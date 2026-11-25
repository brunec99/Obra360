/** Troca das ligações deduzidas da Linha de Balanço pelas reais do Prevision (25/11/2026, Atmos).
 *
 * A Linha de Balanço do Atmos veio em 11/11/2026 do XML do Prevision, que não traz os vínculos: a
 * importação deduziu as ligações da sequência das datas ("equipe segue" e sequência no local, ver
 * `buildPrevisionImport`). A API do Prevision traz os vínculos reais. Regra aprovada pelo usuário:
 * troca só as deduzidas, mantém as criadas à mão, não recria as que foram apagadas, não mexe em datas
 * e manda ao Jorge a lista de conflitos antes de gravar.
 *
 * Tudo aqui é puro (sem banco): `translatePrevisionLinks` leva os vínculos do Prevision para os blocos
 * da obra (pelo nome do serviço e do local, normalizados como na importação);
 * `reconstructDeducedDependencies` refaz o conjunto deduzido original rodando a mesma importação sobre
 * as datas da linha de base dela; e `planDependencyReplacement` diz o que sai, o que entra, o que fica,
 * o que é ignorado, os conflitos de datas e os ciclos. Nenhuma data muda.
 *
 * Decisões:
 * - Deduzida = ligação com o `createdAt` da gravação da importação (a importação grava todas com o
 *   mesmo instante, o mesmo da linha de base dela). As demais são "criadas à mão" e ficam como estão,
 *   mesmo quando o Prevision tem o mesmo par com outra espera.
 * - Vínculo do Prevision vira término → início com espera em dias úteis, como na importação pela API
 *   (início → início, término → término etc. viram o início mínimo que impõem à sucessora), com UMA
 *   diferença: a defasagem do Prevision (`delay`) é contada em DIAS ÚTEIS a partir da data de
 *   referência, não em dias corridos. Conferido em 25/11/2026 nas 1.125 ligações do Atmos com o
 *   calendário do Prevision: assim nenhuma é descumprida pelas datas dele e 862 ficam justas (em dias
 *   corridos, 815). "Término + 1" é a sucessora no dia útil seguinte, ou seja, espera zero aqui.
 * - A espera gravada nunca passa da folga atual entre os dois blocos, para nada se mover; quando o
 *   Prevision pede mais que a folga, é um CONFLITO, listado com os dias úteis que faltam.
 * - Par real que já existe como deduzida com a mesma espera fica como está (mesmo id); com espera
 *   diferente, a deduzida sai e entra a real (o banco não aceita duas ligações no mesmo par, e a
 *   gravação apaga antes de inserir).
 * - Par real que bate com uma deduzida apagada à mão não volta. Sem a reconstrução validada (todas
 *   as deduzidas que restam precisam estar nela), o par que não dá para saber fica "a conferir". */
import {
  activityEnd,
  activityFinish,
  addWorkdays,
  cascade,
  LOB_LIMITS,
  normalizeName,
  topologicalActivities,
  workdaysBetween,
  type LobActivity,
  type LobBaseline,
  type LobCalendar,
  type LobDependency,
  type LobDependencyKind,
  type LobId,
  type LobLocal,
  type LobService,
  type LocalDate,
} from './lob';
import { addDays } from './long-term-plan';
import {
  buildPrevisionImport,
  localGroup,
  readPrevisionApiSchedule,
  type PrevisionApiProject,
  type PrevisionSchedule,
} from './lob-prevision-import';

type Dates = Pick<LobActivity, 'start' | 'durationDays'>;
const pairKey = (predecessorId: LobId, successorId: LobId) => `${predecessorId}|${successorId}`;
const clampLag = (lag: number) => Math.max(-LOB_LIMITS.lagDays, Math.min(LOB_LIMITS.lagDays, lag));
const formatBr = (date: LocalDate) => `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;

/** Folga entre o fim de `a` e o início de `b`, em dias úteis; negativa quando se sobrepõem (a mesma
 * conta da importação). */
export function signedGap(a: Dates, b: Pick<LobActivity, 'start'>, calendar?: LobCalendar): number {
  const end = activityEnd(a, calendar);
  return b.start >= end ? workdaysBetween(end, b.start, calendar) : -workdaysBetween(b.start, end, calendar);
}

// ─── Vínculos do Prevision nos blocos da obra ───────────────────────────────────

/** Um vínculo do Prevision já nos blocos da obra: a data de referência da predecessora, a data
 * amarrada da sucessora e a defasagem em dias úteis a partir da referência (negativa = antes). */
export interface RealLink {
  predecessorId: LobId;
  successorId: LobId;
  from: 'start' | 'finish';
  to: 'start' | 'finish';
  /** O `delay` do Prevision com o sinal de `timeOperation` (o leitor da importação chama de
   * `lagCalendarDays`, mas as datas do Prevision mostram que são dias úteis). */
  delayDays: number;
  /** Datas dos dois blocos no Prevision, para saber se o próprio Prevision cumpre o vínculo. */
  prevision?: { predecessor: { start: LocalDate; finish: LocalDate }; successor: { start: LocalDate; finish: LocalDate } };
}
/** Vínculo do Prevision que não chega à obra (um dos blocos não existe nela). */
export interface UnmatchedRealLink {
  /** "Serviço › Local" no Prevision. */
  predecessor: string;
  successor: string;
  reason: string;
}
export interface PrevisionLinkTranslation {
  /** Vínculos lidos do Prevision (já sem os que ligam um bloco a ele mesmo). */
  total: number;
  links: RealLink[];
  unmatched: UnmatchedRealLink[];
  /** Blocos do Prevision ("Serviço › Local") sem bloco na obra. */
  missingBlocks: string[];
  /** Blocos da obra que não estão no Prevision. */
  extraActivities: LobId[];
  warnings: string[];
}

/** Leva os vínculos do Prevision para os blocos da obra: cada atividade do Prevision (serviço × lote)
 * casa com o bloco do serviço e do local de mesmo nome (normalizado, como a importação faz). */
export function translatePrevisionLinks(
  project: PrevisionApiProject,
  work: { services: LobService[]; locals: LobLocal[]; activities: LobActivity[] },
  calendar?: LobCalendar,
): PrevisionLinkTranslation {
  const schedule = readPrevisionApiSchedule(project, calendar);
  const services = new Map(work.services.map(s => [normalizeName(s.name), s]));
  const locals = new Map(work.locals.map(l => [normalizeName(l.name), l]));
  const activities = new Map(work.activities.map(a => [pairKey(a.serviceId, a.localId), a]));
  const label = (index: number) => `${schedule.blocks[index].serviceName} › ${schedule.blocks[index].localName}`;
  const missingBlocks: string[] = [];
  const matched = schedule.blocks.map((b, index) => {
    const service = services.get(normalizeName(b.serviceName));
    const local = locals.get(normalizeName(b.localName));
    const activity = service && local ? activities.get(pairKey(service.id, local.id)) : undefined;
    if (!activity) missingBlocks.push(label(index));
    return activity;
  });
  const used = new Set(matched.filter(Boolean).map(a => a!.id));
  const links: RealLink[] = [];
  const unmatched: UnmatchedRealLink[] = [];
  for (const l of schedule.links ?? []) {
    const p = matched[l.predecessor];
    const s = matched[l.successor];
    if (!p || !s) {
      const missing = [!p && 'predecessora', !s && 'sucessora'].filter(Boolean).join(' e ');
      unmatched.push({ predecessor: label(l.predecessor), successor: label(l.successor), reason: `${missing} sem bloco na obra` });
      continue;
    }
    const pb = schedule.blocks[l.predecessor];
    const sb = schedule.blocks[l.successor];
    links.push({
      predecessorId: p.id,
      successorId: s.id,
      from: l.from,
      to: l.to,
      delayDays: l.lagCalendarDays,
      prevision: { predecessor: { start: pb.start, finish: pb.finish }, successor: { start: sb.start, finish: sb.finish } },
    });
  }
  return {
    total: schedule.links?.length ?? 0,
    links,
    unmatched,
    missingBlocks,
    extraActivities: work.activities.filter(a => !used.has(a.id)).map(a => a.id),
    warnings: schedule.warnings,
  };
}

/** Espera (dias úteis contados do fim da predecessora) que o vínculo pede entre dois blocos com estas
 * datas. A data amarrada da sucessora (início ou término) fica `delayDays` dias úteis depois da data
 * de referência da predecessora (início ou último dia); amarrar o término equivale a amarrar o início
 * `durationDays - 1` dias úteis antes. Término + 1 dá espera zero; início → início com defasagem
 * pequena dá espera negativa (a sucessora começa antes de a predecessora terminar). */
export function previsionLinkLag(
  link: Pick<RealLink, 'from' | 'to' | 'delayDays'>,
  predecessor: Dates,
  successor: Dates,
  calendar?: LobCalendar,
): number {
  const reference = link.from === 'start' ? predecessor.start : activityFinish(predecessor, calendar);
  const target = addWorkdays(reference, link.delayDays, calendar);
  const required = link.to === 'start' ? target : addWorkdays(target, -(successor.durationDays - 1), calendar);
  return signedGap(predecessor, { start: required }, calendar);
}

/** Dias úteis que faltam para a sucessora cumprir `lag` depois da predecessora (zero se cumpre). */
function shortfall(predecessor: Dates, successor: Dates, lag: number, calendar?: LobCalendar) {
  const minimum = addWorkdays(activityEnd(predecessor, calendar), lag, calendar);
  return { minimum, days: workdaysBetween(successor.start, minimum, calendar) };
}

// ─── Conjunto deduzido original ─────────────────────────────────────────────────

export interface DeducedDependency {
  predecessorId: LobId;
  successorId: LobId;
  lagDays: number;
  kind: LobDependencyKind;
}
export interface DeducedReconstruction {
  dependencies: DeducedDependency[];
  /** Blocos da linha de base que não existem mais na obra (as ligações deles não entram). */
  missingActivities: number;
  /** Motivo, quando a importação não pôde ser refeita. */
  error?: string;
}

/** Refaz as ligações que a importação deduziu, rodando `buildPrevisionImport` sobre as datas da linha
 * de base que ela gravou (as datas do arquivo), com os nomes e a ordem atuais dos serviços e dos
 * locais. `calendar` é o calendário em que a importação contou os dias: a de 11/11/2026 é anterior
 * ao calendário da obra (23/11/2026), então segunda a sexta sem feriados (ausente). */
export function reconstructDeducedDependencies(input: {
  workId: LobId;
  workName: string;
  baseline: Pick<LobBaseline, 'snapshot'>;
  services: LobService[];
  locals: LobLocal[];
  activities: Pick<LobActivity, 'id'>[];
  calendar?: LobCalendar;
}): DeducedReconstruction {
  const serviceName = new Map(input.services.map(s => [s.id, s.name]));
  const localById = new Map(input.locals.map(l => [l.id, l]));
  const alive = new Set(input.activities.map(a => a.id));
  const entries = input.baseline.snapshot.filter(e => serviceName.has(e.serviceId) && localById.has(e.localId) && alive.has(e.activityId));
  const missingActivities = input.baseline.snapshot.length - entries.length;
  if (!entries.length)
    return { dependencies: [], missingActivities, error: 'A linha de base não tem nenhum bloco que ainda exista na obra.' };
  const usedLocals = [...new Set(entries.map(e => e.localId))].map(id => localById.get(id)!).sort((a, b) => a.orderIndex - b.orderIndex);
  const usedServices = input.services.filter(s => entries.some(e => e.serviceId === s.id)).sort((a, b) => a.orderIndex - b.orderIndex);
  const schedule: PrevisionSchedule = {
    services: usedServices.map(s => s.name),
    locals: usedLocals.map(l => ({ name: l.name, group: localGroup(l.name) })),
    blocks: entries.map(e => ({
      serviceName: serviceName.get(e.serviceId)!,
      localName: localById.get(e.localId)!.name,
      start: e.start,
      finish: activityFinish(e, input.calendar),
      workDays: e.durationDays,
      percent: 0,
    })),
    warnings: [],
  };
  let n = 0;
  try {
    const result = buildPrevisionImport(schedule, {
      workId: input.workId,
      workName: input.workName,
      actorId: '',
      now: '',
      newId: () => `reconstrucao-${n++}`,
      measurementDate: entries[0].start,
      sourceName: 'reconstrução',
      existingLocals: usedLocals,
      calendar: input.calendar,
    });
    const original = new Map(result.activities.map((a, index) => [a.id, entries[index].activityId]));
    return {
      dependencies: result.dependencies.map(d => ({
        predecessorId: original.get(d.predecessorId)!,
        successorId: original.get(d.successorId)!,
        lagDays: d.lagDays,
        kind: d.kind,
      })),
      missingActivities,
    };
  } catch (error) {
    return { dependencies: [], missingActivities, error: error instanceof Error ? error.message : String(error) };
  }
}

// ─── Plano da troca ─────────────────────────────────────────────────────────────

export interface DependencyReplacementInput {
  workId: LobId;
  activities: LobActivity[];
  dependencies: LobDependency[];
  /** Calendário atual da obra: conta a espera pedida e os conflitos com as datas de hoje. */
  calendar?: LobCalendar;
  /** Calendário do Prevision (`previsionApiCalendar`), para conferir os vínculos nas datas dele;
   * ausente = o da obra. */
  previsionCalendar?: LobCalendar;
  /** Instante da gravação da importação: o `createdAt` comum às ligações que ela deduziu. */
  importedAt: string;
  /** Vínculos reais do Prevision, já nos blocos da obra (`translatePrevisionLinks`). */
  realLinks: RealLink[];
  /** Vínculos do Prevision sem bloco na obra: entram nas ignoradas. */
  unmatchedLinks?: UnmatchedRealLink[];
  /** Conjunto deduzido original (`reconstructDeducedDependencies`); ausente = não deu para refazer. */
  deduced?: DeducedDependency[];
  newId: () => LobId;
  now: string;
}

/** Os vínculos do Prevision de um mesmo par, juntos: vale o mais exigente (como na importação). */
export interface MergedRealLink {
  predecessorId: LobId;
  successorId: LobId;
  kind: LobDependencyKind;
  links: RealLink[];
  /** Espera que o Prevision pede, com as datas e durações atuais dos blocos. */
  wantedLag: number;
  /** Folga atual entre os dois blocos. */
  gap: number;
  /** Espera a gravar: a pedida, sem passar da folga atual (nada se move). */
  lagDays: number;
  /** Dias úteis que faltam à sucessora para cumprir o Prevision com as datas atuais (zero = cumpre). */
  conflictDays: number;
  /** Início mínimo da sucessora pelo Prevision, com as datas atuais. */
  minimumStart: LocalDate;
  /** O mesmo conflito, nas datas do próprio Prevision (ausente sem as datas dele). */
  previsionConflictDays?: number;
}
export type KeptReason = 'manual' | 'manual-tambem-no-prevision' | 'deduzida-igual-ao-prevision';
export type IgnoredReason = 'apagada-a-mao' | 'a-conferir' | 'sem-bloco';
export interface DependencyConflict {
  link: MergedRealLink;
  /** `nova`: a ligação entra; `mantida`: a deduzida igual à real fica. */
  status: 'nova' | 'mantida';
}
export interface DependencyCycle {
  activityIds: LobId[];
  dependencies: { predecessorId: LobId; successorId: LobId; origin: 'manual' | 'mantida' | 'nova' }[];
}
export type ReconstructionStatus = 'ok' | 'falhou' | 'ausente';
export interface DependencyReplacementPlan {
  /** Ligações da importação que ainda existem (as deduzidas). */
  imported: LobDependency[];
  /** Ligações criadas depois da importação (à mão, por comando da tela ou lançamento). */
  manual: LobDependency[];
  reconstruction: {
    status: ReconstructionStatus;
    /** Ligações deduzidas na importação, segundo a reconstrução. */
    total: number;
    /** Deduzidas que existem e que a reconstrução não reproduz (vazia quando bateu). */
    unexplained: LobDependency[];
    /** Deduzidas que não existem mais: apagadas à mão. `recreated` = o par voltou como ligação à mão. */
    deleted: (DeducedDependency & { recreated: boolean })[];
    /** Deduzidas que existem com a espera diferente da importação (mudada à mão depois). */
    lagChanged: { dependency: LobDependency; importedLag: number }[];
  };
  remove: { dependency: LobDependency; reason: 'deduzida' | 'troca-de-espera' }[];
  insert: { dependency: LobDependency; link: MergedRealLink; replaces?: LobId }[];
  kept: { dependency: LobDependency; reason: KeptReason; link?: MergedRealLink }[];
  ignored: { reason: IgnoredReason; link?: MergedRealLink; unmatched?: UnmatchedRealLink }[];
  conflicts: DependencyConflict[];
  cycles: DependencyCycle[];
  /** Blocos que a rede final moveria (deve ficar vazio: a espera não passa da folga). */
  moved: LobActivity[];
  /** As ligações da obra depois da troca. */
  finalDependencies: LobDependency[];
}

/** O que sai, o que entra, o que fica e o que é ignorado na troca; os conflitos com as datas atuais e
 * os ciclos que a rede nova teria. Não muda datas nem grava nada. */
export function planDependencyReplacement(input: DependencyReplacementInput): DependencyReplacementPlan {
  const { calendar } = input;
  const byId = new Map(input.activities.map(a => [a.id, a]));
  const importedMs = Date.parse(input.importedAt);
  if (!Number.isFinite(importedMs)) throw new Error('Instante da importação inválido.');
  // A importação grava todas as ligações com o mesmo instante; a tolerância de um segundo cobre só a
  // diferença de precisão entre a leitura pela API e a do Postgres.
  const isImported = (d: LobDependency) => Math.abs(Date.parse(d.createdAt) - importedMs) < 1000;
  const imported = input.dependencies.filter(isImported);
  const manual = input.dependencies.filter(d => !isImported(d));
  const importedByPair = new Map(imported.map(d => [pairKey(d.predecessorId, d.successorId), d]));
  const manualByPair = new Map(manual.map(d => [pairKey(d.predecessorId, d.successorId), d]));

  // Reconstrução: precisa conter todas as deduzidas que restam; as que sobram foram apagadas à mão.
  const reconstruction: DependencyReplacementPlan['reconstruction'] = {
    status: 'ausente',
    total: input.deduced?.length ?? 0,
    unexplained: [],
    deleted: [],
    lagChanged: [],
  };
  const deletedPairs = new Set<string>();
  /** Blocos em que a reconstrução não explica alguma deduzida: ali não dá para saber o que foi apagado. */
  const uncertain = new Set<LobId>();
  if (input.deduced) {
    const deducedByPair = new Map(input.deduced.map(d => [pairKey(d.predecessorId, d.successorId), d]));
    for (const d of imported) {
      const original = deducedByPair.get(pairKey(d.predecessorId, d.successorId));
      if (!original) {
        reconstruction.unexplained.push(d);
        uncertain.add(d.predecessorId).add(d.successorId);
      } else if (original.lagDays !== d.lagDays) reconstruction.lagChanged.push({ dependency: d, importedLag: original.lagDays });
    }
    for (const d of input.deduced) {
      const key = pairKey(d.predecessorId, d.successorId);
      if (importedByPair.has(key) || !byId.has(d.predecessorId) || !byId.has(d.successorId)) continue;
      reconstruction.deleted.push({ ...d, recreated: manualByPair.has(key) });
      deletedPairs.add(key);
    }
    reconstruction.status = reconstruction.unexplained.length ? 'falhou' : 'ok';
  }

  // Vínculos reais por par, convertidos para término → início com as datas atuais.
  const ignored: DependencyReplacementPlan['ignored'] = (input.unmatchedLinks ?? []).map(unmatched => ({
    reason: 'sem-bloco' as const,
    unmatched,
  }));
  const merged = new Map<string, MergedRealLink>();
  for (const l of input.realLinks) {
    const p = byId.get(l.predecessorId);
    const s = byId.get(l.successorId);
    if (!p || !s || p === s) {
      ignored.push({
        reason: 'sem-bloco',
        unmatched: {
          predecessor: l.predecessorId,
          successor: l.successorId,
          reason: p === s ? 'o mesmo bloco' : 'bloco não existe na obra',
        },
      });
      continue;
    }
    const wanted = previsionLinkLag(l, p, s, calendar);
    let previsionDays: number | undefined;
    if (l.prevision) {
      const theirs = input.previsionCalendar ?? calendar;
      const toDates = (b: { start: LocalDate; finish: LocalDate }): Dates => ({
        start: b.start,
        durationDays: Math.max(1, workdaysBetween(b.start, addDays(b.finish, 1), theirs)),
      });
      const pp = toDates(l.prevision.predecessor);
      const ps = toDates(l.prevision.successor);
      previsionDays = shortfall(pp, ps, previsionLinkLag(l, pp, ps, theirs), theirs).days;
    }
    const key = pairKey(p.id, s.id);
    const same = merged.get(key);
    if (same) {
      same.links.push(l);
      same.wantedLag = Math.max(same.wantedLag, wanted);
      if (previsionDays !== undefined) same.previsionConflictDays = Math.max(same.previsionConflictDays ?? 0, previsionDays);
    } else
      merged.set(key, {
        predecessorId: p.id,
        successorId: s.id,
        kind: p.serviceId === s.serviceId ? 'crew' : 'fs',
        links: [l],
        wantedLag: wanted,
        gap: 0,
        lagDays: 0,
        conflictDays: 0,
        minimumStart: s.start,
        previsionConflictDays: previsionDays,
      });
  }
  for (const m of merged.values()) {
    const p = byId.get(m.predecessorId)!;
    const s = byId.get(m.successorId)!;
    m.gap = signedGap(p, s, calendar);
    m.lagDays = clampLag(Math.min(m.wantedLag, m.gap));
    const { minimum, days } = shortfall(p, s, m.wantedLag, calendar);
    m.minimumStart = minimum;
    m.conflictDays = days;
  }

  // Classificação.
  const remove: DependencyReplacementPlan['remove'] = [];
  const insert: DependencyReplacementPlan['insert'] = [];
  const kept: DependencyReplacementPlan['kept'] = [];
  const handled = new Set<LobId>();
  const newDependency = (m: MergedRealLink): LobDependency => ({
    id: input.newId(),
    workId: input.workId,
    predecessorId: m.predecessorId,
    successorId: m.successorId,
    lagDays: m.lagDays,
    kind: m.kind,
    createdAt: input.now,
  });
  for (const [key, m] of merged) {
    const own = manualByPair.get(key);
    if (own) {
      kept.push({ dependency: own, reason: 'manual-tambem-no-prevision', link: m });
      continue;
    }
    const deduced = importedByPair.get(key);
    if (deduced) {
      handled.add(deduced.id);
      if (deduced.lagDays === m.lagDays && deduced.kind === m.kind)
        kept.push({ dependency: deduced, reason: 'deduzida-igual-ao-prevision', link: m });
      else {
        remove.push({ dependency: deduced, reason: 'troca-de-espera' });
        insert.push({ dependency: newDependency(m), link: m, replaces: deduced.id });
      }
      continue;
    }
    if (deletedPairs.has(key)) ignored.push({ reason: 'apagada-a-mao', link: m });
    else if (reconstruction.status === 'ausente' || uncertain.has(m.predecessorId) || uncertain.has(m.successorId))
      ignored.push({ reason: 'a-conferir', link: m });
    else insert.push({ dependency: newDependency(m), link: m });
  }
  for (const d of imported) if (!handled.has(d.id)) remove.push({ dependency: d, reason: 'deduzida' });
  const keptManual = new Set(kept.map(k => k.dependency.id));
  for (const d of manual) if (!keptManual.has(d.id)) kept.push({ dependency: d, reason: 'manual' });

  const removed = new Set(remove.map(r => r.dependency.id));
  const finalDependencies = [...input.dependencies.filter(d => !removed.has(d.id)), ...insert.map(i => i.dependency)];
  const origin = new Map<LobId, 'manual' | 'mantida' | 'nova'>([
    ...manual.map(d => [d.id, 'manual'] as const),
    ...imported.map(d => [d.id, 'mantida'] as const),
    ...insert.map(i => [i.dependency.id, 'nova'] as const),
  ]);
  const cycles =
    topologicalActivities(input.activities, finalDependencies).length === input.activities.length
      ? []
      : findCycles(finalDependencies).map(c => ({
          activityIds: c.activityIds,
          dependencies: c.dependencies.map(d => ({
            predecessorId: d.predecessorId,
            successorId: d.successorId,
            origin: origin.get(d.id)!,
          })),
        }));
  const keptDeduced = new Set(kept.filter(k => k.reason === 'deduzida-igual-ao-prevision').map(k => k.dependency.id));
  const conflicts: DependencyConflict[] = [
    ...insert.filter(i => i.link.conflictDays > 0).map(i => ({ link: i.link, status: 'nova' as const })),
    ...kept
      .filter(k => keptDeduced.has(k.dependency.id) && k.link!.conflictDays > 0)
      .map(k => ({ link: k.link!, status: 'mantida' as const })),
  ].sort((a, b) => b.link.conflictDays - a.link.conflictDays);

  return {
    imported,
    manual,
    reconstruction,
    remove,
    insert,
    kept,
    ignored,
    conflicts,
    cycles,
    moved: cycles.length ? [] : cascade(input.activities, finalDependencies, calendar),
    finalDependencies,
  };
}

/** Componentes fortemente conexos com mais de um bloco (Tarjan, sem recursão): cada um é um ciclo,
 * com as ligações de dentro dele. */
function findCycles(dependencies: LobDependency[]): { activityIds: LobId[]; dependencies: LobDependency[] }[] {
  const successors = new Map<LobId, LobId[]>();
  for (const d of dependencies) {
    const list = successors.get(d.predecessorId);
    if (list) list.push(d.successorId);
    else successors.set(d.predecessorId, [d.successorId]);
    if (!successors.has(d.successorId)) successors.set(d.successorId, []);
  }
  const index = new Map<LobId, number>();
  const low = new Map<LobId, number>();
  const onStack = new Set<LobId>();
  const stack: LobId[] = [];
  const components: LobId[][] = [];
  let counter = 0;
  for (const root of successors.keys()) {
    if (index.has(root)) continue;
    const work: { id: LobId; next: number }[] = [{ id: root, next: 0 }];
    index.set(root, counter);
    low.set(root, counter++);
    stack.push(root);
    onStack.add(root);
    while (work.length) {
      const frame = work[work.length - 1];
      const list = successors.get(frame.id)!;
      if (frame.next < list.length) {
        const w = list[frame.next++];
        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter++);
          stack.push(w);
          onStack.add(w);
          work.push({ id: w, next: 0 });
        } else if (onStack.has(w)) low.set(frame.id, Math.min(low.get(frame.id)!, index.get(w)!));
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1].id;
        low.set(parent, Math.min(low.get(parent)!, low.get(frame.id)!));
      }
      if (low.get(frame.id) === index.get(frame.id)) {
        const component: LobId[] = [];
        let w: LobId;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          component.push(w);
        } while (w !== frame.id);
        if (component.length > 1) components.push(component);
      }
    }
  }
  return components.map(ids => {
    const inside = new Set(ids);
    return { activityIds: ids, dependencies: dependencies.filter(d => inside.has(d.predecessorId) && inside.has(d.successorId)) };
  });
}

// ─── Linha de base antes da troca ───────────────────────────────────────────────

/** Linha de base automática "Antes das ligações do Prevision dd/mm/aaaa" ("… (2)" se o nome já
 * existe), com as datas atuais de todos os blocos e o término gravado (como as da tela). */
export function replacementBaseline(input: {
  workId: LobId;
  activities: LobActivity[];
  baselines: Pick<LobBaseline, 'name'>[];
  calendar?: LobCalendar;
  date: LocalDate;
  actorId: LobId;
  now: string;
  newId: () => LobId;
}): LobBaseline {
  const base = `Antes das ligações do Prevision ${formatBr(input.date)}`;
  const taken = new Set(input.baselines.map(b => normalizeName(b.name)));
  let name = base;
  for (let n = 2; taken.has(normalizeName(name)); n++) name = `${base} (${n})`;
  return {
    id: input.newId(),
    workId: input.workId,
    name: name.slice(0, LOB_LIMITS.name),
    automatic: true,
    createdBy: input.actorId,
    createdAt: input.now,
    snapshot: input.activities.map(a => ({
      activityId: a.id,
      serviceId: a.serviceId,
      localId: a.localId,
      start: a.start,
      durationDays: a.durationDays,
      finish: activityFinish(a, input.calendar),
    })),
  };
}

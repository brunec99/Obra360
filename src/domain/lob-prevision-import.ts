/** Importação da Linha de Balanço exportada do Prevision (10/11/2026). O Prevision exporta o
 * cronograma como XML do MS Project em dois níveis: o nível 1 é o serviço ("EST - Estrutura de
 * concreto") e cada filho é o serviço num local ("Térreo", "5ºpavto", "Hall - 8ºpavto"), com início,
 * término, duração e % concluído. Não há vínculos no arquivo nem feriados no calendário.
 *
 * Daqui sai, sem banco: os locais na ordem do Prevision (de baixo para cima), os serviços, um bloco
 * por serviço × local com as MESMAS datas do Prevision, as dependências (a equipe que segue de um
 * local ao outro e a sequência dos serviços dentro de cada local), a medição com o avanço do
 * arquivo, uma linha de base com as datas importadas e os fluxos de serviços dos pavimentos tipo e
 * dos demais pavimentos, deduzidos da ordem em que os serviços acontecem em cada local.
 *
 * Os dias úteis são os do calendário da obra (`calendar`, 23/11/2026), que quem chama lê de
 * `LobData.calendar` e passa às duas funções; sem ele, segunda a sexta sem feriados. */
import { parseXsdDuration, type MspdiProject, type MspdiTask } from './mspdi-import';
import { addDays, isLocalDate, type LocalDate } from './long-term-plan';
import { LOB_CALENDAR_MAX_HOLIDAYS, normalizeLobCalendar } from './lob-calendar';
import {
  activityEnd,
  activityFinish,
  addWorkdays,
  flowLevels,
  LOB_COLORS,
  LOB_LIMITS,
  LobError,
  nextWorkday,
  normalizeName,
  previousWorkday,
  topologicalActivities,
  validateFlowDocument,
  validateFlowForLaunch,
  workdaysBetween,
  type FlowService,
  type LobActivity,
  type LobBaseline,
  type LobCalendar,
  type LobDependency,
  type LobLocal,
  type LobMeasurement,
  type LobMeasurementItem,
  type LobService,
  type ServiceFlowDocument,
} from './lob';

// ─── Leitura do arquivo ─────────────────────────────────────────────────────────

/** Grupo do local: decide a ordem na Linha de Balanço e de que fluxo ele participa. */
export type PrevisionLocalGroup = 'pavimento_tipo' | 'demais' | 'hall' | 'fachada' | 'equipamentos';
export const LOCAL_GROUP_LABEL: Record<PrevisionLocalGroup, string> = {
  pavimento_tipo: 'Pavimentos tipo',
  demais: 'Demais pavimentos',
  hall: 'Halls',
  fachada: 'Fachada',
  equipamentos: 'Equipamentos',
};
/** Ordem dos grupos de baixo para cima: pavimentos (tipo e demais misturados na ordem do
 * Prevision), halls, fachada e equipamentos. */
const GROUP_RANK: Record<PrevisionLocalGroup, number> = { pavimento_tipo: 0, demais: 0, hall: 1, fachada: 2, equipamentos: 3 };

export function localGroup(name: string): PrevisionLocalGroup {
  const n = normalizeName(name);
  if (/^hall\b/.test(n)) return 'hall';
  if (/^(norte|sul|leste|oeste|fachada)\b/.test(n)) return 'fachada';
  if (/^equipamento/.test(n)) return 'equipamentos';
  if (/^\d+\s*[º°o]?\s*(pav|andar)/.test(n) || /^(pav(imento|to)?\.?|andar)\s*\d+/.test(n)) return 'pavimento_tipo';
  return 'demais';
}

export interface PrevisionBlock {
  serviceName: string;
  localName: string;
  /** Primeiro e último dia trabalhado, como no Prevision. */
  start: LocalDate;
  finish: LocalDate;
  /** Duração do Prevision em dias úteis do calendário dele (que desconta feriados). */
  workDays: number;
  percent: number;
  /** Datas reais informadas pela origem (com `PrevisionSchedule.actualDates`). */
  actualStart?: LocalDate;
  actualFinish?: LocalDate;
  /** Datas do bloco na linha de base da origem (com `PrevisionSchedule.baseDates`). */
  baseStart?: LocalDate;
  baseFinish?: LocalDate;
}
export interface PrevisionSchedule {
  title?: string;
  /** Serviços na ordem do arquivo. */
  services: string[];
  /** Locais de baixo para cima. */
  locals: { name: string; group: PrevisionLocalGroup }[];
  blocks: PrevisionBlock[];
  warnings: string[];
  /** Dependências reais do Prevision (só a leitura pela API traz). Com elas, nada é deduzido. */
  links?: PrevisionLink[];
  /** Cor de cada serviço no Prevision (#rrggbb), pelo nome do serviço. */
  colors?: Map<string, string>;
  /** A origem informa as datas reais de cada bloco: valem as dela, em vez das deduzidas do avanço. */
  actualDates?: boolean;
  /** A origem informa a linha de base: a foto guarda `baseStart`/`baseFinish`, e o bloco sem essas
   * datas fica fora dela (criado depois da linha de base). */
  baseDates?: boolean;
}
/** Uma dependência do Prevision entre dois blocos (índices em `blocks`): a data de referência da
 * predecessora (início ou término), a data amarrada da sucessora (início ou término) e a defasagem
 * em dias corridos (negativa = antes). */
export interface PrevisionLink {
  predecessor: number;
  successor: number;
  from: 'start' | 'finish';
  to: 'start' | 'finish';
  lagCalendarDays: number;
}

const datePart = (value: string | undefined): LocalDate | undefined => {
  const date = value?.slice(0, 10);
  return date && isLocalDate(date) ? date : undefined;
};
const clean = (name: string) => name.replace(/\s+/g, ' ').trim();

/** Lê o XML já interpretado por `parseMspdi`. Nível 1 = serviço; cada folha abaixo dele é um bloco,
 * com o local formado pelos nomes dos níveis 2 em diante ("Torre A › 5º pavimento"). */
export function readPrevisionSchedule(project: MspdiProject, calendar?: LobCalendar): PrevisionSchedule {
  const warnings: string[] = [];
  const hoursPerDay = (project.minutesPerDay ?? 480) / 60 || 8;
  const tasks = project.tasks.filter(t => (t.outlineLevel ?? 0) >= 1 && !t.isNull);
  const services: string[] = [];
  const serviceSeen = new Map<string, string>();
  const blocks: PrevisionBlock[] = [];
  const blockKeys = new Set<string>();
  /** Ordem dos locais dentro de cada serviço, para montar a ordem geral. */
  const sequences: string[][] = [];
  const firstSeen = new Map<string, number>();
  const localNames = new Map<string, string>();
  let path: string[] = [];
  let service: string | undefined;
  let sequence: string[] = [];

  const isLeaf = (index: number) => (tasks[index + 1]?.outlineLevel ?? 0) <= (tasks[index].outlineLevel ?? 0);
  const blockOf = (task: MspdiTask, serviceName: string, localName: string) => {
    let start = datePart(task.start);
    let finish = datePart(task.finish);
    if (!start || !finish) {
      warnings.push(`"${serviceName} › ${localName}" sem datas no arquivo: ficou de fora.`);
      return;
    }
    // Término à meia-noite é o fim do dia anterior (o Project grava assim às vezes).
    if (task.finish?.slice(11, 19) === '00:00:00' && finish > start) finish = addDays(finish, -1);
    start = nextWorkday(start, calendar);
    finish = previousWorkday(finish, calendar);
    if (finish < start) finish = start;
    const hours = parseXsdDuration(task.duration);
    const workDays = Math.max(1, Math.round((hours ?? 0) / hoursPerDay) || workdaysBetween(start, addDays(finish, 1), calendar));
    return { serviceName, localName, start, finish, workDays, percent: Math.min(100, Math.max(0, task.percentComplete || 0)) };
  };

  tasks.forEach((task, index) => {
    const level = Math.max(1, Math.round(task.outlineLevel ?? 1));
    const name = clean(task.name);
    if (level === 1) {
      if (sequence.length) sequences.push(sequence);
      sequence = [];
      path = [];
      const key = normalizeName(name);
      service = serviceSeen.get(key);
      if (!service) {
        service = name || `Serviço ${services.length + 1}`;
        serviceSeen.set(key, service);
        services.push(service);
      }
      if (isLeaf(index)) warnings.push(`O serviço "${name}" não tem locais no arquivo: ficou de fora.`);
      return;
    }
    if (!service) return;
    path = [...path.slice(0, level - 2), name];
    if (!isLeaf(index)) return;
    if (!task.active) {
      warnings.push(`"${service} › ${path.join(' › ')}" está inativa no arquivo: ficou de fora.`);
      return;
    }
    const raw = path.filter(Boolean).join(' › ') || 'Geral';
    const localKey = normalizeName(raw);
    const localName = localNames.get(localKey) ?? raw;
    localNames.set(localKey, localName);
    const key = `${normalizeName(service)}|${localKey}`;
    if (blockKeys.has(key)) {
      warnings.push(`"${service} › ${localName}" aparece duas vezes: valeu a primeira.`);
      return;
    }
    const block = blockOf(task, service, localName);
    if (!block) return;
    blockKeys.add(key);
    blocks.push(block);
    sequence.push(localName);
    if (!firstSeen.has(localName)) firstSeen.set(localName, firstSeen.size);
  });
  if (sequence.length) sequences.push(sequence);

  const earliest = new Map<string, LocalDate>();
  for (const b of blocks) if (!earliest.has(b.localName) || b.start < earliest.get(b.localName)!) earliest.set(b.localName, b.start);
  return {
    title: project.title,
    services: services.filter(s => blocks.some(b => b.serviceName === s)),
    locals: orderLocals(sequences, firstSeen, earliest),
    blocks,
    warnings,
  };
}

/** Ordem geral dos locais (de baixo para cima): cada serviço lista os seus locais na ordem do
 * Prevision, e as listas são costuradas (ordenação topológica, desempate pela primeira aparição).
 * Os grupos vêm em blocos: pavimentos, halls, fachada, equipamentos. A fachada vai pela data em que
 * o trabalho começa em cada pano: o Prevision do Atmos a lista do último pano ao primeiro, o que
 * inverteria a diagonal da Linha de Balanço. */
function orderLocals(sequences: string[][], firstSeen: Map<string, number>, earliest: Map<string, LocalDate>) {
  const names = [...firstSeen.keys()];
  const group = new Map(names.map(n => [n, localGroup(n)]));
  const rank = (n: string) => GROUP_RANK[group.get(n)!];
  const after = new Map(names.map(n => [n, new Set<string>()]));
  const pending = new Map(names.map(n => [n, 0]));
  for (const seq of sequences)
    for (let i = 1; i < seq.length; i++) {
      const [a, b] = [seq[i - 1], seq[i]];
      if (a === b || rank(a) !== rank(b) || after.get(a)!.has(b)) continue;
      after.get(a)!.add(b);
      pending.set(b, pending.get(b)! + 1);
    }
  const order: string[] = [];
  const done = new Set<string>();
  const key = (n: string) => rank(n) * 1e6 + firstSeen.get(n)!;
  while (order.length < names.length) {
    const ready = names.filter(n => !done.has(n) && pending.get(n) === 0).sort((a, b) => key(a) - key(b));
    // Ciclo na ordem do arquivo: entra o primeiro que apareceu, e a costura segue dele.
    const next = ready[0] ?? names.filter(n => !done.has(n)).sort((a, b) => key(a) - key(b))[0];
    done.add(next);
    order.push(next);
    for (const b of after.get(next)!) pending.set(b, pending.get(b)! - 1);
  }
  const position = new Map(order.map((name, index) => [name, index]));
  const byStart = (a: string, b: string) =>
    group.get(a) === 'fachada' && group.get(b) === 'fachada' ? earliest.get(a)!.localeCompare(earliest.get(b)!) : 0;
  return order
    .sort((a, b) => rank(a) - rank(b) || byStart(a, b) || position.get(a)! - position.get(b)!)
    .map(name => ({ name, group: group.get(name)! }));
}

// ─── Leitura pela API do Prevision ──────────────────────────────────────────────

/** O cronograma de uma obra como a API do Prevision entrega (GraphQL, 23/11/2026), já sem o
 * envelope: quem busca é `infrastructure/integrations/prevision/graphql.ts`. */
export interface PrevisionApiProject {
  id: string;
  name: string;
  /** "lob" ou "gantt": só a Linha de Balanço tem lotes e serviços de verdade. */
  scheduleType?: string | null;
  calendar?: {
    startAt?: string | null;
    endAt?: string | null;
    /** Feriados e recessos (AAAA-MM-DD); a lista do Prevision vai de 2006 a 2050. */
    holidays?: string[] | null;
    weekWorkdays?: Partial<Record<PrevisionWeekday, boolean>> | null;
  } | null;
  /** Lotes: `position` 1 é o topo da tela do Prevision. */
  floors: { id: string; name: string; position: number }[];
  services: { id: string; name: string; position?: number | null; color?: string | null }[];
  activities: {
    id: string;
    serviceId: string;
    floorId: string;
    startAt?: string | null;
    endAt?: string | null;
    /** Duração em dias úteis do calendário do Prevision. */
    workDuration?: number | null;
    percentageCompleted?: number | null;
    predecessors: {
      predecessorId: string;
      /** "start_at" ou "end_at": a data da predecessora que serve de referência. */
      baseAttribute: string;
      /** "start" ou "end": a data da sucessora que fica amarrada. */
      precedenceAttribute: string;
      /** "after" soma a defasagem à referência; "before" subtrai. */
      timeOperation: string;
      /** Defasagem em dias corridos. */
      delay: number;
    }[];
  }[];
}
const PREVISION_WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
type PrevisionWeekday = (typeof PREVISION_WEEKDAYS)[number];

/** O calendário da obra no Prevision, no formato da Linha de Balanço: os dias da semana trabalhados
 * e os feriados e recessos dentro da janela do calendário dele (ou do período dos blocos, se a
 * janela não vier ou a lista passar do teto). */
export function previsionApiCalendar(project: PrevisionApiProject): LobCalendar {
  const week = project.calendar?.weekWorkdays;
  const marked = PREVISION_WEEKDAYS.map((day, index) => (week?.[day] ? index : -1)).filter(index => index >= 0);
  const weekdays = marked.length ? marked : [1, 2, 3, 4, 5];
  const all = [...new Set((project.calendar?.holidays ?? []).filter(isLocalDate))].sort();
  const dates = project.activities
    .flatMap(a => [datePart(a.startAt ?? undefined), datePart(a.endAt ?? undefined)])
    .filter(Boolean) as LocalDate[];
  const span = dates.length ? { from: dates.reduce((a, b) => (a < b ? a : b)), to: dates.reduce((a, b) => (a > b ? a : b)) } : undefined;
  const within = (from?: LocalDate, to?: LocalDate) => all.filter(d => (!from || d >= from) && (!to || d <= to));
  const start = datePart(project.calendar?.startAt ?? undefined);
  const end = datePart(project.calendar?.endAt ?? undefined);
  // A janela do calendário alargada até cobrir os blocos; sem janela, só o período dos blocos.
  const from = start && span ? (start < span.from ? start : span.from) : (start ?? span?.from);
  const to = end && span ? (end > span.to ? end : span.to) : (end ?? span?.to);
  let holidays = from || to ? within(from, to) : [];
  if (holidays.length > LOB_CALENDAR_MAX_HOLIDAYS) holidays = within(span?.from, span?.to).slice(0, LOB_CALENDAR_MAX_HOLIDAYS);
  return normalizeLobCalendar({ weekdays, holidays });
}

/** Lê o cronograma vindo da API. Cada atividade é um bloco (serviço × lote) com as datas do
 * Prevision; os locais ficam na ordem da tela dele (o lote de `position` 1 no topo); os serviços, na
 * ordem dele; e as dependências são as reais, sem dedução. `calendar` é o calendário em que os dias
 * úteis serão contados (o da obra, ou o do Prevision quando a obra ainda não tem). */
export function readPrevisionApiSchedule(project: PrevisionApiProject, calendar?: LobCalendar): PrevisionSchedule {
  if (project.scheduleType && project.scheduleType !== 'lob')
    throw new LobError(`"${project.name}" é um cronograma do tipo ${project.scheduleType} no Prevision, não uma Linha de Balanço.`);
  const warnings: string[] = [];
  const floorById = new Map(project.floors.map(f => [f.id, f]));
  const serviceById = new Map(project.services.map(s => [s.id, s]));
  // Dois lotes (ou serviços) com o mesmo nome viram um só aqui, onde o nome é único na obra.
  const canonical = (names: Map<string, string>, raw: string, fallback: string) => {
    const name = clean(raw).slice(0, LOB_LIMITS.name) || fallback;
    const key = normalizeName(name);
    if (!names.has(key)) names.set(key, name);
    return names.get(key)!;
  };
  const localNames = new Map<string, string>();
  const serviceNames = new Map<string, string>();
  const blocks: PrevisionBlock[] = [];
  const indexOfActivity = new Map<string, number>();
  const blockKeys = new Map<string, number>();
  for (const a of project.activities) {
    const floor = floorById.get(a.floorId);
    const service = serviceById.get(a.serviceId);
    if (!floor || !service) {
      warnings.push(`Atividade ${a.id} sem lote ou serviço no Prevision: ficou de fora.`);
      continue;
    }
    const serviceName = canonical(serviceNames, service.name, `Serviço ${service.id}`);
    const localName = canonical(localNames, floor.name, `Lote ${floor.id}`);
    let start = datePart(a.startAt ?? undefined);
    let finish = datePart(a.endAt ?? undefined);
    if (!start || !finish) {
      warnings.push(`"${serviceName} › ${localName}" sem datas no Prevision: ficou de fora.`);
      continue;
    }
    const key = `${normalizeName(serviceName)}|${normalizeName(localName)}`;
    const repeated = blockKeys.get(key);
    if (repeated !== undefined) {
      // Atividade dividida em partes no Prevision: aqui é um bloco só por serviço × local.
      warnings.push(`"${serviceName} › ${localName}" aparece mais de uma vez no Prevision (atividade em partes): valeu a primeira.`);
      indexOfActivity.set(a.id, repeated);
      continue;
    }
    start = nextWorkday(start, calendar);
    finish = previousWorkday(finish, calendar);
    if (finish < start) finish = start;
    const counted = workdaysBetween(start, addDays(finish, 1), calendar);
    const workDays = Math.max(1, Math.round(a.workDuration ?? 0) || counted);
    const percent = Math.min(100, Math.max(0, Number(a.percentageCompleted) || 0));
    blockKeys.set(key, blocks.length);
    indexOfActivity.set(a.id, blocks.length);
    blocks.push({ serviceName, localName, start, finish, workDays, percent });
  }
  const links: PrevisionLink[] = [];
  let unknown = 0;
  for (const a of project.activities) {
    const successor = indexOfActivity.get(a.id);
    for (const p of a.predecessors) {
      const predecessor = indexOfActivity.get(p.predecessorId);
      const from = p.baseAttribute === 'start_at' ? 'start' : p.baseAttribute === 'end_at' ? 'finish' : undefined;
      const to = p.precedenceAttribute === 'start' ? 'start' : p.precedenceAttribute === 'end' ? 'finish' : undefined;
      const sign = p.timeOperation === 'after' ? 1 : p.timeOperation === 'before' ? -1 : undefined;
      if (successor === undefined || predecessor === undefined || !from || !to || !sign || !Number.isFinite(p.delay)) {
        unknown++;
        continue;
      }
      if (predecessor !== successor) links.push({ predecessor, successor, from, to, lagCalendarDays: sign * Math.round(p.delay) });
    }
  }
  if (unknown)
    warnings.push(`${unknown} dependência(s) do Prevision apontam para atividade fora da lista ou têm tipo desconhecido: ficaram de fora.`);
  const used = (names: Map<string, string>, raw: string) => names.get(normalizeName(clean(raw).slice(0, LOB_LIMITS.name)));
  const inBlocks = (pick: (b: PrevisionBlock) => string) => new Set(blocks.map(pick));
  const usedLocals = inBlocks(b => b.localName);
  const usedServices = inBlocks(b => b.serviceName);
  const ordered = <T extends { name: string }>(
    list: T[],
    names: Map<string, string>,
    usedNames: Set<string>,
    rank: (item: T) => number,
  ) => {
    const result: string[] = [];
    for (const item of [...list].sort((a, b) => rank(a) - rank(b))) {
      const name = used(names, item.name);
      if (name && usedNames.has(name) && !result.includes(name)) result.push(name);
    }
    return result;
  };
  const colors = new Map<string, string>();
  for (const s of project.services) {
    const name = used(serviceNames, s.name);
    if (name && s.color && !colors.has(name)) colors.set(name, s.color);
  }
  return {
    title: project.name,
    services: ordered(project.services, serviceNames, usedServices, s => s.position ?? 0),
    // De baixo para cima: a maior posição do Prevision é a linha de baixo da tela dele.
    locals: ordered(project.floors, localNames, usedLocals, f => -f.position).map(name => ({ name, group: localGroup(name) })),
    blocks,
    warnings,
    links,
    colors,
  };
}

// ─── Montagem dos dados da obra ─────────────────────────────────────────────────

export interface PrevisionImportOptions {
  workId: string;
  workName: string;
  actorId: string;
  now: string;
  newId: () => string;
  /** Data da medição que guarda o avanço do arquivo. */
  measurementDate: LocalDate;
  /** Nome do arquivo, para a linha de base e a observação da medição. */
  sourceName: string;
  /** Locais já cadastrados na obra (Configurações): reaproveitados pelo nome. */
  existingLocals?: LobLocal[];
  /** Calendário de dias úteis da obra (`LobData.calendar`); ausente = segunda a sexta sem feriados. */
  calendar?: LobCalendar;
  /** `false` deixa de deduzir os fluxos de serviços (padrão: deduz). */
  withFlows?: boolean;
  /** Nome do sistema de origem na linha de base e na medição (padrão "Prevision"). */
  sourceLabel?: string;
  /** Reordena TODOS os locais da obra pela ordem do arquivo (os já cadastrados sem bloco vão para o
   * fim); os já cadastrados que mudam de posição saem em `localUpdates`. Padrão: os cadastrados
   * ficam onde estão e os novos entram depois. */
  reorderLocals?: boolean;
}
export interface PrevisionFlowEdge {
  predecessorId: string;
  successorId: string;
  /** Nomes dos serviços, para o relatório. */
  predecessor: string;
  successor: string;
  lagDays: number;
  /** Em quantos locais o par aparece em sequência, sobre quantos o sucessor tem antecessor. */
  votes: number;
  of: number;
}
export interface PrevisionFlow {
  group: 'pavimento_tipo' | 'demais';
  document: ServiceFlowDocument;
  locals: string[];
  /** Serviços do grupo que ficaram de fora do fluxo por aparecerem em poucos locais. */
  left: string[];
  edges: PrevisionFlowEdge[];
}
export interface PrevisionImport {
  /** Só os locais novos (os existentes com o mesmo nome são reaproveitados). */
  locals: LobLocal[];
  /** Locais já cadastrados que mudam de posição (só com `reorderLocals`). */
  localUpdates: LobLocal[];
  /** Todos os locais usados, de baixo para cima, com o grupo. */
  localOrder: { local: LobLocal; group: PrevisionLocalGroup }[];
  services: LobService[];
  activities: LobActivity[];
  dependencies: LobDependency[];
  measurement?: LobMeasurement;
  items: LobMeasurementItem[];
  baseline: LobBaseline;
  flows: PrevisionFlow[];
  warnings: string[];
  stats: {
    blocks: number;
    crew: number;
    sequence: number;
    measured: number;
    /** Blocos em que o intervalo do Prevision tem mais dias úteis que a duração (feriados no meio). */
    withHolidays: number;
    /** Só com as dependências reais do Prevision (`schedule.links`). */
    links?: {
      /** Dependências lidas do Prevision. */
      total: number;
      /** Pares repetidos (o mesmo par com dois tipos de vínculo): ficou a mais exigente. */
      merged: number;
      /** A espera foi reduzida à folga real, porque as datas do Prevision não cumprem a regra dele. */
      relaxed: number;
    };
  };
}

/** Folga entre o fim de `a` e o início de `b`, em dias úteis; negativa quando se sobrepõem. */
const signedGap = (a: Pick<LobActivity, 'start' | 'durationDays'>, b: Pick<LobActivity, 'start'>, calendar?: LobCalendar) => {
  const end = activityEnd(a, calendar);
  return b.start >= end ? workdaysBetween(end, b.start, calendar) : -workdaysBetween(b.start, end, calendar);
};
const clampLag = (lag: number) => Math.max(-LOB_LIMITS.lagDays, Math.min(LOB_LIMITS.lagDays, lag));
const validColor = (color: string | undefined) => (color && /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : undefined);
const formatBr = (date: LocalDate) => `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;

export function buildPrevisionImport(schedule: PrevisionSchedule, options: PrevisionImportOptions): PrevisionImport {
  const { workId, actorId, now, newId, calendar } = options;
  if (!isLocalDate(options.measurementDate)) throw new LobError('Data da medição inválida.');
  if (!schedule.blocks.length) throw new LobError('O arquivo não tem nenhum serviço com local e datas.');
  if (schedule.locals.length > LOB_LIMITS.locals) throw new LobError(`O arquivo tem mais de ${LOB_LIMITS.locals} locais.`);
  if (schedule.services.length > LOB_LIMITS.services) throw new LobError(`O arquivo tem mais de ${LOB_LIMITS.services} serviços.`);
  if (schedule.blocks.length > LOB_LIMITS.activities) throw new LobError(`O arquivo tem mais de ${LOB_LIMITS.activities} blocos.`);
  const warnings = [...schedule.warnings];
  const sourceLabel = options.sourceLabel ?? 'Prevision';

  // Locais: os já cadastrados ficam com o id e a posição; os novos entram depois, na ordem do arquivo.
  const existing = new Map((options.existingLocals ?? []).map(l => [normalizeName(l.name), l]));
  let nextIndex = (options.existingLocals ?? []).reduce((max, l) => Math.max(max, l.orderIndex), -1) + 1;
  const locals: LobLocal[] = [];
  const localOrder: PrevisionImport['localOrder'] = [];
  const localByName = new Map<string, LobLocal>();
  const groupOf = new Map<string, PrevisionLocalGroup>();
  for (const { name, group } of schedule.locals) {
    let local = existing.get(normalizeName(name));
    if (!local) {
      local = { id: newId(), workId, name: name.slice(0, LOB_LIMITS.name), orderIndex: nextIndex++, createdAt: now, updatedAt: now };
      locals.push(local);
    }
    localByName.set(name, local);
    groupOf.set(local.id, group);
    localOrder.push({ local, group });
  }
  const localUpdates: LobLocal[] = [];
  if (options.reorderLocals) {
    const usedIds = new Set(localOrder.map(l => l.local.id));
    const rest = [...(options.existingLocals ?? [])].filter(l => !usedIds.has(l.id)).sort((a, b) => a.orderIndex - b.orderIndex);
    const created = new Set(locals);
    [...localOrder.map(l => l.local), ...rest].forEach((local, index) => {
      if (local.orderIndex === index) return;
      if (created.has(local)) local.orderIndex = index;
      else {
        const moved = { ...local, orderIndex: index, updatedAt: now };
        localUpdates.push(moved);
        const entry = localOrder.find(l => l.local === local);
        if (entry) entry.local = moved;
        for (const [name, value] of localByName) if (value === local) localByName.set(name, moved);
      }
    });
  }
  localOrder.sort((a, b) => a.local.orderIndex - b.local.orderIndex);

  // Serviços pela ordem do primeiro início (a legenda e a tabela ficam cronológicas).
  const firstStart = new Map<string, LocalDate>();
  for (const b of schedule.blocks) {
    const current = firstStart.get(b.serviceName);
    if (!current || b.start < current) firstStart.set(b.serviceName, b.start);
  }
  const serviceNames = [...schedule.services].sort(
    (a, b) => firstStart.get(a)!.localeCompare(firstStart.get(b)!) || schedule.services.indexOf(a) - schedule.services.indexOf(b),
  );
  const services: LobService[] = serviceNames.map((name, index) => ({
    id: newId(),
    workId,
    name: name.slice(0, LOB_LIMITS.name),
    color: validColor(schedule.colors?.get(name)) ?? LOB_COLORS[index % LOB_COLORS.length],
    orderIndex: index,
    createdAt: now,
    updatedAt: now,
  }));
  const serviceByName = new Map(serviceNames.map((name, index) => [name, services[index]]));

  // Blocos: as datas do Prevision, com a duração contada em dias úteis do calendário da obra (sem
  // calendário configurado, segunda a sexta sem feriados). Quando o Prevision desconta feriados que o
  // calendário da obra não tem, a duração aqui fica maior e o término igual.
  let withHolidays = 0;
  const workDaysOf = new Map<string, number>();
  const percentOf = new Map<string, number>();
  const activities: LobActivity[] = schedule.blocks.map(b => {
    const durationDays = Math.min(LOB_LIMITS.durationDays, Math.max(1, workdaysBetween(b.start, addDays(b.finish, 1), calendar)));
    if (durationDays > b.workDays) withHolidays++;
    const activity: LobActivity = {
      id: newId(),
      workId,
      serviceId: serviceByName.get(b.serviceName)!.id,
      localId: localByName.get(b.localName)!.id,
      start: b.start,
      durationDays,
      createdAt: now,
      updatedAt: now,
    };
    workDaysOf.set(activity.id, b.workDays);
    percentOf.set(activity.id, b.percent);
    if (schedule.actualDates) {
      if (b.actualStart) activity.actualStart = b.actualStart;
      if (b.actualStart && b.actualFinish) activity.actualFinish = b.actualFinish < b.actualStart ? b.actualStart : b.actualFinish;
      return activity;
    }
    if (b.percent > 0) {
      activity.actualStart = b.start;
      if (b.start > options.measurementDate)
        warnings.push(`"${b.serviceName} › ${b.localName}" tem ${b.percent}% mas começa depois da data da medição.`);
    }
    if (b.percent >= 100) activity.actualFinish = b.finish < options.measurementDate ? b.finish : options.measurementDate;
    return activity;
  });

  const localIndex = new Map(localOrder.map(({ local }, index) => [local.id, index]));
  const flows =
    options.withFlows === false ? [] : deriveFlows(activities, localOrder, workDaysOf, services, options.workName, warnings, calendar);
  const flowLag = new Map<string, number>();
  for (const flow of flows) for (const e of flow.edges) flowLag.set(`${flow.group}|${e.predecessorId}|${e.successorId}`, e.lagDays);

  // Dependências. "Equipe segue": o mesmo serviço, de um local ao próximo na ordem em que acontece,
  // com a espera igual à folga real (como o ritmo do lançamento). Sequência: dentro de cada local
  // (menos equipamentos, que não dependem uns dos outros), cada bloco depende dos que começam
  // imediatamente antes dele; a espera é a do fluxo, sem passar da folga real, para nada se mover.
  const dependencies: LobDependency[] = [];
  const link = (p: LobActivity, s: LobActivity, lagDays: number, kind: LobDependency['kind']) =>
    dependencies.push({ id: newId(), workId, predecessorId: p.id, successorId: s.id, lagDays: clampLag(lagDays), kind, createdAt: now });
  let linkStats: PrevisionImport['stats']['links'];
  if (schedule.links) {
    // Dependências reais do Prevision. Aqui toda dependência é término → início com espera em dias
    // úteis, então cada vínculo vira o início mínimo que ele impõe à sucessora, medido a partir do
    // fim da predecessora (negativo quando as duas se sobrepõem, como no início → início). A espera
    // nunca passa da folga real entre os dois blocos: as datas do Prevision ficam como estão.
    linkStats = { total: schedule.links.length, merged: 0, relaxed: 0 };
    const pairs = new Map<string, { p: LobActivity; s: LobActivity; lag: number }>();
    for (const l of schedule.links) {
      const p = activities[l.predecessor];
      const s = activities[l.successor];
      if (!p || !s || p === s) continue;
      const target = addDays(l.from === 'start' ? p.start : activityFinish(p, calendar), l.lagCalendarDays);
      const required =
        l.to === 'start' ? nextWorkday(target, calendar) : addWorkdays(nextWorkday(target, calendar), -(s.durationDays - 1), calendar);
      const gap = signedGap(p, s, calendar);
      const wanted = signedGap(p, { start: required }, calendar);
      if (wanted > gap) linkStats.relaxed++;
      const lag = Math.min(wanted, gap);
      const key = `${p.id}|${s.id}`;
      const same = pairs.get(key);
      if (same) {
        linkStats.merged++;
        same.lag = Math.max(same.lag, lag);
      } else pairs.set(key, { p, s, lag });
    }
    for (const { p, s, lag } of pairs.values()) link(p, s, lag, p.serviceId === s.serviceId ? 'crew' : 'fs');
  } else {
    const byService = groupBy(activities, a => a.serviceId);
    for (const list of byService.values()) {
      list.sort((a, b) => a.start.localeCompare(b.start) || localIndex.get(a.localId)! - localIndex.get(b.localId)!);
      for (let i = 1; i < list.length; i++) link(list[i - 1], list[i], signedGap(list[i - 1], list[i], calendar), 'crew');
    }
    for (const [localId, list] of groupBy(activities, a => a.localId)) {
      const group = groupOf.get(localId)!;
      if (group === 'equipamentos') continue;
      for (const [s, preds] of immediatePredecessors(list, calendar))
        for (const p of preds) {
          const lag = flowLag.get(`${group}|${p.serviceId}|${s.serviceId}`) ?? 0;
          link(p, s, Math.min(lag, signedGap(p, s, calendar)), 'fs');
        }
    }
  }
  const crew = dependencies.filter(d => d.kind === 'crew').length;
  if (topologicalActivities(activities, dependencies).length !== activities.length)
    throw new LobError(
      schedule.links
        ? 'As dependências do Prevision formam um ciclo.'
        : 'As dependências deduzidas formaram um ciclo. Confira a ordem dos serviços no arquivo.',
    );

  // Medição com o avanço do arquivo e linha de base com as datas importadas.
  const measured = activities.filter(a => (percentOf.get(a.id) ?? 0) > 0);
  const measurement: LobMeasurement | undefined = measured.length
    ? {
        id: newId(),
        workId,
        number: 1,
        date: options.measurementDate,
        status: 'closed',
        note: `Avanço importado do ${sourceLabel} (${options.sourceName}).`,
        createdBy: actorId,
        createdAt: now,
        updatedAt: now,
        closedAt: now,
        closedBy: actorId,
      }
    : undefined;
  const items: LobMeasurementItem[] = measurement
    ? measured.map(a => ({
        id: newId(),
        measurementId: measurement.id,
        workId,
        activityId: a.id,
        value: Math.round(percentOf.get(a.id)! * 10) / 10,
        previousValue: 0,
        createdBy: actorId,
        createdAt: now,
        updatedAt: now,
      }))
    : [];
  const baseline: LobBaseline = {
    id: newId(),
    workId,
    name: `${sourceLabel} — ${options.sourceName} (${formatBr(options.measurementDate)})`.slice(0, LOB_LIMITS.name),
    automatic: false,
    createdBy: actorId,
    createdAt: now,
    snapshot: activities.flatMap((a, index) => {
      const head = { activityId: a.id, serviceId: a.serviceId, localId: a.localId };
      if (!schedule.baseDates) return [{ ...head, start: a.start, durationDays: a.durationDays, finish: activityFinish(a, calendar) }];
      const b = schedule.blocks[index];
      if (!b.baseStart || !b.baseFinish) return [];
      const start = nextWorkday(b.baseStart, calendar);
      const last = previousWorkday(b.baseFinish, calendar);
      const finish = last < start ? start : last;
      const durationDays = Math.min(LOB_LIMITS.durationDays, Math.max(1, workdaysBetween(start, addDays(finish, 1), calendar)));
      return [{ ...head, start, durationDays, finish: activityFinish({ start, durationDays }, calendar) }];
    }),
  };

  return {
    locals,
    localUpdates,
    localOrder,
    services,
    activities,
    dependencies,
    measurement,
    items,
    baseline,
    flows,
    warnings,
    stats: {
      blocks: activities.length,
      crew,
      sequence: dependencies.length - crew,
      measured: items.length,
      withHolidays,
      links: linkStats,
    },
  };
}

function groupBy<T>(list: T[], key: (item: T) => string) {
  const map = new Map<string, T[]>();
  for (const item of list) {
    const k = key(item);
    const bucket = map.get(k);
    if (bucket) bucket.push(item);
    else map.set(k, [item]);
  }
  return map;
}
/** Antecessores imediatos de cada bloco de um local: os que começam no dia de início anterior ao
 * dele (blocos que começam juntos correm em paralelo) e os que terminam na véspera do início dele
 * (término → início sem folga, como o Prevision encadeia). Quem começa no primeiro dia não tem. */
function immediatePredecessors(list: LobActivity[], calendar?: LobCalendar): [LobActivity, LobActivity[]][] {
  const byStart = [...groupBy(list, a => a.start).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, g]) => g);
  const result: [LobActivity, LobActivity[]][] = [];
  byStart.forEach((current, i) => {
    if (!i) return;
    for (const s of current) {
      const preds = new Set(byStart[i - 1]);
      for (const p of list) if (p.start < s.start && activityEnd(p, calendar) === s.start) preds.add(p);
      result.push([s, [...preds]]);
    }
  });
  return result;
}

// ─── Fluxos deduzidos ───────────────────────────────────────────────────────────

/** Fluxo de serviços de um grupo de locais. Entra o serviço presente em ao menos um terço dos
 * locais do grupo (e em dois, se o grupo tem mais de um); a predecessora é antecessora imediata
 * dele (`immediatePredecessors`) na maioria dos locais; a espera é a menor folga real entre os dois; a duração é a mais
 * frequente no Prevision (dias úteis dele, sem os feriados). Serviço que ficaria sem predecessora
 * passa a depender do serviço inicial, porque o lançamento aceita um só. */
function deriveFlows(
  activities: LobActivity[],
  localOrder: PrevisionImport['localOrder'],
  workDaysOf: Map<string, number>,
  services: LobService[],
  workName: string,
  warnings: string[],
  calendar?: LobCalendar,
): PrevisionFlow[] {
  const flows: PrevisionFlow[] = [];
  const serviceById = new Map(services.map(s => [s.id, s]));
  const byLocal = groupBy(activities, a => a.localId);
  for (const group of ['pavimento_tipo', 'demais'] as const) {
    const groupLocals = localOrder.filter(l => l.group === group && byLocal.has(l.local.id)).map(l => l.local);
    if (!groupLocals.length) continue;
    const name = `${LOCAL_GROUP_LABEL[group]} — ${workName}`.slice(0, LOB_LIMITS.name);
    const presence = new Map<string, number>();
    for (const l of groupLocals) for (const a of byLocal.get(l.id)!) presence.set(a.serviceId, (presence.get(a.serviceId) ?? 0) + 1);
    const n = groupLocals.length;
    const minLocals = n === 1 ? 1 : Math.max(2, Math.ceil(n / 3));
    const members = new Set([...presence].filter(([, count]) => count >= minLocals).map(([id]) => id));
    const left = [...presence.keys()].filter(id => !members.has(id)).map(id => serviceById.get(id)!.name);
    if (members.size < 2) {
      warnings.push(`Fluxo "${name}" não criado: menos de dois serviços se repetem nos locais do grupo.`);
      continue;
    }
    const votes = new Map<string, number>();
    const denominators = new Map<string, number>();
    const gaps = new Map<string, number>();
    const durations = new Map<string, Map<number, number>>();
    const firstStart = new Map<string, LocalDate>();
    for (const l of groupLocals) {
      const list = byLocal.get(l.id)!.filter(a => members.has(a.serviceId));
      for (const a of list) {
        const counts = durations.get(a.serviceId) ?? new Map<number, number>();
        const d = workDaysOf.get(a.id)!;
        counts.set(d, (counts.get(d) ?? 0) + 1);
        durations.set(a.serviceId, counts);
        const first = firstStart.get(a.serviceId);
        if (!first || a.start < first) firstStart.set(a.serviceId, a.start);
      }
      for (const [s, preds] of immediatePredecessors(list, calendar)) {
        denominators.set(s.serviceId, (denominators.get(s.serviceId) ?? 0) + 1);
        for (const p of preds) {
          const key = `${p.serviceId}|${s.serviceId}`;
          votes.set(key, (votes.get(key) ?? 0) + 1);
          gaps.set(key, Math.min(gaps.get(key) ?? Infinity, signedGap(p, s, calendar)));
        }
      }
    }
    // Arestas por voto, da mais forte à mais fraca, sem fechar ciclo.
    const candidates = [...votes]
      .map(([key, count]) => {
        const [p, s] = key.split('|');
        return { p, s, count, of: denominators.get(s) ?? 0 };
      })
      .filter(c => c.count * 2 >= c.of && (denominators.get(c.s) ?? 0) * 2 >= (presence.get(c.s) ?? 0))
      .sort((a, b) => b.count / b.of - a.count / a.of || b.count - a.count);
    const preds = new Map<string, Set<string>>([...members].map(id => [id, new Set<string>()]));
    const reaches = (from: string, to: string): boolean => {
      const stack = [from];
      const seen = new Set<string>();
      while (stack.length) {
        const id = stack.pop()!;
        if (id === to) return true;
        if (seen.has(id)) continue;
        seen.add(id);
        stack.push(...preds.get(id)!);
      }
      return false;
    };
    const edges: PrevisionFlowEdge[] = [];
    const edge = (p: string, s: string, lagDays: number, count: number, of: number) =>
      edges.push({
        predecessorId: p,
        successorId: s,
        predecessor: serviceById.get(p)!.name,
        successor: serviceById.get(s)!.name,
        lagDays,
        votes: count,
        of,
      });
    for (const c of candidates) {
      if (reaches(c.p, c.s)) continue; // s já é ancestral de p: ligar fecharia um ciclo
      preds.get(c.s)!.add(c.p);
      edge(c.p, c.s, clampLag(gaps.get(`${c.p}|${c.s}`) ?? 0), c.count, c.of);
    }
    const initials = [...members]
      .filter(id => !preds.get(id)!.size)
      .sort(
        (a, b) => firstStart.get(a)!.localeCompare(firstStart.get(b)!) || serviceById.get(a)!.orderIndex - serviceById.get(b)!.orderIndex,
      );
    for (const id of initials.slice(1)) {
      preds.get(id)!.add(initials[0]);
      edge(initials[0], id, 0, 0, 0);
    }
    const flowServices: FlowService[] = [...members].map(id => {
      const service = serviceById.get(id)!;
      const counts = [...durations.get(id)!].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
      return {
        id: service.id,
        name: service.name,
        color: service.color,
        durationDays: Math.min(LOB_LIMITS.durationDays, Math.max(1, counts[0][0])),
        predecessors: edges.filter(e => e.successorId === id).map(e => ({ serviceId: e.predecessorId, lagDays: e.lagDays })),
      };
    });
    const levels = flowLevels(flowServices);
    flowServices.sort(
      (a, b) => levels.get(a.id)! - levels.get(b.id)! || serviceById.get(a.id)!.orderIndex - serviceById.get(b.id)!.orderIndex,
    );
    const document = validateFlowDocument({ name, direction: 'bottom_up', services: flowServices });
    validateFlowForLaunch(document);
    flows.push({ group, document, locals: groupLocals.map(l => l.name), left, edges });
  }
  return flows;
}

/** Os fluxos guardam ids de serviço da obra; para a empresa, cada fluxo ganha ids próprios. */
export function detachFlowIds(document: ServiceFlowDocument, newId: () => string): ServiceFlowDocument {
  const ids = new Map(document.services.map(s => [s.id, newId()]));
  return {
    ...document,
    services: document.services.map(s => ({
      ...s,
      id: ids.get(s.id)!,
      predecessors: s.predecessors.map(p => ({ serviceId: ids.get(p.serviceId)!, lagDays: p.lagDays })),
    })),
  };
}

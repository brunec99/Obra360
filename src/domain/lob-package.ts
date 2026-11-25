/** O pacote inteiro na Linha de Balanço (25/11/2026, pedido do Jorge Lucas): "as tarefas do mesmo
 * pacote não estão se deslocando todas juntas, preciso fazer para cada pavimento" e "configuração em
 * massa [...] mesma duração ou mesma lógica de predecessoras". Modelo aprovado pelo usuário em
 * 25/11/2026 (https://claude.ai/artifact/6JETav5wYHvnutiret3fGn), com as regras numeradas que os
 * comentários abaixo citam.
 *
 * Funções puras, usadas pelo servidor (`lob-commands.ts`) e pela tela (prévia do arrasto e da janela),
 * para as duas mostrarem e gravarem a mesma coisa. "Pacote" é o serviço (`LobService`); os blocos
 * dele são os `LobActivity` com o mesmo `serviceId`. */
import {
  activityEnd,
  activityFinish,
  addWorkdays,
  LobError,
  minimumStart,
  predecessorsOf,
  successorsOf,
  topologicalActivities,
  workdaysBetween,
  type LobActivity,
  type LobCalendar,
  type LobDependency,
  type LobId,
  type LobLocal,
  type LobPackageEdit,
  type LocalDate,
} from './lob';

const fail = (message: string): never => {
  throw new LobError(message);
};

/** Regra 3: bloco iniciado (com início real, que a medição preenche no primeiro avanço acima de 0%)
 * não se move nem entra na edição em massa. */
export const isStartedActivity = (a: Pick<LobActivity, 'actualStart'>) => !!a.actualStart;

/** Limites dos comandos do pacote. */
export const PACKAGE_LIMITS = {
  /** Deslocamento máximo de uma vez, em dias úteis, para cada lado. */
  deltaDays: 730,
  rules: 5,
  /** "N locais abaixo/acima" vai até 3. */
  localOffset: 3,
} as const;

export interface PackageMoveResult {
  /** Blocos com início novo (os do pacote e as sucessoras empurradas), em ordem topológica: o mesmo
   * formato de `moveActivity`, pronto para `pushChanged`. */
  changed: LobActivity[];
  /** Dias úteis que o pacote andou de fato (com sinal). Menor que o pedido quando a antecipação travou. */
  applied: number;
  /** Blocos do pacote que andaram. */
  moved: LobId[];
  /** Blocos do pacote que ficaram por já estarem iniciados (regra 3). */
  kept: LobId[];
  /** Sucessoras de outros pacotes (ou do próprio, iniciadas) empurradas. */
  pushed: number;
  /** Regra 4: ao antecipar, o bloco do pacote que encostou primeiro numa predecessora de fora. */
  limiter?: { activityId: LobId; predecessorId: LobId };
  /** Regra 4: sucessoras diretas de fora do pacote que ganharam folga (não são puxadas). */
  slack: { count: number; maxDays: number };
}
export interface PackageMovePlanner {
  /** O resultado de mover os blocos não iniciados do serviço `deltaDays` dias úteis, a partir da foto
   * com que o planejador foi montado (cada chamada parte dela; é o que o arrasto usa a cada dia). */
  move(serviceId: LobId, deltaDays: number): PackageMoveResult;
}

/** Planejador de movimentos de pacote sobre UMA foto da obra, como `createMovePlanner` (lob.ts): monta
 * a rede uma vez e responde a vários deslocamentos. Regras 2 e 4: todos os blocos não iniciados andam
 * o mesmo número de dias úteis (o ritmo entre os locais fica); para a frente, as sucessoras são
 * empurradas só quando preciso; para trás, o pacote inteiro para quando o primeiro bloco encosta numa
 * predecessora de fora, e ninguém é puxado. */
export function createPackageMovePlanner(
  activities: LobActivity[],
  dependencies: LobDependency[],
  calendar?: LobCalendar,
): PackageMovePlanner {
  const original = new Map(activities.map(a => [a.id, a]));
  const preds = predecessorsOf(dependencies);
  const succ = successorsOf(dependencies);
  const order = topologicalActivities(activities, dependencies);
  const inOrder = new Set(order.map(a => a.id));
  const endOf = (a: Pick<LobActivity, 'start' | 'durationDays'>) => activityEnd(a, calendar);

  // A cascata da foto sem movimento nenhum (o que `cascade` faria): quem já estava antes do mínimo vai
  // para o lugar. Igual a `createMovePlanner`, para o resultado bater com o do bloco sozinho.
  const settledStart = new Map<LobId, LocalDate>();
  const settledEnd = new Map<LobId, LocalDate>();
  for (const a of order) {
    let start = a.start;
    for (const d of preds.get(a.id) ?? []) {
      const p = original.get(d.predecessorId);
      if (!p) continue;
      const candidate = addWorkdays(settledEnd.get(p.id) ?? endOf(p), d.lagDays, calendar);
      if (candidate > start) start = candidate;
    }
    if (start !== a.start) settledStart.set(a.id, start);
    settledEnd.set(a.id, start === a.start ? endOf(a) : endOf({ start, durationDays: a.durationDays }));
  }
  const startOf0 = (a: LobActivity) => settledStart.get(a.id) ?? a.start;
  const endOf0 = (a: LobActivity) => settledEnd.get(a.id) ?? endOf(a);

  const byService = new Map<LobId, LobActivity[]>();
  for (const a of activities) {
    const list = byService.get(a.serviceId);
    if (list) list.push(a);
    else byService.set(a.serviceId, [a]);
  }
  /** O pacote e tudo o que vem depois dele (direta ou indiretamente), em ordem topológica. */
  const regions = new Map<LobId, LobActivity[]>();
  const regionOf = (serviceId: LobId, members: LobActivity[]) => {
    let list = regions.get(serviceId);
    if (!list) {
      const seen = new Set(members.map(a => a.id));
      const stack = [...seen];
      while (stack.length) {
        const id = stack.pop()!;
        for (const d of succ.get(id) ?? [])
          if (!seen.has(d.successorId)) {
            seen.add(d.successorId);
            stack.push(d.successorId);
          }
      }
      list = order.filter(a => seen.has(a.id));
      regions.set(serviceId, list);
    }
    return list;
  };

  return {
    move(serviceId, deltaDays) {
      const all = byService.get(serviceId) ?? [];
      const members = all.filter(a => !isStartedActivity(a));
      const kept = all.filter(isStartedActivity).map(a => a.id);
      const none: PackageMoveResult = { changed: [], applied: 0, moved: [], kept, pushed: 0, slack: { count: 0, maxDays: 0 } };
      if (!members.length || !deltaDays) return none;
      const inPackage = new Set(members.map(a => a.id));

      let applied = Math.trunc(deltaDays);
      let limiter: PackageMoveResult['limiter'];
      if (applied < 0) {
        // Folga de cada bloco até a predecessora de fora mais exigente; o pacote anda o menor recuo.
        for (const a of members) {
          let minimum: LocalDate | undefined;
          let by: LobId | undefined;
          for (const d of preds.get(a.id) ?? []) {
            if (inPackage.has(d.predecessorId)) continue;
            const p = original.get(d.predecessorId);
            if (!p) continue;
            const candidate = addWorkdays(endOf0(p), d.lagDays, calendar);
            if (!minimum || candidate > minimum) {
              minimum = candidate;
              by = p.id;
            }
          }
          if (!minimum || !by) continue;
          const start = startOf0(a);
          const room = minimum <= start ? workdaysBetween(minimum, start, calendar) : 0;
          if (-room > applied) {
            applied = -room;
            limiter = { activityId: a.id, predecessorId: by };
          }
        }
        if (!applied) return { ...none, limiter };
      }

      // O pacote anda; quem vem depois só é empurrado se ficar antes do mínimo (nunca puxado).
      const movedStart = new Map<LobId, LocalDate>();
      const movedEnd = new Map<LobId, LocalDate>();
      const endAt = (a: LobActivity) => movedEnd.get(a.id) ?? endOf0(a);
      for (const a of regionOf(serviceId, members)) {
        let start = inPackage.has(a.id) ? addWorkdays(startOf0(a), applied, calendar) : startOf0(a);
        for (const d of preds.get(a.id) ?? []) {
          const p = original.get(d.predecessorId);
          if (!p) continue;
          const candidate = addWorkdays(endAt(p), d.lagDays, calendar);
          if (candidate > start) start = candidate;
        }
        movedStart.set(a.id, start);
        movedEnd.set(a.id, endOf({ start, durationDays: a.durationDays }));
      }
      // Bloco do pacote preso num ciclo (fora da ordem) só anda, sem conferir a rede.
      for (const a of members) if (!inOrder.has(a.id)) movedStart.set(a.id, addWorkdays(a.start, applied, calendar));

      const changed: LobActivity[] = [];
      const visit = (a: LobActivity) => {
        const next = movedStart.get(a.id) ?? settledStart.get(a.id) ?? a.start;
        if (next !== a.start) changed.push({ ...a, start: next });
      };
      order.forEach(visit);
      for (const a of activities) if (!inOrder.has(a.id)) visit(a);
      const moved = changed.filter(a => inPackage.has(a.id)).map(a => a.id);
      // Folga nova nas sucessoras diretas de fora do pacote: a distância (em dias úteis) entre o
      // mínimo das predecessoras e o início, antes e depois.
      const startAfter = (a: LobActivity) => movedStart.get(a.id) ?? startOf0(a);
      const gap = (id: LobId, endFn: (a: LobActivity) => LocalDate, startFn: (a: LobActivity) => LocalDate) => {
        const a = original.get(id)!;
        let minimum: LocalDate | undefined;
        for (const d of preds.get(id) ?? []) {
          const p = original.get(d.predecessorId);
          if (!p) continue;
          const candidate = addWorkdays(endFn(p), d.lagDays, calendar);
          if (!minimum || candidate > minimum) minimum = candidate;
        }
        return minimum ? workdaysBetween(minimum, startFn(a), calendar) : 0;
      };
      const slack = { count: 0, maxDays: 0 };
      const seen = new Set<LobId>();
      for (const a of members)
        for (const d of succ.get(a.id) ?? []) {
          if (inPackage.has(d.successorId) || seen.has(d.successorId)) continue;
          seen.add(d.successorId);
          const after = gap(d.successorId, endAt, startAfter);
          if (after > gap(d.successorId, endOf0, startOf0)) {
            slack.count++;
            slack.maxDays = Math.max(slack.maxDays, after);
          }
        }
      return { changed, applied, moved, kept, pushed: changed.length - moved.length, limiter, slack };
    },
  };
}

/** Move o pacote uma vez (o servidor, em `move_service`). */
export function planPackageMove(
  activities: LobActivity[],
  dependencies: LobDependency[],
  serviceId: LobId,
  deltaDays: number,
  calendar?: LobCalendar,
): PackageMoveResult {
  return createPackageMovePlanner(activities, dependencies, calendar).move(serviceId, deltaDays);
}

// ─── Editar o pacote ────────────────────────────────────────────────────────────

export interface PackageEditPlan {
  /** Blocos com início ou duração novos (os do pacote e as sucessoras empurradas). */
  changed: LobActivity[];
  /** Ligações novas, com espera nova e retiradas. */
  insert: LobDependency[];
  update: LobDependency[];
  remove: LobId[];
  /** Blocos do pacote editados (locais marcados, não iniciados). */
  blockIds: LobId[];
  /** Blocos iniciados dos locais marcados, que ficaram de fora (regra 3). */
  kept: LobId[];
  /** Locais sem bloco correspondente no pacote de uma regra (regra 10): ficam sem essa predecessora. */
  skipped: { serviceId: LobId; localIds: LobId[] }[];
  /** Dos blocos do pacote, quantos mudam de início ou duração. */
  changedBlocks: number;
  /** Blocos de fora do pacote empurrados. */
  pushed: number;
  /** Sucessoras diretas de fora do pacote que ganham folga (não são puxadas, regra 4). */
  slack: { count: number; maxDays: number };
  /** Término (último dia trabalhado) do pacote inteiro e da obra, antes e depois. */
  finishBefore: LocalDate;
  finishAfter: LocalDate;
  workFinishBefore: LocalDate;
  workFinishAfter: LocalDate;
}
export interface PackageEditInput {
  activities: LobActivity[];
  dependencies: LobDependency[];
  locals: LobLocal[];
  calendar?: LobCalendar;
}
export interface PackageEditContext {
  workId: LobId;
  now: string;
  newId: () => LobId;
}

const lastFinish = (list: LobActivity[], calendar?: LobCalendar) =>
  list.reduce<LocalDate>((max, a) => {
    const f = activityFinish(a, calendar);
    return f > max ? f : max;
  }, '');

/** "Editar o pacote" (regras 7 a 11): monta, sem gravar, o que muda nos blocos e nas ligações.
 * Recusa com mensagem pronta (`LobError`) o que não dá para aplicar: pacote sem bloco, nenhum local
 * marcado com bloco não iniciado, regra apontando para o próprio pacote, ciclo e "nada a mudar". */
export function planPackageEdit(input: PackageEditInput, edit: LobPackageEdit, context: PackageEditContext): PackageEditPlan {
  const { activities, dependencies, locals, calendar } = input;
  const all = activities.filter(a => a.serviceId === edit.serviceId);
  if (!all.length) fail('Este pacote não tem blocos na Linha de Balanço.');
  const marked = new Set(edit.localIds);
  const members = all.filter(a => marked.has(a.localId) && !isStartedActivity(a));
  const kept = all.filter(a => marked.has(a.localId) && isStartedActivity(a)).map(a => a.id);
  if (!members.length)
    fail(kept.length ? 'Os locais marcados só têm blocos já iniciados, que não entram na edição em massa.' : 'Marque ao menos um local.');
  const inPackage = new Set(members.map(a => a.id));
  const byId = new Map(activities.map(a => [a.id, a]));
  const serviceOf = (id: LobId) => byId.get(id)?.serviceId;

  if (edit.rules.some(r => r.serviceId === edit.serviceId))
    fail('A predecessora precisa ser de outro pacote. A ordem entre os locais do próprio pacote é o ritmo.');
  for (const r of edit.rules)
    if (!activities.some(a => a.serviceId === r.serviceId)) fail('O pacote de uma das predecessoras não tem blocos. Recarregue a página.');

  // Ligações de trabalho: as atuais, com as retiradas marcadas e as esperas novas por cima.
  const current = new Map(dependencies.map(d => [d.id, d]));
  const removed = new Set<LobId>();
  const lagChanges = new Map<LobId, number>();
  const inserted: LobDependency[] = [];
  const liveBetween = (predecessorId: LobId, successorId: LobId) =>
    dependencies.find(d => d.predecessorId === predecessorId && d.successorId === successorId && !removed.has(d.id));
  const removedBetween = (predecessorId: LobId, successorId: LobId) =>
    dependencies.find(d => d.predecessorId === predecessorId && d.successorId === successorId && removed.has(d.id));
  /** Liga `predecessorId` → `successorId` com a espera e o tipo pedidos, reaproveitando a ligação que já
   * existe (ou que acabou de ser retirada) em vez de apagar e criar de novo a mesma coisa. */
  const link = (predecessorId: LobId, successorId: LobId, lagDays: number, kind: LobDependency['kind']) => {
    const same = liveBetween(predecessorId, successorId) ?? removedBetween(predecessorId, successorId);
    if (same && same.kind === kind) {
      removed.delete(same.id);
      if (same.lagDays !== lagDays) lagChanges.set(same.id, lagDays);
      else lagChanges.delete(same.id);
      return;
    }
    if (same) removed.add(same.id);
    const twin = inserted.find(d => d.predecessorId === predecessorId && d.successorId === successorId);
    if (twin) {
      twin.lagDays = lagDays;
      twin.kind = kind;
      return;
    }
    inserted.push({ id: context.newId(), workId: context.workId, predecessorId, successorId, lagDays, kind, createdAt: context.now });
  };

  // Regra 10: predecessoras de outros pacotes.
  const ruleServices = new Set(edit.rules.map(r => r.serviceId));
  if (edit.mode === 'replace')
    for (const d of dependencies)
      if (inPackage.has(d.successorId) && !inPackage.has(d.predecessorId) && ruleServices.has(serviceOf(d.predecessorId) ?? ''))
        removed.add(d.id);
  const sortedLocals = [...locals].sort((a, b) => a.orderIndex - b.orderIndex);
  const position = new Map(sortedLocals.map((l, i) => [l.id, i]));
  const skipped: PackageEditPlan['skipped'] = [];
  for (const rule of edit.rules) {
    const atLocal = new Map<LobId, LobActivity>();
    for (const a of activities.filter(x => x.serviceId === rule.serviceId).sort((x, y) => x.start.localeCompare(y.start)))
      if (!atLocal.has(a.localId)) atLocal.set(a.localId, a);
    const missing: LobId[] = [];
    for (const b of members) {
      const at = position.get(b.localId);
      const target = at === undefined ? undefined : sortedLocals[at + rule.localOffset];
      const pred = target ? atLocal.get(target.id) : undefined;
      if (!pred) {
        missing.push(b.localId);
        continue;
      }
      link(pred.id, b.id, rule.lagDays, 'fs');
    }
    if (missing.length) skipped.push({ serviceId: rule.serviceId, localIds: missing });
  }

  // Regra 9: ritmo. Encadear refaz a ordem entre os locais marcados pela data de início de hoje.
  const chainOrder =
    edit.rhythm === 'chain'
      ? [...members].sort(
          (a, b) =>
            a.start.localeCompare(b.start) || (position.get(a.localId) ?? 0) - (position.get(b.localId) ?? 0) || a.id.localeCompare(b.id),
        )
      : [];
  if (edit.rhythm === 'chain') {
    const chained = new Set<string>();
    for (let k = 1; k < chainOrder.length; k++) chained.add(`${chainOrder[k - 1].id}>${chainOrder[k].id}`);
    for (const d of dependencies)
      if (inPackage.has(d.predecessorId) && inPackage.has(d.successorId) && !chained.has(`${d.predecessorId}>${d.successorId}`))
        removed.add(d.id);
    for (let k = 1; k < chainOrder.length; k++) link(chainOrder[k - 1].id, chainOrder[k].id, edit.lagDays, 'crew');
  }

  const finalDeps: LobDependency[] = [
    ...dependencies.filter(d => !removed.has(d.id)).map(d => (lagChanges.has(d.id) ? { ...d, lagDays: lagChanges.get(d.id)! } : d)),
    ...inserted,
  ];
  if (topologicalActivities(activities, finalDeps).length < topologicalActivities(activities, dependencies).length)
    fail('Essa lógica fecha um ciclo entre os pacotes. Troque o pacote ou o local da predecessora.');

  // Regra 8: duração. Depois, as posições.
  const next = new Map(activities.map(a => [a.id, a]));
  if (edit.durationDays !== undefined)
    for (const a of members) if (a.durationDays !== edit.durationDays) next.set(a.id, { ...a, durationDays: edit.durationDays });
  const finalPreds = predecessorsOf(finalDeps);
  if (edit.rhythm === 'chain')
    chainOrder.forEach((a, k) => {
      const block = next.get(a.id)!;
      const minimum = minimumStart(a.id, next, finalPreds, calendar);
      // O primeiro local fica onde está (só anda se a predecessora empurrar); os seguintes encostam no
      // anterior mais a espera, o que pode trazê-los para trás, nunca antes de uma predecessora de fora.
      const start = k === 0 ? (minimum && minimum > block.start ? minimum : block.start) : (minimum ?? block.start);
      if (start !== block.start) next.set(a.id, { ...block, start });
    });
  // A cascata de sempre, por cima: só empurra para a frente.
  for (const a of topologicalActivities([...next.values()], finalDeps)) {
    const block = next.get(a.id)!;
    const minimum = minimumStart(a.id, next, finalPreds, calendar);
    if (minimum && minimum > block.start) next.set(a.id, { ...block, start: minimum });
  }

  const changed = activities
    .map(a => next.get(a.id)!)
    .filter(a => {
      const before = byId.get(a.id)!;
      return a.start !== before.start || a.durationDays !== before.durationDays;
    });
  const update = finalDeps.filter(d => lagChanges.has(d.id));
  const remove = [...removed].filter(id => current.has(id));
  if (!changed.length && !inserted.length && !update.length && !remove.length) fail('Nada a mudar: o pacote já está assim.');

  // Folga nova nas sucessoras diretas de fora do pacote (regra 4: elas não são puxadas).
  const beforePreds = predecessorsOf(dependencies);
  const gap = (map: Map<LobId, LobActivity>, predMap: Map<LobId, LobDependency[]>, id: LobId) => {
    const minimum = minimumStart(id, map, predMap, calendar);
    return minimum ? workdaysBetween(minimum, map.get(id)!.start, calendar) : 0;
  };
  const followers = new Set<LobId>();
  for (const d of finalDeps) if (inPackage.has(d.predecessorId) && !inPackage.has(d.successorId)) followers.add(d.successorId);
  let slackCount = 0;
  let slackMax = 0;
  for (const id of followers) {
    const after = gap(next, finalPreds, id);
    if (after > gap(byId, beforePreds, id)) {
      slackCount++;
      slackMax = Math.max(slackMax, after);
    }
  }

  const changedBlocks = changed.filter(a => inPackage.has(a.id)).length;
  const nextAll = activities.map(a => next.get(a.id)!);
  return {
    changed,
    insert: inserted,
    update,
    remove,
    blockIds: members.map(a => a.id),
    kept,
    skipped,
    changedBlocks,
    pushed: changed.length - changedBlocks,
    slack: { count: slackCount, maxDays: slackMax },
    finishBefore: lastFinish(all, calendar),
    finishAfter: lastFinish(
      all.map(a => next.get(a.id)!),
      calendar,
    ),
    workFinishBefore: lastFinish(activities, calendar),
    workFinishAfter: lastFinish(nextAll, calendar),
  };
}

/** A lógica que o pacote tem hoje, para a janela mostrar ("Hoje neste pacote: …") e sugerir a regra
 * inicial: ligações vindas de outros pacotes agrupadas por pacote, posição do local e espera, e as
 * ligações entre os próprios locais agrupadas por espera. */
export interface PackageLogic {
  external: { serviceId: LobId; localOffset: number; lagDays: number; count: number }[];
  internal: { lagDays: number; count: number }[];
}
export function packageLogic(input: Pick<PackageEditInput, 'activities' | 'dependencies' | 'locals'>, serviceId: LobId): PackageLogic {
  const byId = new Map(input.activities.map(a => [a.id, a]));
  const position = new Map([...input.locals].sort((a, b) => a.orderIndex - b.orderIndex).map((l, i) => [l.id, i]));
  const external = new Map<string, PackageLogic['external'][number]>();
  const internal = new Map<number, number>();
  for (const d of input.dependencies) {
    const s = byId.get(d.successorId);
    const p = byId.get(d.predecessorId);
    if (!s || !p || s.serviceId !== serviceId) continue;
    if (p.serviceId === serviceId) {
      internal.set(d.lagDays, (internal.get(d.lagDays) ?? 0) + 1);
      continue;
    }
    const localOffset = (position.get(p.localId) ?? 0) - (position.get(s.localId) ?? 0);
    const key = `${p.serviceId}|${localOffset}|${d.lagDays}`;
    const entry = external.get(key) ?? { serviceId: p.serviceId, localOffset, lagDays: d.lagDays, count: 0 };
    entry.count++;
    external.set(key, entry);
  }
  return {
    external: [...external.values()].sort((a, b) => b.count - a.count),
    internal: [...internal.entries()].map(([lagDays, count]) => ({ lagDays, count })).sort((a, b) => b.count - a.count),
  };
}

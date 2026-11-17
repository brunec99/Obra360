import { activityEnd, addWorkdays, workdaysBetween, type LobActivity, type LobDependency, type LobId, type LocalDate } from './lob';

/** Caminho crítico da Linha de Balanço (16/11/2026, retorno do Atmos): folga total de cada bloco em
 * dias úteis, pela passagem de volta do CPM sobre as dependências entre blocos (as duas espécies,
 * "depois de" e "equipe segue", com a espera de cada uma).
 *
 * A Linha de Balanço não reagenda para o mais cedo: cada bloco fica onde foi posto, e a cascata só
 * empurra quem ficaria antes do mínimo. Por isso a folga sai da data ATUAL do bloco: é quantos dias
 * úteis ele pode atrasar sem empurrar o término da obra. Folga zero (ou negativa, quando alguma
 * dependência está violada) = crítico. Bloco sem sucessora só é crítico se termina no fim da obra. */

export interface LobCriticalPath {
  /** Primeiro dia útil livre depois do último bloco (fim exclusivo da obra). */
  end?: LocalDate;
  /** Folga total por bloco, em dias úteis. Bloco preso num ciclo de dependências fica de fora. */
  floatDays: Map<LobId, number>;
  /** Blocos com folga zero ou negativa. */
  criticalIds: Set<LobId>;
}

export function lobCriticalPath(activities: LobActivity[], dependencies: LobDependency[]): LobCriticalPath {
  const floatDays = new Map<LobId, number>();
  const criticalIds = new Set<LobId>();
  if (!activities.length) return { floatDays, criticalIds };

  const byId = new Map(activities.map(a => [a.id, a]));
  const successors = new Map<LobId, LobDependency[]>();
  const predecessors = new Map<LobId, LobDependency[]>();
  const waiting = new Map<LobId, number>(activities.map(a => [a.id, 0]));
  for (const d of dependencies) {
    if (d.predecessorId === d.successorId || !byId.has(d.predecessorId) || !byId.has(d.successorId)) continue;
    (successors.get(d.predecessorId) ?? successors.set(d.predecessorId, []).get(d.predecessorId)!).push(d);
    (predecessors.get(d.successorId) ?? predecessors.set(d.successorId, []).get(d.successorId)!).push(d);
    waiting.set(d.predecessorId, (waiting.get(d.predecessorId) ?? 0) + 1);
  }

  let end = activityEnd(activities[0]);
  for (const a of activities) {
    const e = activityEnd(a);
    if (e > end) end = e;
  }

  // De trás para a frente: um bloco entra na fila quando todas as sucessoras dele já têm início tardio.
  const lateStart = new Map<LobId, LocalDate>();
  let ready = activities.filter(a => !waiting.get(a.id)).map(a => a.id);
  while (ready.length) {
    const next: LobId[] = [];
    for (const id of ready) {
      const a = byId.get(id)!;
      let lateEnd = end;
      for (const d of successors.get(id) ?? []) {
        // A sucessora começa, no mínimo, `lagDays` dias úteis depois do fim deste bloco.
        const limit = addWorkdays(lateStart.get(d.successorId)!, -d.lagDays);
        if (limit < lateEnd) lateEnd = limit;
      }
      const late = addWorkdays(lateEnd, -a.durationDays);
      lateStart.set(id, late);
      const slack = late >= a.start ? workdaysBetween(a.start, late) : -workdaysBetween(late, a.start);
      floatDays.set(id, slack);
      if (slack <= 0) criticalIds.add(id);
      for (const d of predecessors.get(id) ?? []) {
        const left = (waiting.get(d.predecessorId) ?? 0) - 1;
        waiting.set(d.predecessorId, left);
        if (left === 0) next.push(d.predecessorId);
      }
    }
    ready = next;
  }
  return { end, floatDays, criticalIds };
}

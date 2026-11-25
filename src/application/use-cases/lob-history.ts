import { DEFAULT_LOB_CALENDAR, weekdaysLabel, type LobCalendar } from '../../domain/lob-calendar';
import {
  workdayDelta,
  type LobActivity,
  type LobBaseline,
  type LobCommand,
  type LobDependency,
  type LobDependencyKind,
  type LobDirection,
  type LobLocal,
  type LobPackageRule,
  type LobRhythm,
  type LobService,
  type LocalDate,
} from '../../domain/lob';
import { formatDate } from '../../shared/format';
import type { LobMutation } from './lob-commands';

/** Histórico de alterações da Linha de Balanço (25/11/2026). Em 24/11 apareceram 277 blocos do Atmos
 * movidos em 16/11 sem como saber por quem: o sistema guardava só `updated_at`. Regra aprovada pelo
 * usuário: toda alteração grava quem, quando, o quê e as datas antes e depois, na tabela de histórico
 * que o curto prazo já usa (`history_events`, só de inclusão), sem migração; um botão "Histórico" na
 * barra mostra as últimas 100 alterações e a Claudia passa a consultar.
 *
 * Funções puras, sem banco: a rota de comandos monta o registro com `buildLobHistoryEntry` depois de
 * gravar, e a leitura transforma cada registro em frase com `describeLobHistory`, com os nomes de
 * hoje. No caminho curto dos comandos de datas (`update_activity`, `set_activity_dates`,
 * `move_service`) a rota só carrega blocos, ligações e calendário, sem nomes: por isso o registro
 * guarda ids, e os nomes saem na leitura. Quando a rota tem os nomes (os demais comandos), o nome do
 * momento também fica gravado, para a frase não perder o pacote ou o local excluído depois. */

/** Um bloco alterado: [bloco, início antes, duração antes, início depois, duração depois]. Bloco criado
 * tem o "antes" vazio ('' e 0); bloco excluído, o "depois" vazio. */
export type LobHistoryBlock = [activityId: string, fromStart: string, fromDuration: number, toStart: string, toDuration: number];

/** Até quantos blocos o registro guarda as datas; `blocksTotal` conta todos, mesmo além do corte. */
export const LOB_HISTORY_BLOCK_LIMIT = 2000;
/** Até quantos dias sem trabalho marcados (ou desmarcados) o registro lista; o total vem à parte. */
const CALENDAR_DATES_LIMIT = 31;
/** Até quantos nomes de locais cadastrados de uma vez o registro lista. */
const NAMES_LIMIT = 20;

/** Mudança de calendário resumida: dias da semana antes e depois, quantos dias sem trabalho havia e
 * há, e quais foram marcados ou desmarcados. */
export interface LobHistoryCalendarChange {
  weekdaysFrom: number[];
  weekdaysTo: number[];
  holidaysFrom: number;
  holidaysTo: number;
  added: LocalDate[];
  addedTotal: number;
  removed: LocalDate[];
  removedTotal: number;
}

/** O que mudou, versão 1. Só os campos que importam para descrever a alteração; o comando inteiro não
 * é copiado (em `save_costs`, por exemplo, só as contagens: valor em reais nunca entra no histórico). */
export interface LobHistoryChanges {
  v: 1;
  /** Alvo do comando, quando houver. */
  serviceId?: string;
  activityId?: string;
  localId?: string;
  dependencyId?: string;
  baselineId?: string;
  /** Nome no momento da alteração (pacote, local ou linha de base), quando a rota o tinha. */
  name?: string;
  /** Nome de antes, ao renomear. */
  previousName?: string;
  /** Locais cadastrados de uma vez (até 20 nomes); o total em `count`. */
  names?: string[];
  /** Contagem do comando: locais cadastrados ou reordenados, datas pedidas no "Desfazer". */
  count?: number;
  /** Pacote e local de cada bloco citado (o do comando, a predecessora e a sucessora da ligação), para
   * o nome sair mesmo depois de o bloco ser excluído. */
  refs?: Record<string, [serviceId: string, localId: string]>;
  /** Ligação (add/update/remove_dependency). */
  predecessorId?: string;
  successorId?: string;
  lagDays?: number;
  previousLagDays?: number;
  kind?: LobDependencyKind;
  /** Deslocamento pedido (`move_service`) e o aplicado (`move_service` e `update_activity`), em dias
   * úteis com sinal: positivo = para a frente. */
  deltaDays?: number;
  appliedDays?: number;
  /** Blocos empurrados além do próprio bloco (`update_activity`). */
  pushed?: number;
  /** Início e duração pedidos (`update_activity`) ou do bloco criado (`create_activity`). */
  start?: LocalDate;
  durationDays?: number;
  previousDurationDays?: number;
  /** Datas reais de um bloco, antes e depois (`update_activity`); null = vazia. */
  actualStart?: [LocalDate | null, LocalDate | null];
  actualFinish?: [LocalDate | null, LocalDate | null];
  notesChanged?: boolean;
  /** Campos alterados do pacote (`update_service`). */
  fields?: ('name' | 'color' | 'team' | 'unit')[];
  /** "Editar o pacote": locais marcados e o que foi pedido. */
  edit?: {
    localCount: number;
    durationDays?: number;
    rhythm: 'chain' | 'keep';
    lagDays: number;
    rules: LobPackageRule[];
    mode: 'replace' | 'add';
  };
  /** Lançamento de fluxo. */
  launch?: { flowId: string; flowName?: string; localCount: number; start: LocalDate; direction: LobDirection; rhythm: LobRhythm };
  calendar?: LobHistoryCalendarChange;
  /** Itens de custo novos, alterados e excluídos: só contagens. */
  costs?: { inserted: number; updated: number; removed: number };
  /** Locais e pacotes criados junto (lançamento e importação do Planejador). */
  created?: { locals: number; services: number };
  /** Nome da linha de base automática guardada antes da alteração, se houve. */
  automaticBaseline?: string;
  /** Datas antes e depois de cada bloco alterado, criado ou excluído (até `LOB_HISTORY_BLOCK_LIMIT`). */
  blocks: LobHistoryBlock[];
  blocksTotal: number;
  /** Ligações criadas, excluídas e com espera nova. */
  links: { added: number; removed: number; updated: number };
  /** Os números que o comando devolve à tela (`LobMutation.summary`), quando houver. */
  summary?: Record<string, number>;
}

export interface LobHistoryRecord {
  id: string;
  /** A obra. */
  entityId: string;
  entityType: 'lob';
  action: LobCommand['type'];
  authorId: string;
  occurredAt: string;
  changes: LobHistoryChanges;
}

/** Um item da lista do botão "Histórico" (GET /api/lob/history), já com a frase pronta. */
export interface LobHistoryItem {
  id: string;
  occurredAt: string;
  authorId: string;
  authorName: string;
  action: string;
  text: string;
  blocks: number;
}

/** A obra como estava antes do comando: no caminho de datas, só blocos, ligações e calendário. A rota
 * pode passar o `LobData` inteiro. */
export interface LobHistoryBefore {
  activities: LobActivity[];
  dependencies: LobDependency[];
  services?: LobService[];
  locals?: LobLocal[];
  baselines?: LobBaseline[];
  calendar?: LobCalendar;
}

/** Comandos de medição: têm autor próprio (quem abriu, lançou, fechou) e não são o cronograma. */
const MEASUREMENT_COMMANDS: ReadonlySet<LobCommand['type']> = new Set<LobCommand['type']>([
  'open_measurement',
  'update_measurement',
  'save_items',
  'remove_item',
  'close_measurement',
  'delete_measurement',
  'add_photo',
  'delete_photo',
]);

const writesSomething = (m: LobMutation) =>
  !!m.calendar ||
  [m.insert, m.update].some(set => Object.values(set).some(list => list.length > 0)) ||
  Object.values(m.delete).some(list => list.length > 0);

/** Datas antes e depois de cada bloco que a gravação cria, muda (início ou duração) ou exclui. */
function blockChanges(before: Map<string, LobActivity>, mutation: LobMutation): LobHistoryBlock[] {
  const list: LobHistoryBlock[] = [];
  for (const a of mutation.update.activities) {
    const b = before.get(a.id);
    if (b && (b.start !== a.start || b.durationDays !== a.durationDays))
      list.push([a.id, b.start, b.durationDays, a.start, a.durationDays]);
  }
  for (const a of mutation.insert.activities) list.push([a.id, '', 0, a.start, a.durationDays]);
  for (const id of mutation.delete.activities) {
    const b = before.get(id);
    if (b) list.push([id, b.start, b.durationDays, '', 0]);
  }
  return list;
}

/** O pacote do "Desfazer" de "Editar o pacote", que o comando não informa: o mais frequente entre as
 * sucessoras das ligações devolvidas (elas são do pacote editado) ou, sem ligação, entre os blocos. */
function revertedService(before: LobHistoryBefore, command: Extract<LobCommand, { type: 'revert_service_edit' }>) {
  const activities = new Map(before.activities.map(a => [a.id, a]));
  const deps = new Map(before.dependencies.map(d => [d.id, d]));
  const count = new Map<string, number>();
  const add = (activityId: string | undefined) => {
    const serviceId = activityId ? activities.get(activityId)?.serviceId : undefined;
    if (serviceId) count.set(serviceId, (count.get(serviceId) ?? 0) + 1);
  };
  for (const id of command.links.remove) add(deps.get(id)?.successorId);
  for (const u of command.links.update) add(deps.get(u.dependencyId)?.successorId);
  for (const r of command.links.restore) add(r.successorId);
  if (!count.size) for (const item of command.items) add(item.activityId);
  let best: string | undefined;
  for (const [serviceId, n] of count) if (!best || n > count.get(best)!) best = serviceId;
  return best;
}

function calendarChange(from: LobCalendar | undefined, to: LobCalendar): LobHistoryCalendarChange {
  const a = from ?? DEFAULT_LOB_CALENDAR;
  const before = new Set(a.holidays);
  const after = new Set(to.holidays);
  const added = to.holidays.filter(d => !before.has(d));
  const removed = a.holidays.filter(d => !after.has(d));
  return {
    weekdaysFrom: [...a.weekdays],
    weekdaysTo: [...to.weekdays],
    holidaysFrom: a.holidays.length,
    holidaysTo: to.holidays.length,
    added: added.slice(0, CALENDAR_DATES_LIMIT),
    addedTotal: added.length,
    removed: removed.slice(0, CALENDAR_DATES_LIMIT),
    removedTotal: removed.length,
  };
}

/** O registro de histórico de um comando já planejado (`planLobCommand`), para a rota gravar depois de
 * aplicar a gravação. `null` para os comandos de medição e para o comando que não grava nada. */
export function buildLobHistoryEntry(
  before: LobHistoryBefore,
  command: LobCommand,
  mutation: LobMutation,
  context: { actorId: string; now: string; newId: () => string },
): LobHistoryRecord | null {
  if (MEASUREMENT_COMMANDS.has(command.type)) return null;
  if (!writesSomething(mutation)) return null;
  const activities = new Map(before.activities.map(a => [a.id, a]));
  const inserted = new Map(mutation.insert.activities.map(a => [a.id, a]));
  const all = blockChanges(activities, mutation);
  const changes: LobHistoryChanges = {
    v: 1,
    blocks: all.slice(0, LOB_HISTORY_BLOCK_LIMIT),
    blocksTotal: all.length,
    links: {
      added: mutation.insert.dependencies.length,
      removed: mutation.delete.dependencies.length,
      updated: mutation.update.dependencies.length,
    },
  };
  if (mutation.summary) changes.summary = { ...mutation.summary };
  const automatic = mutation.insert.baselines.find(b => b.automatic);
  if (automatic) changes.automaticBaseline = automatic.name;

  const ref = (id: string | undefined) => {
    const a = id ? (activities.get(id) ?? inserted.get(id)) : undefined;
    if (a) changes.refs = { ...changes.refs, [a.id]: [a.serviceId, a.localId] };
  };
  const serviceName = (id: string) => before.services?.find(s => s.id === id)?.name;
  const localName = (id: string) => before.locals?.find(l => l.id === id)?.name;
  const baselineName = (id: string) => before.baselines?.find(b => b.id === id)?.name;
  const set = <K extends keyof LobHistoryChanges>(key: K, value: LobHistoryChanges[K] | undefined) => {
    if (value !== undefined) changes[key] = value as LobHistoryChanges[K];
  };

  switch (command.type) {
    case 'create_locals':
      changes.names = mutation.insert.locals.map(l => l.name).slice(0, NAMES_LIMIT);
      changes.count = mutation.insert.locals.length;
      break;
    case 'rename_local':
      changes.localId = command.localId;
      set('previousName', localName(command.localId));
      changes.name = command.name;
      break;
    case 'reorder_locals':
      changes.count = mutation.update.locals.length;
      break;
    case 'delete_local':
      changes.localId = command.localId;
      set('name', localName(command.localId));
      break;
    case 'create_service':
      set('serviceId', mutation.insert.services[0]?.id);
      changes.name = command.name;
      break;
    case 'update_service': {
      changes.serviceId = command.serviceId;
      const old = before.services?.find(s => s.id === command.serviceId);
      const next = mutation.update.services.find(s => s.id === command.serviceId);
      if (old && next) {
        const fields: NonNullable<LobHistoryChanges['fields']> = [];
        if (old.name !== next.name) fields.push('name');
        if (old.color !== next.color) fields.push('color');
        if ((old.team ?? '') !== (next.team ?? '')) fields.push('team');
        if ((old.unit ?? '') !== (next.unit ?? '')) fields.push('unit');
        changes.fields = fields;
        changes.name = next.name;
        if (old.name !== next.name) changes.previousName = old.name;
      }
      break;
    }
    case 'delete_service':
      changes.serviceId = command.serviceId;
      set('name', serviceName(command.serviceId));
      break;
    case 'create_activity': {
      const created = mutation.insert.activities[0];
      changes.serviceId = command.serviceId;
      changes.localId = command.localId;
      if (created) {
        changes.activityId = created.id;
        changes.start = created.start;
        changes.durationDays = created.durationDays;
        ref(created.id);
      }
      break;
    }
    case 'update_activity': {
      const id = command.activityId;
      changes.activityId = id;
      ref(id);
      set('start', command.start);
      const old = activities.get(id);
      const next = mutation.update.activities.find(a => a.id === id);
      if (old && next) {
        if (old.start !== next.start) changes.appliedDays = workdayDelta(old.start, next.start, before.calendar);
        if (old.durationDays !== next.durationDays) {
          changes.previousDurationDays = old.durationDays;
          changes.durationDays = next.durationDays;
        }
        if ((old.actualStart ?? null) !== (next.actualStart ?? null))
          changes.actualStart = [old.actualStart ?? null, next.actualStart ?? null];
        if ((old.actualFinish ?? null) !== (next.actualFinish ?? null))
          changes.actualFinish = [old.actualFinish ?? null, next.actualFinish ?? null];
        if ((old.notes ?? '') !== (next.notes ?? '')) changes.notesChanged = true;
      }
      changes.pushed = all.filter(b => b[0] !== id).length;
      break;
    }
    case 'delete_activity':
      changes.activityId = command.activityId;
      ref(command.activityId);
      break;
    case 'add_dependency':
      set('dependencyId', mutation.insert.dependencies[0]?.id);
      changes.predecessorId = command.predecessorId;
      changes.successorId = command.successorId;
      changes.lagDays = command.lagDays;
      changes.kind = command.kind ?? 'fs';
      ref(command.predecessorId);
      ref(command.successorId);
      break;
    case 'update_dependency':
    case 'remove_dependency': {
      changes.dependencyId = command.dependencyId;
      const old = before.dependencies.find(d => d.id === command.dependencyId);
      if (old) {
        changes.predecessorId = old.predecessorId;
        changes.successorId = old.successorId;
        changes.kind = old.kind;
        ref(old.predecessorId);
        ref(old.successorId);
      }
      if (command.type === 'update_dependency') {
        set('previousLagDays', old?.lagDays);
        changes.lagDays = command.lagDays;
      } else set('lagDays', old?.lagDays);
      break;
    }
    case 'launch_flow':
      changes.launch = {
        flowId: command.flowId,
        flowName: mutation.insert.launches[0]?.flowName,
        localCount: command.params.localIds.length,
        start: command.params.start,
        direction: command.params.direction,
        rhythm: command.params.rhythm,
      };
      changes.created = { locals: mutation.insert.locals.length, services: mutation.insert.services.length };
      break;
    case 'import_planner':
      changes.created = { locals: mutation.insert.locals.length, services: mutation.insert.services.length };
      break;
    case 'create_baseline':
      set('baselineId', mutation.insert.baselines[0]?.id);
      changes.name = command.name;
      break;
    case 'restore_baseline':
    case 'delete_baseline':
      changes.baselineId = command.baselineId;
      set('name', baselineName(command.baselineId));
      break;
    case 'save_costs':
      // Só contagens: valor, descrição e código dos itens ficam de fora do histórico.
      changes.costs = {
        inserted: mutation.insert.costs.length,
        updated: mutation.update.costs.length,
        removed: mutation.delete.costs.length,
      };
      break;
    case 'set_calendar':
      changes.calendar = calendarChange(before.calendar, command.calendar);
      break;
    case 'set_activity_dates':
      changes.count = command.items.length;
      break;
    case 'move_service':
      changes.serviceId = command.serviceId;
      changes.deltaDays = command.deltaDays;
      set('appliedDays', mutation.summary?.applied);
      break;
    case 'edit_service':
      changes.serviceId = command.serviceId;
      changes.edit = {
        localCount: command.localIds.length,
        ...(command.durationDays !== undefined ? { durationDays: command.durationDays } : {}),
        rhythm: command.rhythm,
        lagDays: command.lagDays,
        rules: command.rules.map(r => ({ serviceId: r.serviceId, localOffset: r.localOffset, lagDays: r.lagDays })),
        mode: command.mode,
      };
      break;
    case 'revert_service_edit':
      set('serviceId', revertedService(before, command));
      changes.count = command.items.length;
      break;
  }

  return {
    id: context.newId(),
    entityId: mutation.workId,
    entityType: 'lob',
    action: command.type,
    authorId: context.actorId,
    occurredAt: context.now,
    changes,
  };
}

// ─── Leitura: a frase de cada alteração ─────────────────────────────────────────

/** Nomes de hoje, carregados na leitura. */
export interface LobHistoryNames {
  services: Map<string, string>;
  locals: Map<string, string>;
  activities: Map<string, { serviceId: string; localId: string }>;
  authors: Map<string, string>;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** "1 dia útil", "5 dias úteis" (sem sinal). */
const workdays = (n: number) => plural(Math.abs(n), 'dia útil', 'dias úteis');
/** Espera com sinal: "2", "−3". */
const signed = (n: number) => (n < 0 ? `−${Math.abs(n)}` : String(n));
const towards = (n: number) => (n > 0 ? 'para a frente' : 'para trás');
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
/** "A", "A e B", "A, B e C". */
function joinList(items: string[]) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} e ${items[items.length - 1]}`;
}
const details = (parts: (string | false | undefined)[]) => {
  const list = parts.filter((p): p is string => !!p);
  return list.length ? ` (${list.join('; ')})` : '';
};
/** "no mesmo local", "1 local abaixo", "2 locais acima". */
function offsetLabel(offset: number) {
  if (!offset) return 'no mesmo local';
  return `${plural(Math.abs(offset), 'local', 'locais')} ${offset < 0 ? 'abaixo' : 'acima'}`;
}
function linksLabel(links: Partial<LobHistoryChanges['links']> | undefined) {
  const added = num(links?.added);
  const removed = num(links?.removed);
  const updated = num(links?.updated);
  const parts: string[] = [];
  if (added || removed) parts.push(`+${added} −${removed} ligações`);
  if (updated) parts.push(`${plural(updated, 'ligação', 'ligações')} com espera nova`);
  return parts.length ? parts.join('; ') : undefined;
}
const dates = (list: unknown, total: number) => {
  const shown = (Array.isArray(list) ? list : []).filter((d): d is string => typeof d === 'string').slice(0, 3);
  return shown.length ? ` (${shown.map(formatDate).join(', ')}${total > shown.length ? '…' : ''})` : '';
};

/** Nome do autor para a lista: o do perfil ou, sem perfil, "Usuário removido". */
export const lobHistoryAuthor = (authorId: string, authors: Map<string, string>) => authors.get(authorId) ?? 'Usuário removido';

/** A frase pronta de um registro, com os nomes de hoje (pacote, local ou bloco que não existe mais vira
 * "pacote excluído", "local excluído", "bloco excluído"), e quantos blocos ela mexeu. Tolera registro
 * fora do formato (campo faltando ou de outra versão): a frase fica genérica, sem quebrar a lista. */
export function describeLobHistory(record: LobHistoryRecord, names: LobHistoryNames): { text: string; blocks: number } {
  const c = (record.changes && typeof record.changes === 'object' ? record.changes : {}) as Partial<LobHistoryChanges>;
  const blocks = typeof c.blocksTotal === 'number' ? c.blocksTotal : Array.isArray(c.blocks) ? c.blocks.length : 0;
  const summary = c.summary && typeof c.summary === 'object' ? c.summary : {};
  /** Nome de hoje do pacote ou, se ele não existe mais, o gravado no registro. */
  const serviceName = (id: unknown, stored?: unknown) => (typeof id === 'string' ? names.services.get(id) : undefined) || str(stored);
  /** "o pacote DRY - Estruturação" ou "o pacote excluído". */
  const thePackage = (id: unknown, stored?: unknown) => {
    const name = serviceName(id, stored);
    return name ? `o pacote ${name}` : 'o pacote excluído';
  };
  /** "ACA - Lixamento de teto · 2ºpavto": o bloco pelo pacote e pelo local de hoje (ou os gravados em
   * `refs`, se o bloco foi excluído); indefinido quando não sobrou nenhum dos dois. */
  const blockName = (id: unknown): string | undefined => {
    if (typeof id !== 'string') return undefined;
    const stored = c.refs?.[id];
    const ref = names.activities.get(id) ?? (Array.isArray(stored) ? { serviceId: stored[0], localId: stored[1] } : undefined);
    if (!ref) return undefined;
    const s = names.services.get(ref.serviceId);
    const l = names.locals.get(ref.localId);
    if (!s && !l) return undefined;
    return `${s ?? 'pacote excluído'} · ${l ?? 'local excluído'}`;
  };
  /** "o bloco ACA - Lixamento de teto · 2ºpavto" ou "o bloco excluído". */
  const theBlock = (id: unknown) => {
    const name = blockName(id);
    return name ? `o bloco ${name}` : 'o bloco excluído';
  };
  const blockLabel = (id: unknown) => blockName(id) ?? 'bloco excluído';
  const blocksPart = (n: number) => (n ? plural(n, 'bloco', 'blocos') : undefined);
  const pushedPart = (n: number) => (n ? plural(n, 'sucessora empurrada', 'sucessoras empurradas') : undefined);
  const keptPart = (n: number) => (n ? plural(n, 'iniciado ficou', 'iniciados ficaram') : undefined);
  const baseline = (stored: unknown) => (str(stored) ? `a linha de base "${str(stored)}"` : 'uma linha de base já excluída');

  const text = ((): string => {
    switch (record.action) {
      case 'create_locals': {
        const list = Array.isArray(c.names) ? c.names.filter((n): n is string => typeof n === 'string') : [];
        const count = num(c.count) || list.length;
        return `Cadastrou ${plural(count, 'local', 'locais')}${list.length ? `: ${list.join(', ')}${count > list.length ? '…' : ''}` : ''}.`;
      }
      case 'rename_local': {
        const after = str(c.name) ?? (typeof c.localId === 'string' ? names.locals.get(c.localId) : undefined) ?? 'outro nome';
        return str(c.previousName) ? `Renomeou o local ${str(c.previousName)} para ${after}.` : `Renomeou um local para ${after}.`;
      }
      case 'reorder_locals':
        return `Reordenou os locais da obra${details([num(c.count) ? `${plural(num(c.count), 'local mudou', 'locais mudaram')} de posição` : undefined])}.`;
      case 'delete_local':
        return str(c.name) ? `Excluiu o local ${str(c.name)}.` : 'Excluiu um local.';
      case 'create_service':
        return `Criou ${thePackage(c.serviceId, c.name)}.`;
      case 'update_service': {
        const fields = Array.isArray(c.fields) ? c.fields : [];
        const labels = fields.map(f =>
          f === 'name'
            ? `nome${str(c.previousName) ? ` (antes ${str(c.previousName)})` : ''}`
            : f === 'color'
              ? 'cor'
              : f === 'team'
                ? 'equipe'
                : 'unidade',
        );
        const name = thePackage(c.serviceId, c.name);
        return labels.length ? `Alterou ${name}: ${joinList(labels)}.` : `Salvou ${name} sem mudanças.`;
      }
      case 'delete_service': {
        const removed = num(c.links?.removed);
        const name = str(c.name) ? `o pacote ${str(c.name)}` : 'um pacote';
        return `Excluiu ${name}${details([blocksPart(blocks), removed ? plural(removed, 'ligação', 'ligações') : undefined])}.`;
      }
      case 'create_activity': {
        const start = str(c.start);
        const duration = num(c.durationDays);
        return `Criou ${theBlock(c.activityId)}${details([start && `início ${formatDate(start)}`, duration ? workdays(duration) : undefined])}.`;
      }
      case 'update_activity': {
        const moved = num(c.appliedDays);
        const durationChanged = typeof c.durationDays === 'number' && typeof c.previousDurationDays === 'number';
        const actual = (label: string, pair: unknown) => {
          if (!Array.isArray(pair)) return undefined;
          const to = str(pair[1]);
          return to ? `${label} ${formatDate(to)}` : `${label} apagado`;
        };
        const realStart = actual('início real', c.actualStart);
        const realFinish = actual('término real', c.actualFinish);
        const name = theBlock(c.activityId);
        const tail = details([pushedPart(num(c.pushed))]);
        if (moved && !durationChanged && !realStart && !realFinish && !c.notesChanged)
          return `Moveu ${name} ${workdays(moved)} ${towards(moved)}${tail}.`;
        if (!moved && durationChanged && !realStart && !realFinish && !c.notesChanged)
          return `Mudou a duração d${name} de ${num(c.previousDurationDays)} para ${workdays(num(c.durationDays))}${tail}.`;
        const parts = [
          moved ? `moveu ${workdays(moved)} ${towards(moved)}` : undefined,
          durationChanged ? `duração de ${num(c.previousDurationDays)} para ${workdays(num(c.durationDays))}` : undefined,
          realStart,
          realFinish,
          c.notesChanged ? 'observação editada' : undefined,
        ].filter((p): p is string => !!p);
        return parts.length ? `Alterou ${name}: ${parts.join(', ')}${tail}.` : `Salvou ${name} sem mudança de datas${tail}.`;
      }
      case 'delete_activity': {
        const removed = num(c.links?.removed);
        return `Excluiu ${theBlock(c.activityId)}${details([removed ? plural(removed, 'ligação', 'ligações') : undefined])}.`;
      }
      case 'add_dependency':
        return `Ligou ${blockLabel(c.predecessorId)} → ${blockLabel(c.successorId)}${details([
          num(c.lagDays) ? `espera ${signed(num(c.lagDays))}` : undefined,
          c.kind === 'crew' ? 'equipe segue' : undefined,
          pushedPart(blocks),
        ])}.`;
      case 'update_dependency':
        return `Mudou a espera da ligação ${blockLabel(c.predecessorId)} → ${blockLabel(c.successorId)}${
          typeof c.previousLagDays === 'number' ? ` de ${signed(c.previousLagDays)}` : ''
        } para ${signed(num(c.lagDays))} ${Math.abs(num(c.lagDays)) === 1 ? 'dia útil' : 'dias úteis'}${details([pushedPart(blocks)])}.`;
      case 'remove_dependency':
        return `Removeu a ligação ${blockLabel(c.predecessorId)} → ${blockLabel(c.successorId)}.`;
      case 'launch_flow': {
        const l = c.launch;
        const launched = num(summary.launched) || blocks;
        const skipped = num(summary.skipped);
        const services = num(c.created?.services);
        return `Lançou o fluxo ${str(l?.flowName) ?? 'excluído'}${l ? ` em ${plural(num(l.localCount), 'local', 'locais')}` : ''}${
          str(l?.start) ? `, a partir de ${formatDate(l!.start)}` : ''
        }${details([
          blocksPart(launched),
          skipped ? `${skipped} já ${skipped === 1 ? 'existia' : 'existiam'}` : undefined,
          services ? plural(services, 'pacote novo', 'pacotes novos') : undefined,
        ])}.`;
      }
      case 'import_planner': {
        const locals = num(c.created?.locals);
        const services = num(c.created?.services);
        const fresh = [
          locals ? plural(locals, 'local novo', 'locais novos') : '',
          services ? plural(services, 'pacote novo', 'pacotes novos') : '',
        ]
          .filter(Boolean)
          .join(' e ');
        return `Importou o plano do Planejador${details([blocksPart(blocks), fresh || undefined, num(c.links?.added) ? plural(num(c.links?.added), 'ligação', 'ligações') : undefined])}.`;
      }
      case 'create_baseline':
        return `Guardou ${baseline(c.name)}.`;
      case 'restore_baseline':
        return `Restaurou ${baseline(c.name)}${details([blocksPart(blocks)])}.`;
      case 'delete_baseline':
        return `Excluiu ${baseline(c.name)}.`;
      case 'save_costs': {
        const inserted = num(c.costs?.inserted);
        const updated = num(c.costs?.updated);
        const removed = num(c.costs?.removed);
        return `Salvou a apropriação de custos${details([
          inserted ? plural(inserted, 'item novo', 'itens novos') : undefined,
          updated ? plural(updated, 'item alterado', 'itens alterados') : undefined,
          removed ? plural(removed, 'item excluído', 'itens excluídos') : undefined,
        ])}.`;
      }
      case 'set_calendar': {
        const cal = c.calendar;
        const parts: string[] = [];
        if (cal) {
          const from = Array.isArray(cal.weekdaysFrom) ? cal.weekdaysFrom : [];
          const to = Array.isArray(cal.weekdaysTo) ? cal.weekdaysTo : [];
          if (from.join() !== to.join()) parts.push(`dias trabalhados: ${weekdaysLabel(from)} → ${weekdaysLabel(to)}`);
          const added = num(cal.addedTotal);
          const removed = num(cal.removedTotal);
          if (added) parts.push(`${plural(added, 'dia sem trabalho marcado', 'dias sem trabalho marcados')}${dates(cal.added, added)}`);
          if (removed)
            parts.push(`${plural(removed, 'dia sem trabalho desmarcado', 'dias sem trabalho desmarcados')}${dates(cal.removed, removed)}`);
        }
        const changed = num(summary.changedBlocks) || blocks;
        if (changed) parts.push(`${plural(changed, 'bloco mudou', 'blocos mudaram')} de data`);
        return `Mudou o calendário da obra${details(parts)}.`;
      }
      case 'set_activity_dates':
        return `Devolveu datas de ${plural(blocks, 'bloco', 'blocos')} (Desfazer).`;
      case 'move_service': {
        const applied = num(c.appliedDays) || num(summary.applied);
        const requested = num(c.deltaDays);
        const name = thePackage(c.serviceId);
        const asked = requested && requested !== applied ? `, dos ${Math.abs(requested)} pedidos` : '';
        const tail = details([blocksPart(num(summary.moved)), pushedPart(num(summary.pushed)), keptPart(num(summary.kept))]);
        return applied ? `Moveu ${name} ${workdays(applied)} ${towards(applied)}${asked}${tail}.` : `Moveu ${name}${tail}.`;
      }
      case 'edit_service': {
        const e = c.edit;
        const parts: string[] = [];
        if (e) {
          if (typeof e.durationDays === 'number') parts.push(workdays(e.durationDays));
          parts.push(e.rhythm === 'chain' ? `encadeado com espera ${signed(num(e.lagDays))}` : 'ritmo mantido');
          const rules = Array.isArray(e.rules) ? e.rules : [];
          if (rules.length)
            parts.push(
              `${rules.length === 1 ? 'predecessora' : 'predecessoras'} ${joinList(
                rules.map(
                  r =>
                    `${serviceName(r.serviceId) ?? 'de um pacote excluído'} ${offsetLabel(num(r.localOffset))}${num(r.lagDays) ? ` com espera ${signed(num(r.lagDays))}` : ''}`,
                ),
              )}${e.mode === 'add' ? (rules.length === 1 ? ', somada às atuais' : ', somadas às atuais') : ''}`,
            );
        }
        return `Editou ${thePackage(c.serviceId)}${parts.length ? `: ${parts.join(', ')}` : ''}${details([
          blocksPart(num(summary.changedBlocks)),
          pushedPart(num(summary.pushed)),
          keptPart(num(summary.kept)),
          linksLabel(c.links),
        ])}.`;
      }
      case 'revert_service_edit':
        return `Desfez a edição d${thePackage(c.serviceId)}${details([blocksPart(blocks), linksLabel(c.links)])}.`;
      default:
        return `Alterou a Linha de Balanço${details([blocksPart(blocks)])}.`;
    }
  })();
  return { text, blocks };
}

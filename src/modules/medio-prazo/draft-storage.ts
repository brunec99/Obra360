import type { PlanDependency, PlanTask } from '@/domain/entities';
import type { WorkCalendar } from '@/domain/plan-schedule';

/** Rascunho automático do cronograma (16/11/2026): o que a pessoa editou e ainda não passou por
 * o salvamento automático (17/11/2026: antes, "Revisar e salvar") fica guardado no localStorage deste navegador, por pessoa e por cronograma, e
 * volta quando ela reabre o cronograma aqui. Funções puras: a tela (`schedule-sheet.tsx`) só lê e
 * grava pelo que sai daqui.
 *
 * Vai o rascunho e a impressão digital (`baseHash`) do cronograma gravado quando a edição começou.
 * O original não vai: com a mesma impressão digital ele é o que o banco devolve de novo. A pilha de
 * desfazer também não vai. Com a impressão digital diferente, alguém salvou o cronograma depois que o
 * rascunho começou, e a tela não deixa salvar por cima sem a pessoa escolher. */

export type DraftContent = { tasks: PlanTask[]; links: PlanDependency[]; calendar: WorkCalendar };

export const DRAFT_PREFIX = 'obra360.medio-prazo.rascunho.v1.';
export const DRAFT_VERSION = 1;

export interface StoredDraft {
  v: typeof DRAFT_VERSION;
  actorId: string;
  planId: string;
  /** Instante ISO em que foi guardado. */
  savedAt: string;
  /** `hashText(planSnapshot(...))` do cronograma gravado quando a edição começou. */
  baseHash: string;
  draft: DraftContent;
}

export const draftKey = (actorId: string, planId: string) => `${DRAFT_PREFIX}${actorId}.${planId}`;

/** Impressão digital de 53 bits (cyrb53) em base 36: compara o cronograma gravado sem guardar o
 * retrato inteiro, que tem o tamanho do próprio rascunho. */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef,
    h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function serializeDraft(input: Omit<StoredDraft, 'v'>): string {
  return JSON.stringify({ v: DRAFT_VERSION, ...input });
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Lê o que estava guardado. Texto corrompido, outra versão do formato, outra pessoa, outro cronograma
 * ou tarefa de outro plano: `undefined`, e a tela apaga a chave. */
export function parseDraft(raw: string | null | undefined, actorId: string, planId: string): StoredDraft | undefined {
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isObject(value) || value.v !== DRAFT_VERSION || value.actorId !== actorId || value.planId !== planId) return undefined;
  if (typeof value.savedAt !== 'string' || Number.isNaN(Date.parse(value.savedAt))) return undefined;
  if (typeof value.baseHash !== 'string' || !value.baseHash) return undefined;
  const draft = value.draft;
  if (!isObject(draft) || !Array.isArray(draft.tasks) || !Array.isArray(draft.links) || !isObject(draft.calendar)) return undefined;
  const calendar = draft.calendar;
  if (!Array.isArray(calendar.weekdays) || !Array.isArray(calendar.holidays)) return undefined;
  const tasksOk = draft.tasks.every(
    t =>
      isObject(t) &&
      typeof t.id === 'string' &&
      t.planId === planId &&
      typeof t.name === 'string' &&
      typeof t.plannedStart === 'string' &&
      typeof t.plannedEnd === 'string' &&
      typeof t.progress === 'number' &&
      typeof t.level === 'number',
  );
  if (!tasksOk) return undefined;
  const linksOk = draft.links.every(l => isObject(l) && typeof l.predecessorId === 'string' && typeof l.successorId === 'string');
  if (!linksOk) return undefined;
  return value as unknown as StoredDraft;
}

export type DraftRecovery =
  | { kind: 'none' }
  /** Havia chave, mas sem nada a recuperar (inválida ou igual ao gravado): apagar. */
  | { kind: 'discard' }
  /** `stale`: o cronograma gravado mudou depois que o rascunho começou. */
  | { kind: 'restore'; stored: StoredDraft; stale: boolean };

/** Decide o que fazer ao abrir o cronograma: `current` é o rascunho que o banco dá agora e
 * `currentHash` a impressão digital do cronograma gravado agora. */
export function decideRecovery(
  raw: string | null | undefined,
  { actorId, planId, current, currentHash }: { actorId: string; planId: string; current: DraftContent; currentHash: string },
): DraftRecovery {
  if (raw === null || raw === undefined) return { kind: 'none' };
  const stored = parseDraft(raw, actorId, planId);
  if (!stored) return { kind: 'discard' };
  if (JSON.stringify(stored.draft) === JSON.stringify(current)) return { kind: 'discard' };
  return { kind: 'restore', stored, stale: stored.baseHash !== currentHash };
}

/** "16/11 às 14:32", no fuso do navegador (ou no indicado). */
export function formatSavedAt(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  const parts = new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? '';
  return `${get('day')}/${get('month')} às ${get('hour')}:${get('minute')}`;
}

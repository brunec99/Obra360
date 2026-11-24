'use client';
import { useSyncExternalStore } from 'react';
import type { DailyCommandResult, DailyContent, DailyCrew, DailyPhotoView } from '@/domain/daily-report';
import {
  errorMessage,
  fetchDiary,
  fetchDiaryWorks,
  isConflict,
  isRefusal,
  sendDiaryCommand,
  SessionExpiredError,
  uploadDiaryPhoto,
  type DiaryWork,
} from './api';
import {
  alreadyApplied,
  applyResult,
  dayFromPackage,
  dayFromResponse,
  discardOperation,
  editPhoto,
  isStaleDraftRefusal,
  markError,
  operationCommand,
  packageFromDay,
  putCommand,
  putPhoto,
  putSave,
  removePhoto,
  resolveConflict,
  retryOperation,
  sameAsServer,
  sendable,
  settle,
  type DiaryDay,
  type DiaryPackage,
  type DiarySideCommand,
  type PhotoFields,
  type QueuedOperation,
} from './diary-model';

/** Armazenamento do Diário de Obra no aparelho, no desenho do modo de campo da terminalidade
 * (`terminalidade/offline-store.ts`): o dono do rascunho é o aparelho. No canteiro não há sinal, e perder o
 * que foi preenchido ou uma foto tirada é o único erro que esta tela não pode cometer. Tudo vai para o
 * IndexedDB na hora, e a fila sobe quando houver rede.
 *
 * Diferença para a terminalidade: a fila e os dias abertos ficam também em memória, e a tela lê dali
 * (`useDiaryStore`). A pessoa digita enquanto um envio está no ar; com a memória como fonte da sessão, a
 * volta do envio nunca apaga uma letra digitada no meio do caminho. O IndexedDB é a durabilidade. */

const DB_NAME = 'obra360-diario';
const STORE = 'estado';
const KEY_WORKS = 'obras';
const KEY_QUEUE = 'fila';
const dayKey = (workId: string, date: string) => `dia:${workId}:${date}`;
const packageKey = (workId: string) => `apoio:${workId}`;
const photoKey = (photoId: string) => `foto:${photoId}`;
const thumbKey = (photoId: string) => `miniatura:${photoId}`;

export interface StoredWorks {
  works: DiaryWork[];
  savedAt: string;
}
export interface StoredPhoto {
  image: Blob;
  thumb: Blob;
}

const available = () => typeof window !== 'undefined' && 'indexedDB' in window;
let connection: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  connection ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return connection;
}
async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T | null> {
  if (!available()) return null;
  const db = await open();
  return new Promise<T | null>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = fn(tx.objectStore(STORE));
    request.onsuccess = () => resolve((request.result as T) ?? null);
    request.onerror = () => reject(request.error);
  });
}
/** Leitura que nunca derruba a tela: sem IndexedDB (aba anônima, por exemplo) é como não ter nada guardado. */
const read = <T>(key: string) => run<T>('readonly', store => store.get(key)).catch(() => null);
const write = async (key: string, value: unknown) => {
  await run('readwrite', store => store.put(value, key));
};
const remove = async (key: string) => {
  await run('readwrite', store => store.delete(key)).catch(() => undefined);
};

/* ---------- estado em memória ---------- */

export interface DiaryStoreState {
  /** A fila já foi lida do aparelho. */
  ready: boolean;
  queue: QueuedOperation[];
  /** Dias abertos nesta sessão, por `dia:obra:data`. */
  days: Record<string, DiaryDay>;
  syncing: boolean;
  sessionExpired: boolean;
  /** O aparelho não conseguiu gravar (armazenamento cheio ou bloqueado): o que está na tela só vale enquanto ela estiver aberta. */
  storageFailed: boolean;
}
let state: DiaryStoreState = { ready: false, queue: [], days: {}, syncing: false, sessionExpired: false, storageFailed: false };
const listeners = new Set<() => void>();
function set(patch: Partial<DiaryStoreState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const SERVER_STATE = state;
export const useDiaryStore = () =>
  useSyncExternalStore(
    subscribe,
    () => state,
    () => SERVER_STATE,
  );
export const diaryDayOf = (store: DiaryStoreState, workId: string, date: string): DiaryDay | undefined => store.days[dayKey(workId, date)];

/** Gravações em fila única, sempre com o valor mais novo: duas alterações seguidas nunca gravam fora de ordem. */
let writes: Promise<void> = Promise.resolve();
function persistQueue() {
  writes = writes
    .then(() => write(KEY_QUEUE, state.queue))
    .then(
      () => undefined,
      () => set({ storageFailed: true }),
    );
  return writes;
}
function mutateQueue(change: (queue: QueuedOperation[]) => QueuedOperation[]) {
  set({ queue: change(state.queue) });
  void persistQueue();
}
const newIds = () => ({ id: crypto.randomUUID(), now: new Date().toISOString() });

let loading: Promise<void> | null = null;
/** Lê a fila do aparelho, uma vez por sessão. */
export function initDiaryStore(): Promise<void> {
  loading ??= (async () => {
    const queue = (await read<QueuedOperation[]>(KEY_QUEUE)) ?? [];
    const early = state.queue;
    set({ ready: true, queue: [...queue, ...early] });
    if (early.length) void persistQueue();
  })();
  return loading;
}

/* ---------- dias e pacote de apoio ---------- */

async function storeDay(day: DiaryDay) {
  set({ days: { ...state.days, [dayKey(day.workId, day.date)]: day } });
  if (day.fromPackage) return;
  try {
    await write(dayKey(day.workId, day.date), day);
    await write(packageKey(day.workId), packageFromDay(day, await read<DiaryPackage>(packageKey(day.workId))));
  } catch {
    set({ storageFailed: true });
  }
}

/** O dia como está no aparelho: a última leitura dele, ou um dia em branco montado com as listas da obra
 * (pacote de apoio) quando a data nunca foi lida. Nulo se o aparelho ainda não conhece a obra. */
export async function readLocalDay(workId: string, date: string, today: string): Promise<DiaryDay | null> {
  const known = state.days[dayKey(workId, date)];
  if (known) return known;
  const stored = await read<DiaryDay>(dayKey(workId, date));
  const pkg = stored ? null : await read<DiaryPackage>(packageKey(workId));
  const day = stored ?? (pkg ? dayFromPackage(pkg, date, today) : null);
  // Uma leitura do servidor pode ter chegado enquanto esta consultava o aparelho: ela vence.
  if (day && !state.days[dayKey(workId, date)]) set({ days: { ...state.days, [dayKey(workId, date)]: day } });
  return state.days[dayKey(workId, date)] ?? null;
}

/** Quantas respostas de comando cada dia já recebeu nesta sessão (ver `refreshDay`). */
const patches = new Map<string, number>();
const freshIds = new Map<string, string>();
/** O id que o diário de um dia terá se ainda não existe: escolhido no aparelho, o mesmo enquanto a sessão durar. */
export function freshReportId(workId: string, date: string): string {
  // Na renderização do servidor não há rascunho: nada a guardar entre pedidos.
  if (typeof window === 'undefined') return '';
  const key = dayKey(workId, date);
  let id = freshIds.get(key);
  if (!id) freshIds.set(key, (id = crypto.randomUUID()));
  return id;
}

/** Até quantas miniaturas guardar por leitura, para as fotos aparecerem sem sinal (as URLs assinadas vencem em 1 h). */
const MAX_CACHED_THUMBS = 30;
async function cacheThumbs(photos: readonly DailyPhotoView[]) {
  for (const photo of photos.slice(0, MAX_CACHED_THUMBS)) {
    if (!photo.thumbUrl || (await read<Blob>(thumbKey(photo.id)))) continue;
    try {
      const res = await fetch(photo.thumbUrl);
      if (res.ok) await write(thumbKey(photo.id), await res.blob());
    } catch {
      // Sem a miniatura o diário abre igual; a foto só aparece com sinal.
    }
  }
}

/** Lê o dia no servidor (precisa de rede) e guarda no aparelho. Devolve falso quando o diário não existe
 * neste banco (falta a migração). Lança o erro de rede, de sessão ou do servidor. */
export async function refreshDay(workId: string, date: string): Promise<boolean> {
  const key = dayKey(workId, date);
  const seen = patches.get(key) ?? 0;
  try {
    const response = await fetchDiary(workId, date);
    if (!response.available) return false;
    // Um comando respondeu enquanto esta leitura estava no ar: ela pode ser mais velha que ele, e não entra.
    if ((patches.get(key) ?? 0) !== seen && state.days[key]) return true;
    const day = dayFromResponse(workId, response);
    await storeDay(day);
    set({ sessionExpired: false });
    void cacheThumbs(day.photos);
    return true;
  } catch (error) {
    if (error instanceof SessionExpiredError) set({ sessionExpired: true });
    throw error;
  }
}

/** Aplica a resposta de um comando (ou do envio ao Sienge) sobre o dia guardado, esteja ele aberto ou não. */
export async function patchDay(workId: string, date: string, result: DailyCommandResult & { photos?: DailyPhotoView[] }): Promise<void> {
  const day = state.days[dayKey(workId, date)] ?? (await read<DiaryDay>(dayKey(workId, date)));
  if (!day) return;
  patches.set(dayKey(workId, date), (patches.get(dayKey(workId, date)) ?? 0) + 1);
  await storeDay(applyResult(day, result));
}

/* ---------- alterações (vão para a fila) ---------- */

/** Grava o rascunho do dia no aparelho. `crews` nulo: a pessoa não mexeu na mão de obra. */
export function saveDraft(workId: string, date: string, reportId: string, content: DailyContent, crews: DailyCrew[] | null) {
  const baseVersion = state.days[dayKey(workId, date)]?.report?.version ?? null;
  mutateQueue(queue => putSave(queue, workId, { kind: 'save', reportId, date, baseVersion, content, crews }, newIds()));
}

/** Guarda uma foto no aparelho e a põe na fila. Os arquivos são gravados antes do registro, para nunca
 * existir registro sem arquivo. `draft` é o rascunho atual: se o diário ainda não existe no servidor nem na
 * fila, ele entra antes da foto (a foto depende do diário). Lança se o aparelho não consegue guardar. */
export async function addPhoto(
  workId: string,
  date: string,
  reportId: string,
  draft: { content: DailyContent; crews: DailyCrew[] | null },
  photoId: string,
  files: StoredPhoto,
  fields: PhotoFields,
): Promise<void> {
  try {
    await write(photoKey(photoId), files);
  } catch {
    throw new Error('O aparelho não conseguiu guardar a foto. Libere espaço e tente de novo.');
  }
  const exists = state.days[dayKey(workId, date)]?.report != null;
  const hasSave = state.queue.some(queued => queued.operation.kind === 'save' && queued.operation.reportId === reportId);
  if (!exists && !hasSave) saveDraft(workId, date, reportId, draft.content, draft.crews);
  mutateQueue(queue => putPhoto(queue, workId, { kind: 'photo', reportId, date, photoId, ...fields }, newIds()));
}

export function changePhoto(workId: string, date: string, photoId: string, fields: PhotoFields) {
  mutateQueue(queue => editPhoto(queue, workId, date, photoId, fields, newIds()));
}
export function deletePhoto(workId: string, date: string, photoId: string) {
  const local = state.queue.some(queued => queued.operation.kind === 'photo' && queued.operation.photoId === photoId);
  mutateQueue(queue => removePhoto(queue, workId, date, photoId, newIds()));
  if (local) void remove(photoKey(photoId));
}
export function queueCommand(workId: string, date: string, command: DiarySideCommand) {
  mutateQueue(queue => putCommand(queue, workId, date, command, newIds()));
}
export function retryQueued(id: string) {
  mutateQueue(queue => retryOperation(queue, id));
}
/** Descarta de propósito uma alteração recusada (e os arquivos das fotos que saem com ela). */
export function discardQueued(id: string) {
  const before = state.queue;
  mutateQueue(queue => discardOperation(queue, id));
  const kept = new Set(state.queue.map(queued => queued.id));
  for (const queued of before)
    if (!kept.has(queued.id) && queued.operation.kind === 'photo') void remove(photoKey(queued.operation.photoId));
}
/** Conflito: fica o que está no servidor. O rascunho local sai; as fotos que esperavam por ele seguem. */
export async function reloadAfterConflict(workId: string, date: string, reportId: string): Promise<void> {
  await refreshDay(workId, date);
  const server = state.days[dayKey(workId, date)]?.report?.id ?? null;
  mutateQueue(queue => resolveConflict(queue, reportId, server));
}

/* ---------- fotos guardadas ---------- */

/** A miniatura de uma foto, se o aparelho a tem (foto ainda na fila, ou já enviada e guardada). */
export async function readThumb(photoId: string): Promise<Blob | null> {
  return (await read<StoredPhoto>(photoKey(photoId)))?.thumb ?? (await read<Blob>(thumbKey(photoId)));
}
/** A imagem inteira de uma foto que ainda está no aparelho. */
export const readImage = async (photoId: string) => (await read<StoredPhoto>(photoKey(photoId)))?.image ?? null;

/* ---------- fila de saída ---------- */

export interface SyncResult {
  sent: number;
  /** Mensagem da falha passageira que interrompeu o envio (sem sinal, servidor fora), ou nulo. */
  error: string | null;
  /** Operações que o servidor recusou nesta rodada. */
  refused: number;
  sessionExpired: boolean;
}

async function sendPhoto(queued: QueuedOperation & { operation: { kind: 'photo' } }): Promise<DailyCommandResult> {
  const { reportId, photoId } = queued.operation;
  const files = await read<StoredPhoto>(photoKey(photoId));
  if (!files) throw new LostPhotoError();
  await uploadDiaryPhoto({ workId: queued.workId, reportId, photoId }, files);
  // A miniatura fica guardada: a foto continua aparecendo sem sinal depois de enviada.
  await write(thumbKey(photoId), files.thumb).catch(() => undefined);
  const result = await sendDiaryCommand(queued.workId, operationCommand(queued.workId, queued.operation));
  await remove(photoKey(photoId));
  return result;
}
class LostPhotoError extends Error {
  constructor() {
    super('Os arquivos desta foto não estão mais no aparelho. Descarte e tire a foto de novo.');
  }
}

/** Outra pessoa gravou o diário antes: o 409 da gravação ou a recusa da regra com a versão defasada. */
const isStaleDraft = (error: unknown) => isConflict(error) || (isRefusal(error) && isStaleDraftRefusal(error.message));

async function attempt(queued: QueuedOperation): Promise<DailyCommandResult | 'reread'> {
  const { operation } = queued;
  try {
    if (operation.kind === 'photo') return await sendPhoto(queued as Parameters<typeof sendPhoto>[0]);
    return await sendDiaryCommand(queued.workId, operationCommand(queued.workId, operation));
  } catch (error) {
    // "Já foi anexada": uma tentativa anterior subiu e a resposta se perdeu. Conta como enviada.
    if (operation.kind === 'photo' && isRefusal(error) && alreadyApplied(error.message)) {
      await remove(photoKey(operation.photoId));
      return 'reread';
    }
    // Versão defasada no rascunho: antes de mostrar conflito, confere se o que está no servidor já é o que ia ser gravado.
    if (operation.kind === 'save' && isStaleDraft(error)) {
      const fresh = await refreshDay(queued.workId, operation.date).catch(() => false);
      const day = state.days[dayKey(queued.workId, operation.date)];
      if (fresh && day && sameAsServer(operation, day.report, day.crews)) return { report: day.report, crews: day.crews };
    }
    throw error;
  }
}

async function pass(): Promise<SyncResult> {
  const result: SyncResult = { sent: 0, error: null, refused: 0, sessionExpired: false };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { ...result, error: 'Sem conexão.' };
  for (const planned of sendable(state.queue)) {
    // A fila pode ter mudado desde o início da rodada: vale o que está nela agora.
    const queued = sendable(state.queue).find(item => item.id === planned.id);
    if (!queued) continue;
    const { operation } = queued;
    try {
      const answer = await attempt(queued);
      if (answer === 'reread') await refreshDay(queued.workId, operation.date).catch(() => undefined);
      else await patchDay(queued.workId, operation.date, answer);
      mutateQueue(queue => settle(queue, queued, answer === 'reread' ? {} : answer, newIds()));
      result.sent++;
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        set({ sessionExpired: true });
        return { ...result, error: error.message, sessionExpired: true };
      }
      const message = errorMessage(error, 'Falha no envio.');
      // Recusa de regra fica marcada na operação e a fila segue; falha passageira para a rodada e tenta depois.
      if (isRefusal(error) || error instanceof LostPhotoError) {
        // Só o rascunho tem conflito de versão; na foto, 409 quer dizer que os arquivos não chegaram ao Storage.
        mutateQueue(queue => markError(queue, queued, message, operation.kind === 'save' && isStaleDraft(error)));
        result.refused++;
        continue;
      }
      return { ...result, error: message };
    }
  }
  return result;
}

let running: Promise<SyncResult> | null = null;
let again = false;
/** Sobe a fila na ordem em que foi lançada. O que sobe sai da fila na hora: se o sinal cair no meio, o que
 * já subiu não sobe de novo e o que faltou continua guardado. Uma chamada durante o envio só pede mais uma
 * rodada ao fim da atual. */
export function synchronize(): Promise<SyncResult> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    set({ syncing: true });
    try {
      await initDiaryStore();
      let result = await pass();
      while (again && !result.error) {
        again = false;
        const next = await pass();
        result = { ...next, sent: result.sent + next.sent, refused: result.refused + next.refused };
      }
      return result;
    } finally {
      again = false;
      running = null;
      set({ syncing: false });
    }
  })();
  return running;
}

/* ---------- obras do modo de campo ---------- */

export const readWorks = () => read<StoredWorks>(KEY_WORKS);
/** Obras em que a pessoa tem o diário (precisa de rede). Guardadas para a lista abrir sem sinal. */
export async function fetchWorks(): Promise<StoredWorks> {
  try {
    const stored = { works: await fetchDiaryWorks(), savedAt: new Date().toISOString() };
    await write(KEY_WORKS, stored).catch(() => undefined);
    return stored;
  } catch (error) {
    if (error instanceof SessionExpiredError) set({ sessionExpired: true });
    throw error;
  }
}
/** Guarda uma obra aberta pelo link da tela logada, para ela aparecer na lista mesmo sem a leitura de obras. */
export async function rememberWork(work: DiaryWork): Promise<StoredWorks> {
  const current = await readWorks();
  const works = [...(current?.works ?? []).filter(item => item.id !== work.id), work].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const stored = { works, savedAt: current?.savedAt ?? new Date().toISOString() };
  await write(KEY_WORKS, stored).catch(() => undefined);
  return stored;
}
/** A obra já tem leitura guardada (abre sem sinal)? */
export const hasPackage = async (workId: string) => (await read<DiaryPackage>(packageKey(workId))) !== null;

/** Registra o service worker que guarda a casca das telas de campo para abrir sem sinal (escopo `/campo/`). */
export function registerFieldServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/campo-sw.js', { scope: '/campo/', updateViaCache: 'none' }).catch(() => undefined);
}

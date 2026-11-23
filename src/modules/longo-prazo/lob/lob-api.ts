'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isLobScheduleCommand,
  mergeActivities,
  planLobCommand,
  sameScheduleResult,
  type LobScheduleCommand,
  type LobScheduleResponse,
} from '@/application/use-cases/lob-commands';
import {
  lobPhotoPaths,
  type LobActivity,
  type LobCommand,
  type LobCostAccess,
  type LobData,
  type LobResponse,
  type ServiceFlow,
  type ServiceFlowDocument,
} from '@/domain/lob';

/** Cliente das visões Linha de Balanço, Fluxos e Medições (aba 1). Os dados vivem fora do snapshot
 * do planejamento: GET /api/lob, POST /api/lob/commands, /api/lob/flows e, para as fotos,
 * POST /api/lob/upload-url seguido do envio direto ao Storage (como na Terminalidade). */

/** `costAccess` (11/11/2026, apropriação de custos): `full` = valores em reais; `masked` = perfil de
 * consulta, que recebe só a porcentagem de cada item; `unavailable` = migração 0044 não aplicada. */
export type LobState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'unavailable' }
  | { status: 'ready'; data: LobData; costAccess: LobCostAccess };

export class LobApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'LobApiError';
  }
}
export const isLobConflict = (cause: unknown) => cause instanceof LobApiError && cause.status === 409;

async function readJson(res: Response) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new LobApiError((body as { error?: string }).error ?? 'Falha na comunicação com o servidor.', res.status);
  return body;
}
const post = (url: string, body: unknown, method = 'POST') =>
  fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export async function fetchLob(workId: string): Promise<LobResponse> {
  return readJson(await fetch(`/api/lob?workId=${encodeURIComponent(workId)}`, { cache: 'no-store' }));
}
/** A obra inteira de volta, mais os números do comando: blocos lançados (`launch_flow`) ou blocos que
 * mudaram de data (`set_calendar`). */
export type LobFullResult = LobResponse & { launched?: number; skipped?: number; changedBlocks?: number; movedStarts?: number };
/** O que o servidor responde a um comando: a obra inteira ou, nos comandos de datas, só os blocos gravados. */
export type LobCommandResult = LobFullResult | LobScheduleResponse;
const isPartial = (result: LobCommandResult): result is LobScheduleResponse =>
  result.available && 'partial' in result && result.partial === true;
/** Executa um comando no servidor. Os comandos de datas (mover, esticar, devolver) voltam enxutos
 * (`partial: true`, só os blocos gravados); os demais devolvem a obra já atualizada, com URLs de foto novas. */
export async function sendLobCommand(command: LobCommand): Promise<LobCommandResult> {
  return readJson(await post('/api/lob/commands', command));
}

// ----- Fluxos -----
export async function fetchFlows(): Promise<{ available: boolean; flows: ServiceFlow[] }> {
  return readJson(await fetch('/api/lob/flows', { cache: 'no-store' }));
}
export async function createFlow(document: ServiceFlowDocument, flowId?: string): Promise<ServiceFlow> {
  return (await readJson(await post('/api/lob/flows', { flowId, document }))).flow;
}
export async function updateFlow(flowId: string, revision: number, document: ServiceFlowDocument): Promise<ServiceFlow> {
  return (await readJson(await post('/api/lob/flows', { flowId, revision, document }, 'PUT'))).flow;
}
export async function deleteFlow(flowId: string): Promise<void> {
  await readJson(await post('/api/lob/flows', { flowId }, 'DELETE'));
}

// ----- Fotos -----
type UploadTicket = { path: string; signedUrl: string };
type UploadKey = { workId: string; itemId: string; photoId: string };
async function putBlob(ticket: UploadTicket, blob: Blob) {
  try {
    const sent = await fetch(ticket.signedUrl, { method: 'PUT', body: blob, headers: { 'content-type': 'image/jpeg' } });
    return sent.ok;
  } catch {
    return false;
  }
}
export async function discardLobUpload(key: UploadKey): Promise<void> {
  await post('/api/lob/upload-url', key, 'DELETE').catch(() => undefined);
}
/** Envia uma foto já comprimida (imagem + miniatura, JPEG) e devolve o comando `add_photo` pronto.
 * O lançamento (`itemId`) precisa existir antes: salve o valor com `save_items`. Cada PUT tem uma
 * segunda tentativa; se falhar, o que subiu é descartado no servidor. */
export async function uploadLobPhoto(input: {
  workId: string;
  itemId: string;
  image: Blob;
  thumb: Blob;
  width?: number;
  height?: number;
}): Promise<Extract<LobCommand, { type: 'add_photo' }>> {
  const photoId = crypto.randomUUID();
  const key: UploadKey = { workId: input.workId, itemId: input.itemId, photoId };
  const tickets = (await readJson(await post('/api/lob/upload-url', key))) as { image: UploadTicket; thumb: UploadTicket };
  for (const [ticket, blob] of [
    [tickets.image, input.image],
    [tickets.thumb, input.thumb],
  ] as const) {
    if (await putBlob(ticket, blob)) continue;
    if (await putBlob(ticket, blob)) continue;
    await discardLobUpload(key);
    throw new Error('Não foi possível enviar a foto. Verifique a conexão e tente de novo.');
  }
  const { storagePath, thumbPath } = lobPhotoPaths(input.workId, input.itemId, photoId);
  return {
    type: 'add_photo',
    itemId: input.itemId,
    photoId,
    storagePath,
    thumbPath,
    width: input.width,
    height: input.height,
    bytes: input.image.size,
  };
}

const PHOTO_URL_STALE_MS = 45 * 60 * 1000;

// ----- Sessão: estado confirmado, alterações otimistas e fila de gravação -----

/** Situação da gravação, para o indicador discreto da tela: `saving` enquanto há comando na fila,
 * `saved` quando a fila esvazia sem erro, `error` quando o último comando falhou. */
export type LobSync = 'idle' | 'saving' | 'saved' | 'error';
export interface LobSnapshot {
  state: LobState;
  sync: LobSync;
}
export interface LobTransport {
  fetch(): Promise<LobResponse>;
  send(command: LobCommand): Promise<LobCommandResult>;
}
/** Datas que um comando de datas mudou na tela (os valores de ANTES), para o "Desfazer". */
export type LobDateChange = { id: string; start: string; durationDays: number };
interface PendingOp {
  command: LobScheduleCommand;
  /** Os blocos que a tela calculou que o servidor vai gravar. */
  predicted: LobActivity[];
  /** A alteração deixou de valer antes de chegar ao servidor (a base mudou e ela não se aplica mais). */
  dropped?: Error;
}

/** A Linha de Balanço de uma obra no navegador (23/11/2026). Guarda o estado CONFIRMADO pelo servidor
 * e, por cima dele, as alterações de datas que a tela já aplicou e ainda estão a caminho:
 *
 * - `dispatch` (mover, esticar, devolver datas) calcula o resultado na hora com a mesma função do
 *   servidor (`planLobCommand`), mostra e grava em segundo plano. O servidor responde só com os
 *   blocos que gravou; se bater com o previsto, a tela nem redesenha; se divergir, relê a obra; se
 *   recusar ou falhar, a tela volta ao confirmado (com o que ainda estiver na fila reaplicado).
 * - `execute` (todos os outros comandos) espera a obra inteira de volta, como sempre.
 * - Tudo passa por UMA fila, na ordem em que foi pedido: dois arrastos seguidos não disputam, e uma
 *   resposta antiga não passa por cima de uma mais nova.
 *
 * Sem React: a tela assina `emit` e os testes trocam o transporte. */
export class LobSession {
  private confirmed?: { data: LobData; costAccess: LobCostAccess };
  private view: LobState = { status: 'loading' };
  private sync: LobSync = 'idle';
  private pending: PendingOp[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private failed = false;
  private disposed = false;
  /** Quando a obra foi lida por inteiro pela última vez (as URLs das fotos valem uma hora). */
  fetchedAt?: number;

  constructor(
    private readonly transport: LobTransport,
    private readonly emit: (snapshot: LobSnapshot) => void,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  get snapshot(): LobSnapshot {
    return { state: this.view, sync: this.sync };
  }
  /** Para de avisar a tela (obra trocada ou componente desmontado); o que estiver na fila termina. */
  dispose() {
    this.disposed = true;
  }
  private publish() {
    if (!this.disposed) this.emit(this.snapshot);
  }
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    this.queued += 1;
    if (this.queued === 1) this.failed = false;
    this.setSync('saving');
    const run = this.chain.then(task);
    this.chain = run.then(
      () => this.settle(false),
      () => this.settle(true),
    );
    return run;
  }
  private settle(failed: boolean) {
    this.queued -= 1;
    if (failed) this.failed = true;
    if (!this.queued) this.setSync(this.failed ? 'error' : 'saved');
  }
  private setSync(sync: LobSync) {
    if (this.sync === sync) return;
    this.sync = sync;
    this.publish();
  }

  /** O contexto do cálculo na tela. Só as datas importam aqui: quem assina e as travas que dependem
   * do dia de hoje (data real no futuro) ficam com o servidor, que tem o relógio da obra. */
  private context() {
    return { actorId: '', now: this.clock(), today: '9999-12-31', newId: () => crypto.randomUUID() };
  }
  /** Refaz a tela: o confirmado com as alterações a caminho por cima, recalculadas sobre ele. A que
   * deixou de se aplicar sai da tela e, quando chegar a vez dela na fila, falha sem ir ao servidor. */
  private rebuild() {
    if (!this.confirmed) return;
    let data = this.confirmed.data;
    for (const op of this.pending) {
      if (op.dropped) continue;
      try {
        op.predicted = planLobCommand(data, op.command, this.context()).update.activities;
        data = { ...data, activities: mergeActivities(data.activities, op.predicted) };
      } catch (error) {
        op.dropped = error instanceof Error ? error : new Error('A alteração não pôde ser aplicada.');
      }
    }
    this.view = { status: 'ready', data, costAccess: this.confirmed.costAccess };
    this.publish();
  }
  /** Recebe a obra inteira do servidor: vira o confirmado, e a tela é refeita por cima dele. */
  private applyFull(response: LobResponse) {
    this.fetchedAt = Date.now();
    if (!response.available) {
      this.confirmed = undefined;
      this.view = { status: 'unavailable' };
      this.publish();
      return;
    }
    const { locals, services, activities, dependencies, baselines, launches, measurements, items, photos } = response;
    // Calendário de dias úteis da obra: ausente = segunda a sexta sem feriados (nunca configurado).
    const calendar = response.calendar;
    this.confirmed = {
      data: {
        locals,
        services,
        activities,
        dependencies,
        baselines,
        launches,
        measurements,
        items,
        photos,
        costs: response.costs ?? [],
        ...(calendar ? { calendar } : {}),
      },
      costAccess: response.costAccess ?? 'unavailable',
    };
    this.rebuild();
  }
  private async fetchFull() {
    this.applyFull(await this.transport.fetch());
  }

  /** Lê a obra (primeira leitura e "Tentar de novo"); a falha vira a tela de erro. */
  load(): Promise<void> {
    return this.enqueueQuiet(async () => {
      try {
        await this.fetchFull();
      } catch (error) {
        this.view = { status: 'error', message: error instanceof Error ? error.message : 'Falha ao carregar a Linha de Balanço.' };
        this.publish();
      }
    });
  }
  /** Releitura silenciosa (URLs de foto vencendo): se falhar, a tela segue com o que tem. */
  refresh(): Promise<void> {
    return this.enqueueQuiet(() => this.fetchFull().catch(() => undefined));
  }
  /** Leitura na fila, sem mexer no indicador de gravação. */
  private enqueueQuiet(task: () => Promise<void>): Promise<void> {
    const run = this.chain.then(task);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Executa um comando e devolve a obra atualizada; erro vira exceção para quem chamou mostrar. Em
   * conflito (409) os dados são relidos. Comando de datas passa por `dispatch` (na hora, na tela). */
  execute(command: LobCommand): Promise<LobFullResult> {
    if (isLobScheduleCommand(command) && this.view.status === 'ready') {
      let done: Promise<void>;
      try {
        done = this.dispatch(command).done;
      } catch (error) {
        return Promise.reject(error);
      }
      return done.then(() => this.fullResult());
    }
    return this.enqueue(async () => {
      try {
        const result = await this.transport.send(command);
        if (isPartial(result)) {
          // Só chega aqui se a obra ainda não estava carregada: aplica o que veio e segue.
          if (this.confirmed) {
            this.confirmed = {
              ...this.confirmed,
              data: { ...this.confirmed.data, activities: mergeActivities(this.confirmed.data.activities, result.activities) },
            };
            this.rebuild();
          }
          return this.fullResult();
        }
        this.applyFull(result);
        return result;
      } catch (error) {
        if (isLobConflict(error)) await this.fetchFull().catch(() => undefined);
        throw error;
      }
    });
  }
  private fullResult(): LobFullResult {
    return this.view.status === 'ready' ? { available: true, ...this.view.data, costAccess: this.view.costAccess } : { available: false };
  }

  /** Aplica um comando de datas NA HORA e grava em segundo plano. Lança, sem mudar nada, se as regras
   * recusarem (a mesma mensagem que o servidor daria). Devolve as datas de antes dos blocos que
   * mudaram (para o "Desfazer") e a promessa da gravação, que rejeita se o servidor recusar ou
   * falhar: aí a tela já voltou ao estado confirmado. */
  dispatch(command: LobScheduleCommand): { previous: LobDateChange[]; done: Promise<void> } {
    if (this.view.status !== 'ready' || !this.confirmed) throw new Error('A Linha de Balanço ainda está carregando.');
    const base = this.view.data;
    const predicted = planLobCommand(base, command, this.context()).update.activities;
    const before = new Map(base.activities.map(a => [a.id, a]));
    const previous: LobDateChange[] = [];
    for (const a of predicted) {
      const b = before.get(a.id);
      if (b && (b.start !== a.start || b.durationDays !== a.durationDays))
        previous.push({ id: b.id, start: b.start, durationDays: b.durationDays });
    }
    const op: PendingOp = { command, predicted };
    this.pending.push(op);
    this.view = { ...this.view, data: { ...base, activities: mergeActivities(base.activities, predicted) } };
    this.publish();
    const done = this.enqueue(async () => {
      const leave = () => {
        this.pending = this.pending.filter(p => p !== op);
      };
      if (op.dropped) {
        leave();
        throw op.dropped;
      }
      let result: LobCommandResult;
      try {
        result = await this.transport.send(command);
      } catch (error) {
        leave();
        // Recusa das regras (400): o servidor não gravou, basta voltar ao confirmado. Qualquer outra
        // falha (conflito, rede, erro do servidor) pode ter gravado ou não: relê para não adivinhar.
        const refused = error instanceof LobApiError && error.status === 400;
        if (refused) this.rebuild();
        else await this.fetchFull().catch(() => this.rebuild());
        throw error;
      }
      leave();
      if (!isPartial(result)) this.applyFull(result);
      else if (this.confirmed && sameScheduleResult(op.predicted, result.activities)) {
        // O servidor gravou o que a tela previu: só o confirmado anda. A tela já está certa e não
        // redesenha (os carimbos de hora do servidor entram quando ela for refeita).
        this.confirmed = {
          ...this.confirmed,
          data: { ...this.confirmed.data, activities: mergeActivities(this.confirmed.data.activities, result.activities) },
        };
      } else {
        // Divergiu (outra pessoa mexeu na obra, ou a tela estava desatualizada): vale o servidor.
        await this.fetchFull().catch(() => undefined);
      }
    });
    // Quem não acompanha a gravação (o arrasto) não pode gerar "rejeição não tratada".
    done.catch(() => undefined);
    return { previous, done };
  }
}

/** Estado da Linha de Balanço de uma obra: carrega, executa comandos e mantém a tela em dia com o
 * servidor (ver `LobSession`). As URLs das fotos valem uma hora: ao voltar ao foco com leitura velha,
 * relê em silêncio. */
export function useLob(workId: string) {
  const [snapshot, setSnapshot] = useState<LobSnapshot>({ state: { status: 'loading' }, sync: 'idle' });
  const sessionRef = useRef<LobSession | undefined>(undefined);
  // Uma sessão por obra, criada na montagem (e ao trocar de obra): a anterior para de avisar a tela.
  useEffect(() => {
    const session = new LobSession({ fetch: () => fetchLob(workId), send: sendLobCommand }, setSnapshot);
    sessionRef.current = session;
    session.load();
    return () => {
      session.dispose();
      if (sessionRef.current === session) sessionRef.current = undefined;
    };
  }, [workId]);
  const reload = useCallback(async () => {
    await sessionRef.current?.load();
  }, []);
  const refresh = useCallback(async () => {
    await sessionRef.current?.refresh();
  }, []);
  useEffect(() => {
    const onFocus = () => {
      const fetchedAt = sessionRef.current?.fetchedAt;
      if (document.visibilityState === 'visible' && fetchedAt !== undefined && Date.now() - fetchedAt >= PHOTO_URL_STALE_MS) refresh();
    };
    document.addEventListener('visibilitychange', onFocus);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onFocus);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);
  const notReady = () => new Error('A Linha de Balanço ainda está carregando.');
  /** Executa um comando; erro vira exceção para quem chamou mostrar. Em 409 os dados são relidos. */
  const execute = useCallback(
    (command: LobCommand): Promise<LobFullResult> => sessionRef.current?.execute(command) ?? Promise.reject(notReady()),
    [],
  );
  /** Comando de datas aplicado na hora e gravado em segundo plano (ver `LobSession.dispatch`). */
  const dispatch = useCallback((command: LobScheduleCommand) => {
    const session = sessionRef.current;
    if (!session) throw notReady();
    return session.dispatch(command);
  }, []);
  return { state: snapshot.state, sync: snapshot.sync, reload, refresh, execute, dispatch };
}

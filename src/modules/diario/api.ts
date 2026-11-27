'use client';
import { useSyncExternalStore } from 'react';
import type {
  DailyCommandResult,
  DailyPhotoView,
  DailyReport,
  DailyReportCommand,
  DailyReportResponse,
  DailySendPhotoResult,
  DailySendResult,
} from '@/domain/daily-report';
import type { SiengeUserCheck } from '@/domain/sienge-daily-report';

/** Cliente do Diário de Obra (2.4), 24/11/2026. A tela só fala com `/api/diario/*`: a credencial do Sienge
 * fica no servidor. Leitura do dia, comandos, URL assinada das fotos (como na terminalidade) e as três
 * chamadas do envio: o diário, uma por foto e a reabertura. Quem guarda o rascunho e a fila do aparelho é
 * `offline-store.ts`; aqui ficam só as chamadas e os erros. */

/** Erro da API com o status HTTP: 4xx é recusa de regra (409 = outra pessoa gravou antes), 5xx é falha passageira. */
export class DiaryApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** O corpo inteiro do erro: o envio ao Sienge devolve junto o diário (`report`), a foto (`photo`) ou os bloqueios. */
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DiaryApiError';
  }
  /** Recusa de regra: tentar de novo sem mudar nada dá no mesmo. */
  get refused() {
    return this.status >= 400 && this.status < 500;
  }
}
export class SessionExpiredError extends Error {
  constructor() {
    super('Sua sessão expirou. Entre de novo para enviar; o que foi preenchido continua guardado neste aparelho.');
    this.name = 'SessionExpiredError';
  }
}
/** Sem resposta (sem sinal ou servidor fora): vale tentar de novo depois. */
export class NetworkError extends Error {
  constructor() {
    super('Sem resposta do servidor. Confira o sinal e tente de novo.');
    this.name = 'NetworkError';
  }
}
export const isRefusal = (cause: unknown): cause is DiaryApiError => cause instanceof DiaryApiError && cause.refused;
export const isConflict = (cause: unknown) => cause instanceof DiaryApiError && cause.status === 409;
export const errorMessage = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store', ...init });
  } catch {
    throw new NetworkError();
  }
  // Sessão vencida: a API responde 401, ou o proxy desvia para o login (a resposta deixa de ser JSON da API).
  if (res.status === 401 || (res.redirected && new URL(res.url).pathname.startsWith('/login'))) throw new SessionExpiredError();
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new DiaryApiError(body.error ?? 'Falha na comunicação com o servidor.', res.status, body as Record<string, unknown>);
  return body as T;
}
const post = <T>(url: string, body: unknown, method: 'POST' | 'DELETE' = 'POST') =>
  request<T>(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** GET /api/diario?workId=&date= */
export const fetchDiary = (workId: string, date: string) =>
  request<DailyReportResponse>(`/api/diario?workId=${encodeURIComponent(workId)}&date=${encodeURIComponent(date)}`);

/** POST /api/diario/commands?workId= */
export const sendDiaryCommand = (workId: string, command: DailyReportCommand) =>
  post<DailyCommandResult>(`/api/diario/commands?workId=${encodeURIComponent(workId)}`, command);

/** POST /api/diario/usuario-sienge: confere o login do Sienge digitado, sem gravar. `live` = "Verificar de novo". */
export const checkSiengeUserCode = (code: string, live = false) => post<SiengeUserCheck>('/api/diario/usuario-sienge', { code, live });

type UploadTicket = { path: string; signedUrl: string };
export interface DiaryUploadKey {
  workId: string;
  reportId: string;
  photoId: string;
}
async function putBlob(ticket: UploadTicket, blob: Blob) {
  try {
    return (await fetch(ticket.signedUrl, { method: 'PUT', body: blob, headers: { 'content-type': 'image/jpeg' } })).ok;
  } catch {
    return false;
  }
}

/** Sobe a imagem e a miniatura (JPEG, já comprimidas) direto ao Storage pelas URLs assinadas de
 * `/api/diario/upload-url`. Cada PUT tem uma segunda tentativa com o mesmo ticket. O registro (`add_photo`)
 * fica com quem chama. Se o arquivo não sobe, o que subiu é descartado e o erro é passageiro. */
export async function uploadDiaryPhoto(key: DiaryUploadKey, files: { image: Blob; thumb: Blob }): Promise<void> {
  const tickets = await post<{ image: UploadTicket; thumb: UploadTicket }>('/api/diario/upload-url', key);
  for (const [ticket, blob] of [
    [tickets.image, files.image],
    [tickets.thumb, files.thumb],
  ] as const) {
    if ((await putBlob(ticket, blob)) || (await putBlob(ticket, blob))) continue;
    await post('/api/diario/upload-url', key, 'DELETE').catch(() => undefined);
    throw new NetworkError();
  }
}

/** POST /api/diario/enviar: cria o diário no Sienge (se ainda não criou) e devolve as fotos que faltam.
 * Erros: 400 `{ error, blocking }`; 409 `{ error, siengeId? }`; 422/502 `{ error, report }` quando o Sienge
 * recusa (o `report` do erro substitui o local: a rota sobe a versão antes de chamar o Sienge); 503 sem as
 * variáveis do Sienge. */
export const sendDiaryToSienge = (workId: string, reportId: string) => post<DailySendResult>('/api/diario/enviar', { workId, reportId });
/** POST /api/diario/enviar/foto: manda uma foto ao Sienge. Recusa do Sienge: 422/502 `{ error, photo }`, com a
 * foto já marcada com o erro; 409 quando a mesma foto já está em envio. */
export const sendDiaryPhotoToSienge = (workId: string, photoId: string) =>
  post<DailySendPhotoResult>('/api/diario/enviar/foto', { workId, photoId });
/** POST /api/diario/reabrir (admin): exclui o diário do Sienge e devolve o rascunho destravado. */
export const reopenDiary = (workId: string, reportId: string) =>
  post<{ report: DailyReport; photos: DailyPhotoView[] }>('/api/diario/reabrir', { workId, reportId });

export interface DiaryWork {
  id: string;
  name: string;
  code: string;
}
/** GET /api/diario sem `workId`: as obras em que a pessoa tem o diário, para a lista do modo de campo. */
export async function fetchDiaryWorks(): Promise<DiaryWork[]> {
  const body = await request<{ works?: DiaryWork[] }>('/api/diario');
  if (!Array.isArray(body.works)) throw new DiaryApiError('A lista de obras do diário não está disponível.', 404);
  return body.works;
}

/** Há sinal? Muda sozinho com os eventos do navegador. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    notify => {
      window.addEventListener('online', notify);
      window.addEventListener('offline', notify);
      return () => {
        window.removeEventListener('online', notify);
        window.removeEventListener('offline', notify);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}

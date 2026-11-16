'use client';
import { useEffect, useState } from 'react';
import type { AccessPayload, AccessPeriod } from '@/domain/access-usage';

/** Os dados da aba "Acessos" do Dashboard geral (15/11/2026, modelo aprovado "Aba Acessos no Dashboard geral"):
 * uma leitura de `GET /api/dashboard/acessos?de=&ate=` por período. Os filtros recortam na tela e não vão ao
 * servidor. Regra 9: "No sistema agora" atualiza sozinho a cada minuto enquanto a aba está na frente; a
 * atualização é silenciosa (a tela não volta ao esqueleto, a linha aberta e a ordenação ficam) e, se falhar, fica o
 * que já está na tela. Ao voltar para a aba depois de mais de um minuto escondida, atualiza na hora. Trocar de
 * período descarta a resposta de um pedido antigo que chegue depois. */

export const ACCESS_REFRESH_MS = 60_000;

/** O último período que chegou, com o período que o pediu: enquanto o novo carrega, a tela mostra este, apagado. */
export interface AccessShown {
  payload: AccessPayload;
  period: AccessPeriod;
}
export type AccessDataState =
  | { status: 'loading'; previous?: AccessShown }
  | { status: 'error'; message: string; previous?: AccessShown; retry: () => void }
  | { status: 'ready'; payload: AccessPayload; retry: () => void };

type Outcome = { ok: true; payload: AccessPayload } | { ok: false; message: string };

export const accessDataUrl = (period: Pick<AccessPeriod, 'from' | 'to'>) => `/api/dashboard/acessos?de=${period.from}&ate=${period.to}`;

async function load(url: string, signal: AbortSignal): Promise<Outcome> {
  try {
    const res = await fetch(url, { cache: 'no-store', signal });
    const body: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = (body as { error?: unknown } | null)?.error;
      return { ok: false, message: typeof error === 'string' ? error : 'Não foi possível carregar os acessos.' };
    }
    const payload = body as AccessPayload | null;
    return payload && Array.isArray(payload.people) && Array.isArray(payload.usage) && Array.isArray(payload.last)
      ? { ok: true, payload }
      : { ok: false, message: 'Resposta inesperada do servidor.' };
  } catch {
    return { ok: false, message: 'Falha na comunicação com o servidor.' };
  }
}

export function useAccessData(period: AccessPeriod): AccessDataState {
  const url = accessDataUrl(period);
  // A última resposta boa (de qualquer período), com a hora em que chegou, e a última falha da leitura principal.
  const [ready, setReady] = useState<AccessShown & { url: string; at: number }>();
  const [failure, setFailure] = useState<{ url: string; nonce: number; message: string }>();
  const [nonce, setNonce] = useState(0);

  // Leitura principal: a cada período e a cada "Tentar de novo". O `abort` da limpeza descarta o pedido antigo.
  useEffect(() => {
    const controller = new AbortController();
    const target = accessDataUrl(period);
    void load(target, controller.signal).then(outcome => {
      if (controller.signal.aborted) return;
      if (outcome.ok) setReady({ url: target, payload: outcome.payload, period, at: Date.now() });
      else setFailure({ url: target, nonce, message: outcome.message });
    });
    return () => controller.abort();
  }, [period, nonce]);

  // Atualização silenciosa, só do período que já está na tela. Cada resposta nova refaz o relógio de 60 s.
  const shownUrl = ready?.url;
  const loadedAt = ready?.at ?? 0;
  useEffect(() => {
    if (shownUrl !== url) return;
    let controller: AbortController | undefined;
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      controller?.abort();
      const current = new AbortController();
      controller = current;
      void load(url, current.signal).then(outcome => {
        if (!current.signal.aborted && outcome.ok) setReady({ url, payload: outcome.payload, period, at: Date.now() });
      });
    };
    const timer = window.setInterval(refresh, ACCESS_REFRESH_MS);
    const wake = () => {
      if (document.visibilityState === 'visible' && Date.now() - loadedAt >= ACCESS_REFRESH_MS) refresh();
    };
    document.addEventListener('visibilitychange', wake);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', wake);
      controller?.abort();
    };
  }, [url, shownUrl, loadedAt, period]);

  const retry = () => setNonce(value => value + 1);
  if (ready && ready.url === url) return { status: 'ready', payload: ready.payload, retry };
  const previous = ready ? { payload: ready.payload, period: ready.period } : undefined;
  if (failure && failure.url === url && failure.nonce === nonce) return { status: 'error', message: failure.message, previous, retry };
  return { status: 'loading', previous };
}

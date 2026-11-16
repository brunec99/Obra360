'use client';
import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { accessPayload, ActiveClock, FIELD_PREFIX, fieldWorkId, TICK_MS } from './active-clock';

const ENDPOINT = '/api/acessos';
/** Ponteiro, roda e rolagem disparam dezenas de vezes por segundo: um registro por segundo basta para o corte de 5 min. */
const CONTINUOUS_THROTTLE_MS = 1_000;

/**
 * Mede o tempo ativo no navegador e manda para `POST /api/acessos` (aba "Acessos" do Dashboard geral,
 * 15/11/2026). Não renderiza nada. A medição é do `ActiveClock`; aqui só os eventos do navegador e o envio.
 * Envia a cada 60 s, ao trocar de tela, ao esconder a aba e no `pagehide`. Falha de rede, resposta de erro
 * ou aparelho sem sinal: o tempo se perde em silêncio (regra aprovada), sem aviso nem log.
 */
export function AccessTracker() {
  const pathname = usePathname();
  const clockRef = useRef<ActiveClock | null>(null);
  // Última obra lida de `?obra=` na tela de campo atual. Ao trocar de tela (ou desmontar), a URL já é a
  // nova quando o envio da anterior sai; aí vale a obra lida enquanto a pessoa ainda estava nela.
  const fieldWorkRef = useRef<string | null>(null);

  // Este efeito vem antes do de eventos de propósito: na montagem, ele cria o relógio que o outro usa.
  useEffect(() => {
    const now = performance.now();
    const clock = clockRef.current;
    if (!clock) {
      clockRef.current = new ActiveClock(pathname, now, document.visibilityState === 'visible');
    } else if (clock.path !== pathname) {
      const previous = clock.switchScreen(pathname, now);
      send(previous.path, previous.seconds, workIdFor(previous.path, fieldWorkRef), false);
    }
    fieldWorkRef.current = fieldWorkId(pathname, window.location.search);
  }, [pathname]);

  useEffect(() => {
    let lastContinuous = -Infinity;

    // `performance.now()` em vez de `Date.now()`: não pula com ajuste do relógio do computador.
    const interact = () => clockRef.current?.interact(performance.now());
    const interactContinuous = () => {
      const now = performance.now();
      if (now - lastContinuous < CONTINUOUS_THROTTLE_MS) return;
      lastContinuous = now;
      clockRef.current?.interact(now);
    };
    const flush = (beacon: boolean) => {
      const clock = clockRef.current;
      if (!clock) return;
      const seconds = clock.take(performance.now());
      send(clock.path, seconds, workIdFor(clock.path, fieldWorkRef), beacon);
    };
    const onVisibility = () => {
      const clock = clockRef.current;
      if (!clock) return;
      const visible = document.visibilityState === 'visible';
      clock.setVisible(visible, performance.now());
      if (!visible) flush(true);
    };
    const onPageHide = () => {
      clockRef.current?.setVisible(false, performance.now());
      flush(true);
    };
    const onTick = () => {
      const clock = clockRef.current;
      if (!clock) return;
      const now = performance.now();
      // Confere a visibilidade a cada tick: cobre evento perdido, como a volta do cache de voltar/avançar
      // depois de um `pagehide`.
      const visible = document.visibilityState === 'visible';
      if (visible !== clock.isVisible) clock.setVisible(visible, now);
      else clock.tick(now);
      workIdFor(clock.path, fieldWorkRef);
      if (clock.flushDue(now)) flush(false);
    };

    const passive: AddEventListenerOptions = { passive: true };
    const capture: AddEventListenerOptions = { passive: true, capture: true };
    window.addEventListener('pointerdown', interact, passive);
    window.addEventListener('pointermove', interactContinuous, passive);
    window.addEventListener('keydown', interact, passive);
    window.addEventListener('wheel', interactContinuous, passive);
    // Rolagem não sobe da caixa rolável para a janela; na captura, a de qualquer quadro interno chega aqui.
    window.addEventListener('scroll', interactContinuous, capture);
    window.addEventListener('touchstart', interact, passive);
    document.addEventListener('visibilitychange', onVisibility, passive);
    window.addEventListener('pagehide', onPageHide, passive);
    const timer = window.setInterval(onTick, TICK_MS);

    return () => {
      window.removeEventListener('pointerdown', interact, passive);
      window.removeEventListener('pointermove', interactContinuous, passive);
      window.removeEventListener('keydown', interact, passive);
      window.removeEventListener('wheel', interactContinuous, passive);
      window.removeEventListener('scroll', interactContinuous, capture);
      window.removeEventListener('touchstart', interact, passive);
      document.removeEventListener('visibilitychange', onVisibility, passive);
      window.removeEventListener('pagehide', onPageHide, passive);
      window.clearInterval(timer);
      // Saindo da árvore (ex.: da tela de campo para as telas da obra), o acumulado vai junto.
      flush(false);
    };
  }, []);

  return null;
}

/**
 * Obra do envio no modo de campo: lida da URL na hora quando ela ainda é da tela do envio (e guardada);
 * senão, a última lida nessa tela. Fora do campo, nenhuma.
 */
function workIdFor(path: string, memory: { current: string | null }): string | null {
  if (!path.startsWith(FIELD_PREFIX)) return null;
  if (window.location.pathname === path) memory.current = fieldWorkId(path, window.location.search);
  return memory.current;
}

/**
 * Manda o tempo da tela. `beacon` (aba escondida, `pagehide`): `sendBeacon`, que sobrevive ao fechamento
 * da página; se ele não existir ou recusar a fila, `fetch` com `keepalive`. Nada de erro na tela nem no
 * console: o registro de acesso nunca atrapalha o trabalho.
 */
function send(path: string, seconds: number, workId: string | null, beacon: boolean): void {
  if (seconds < 1) return;
  // Sem sinal, o minuto se perde (regra aprovada): não há fila de acessos no aparelho.
  if (navigator.onLine === false) return;
  const body = JSON.stringify(accessPayload(path, seconds, workId));
  try {
    if (beacon && typeof navigator.sendBeacon === 'function') {
      if (navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }))) return;
    }
    fetch(ENDPOINT, {
      method: 'POST',
      body,
      keepalive: true,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
    }).catch(() => {});
  } catch {
    // Navegador que recusa o envio (ex.: limite do keepalive): descarta em silêncio.
  }
}

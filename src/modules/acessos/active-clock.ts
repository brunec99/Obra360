/**
 * Relógio do tempo ativo no Obra 360 (aba "Acessos" do Dashboard geral, 15/11/2026). Lógica pura, sem
 * DOM nem React: quem chama passa o instante (`now`, em ms) e o `AccessTracker` liga isso ao navegador.
 * Assim as regras aprovadas ficam testáveis com relógio falso.
 *
 * Tempo ativo = a aba visível e alguma interação nos últimos 5 min. Conta até 5 min depois da última
 * interação e para; escondida, não conta. O tempo é da tela (path) em que a pessoa estava.
 */

/** Sem interação por 5 min, a pessoa saiu da frente: o tempo para exatamente no limite. */
export const IDLE_MS = 5 * 60_000;
/** Envio periódico do acumulado da tela. */
export const FLUSH_MS = 60_000;
/** Teto de cada soma entre dois instantes: timer atrasado (aba dormindo, computador suspenso) não vira hora ativa. */
export const MAX_STEP_MS = 15_000;
/** Teto de um envio; o excesso é descartado (só aconteceria com relógio fora do normal). */
export const MAX_SEND_SECONDS = 120;
/** Intervalo do tick no navegador; o envio de 60 s é checado nele. */
export const TICK_MS = 5_000;
/** Telas do modo de campo: a obra não está no caminho, vem de `?obra=`. */
export const FIELD_PREFIX = '/campo/';

/** O que foi acumulado numa tela, pronto para enviar (0 = nada a enviar). */
export interface ScreenTime {
  path: string;
  seconds: number;
}

/** Corpo do `POST /api/acessos`. `workId` só no modo de campo, quando a URL traz `?obra=`. */
export interface AccessPayload {
  path: string;
  seconds: number;
  workId?: string;
}

export class ActiveClock {
  private currentPath: string;
  private visible: boolean;
  private lastInteraction: number;
  /** Até onde o tempo já foi contabilizado. */
  private lastTick: number;
  private lastTake: number;
  /** Acumulado da tela atual ainda não enviado, em ms (guarda o resto abaixo de 1 s). */
  private pendingMs = 0;

  /** Carregar a página conta como interação: começa a contar na hora, se a aba estiver visível. */
  constructor(path: string, now: number, visible = true) {
    this.currentPath = path;
    this.visible = visible;
    this.lastInteraction = now;
    this.lastTick = now;
    this.lastTake = now;
  }

  get path(): string {
    return this.currentPath;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** Acumulado ainda não enviado, em ms. */
  get accumulatedMs(): number {
    return this.pendingMs;
  }

  /**
   * Soma o tempo ativo desde o último instante contabilizado. Corta em `lastInteraction + IDLE_MS` (se o
   * corte cai no meio do intervalo, conta só até ele) e nunca soma mais que `MAX_STEP_MS` de uma vez.
   */
  tick(now: number): void {
    const from = this.lastTick;
    if (now <= from) {
      // Relógio que volta (ajuste de hora) recomeça dali sem descontar nem inventar tempo.
      this.lastTick = now;
      this.lastInteraction = Math.min(this.lastInteraction, now);
      return;
    }
    this.lastTick = now;
    if (!this.visible) return;
    const until = Math.min(now, this.lastInteraction + IDLE_MS);
    const active = Math.min(until - from, MAX_STEP_MS);
    if (active > 0) this.pendingMs += active;
  }

  /** Clique, tecla, rolagem, toque ou ponteiro. Contabiliza antes, para o tempo parado não entrar retroativamente. */
  interact(now: number): void {
    this.tick(now);
    this.lastInteraction = now;
  }

  /** Aba visível ou escondida. Voltar a ficar visível conta como interação. */
  setVisible(visible: boolean, now: number): void {
    this.tick(now);
    if (visible && !this.visible) this.lastInteraction = now;
    this.visible = visible;
  }

  /** Passou o intervalo de envio desde o último `take`. */
  flushDue(now: number): boolean {
    return now - this.lastTake >= FLUSH_MS;
  }

  /**
   * Segundos inteiros a enviar da tela atual (0 abaixo de 1 s). Guarda o resto em ms para o próximo envio
   * da mesma tela. Acima de `MAX_SEND_SECONDS`, manda o teto e descarta o excesso, resto incluído.
   */
  take(now: number): number {
    this.tick(now);
    this.lastTake = now;
    const seconds = Math.floor(this.pendingMs / 1000);
    if (seconds < 1) return 0;
    if (seconds > MAX_SEND_SECONDS) {
      this.pendingMs = 0;
      return MAX_SEND_SECONDS;
    }
    this.pendingMs -= seconds * 1000;
    return seconds;
  }

  /**
   * Troca de tela: devolve o acumulado da anterior (para enviar na hora) e começa a nova do zero. O resto
   * abaixo de 1 s era da tela anterior e fica para trás. Abrir a tela nova conta como interação, como
   * carregar a página (cobre também os botões voltar/avançar do navegador, que não disparam evento na tela).
   */
  switchScreen(path: string, now: number): ScreenTime {
    if (path === this.currentPath) return { path, seconds: 0 };
    const previous: ScreenTime = { path: this.currentPath, seconds: this.take(now) };
    this.currentPath = path;
    this.pendingMs = 0;
    this.lastInteraction = now;
    return previous;
  }
}

/** Obra do modo de campo: `?obra=` da URL, só nas telas `/campo/`. Vazio ou fora do campo = sem obra. */
export function fieldWorkId(path: string, search: string): string | null {
  if (!path.startsWith(FIELD_PREFIX)) return null;
  const workId = new URLSearchParams(search).get('obra');
  return workId ? workId : null;
}

/** Corpo do envio; `workId` só aparece quando existe. */
export function accessPayload(path: string, seconds: number, workId: string | null): AccessPayload {
  return workId ? { path, seconds, workId } : { path, seconds };
}

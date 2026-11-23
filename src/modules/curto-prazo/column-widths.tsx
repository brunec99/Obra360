'use client';
import { useCallback, useEffect, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react';

/** Largura das colunas da planilha, ajustável arrastando a borda do cabeçalho, como no Sheets. Fica
 * guardada no navegador de cada pessoa (localStorage): é preferência de quem lê, não dado da obra.
 * Sem larguras escolhidas (ou sem o armazenamento: janela anônima, bloqueio), a planilha acompanha a
 * largura da tela (23/11/2026: antes só se ajustava ao abrir, e levar a aba para a TV não a ampliava). */
export const MIN_COLUMN_WIDTH = 40;

/** Cabe na largura disponível: reduz (ou amplia) proporcionalmente as larguras-base, sem descer do
 * mínimo de cada coluna. Se nem os mínimos cabem, fica nos mínimos e a planilha rola de lado. */
export function fitWidths(base: Record<string, number>, minimums: Record<string, number>, available: number): Record<string, number> {
  const keys = Object.keys(base);
  const result = { ...base };
  let flexible = keys;
  let room = available;
  // Algumas passadas: quem bate no mínimo sai da conta e o resto divide o espaço que sobra.
  for (let pass = 0; pass < keys.length && flexible.length; pass++) {
    const total = flexible.reduce((sum, k) => sum + base[k], 0);
    const scale = room / total;
    const clamped = flexible.filter(k => base[k] * scale < (minimums[k] ?? MIN_COLUMN_WIDTH));
    if (!clamped.length) {
      flexible.forEach(k => (result[k] = Math.floor(base[k] * scale)));
      return result;
    }
    clamped.forEach(k => {
      result[k] = minimums[k] ?? MIN_COLUMN_WIDTH;
      room -= result[k];
    });
    flexible = flexible.filter(k => !clamped.includes(k));
    if (room <= 0) break;
  }
  flexible.forEach(k => (result[k] = minimums[k] ?? MIN_COLUMN_WIDTH));
  return result;
}

/** Larguras escolhidas à mão, como ficam guardadas no navegador: as colunas e a largura do painel em que
 * foram definidas (`panel`). Sem `panel` é o formato antigo, de antes de a planilha acompanhar a tela. */
export type StoredWidths = { widths: Record<string, number>; panel?: number };
/** A largura do painel vai junto das colunas, numa chave que não é coluna: a versão anterior da tela lê
 * o mesmo registro e só ignora a chave. */
const PANEL_KEY = '_painel';

/** Lê o que está guardado. Só valem colunas conhecidas com largura plausível; sem nenhuma, não há
 * escolha guardada (`null`) e a planilha segue no ajuste automático. */
export function parseStoredWidths(raw: string | null | undefined, known: Record<string, number>): StoredWidths | null {
  let stored: unknown;
  try {
    stored = JSON.parse(raw ?? '{}');
  } catch {
    return null;
  }
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return null;
  const record = stored as Record<string, unknown>;
  const widths = Object.fromEntries(
    Object.entries(record).filter(([key, value]) => key in known && typeof value === 'number' && value >= MIN_COLUMN_WIDTH),
  ) as Record<string, number>;
  if (!Object.keys(widths).length) return null;
  const panel = record[PANEL_KEY];
  return typeof panel === 'number' && Number.isFinite(panel) && panel > 0 ? { widths, panel } : { widths };
}

export function serializeStoredWidths(stored: StoredWidths): string {
  return JSON.stringify(stored.panel ? { ...stored.widths, [PANEL_KEY]: stored.panel } : stored.widths);
}

/** Larguras escolhidas num painel de `from` px, mostradas num de `to` px: todas crescem ou encolhem na
 * mesma proporção, sem descer do mínimo de cada coluna. Levar a aba para a TV amplia a planilha; voltar
 * ao notebook devolve as larguras escolhidas. Sem as duas medidas, ficam como estão. */
export function rescaleWidths(widths: Record<string, number>, minimums: Record<string, number>, from: number, to: number) {
  const scale = from > 0 && to > 0 ? to / from : 1;
  return Object.fromEntries(
    Object.entries(widths).map(([key, width]) => [key, Math.max(minimums[key] ?? MIN_COLUMN_WIDTH, Math.round(width * scale))]),
  );
}

/** As larguras que a planilha mostra num painel de `panel` px.
 *  - Sem escolha guardada: as colunas visíveis dividem a largura do painel (`fitWidths`); as escondidas
 *    não entram na conta, então a planilha é reajustada quando uma coluna aparece ou some.
 *  - Com larguras escolhidas à mão: as escolhidas, na proporção entre o painel de agora e o painel em que
 *    foram definidas. No formato antigo (sem a largura de referência) valem como estão.
 *  - Antes da primeira medição (`panel` 0): as escolhidas ou as padrão, sem ajuste. */
export function layoutWidths(
  defaults: Record<string, number>,
  minimums: Record<string, number>,
  visible: readonly string[],
  stored: StoredWidths | null,
  panel: number,
): Record<string, number> {
  if (stored) {
    const chosen = { ...defaults, ...stored.widths };
    return stored.panel && panel > 0 ? rescaleWidths(chosen, minimums, stored.panel, panel) : chosen;
  }
  if (panel <= 0) return defaults;
  const shown = Object.fromEntries(visible.filter(key => key in defaults).map(key => [key, defaults[key]]));
  return { ...defaults, ...fitWidths(shown, minimums, panel) };
}

/** Larguras das colunas da planilha. Enquanto a pessoa não arrasta nenhuma borda, as colunas visíveis
 * acompanham a largura do painel (janela redimensionada, aba levada para outro monitor, coluna que
 * aparece ou some). Depois de arrastar, as larguras são dela: ficam guardadas com a largura do painel em
 * que foram definidas e mudam só na proporção do painel. "Ajustar à tela" (`fit`) volta ao automático. */
export function useColumnWidths(
  storageKey: string,
  defaults: Record<string, number>,
  minimums: Record<string, number>,
  visible: readonly string[],
) {
  const [stored, setStored] = useState<StoredWidths | null>(null);
  /** Largura útil do painel da planilha; 0 até a primeira medição (e no servidor). */
  const [panel, setPanel] = useState(0);
  useEffect(() => {
    let found: StoredWidths | null = null;
    try {
      found = parseStoredWidths(localStorage.getItem(storageKey), defaults);
    } catch {}
    // Carrega depois da montagem: no servidor não há localStorage, e ler na renderização desalinharia a hidratação.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (found) setStored(found);
    // As larguras padrão são constantes de quem chama; só a chave decide quando reler.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);
  const persist = useCallback(
    (next: StoredWidths | null) => {
      try {
        if (next) localStorage.setItem(storageKey, serializeStoredWidths(next));
        else localStorage.removeItem(storageKey);
      } catch {}
    },
    [storageKey],
  );
  // Larguras guardadas no formato antigo: o painel da primeira medição passa a ser a referência delas, e
  // dali em diante acompanham a tela como as demais.
  useEffect(() => {
    if (!stored || stored.panel || panel <= 0) return;
    const next = { ...stored, panel };
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStored(next);
    persist(next);
  }, [stored, panel, persist]);
  /** `ref` do painel que rola a planilha: mede na montagem e a cada mudança de largura. */
  const observe = useCallback((element: HTMLElement | null) => {
    if (!element) return;
    setPanel(element.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    // Um ajuste por quadro: arrastar a borda da janela dispara dezenas de medições seguidas.
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setPanel(element.clientWidth));
    });
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);
  const widths = layoutWidths(defaults, minimums, visible, stored, panel);
  /** A partir daqui as larguras são da pessoa: as que estão na tela, com a coluna mexida, neste painel. */
  const choose = (column: string, width: number) => {
    const next: StoredWidths = { widths: { ...widths, [column]: Math.max(minimums[column] ?? MIN_COLUMN_WIDTH, Math.round(width)) } };
    if (panel > 0) next.panel = panel;
    setStored(next);
    persist(next);
  };
  const resize = (column: string, width: number) => choose(column, width);
  const reset = (column: string) => choose(column, defaults[column]);
  /** Volta ao ajuste automático: esquece as larguras escolhidas, e as colunas voltam a acompanhar a tela. */
  const fit = useCallback(() => {
    setStored(null);
    persist(null);
  }, [persist]);
  return { widths, resize, fit, reset, observe, manual: !!stored };
}

/** Telas largas (lg, 1024 px) desenham a tabela; as estreitas, os cartões. Desenhar as duas e esconder
 * uma com CSS dobrava a página (46 mil elementos numa semana de 120 linhas, 09/10/2026). */
export function useWideScreen(): boolean {
  return useSyncExternalStore(
    notify => {
      const query = window.matchMedia('(min-width: 1024px)');
      query.addEventListener('change', notify);
      return () => query.removeEventListener('change', notify);
    },
    () => window.matchMedia('(min-width: 1024px)').matches,
    () => true,
  );
}

/** Alça na borda direita do cabeçalho. Arrastar muda a largura; duplo clique volta ao padrão. O
 * teclado também ajusta (setas, com foco na alça), para não depender do mouse. */
export function ColumnResizeHandle({
  label,
  width,
  onResize,
  onReset,
}: {
  label: string;
  width: number;
  onResize: (width: number) => void;
  onReset: () => void;
}) {
  const start = (event: ReactPointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const originX = event.clientX;
    const originWidth = width;
    const move = (e: PointerEvent) => onResize(originWidth + e.clientX - originX);
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'col-resize';
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={`Largura da coluna ${label}`}
      aria-valuenow={width}
      aria-valuemin={MIN_COLUMN_WIDTH}
      tabIndex={0}
      title="Arraste para mudar a largura · duplo clique volta ao padrão"
      onPointerDown={start}
      onDoubleClick={event => {
        event.stopPropagation();
        onReset();
      }}
      onClick={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          onResize(width + (event.key === 'ArrowRight' ? 16 : -16));
        }
      }}
      className="absolute top-0 right-0 z-10 h-full w-2 cursor-col-resize touch-none select-none border-r-2 border-transparent hover:border-primary focus-visible:border-primary focus-visible:outline-none"
    />
  );
}

import type { DayEdge, WorkCalendar } from '@/domain/plan-schedule';

/** Folha do botão "Imprimir" do cronograma (16/11/2026). O modelo publicado (A4, tabela e Gantt,
 * 11 regras) foi aprovado pelo usuário com uma troca: "plote em A3 ao invés de A4". Funções puras:
 * a folha (`print-schedule.tsx`) só desenha o que sai daqui.
 *
 * A3 deitada tem 420 × 297 mm; com 7 mm de margem sobram 406 × 283 mm. A folha usa 1 mm a menos na
 * altura para o arredondamento não empurrar uma página em branco. A 96 px por polegada, que é como o
 * navegador imprime, isso dá 1534 × 1065 px. As alturas de cada faixa são fixas (com `overflow:
 * hidden` na folha), então o número de linhas por folha é uma conta, não uma medição. */

export const PRINT_PAPER = 'A3 landscape';
export const PRINT_MARGIN_MM = 7;
const PX_PER_MM = 96 / 25.4;
export const SHEET_W = Math.floor(406 * PX_PER_MM);
export const SHEET_H = Math.floor(282 * PX_PER_MM);
export const BAND_H = 56;
export const META_H = 16;
export const DRAFT_H = 22;
export const FOOT_H = 18;
export const GAP = 6;
/** Cabeçalho da tabela = as duas faixas da régua do Gantt. */
export const HEAD_H = 38;
export const ROW_H = 22;
/** Tabela com 45% da largura (regra 4); o Gantt fica com o resto, menos as bordas. */
export const TABLE_W = 690;
export const CHART_W = SHEET_W - 2 - TABLE_W - 1;
/** Colunas fixas da regra 3, na ordem do modelo. As larguras somam `TABLE_W`. */
export const PRINT_COLUMNS = [
  { key: 'id', label: 'Id', width: 34, right: true },
  { key: 'name', label: 'Nome da tarefa', width: 254 },
  { key: 'duration', label: 'Duração', width: 68 },
  { key: 'start', label: 'Início', width: 90 },
  { key: 'end', label: 'Término', width: 90 },
  { key: 'progress', label: '% concl.', width: 48, right: true },
  { key: 'resource', label: 'Recursos', width: 106 },
] as const;
export type PrintColumn = (typeof PRINT_COLUMNS)[number]['key'];

/** Linhas que cabem numa folha. A faixa do rascunho (regra 7) come uma linha e pouco. */
export function rowsPerSheet(withDraft: boolean): number {
  const fixed = BAND_H + META_H + FOOT_H + 3 * GAP + (withDraft ? DRAFT_H + GAP : 0);
  return Math.max(1, Math.floor((SHEET_H - fixed - 2 - HEAD_H) / ROW_H));
}

/** Folhas com `perSheet` linhas cada; sem linha nenhuma, uma folha vazia (o cabeçalho sai assim mesmo). */
export function paginate<T>(rows: T[], perSheet: number): T[][] {
  const size = Math.max(1, Math.floor(perSheet));
  const sheets: T[][] = [];
  for (let i = 0; i < rows.length; i += size) sheets.push(rows.slice(i, i + size));
  return sheets.length ? sheets : [[]];
}

const dayNumber = (date: string) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 86400000;
const fromDayNumber = (n: number) => new Date(n * 86400000).toISOString().slice(0, 10);
const MONTH_NAMES = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];

/** "novembro/2026". */
export const monthName = (month: string) => `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]}/${month.slice(0, 4)}`;

export interface ScaleCell {
  label: string;
  x: number;
  width: number;
}
export interface PrintScale {
  /** Pixels por dia. */
  px: number;
  start: string;
  end: string;
  /** Faixa de cima e de baixo da régua. Com semanas legíveis: meses e semanas (regra 5); numa janela
   * longa (o Gantt de legalização, 12 meses): anos e meses (regra 11). */
  top: ScaleCell[];
  bottom: ScaleCell[];
}

/** Rótulo que cabe na célula: o primeiro de `options` que cabe em `width` (≈ 5,6 px por letra a 9,5 px). */
function fit(width: number, ...options: string[]) {
  return options.find(o => o.length * 5.6 + 6 <= width) ?? '';
}

export function printScale(window: { start: string; end: string }, width: number): PrintScale {
  const s0 = dayNumber(window.start);
  const s1 = Math.max(s0, dayNumber(window.end));
  const px = width / (s1 - s0 + 1);
  const cell = (from: number, to: number, label: (w: number) => string): ScaleCell => {
    const x = Math.max(0, (from - s0) * px);
    const right = Math.min(width, (to - s0 + 1) * px);
    return { x, width: right - x, label: label(right - x) };
  };
  const spans: { from: number; to: number; name: string; y: number }[] = [];
  for (let n = s0; n <= s1;) {
    const date = fromDayNumber(n);
    const y = Number(date.slice(0, 4)),
      m = Number(date.slice(5, 7));
    const last = Math.min(s1, Date.UTC(y, m, 0) / 86400000);
    spans.push({ from: n, to: last, name: MONTH_NAMES[m - 1], y });
    n = last + 1;
  }
  const months = spans.map(s =>
    cell(s.from, s.to, w => fit(w, `${s.name}/${s.y}`, `${s.name.slice(0, 3)}/${String(s.y).slice(2)}`, s.name.slice(0, 3), s.name[0])),
  );
  if (px * 7 >= 26) {
    const weeks: ScaleCell[] = [];
    for (let n = s0; n <= s1; n++) {
      if (new Date(n * 86400000).getUTCDay() !== 1) continue;
      const date = fromDayNumber(n);
      weeks.push(cell(n, Math.min(s1, n + 6), w => fit(w, `${date.slice(8, 10)}/${date.slice(5, 7)}`)));
    }
    return { px, start: window.start, end: fromDayNumber(s1), top: months, bottom: weeks };
  }
  const years: ScaleCell[] = [];
  for (let n = s0; n <= s1;) {
    const y = Number(fromDayNumber(n).slice(0, 4));
    const last = Math.min(s1, Date.UTC(y + 1, 0, 0) / 86400000);
    years.push(cell(n, last, w => fit(w, String(y))));
    n = last + 1;
  }
  return {
    px,
    start: window.start,
    end: fromDayNumber(s1),
    top: years,
    bottom: spans.map(s => cell(s.from, s.to, w => fit(w, s.name.slice(0, 3), s.name[0]))),
  };
}

/** Faixas de dias sem trabalho (fim de semana pelo calendário e feriados), juntando os seguidos.
 * Numa escala apertada (menos de 4 px por dia) não há faixa: viraria listras. */
export function offDayRuns(scale: PrintScale, calendar: Pick<WorkCalendar, 'weekdays' | 'holidays'>): { x: number; width: number }[] {
  if (scale.px < 4) return [];
  const holidays = new Set(calendar.holidays);
  const runs: { x: number; width: number }[] = [];
  const s0 = dayNumber(scale.start);
  for (let n = s0; n <= dayNumber(scale.end); n++) {
    const date = fromDayNumber(n);
    const off = !calendar.weekdays.includes(new Date(n * 86400000).getUTCDay()) || holidays.has(date);
    if (!off) continue;
    const x = (n - s0) * scale.px;
    const last = runs.at(-1);
    if (last && Math.abs(last.x + last.width - x) < 0.01) last.width += scale.px;
    else runs.push({ x, width: scale.px });
  }
  return runs;
}

/** Posição de uma data na régua: começo do dia. */
export const printX = (scale: PrintScale, date: string) => (dayNumber(date) - dayNumber(scale.start)) * scale.px;

/** Barra entre as bordas do dia, como o Gantt da tela (`dayEdgeX`): início às 08:00 na borda
 * esquerda (ou 17:00 na direita) e término às 17:00 na direita (ou 08:00 na esquerda). Fora da janela,
 * `null`; a parte que passa da janela é cortada na borda. */
export function printBar(
  scale: PrintScale,
  width: number,
  bar: { start: string; end: string; startEdge?: DayEdge; endEdge?: DayEdge },
): { left: number; right: number } | null {
  const end = bar.end < bar.start ? bar.start : bar.end;
  const left = printX(scale, bar.start) + (bar.startEdge === 'end' ? scale.px : 0);
  const right = Math.max(printX(scale, end) + (bar.endEdge === 'start' ? 0 : scale.px), left + 2);
  if (right < 0 || left > width) return null;
  return { left: Math.max(0, left), right: Math.min(width, right) };
}

/** Lado do nome do recurso: à direita da barra; sem espaço, à esquerda; sem espaço nenhum, à direita
 * mesmo (a folha corta na borda). Largura estimada a 9,5 px em negrito. */
export function labelSide(left: number, right: number, label: string, width: number): 'right' | 'left' {
  const size = label.length * 5.6 + 4;
  if (right + size <= width) return 'right';
  return left - size >= 0 ? 'left' : 'right';
}

/** Cor cheia misturada com branco (`share` % da cor), em hexadecimal: o SVG impresso não depende de
 * `color-mix`. Mesma conta do Gantt da tela (`mixWhite` em `gantt-chart.tsx`). */
export function mixWhite(hex: string, share: number): string {
  const n = parseInt(hex.slice(1), 16);
  const channel = (v: number) =>
    Math.round((v * share) / 100 + 255 * (1 - share / 100))
      .toString(16)
      .padStart(2, '0');
  return `#${channel((n >> 16) & 255)}${channel((n >> 8) & 255)}${channel(n & 255)}`;
}

/** Nome sugerido ao salvar em PDF (regra 10): "Médio prazo ATM - Novembro 2026". Com mais de um
 * cronograma no mês, o nome do cronograma vai junto; o Gantt de legalização leva o título dele. */
export function printFileName({
  code,
  month,
  planName,
  sameMonthPlans,
  variantTitle,
}: {
  code?: string;
  month: string;
  planName: string;
  sameMonthPlans: number;
  variantTitle?: string;
}): string {
  const parts = variantTitle
    ? [variantTitle, code]
    : [
        'Médio prazo',
        code,
        '-',
        `${MONTH_NAMES[Number(month.slice(5, 7)) - 1].replace(/^./, c => c.toUpperCase())} ${month.slice(0, 4)}`,
        ...(sameMonthPlans > 1 ? ['-', planName] : []),
      ];
  return parts
    .filter(Boolean)
    .join(' ')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

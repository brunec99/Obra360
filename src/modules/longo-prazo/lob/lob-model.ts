import { addDays, daysBetween, fromMs, toMs } from '@/domain/long-term-plan';
import {
  activityEnd,
  activityFinish,
  baselineDeviation,
  baselineEntries,
  baselineEntryEnd,
  baselineEntryFinish,
  isWorkday,
  weekday,
  type CalendarChangePreview,
  type LobActivity,
  type LobBaseline,
  type LobBaselineDeviation,
  type LobBaselineEntry,
  type LobCalendar,
  type LobData,
  type LobLocal,
  type LobService,
  type LocalDate,
} from '@/domain/lob';
import { CHART } from '@/shared/palette';
import { formatDate } from '@/shared/format';

/** Geometria da Linha de Balanço (aba 1, modelo aprovado em 04/11/2026): funções puras, sem React,
 * que transformam `LobData` + zoom + filtros em pixels. O gráfico (`lob-chart.tsx`) só desenha o que
 * sai daqui, e o arrasto usa `dateAtX` para voltar de pixel a data. Tudo em dias corridos no eixo
 * (um dia = `pxPerDay`), mas as datas devolvidas caem sempre em dia útil do calendário da obra
 * (`data.calendar`; sem ele, segunda a sexta). */

/** Níveis de zoom (16/11/2026). 'semana', 'mes' e 'trimestre' têm escala fixa; 'obra' encaixa a obra
 * inteira na largura disponível. */
export type LobZoom = 'semana' | 'mes' | 'trimestre' | 'obra';

/** Medidas fixas do desenho. Rótulos dos locais à esquerda, uma linha de 30 px por local; a linha
 * cresce quando serviços do mesmo local se sobrepõem no tempo (faixas, 11/11/2026). No topo, o
 * cabeçalho do tempo em duas faixas de `band` px (`top` = 2 × `band`). */
export const GEOMETRY = {
  left: 110,
  top: 40,
  /** Altura de cada uma das duas faixas do cabeçalho do tempo. */
  band: 20,
  right: 24,
  bottom: 26,
  row: 30,
  /** Folga vertical do bloco dentro da linha (4 px acima e abaixo). */
  blockPad: 4,
  /** Folga horizontal entre um bloco e o início do seguinte. */
  blockGap: 1.5,
  /** Altura mínima de cada faixa quando blocos do mesmo local se sobrepõem, e o vão entre faixas. */
  lane: 12,
  laneGap: 1.5,
  /** Dias de respiro antes do começo e depois do fim do plano. */
  padBefore: 10,
  padAfter: 24,
  /** Largura mínima do bloco para receber o nome do serviço. */
  minLabelWidth: 40,
} as const;

/** Pixels por dia corrido em cada zoom, antes do ajuste fino (`zoomScale`). Cada nível tem mais ou
 * menos o triplo do seguinte, para a troca de visão ser evidente: numa tela de 1.100 px cabem cerca
 * de 2 meses na semana, 7 no mês e 22 no trimestre. 'obra' é calculado para o plano caber na largura
 * disponível, entre `obraMin` e `obraMax`. */
export const ZOOM_PX = { semana: 16, mes: 4.5, trimestre: 1.5, obraMin: 0.4, obraMax: 6 } as const;

/** Ajuste fino do zoom (botões − e +, Ctrl+roda): multiplicador sobre a escala do nível escolhido. */
export const ZOOM_SCALE_MIN = 0.25;
export const ZOOM_SCALE_MAX = 6;
export const ZOOM_SCALE_STEP = 1.25;
/** Limites da escala efetiva (nível × ajuste fino), em px por dia corrido. */
export const PX_PER_DAY_MIN = 0.3;
export const PX_PER_DAY_MAX = 40;

/** Escala efetiva a partir da qual o cabeçalho do tempo muda de cara: semanas (≥ `week`), meses
 * (≥ `month`) ou trimestres (abaixo disso). */
export const HEADER_SCALE_PX = { week: 9, month: 2.5 } as const;

/** Largura mínima do dia, em px, para grifar os dias sem trabalho (sábados, domingos e os dias do
 * calendário da obra) atrás dos blocos: com 2,5 px por dia a faixa do fim de semana tem 5 px. Vale
 * para "Semana" (16), "Mês" (4,5) e os ajustes finos acima do limiar; mais estreito que isso as
 * faixas virariam um listrado que só atrapalha (23/11/2026). */
export const OFF_DAY_MIN_PX = 2.5;
/** Largura mínima do dia, em px, para a faixa de baixo do cabeçalho mostrar o número de cada dia
 * em vez de só o da segunda-feira: é o zoom "Semana" e as ampliações dele. */
export const DAY_LABEL_MIN_PX = 14;
/** Cor das faixas de dias sem trabalho (cinza neutro, desenhado translúcido sobre o fundo). */
export const OFF_DAY_FILL = '#64748b';
export const OFF_DAY_OPACITY = 0.13;

/** Largura mínima do dia, em px, para o selo do desvio contra a linha de base ("+12d", "−3d") aparecer
 * dentro do bloco: vale para "Semana" (16), "Mês" (4,5) e os ajustes finos acima do limiar. No
 * "Trimestre" (1,5) e na "Obra inteira" de uma obra longa os blocos são estreitos demais: lá o desvio
 * fica só na dica do bloco e na Tabela, para não poluir a visão geral (23/11/2026). */
export const DEVIATION_BADGE_MIN_PX = 2.5;
/** Cores do selo do desvio: vermelho = atrasado em relação à linha de base, verde = adiantado. */
export const DEVIATION_COLORS = { late: '#be123c', ahead: '#047857' } as const;

/** Contorno dos blocos do caminho crítico: roxo, para não se confundir com o vermelho do atraso
 * (`CHART.late`) nem com o contorno escuro da seleção (`CHART.ink`). */
export const CRITICAL_COLOR = '#7e22ce';

/** "Hoje" só entra na janela do eixo se estiver a até este tanto de dias do plano: uma obra
 * concluída há anos não precisa de um eixo até hoje. */
const TODAY_REACH_DAYS = 120;

export const MONTHS_SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const MONTHS_LONG = [
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
export const WEEKDAYS_SHORT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
/** "dd/mm". */
export const shortDate = (date: LocalDate) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
/** "seg 09/11": dia da semana abreviado e dd/mm, como no tooltip do modelo. */
export const weekdayDate = (date: LocalDate) => `${WEEKDAYS_SHORT[weekday(date)]} ${shortDate(date)}`;
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
export const clip = (text: string, max: number) => (max < 1 ? '' : text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text);

// ─── Cor do texto sobre o bloco ─────────────────────────────────────────────────

/** Luminância relativa (WCAG) de um `#rrggbb`. */
function luminance(hex: string) {
  const channel = (at: number) => {
    const c = parseInt(hex.slice(at, at + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}
/** A cor como fica desenhada com `fill-opacity` sobre o fundo do gráfico. */
export function blendOnSurface(hex: string, alpha: number, surface: string = CHART.surfaceMuted) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const mix = (at: number) => {
    const top = parseInt(hex.slice(at, at + 2), 16),
      under = parseInt(surface.slice(at, at + 2), 16);
    return Math.round(top * alpha + under * (1 - alpha))
      .toString(16)
      .padStart(2, '0');
  };
  return `#${mix(1)}${mix(3)}${mix(5)}`;
}
/** Mesma regra da Linha de Balanço dos vagões: texto escuro sobre as cores claras da paleta (amarelo,
 * verde-água, rosa), branco sobre as outras. `alpha` considera a parte ainda não medida do bloco,
 * desenhada a 42%: sobre ela quase toda cor fica clara e o texto precisa ser escuro. */
export function inkOn(fill: string, alpha = 1) {
  const effective = alpha < 1 ? blendOnSurface(fill, alpha) : fill;
  if (!/^#[0-9a-f]{6}$/i.test(effective)) return CHART.ink;
  return luminance(effective) > 0.3 ? CHART.ink : '#ffffff';
}

// ─── Tipos do layout ────────────────────────────────────────────────────────────

export interface LobLayoutInput {
  /** `calendar` é o calendário de dias úteis da obra (ausente = segunda a sexta sem feriados). */
  data: Pick<LobData, 'locals' | 'services' | 'activities' | 'calendar'>;
  zoom: LobZoom;
  /** Ajuste fino sobre a escala do zoom (padrão 1). */
  zoomScale?: number;
  /** Largura do contêiner em px: o zoom 'obra' ajusta a escala para o plano caber nela. */
  availableWidth: number;
  today: LocalDate;
  measurementDates?: { number: number; date: LocalDate }[];
  baseline?: LobBaseline;
  hiddenServiceIds?: ReadonlySet<string>;
  visibleLocalIds?: ReadonlySet<string>;
  /** Período mostrado (datas inclusivas); sem ele, o plano inteiro. */
  range?: { start: LocalDate; end: LocalDate };
  /** Escala congelada (23/11/2026): a janela e os px por dia de um layout anterior. Enquanto a pessoa
   * edita, mover um bloco não muda a escala nem a origem do eixo (o que redesenharia a obra inteira);
   * a janela só cresce se um bloco sair dela. Sem `pin`, o layout encaixa de novo. Ignorado com `range`. */
  pin?: { start: LocalDate; end: LocalDate; pxPerDay: number };
}
export interface LobRow {
  local: LobLocal;
  /** Posição de baixo para cima (0 = o local mais baixo). */
  index: number;
  /** Topo da linha, em px. */
  y: number;
  /** Altura da linha: `GEOMETRY.row`, ou mais quando há serviços simultâneos no local. */
  height: number;
  /** Maior número de faixas usadas na linha (1 = nenhuma sobreposição). */
  lanes: number;
}
export interface LobBlock {
  activity: LobActivity;
  service: LobService;
  local: LobLocal;
  row: LobRow;
  x: number;
  y: number;
  w: number;
  h: number;
  start: LocalDate;
  /** Fim exclusivo (primeiro dia útil livre). */
  end: LocalDate;
  /** Último dia trabalhado. */
  finish: LocalDate;
  /** O bloco contra a linha de base escolhida (desvio em dias úteis, ou "novo"); ausente sem linha de base. */
  deviation?: LobBaselineDeviation;
}
export interface LobGhost {
  activityId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  start: LocalDate;
  durationDays: number;
  /** Último dia trabalhado na linha de base. */
  finish: LocalDate;
}
/** Uma sequência de dias sem trabalho seguidos (sábado + domingo, um feriado, um recesso), já em px. */
export interface LobOffRun {
  x: number;
  w: number;
  /** Primeiro dia da sequência e quantos dias corridos ela tem. */
  start: LocalDate;
  days: number;
}
/** Um dia na faixa de baixo do cabeçalho, no zoom que mostra o número de cada dia. */
export interface LobHeaderDay {
  x: number;
  w: number;
  /** Dia do mês, com dois dígitos. */
  label: string;
  /** Dia sem trabalho no calendário da obra: número esmaecido. */
  off: boolean;
}
export type LobHeaderScale = 'week' | 'month' | 'quarter';
/** Uma célula do cabeçalho do tempo, já recortada na janela do eixo. */
export interface LobHeaderCell {
  x: number;
  w: number;
  /** Vazio quando o texto não cabe na célula. */
  label: string;
  /** Primeiro período do ano (janeiro, T1): rótulo em negrito. */
  strong?: boolean;
}
/** Cabeçalho do tempo conforme a escala efetiva:
 * - 'week': meses em cima ("novembro 2026"), semanas embaixo (dia da segunda-feira); grade leve por
 *   semana e forte por mês; com o dia largo (`DAY_LABEL_MIN_PX`), `days` traz o número de cada dia,
 *   que o gráfico mostra no lugar do número da semana;
 * - 'month': anos em cima, meses embaixo ("nov", "jan/27"); grade por mês (forte em janeiro) e traço
 *   curto por semana na base;
 * - 'quarter': anos em cima, trimestres embaixo ("T2", "T1/27"); grade forte por trimestre e leve
 *   por mês. */
export interface LobHeader {
  scale: LobHeaderScale;
  top: LobHeaderCell[];
  bottom: LobHeaderCell[];
  /** Linhas verticais da grade, da esquerda para a direita. */
  lines: { x: number; strong: boolean }[];
  /** Traços curtos na base do gráfico (segundas-feiras, só na escala 'month'). */
  ticks: number[];
  /** Um por dia da janela, só na escala 'week' com o dia a partir de `DAY_LABEL_MIN_PX`; senão vazio. */
  days: LobHeaderDay[];
}
export interface LobMarker {
  x: number;
  label: string;
  date: LocalDate;
}
export interface LobLayout {
  zoom: LobZoom;
  /** Janela do eixo: `start` inclusivo, `end` exclusivo. */
  start: LocalDate;
  end: LocalDate;
  pxPerDay: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** Altura base de uma linha; a de cada uma está em `rows[i].height`. */
  rowHeight: number;
  innerW: number;
  innerH: number;
  width: number;
  height: number;
  rows: LobRow[];
  blocks: LobBlock[];
  blockById: Map<string, LobBlock>;
  ghosts: LobGhost[];
  header: LobHeader;
  /** Dias sem trabalho da janela (fins de semana e os dias do calendário da obra), com os dias
   * seguidos juntos numa faixa só. Vazio quando o dia é mais estreito que `OFF_DAY_MIN_PX`. */
  offRuns: LobOffRun[];
  /** Abscissa de "hoje"; indefinida quando fica fora da janela. */
  todayX?: number;
  measurements: LobMarker[];
  /** Data → px (borda esquerda do dia). */
  xOf: (date: LocalDate) => number;
  /** px → dia útil mais próximo no calendário da obra: sábado volta para sexta, domingo avança para
   * segunda, e um feriado vai ao dia útil vizinho (o seguinte, no empate). */
  dateAtX: (x: number) => LocalDate;
}

// ─── Layout ─────────────────────────────────────────────────────────────────────

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Locais ordenados de baixo para cima (orderIndex crescente), já filtrados. */
export function orderedLocals(locals: LobLocal[], visibleLocalIds?: ReadonlySet<string>): LobLocal[] {
  return locals
    .filter(l => !visibleLocalIds || visibleLocalIds.has(l.id))
    .sort((a, b) => a.orderIndex - b.orderIndex || a.name.localeCompare(b.name, 'pt-BR'));
}
/** Dia útil mais próximo de uma data qualquer, no calendário da obra (sem ele, segunda a sexta):
 * sábado volta para sexta e domingo avança para segunda; no empate (um feriado no meio da semana),
 * vale o dia seguinte. */
export function nearestWorkday(date: LocalDate, calendar?: LobCalendar): LocalDate {
  if (isWorkday(date, calendar)) return date;
  // Sempre termina: o calendário tem ao menos um dia da semana e uma lista finita de dias sem trabalho.
  for (let distance = 1; ; distance++) {
    const after = addDays(date, distance);
    if (isWorkday(after, calendar)) return after;
    const before = addDays(date, -distance);
    if (isWorkday(before, calendar)) return before;
  }
}

/** Dias sem trabalho de `start` (inclusivo) a `end` (exclusivo), com os dias seguidos juntos: o fim
 * de semana é uma sequência de dois dias, e um feriado na sexta emenda com ele numa de três. */
export function nonWorkingRuns(start: LocalDate, end: LocalDate, calendar?: LobCalendar): { start: LocalDate; days: number }[] {
  const runs: { start: LocalDate; days: number }[] = [];
  let open: { start: LocalDate; days: number } | undefined;
  for (let date = start; date < end; date = addDays(date, 1)) {
    if (isWorkday(date, calendar)) {
      open = undefined;
      continue;
    }
    if (open) open.days++;
    else runs.push((open = { start: date, days: 1 }));
  }
  return runs;
}

/** Janela do eixo do tempo. Sem período escolhido, vai do primeiro ao último bloco de TODA a obra
 * (não só dos filtrados): ocultar um serviço pela legenda não desloca o eixo. Entram também os
 * fantasmas da linha de base e, se estiver perto do plano, o dia de hoje. */
function timeWindow(input: LobLayoutInput): { start: LocalDate; end: LocalDate } {
  if (input.range) return { start: input.range.start, end: addDays(input.range.end, 1) };
  const dates: LocalDate[] = [];
  const ends: LocalDate[] = [];
  const calendar = input.data.calendar;
  for (const a of input.data.activities) {
    dates.push(a.start);
    ends.push(activityEnd(a, calendar));
  }
  for (const g of input.baseline?.snapshot ?? []) {
    dates.push(g.start);
    ends.push(baselineEntryEnd(g, calendar));
  }
  if (!dates.length) {
    dates.push(input.today);
    ends.push(addDays(input.today, 30));
  }
  let start = dates.reduce((m, d) => (d < m ? d : m));
  let end = ends.reduce((m, d) => (d > m ? d : m));
  if (Math.abs(daysBetween(start, input.today)) <= TODAY_REACH_DAYS || Math.abs(daysBetween(end, input.today)) <= TODAY_REACH_DAYS) {
    if (input.today < start) start = input.today;
    if (input.today >= end) end = addDays(input.today, 1);
  }
  return { start: addDays(start, -GEOMETRY.padBefore), end: addDays(end, GEOMETRY.padAfter) };
}

/** Folga, em dias, entre o conteúdo e a borda da janela congelada antes de ela crescer. */
const PIN_MARGIN_DAYS = 3;
/** A janela com a escala congelada: fica a de `pin` enquanto os blocos couberem nela (com uma folga
 * pequena); o lado em que um bloco saiu passa a ser o da janela natural. */
function pinnedWindow(natural: { start: LocalDate; end: LocalDate }, input: LobLayoutInput) {
  const pin = input.pin;
  if (!pin || input.range) return natural;
  const contentStart = addDays(natural.start, GEOMETRY.padBefore);
  const contentEnd = addDays(natural.end, -GEOMETRY.padAfter);
  return {
    start: contentStart < addDays(pin.start, PIN_MARGIN_DAYS) && natural.start < pin.start ? natural.start : pin.start,
    end: contentEnd > addDays(pin.end, -PIN_MARGIN_DAYS) && natural.end > pin.end ? natural.end : pin.end,
  };
}

// ─── Desvio contra a linha de base ──────────────────────────────────────────────

/** "+12 dias úteis (atrasado)", "−3 dias úteis (adiantado)" ou "no prazo". */
export function signedWorkdays(days: number, withTone = true): string {
  if (!days) return 'no prazo';
  const text = `${days > 0 ? '+' : '−'}${plural(Math.abs(days), 'dia útil', 'dias úteis')}`;
  return withTone ? `${text} (${days > 0 ? 'atrasado' : 'adiantado'})` : text;
}
/** O desvio do bloco por extenso, pelo término; cita o início quando ele difere do término
 * ("+5 dias úteis (atrasado) no término; início +2 dias úteis"). Bloco criado depois da foto:
 * "não estava na linha de base". */
export function deviationText(deviation: LobBaselineDeviation): string {
  if (deviation.status === 'new') return 'não estava na linha de base';
  const finish = signedWorkdays(deviation.finishDays);
  if (deviation.startDays === deviation.finishDays) return finish;
  return `${finish} no término; início ${signedWorkdays(deviation.startDays, false)}`;
}
/** "dd/mm → dd/mm" da linha de base (com o ano quando ele difere do ano de `today`). */
export function baselineDatesText(deviation: Extract<LobBaselineDeviation, { status: 'compared' }>, today?: LocalDate): string {
  const show = (date: LocalDate) =>
    today && date.slice(0, 4) !== today.slice(0, 4) ? `${shortDate(date)}/${date.slice(2, 4)}` : shortDate(date);
  return `${show(deviation.baselineStart)} → ${show(deviation.baselineFinish)}`;
}
/** Selo curto do desvio do término: "+12d", "−3d"; vazio quando não há desvio (ou o bloco é novo). */
export function deviationBadge(deviation: LobBaselineDeviation | undefined): string {
  if (!deviation || deviation.status !== 'compared' || !deviation.finishDays) return '';
  return `${deviation.finishDays > 0 ? '+' : '−'}${Math.abs(deviation.finishDays)}d`;
}
/** Largura do selo, em px (letra de 9 px, ~5,4 px por caractere, mais a margem interna). */
export const badgeWidth = (text: string) => Math.ceil(text.length * 5.4 + 8);
/** O selo que cabe num bloco de `blockWidth` px: o completo ("+4d") com folga de 6 px ou, no bloco
 * estreito (5 dias úteis no zoom "Mês" têm ~21 px), o compacto, sem o "d" e com menos margem ("+4").
 * Indefinido quando nem o compacto cabe: aí o desvio fica na dica do bloco e na Tabela. */
export function fitBadge(text: string, blockWidth: number): { text: string; width: number } | undefined {
  if (!text) return undefined;
  const full = badgeWidth(text);
  if (blockWidth >= full + 6) return { text, width: full };
  const compact = text.replace(/d$/, '');
  const width = Math.ceil(compact.length * 5.4 + 5);
  return blockWidth >= width + 3 ? { text: compact, width } : undefined;
}

/** Desvio de cada bloco contra uma linha de base, guardado por bloco: a conta percorre os dias entre
 * as duas datas, e depois de um arrasto só os blocos que mudaram (objetos novos) são refeitos. */
const deviationCache = new WeakMap<
  LobBaseline,
  { calendar: LobCalendar | undefined; entries: Map<string, LobBaselineEntry>; byActivity: WeakMap<LobActivity, LobBaselineDeviation> }
>();
export function baselineDeviations(baseline: LobBaseline, calendar?: LobCalendar): (activity: LobActivity) => LobBaselineDeviation {
  let cache = deviationCache.get(baseline);
  if (!cache || cache.calendar !== calendar) {
    cache = { calendar, entries: baselineEntries(baseline), byActivity: new WeakMap() };
    deviationCache.set(baseline, cache);
  }
  const { entries, byActivity } = cache;
  return activity => {
    let deviation = byActivity.get(activity);
    if (!deviation) {
      deviation = baselineDeviation(activity, entries.get(activity.id), calendar);
      byActivity.set(activity, deviation);
    }
    return deviation;
  };
}

/** Faixa de cada bloco de um local: blocos que se sobrepõem no tempo (fim exclusivo) formam um
 * grupo e repartem a altura, cada um na primeira faixa livre, pela ordem de início e depois do
 * serviço; quem não se sobrepõe a ninguém fica com a linha inteira. Devolve, na ordem recebida, a
 * faixa e o total de faixas do grupo do bloco. */
export function assignLanes(items: { start: LocalDate; end: LocalDate; order: number }[]): { lane: number; lanes: number }[] {
  const result = items.map(() => ({ lane: 0, lanes: 1 }));
  const sorted = items.map((item, index) => ({ ...item, index })).sort((a, b) => a.start.localeCompare(b.start) || a.order - b.order);
  let group: number[] = [];
  let laneEnds: LocalDate[] = [];
  let groupEnd = '';
  const close = () => {
    for (const index of group) result[index].lanes = laneEnds.length;
    group = [];
    laneEnds = [];
  };
  for (const item of sorted) {
    if (group.length && item.start >= groupEnd) close();
    let lane = laneEnds.findIndex(end => end <= item.start);
    if (lane < 0) lane = laneEnds.push(item.end) - 1;
    else laneEnds[lane] = item.end;
    result[item.index].lane = lane;
    group.push(item.index);
    if (group.length === 1 || item.end > groupEnd) groupEnd = item.end;
  }
  close();
  return result;
}
/** Altura da linha que acomoda `lanes` faixas de no mínimo `GEOMETRY.lane` px. */
export const rowHeightFor = (lanes: number) =>
  lanes <= 1
    ? GEOMETRY.row
    : Math.max(GEOMETRY.row, Math.ceil(2 * GEOMETRY.blockPad + lanes * GEOMETRY.lane + (lanes - 1) * GEOMETRY.laneGap));

/** Escala efetiva, em px por dia corrido: a do nível (fixa, ou a que encaixa a obra na largura)
 * vezes o ajuste fino, dentro de `PX_PER_DAY_MIN`…`PX_PER_DAY_MAX`. */
export function pxPerDayFor(zoom: LobZoom, days: number, availableWidth: number, zoomScale = 1): number {
  let base: number;
  if (zoom === 'obra') {
    // 2 px a menos: o arredondamento da largura não pode gerar uma barra de rolagem de 1 px.
    const inner = Math.max(120, availableWidth - GEOMETRY.left - GEOMETRY.right - 2);
    base = clamp(inner / Math.max(1, days), ZOOM_PX.obraMin, ZOOM_PX.obraMax);
  } else base = ZOOM_PX[zoom];
  const scale = Number.isFinite(zoomScale) && zoomScale > 0 ? zoomScale : 1;
  return clamp(base * scale, PX_PER_DAY_MIN, PX_PER_DAY_MAX);
}

export const headerScaleFor = (pxPerDay: number): LobHeaderScale =>
  pxPerDay >= HEADER_SCALE_PX.week ? 'week' : pxPerDay >= HEADER_SCALE_PX.month ? 'month' : 'quarter';

/** Primeiro rótulo que cabe em `width` px (~6 px por caractere a 10 px, mais 10 px de margem). */
const fitLabel = (width: number, ...candidates: string[]) => candidates.find(text => text.length * 6 + 10 <= width) ?? '';

/** Inícios de período de `step` meses (1 = mês, 3 = trimestre, 12 = ano), do que contém `start` até
 * o primeiro em `end` ou depois: cada par vizinho é uma célula. */
function monthBounds(start: LocalDate, end: LocalDate, step: number): LocalDate[] {
  const cursor = new Date(toMs(start));
  cursor.setUTCDate(1);
  cursor.setUTCMonth(Math.floor(cursor.getUTCMonth() / step) * step);
  const bounds: LocalDate[] = [];
  for (;;) {
    const date = fromMs(cursor.getTime());
    bounds.push(date);
    if (date >= end) return bounds;
    cursor.setUTCMonth(cursor.getUTCMonth() + step);
  }
}
/** Segundas-feiras, da semana que contém `start` até a primeira em `end` ou depois. */
function weekBounds(start: LocalDate, end: LocalDate): LocalDate[] {
  const bounds: LocalDate[] = [];
  for (let d = addDays(start, -((weekday(start) + 6) % 7)); ; d = addDays(d, 7)) {
    bounds.push(d);
    if (d >= end) return bounds;
  }
}

/** Cabeçalho do tempo da janela `start` (inclusivo) … `end` (exclusivo) na escala dada. Função pura:
 * o gráfico só desenha as células e as linhas que saem daqui. */
export function lobHeader(
  start: LocalDate,
  end: LocalDate,
  pxPerDay: number,
  left: number = GEOMETRY.left,
  calendar?: LobCalendar,
): LobHeader {
  const scale = headerScaleFor(pxPerDay);
  const right = left + Math.round(Math.max(1, daysBetween(start, end)) * pxPerDay);
  const xAt = (date: LocalDate) => clamp(left + daysBetween(start, date) * pxPerDay, left, right);
  const month = (date: LocalDate) => Number(date.slice(5, 7)) - 1;
  const yy = (date: LocalDate) => date.slice(2, 4);
  const cells = (bounds: LocalDate[], cell: (date: LocalDate, width: number) => Omit<LobHeaderCell, 'x' | 'w'>): LobHeaderCell[] => {
    const out: LobHeaderCell[] = [];
    for (let i = 0; i + 1 < bounds.length; i++) {
      const x = xAt(bounds[i]),
        w = xAt(bounds[i + 1]) - x;
      if (w > 0) out.push({ x: r2(x), w: r2(w), ...cell(bounds[i], w) });
    }
    return out;
  };
  // Grade: uma linha por limite que cai dentro da janela; o mais forte vence quando dois coincidem.
  const lineAt = new Map<LocalDate, boolean>();
  const addLines = (bounds: LocalDate[], strong: (date: LocalDate) => boolean) => {
    for (const date of bounds) if (date >= start && date < end) lineAt.set(date, lineAt.get(date) || strong(date));
  };
  const months = monthBounds(start, end, 1);
  const years = () =>
    cells(monthBounds(start, end, 12), (date, w) => ({ label: fitLabel(w, date.slice(0, 4), `'${yy(date)}`), strong: true }));
  let top: LobHeaderCell[], bottom: LobHeaderCell[];
  let ticks: number[] = [];
  const days: LobHeaderDay[] = [];

  if (scale === 'week') {
    const weeks = weekBounds(start, end);
    top = cells(months, (date, w) => {
      const m = month(date),
        year = date.slice(0, 4);
      return {
        label: fitLabel(w, `${MONTHS_LONG[m]} ${year}`, `${MONTHS_SHORT[m]} ${year}`, `${MONTHS_SHORT[m]}/${yy(date)}`, MONTHS_SHORT[m]),
        strong: m === 0,
      };
    });
    // A semana cortada pela borda esquerda fica sem número: a segunda-feira dela está fora da janela.
    bottom = cells(weeks, (date, w) => ({ label: date >= start ? fitLabel(w, date.slice(8, 10)) : '' }));
    addLines(weeks, () => false);
    addLines(months, () => true);
    if (pxPerDay >= DAY_LABEL_MIN_PX)
      for (let date = start; date < end; date = addDays(date, 1)) {
        const x = xAt(date);
        days.push({ x: r2(x), w: r2(xAt(addDays(date, 1)) - x), label: date.slice(8, 10), off: !isWorkday(date, calendar) });
      }
  } else if (scale === 'month') {
    top = years();
    bottom = cells(months, (date, w) => {
      const m = month(date);
      return m === 0
        ? { label: fitLabel(w, `${MONTHS_SHORT[0]}/${yy(date)}`, MONTHS_SHORT[0]), strong: true }
        : { label: fitLabel(w, MONTHS_SHORT[m]) };
    });
    addLines(months, date => month(date) === 0);
    ticks = weekBounds(start, end)
      .filter(date => date >= start && date < end)
      .map(date => r2(xAt(date)));
  } else {
    top = years();
    bottom = cells(monthBounds(start, end, 3), (date, w) => {
      const quarter = `T${month(date) / 3 + 1}`;
      return month(date) === 0 ? { label: fitLabel(w, `${quarter}/${yy(date)}`, quarter), strong: true } : { label: fitLabel(w, quarter) };
    });
    addLines(months, date => month(date) % 3 === 0);
  }
  const lines = [...lineAt].sort(([a], [b]) => a.localeCompare(b)).map(([date, strong]) => ({ x: r2(xAt(date)), strong }));
  return { scale, top, bottom, lines, ticks, days };
}

/** Largura desenhada de um bloco (ou do tracejado da linha de base): do início ao fim do ÚLTIMO DIA
 * TRABALHADO, e não até o fim exclusivo (o primeiro dia útil livre). Um bloco que termina na sexta
 * acaba na sexta: desenhado até a segunda, ele cobria a faixa do sábado e do domingo e parecia
 * trabalhar no fim de semana (23/11/2026). Só o desenho: as regras de data continuam no fim exclusivo. */
const drawnWidth = (xOf: (date: LocalDate) => number, start: LocalDate, finish: LocalDate) =>
  r2(Math.max(2, xOf(addDays(finish, 1)) - xOf(start) - GEOMETRY.blockGap));

/** Monta o layout inteiro. Chamar dentro de um `useMemo`: percorre todos os blocos uma vez. */
export function lobLayout(input: LobLayoutInput): LobLayout {
  const { left, top, right, bottom, row: rowHeight } = GEOMETRY;
  const { start, end } = pinnedWindow(timeWindow(input), input);
  const days = Math.max(1, daysBetween(start, end));
  const pxPerDay = input.pin && !input.range ? input.pin.pxPerDay : pxPerDayFor(input.zoom, days, input.availableWidth, input.zoomScale);
  const innerW = Math.round(days * pxPerDay);
  const calendar = input.data.calendar;
  const xOf = (date: LocalDate) => left + daysBetween(start, date) * pxPerDay;
  const dateAtX = (x: number) => nearestWorkday(addDays(start, Math.round((x - left) / pxPerDay)), calendar);

  const locals = orderedLocals(input.data.locals, input.visibleLocalIds);
  const rows: LobRow[] = locals.map((local, index) => ({ local, index, y: top, height: rowHeight, lanes: 1 }));
  const rowByLocal = new Map(rows.map(r => [r.local.id, r]));
  const serviceById = new Map(input.data.services.map(s => [s.id, s]));

  // Blocos visíveis de cada local, para repartir a linha em faixas quando se sobrepõem.
  type Placed = { activity: LobActivity; service: LobService; row: LobRow; end: LocalDate; lane: number; lanes: number };
  const placed: Placed[] = [];
  const byRow = new Map<string, Placed[]>();
  for (const activity of input.data.activities) {
    if (input.hiddenServiceIds?.has(activity.serviceId)) continue;
    const row = rowByLocal.get(activity.localId);
    const service = serviceById.get(activity.serviceId);
    if (!row || !service) continue;
    const blockEnd = activityEnd(activity, calendar);
    // Fora do período escolhido: nem desenha. Quem cruza a borda entra e o gráfico recorta.
    if (blockEnd <= start || activity.start >= end) continue;
    const item: Placed = { activity, service, row, end: blockEnd, lane: 0, lanes: 1 };
    placed.push(item);
    const list = byRow.get(row.local.id);
    if (list) list.push(item);
    else byRow.set(row.local.id, [item]);
  }
  for (const [localId, list] of byRow) {
    const lanes = assignLanes(list.map(p => ({ start: p.activity.start, end: p.end, order: p.service.orderIndex })));
    list.forEach((p, i) => Object.assign(p, lanes[i]));
    const row = rowByLocal.get(localId)!;
    row.lanes = Math.max(1, ...lanes.map(l => l.lanes));
    row.height = rowHeightFor(row.lanes);
  }
  // De cima para baixo: o local mais alto (último índice) fica no topo do gráfico.
  let cursorY = top;
  for (let i = rows.length - 1; i >= 0; i--) {
    rows[i].y = cursorY;
    cursorY += rows[i].height;
  }
  const innerH = cursorY - top;

  const blocks: LobBlock[] = [];
  const blockById = new Map<string, LobBlock>();
  const deviationOf = input.baseline ? baselineDeviations(input.baseline, calendar) : undefined;
  for (const { activity, service, row, end: blockEnd, lane, lanes } of placed) {
    const x = xOf(activity.start);
    const finish = activityFinish(activity, calendar);
    const inner = row.height - 2 * GEOMETRY.blockPad;
    const h = (inner - (lanes - 1) * GEOMETRY.laneGap) / lanes;
    const block: LobBlock = {
      activity,
      service,
      local: row.local,
      row,
      x: r2(x),
      y: r2(row.y + GEOMETRY.blockPad + lane * (h + GEOMETRY.laneGap)),
      w: drawnWidth(xOf, activity.start, finish),
      h: r2(h),
      start: activity.start,
      end: blockEnd,
      finish,
      deviation: deviationOf?.(activity),
    };
    blocks.push(block);
    blockById.set(activity.id, block);
  }

  // Linha de base: fantasma só onde o bloco atual existe e saiu do lugar (mudou de início, de duração
  // ou de término — este muda sozinho quando o calendário ganha um feriado no meio do bloco).
  // Fantasma igual ao bloco só poria um tracejado por baixo de tudo, sem informação nova.
  const ghosts: LobGhost[] = [];
  for (const entry of input.baseline?.snapshot ?? []) {
    const block = blockById.get(entry.activityId);
    if (!block) continue;
    const ghostFinish = baselineEntryFinish(entry, calendar);
    if (entry.start === block.activity.start && entry.durationDays === block.activity.durationDays && ghostFinish === block.finish)
      continue;
    const ghostEnd = baselineEntryEnd(entry, calendar);
    if (ghostEnd <= start || entry.start >= end) continue;
    const x = xOf(entry.start);
    ghosts.push({
      activityId: entry.activityId,
      x: r2(x),
      y: block.y,
      w: drawnWidth(xOf, entry.start, ghostFinish),
      h: block.h,
      start: entry.start,
      durationDays: entry.durationDays,
      finish: ghostFinish,
    });
  }

  // Dias sem trabalho atrás dos blocos, quando o zoom dá espaço: uma faixa por sequência de dias.
  const offRuns: LobOffRun[] =
    pxPerDay >= OFF_DAY_MIN_PX
      ? nonWorkingRuns(start, end, calendar).map(run => ({
          x: r2(xOf(run.start)),
          w: r2(run.days * pxPerDay),
          start: run.start,
          days: run.days,
        }))
      : [];

  const inWindow = (date: LocalDate) => date >= start && date < end;
  const todayX = inWindow(input.today) ? r2(xOf(input.today)) : undefined;
  const measurements: LobMarker[] = (input.measurementDates ?? [])
    .filter(m => inWindow(m.date))
    .sort((a, b) => a.date.localeCompare(b.date) || a.number - b.number)
    .map(m => ({ x: r2(xOf(m.date)), label: `M${m.number}`, date: m.date }));

  return {
    zoom: input.zoom,
    start,
    end,
    pxPerDay,
    left,
    top,
    right,
    bottom,
    rowHeight,
    innerW,
    innerH,
    width: left + innerW + right,
    height: top + innerH + bottom,
    rows,
    blocks,
    blockById,
    ghosts,
    header: lobHeader(start, end, pxPerDay, left, calendar),
    offRuns,
    todayX,
    measurements,
    xOf,
    dateAtX,
  };
}

// ─── Arrasto ────────────────────────────────────────────────────────────────────

/** Onde um bloco fica desenhado enquanto o arrasto não é solto: deslocamento e largura em px. */
export interface LobShift {
  dx: number;
  w: number;
  start: LocalDate;
}
/** Deslocamento, por linha (local), dos blocos que um movimento altera: o bloco arrastado e as
 * sucessoras que a rede empurra (`changed` vem do planejador de movimentos, o mesmo do servidor). Só
 * entram as linhas com algum bloco deslocado: as outras nem redesenham. */
export function dragShifts(layout: LobLayout, changed: LobActivity[], calendar?: LobCalendar): Map<string, Map<string, LobShift>> {
  const byRow = new Map<string, Map<string, LobShift>>();
  for (const activity of changed) {
    const block = layout.blockById.get(activity.id);
    if (!block) continue;
    const x = layout.xOf(activity.start);
    const w = drawnWidth(layout.xOf, activity.start, activityFinish(activity, calendar));
    const dx = r2(x - block.x);
    if (!dx && w === block.w) continue;
    let row = byRow.get(block.local.id);
    if (!row) byRow.set(block.local.id, (row = new Map()));
    row.set(activity.id, { dx, w, start: activity.start });
  }
  return byRow;
}
export const sameShifts = (a: ReadonlyMap<string, LobShift> | undefined, b: ReadonlyMap<string, LobShift> | undefined) => {
  if (a === b) return true;
  if (!a || !b || a.size !== b.size) return false;
  for (const [id, shift] of a) {
    const other = b.get(id);
    if (!other || other.dx !== shift.dx || other.w !== shift.w) return false;
  }
  return true;
};
/** Dois conjuntos de blocos de uma linha desenham o mesmo: mesmos blocos (o mesmo objeto de bloco da
 * obra), no mesmo lugar e com o mesmo desvio. É o que deixa uma linha intacta quando outra muda. */
export function sameBlocks(a: LobBlock[], b: LobBlock[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i],
      q = b[i];
    if (
      p.activity !== q.activity ||
      p.service !== q.service ||
      p.local !== q.local ||
      p.x !== q.x ||
      p.y !== q.y ||
      p.w !== q.w ||
      p.h !== q.h ||
      p.finish !== q.finish ||
      p.deviation !== q.deviation
    )
      return false;
  }
  return true;
}

/** A frase da prévia da mudança de calendário (regra de 23/11/2026): quantos blocos mudam de data e
 * para quando vai o término da obra. `blocks` é o total de blocos da obra. */
export function calendarPreviewText(preview: CalendarChangePreview, blocks: number): string {
  if (!blocks) return 'A obra ainda não tem blocos: nenhuma data muda. O calendário passa a valer para o que for lançado.';
  if (!preview.changedBlocks) return 'Nenhum bloco muda de data com este calendário.';
  const changed = `${plural(preview.changedBlocks, 'bloco muda', 'blocos mudam')} de data`;
  if (!preview.finishBefore || !preview.finishAfter) return `${changed}.`;
  return preview.finishBefore === preview.finishAfter
    ? `${changed}; o término da obra continua em ${formatDate(preview.finishAfter)}.`
    : `${changed}; o término da obra passa de ${formatDate(preview.finishBefore)} para ${formatDate(preview.finishAfter)}.`;
}

/** Duração mais comum de cada serviço entre seus blocos ("10 d/local" na legenda). */
export function typicalDurations(activities: Pick<LobActivity, 'serviceId' | 'durationDays'>[]): Map<string, number> {
  const counts = new Map<string, Map<number, number>>();
  for (const a of activities) {
    const perService = counts.get(a.serviceId) ?? new Map<number, number>();
    perService.set(a.durationDays, (perService.get(a.durationDays) ?? 0) + 1);
    counts.set(a.serviceId, perService);
  }
  const result = new Map<string, number>();
  for (const [serviceId, perService] of counts) {
    let best = 0,
      bestCount = -1;
    for (const [duration, count] of perService) {
      if (count > bestCount || (count === bestCount && duration < best)) {
        best = duration;
        bestCount = count;
      }
    }
    result.set(serviceId, best);
  }
  return result;
}

/** Quantos caracteres do nome cabem num bloco: ~6 px por caractere a 10,5 px, com 5 px de margem. */
export const labelChars = (width: number) => Math.floor((width - 10) / 6);

// ─── Busca de predecessora no painel do bloco (23/11/2026) ───────────────────

/** Opção do campo "adicionar predecessora": um bloco, com o rótulo "Serviço · Local". */
export interface PredecessorOption {
  id: string;
  label: string;
}

/** Quantas opções a lista mostra de uma vez; o resto aparece ao refinar a busca. */
export const PREDECESSOR_OPTIONS_LIMIT = 50;

const searchKey = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Filtra as candidatas pelo que foi digitado: sem diferenciar maiúsculas nem acentos, e cada
 * palavra precisa aparecer no rótulo, em qualquer ordem ("alv 12" acha "Alvenaria · 12º pavimento").
 * Busca vazia devolve tudo, na ordem recebida. */
export function filterPredecessorOptions<T extends PredecessorOption>(options: T[], query: string): T[] {
  const words = searchKey(query).split(/\s+/).filter(Boolean);
  if (!words.length) return options;
  return options.filter(option => {
    const key = searchKey(option.label);
    return words.every(word => key.includes(word));
  });
}

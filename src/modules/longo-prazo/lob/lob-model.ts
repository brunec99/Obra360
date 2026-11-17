import { addDays, daysBetween, fromMs, toMs } from '@/domain/long-term-plan';
import {
  activityEnd,
  activityFinish,
  weekday,
  type LobActivity,
  type LobBaseline,
  type LobData,
  type LobLocal,
  type LobService,
  type LocalDate,
} from '@/domain/lob';
import { CHART } from '@/shared/palette';

/** Geometria da Linha de Balanço (aba 1, modelo aprovado em 04/11/2026): funções puras, sem React,
 * que transformam `LobData` + zoom + filtros em pixels. O gráfico (`lob-chart.tsx`) só desenha o que
 * sai daqui, e o arrasto usa `dateAtX` para voltar de pixel a data. Tudo em dias corridos no eixo
 * (um dia = `pxPerDay`), mas as datas devolvidas caem sempre em dia útil. */

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
  data: Pick<LobData, 'locals' | 'services' | 'activities'>;
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
}
export interface LobGhost {
  activityId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  start: LocalDate;
  durationDays: number;
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
 *   semana e forte por mês;
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
  /** Abscissa de "hoje"; indefinida quando fica fora da janela. */
  todayX?: number;
  measurements: LobMarker[];
  /** Data → px (borda esquerda do dia). */
  xOf: (date: LocalDate) => number;
  /** px → dia útil mais próximo: sábado volta para sexta, domingo avança para segunda. */
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
/** Dia útil mais próximo de uma data qualquer. */
export function nearestWorkday(date: LocalDate): LocalDate {
  const d = weekday(date);
  if (d === 6) return addDays(date, -1);
  if (d === 0) return addDays(date, 1);
  return date;
}

/** Janela do eixo do tempo. Sem período escolhido, vai do primeiro ao último bloco de TODA a obra
 * (não só dos filtrados): ocultar um serviço pela legenda não desloca o eixo. Entram também os
 * fantasmas da linha de base e, se estiver perto do plano, o dia de hoje. */
function timeWindow(input: LobLayoutInput): { start: LocalDate; end: LocalDate } {
  if (input.range) return { start: input.range.start, end: addDays(input.range.end, 1) };
  const dates: LocalDate[] = [];
  const ends: LocalDate[] = [];
  for (const a of input.data.activities) {
    dates.push(a.start);
    ends.push(activityEnd(a));
  }
  for (const g of input.baseline?.snapshot ?? []) {
    dates.push(g.start);
    ends.push(activityEnd(g));
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
export function lobHeader(start: LocalDate, end: LocalDate, pxPerDay: number, left: number = GEOMETRY.left): LobHeader {
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
  return { scale, top, bottom, lines, ticks };
}

/** Monta o layout inteiro. Chamar dentro de um `useMemo`: percorre todos os blocos uma vez. */
export function lobLayout(input: LobLayoutInput): LobLayout {
  const { left, top, right, bottom, row: rowHeight } = GEOMETRY;
  const { start, end } = timeWindow(input);
  const days = Math.max(1, daysBetween(start, end));
  const pxPerDay = pxPerDayFor(input.zoom, days, input.availableWidth, input.zoomScale);
  const innerW = Math.round(days * pxPerDay);
  const xOf = (date: LocalDate) => left + daysBetween(start, date) * pxPerDay;
  const dateAtX = (x: number) => nearestWorkday(addDays(start, Math.round((x - left) / pxPerDay)));

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
    const blockEnd = activityEnd(activity);
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
  for (const { activity, service, row, end: blockEnd, lane, lanes } of placed) {
    const x = xOf(activity.start);
    const inner = row.height - 2 * GEOMETRY.blockPad;
    const h = (inner - (lanes - 1) * GEOMETRY.laneGap) / lanes;
    const block: LobBlock = {
      activity,
      service,
      local: row.local,
      row,
      x: r2(x),
      y: r2(row.y + GEOMETRY.blockPad + lane * (h + GEOMETRY.laneGap)),
      w: r2(Math.max(2, xOf(blockEnd) - x - GEOMETRY.blockGap)),
      h: r2(h),
      start: activity.start,
      end: blockEnd,
      finish: activityFinish(activity),
    };
    blocks.push(block);
    blockById.set(activity.id, block);
  }

  // Linha de base: fantasma só onde o bloco atual existe e saiu do lugar (ou mudou de duração).
  // Fantasma igual ao bloco só poria um tracejado por baixo de tudo, sem informação nova.
  const ghosts: LobGhost[] = [];
  for (const entry of input.baseline?.snapshot ?? []) {
    const block = blockById.get(entry.activityId);
    if (!block || (entry.start === block.activity.start && entry.durationDays === block.activity.durationDays)) continue;
    const ghostEnd = activityEnd(entry);
    if (ghostEnd <= start || entry.start >= end) continue;
    const x = xOf(entry.start);
    ghosts.push({
      activityId: entry.activityId,
      x: r2(x),
      y: block.y,
      w: r2(Math.max(2, xOf(ghostEnd) - x - GEOMETRY.blockGap)),
      h: block.h,
      start: entry.start,
      durationDays: entry.durationDays,
    });
  }

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
    header: lobHeader(start, end, pxPerDay, left),
    todayX,
    measurements,
    xOf,
    dateAtX,
  };
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

'use client';
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import {
  addWorkdays,
  createMovePlanner,
  delayDays,
  isLate,
  plannedPercent,
  type LobActivity,
  type LobBaseline,
  type LobCalendar,
  type LobData,
  type LobMovePlanner,
  type LobService,
  type LocalDate,
} from '@/domain/lob';
import { daysBetween } from '@/domain/long-term-plan';
import { CHART } from '@/shared/palette';
import { formatDate } from '@/shared/format';
import {
  CRITICAL_COLOR,
  DEVIATION_BADGE_MIN_PX,
  DEVIATION_COLORS,
  GEOMETRY,
  OFF_DAY_FILL,
  OFF_DAY_OPACITY,
  baselineDatesText,
  clip,
  deviationBadge,
  deviationText,
  dragShifts,
  fitBadge,
  inkOn,
  labelChars,
  lobLayout,
  plural,
  sameBlocks,
  sameShifts,
  shortDate,
  typicalDurations,
  weekdayDate,
  type LobBlock,
  type LobGhost,
  type LobLayout,
  type LobShift,
  type LobZoom,
} from './lob-model';

export type { LobZoom } from './lob-model';

/** Linha de Balanço no estilo Prevision (aba 1, modelo aprovado em 04/11/2026). Um <svg> por obra:
 * eixo vertical = locais de baixo para cima, eixo horizontal = tempo; cada bloco é um serviço num
 * local, na cor do serviço, com a parte medida cheia e a parte a fazer a 42%. Rótulos dos locais
 * ficam fixos à esquerda (coluna `position: sticky`) enquanto o gráfico rola. Toda a geometria vem
 * de `lob-model.ts`; aqui ficam só o desenho e a interação (seleção, tooltip, arrasto, teclado).
 * Os dias sem trabalho do calendário da obra (`data.calendar`: fins de semana, feriados e recessos)
 * aparecem como faixas cinza-claras atrás dos blocos quando o zoom dá espaço (`layout.offRuns`).
 *
 * Linha de base (23/11/2026): com uma escolhida, cada bloco que saiu do lugar tem um tracejado onde
 * estava; o tracejado responde ao mouse com a própria dica, o par bloco + tracejado é ligado ao passar
 * o mouse num dos dois, e o bloco ganha o selo do desvio do término ("+12d", "−3d") quando o zoom dá
 * espaço. Arrasto (23/11/2026): a cada dia que o ponteiro muda, o planejador de movimentos (a mesma
 * regra do servidor) diz onde o bloco e as sucessoras vão parar, e todos se deslocam juntos; ao soltar,
 * quem recebe `onMove` aplica na hora, então não há mais "bloco à espera do servidor". */

export interface LobChartProps {
  data: LobData;
  /** AAAA-MM-DD. */
  today: string;
  /** Acumulado medido por activityId (de `measuredPercents`). */
  percents: Record<string, number>;
  /** Medições fechadas, para as linhas verticais azuis. */
  measurementDates: { number: number; date: string }[];
  /** Linha de base em comparação: tracejado onde cada bloco estava, desvio na dica e no selo. */
  baseline?: LobBaseline;
  /** Quando muda, o gráfico encaixa a escala de novo (a pessoa pediu o zoom outra vez). Entre um
   * pedido e outro a escala fica congelada: editar datas não redesenha a obra inteira. */
  fitToken?: number;
  /** Serviços ocultos pela legenda. */
  hiddenServiceIds: ReadonlySet<string>;
  /** Filtro de locais; undefined = todos. */
  visibleLocalIds?: ReadonlySet<string>;
  /** Filtro de período; undefined = plano inteiro. */
  range?: { start: string; end: string };
  zoom: LobZoom;
  /** Ajuste fino sobre a escala do zoom (botões − e +); padrão 1. */
  zoomScale?: number;
  /** Pedido de um passo de zoom (1 = aproximar, -1 = afastar): Ctrl+roda, ⌘+roda ou pinça do
   * trackpad sobre o gráfico, e as teclas + e − com o foco nele. Quem recebe ajusta `zoomScale`. */
  onZoomStep?: (direction: 1 | -1) => void;
  /** Caminho crítico ligado: os blocos fora do conjunto ficam esmaecidos e os de dentro ganham
   * contorno roxo. Indefinido = modo desligado. */
  criticalIds?: ReadonlySet<string>;
  /** Folga total de cada bloco, em dias úteis, para o tooltip (0 = crítico). */
  floatDays?: ReadonlyMap<string, number>;
  selectedId?: string;
  /** Sem arrastar nem mover pelo teclado. */
  readOnly: boolean;
  onSelect: (id: string | undefined) => void;
  /** Ao soltar o arrasto (ou pelas setas), com a data já no dia útil. */
  onMove: (id: string, start: string) => void;
  /** Quando muda, rola a área para "hoje" ficar visível. */
  scrollToTodayToken?: number;
}

// ─── Utilitários ────────────────────────────────────────────────────────────────

const STYLE = `
.lob-block{transition:transform 220ms cubic-bezier(.2,.8,.2,1),opacity 150ms ease;outline:none}
.lob-block:hover .lob-base{fill-opacity:.62}
.lob-block:focus-visible .lob-base{stroke:var(--color-primary);stroke-width:2}
.lob-ghost{cursor:help}
.lob-ghost:hover{stroke-width:1.75}
.lob-off{opacity:.28}
.lob-off:hover,.lob-off:focus-visible{opacity:.8}
.lob-dragging{transition:none}
@media (prefers-reduced-motion:reduce){.lob-block{transition:none!important}}
`;
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const idAt = (target: EventTarget | null) => (target as Element | null)?.closest?.('[data-aid]')?.getAttribute('data-aid') ?? undefined;
/** O tracejado da linha de base sob o ponteiro (só onde nenhum bloco o cobre: os blocos ficam por cima). */
const ghostAt = (target: EventTarget | null) => (target as Element | null)?.closest?.('[data-gid]')?.getAttribute('data-gid') ?? undefined;
const escapeId = (id: string) => (typeof CSS !== 'undefined' && 'escape' in CSS ? CSS.escape(id) : id);
const percentText = (value: number) => `${String(Math.round(value * 10) / 10).replace('.', ',')}%`;
const sameSet = (a: ReadonlySet<string> | undefined, b: ReadonlySet<string> | undefined) => {
  if (a === b) return true;
  if (!a || !b || a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
};
const sameMap = (a: ReadonlyMap<string, number> | undefined, b: ReadonlyMap<string, number> | undefined) => {
  if (a === b) return true;
  if (!a || !b || a.size !== b.size) return false;
  for (const [id, value] of a) if (b.get(id) !== value) return false;
  return true;
};
const sameRecord = (a: Record<string, number>, b: Record<string, number>) => {
  if (a === b) return true;
  const ka = Object.keys(a),
    kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
};
const sameDates = (a: LobChartProps['measurementDates'], b: LobChartProps['measurementDates']) =>
  a === b || (a.length === b.length && a.every((m, i) => m.number === b[i].number && m.date === b[i].date));
const sameRange = (a: LobChartProps['range'], b: LobChartProps['range']) =>
  a === b || (!!a && !!b && a.start === b.start && a.end === b.end);

/** Devolve a mesma referência enquanto o valor for igual por conteúdo. O gráfico memoiza o layout
 * e as linhas por referência; se o contêiner recriar `percents` ou um `Set` a cada render, sem isto
 * cada passagem do mouse redesenharia os cinco mil blocos. Padrão oficial de estado derivado do
 * render anterior (setState condicional durante o render). */
function useStable<T>(value: T, equals: (a: T, b: T) => boolean): T {
  const [stable, setStable] = useState(value);
  if (!equals(stable, value)) {
    setStable(value);
    return value;
  }
  return stable;
}

// ─── Camadas estáticas (memo: não mudam com hover nem seleção) ──────────────────

/** Passo de zoom pela roda: quanto de `deltaY` acumulado vale um passo (um dente da roda do mouse
 * manda ~100; a pinça do trackpad, vários eventos pequenos). */
const WHEEL_STEP = 40;
/** Margem do rótulo dentro da célula do cabeçalho. */
const HEADER_PAD = 6;

/** Fundo com faixas alternadas por local, os dias sem trabalho grifados, cabeçalho do tempo em duas
 * faixas e a grade vertical. As células, as linhas e as faixas vêm prontas de `layout.header` e
 * `layout.offRuns` (semanas, meses ou trimestres, conforme a escala). */
const Axes = memo(function Axes({ layout }: { layout: LobLayout }) {
  const { left, top, innerW, innerH, rows, header, offRuns } = layout;
  const dayLabels = header.days.length > 0;
  const band = GEOMETRY.band;
  const bottomY = top + innerH;
  const textY = (y: number) => y + band / 2 + 3.5;
  return (
    <g aria-hidden="true">
      <rect x={left} y={top} width={innerW} height={innerH} fill={CHART.surfaceMuted} />
      {rows.map(r =>
        r.index % 2 === 0 ? (
          <rect key={`z${r.local.id}`} x={left} y={r.y} width={innerW} height={r.height} fill={CHART.surfaceAlt} />
        ) : null,
      )}
      {/* Dias sem trabalho (fins de semana, feriados e recessos do calendário da obra): por cima do
          fundo das linhas e por baixo da grade e dos blocos. */}
      {offRuns.map(run => (
        <rect key={`o${run.x}`} x={run.x} y={top} width={run.w} height={innerH} fill={OFF_DAY_FILL} fillOpacity={OFF_DAY_OPACITY} />
      ))}
      {rows.map(r => (
        <line key={`l${r.local.id}`} x1={left} x2={left + innerW} y1={r.y} y2={r.y} stroke={CHART.grid} strokeWidth={0.6} />
      ))}
      {header.lines.map(l => (
        <line
          key={l.x}
          x1={l.x}
          x2={l.x}
          y1={top}
          y2={bottomY}
          stroke={l.strong ? CHART.gridStrong : CHART.grid}
          strokeWidth={l.strong ? 1.5 : 1}
        />
      ))}
      {header.ticks.map(x => (
        <line key={x} x1={x} x2={x} y1={bottomY} y2={bottomY + 4} stroke={CHART.gridStrong} />
      ))}
      {/* Cabeçalho: faixa de cima (meses ou anos) e faixa de baixo (semanas, meses ou trimestres). */}
      <rect x={left} y={0} width={innerW} height={band} fill={CHART.surfaceAlt} />
      <rect x={left} y={band} width={innerW} height={band} fill={CHART.surfaceMuted} />
      {header.top.map(c => (
        <g key={c.x}>
          {c.x > left && <line x1={c.x} x2={c.x} y1={0} y2={top} stroke={CHART.gridStrong} strokeWidth={1.5} />}
          {c.label && (
            // O rótulo acompanha a rolagem dentro da célula (`placeHeader`): um mês ou um ano mais
            // largo que a tela não fica sem nome.
            <text
              x={c.x + HEADER_PAD}
              y={textY(0)}
              data-hx={c.x}
              data-hw={c.w}
              data-tw={c.label.length * 6.2}
              fontSize={10.5}
              fontWeight={700}
              fill={CHART.ink}
            >
              {c.label}
            </text>
          )}
        </g>
      ))}
      {header.bottom.map(c => (
        <g key={c.x}>
          {c.x > left && <line x1={c.x} x2={c.x} y1={band} y2={top} stroke={CHART.gridStrong} strokeWidth={c.strong ? 1.5 : 1} />}
          {c.label && !dayLabels && (
            // Semana: o número é o dia da segunda-feira, junto da linha dela. Mês e trimestre: no meio.
            <text
              x={header.scale === 'week' ? c.x + 4 : c.x + c.w / 2}
              y={textY(band)}
              textAnchor={header.scale === 'week' ? 'start' : 'middle'}
              fontSize={10}
              fontWeight={c.strong ? 700 : 500}
              fill={c.strong ? CHART.ink : CHART.inkMuted}
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {c.label}
            </text>
          )}
        </g>
      ))}
      {/* Dia largo (zoom "Semana"): o número de cada dia no lugar do número da semana; dia sem
          trabalho com o fundo grifado e o número esmaecido. */}
      {header.days.map(d => (
        <g key={`d${d.x}`}>
          {d.off && <rect x={d.x} y={band} width={d.w} height={band} fill={OFF_DAY_FILL} fillOpacity={OFF_DAY_OPACITY} />}
          <text
            x={d.x + d.w / 2}
            y={textY(band)}
            textAnchor="middle"
            fontSize={9}
            fontWeight={500}
            fill={CHART.inkMuted}
            fillOpacity={d.off ? 0.6 : 1}
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {d.label}
          </text>
        </g>
      ))}
      <line x1={left} x2={left + innerW} y1={band} y2={band} stroke={CHART.gridStrong} />
      <line x1={left} x2={left + innerW} y1={0.5} y2={0.5} stroke={CHART.gridStrong} />
      <line x1={left + innerW} x2={left + innerW} y1={0} y2={top} stroke={CHART.gridStrong} strokeWidth={1.5} />
    </g>
  );
});

/** Linhas verticais por cima dos blocos: medições (M1, M2…) e "Hoje"; mais a moldura. Sem eventos
 * de ponteiro, para não roubar o hover dos blocos que cruzam. */
const Markers = memo(function Markers({ layout, today }: { layout: LobLayout; today: LocalDate }) {
  const { left, top, innerW, innerH, todayX } = layout;
  const bottomY = top + innerH;
  return (
    <g pointerEvents="none" aria-hidden="true">
      {layout.measurements.map(m => {
        const w = 10 + 6 * m.label.length;
        return (
          <g key={`${m.label}-${m.x}`}>
            <line x1={m.x} x2={m.x} y1={top} y2={bottomY} stroke={CHART.link} strokeWidth={1.5} />
            <rect x={m.x - w / 2} y={top + 2} width={w} height={12} rx={3} fill={CHART.link} />
            <text x={m.x} y={top + 11} textAnchor="middle" fontSize={8.5} fontWeight={800} fill="#ffffff">
              {m.label}
            </text>
          </g>
        );
      })}
      {todayX !== undefined && (
        <g>
          <line x1={todayX} x2={todayX} y1={top} y2={bottomY} stroke={CHART.today} strokeWidth={1.75} strokeDasharray="4 3" />
          <rect x={todayX - 26} y={bottomY + 6} width={52} height={14} rx={4} fill={CHART.today} />
          <text x={todayX} y={bottomY + 16.5} textAnchor="middle" fontSize={9} fontWeight={800} fill="#ffffff">
            Hoje {shortDate(today)}
          </text>
        </g>
      )}
      <rect x={left} y={top} width={innerW} height={innerH} fill="none" stroke={CHART.gridStrong} strokeWidth={1.5} />
    </g>
  );
});

/** Linha de base: contorno tracejado cinza onde o bloco estava no snapshot. Fica POR BAIXO dos blocos
 * e responde ao ponteiro (dica própria, par destacado) só na parte que nenhum bloco cobre: assim o
 * tracejado nunca rouba o clique nem o arrasto de um bloco. Não tem `data-aid`: não se arrasta. */
const Ghosts = memo(function Ghosts({ ghosts }: { ghosts: LobLayout['ghosts'] }) {
  return (
    <g aria-hidden="true">
      {ghosts.map(g => (
        <rect
          key={g.activityId}
          data-gid={g.activityId}
          className="lob-ghost"
          x={g.x}
          y={g.y}
          width={g.w}
          height={g.h}
          rx={3}
          fill="transparent"
          pointerEvents="all"
          stroke={CHART.baseline}
          strokeWidth={1}
          strokeDasharray="3 2"
        />
      ))}
    </g>
  );
});

/** O par em destaque: o tracejado da linha de base reforçado e uma linha fina do término dele ao
 * término do bloco de hoje, para ver quem é de quem e para que lado foi o desvio. Por cima dos blocos
 * e sem eventos de ponteiro. */
function PairLink({ block, ghost }: { block: LobBlock; ghost: LobGhost }) {
  const days = block.deviation?.status === 'compared' ? block.deviation.finishDays : 0;
  const color = days > 0 ? DEVIATION_COLORS.late : days < 0 ? DEVIATION_COLORS.ahead : CHART.ink;
  const y = block.y + block.h / 2;
  const from = ghost.x + ghost.w,
    to = block.x + block.w;
  return (
    <g pointerEvents="none" aria-hidden="true">
      <rect
        x={ghost.x - 1}
        y={ghost.y - 1}
        width={ghost.w + 2}
        height={ghost.h + 2}
        rx={4}
        fill="none"
        stroke={CHART.ink}
        strokeWidth={1.75}
        strokeDasharray="4 2"
      />
      {Math.abs(to - from) >= 3 && (
        <>
          <line x1={from} x2={to} y1={y} y2={y} stroke={color} strokeWidth={1.5} />
          <circle cx={from} cy={y} r={2.5} fill={CHART.surface} stroke={color} strokeWidth={1.5} />
          <circle cx={to} cy={y} r={2.5} fill={color} />
        </>
      )}
    </g>
  );
}

/** Coluna fixa dos locais. É um segundo <svg> em `position: sticky`, por cima do gráfico: ao rolar,
 * os blocos passam por baixo dela. */
const LocalLabels = memo(function LocalLabels({ layout }: { layout: LobLayout }) {
  const { left, top, innerH, rows, height } = layout;
  return (
    <svg
      className="sticky left-0 top-0 z-[1] block"
      width={left}
      height={height}
      viewBox={`0 0 ${left} ${height}`}
      aria-hidden="true"
      style={{ fontFamily: 'inherit' }}
    >
      <rect width={left} height={height} fill={CHART.surface} />
      <text
        x={left - 8}
        y={top - GEOMETRY.band / 2 + 3.5}
        textAnchor="end"
        fontSize={9.5}
        fontWeight={700}
        letterSpacing=".08em"
        fill={CHART.inkMuted}
      >
        LOCAL
      </text>
      {rows.map(r => {
        const label = clip(r.local.name, 16);
        return (
          <text
            key={r.local.id}
            x={left - 8}
            y={r.y + r.height / 2 + 3.5}
            textAnchor="end"
            fontSize={10.5}
            fontWeight={500}
            fill={CHART.ink}
          >
            {label !== r.local.name && <title>{r.local.name}</title>}
            {label}
          </text>
        );
      })}
      <line x1={left - 0.75} x2={left - 0.75} y1={0} y2={top + innerH} stroke={CHART.gridStrong} strokeWidth={1.5} />
    </svg>
  );
});

// ─── Blocos ─────────────────────────────────────────────────────────────────────

interface RowBlocksProps {
  blocks: LobBlock[];
  percents: Record<string, number>;
  today: LocalDate;
  /** Calendário de dias úteis da obra, para o previsto e o atraso (referência estável). */
  calendar?: LobCalendar;
  /** Só vem preenchido na linha que contém o selecionado. */
  selectedId?: string;
  /** Blocos do caminho crítico (referência estável: é a mesma para todas as linhas). */
  critical?: ReadonlySet<string>;
  /** Caminho crítico ligado: esmaece quem está fora de `critical` e contorna quem está dentro. */
  criticalMode: boolean;
  /** Arrasto em curso: onde ficam os blocos desta linha que o movimento altera (o arrastado e as
   * sucessoras empurradas). Só vem preenchido nas linhas afetadas. */
  shifts?: ReadonlyMap<string, LobShift>;
  /** Selo do desvio contra a linha de base dentro do bloco (o zoom dá espaço). */
  badges: boolean;
  readOnly: boolean;
}
/** Uma linha só redesenha quando algo DELA muda: os blocos (comparados um a um, porque o layout é
 * refeito a cada alteração da obra), a seleção, o deslocamento do arrasto. É o que mantém o arrasto e
 * o "soltar" baratos numa obra de 600 blocos: as linhas que não foram tocadas ficam como estão. */
const sameRow = (a: RowBlocksProps, b: RowBlocksProps) =>
  a.percents === b.percents &&
  a.today === b.today &&
  a.calendar === b.calendar &&
  a.selectedId === b.selectedId &&
  a.critical === b.critical &&
  a.criticalMode === b.criticalMode &&
  a.badges === b.badges &&
  a.readOnly === b.readOnly &&
  sameShifts(a.shifts, b.shifts) &&
  sameBlocks(a.blocks, b.blocks);

/** Os blocos de um local. Memo por linha (`sameRow`): selecionar um bloco redesenha só a linha que o
 * contém, e arrastar redesenha só as linhas do bloco arrastado e das sucessoras que ele empurra. */
const RowBlocks = memo(function RowBlocks({
  blocks,
  percents,
  today,
  selectedId,
  critical,
  criticalMode,
  shifts,
  badges,
  readOnly,
  calendar,
}: RowBlocksProps) {
  const hint = readOnly ? '' : '. Arraste ou use as setas para mover';
  return (
    <>
      {blocks.map(b => {
        const a = b.activity;
        const measured = Math.min(100, percents[a.id] ?? 0);
        const planned = plannedPercent(a, today, calendar);
        const late = isLate(a, measured, today, calendar);
        const selected = a.id === selectedId;
        const isCritical = !!critical?.has(a.id);
        // Contornos de dentro para fora, sem um cobrir o outro: atraso, caminho crítico, seleção.
        const criticalRing = criticalMode && isCritical;
        const criticalOut = late ? 2.75 : 1;
        const selectedOut = criticalRing ? criticalOut + 2 : 2;
        // O selecionado não esmaece: o contorno da seleção precisa aparecer.
        const off = criticalMode && !isCritical && !selected;
        const shift = shifts?.get(a.id);
        const w = shift?.w ?? b.w;
        // Selo do desvio do término contra a linha de base, dentro do bloco e junto da borda direita;
        // some durante o arrasto (o número é o da data gravada) e quando o bloco é estreito demais.
        // No bloco estreito do zoom "Mês" entra o selo compacto ("+4", sem o "d").
        const badgeText = badges && !shift && b.h >= 12 ? deviationBadge(b.deviation) : '';
        const fitted = fitBadge(badgeText, w);
        const badge = fitted?.text ?? '';
        const badgeW = fitted?.width ?? 0;
        const badgeColor = badge.startsWith('+') ? DEVIATION_COLORS.late : DEVIATION_COLORS.ahead;
        // Faixa fina (serviços simultâneos no local): letra menor; abaixo de 10 px, só o bloco.
        const fontSize = b.h >= 16 ? 10.5 : 9;
        const room = badge ? w - badgeW - 4 : w;
        const label = room >= GEOMETRY.minLabelWidth && b.h >= 10 ? clip(b.service.name, labelChars(room)) : '';
        const deviation = b.deviation;
        const aria =
          `${b.service.name}, ${b.local.name}: ${formatDate(b.start)} a ${formatDate(b.finish)}, ${plural(a.durationDays, 'dia útil', 'dias úteis')}, ` +
          `previsto ${planned}%, medido ${percentText(measured)}` +
          (late ? `, atrasado ${plural(delayDays(a, measured, today, calendar), 'dia útil', 'dias úteis')}` : '') +
          (deviation?.status === 'compared'
            ? `, linha de base ${formatDate(deviation.baselineStart)} a ${formatDate(deviation.baselineFinish)}, desvio ${deviationText(deviation)}`
            : deviation
              ? `, ${deviationText(deviation)}`
              : '') +
          (isCritical ? ', caminho crítico' : '') +
          (selected ? ', selecionado' : '') +
          hint;
        return (
          <g
            key={a.id}
            data-aid={a.id}
            className={`lob-block${off ? ' lob-off' : ''}${shift ? ' lob-dragging' : ''}`}
            style={{
              transform: `translate(${b.x + (shift?.dx ?? 0)}px, ${b.y}px)`,
              cursor: readOnly ? 'pointer' : 'grab',
              touchAction: readOnly ? undefined : 'pan-y',
            }}
            role="button"
            tabIndex={selected ? 0 : -1}
            aria-label={aria}
          >
            <rect className="lob-base" width={w} height={b.h} rx={3} fill={b.service.color} fillOpacity={0.42} />
            {measured > 0 && <rect width={Math.max(1.5, (w * measured) / 100)} height={b.h} rx={3} fill={b.service.color} />}
            {late && (
              <rect x={-0.75} y={-0.75} width={w + 1.5} height={b.h + 1.5} rx={3.5} fill="none" stroke={CHART.late} strokeWidth={1.75} />
            )}
            {criticalRing && (
              <rect
                x={-criticalOut}
                y={-criticalOut}
                width={w + 2 * criticalOut}
                height={b.h + 2 * criticalOut}
                rx={3 + criticalOut}
                fill="none"
                stroke={CRITICAL_COLOR}
                strokeWidth={2}
              />
            )}
            {selected && (
              <rect
                x={-selectedOut}
                y={-selectedOut}
                width={w + 2 * selectedOut}
                height={b.h + 2 * selectedOut}
                rx={2.5 + selectedOut}
                fill="none"
                stroke={CHART.ink}
                strokeWidth={2}
              />
            )}
            {label && (
              <text
                x={5}
                y={b.h / 2 + fontSize / 3}
                fontSize={fontSize}
                fontWeight={600}
                fill={inkOn(b.service.color, measured >= 50 ? 1 : 0.42)}
                pointerEvents="none"
              >
                {label}
              </text>
            )}
            {badge && (
              <g pointerEvents="none">
                <rect
                  x={w - badgeW - 2}
                  y={(b.h - 11) / 2}
                  width={badgeW}
                  height={11}
                  rx={3}
                  fill="#ffffff"
                  stroke={badgeColor}
                  strokeWidth={1}
                />
                <text
                  x={w - 2 - badgeW / 2}
                  y={b.h / 2 + 3.2}
                  textAnchor="middle"
                  fontSize={9}
                  fontWeight={800}
                  fill={badgeColor}
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {badge}
                </text>
              </g>
            )}
          </g>
        );
      })}
    </>
  );
}, sameRow);

// ─── Componente ─────────────────────────────────────────────────────────────────

interface Drag {
  id: string;
  pointerId: number;
  x0: number;
  /** px do SVG por px da tela (1 enquanto o SVG não for escalado por CSS). */
  scale: number;
  moved: boolean;
  /** Dia sob o ponteiro, já em dia útil: o início PEDIDO. */
  date: LocalDate;
  /** O início que o bloco terá de fato: o pedido ou, se ele cair antes do fim das predecessoras, o mínimo. */
  start: LocalDate;
  /** Deslocamento do bloco e das sucessoras empurradas, por linha (de `dragShifts`). */
  shifts?: Map<string, Map<string, LobShift>>;
  /** Quantos blocos além do arrastado mudam de data. */
  followers: number;
}
/** Quem está sob o ponteiro: um bloco ou o tracejado da linha de base de um bloco. */
interface Hover {
  id: string;
  ghost: boolean;
}

export function LobChart(props: LobChartProps) {
  const { data, today, baseline, zoom, zoomScale = 1, onZoomStep, selectedId, readOnly, onSelect, onMove, scrollToTodayToken } = props;
  const fitToken = props.fitToken ?? 0;
  const percents = useStable(props.percents, sameRecord);
  const hiddenServiceIds = useStable(props.hiddenServiceIds, sameSet);
  const visibleLocalIds = useStable(props.visibleLocalIds, sameSet);
  const measurementDates = useStable(props.measurementDates, sameDates);
  const range = useStable(props.range, sameRange);
  const criticalIds = useStable(props.criticalIds, sameSet);
  const floatDays = useStable(props.floatDays, sameMap);
  /** Quem é crítico, para o contorno, o texto lido e o tooltip: o conjunto recebido ou, com o modo
   * desligado, quem tem folga zero. */
  const critical = useMemo(() => {
    if (criticalIds) return criticalIds;
    if (!floatDays) return undefined;
    const ids = new Set<string>();
    for (const [id, days] of floatDays) if (days <= 0) ids.add(id);
    return ids;
  }, [criticalIds, floatDays]);

  const clipId = `lob-clip-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const scrollRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<LobLayout | undefined>(undefined);
  /** Retângulo ao lado do qual a dica se encaixa: o bloco ativo ou o tracejado sob o ponteiro. */
  const activeRef = useRef<{ x: number; y: number; w: number; h: number } | undefined>(undefined);
  /** Planejador de movimentos do arrasto em curso: montado no primeiro movimento, descartado ao soltar. */
  const plannerRef = useRef<LobMovePlanner | undefined>(undefined);
  const scrollLeftRef = useRef(0);
  /** Bloco que deve receber o foco assim que a seleção chegar (clique ou setas). */
  const focusNextRef = useRef<string | undefined>(undefined);
  const justDraggedRef = useRef(false);
  const onZoomStepRef = useRef(onZoomStep);
  /** Onde o ponteiro estava (px a partir da borda esquerda da área) no último passo de zoom pela
   * roda: é esse ponto, e não o meio da tela, que fica parado quando a escala muda. */
  const anchorRef = useRef<{ x: number; at: number } | undefined>(undefined);

  const [availableWidth, setAvailableWidth] = useState(1100);
  const [hover, setHover] = useState<Hover | undefined>(undefined);
  const [drag, setDrag] = useState<Drag | null>(null);
  /** Escala congelada: a janela e os px por dia do último encaixe. Vale enquanto `fitKey` não muda. */
  const [pin, setPin] = useState<{ key: string; start: LocalDate; end: LocalDate; pxPerDay: number } | undefined>(undefined);

  const { locals, services, activities, dependencies, calendar } = data;
  // O encaixe é refeito quando a pessoa pede (zoom, ajuste fino, período, linha de base, largura da
  // tela, `fitToken`) ou quando a obra ganha ou perde blocos; mudar a DATA de um bloco não o refaz.
  const fitKey = [zoom, zoomScale, availableWidth, range?.start, range?.end, baseline?.id, activities.length, fitToken].join('|');
  const activePin = pin?.key === fitKey ? pin : undefined;
  const layout = useMemo(
    () =>
      lobLayout({
        data: { locals, services, activities, calendar },
        zoom,
        zoomScale,
        availableWidth,
        today,
        measurementDates,
        baseline,
        hiddenServiceIds,
        visibleLocalIds,
        range,
        pin: activePin,
      }),
    [
      locals,
      services,
      activities,
      calendar,
      zoom,
      zoomScale,
      availableWidth,
      today,
      measurementDates,
      baseline,
      hiddenServiceIds,
      visibleLocalIds,
      range,
      activePin,
    ],
  );
  // Guarda a escala do encaixe (estado derivado do render, como em `useStable`): no próximo render o
  // layout já sai congelado nela. Se um bloco saiu da janela, ela cresceu, e é a nova que fica guardada.
  if (!activePin || activePin.start !== layout.start || activePin.end !== layout.end || activePin.pxPerDay !== layout.pxPerDay)
    setPin({ key: fitKey, start: layout.start, end: layout.end, pxPerDay: layout.pxPerDay });
  const rowBlocks = useMemo(() => {
    const map = new Map<string, LobBlock[]>(layout.rows.map(r => [r.local.id, []]));
    for (const b of layout.blocks) map.get(b.local.id)?.push(b);
    return map;
  }, [layout]);
  const ghostById = useMemo(() => new Map(layout.ghosts.map(g => [g.activityId, g])), [layout]);
  /** serviço × posição da linha → bloco, para as setas para cima e para baixo. */
  const neighbors = useMemo(() => new Map(layout.blocks.map(b => [`${b.service.id}|${b.row.index}`, b])), [layout]);
  const summary = useMemo(() => {
    if (!layout.blocks.length) return 'Linha de Balanço sem blocos para mostrar.';
    let start = layout.blocks[0].start,
      finish = layout.blocks[0].finish;
    const serviceIds = new Set<string>();
    for (const b of layout.blocks) {
      serviceIds.add(b.service.id);
      if (b.start < start) start = b.start;
      if (b.finish > finish) finish = b.finish;
    }
    return `Linha de Balanço: ${plural(serviceIds.size, 'serviço', 'serviços')} em ${plural(layout.rows.length, 'local', 'locais')}, de ${formatDate(start)} a ${formatDate(finish)}.`;
  }, [layout]);
  const lastMeasurement = useMemo(
    () =>
      measurementDates.reduce<LobChartProps['measurementDates'][number] | undefined>(
        (best, m) => (!best || m.date > best.date ? m : best),
        undefined,
      ),
    [measurementDates],
  );

  const dragging = !!drag?.moved;
  const hovered = !dragging && hover && layout.blockById.has(hover.id) ? hover : undefined;
  const activeId = dragging ? undefined : (hovered?.id ?? selectedId);
  const activeBlock = activeId ? layout.blockById.get(activeId) : undefined;
  const selectedBlock = selectedId ? layout.blockById.get(selectedId) : undefined;
  /** O tracejado do bloco ativo, quando ele saiu do lugar em relação à linha de base. */
  const activeGhost = activeBlock ? ghostById.get(activeBlock.activity.id) : undefined;
  /** A dica fala do tracejado (e encosta nele) quando é ele que está sob o ponteiro. */
  const ghostTip = hovered?.ghost && activeGhost ? activeGhost : undefined;
  const shifts = drag?.moved ? drag.shifts : undefined;
  const badges = !!baseline && layout.pxPerDay >= DEVIATION_BADGE_MIN_PX;

  // Largura disponível: o zoom 'obra' encaixa o plano nela.
  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const observer = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width;
      if (w) setAvailableWidth(Math.round(w));
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  // Rótulos da faixa de cima do cabeçalho: acompanham a rolagem sem sair da própria célula.
  const placeHeader = useCallback(() => {
    const box = scrollRef.current,
      svg = svgRef.current,
      current = layoutRef.current;
    if (!box || !svg || !current) return;
    const viewLeft = box.scrollLeft + current.left + HEADER_PAD;
    for (const text of svg.querySelectorAll<SVGTextElement>('[data-hx]')) {
      const x = Number(text.dataset.hx) + HEADER_PAD;
      const last = Number(text.dataset.hx) + Number(text.dataset.hw) - Number(text.dataset.tw) - HEADER_PAD;
      text.setAttribute('x', String(Math.round(clamp(viewLeft, x, Math.max(x, last)))));
    }
  }, []);

  // Ao trocar a escala (zoom, ajuste fino ou largura), o instante que estava no meio da tela continua
  // no meio; no zoom pela roda, o que fica parado é o instante sob o ponteiro.
  useLayoutEffect(() => {
    const box = scrollRef.current,
      previous = layoutRef.current;
    if (box && previous && previous.pxPerDay !== layout.pxPerDay) {
      const anchor = anchorRef.current;
      anchorRef.current = undefined;
      const at = anchor && performance.now() - anchor.at < 600 ? Math.max(layout.left, anchor.x) : box.clientWidth / 2;
      const days = (scrollLeftRef.current + at - previous.left) / previous.pxPerDay - daysBetween(previous.start, layout.start);
      box.scrollLeft = Math.max(0, layout.left + days * layout.pxPerDay - at);
      scrollLeftRef.current = box.scrollLeft;
    }
    layoutRef.current = layout;
    placeHeader();
  }, [layout, placeHeader]);

  // Ctrl+roda, ⌘+roda e a pinça do trackpad (que chega como roda com Ctrl) pedem um passo de zoom.
  // Listener nativo não passivo: só assim o `preventDefault` segura o zoom da página inteira.
  useEffect(() => {
    onZoomStepRef.current = onZoomStep;
  }, [onZoomStep]);
  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    let sum = 0,
      last = 0;
    const onWheel = (e: WheelEvent) => {
      const step = onZoomStepRef.current;
      if (!step || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      if (e.timeStamp - last > 250) sum = 0;
      last = e.timeStamp;
      // deltaMode 1 = linhas (roda de mouse em alguns navegadores).
      sum += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      if (Math.abs(sum) < WHEEL_STEP) return;
      anchorRef.current = { x: e.clientX - box.getBoundingClientRect().left, at: performance.now() };
      step(sum < 0 ? 1 : -1);
      sum = 0;
    };
    box.addEventListener('wheel', onWheel, { passive: false });
    return () => box.removeEventListener('wheel', onWheel);
  }, []);

  // "Hoje" a ~35% da largura visível: na montagem e a cada mudança do token.
  useEffect(() => {
    const box = scrollRef.current,
      current = layoutRef.current;
    if (!box || !current || current.todayX === undefined) return;
    box.scrollLeft = Math.max(0, current.todayX - box.clientWidth * 0.35);
    scrollLeftRef.current = box.scrollLeft;
    placeHeader();
  }, [scrollToTodayToken, placeHeader]);

  // Tooltip: ao lado do bloco, à esquerda quando há espaço, senão à direita; nunca fora da área visível.
  const placeTooltip = useCallback(() => {
    const tip = tipRef.current,
      box = scrollRef.current,
      block = activeRef.current,
      current = layoutRef.current;
    if (!tip || !box || !block || !current) return;
    const viewW = box.clientWidth,
      tipW = tip.offsetWidth,
      tipH = tip.offsetHeight;
    const bx = block.x - box.scrollLeft;
    let left = bx - tipW - 10;
    if (left < current.left + 4) left = bx + block.w + 10;
    left = clamp(left, 4, Math.max(4, viewW - tipW - 4));
    const top = clamp(block.y + block.h / 2 - tipH / 2, 2, Math.max(2, current.height - tipH - 2));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }, []);
  useLayoutEffect(() => {
    activeRef.current = ghostTip ?? activeBlock;
    placeTooltip();
  }, [activeBlock, ghostTip, layout, placeTooltip]);

  // Foco no bloco recém-selecionado pelo gráfico; seleção vinda de fora (tabela) só garante que ele apareça.
  useEffect(() => {
    if (!selectedId) return;
    const current = layoutRef.current,
      box = scrollRef.current;
    const block = current?.blockById.get(selectedId);
    if (focusNextRef.current === selectedId) {
      focusNextRef.current = undefined;
      svgRef.current?.querySelector<SVGGElement>(`[data-aid="${escapeId(selectedId)}"]`)?.focus({ preventScroll: true });
      return;
    }
    if (!block || !box || !current) return;
    const viewLeft = box.scrollLeft + current.left,
      viewRight = box.scrollLeft + box.clientWidth;
    if (block.x < viewLeft || block.x + Math.min(block.w, 80) > viewRight) {
      box.scrollLeft = Math.max(0, block.x - box.clientWidth * 0.35);
      scrollLeftRef.current = box.scrollLeft;
    }
  }, [selectedId]);

  // ─── Ponteiro ───────────────────────────────────────────────────────────────
  function onPointerDown(e: PointerEvent<SVGSVGElement>) {
    // Um arrasto solto fora do SVG não gera click aqui; o próximo toque zera a marca para não engolir um clique.
    justDraggedRef.current = false;
    if (readOnly || e.button !== 0) return;
    const id = idAt(e.target);
    const block = id ? layout.blockById.get(id) : undefined;
    if (!block) return;
    const svg = e.currentTarget;
    svg.setPointerCapture(e.pointerId);
    const rect = svg.getBoundingClientRect();
    plannerRef.current = undefined;
    setDrag({
      id: block.activity.id,
      pointerId: e.pointerId,
      x0: e.clientX,
      scale: rect.width ? layout.width / rect.width : 1,
      moved: false,
      date: block.start,
      start: block.start,
      followers: 0,
    });
  }
  function onPointerMove(e: PointerEvent<SVGSVGElement>) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const block = layout.blockById.get(drag.id);
    if (!block) return;
    const dx = (e.clientX - drag.x0) * drag.scale;
    const moved = drag.moved || Math.abs(dx) >= 4;
    // O bloco encaixa no dia útil sob o ponteiro: fim de semana nunca é destino.
    const date = moved ? layout.dateAtX(block.x + dx) : block.start;
    if (moved === drag.moved && date === drag.date) return;
    // Só quando o dia muda: a mesma função do servidor diz onde o bloco e as sucessoras vão parar. A
    // rede (predecessoras, ordem, cascata da obra) é montada uma vez, no primeiro movimento do arrasto.
    const planner = (plannerRef.current ??= createMovePlanner(activities, dependencies, calendar));
    const changed = date === block.start ? [] : planner.move(drag.id, date);
    const own = changed.find(a => a.id === drag.id);
    setDrag({
      ...drag,
      moved,
      date,
      start: own?.start ?? block.start,
      shifts: dragShifts(layout, changed, calendar),
      followers: changed.length - (own ? 1 : 0),
    });
  }
  function onPointerUp(e: PointerEvent<SVGSVGElement>) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const block = layout.blockById.get(drag.id);
    if (block) {
      if (!drag.moved) {
        focusNextRef.current = drag.id;
        // O painel da atividade abre acima do gráfico e o empurra para baixo antes de o `click` chegar:
        // o clique cairia fora do bloco e desfaria a seleção. Quem selecionou foi este soltar.
        justDraggedRef.current = true;
        onSelect(drag.id);
      } else {
        justDraggedRef.current = true;
        // Quem recebe aplica o movimento na hora (mesma regra da prévia): o bloco e as sucessoras já
        // aparecem no lugar novo no mesmo desenho em que o arrasto termina, sem voltar nem deslizar.
        if (drag.start !== block.start) onMove(drag.id, drag.date);
      }
    }
    plannerRef.current = undefined;
    setDrag(null);
  }
  function onPointerCancel() {
    plannerRef.current = undefined;
    setDrag(null);
  }
  function onClick(e: MouseEvent<SVGSVGElement>) {
    if (justDraggedRef.current) {
      justDraggedRef.current = false;
      return;
    }
    const id = idAt(e.target);
    const ghostId = id ? undefined : ghostAt(e.target);
    if (ghostId && layout.blockById.has(ghostId)) {
      // Clicar no tracejado seleciona o bloco dele: é a forma de achar "de quem é" pelo teclado e no toque.
      focusNextRef.current = ghostId;
      onSelect(ghostId);
    } else if (!id) onSelect(undefined);
    else if (readOnly) {
      // Em modo edição o soltar do ponteiro já selecionou.
      focusNextRef.current = id;
      onSelect(id);
    }
  }
  function onPointerOver(e: PointerEvent<SVGSVGElement>) {
    if (drag) return;
    const id = idAt(e.target);
    const ghostId = id ? undefined : ghostAt(e.target);
    const next = id ? { id, ghost: false } : ghostId ? { id: ghostId, ghost: true } : undefined;
    if (next?.id !== hover?.id || next?.ghost !== hover?.ghost) setHover(next);
  }

  // ─── Teclado ────────────────────────────────────────────────────────────────
  function onSvgKeyDown(e: KeyboardEvent<SVGSVGElement>) {
    const id = (e.target as Element).getAttribute?.('data-aid');
    const block = id ? layout.blockById.get(id) : undefined;
    if (!id || !block) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(id);
    } else if (e.key === 'Escape') {
      onSelect(undefined);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (readOnly) return;
      e.preventDefault();
      // Shift anda uma semana útil (os dias trabalhados por semana no calendário da obra).
      const week = calendar?.weekdays.length ?? 5;
      onMove(id, addWorkdays(block.activity.start, (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? week : 1), calendar));
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      // Mesmo serviço no local de cima ou de baixo.
      const next = neighbors.get(`${block.service.id}|${block.row.index + (e.key === 'ArrowUp' ? 1 : -1)}`);
      if (!next) return;
      e.preventDefault();
      focusNextRef.current = next.activity.id;
      onSelect(next.activity.id);
    }
  }
  /** Com o foco na área, Enter entra no bloco selecionado ou, sem seleção, no mais perto de hoje.
   * As setas ficam livres para a rolagem nativa da área. As teclas + e − (com o foco na área ou num
   * bloco) pedem um passo de zoom; com Ctrl ou ⌘ ficam para o zoom do navegador. */
  function onRegionKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (onZoomStep && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === '+' || e.key === '=' || e.key === '-')) {
      e.preventDefault();
      onZoomStep(e.key === '-' ? -1 : 1);
      return;
    }
    if (e.target !== e.currentTarget || !layout.blocks.length || e.key !== 'Enter') return;
    e.preventDefault();
    const target =
      selectedBlock ??
      layout.blocks.reduce((best, b) => (Math.abs(daysBetween(b.start, today)) < Math.abs(daysBetween(best.start, today)) ? b : best));
    focusNextRef.current = target.activity.id;
    onSelect(target.activity.id);
  }

  // ─── Desenho ────────────────────────────────────────────────────────────────
  const dragHint = (() => {
    if (!drag?.moved) return null;
    const block = layout.blockById.get(drag.id);
    if (!block) return null;
    const dx = shifts?.get(block.local.id)?.get(drag.id)?.dx ?? 0;
    // O pedido caiu antes do fim das predecessoras: o bloco para no mínimo, e a dica diz por quê.
    const limited = drag.start > drag.date;
    const text =
      `Início ${weekdayDate(drag.start)}` +
      (limited ? ' · limite das predecessoras' : '') +
      (drag.followers ? ` · ${plural(drag.followers, 'bloco acompanha', 'blocos acompanham')}` : '');
    const w = text.length * 6.3 + 18;
    const x = clamp(block.x + dx, layout.left, Math.max(layout.left, layout.width - w - 4));
    const y = Math.max(20, block.y - 8);
    return (
      <g pointerEvents="none" aria-hidden="true">
        <rect x={x} y={y - 17} width={w} height={22} rx={6} fill={CHART.ink} />
        <text x={x + 9} y={y - 2} fontSize={11} fontWeight={600} fill="#ffffff">
          {text}
        </text>
      </g>
    );
  })();

  const tooltip = (() => {
    if (!activeBlock) return null;
    const a = activeBlock.activity;
    const measured = Math.min(100, percents[a.id] ?? 0);
    const planned = plannedPercent(a, today, calendar);
    const late = isLate(a, measured, today, calendar);
    const deviation = activeBlock.deviation;
    type Row = { label: string; value: string; tone?: 'danger' | 'success' };
    const deviationRow = (): Row | undefined =>
      deviation?.status === 'compared'
        ? {
            label: 'Desvio',
            value: deviationText(deviation),
            tone: deviation.finishDays > 0 ? 'danger' : deviation.finishDays < 0 ? 'success' : undefined,
          }
        : undefined;
    const rows: Row[] = [];
    if (ghostTip && deviation?.status === 'compared') {
      // Dica do tracejado: o que a linha de base previa para este bloco, e onde ele está hoje.
      rows.push({ label: 'Na linha de base', value: `${weekdayDate(ghostTip.start)} → ${weekdayDate(ghostTip.finish)}` });
      rows.push({ label: 'Duração na linha de base', value: plural(ghostTip.durationDays, 'dia útil', 'dias úteis') });
      rows.push({ label: 'Hoje', value: `${weekdayDate(activeBlock.start)} → ${weekdayDate(activeBlock.finish)}` });
      rows.push(deviationRow()!);
    } else {
      rows.push({ label: 'Início → término', value: `${weekdayDate(activeBlock.start)} → ${weekdayDate(activeBlock.finish)}` });
      rows.push({ label: 'Duração', value: plural(a.durationDays, 'dia útil', 'dias úteis') });
      if (deviation?.status === 'compared') {
        rows.push({ label: 'Linha de base', value: baselineDatesText(deviation, today) });
        rows.push(deviationRow()!);
      } else if (deviation) rows.push({ label: 'Linha de base', value: deviationText(deviation) });
      if (activeBlock.service.team) rows.push({ label: 'Equipe', value: activeBlock.service.team });
      rows.push({ label: 'Previsto até hoje', value: `${planned}%` });
      rows.push({
        label: lastMeasurement ? `Medido (M${lastMeasurement.number} · ${shortDate(lastMeasurement.date)})` : 'Medido',
        value: percentText(measured),
        tone: late ? 'danger' : undefined,
      });
      if (late)
        rows.push({ label: 'Atraso', value: plural(delayDays(a, measured, today, calendar), 'dia útil', 'dias úteis'), tone: 'danger' });
      const float = floatDays?.get(a.id);
      if (critical?.has(a.id)) rows.push({ label: 'Folga', value: 'crítico · sem folga' });
      else if (float !== undefined) rows.push({ label: 'Folga', value: plural(float, 'dia útil', 'dias úteis') });
      if (a.actualStart || a.actualFinish)
        rows.push({
          label: 'Real',
          value: `${a.actualStart ? shortDate(a.actualStart) : '…'} → ${a.actualFinish ? shortDate(a.actualFinish) : '…'}`,
        });
    }
    return (
      <div
        ref={tipRef}
        role="tooltip"
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0 z-20 w-[300px] rounded-xl border border-slate-300 bg-white px-3.5 py-3 text-xs shadow-card-hover"
      >
        <h4 className="flex items-center gap-2 text-[13px] font-bold text-slate-900">
          <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: activeBlock.service.color }} />
          <span className="min-w-0 truncate">
            {activeBlock.service.name} · {activeBlock.local.name}
          </span>
          {late && !ghostTip && (
            <span className="status ml-auto border-danger-ring bg-danger-soft text-danger before:bg-danger">atrasado</span>
          )}
        </h4>
        {ghostTip && baseline && <p className="mt-0.5 truncate text-slate-500">linha de base “{baseline.name}”</p>}
        <dl className="mt-1.5">
          {rows.map(r => (
            <div key={r.label} className="mt-1 flex justify-between gap-2.5 text-slate-500">
              <dt className="shrink-0">{r.label}</dt>
              <dd
                className={`text-right font-semibold tabular-nums ${r.tone === 'danger' ? 'text-danger' : r.tone === 'success' ? 'text-success' : 'text-slate-700'}`}
              >
                {r.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    );
  })();

  const empty = !layout.rows.length
    ? 'Nenhum local para mostrar: cadastre os locais da obra ou mude o filtro de locais.'
    : !layout.blocks.length
      ? 'Nenhum bloco para mostrar com os filtros atuais.'
      : '';

  return (
    <div className="relative">
      <div
        ref={scrollRef}
        className="relative overflow-x-auto custom-scrollbar"
        role="region"
        aria-label="Linha de Balanço"
        tabIndex={0}
        onScroll={e => {
          scrollLeftRef.current = e.currentTarget.scrollLeft;
          placeTooltip();
          placeHeader();
        }}
        onKeyDown={onRegionKeyDown}
      >
        <div className="relative" style={{ width: layout.width, height: layout.height }}>
          <svg
            ref={svgRef}
            className="absolute left-0 top-0 block"
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            role="group"
            aria-label={summary}
            style={{ fontFamily: 'inherit', cursor: dragging ? 'grabbing' : undefined }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onPointerOver={onPointerOver}
            onPointerLeave={() => setHover(undefined)}
            onClick={onClick}
            onKeyDown={onSvgKeyDown}
          >
            <style>{STYLE}</style>
            <defs>
              <clipPath id={clipId}>
                <rect x={layout.left - 3} y={layout.top - 3} width={layout.innerW + 6} height={layout.innerH + 6} />
              </clipPath>
            </defs>
            <Axes layout={layout} />
            <g clipPath={`url(#${clipId})`}>
              {layout.ghosts.length > 0 && <Ghosts ghosts={layout.ghosts} />}
              {/* A chave remonta os blocos quando a escala muda: sem isso, 5 mil blocos animariam ao trocar o zoom. */}
              <g key={`${layout.pxPerDay}|${layout.start}`}>
                {layout.rows.map(row => (
                  <RowBlocks
                    key={row.local.id}
                    blocks={rowBlocks.get(row.local.id) ?? []}
                    percents={percents}
                    today={today}
                    selectedId={selectedBlock?.local.id === row.local.id ? selectedId : undefined}
                    critical={critical}
                    criticalMode={!!criticalIds}
                    shifts={shifts?.get(row.local.id)}
                    badges={badges}
                    readOnly={readOnly}
                    calendar={calendar}
                  />
                ))}
              </g>
              {activeBlock && activeGhost && <PairLink block={activeBlock} ghost={activeGhost} />}
            </g>
            <Markers layout={layout} today={today} />
            {dragHint}
          </svg>
          <LocalLabels layout={layout} />
        </div>
      </div>
      {tooltip}
      {baseline && !empty && (
        <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500" data-tour="longo-lob-legenda-linha-base">
          <svg width={26} height={12} aria-hidden="true" className="shrink-0">
            <rect x={1} y={1} width={24} height={10} rx={3} fill="none" stroke={CHART.baseline} strokeWidth={1.25} strokeDasharray="3 2" />
          </svg>
          <span>
            tracejado = onde o bloco estava na linha de base <b className="font-semibold text-slate-700">“{baseline.name}”</b>
            {layout.ghosts.length ? '' : ' (nenhum bloco visível saiu do lugar)'}
          </span>
          <span aria-hidden="true">·</span>
          {badges ? (
            <span>
              selo no bloco = desvio do término em dias úteis (<b style={{ color: DEVIATION_COLORS.late }}>+ atrasado</b>,{' '}
              <b style={{ color: DEVIATION_COLORS.ahead }}>− adiantado</b>)
            </span>
          ) : (
            <span>aproxime o zoom (Mês ou Semana) para ver o selo do desvio em cada bloco</span>
          )}
          <span aria-hidden="true">·</span>
          <span>passe o mouse no bloco ou no tracejado para ver as datas e o desvio</span>
        </p>
      )}
      {empty && <p className="callout callout-info mt-3">{empty}</p>}
    </div>
  );
}

// ─── Legenda ────────────────────────────────────────────────────────────────────

/** Chips dos serviços: quadrado da cor, nome e "N d/local" (a duração mais comum entre os blocos do
 * serviço, quando `activities` é informado). Oculto fica esmaecido e riscado; o botão é um toggle
 * (`aria-pressed` = visível). */
export function LobLegend({
  services,
  hidden,
  onToggle,
  activities,
}: {
  services: LobService[];
  hidden: ReadonlySet<string>;
  onToggle: (serviceId: string) => void;
  /** Blocos da obra, só para a duração típica de cada serviço; sem eles o chip mostra só o nome. */
  activities?: LobActivity[];
}) {
  const ordered = useMemo(
    () => [...services].sort((a, b) => a.orderIndex - b.orderIndex || a.name.localeCompare(b.name, 'pt-BR')),
    [services],
  );
  const durations = useMemo(() => (activities ? typicalDurations(activities) : new Map<string, number>()), [activities]);
  if (!ordered.length) return <></>;
  return (
    <div
      role="group"
      aria-label="Serviços da Linha de Balanço"
      className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3"
    >
      {ordered.map(s => {
        const off = hidden.has(s.id);
        const duration = durations.get(s.id);
        return (
          <button
            key={s.id}
            type="button"
            aria-pressed={!off}
            title={off ? `Mostrar ${s.name}` : `Ocultar ${s.name}`}
            onClick={() => onToggle(s.id)}
            className={`inline-flex h-7 items-center gap-2 rounded-full border border-slate-200 bg-white pl-2 pr-2.5 text-xs font-semibold text-slate-700 transition-colors hover:border-brand-300 hover:bg-brand-50 ${off ? 'opacity-40 line-through' : ''}`}
          >
            <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: s.color }} aria-hidden="true" />
            {s.name}
            {duration !== undefined && <small className="font-medium tabular-nums text-slate-400">{duration} d/local</small>}
          </button>
        );
      })}
      <span className="ml-auto self-center text-xs text-slate-500">Clique num serviço para ocultar ou mostrar.</span>
    </div>
  );
}

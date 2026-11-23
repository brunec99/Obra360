'use client';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { LocalDate } from '@/domain/lob';
import type { LobCurveMonth } from '@/domain/lob-curve';
import { CHART } from '@/shared/palette';
import { formatDate } from '@/shared/format';

/** Os dois gráficos da visão "Curva S" (23/11/2026): a curva do avanço acumulado e as barras do
 * progresso mensal. SVG próprio, desenhado na largura medida do quadro (o texto não encolhe com a
 * tela) e com `viewBox`, para a impressão reduzir o desenho à largura do papel. Os dois usam as
 * mesmas margens e a mesma faixa por mês, então os meses ficam alinhados um embaixo do outro.
 *
 * Cada série tem uma segunda marca além da cor: a linha de base é tracejada, o realizado tem um
 * ponto em cada medição e o previsto é a linha lisa. A tabela da tela traz os mesmos números. */

export const SERIES = {
  baseline: { label: 'Linha de base', color: CHART.baseline },
  planned: { label: 'Previsto', color: CHART.planned },
  real: { label: 'Realizado', color: CHART.executed },
} as const;

const MONTHS_SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
/** "out/26" a partir de "2026-10". */
export const monthShort = (month: string) => `${MONTHS_SHORT[Number(month.slice(5, 7)) - 1] ?? month}/${month.slice(2, 4)}`;
/** "outubro de 2026" a partir de "2026-10". */
export const monthLong = (month: string) =>
  new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`));
/** "21,2%": uma casa fixa, como nos cartões da Linha de Balanço. */
export const pct = (value: number) => `${value.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
/** "+3,2 pp" / "−3,2 pp" / "0,0 pp": diferença em pontos percentuais, pelo número mostrado. */
export function points(value: number) {
  const shown = Math.round(Math.abs(value) * 10) / 10;
  const sign = shown === 0 ? '' : value > 0 ? '+' : '−';
  return `${sign}${shown.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} pp`;
}

const LEFT = 46,
  RIGHT = 16,
  TOP = 24,
  BOTTOM = 28;
/** Largura mínima de um mês: abaixo disso o quadro rola de lado em vez de espremer. */
const MIN_BAND = 22;
const FONT = 10.5;

/** Largura do quadro em pixels, acompanhando o redimensionamento. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(880);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const read = () =>
      setWidth(current => (node.clientWidth > 0 && Math.abs(node.clientWidth - current) >= 1 ? node.clientWidth : current));
    read();
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** A geometria comum: uma faixa por mês entre as margens. */
function frame(containerWidth: number, months: number, height: number) {
  const width = Math.max(containerWidth, LEFT + RIGHT + months * MIN_BAND);
  const plotW = width - LEFT - RIGHT;
  const band = plotW / Math.max(1, months);
  return { width, height, plotW, plotH: height - TOP - BOTTOM, band, bottom: height - BOTTOM };
}
type Frame = ReturnType<typeof frame>;

/** Posição de "hoje" no eixo: dentro da faixa do mês, na proporção do dia; fora do eixo, nada. */
function todayX(months: readonly LobCurveMonth[], today: LocalDate, f: Frame) {
  const index = months.findIndex(m => m.month === today.slice(0, 7));
  if (index < 0) return undefined;
  const days = Number(months[index].end.slice(8, 10));
  return LEFT + f.band * (index + Math.min(1, Number(today.slice(8, 10)) / days));
}

/** O mês sob o ponteiro e as setas do teclado (← → percorrem, Esc fecha). */
function useActiveMonth(count: number, f: Frame) {
  const [active, setActive] = useState<number>();
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (!box.width) return;
    const x = ((event.clientX - box.left) / box.width) * f.width;
    const index = Math.floor((x - LEFT) / f.band);
    setActive(index >= 0 && index < count ? index : undefined);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') return setActive(undefined);
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = event.key === 'ArrowRight' ? 1 : -1;
    setActive(current => Math.min(count - 1, Math.max(0, current === undefined ? (step > 0 ? 0 : count - 1) : current + step)));
  };
  return { active, onPointerMove, onPointerLeave: () => setActive(undefined), onKeyDown, onBlur: () => setActive(undefined) };
}

function XAxis({ months, f }: { months: readonly LobCurveMonth[]; f: Frame }) {
  // "out/26" ocupa uns 36 px: com faixa estreita, mostra um rótulo a cada tantos meses.
  const every = Math.max(1, Math.ceil(38 / f.band));
  return (
    <>
      <line x1={LEFT} x2={f.width - RIGHT} y1={f.bottom} y2={f.bottom} stroke={CHART.gridStrong} />
      {months.map((m, i) => (
        <g key={m.month}>
          <line x1={LEFT + f.band * (i + 1)} x2={LEFT + f.band * (i + 1)} y1={f.bottom} y2={f.bottom + 3} stroke={CHART.gridStrong} />
          {i % every === 0 && (
            <text x={LEFT + f.band * (i + 0.5)} y={f.bottom + 16} textAnchor="middle" fontSize={FONT} fill={CHART.inkMuted}>
              {monthShort(m.month)}
            </text>
          )}
        </g>
      ))}
    </>
  );
}

function TodayMark({ x, f, label = true }: { x: number | undefined; f: Frame; label?: boolean }) {
  if (x === undefined) return null;
  const flip = x > f.width - RIGHT - 34;
  return (
    <>
      <line x1={x} x2={x} y1={TOP - 12} y2={f.bottom} stroke={CHART.today} strokeWidth={1.5} strokeDasharray="4 3" />
      {label && (
        <text x={x + (flip ? -5 : 5)} y={TOP - 4} textAnchor={flip ? 'end' : 'start'} fontSize={FONT} fontWeight={700} fill={CHART.today}>
          hoje
        </text>
      )}
    </>
  );
}

/** A dica do mês: um quadro HTML sobre o gráfico, do lado em que cabe. */
function Tip({ x, f, children }: { x: number; f: Frame; children: ReactNode }) {
  const right = x > f.width / 2;
  return (
    <div
      role="status"
      className="pointer-events-none absolute top-2 z-10 w-60 rounded-lg border border-slate-200 bg-white/95 p-2.5 text-xs text-slate-700 shadow-lg print:hidden"
      style={right ? { right: `${Math.max(0, f.width - x + 10)}px` } : { left: `${x + 10}px` }}
    >
      {children}
    </div>
  );
}
function TipRow({ swatch, label, value, note }: { swatch: ReactNode; label: string; value: string; note?: string }) {
  return (
    <p className="mt-1 flex items-baseline gap-1.5">
      <span className="flex w-5 shrink-0 items-center self-center">{swatch}</span>
      <span className="flex-1 text-slate-600">
        {label}
        {note && <span className="block text-[11px] leading-4 text-slate-500">{note}</span>}
      </span>
      <b className="self-start text-slate-900 tabular-nums">{value}</b>
    </p>
  );
}

/** As marcas da legenda e da dica: um traço (tracejado para a linha de base, com ponto para o realizado) ou um quadrado. */
export function Swatch({ series, shape }: { series: keyof typeof SERIES | 'today'; shape: 'line' | 'bar' }) {
  const color = series === 'today' ? CHART.today : SERIES[series].color;
  if (shape === 'bar')
    return (
      <svg width={12} height={12} aria-hidden className="shrink-0">
        <rect x={1} y={1} width={10} height={10} rx={2} fill={color} />
      </svg>
    );
  return (
    <svg width={20} height={10} aria-hidden className="shrink-0">
      <line
        x1={0}
        x2={20}
        y1={5}
        y2={5}
        stroke={color}
        strokeWidth={series === 'today' ? 1.5 : 2}
        strokeDasharray={series === 'baseline' ? '5 3' : series === 'today' ? '4 3' : undefined}
      />
      {series === 'real' && <circle cx={10} cy={5} r={3.5} fill={color} stroke={CHART.surface} strokeWidth={1.5} />}
    </svg>
  );
}
export function Legend({ items }: { items: { series: keyof typeof SERIES | 'today'; shape: 'line' | 'bar'; text: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
      {items.map(item => (
        <li key={item.series} className="flex items-center gap-1.5">
          <Swatch series={item.series} shape={item.shape} />
          {item.text}
        </li>
      ))}
    </ul>
  );
}

// ─── Curva S ────────────────────────────────────────────────────────────────────

const pathOf = (list: { x: number; y: number }[]) => list.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');

/** Curva S do avanço acumulado. O ponto de cada mês fica no fim da faixa do mês (o acumulado é o do
 * último dia); as curvas da linha de base e do previsto partem de 0% no começo do eixo. O realizado
 * do mês em andamento para na linha de "hoje", para a curva não avançar sobre o futuro. */
export function CurveChart({ months, today, hasBaseline }: { months: readonly LobCurveMonth[]; today: LocalDate; hasBaseline: boolean }) {
  const [ref, containerWidth] = useWidth();
  const f = frame(containerWidth, months.length, 320);
  const hover = useActiveMonth(months.length, f);
  const xEnd = (i: number) => LEFT + f.band * (i + 1);
  const y = (value: number) => TOP + f.plotH * (1 - Math.min(100, Math.max(0, value)) / 100);
  const nowX = todayX(months, today, f);
  const realX = (i: number) => (nowX !== undefined && months[i].month === today.slice(0, 7) ? Math.min(xEnd(i), nowX) : xEnd(i));

  const origin = { x: LEFT, y: y(0) };
  const plannedPath = pathOf([origin, ...months.map((m, i) => ({ x: xEnd(i), y: y(m.planned) }))]);
  const baselinePath = hasBaseline ? pathOf([origin, ...months.map((m, i) => ({ x: xEnd(i), y: y(m.baseline ?? 0) }))]) : undefined;
  const realPoints = months.flatMap((m, i) => (m.real !== undefined ? [{ i, x: realX(i), y: y(m.real), month: m }] : []));
  const lastReal = realPoints[realPoints.length - 1];
  const active = hover.active !== undefined ? months[hover.active] : undefined;
  const activeX = hover.active !== undefined ? xEnd(hover.active) : 0;
  const labelLeft = lastReal ? lastReal.x > f.width - RIGHT - 110 : false;
  const labelBelow = lastReal ? (lastReal.month.real ?? 0) <= lastReal.month.planned : false;

  return (
    <div
      ref={ref}
      tabIndex={0}
      role="group"
      aria-label="Curva S do avanço acumulado. Use as setas esquerda e direita para percorrer os meses; a tabela abaixo traz os mesmos números."
      onKeyDown={hover.onKeyDown}
      onBlur={hover.onBlur}
      className="custom-scrollbar overflow-x-auto rounded-lg focus-visible:ring-2 focus-visible:ring-primary-ring focus-visible:outline-none print:overflow-visible"
    >
      <div className="relative" style={{ minWidth: `${f.width}px` }}>
        <svg
          viewBox={`0 0 ${f.width} ${f.height}`}
          width="100%"
          role="img"
          aria-label={`Curva S: ${hasBaseline ? 'linha de base, ' : ''}previsto e realizado acumulados por mês, de ${monthLong(months[0].month)} a ${monthLong(months[months.length - 1].month)}`}
          className="block touch-pan-x select-none"
          onPointerMove={hover.onPointerMove}
          onPointerDown={hover.onPointerMove}
          onPointerLeave={hover.onPointerLeave}
        >
          {active && <rect x={activeX - f.band} y={TOP} width={f.band} height={f.plotH} fill={CHART.surfaceAlt} />}
          {[0, 25, 50, 75, 100].map(mark => (
            <g key={mark}>
              {mark > 0 && <line x1={LEFT} x2={f.width - RIGHT} y1={y(mark)} y2={y(mark)} stroke={CHART.grid} />}
              <text x={LEFT - 7} y={y(mark) + 3.5} textAnchor="end" fontSize={FONT} fill={CHART.inkMuted}>
                {mark}%
              </text>
            </g>
          ))}
          <XAxis months={months} f={f} />
          <TodayMark x={nowX} f={f} />
          {baselinePath && (
            <path
              d={baselinePath}
              fill="none"
              stroke={SERIES.baseline.color}
              strokeWidth={2}
              strokeDasharray="6 4"
              strokeLinejoin="round"
            />
          )}
          <path d={plannedPath} fill="none" stroke={SERIES.planned.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {realPoints.length > 1 && (
            <path
              d={pathOf(realPoints)}
              fill="none"
              stroke={SERIES.real.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}
          {/* Um ponto por mês com medição nova; o mês que só repete a medição anterior fica sem ponto. */}
          {realPoints
            .filter(p => !p.month.realCarried)
            .map(p => (
              <circle key={p.month.month} cx={p.x} cy={p.y} r={4} fill={SERIES.real.color} stroke={CHART.surface} strokeWidth={1.5} />
            ))}
          {lastReal && (
            <text
              x={lastReal.x + (labelLeft ? -8 : 8)}
              y={lastReal.y + (labelBelow ? 15 : -9)}
              textAnchor={labelLeft ? 'end' : 'start'}
              fontSize={FONT + 0.5}
              fontWeight={700}
              fill={CHART.ink}
              stroke={CHART.surface}
              strokeWidth={3}
              paintOrder="stroke"
            >
              realizado {pct(lastReal.month.real ?? 0)}
            </text>
          )}
          {active && hover.active !== undefined && (
            <g pointerEvents="none">
              <line x1={activeX} x2={activeX} y1={TOP} y2={f.bottom} stroke={CHART.ink} strokeWidth={1} opacity={0.55} />
              {active.baseline !== undefined && (
                <circle cx={activeX} cy={y(active.baseline)} r={4.5} fill={SERIES.baseline.color} stroke={CHART.surface} strokeWidth={2} />
              )}
              <circle cx={activeX} cy={y(active.planned)} r={4.5} fill={SERIES.planned.color} stroke={CHART.surface} strokeWidth={2} />
              {active.real !== undefined && (
                <circle
                  cx={realX(hover.active)}
                  cy={y(active.real)}
                  r={4.5}
                  fill={SERIES.real.color}
                  stroke={CHART.surface}
                  strokeWidth={2}
                />
              )}
            </g>
          )}
        </svg>
        {active && (
          <Tip x={activeX} f={f}>
            <p className="font-bold text-slate-900 first-letter:uppercase">{monthLong(active.month)}</p>
            <p className="text-[11px] text-slate-500">Acumulado até {formatDate(active.end)}</p>
            {active.baseline !== undefined && (
              <TipRow swatch={<Swatch series="baseline" shape="line" />} label={SERIES.baseline.label} value={pct(active.baseline)} />
            )}
            <TipRow swatch={<Swatch series="planned" shape="line" />} label={SERIES.planned.label} value={pct(active.planned)} />
            <TipRow
              swatch={<Swatch series="real" shape="line" />}
              label={SERIES.real.label}
              value={active.real !== undefined ? pct(active.real) : '—'}
              note={
                active.real === undefined || !active.realFrom
                  ? active.month > today.slice(0, 7)
                    ? 'mês futuro'
                    : 'sem medição até o mês'
                  : active.realCarried
                    ? `sem medição no mês: repete a nº ${active.realFrom.number}, de ${formatDate(active.realFrom.date)}`
                    : `medição nº ${active.realFrom.number}, de ${formatDate(active.realFrom.date)}`
              }
            />
            {active.real !== undefined && (
              <p className="mt-1.5 border-t border-slate-100 pt-1.5 text-slate-600">
                Desvio (realizado − previsto): <b className="text-slate-900 tabular-nums">{points(active.real - active.planned)}</b>
                {active.end > today && (
                  <span className="block text-[11px] leading-4 text-slate-500">Mês em andamento: o previsto é o do fim do mês.</span>
                )}
              </p>
            )}
          </Tip>
        )}
      </div>
    </div>
  );
}

// ─── Progresso mensal ───────────────────────────────────────────────────────────

/** Teto "redondo" do eixo (1, 2, 2,5 ou 5 × potência de dez) e o passo das quatro marcas. */
export function niceCeiling(max: number) {
  if (!(max > 0)) return 4;
  const power = 10 ** Math.floor(Math.log10(max / 4));
  const step = [1, 2, 2.5, 5, 10].map(k => k * power).find(s => s * 4 >= max - 1e-9) ?? 10 * power;
  return step * 4;
}
/** Barra de base reta e topo arredondado. */
function barPath(x: number, top: number, width: number, bottom: number) {
  const r = Math.min(3, width / 2, Math.max(0, bottom - top));
  return `M${x} ${bottom}V${top + r}Q${x} ${top} ${x + r} ${top}H${x + width - r}Q${x + width} ${top} ${x + width} ${top + r}V${bottom}Z`;
}

/** Progresso mensal: o ganho de cada série no mês, em barras lado a lado na faixa do mês. */
export function MonthlyChart({
  months,
  today,
  hasBaseline,
  hasReal,
}: {
  months: readonly LobCurveMonth[];
  today: LocalDate;
  hasBaseline: boolean;
  hasReal: boolean;
}) {
  const [ref, containerWidth] = useWidth();
  const f = frame(containerWidth, months.length, 250);
  const hover = useActiveMonth(months.length, f);
  const series = [
    ...(hasBaseline ? [{ key: 'baseline' as const, gain: (m: LobCurveMonth) => m.baselineGain }] : []),
    { key: 'planned' as const, gain: (m: LobCurveMonth) => m.plannedGain as number | undefined },
    ...(hasReal ? [{ key: 'real' as const, gain: (m: LobCurveMonth) => m.realGain }] : []),
  ];
  const top = niceCeiling(Math.max(0, ...months.flatMap(m => series.map(s => s.gain(m) ?? 0))));
  const y = (value: number) => TOP + f.plotH * (1 - Math.min(top, Math.max(0, value)) / top);
  // Barras com 2 px de respiro entre si (1 px quando o mês é estreito), ocupando até 78% da faixa.
  const gap = f.band < 30 ? 1 : 2;
  const barW = Math.min(30, Math.max(2, (f.band * 0.78 - gap * (series.length - 1)) / series.length));
  const groupW = barW * series.length + gap * (series.length - 1);
  const labeled = barW >= 28;
  const active = hover.active !== undefined ? months[hover.active] : undefined;
  const tick = (value: number) => `${value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;

  return (
    <div
      ref={ref}
      tabIndex={0}
      role="group"
      aria-label="Progresso mensal. Use as setas esquerda e direita para percorrer os meses; a tabela abaixo traz os mesmos números."
      onKeyDown={hover.onKeyDown}
      onBlur={hover.onBlur}
      className="custom-scrollbar overflow-x-auto rounded-lg focus-visible:ring-2 focus-visible:ring-primary-ring focus-visible:outline-none print:overflow-visible"
    >
      <div className="relative" style={{ minWidth: `${f.width}px` }}>
        <svg
          viewBox={`0 0 ${f.width} ${f.height}`}
          width="100%"
          role="img"
          aria-label={`Progresso mensal: ganho de ${series.map(s => SERIES[s.key].label.toLowerCase()).join(', ')} em cada mês`}
          className="block touch-pan-x select-none"
          onPointerMove={hover.onPointerMove}
          onPointerDown={hover.onPointerMove}
          onPointerLeave={hover.onPointerLeave}
        >
          {hover.active !== undefined && (
            <rect x={LEFT + f.band * hover.active} y={TOP} width={f.band} height={f.plotH} fill={CHART.surfaceAlt} />
          )}
          {[0, 1, 2, 3, 4].map(k => {
            const mark = (top * k) / 4;
            return (
              <g key={k}>
                {k > 0 && <line x1={LEFT} x2={f.width - RIGHT} y1={y(mark)} y2={y(mark)} stroke={CHART.grid} />}
                <text x={LEFT - 7} y={y(mark) + 3.5} textAnchor="end" fontSize={FONT} fill={CHART.inkMuted}>
                  {tick(mark)}
                </text>
              </g>
            );
          })}
          <TodayMark x={todayX(months, today, f)} f={f} label={false} />
          {months.map((m, i) => {
            const x0 = LEFT + f.band * i + (f.band - groupW) / 2;
            return (
              <g key={m.month}>
                {series.map((s, k) => {
                  const gain = s.gain(m);
                  if (gain === undefined) return null;
                  const x = x0 + k * (barW + gap);
                  // Ganho positivo sempre aparece: no mínimo 1,5 px de barra.
                  const barTop = gain > 0 ? Math.min(y(gain), f.bottom - 1.5) : f.bottom;
                  return (
                    <g key={s.key}>
                      {gain > 0 && <path d={barPath(x, barTop, barW, f.bottom)} fill={SERIES[s.key].color} />}
                      {labeled && gain > 0 && (
                        <text x={x + barW / 2} y={barTop - 4} textAnchor="middle" fontSize={FONT - 1} fill={CHART.ink}>
                          {pct(gain)}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })}
          <XAxis months={months} f={f} />
        </svg>
        {active && hover.active !== undefined && (
          <Tip x={LEFT + f.band * (hover.active + 0.5)} f={f}>
            <p className="font-bold text-slate-900 first-letter:uppercase">{monthLong(active.month)}</p>
            <p className="text-[11px] text-slate-500">Ganho no mês</p>
            {series.map(s => {
              const gain = s.gain(active);
              return (
                <TipRow
                  key={s.key}
                  swatch={<Swatch series={s.key} shape="bar" />}
                  label={SERIES[s.key].label}
                  value={gain !== undefined ? pct(gain) : '—'}
                  note={
                    s.key !== 'real'
                      ? undefined
                      : gain === undefined
                        ? active.month > today.slice(0, 7)
                          ? 'mês futuro'
                          : 'sem medição até o mês'
                        : active.realCarried
                          ? 'sem medição no mês'
                          : undefined
                  }
                />
              );
            })}
          </Tip>
        )}
      </div>
    </div>
  );
}

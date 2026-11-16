'use client';
import type { WorkCalendar } from '@/domain/plan-schedule';
import { CHART } from '@/shared/palette';
import type { GanttRow } from './gantt-chart';
import {
  BAND_H,
  CHART_W,
  DRAFT_H,
  FOOT_H,
  GAP,
  HEAD_H,
  META_H,
  PRINT_COLUMNS,
  PRINT_MARGIN_MM,
  PRINT_PAPER,
  ROW_H,
  SHEET_H,
  SHEET_W,
  TABLE_W,
  labelSide,
  mixWhite,
  offDayRuns,
  paginate,
  printBar,
  printScale,
  printX,
  rowsPerSheet,
  type PrintColumn,
} from './print-layout';

/** As folhas do botão "Imprimir" do cronograma (modelo aprovado em 16/11/2026, em A3 deitada). A tela
 * (`schedule-sheet.tsx`) monta as linhas com o que está nela — rascunho, filtro, grupos recolhidos,
 * linha de base e "Caminho crítico" — e põe este componente direto no <body> enquanto imprime. Na
 * impressão, o resto da página some e só as folhas saem; na tela, elas nunca aparecem. */

export const PRINT_LOGOS = ['/logo-atr.png', '/logo-takt.png'];

export interface PrintRow {
  key: string;
  /** -1 é a linha 0 (resumo do cronograma inteiro). */
  level: number;
  cells: Record<PrintColumn, string>;
  /** Alterada no rascunho: faixa amarela à esquerda (regra 7). */
  changed?: boolean;
  bar: GanttRow;
}

export interface PrintScheduleProps {
  title: string;
  subtitle: string;
  /** "Impresso em 16/11/2026 às 14:32". */
  printedAt: string;
  printedBy?: string;
  /** "24 tarefas · avanço do plano 31% · …". */
  summary: string;
  /** "Filtro: nenhum · todos os grupos abertos". */
  filter: string;
  /** Tarefas alteradas ou excluídas que ainda não estão no sistema; 0 ou ausente, sem faixa. */
  draftCount?: number;
  /** "Obra 360 · Médio prazo". */
  footer: string;
  rows: PrintRow[];
  window: { start: string; end: string };
  today: string;
  calendar: Pick<WorkCalendar, 'weekdays' | 'holidays'>;
  showCritical: boolean;
  showBaseline: boolean;
  showResources: boolean;
}

const INK = '#1f2f3d';
const MUTED = '#59738a';
/** O resumo é o colchete preto do Project, no preto petróleo da escala (`--color-slate-900`). */
const SUMMARY = '#0d1f2b';
const PLANNED_LIGHT = mixWhite(CHART.planned, 28);
const CRITICAL_LIGHT = mixWhite(CHART.late, 28);
const CHANGED = '#e0a100';

const CSS = `
@page { size: ${PRINT_PAPER}; margin: ${PRINT_MARGIN_MM}mm; }
.mp-print-root { display: none; }
@media print {
  html, body { height: auto !important; min-height: 0 !important; overflow: visible !important; background: #fff !important; }
  body > *:not(.mp-print-root) { display: none !important; }
  .mp-print-root { display: block; }
}
.mp-print-root, .mp-print-root * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.mp-print-root { font-family: Arial, Helvetica, sans-serif; color: ${INK}; background: #fff; }
.mp-sheet { width: ${SHEET_W}px; height: ${SHEET_H}px; overflow: hidden; display: flex; flex-direction: column; gap: ${GAP}px; break-after: page; page-break-after: always; }
.mp-sheet:last-child { break-after: auto; page-break-after: auto; }
.mp-band { height: ${BAND_H}px; flex: none; display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 16px; background: #1a719f; color: #fff; border-radius: 3px; padding: 0 12px; }
.mp-logos { display: inline-flex; align-items: center; gap: 10px; background: #fff; border-radius: 6px; padding: 4px 10px; }
.mp-logos img { height: 28px; width: auto; display: block; }
.mp-logos img.mp-takt { height: 38px; margin: -5px -8px; }
.mp-logos i { width: 1px; height: 26px; background: #cbd5e1; }
.mp-title { display: grid; gap: 3px; text-align: center; min-width: 0; }
.mp-title b { font-size: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mp-title span { font-size: 12px; opacity: .92; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mp-stamp { text-align: right; font-size: 11.5px; line-height: 1.45; white-space: nowrap; }
.mp-meta { height: ${META_H}px; flex: none; display: flex; justify-content: space-between; gap: 16px; font-size: 11.5px; line-height: ${META_H}px; color: ${MUTED}; padding: 0 2px; white-space: nowrap; overflow: hidden; }
.mp-meta b { color: ${INK}; font-weight: 700; }
.mp-draft { height: ${DRAFT_H}px; flex: none; background: #fff4d6; color: #7a4b00; border: 1px solid #f0d58c; border-radius: 3px; font-size: 11.5px; line-height: ${DRAFT_H - 2}px; padding: 0 10px; white-space: nowrap; overflow: hidden; }
.mp-body { flex: none; display: flex; border: 1px solid #c4d3df; }
.mp-grid { width: ${TABLE_W}px; flex: none; border-collapse: collapse; table-layout: fixed; font-size: 10.5px; align-self: flex-start; }
.mp-grid th { height: ${HEAD_H}px; background: #f1f5f8; font-weight: 700; text-align: left; line-height: 1.15; border-right: 1px solid #c4d3df; border-bottom: 1px solid #c4d3df; padding: 0 5px; }
.mp-grid td { height: ${ROW_H}px; border-right: 1px solid #dce6ee; border-bottom: 1px solid #dce6ee; padding: 0 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.mp-grid .mp-r { text-align: right; }
.mp-grid tr.mp-sum td { font-weight: 700; }
.mp-grid tr.mp-plan td { font-weight: 700; background: #f7f9fb; }
.mp-grid tr.mp-changed td:first-child { box-shadow: inset 4px 0 0 ${CHANGED}; }
.mp-chart { border-left: 1px solid #c4d3df; flex: none; display: block; }
.mp-foot { height: ${FOOT_H}px; flex: none; display: flex; justify-content: space-between; align-items: center; gap: 16px; font-size: 10.5px; color: ${MUTED}; padding: 0 2px; white-space: nowrap; }
.mp-legend { display: flex; gap: 14px; align-items: center; }
.mp-legend span { display: inline-flex; align-items: center; gap: 5px; }
.mp-sw { display: inline-block; width: 22px; height: 9px; border-radius: 1px; }
`;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function PrintSchedule(props: PrintScheduleProps) {
  const draft = (props.draftCount ?? 0) > 0;
  const perSheet = rowsPerSheet(draft);
  const sheets = paginate(props.rows, perSheet);
  const scale = printScale(props.window, CHART_W);
  const offRuns = offDayRuns(scale, props.calendar);
  const chartH = HEAD_H + perSheet * ROW_H;
  return (
    <div className="mp-print-root" data-testid="impressao-cronograma">
      <style>{CSS}</style>
      {sheets.map((chunk, index) => (
        <section key={index} className="mp-sheet" aria-label={`Folha ${index + 1} de ${sheets.length}`}>
          <header className="mp-band">
            <span className="mp-logos">
              {/* eslint-disable-next-line @next/next/no-img-element -- impressão: a imagem precisa estar no DOM, sem o carregamento preguiçoso do next/image */}
              <img src={PRINT_LOGOS[0]} alt="ATR Incorporadora" />
              <i aria-hidden />
              {/* eslint-disable-next-line @next/next/no-img-element -- idem */}
              <img src={PRINT_LOGOS[1]} alt="Takt Engenharia" className="mp-takt" />
            </span>
            <div className="mp-title">
              <b>{props.title}</b>
              <span>{props.subtitle}</span>
            </div>
            <div className="mp-stamp">
              {props.printedAt}
              {props.printedBy && (
                <>
                  <br />
                  por {props.printedBy}
                </>
              )}
            </div>
          </header>
          <div className="mp-meta">
            <span>{props.summary}</span>
            <span>{props.filter}</span>
          </div>
          {draft && (
            <div className="mp-draft">
              <b>Rascunho não salvo:</b> {plural(props.draftCount!, 'tarefa alterada ainda não está', 'tarefas alteradas ainda não estão')}{' '}
              no sistema ({props.draftCount === 1 ? 'marcada' : 'marcadas'} com a faixa amarela à esquerda).
            </div>
          )}
          <div className="mp-body" style={{ height: chartH + 2 }}>
            <table className="mp-grid">
              <colgroup>
                {PRINT_COLUMNS.map(c => (
                  <col key={c.key} style={{ width: c.width }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  {PRINT_COLUMNS.map(c => (
                    <th key={c.key} className={'right' in c ? 'mp-r' : undefined}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {chunk.map(row => (
                  <tr
                    key={row.key}
                    className={[row.level < 0 ? 'mp-plan' : row.bar.summary ? 'mp-sum' : '', row.changed ? 'mp-changed' : '']
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {PRINT_COLUMNS.map(c => (
                      <td
                        key={c.key}
                        className={'right' in c ? 'mp-r' : undefined}
                        style={c.key === 'name' ? { paddingLeft: 5 + Math.max(0, row.level) * 12 } : undefined}
                      >
                        {row.cells[c.key]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <ChartSheet
              rows={chunk}
              height={chartH}
              scale={scale}
              offRuns={offRuns}
              today={props.today}
              showCritical={props.showCritical}
              showBaseline={props.showBaseline}
              showResources={props.showResources}
            />
          </div>
          <footer className="mp-foot">
            <Legend showCritical={props.showCritical} showBaseline={props.showBaseline} draft={draft} />
            <span>
              {props.footer} · Folha {index + 1} de {sheets.length}
            </span>
          </footer>
        </section>
      ))}
    </div>
  );
}

function ChartSheet({
  rows,
  height,
  scale,
  offRuns,
  today,
  showCritical,
  showBaseline,
  showResources,
}: {
  rows: PrintRow[];
  height: number;
  scale: ReturnType<typeof printScale>;
  offRuns: ReturnType<typeof offDayRuns>;
} & Pick<PrintScheduleProps, 'today' | 'showCritical' | 'showBaseline' | 'showResources'>) {
  const width = CHART_W;
  const half = HEAD_H / 2;
  const todayX = today >= scale.start && today <= scale.end ? printX(scale, today) + scale.px / 2 : null;
  const text = { fontFamily: 'Arial, Helvetica, sans-serif' };
  return (
    <svg className="mp-chart" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-label="Gráfico de Gantt">
      {/* O <svg> corta o que passa da borda: barra e nome além da janela não invadem a tabela. */}
      <g>
        {offRuns.map(r => (
          <rect key={r.x} x={r.x} y={HEAD_H} width={r.width} height={height - HEAD_H} fill="rgba(142,164,183,0.18)" />
        ))}
        {scale.bottom.map(c => (
          <line key={`g${c.x}`} x1={c.x} y1={half} x2={c.x} y2={height} stroke="#e6edf3" />
        ))}
        {scale.top.map(c => (
          <line key={`t${c.x}`} x1={c.x} y1={0} x2={c.x} y2={height} stroke="#c4d3df" />
        ))}
        <rect x={0} y={0} width={width} height={HEAD_H} fill="#f1f5f8" />
        <line x1={0} y1={half} x2={width} y2={half} stroke="#dce6ee" />
        <line x1={0} y1={HEAD_H - 0.5} x2={width} y2={HEAD_H - 0.5} stroke="#c4d3df" />
        {scale.top.map(c => (
          <g key={`tl${c.x}`}>
            {c.x > 0 && <line x1={c.x} y1={0} x2={c.x} y2={HEAD_H} stroke="#c4d3df" />}
            <text x={c.x + c.width / 2} y={13} fontSize={11} fontWeight={700} textAnchor="middle" fill={INK} style={text}>
              {c.label}
            </text>
          </g>
        ))}
        {scale.bottom.map(c => (
          <g key={`bl${c.x}`}>
            <line x1={c.x} y1={half} x2={c.x} y2={HEAD_H} stroke="#dce6ee" />
            <text x={c.x + 3} y={HEAD_H - 6} fontSize={9.5} fill={MUTED} style={text}>
              {c.label}
            </text>
          </g>
        ))}
        {rows.map((row, i) => {
          const y = HEAD_H + i * ROW_H;
          const bar = row.bar;
          const span = printBar(scale, width, bar);
          const critical = showCritical && !!bar.critical && !bar.summary;
          const edge = critical ? CHART.late : CHART.planned;
          const fill = critical ? CRITICAL_LIGHT : PLANNED_LIGHT;
          const base =
            showBaseline && bar.baseStart && bar.baseEnd ? printBar(scale, width, { start: bar.baseStart, end: bar.baseEnd }) : null;
          const barTop = base ? y + 4 : y + 5;
          const barH = base ? 10 : 12;
          const label = showResources && !bar.summary ? bar.resourceLabel : undefined;
          return (
            <g key={row.key}>
              <line x1={0} y1={y + ROW_H - 0.5} x2={width} y2={y + ROW_H - 0.5} stroke="#eef3f7" />
              {base &&
                (bar.milestone ? (
                  <path d={`M${printX(scale, bar.baseStart!) + scale.px / 2} ${y + 13}l4 4 -4 4 -4 -4Z`} fill={CHART.baseline} />
                ) : (
                  <rect x={base.left} y={y + 16} width={base.right - base.left} height={3.5} fill={CHART.baseline} />
                ))}
              {span &&
                (bar.summary ? (
                  <g fill={SUMMARY}>
                    <rect x={span.left} y={barTop + 1} width={span.right - span.left} height={4} />
                    <path d={`M${span.left} ${barTop + 1}h5v7Z`} />
                    <path d={`M${span.right} ${barTop + 1}h-5v7Z`} />
                  </g>
                ) : bar.milestone ? (
                  (() => {
                    const cx = printX(scale, bar.start) + scale.px / 2;
                    const day = `${bar.start.slice(8, 10)}/${bar.start.slice(5, 7)}`;
                    const side = labelSide(cx - 7, cx + 7, day, width);
                    return (
                      <>
                        <path d={`M${cx} ${barTop - 1}l7 7 -7 7 -7 -7Z`} fill={critical ? CHART.late : SUMMARY} />
                        <text
                          x={side === 'right' ? cx + 10 : cx - 10}
                          y={barTop + 10}
                          textAnchor={side === 'right' ? 'start' : 'end'}
                          fontSize={9.5}
                          fill={INK}
                          style={text}
                        >
                          {day}
                        </text>
                      </>
                    );
                  })()
                ) : (
                  <>
                    <rect
                      x={span.left}
                      y={barTop}
                      width={span.right - span.left}
                      height={barH}
                      rx={1.5}
                      fill={fill}
                      stroke={edge}
                      strokeWidth={1}
                    />
                    {bar.progress > 0 && (
                      <rect
                        x={span.left}
                        y={barTop}
                        width={((span.right - span.left) * Math.min(100, bar.progress)) / 100}
                        height={barH}
                        rx={1.5}
                        fill={edge}
                      />
                    )}
                  </>
                ))}
              {span &&
                label &&
                !bar.milestone &&
                (() => {
                  const side = labelSide(span.left, span.right, label, width);
                  return (
                    <text
                      x={side === 'right' ? span.right + 4 : span.left - 4}
                      y={barTop + barH - 2}
                      textAnchor={side === 'right' ? 'start' : 'end'}
                      fontSize={9.5}
                      fontWeight={700}
                      fill={INK}
                      style={text}
                    >
                      {label}
                    </text>
                  );
                })()}
            </g>
          );
        })}
        {todayX !== null && (
          <>
            <line x1={todayX} y1={HEAD_H} x2={todayX} y2={height} stroke={CHART.today} strokeWidth={1.5} />
            <rect x={todayX - 1} y={HEAD_H - 6} width={2} height={6} fill={CHART.today} />
          </>
        )}
      </g>
    </svg>
  );
}

function Legend({ showCritical, showBaseline, draft }: { showCritical: boolean; showBaseline: boolean; draft: boolean }) {
  return (
    <div className="mp-legend">
      <span>
        <i className="mp-sw" style={{ background: PLANNED_LIGHT, border: `1px solid ${CHART.planned}` }} />
        Tarefa
      </span>
      <span>
        <i
          className="mp-sw"
          style={{ background: `linear-gradient(90deg, ${CHART.planned} 55%, ${PLANNED_LIGHT} 55%)`, border: `1px solid ${CHART.planned}` }}
        />
        Avanço
      </span>
      {showCritical && (
        <span>
          <i className="mp-sw" style={{ background: CRITICAL_LIGHT, border: `1px solid ${CHART.late}` }} />
          Crítica
        </span>
      )}
      <span>
        <i className="mp-sw" style={{ background: SUMMARY, height: 4 }} />
        Resumo
      </span>
      <span>
        <svg width={11} height={11} viewBox="0 0 10 10" aria-hidden>
          <path d="M5 0 10 5 5 10 0 5Z" fill={SUMMARY} />
        </svg>
        Marco
      </span>
      {showBaseline && (
        <span>
          <i className="mp-sw" style={{ background: CHART.baseline, height: 4 }} />
          Linha de base
        </span>
      )}
      <span>
        <i className="mp-sw" style={{ background: CHART.today, width: 2, height: 12 }} />
        Hoje
      </span>
      <span>
        <i className="mp-sw" style={{ background: 'rgba(142,164,183,0.18)', border: '1px solid #dce6ee' }} />
        Sem trabalho
      </span>
      {draft && (
        <span>
          <i className="mp-sw" style={{ background: CHANGED, width: 4, height: 12 }} />
          Alterada no rascunho
        </span>
      )}
    </div>
  );
}

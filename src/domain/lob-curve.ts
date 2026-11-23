/** Curva S e progresso mensal da Linha de Balanço (23/11/2026, retorno do Atmos: "no Prevision
 * tínhamos os gráficos de curva S e progresso mensal"). Tudo puro, a partir de `LobData`.
 *
 * Regras:
 *  1. Uma linha por mês, do mês do primeiro início ao mês do último término, olhando o cronograma
 *     atual e a linha de base escolhida; o eixo se estende para caber toda medição fechada.
 *  2. O acumulado de cada mês é o do último dia do mês (inclusive), mesmo que caia num fim de semana.
 *  3. Linha de base e previsto usam os mesmos blocos (os atuais) e o mesmo peso do IDP (`lobWeights`):
 *     o previsto pelas datas atuais; a linha de base pelas datas guardadas, e pelas atuais no bloco
 *     criado depois dela (como o planejado do IDP).
 *  4. A linha de base é a escolhida; sem escolha, a manual mais recente (`performanceBaseline`); sem
 *     nenhuma, a série da linha de base não existe.
 *  5. Realizado do mês = avanço físico pela última medição fechada com data até o fim do mês. Antes
 *     da primeira medição não há realizado; depois do mês de hoje também não. Mês passado sem medição
 *     nova repete o último valor (`realCarried`) e tem ganho zero.
 *  6. Ganho mensal = acumulado do mês − acumulado do mês anterior; o que não existe conta como zero,
 *     então o primeiro mês medido leva tudo o que foi realizado até ali.
 *  7. A medição aberta não entra (como no IDP).
 *
 * Desempenho: o início e o fim de cada bloco são calculados uma vez por série; por mês, só o bloco
 * que está no meio da execução no último dia do mês passa pela conta de dias úteis. */
import {
  activityEnd,
  activityFinish,
  closedMeasurements,
  physicalProgress,
  plannedPercent,
  type LobActivity,
  type LobBaseline,
  type LobBaselineEntry,
  type LobData,
  type LobId,
  type LobMeasurementItem,
  type LocalDate,
} from './lob';
import type { LobCalendar } from './lob-calendar';
import { lobWeights, performanceBaseline, type LobWeights } from './lob-performance';

export interface LobCurveMeasurement {
  measurementId: LobId;
  number: number;
  date: LocalDate;
  /** % físico real da obra com as medições fechadas até esta, no peso vigente. */
  real: number;
}
export interface LobCurveMonth {
  /** "AAAA-MM". */
  month: string;
  /** Último dia do mês: a data do acumulado. */
  end: LocalDate;
  /** % acumulado da linha de base no fim do mês; ausente sem linha de base. */
  baseline?: number;
  /** % acumulado previsto (cronograma atual) no fim do mês. */
  planned: number;
  /** % acumulado realizado no fim do mês (regra 5); ausente antes da primeira medição e nos meses futuros. */
  real?: number;
  /** A medição de onde saiu o realizado do mês. */
  realFrom?: LobCurveMeasurement;
  /** Verdadeiro quando nenhuma medição fechou neste mês: o realizado repete o da medição anterior. */
  realCarried?: boolean;
  baselineGain?: number;
  plannedGain: number;
  realGain?: number;
}
export interface LobCurve {
  status: 'no-blocks' | 'ok';
  weights: LobWeights;
  /** A linha de base da curva (regra 4); ausente = só previsto e realizado. */
  baseline?: Pick<LobBaseline, 'id' | 'name' | 'automatic' | 'createdAt'>;
  months: LobCurveMonth[];
  /** As medições fechadas, da mais antiga à mais nova, com o realizado de cada uma. */
  measurements: LobCurveMeasurement[];
  /** Os três números na data da última medição fechada: `real` e `baseline` são os do cartão do IDP. */
  last?: LobCurveMeasurement & { planned: number; baseline?: number };
}
type CurveData = Pick<LobData, 'services' | 'activities' | 'baselines' | 'measurements' | 'items' | 'costs' | 'calendar'>;
type Dated = Pick<LobActivity, 'start' | 'durationDays'>;

// ─── Dias úteis: o único ponto do arquivo que chama as funções de calendário ────
// O calendário da obra (`data.calendar`) entra só nas três chamadas abaixo (`activityEnd`,
// `activityFinish` e `plannedPercent`), do mesmo jeito que em `plannedPercents`, para a curva bater
// com o planejado do IDP: a linha de base usa o início e a duração guardados, no calendário atual.

interface Span {
  weight: number;
  dated: Dated;
  start: LocalDate;
  /** Primeiro dia útil depois do bloco: a partir dele o bloco está em 100%. */
  end: LocalDate;
  /** Último dia trabalhado. */
  finish: LocalDate;
}
const spanOf = (dated: Dated, weight: number, calendar?: LobCalendar): Span => ({
  weight,
  dated,
  start: dated.start,
  end: activityEnd(dated, calendar),
  finish: activityFinish(dated, calendar),
});
/** Previsto (%) do bloco na data, com o mesmo arredondamento de `plannedPercent`; antes do início e
 * depois do fim não refaz a conta de dias úteis. */
const percentAt = (span: Span, date: LocalDate, calendar?: LobCalendar) =>
  date < span.start ? 0 : date >= span.end ? 100 : plannedPercent(span.dated, date, calendar);

// ─── Meses ──────────────────────────────────────────────────────────────────────

const monthOf = (date: LocalDate) => date.slice(0, 7);
const lastDayOf = (month: string): LocalDate => {
  const [year, m] = month.split('-').map(Number);
  return new Date(Date.UTC(year, m, 0)).toISOString().slice(0, 10);
};
function monthsFrom(first: string, last: string): string[] {
  const out: string[] = [];
  let [year, month] = first.split('-').map(Number);
  for (;;) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    out.push(key);
    if (key >= last || out.length >= 600) return out;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
}

// ─── Curva ──────────────────────────────────────────────────────────────────────

/** Avanço ponderado (%) de uma série de blocos na data. */
function progressAt(spans: readonly Span[], total: number, date: LocalDate, calendar?: LobCalendar) {
  let done = 0;
  for (const span of spans) if (span.weight && date >= span.start) done += span.weight * percentAt(span, date, calendar);
  return done / total;
}

/** O realizado da obra depois de cada medição fechada, acumulando os valores rodada a rodada (o mesmo
 * que `measuredPercents` + `physicalProgress` devolvem para cada uma, sem refazer do zero). */
function measuredSeries(data: CurveData, weights: ReadonlyMap<LobId, number>): LobCurveMeasurement[] {
  const byMeasurement = new Map<LobId, LobMeasurementItem[]>();
  for (const item of data.items) {
    const list = byMeasurement.get(item.measurementId);
    if (list) list.push(item);
    else byMeasurement.set(item.measurementId, [item]);
  }
  const percents: Record<LobId, number> = {};
  return closedMeasurements(data.measurements).map(m => {
    for (const item of byMeasurement.get(m.id) ?? []) percents[item.activityId] = item.value;
    return { measurementId: m.id, number: m.number, date: m.date, real: physicalProgress(data.activities, percents, weights) ?? 0 };
  });
}

/** A série mensal da obra. `baselineId` é a linha de base escolhida na tela (vazio cai na regra 4);
 * `today` limita o realizado (regra 5). */
export function lobCurve(data: CurveData, options: { baselineId?: LobId; today: LocalDate }): LobCurve {
  const weights = lobWeights(data.services, data.activities, data.costs);
  const chosen = performanceBaseline(data.baselines, options.baselineId);
  const baseline = chosen ? { id: chosen.id, name: chosen.name, automatic: chosen.automatic, createdAt: chosen.createdAt } : undefined;
  const head = { weights, ...(baseline ? { baseline } : {}) };
  const weightOf = (id: LobId) => weights.weight.get(id) ?? 0;
  const total = data.activities.reduce((sum, a) => sum + weightOf(a.id), 0);
  if (!data.activities.length || !(total > 0)) return { status: 'no-blocks', ...head, months: [], measurements: [] };

  const { calendar } = data;
  const current = data.activities.map(a => spanOf(a, weightOf(a.id), calendar));
  const frozen = new Map<LobId, LobBaselineEntry>((chosen?.snapshot ?? []).map(e => [e.activityId, e]));
  // Bloco fora da linha de base (criado depois) reaproveita o intervalo atual, já calculado.
  const base = chosen
    ? data.activities.map((a, index) => {
        const entry = frozen.get(a.id);
        return entry ? spanOf(entry, weightOf(a.id), calendar) : current[index];
      })
    : undefined;
  const measurements = measuredSeries(data, weights.weight);

  let first = current[0].start,
    last = current[0].finish;
  for (const span of [...current, ...(base ?? [])]) {
    if (span.start < first) first = span.start;
    if (span.finish > last) last = span.finish;
  }
  for (const m of measurements) {
    if (m.date < first) first = m.date;
    if (m.date > last) last = m.date;
  }

  const lastMeasured = measurements[measurements.length - 1];
  // Até que mês existe realizado: o de hoje (ou o da última medição, se o relógio estiver atrás dela).
  const realUntil =
    lastMeasured && monthOf(lastMeasured.date) > monthOf(options.today) ? monthOf(lastMeasured.date) : monthOf(options.today);
  const months: LobCurveMonth[] = [];
  let cursor = 0; // quantas medições têm data até o fim do mês corrente do laço
  let previous: LobCurveMonth | undefined;
  for (const month of monthsFrom(monthOf(first), monthOf(last))) {
    const end = lastDayOf(month);
    const before = cursor;
    while (cursor < measurements.length && measurements[cursor].date <= end) cursor++;
    const realFrom = cursor > 0 && month <= realUntil ? measurements[cursor - 1] : undefined;
    const planned = progressAt(current, total, end, calendar);
    const baseValue = base ? progressAt(base, total, end, calendar) : undefined;
    const row: LobCurveMonth = {
      month,
      end,
      ...(baseValue !== undefined ? { baseline: baseValue, baselineGain: baseValue - (previous?.baseline ?? 0) } : {}),
      planned,
      plannedGain: planned - (previous?.planned ?? 0),
      ...(realFrom
        ? {
            real: realFrom.real,
            realFrom,
            realGain: realFrom.real - (previous?.real ?? 0),
            ...(cursor === before ? { realCarried: true } : {}),
          }
        : {}),
    };
    months.push(row);
    previous = row;
  }

  return {
    status: 'ok',
    ...head,
    months,
    measurements,
    ...(lastMeasured
      ? {
          last: {
            ...lastMeasured,
            planned: progressAt(current, total, lastMeasured.date, calendar),
            ...(base ? { baseline: progressAt(base, total, lastMeasured.date, calendar) } : {}),
          },
        }
      : {}),
  };
}

/** "ponderado pelo custo dos pacotes" ou o motivo de estar na duração, para a linha do critério. */
export const curveWeightingText = (weights: LobWeights) =>
  weights.mode === 'cost'
    ? 'ponderado pelo custo dos pacotes'
    : weights.fallback === 'zero'
      ? 'ponderado pela duração, porque os custos apropriados somam zero'
      : weights.fallback === 'missing'
        ? 'ponderado pela duração, porque há pacotes sem custo'
        : 'ponderado pela duração';

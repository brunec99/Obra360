import test from 'node:test';
import assert from 'node:assert/strict';
import {
  measuredPercents,
  physicalProgress,
  type LobActivity,
  type LobBaseline,
  type LobCostItem,
  type LobMeasurement,
  type LobMeasurementItem,
  type LobService,
} from '../src/domain/lob';
import { lobPerformance, plannedPercents } from '../src/domain/lob-performance';
import { curveWeightingText, lobCurve } from '../src/domain/lob-curve';

/** Curva S da Linha de Balanço (23/11/2026). Obra pequena, de outubro a dezembro de 2026:
 *  - a1 (pacote A): 10 dias úteis de 19/10 a 30/10;
 *  - a2 (pacote A): 10 dias úteis de 02/11 a 13/11;
 *  - b1 (pacote B): 20 dias úteis de 16/11 a 11/12 (em 30/11 tem 11 dias: 55%).
 * Pela duração (10 + 10 + 20 = 40): out 25%, nov (1000 + 1000 + 1100) ÷ 40 = 77,5%, dez 100%.
 * Pelo custo (A = 900, B = 100): out 45%, nov 95,5%, dez 100%.
 * Linha de base "LB": a1 começava em 21/09 (8 dias até 30/09: 80%), a2 em 19/10 e b1 em 02/11 (até 27/11).
 * Pela duração: set 20%, out 50%, nov 100%, dez 100%.
 * Medições: nº 1 em 30/10 (a1 80% → 20%) e nº 2 em 04/12 (a1 100, a2 50, b1 10 → 42,5%). */

const NOW = '2026-11-23T12:00:00.000Z';
const W = 'obra-1';

const service = (id: string, orderIndex: number): LobService => ({
  id,
  workId: W,
  name: `Pacote ${id}`,
  color: '#1a719f',
  orderIndex,
  createdAt: NOW,
  updatedAt: NOW,
});
const act = (id: string, serviceId: string, start: string, durationDays: number): LobActivity => ({
  id,
  workId: W,
  serviceId,
  localId: `l-${id}`,
  start,
  durationDays,
  createdAt: NOW,
  updatedAt: NOW,
});
const measurement = (id: string, number: number, date: string, status: LobMeasurement['status'] = 'closed'): LobMeasurement => ({
  id,
  workId: W,
  number,
  date,
  status,
  createdBy: 'u1',
  createdAt: NOW,
  updatedAt: NOW,
});
const item = (measurementId: string, activityId: string, value: number): LobMeasurementItem => ({
  id: `${measurementId}-${activityId}`,
  measurementId,
  workId: W,
  activityId,
  value,
  previousValue: 0,
  createdBy: 'u1',
  createdAt: NOW,
  updatedAt: NOW,
});
let seq = 0;
const cost = (serviceId: string, amount: number): LobCostItem => ({
  id: `c${++seq}`,
  workId: W,
  serviceId,
  description: 'Item',
  amount,
  orderIndex: seq,
  createdBy: 'u1',
  createdAt: NOW,
  updatedAt: NOW,
});

const services = [service('A', 0), service('B', 1)];
const activities = [act('a1', 'A', '2026-10-19', 10), act('a2', 'A', '2026-11-02', 10), act('b1', 'B', '2026-11-16', 20)];
const baseline = (id: string, createdAt: string, automatic: boolean, starts: Record<string, string>, only?: string[]): LobBaseline => ({
  id,
  workId: W,
  name: `LB ${id}`,
  automatic,
  createdBy: 'u1',
  createdAt,
  snapshot: activities
    .filter(a => !only || only.includes(a.id))
    .map(a => ({
      activityId: a.id,
      serviceId: a.serviceId,
      localId: a.localId,
      start: starts[a.id] ?? a.start,
      durationDays: a.durationDays,
    })),
});
const LB = baseline('lb', '2026-09-01T10:00:00.000Z', false, { a1: '2026-09-21', a2: '2026-10-19', b1: '2026-11-02' });
const m1 = measurement('m1', 1, '2026-10-30');
const m2 = measurement('m2', 2, '2026-12-04');
const items = [item('m1', 'a1', 80), item('m2', 'a1', 100), item('m2', 'a2', 50), item('m2', 'b1', 10)];
const obra = (over: Partial<Parameters<typeof lobCurve>[0]> = {}) => ({
  services,
  activities,
  baselines: [] as LobBaseline[],
  measurements: [m1, m2],
  items,
  costs: [] as LobCostItem[],
  ...over,
});
const TODAY = '2026-12-10';
const close = (actual: number | undefined, expected: number) => {
  assert.ok(actual !== undefined, 'valor ausente');
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);
};

test('sem linha de base: previsto mensal do primeiro início ao último término, pela duração', () => {
  const curve = lobCurve(obra(), { today: TODAY });
  assert.equal(curve.status, 'ok');
  assert.equal(curve.baseline, undefined);
  assert.equal(curve.weights.mode, 'duration');
  assert.deepEqual(
    curve.months.map(m => [m.month, m.end]),
    [
      ['2026-10', '2026-10-31'],
      ['2026-11', '2026-11-30'],
      ['2026-12', '2026-12-31'],
    ],
  );
  const [oct, nov, dec] = curve.months;
  close(oct.planned, 25);
  close(nov.planned, 77.5);
  close(dec.planned, 100);
  close(oct.plannedGain, 25);
  close(nov.plannedGain, 52.5);
  close(dec.plannedGain, 22.5);
  for (const m of curve.months) {
    assert.equal(m.baseline, undefined);
    assert.equal(m.baselineGain, undefined);
  }
});

test('realizado: última medição fechada até o fim do mês; mês sem medição repete; futuro fica sem ponto', () => {
  const curve = lobCurve(obra(), { today: TODAY });
  const [oct, nov, dec] = curve.months;
  close(oct.real, 20);
  assert.equal(oct.realFrom?.number, 1);
  assert.equal(oct.realCarried, undefined);
  close(oct.realGain, 20);
  // Novembro não teve medição: repete os 20% da nº 1, marcado como repetido, com ganho zero.
  close(nov.real, 20);
  assert.equal(nov.realFrom?.number, 1);
  assert.equal(nov.realCarried, true);
  close(nov.realGain, 0);
  close(dec.real, 42.5);
  assert.equal(dec.realFrom?.number, 2);
  assert.equal(dec.realCarried, undefined);
  close(dec.realGain, 22.5);
  assert.deepEqual(
    curve.measurements.map(m => [m.number, m.date, m.real]),
    [
      [1, '2026-10-30', 20],
      [2, '2026-12-04', 42.5],
    ],
  );

  // Em 20/11 só existe a medição nº 1: dezembro é futuro e fica sem realizado.
  const earlier = lobCurve(obra({ measurements: [m1] }), { today: '2026-11-20' });
  close(earlier.months[1].real, 20);
  assert.equal(earlier.months[1].realCarried, true);
  assert.equal(earlier.months[2].real, undefined);
  assert.equal(earlier.months[2].realGain, undefined);
  assert.equal(earlier.months[2].realFrom, undefined);
});

test('antes da primeira medição não há realizado, e a medição aberta não entra', () => {
  const m0 = measurement('m0', 1, '2026-11-13');
  const open = measurement('mo', 2, '2026-12-09', 'open');
  const curve = lobCurve(obra({ measurements: [m0, open], items: [item('m0', 'a1', 100), item('mo', 'b1', 100)] }), { today: TODAY });
  const [oct, nov, dec] = curve.months;
  assert.equal(oct.real, undefined);
  assert.equal(oct.realGain, undefined);
  // O primeiro mês medido leva todo o realizado até ali.
  close(nov.real, 25);
  close(nov.realGain, 25);
  close(dec.real, 25);
  assert.equal(dec.realCarried, true);
  assert.equal(curve.measurements.length, 1);

  const none = lobCurve(obra({ measurements: [open], items: [item('mo', 'b1', 100)] }), { today: TODAY });
  assert.equal(none.last, undefined);
  assert.deepEqual(none.measurements, []);
  assert.ok(none.months.every(m => m.real === undefined && m.realGain === undefined));
});

test('linha de base: a manual mais recente por padrão, e o eixo começa no mês em que ela começava', () => {
  const auto = baseline('auto', '2026-10-01T10:00:00.000Z', true, {});
  const curve = lobCurve(obra({ baselines: [LB, auto] }), { today: TODAY });
  assert.equal(curve.baseline?.id, 'lb');
  assert.deepEqual(
    curve.months.map(m => m.month),
    ['2026-09', '2026-10', '2026-11', '2026-12'],
  );
  const [sep, oct, nov, dec] = curve.months;
  close(sep.baseline, 20);
  close(oct.baseline, 50);
  close(nov.baseline, 100);
  close(dec.baseline, 100);
  close(sep.baselineGain, 20);
  close(oct.baselineGain, 30);
  close(nov.baselineGain, 50);
  close(dec.baselineGain, 0);
  close(sep.planned, 0);
  close(sep.plannedGain, 0);
  close(oct.planned, 25);
  assert.equal(sep.real, undefined);

  // A escolhida na tela vale mais que a regra padrão: a automática tem as datas atuais.
  const chosen = lobCurve(obra({ baselines: [LB, auto] }), { baselineId: 'auto', today: TODAY });
  assert.equal(chosen.baseline?.id, 'auto');
  assert.deepEqual(
    chosen.months.map(m => m.baseline),
    chosen.months.map(m => m.planned),
  );
  // Só linha de base automática: sem escolha, a curva fica sem a série.
  assert.equal(lobCurve(obra({ baselines: [auto] }), { today: TODAY }).baseline, undefined);
});

test('bloco criado depois da linha de base entra nela com as datas atuais', () => {
  const partial = baseline('p', '2026-09-01T10:00:00.000Z', false, { a1: '2026-09-21', a2: '2026-10-19' }, ['a1', 'a2']);
  const curve = lobCurve(obra({ baselines: [partial] }), { today: TODAY });
  const [sep, oct, nov, dec] = curve.months;
  close(sep.baseline, 20);
  close(oct.baseline, 50);
  // b1 pelas datas atuais: 55% em 30/11 → (1000 + 1000 + 1100) ÷ 40.
  close(nov.baseline, 77.5);
  close(dec.baseline, 100);
});

test('com todos os pacotes custeados, a curva pesa pelo custo', () => {
  const costs = [cost('A', 600), cost('A', 300), cost('B', 100)];
  const curve = lobCurve(obra({ costs, baselines: [LB] }), { today: TODAY });
  assert.equal(curve.weights.mode, 'cost');
  assert.equal(curveWeightingText(curve.weights), 'ponderado pelo custo dos pacotes');
  const [sep, oct, nov, dec] = curve.months;
  // a1 e a2 pesam 450 cada; b1 pesa 100.
  close(oct.planned, 45);
  close(nov.planned, 95.5);
  close(dec.planned, 100);
  close(sep.baseline, 36);
  close(oct.baseline, 90);
  close(oct.real, 36);
  close(dec.real, (450 * 100 + 450 * 50 + 100 * 10) / 1000);

  // Faltando o custo de B, volta para a duração e diz o motivo.
  const missing = lobCurve(obra({ costs: [cost('A', 900)] }), { today: TODAY });
  assert.equal(curveWeightingText(missing.weights), 'ponderado pela duração, porque há pacotes sem custo');
  close(missing.months[0].planned, 25);
});

test('os números batem com o IDP e com as funções de previsto e medido da Linha de Balanço', () => {
  const data = obra({ baselines: [LB] });
  const curve = lobCurve(data, { today: TODAY });
  const performance = lobPerformance(data);
  // Na data da última medição: real e planejado (linha de base) do cartão do IDP.
  close(curve.last?.real, performance.point!.real);
  close(curve.last?.baseline, performance.point!.planned);
  // Previsto pelo cronograma atual em 04/12: b1 com 15 dos 20 dias → (1000 + 1000 + 1500) ÷ 40.
  close(curve.last?.planned, 87.5);
  assert.equal(curve.last?.number, 2);
  for (const month of curve.months) {
    const weights = curve.weights.weight;
    close(month.planned, physicalProgress(activities, plannedPercents(activities, month.end), weights) ?? 0);
    close(month.baseline, physicalProgress(activities, plannedPercents(activities, month.end, LB), weights) ?? 0);
    if (month.real !== undefined)
      close(month.real, physicalProgress(activities, measuredPercents(data.measurements, data.items, month.end), weights) ?? 0);
  }
});

test('medição depois do último término estende o eixo; obra sem blocos não tem curva', () => {
  const late = measurement('m3', 3, '2027-01-08');
  const curve = lobCurve(obra({ measurements: [m1, m2, late], items: [...items, item('m3', 'b1', 60)] }), { today: '2027-01-15' });
  assert.deepEqual(
    curve.months.map(m => m.month),
    ['2026-10', '2026-11', '2026-12', '2027-01'],
  );
  const jan = curve.months[3];
  close(jan.planned, 100);
  close(jan.plannedGain, 0);
  close(jan.real, (1000 + 500 + 1200) / 40);
  close(jan.realGain, 25);

  const empty = lobCurve(obra({ activities: [], measurements: [], items: [] }), { today: TODAY });
  assert.equal(empty.status, 'no-blocks');
  assert.deepEqual(empty.months, []);
  assert.equal(curveWeightingText(empty.weights), 'ponderado pela duração');
});

test('obra do tamanho do Atmos (606 blocos, 30 meses) calcula sem demora e fecha em 100%', () => {
  const many: LobActivity[] = [];
  let start = '2026-01-05';
  for (let i = 0; i < 606; i++) {
    many.push(act(`x${i}`, i % 2 ? 'A' : 'B', start, 10 + (i % 15)));
    // Um bloco novo a cada dia corrido, espalhando a obra por uns 20 meses, mais a duração.
    start = new Date(Date.parse(`${start}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  }
  const snapshot = many.map(a => ({
    activityId: a.id,
    serviceId: a.serviceId,
    localId: a.localId,
    start: a.start,
    durationDays: a.durationDays,
  }));
  const big = { ...obra({ activities: many, measurements: [], items: [] }), baselines: [{ ...LB, snapshot }] };
  const began = performance.now();
  const curve = lobCurve(big, { today: '2026-12-10' });
  const elapsed = performance.now() - began;
  assert.ok(curve.months.length >= 20);
  close(curve.months[curve.months.length - 1].planned, 100);
  close(curve.months[curve.months.length - 1].baseline, 100);
  // Série que só cresce, e os ganhos somam o acumulado.
  let sum = 0;
  for (const [index, month] of curve.months.entries()) {
    assert.ok(month.plannedGain >= -1e-9);
    if (index) close(month.planned - curve.months[index - 1].planned, month.plannedGain);
    sum += month.plannedGain;
  }
  close(sum, 100);
  assert.ok(elapsed < 1000, `demorou ${elapsed.toFixed(0)} ms`);
});

test('o calendário da obra entra no previsto: feriado em 30/11 tira um dia de b1 no fim de novembro', () => {
  const calendar = { weekdays: [1, 2, 3, 4, 5], holidays: ['2026-11-30'] };
  const curve = lobCurve(obra({ calendar }), { today: TODAY });
  // b1 tem 10 dos 20 dias até 30/11 (o feriado não conta): (1000 + 1000 + 1000) ÷ 40.
  close(curve.months[1].planned, 75);
  for (const month of curve.months)
    close(
      month.planned,
      physicalProgress(activities, plannedPercents(activities, month.end, undefined, calendar), curve.weights.weight) ?? 0,
    );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  baselineDeviation,
  baselineFinishDate,
  workdayDelta,
  type LobActivity,
  type LobBaseline,
  type LobBaselineEntry,
  type LobCalendar,
  type LobLocal,
  type LobService,
} from '../src/domain/lob';
import {
  DEVIATION_BADGE_MIN_PX,
  badgeWidth,
  fitBadge,
  baselineDatesText,
  baselineDeviations,
  deviationBadge,
  deviationText,
  dragShifts,
  lobLayout,
  sameBlocks,
  sameShifts,
  signedWorkdays,
  ZOOM_PX,
} from '../src/modules/longo-prazo/lob/lob-model';

/** Linha de base na Linha de Balanço (23/11/2026, retorno de quem vem do Prevision): o desvio de cada
 * bloco em dias úteis do calendário da obra, os textos da tela e o que o layout entrega ao gráfico. */

const NOW = '2026-11-23T12:00:00.000Z';
const local = (id: string, orderIndex: number): LobLocal => ({ id, workId: 'w', name: id, orderIndex, createdAt: NOW, updatedAt: NOW });
const service = (id: string, orderIndex: number): LobService => ({
  id,
  workId: 'w',
  name: id,
  color: '#2a78d6',
  orderIndex,
  createdAt: NOW,
  updatedAt: NOW,
});
const act = (id: string, serviceId: string, localId: string, start: string, durationDays: number): LobActivity => ({
  id,
  workId: 'w',
  serviceId,
  localId,
  start,
  durationDays,
  createdAt: NOW,
  updatedAt: NOW,
});
const entry = (activityId: string, start: string, durationDays: number, finish?: string): LobBaselineEntry => ({
  activityId,
  serviceId: 's',
  localId: 'l',
  start,
  durationDays,
  ...(finish ? { finish } : {}),
});
const baselineOf = (snapshot: LobBaselineEntry[], name = 'Aprovada'): LobBaseline => ({
  id: 'b1',
  workId: 'w',
  name,
  automatic: false,
  createdBy: 'u',
  createdAt: NOW,
  snapshot,
});

test('workdayDelta: dias úteis com sinal, pulando fim de semana e os dias sem trabalho da obra', () => {
  assert.equal(workdayDelta('2026-11-06', '2026-11-06'), 0);
  // Sexta → segunda: 1 dia útil; e de volta, −1.
  assert.equal(workdayDelta('2026-11-06', '2026-11-09'), 1);
  assert.equal(workdayDelta('2026-11-09', '2026-11-06'), -1);
  // Uma semana cheia: 5 dias úteis.
  assert.equal(workdayDelta('2026-11-02', '2026-11-09'), 5);
  // Com sábado trabalhado e a sexta 20/11 de feriado: de quinta 19 a segunda 23 são 2 (sábado e segunda).
  const calendar: LobCalendar = { weekdays: [1, 2, 3, 4, 5, 6], holidays: ['2026-11-20'] };
  assert.equal(workdayDelta('2026-11-19', '2026-11-23', calendar), 2);
  assert.equal(workdayDelta('2026-11-23', '2026-11-19', calendar), -2);
  // Uma data que virou dia sem trabalho não conta por ela mesma: do feriado 20 para o sábado 21 é 1.
  assert.equal(workdayDelta('2026-11-20', '2026-11-21', calendar), 1);
});

test('baselineDeviation: atrasado, adiantado, no prazo e bloco novo', () => {
  // Linha de base: seg 02/11, 5 dias úteis → término sex 06/11.
  const base = entry('a', '2026-11-02', 5);
  // Uma semana depois: +5 no início e no término.
  assert.deepEqual(baselineDeviation({ start: '2026-11-09', durationDays: 5 }, base), {
    status: 'compared',
    baselineStart: '2026-11-02',
    baselineFinish: '2026-11-06',
    baselineDurationDays: 5,
    startDays: 5,
    finishDays: 5,
  });
  // Dois dias antes: adiantado (negativo).
  const early = baselineDeviation({ start: '2026-10-29', durationDays: 5 }, base);
  assert.equal(early.status === 'compared' && early.startDays, -2);
  assert.equal(early.status === 'compared' && early.finishDays, -2);
  // Mesmo início, duração maior: o início bate, o término atrasa 3.
  const longer = baselineDeviation({ start: '2026-11-02', durationDays: 8 }, base);
  assert.equal(longer.status === 'compared' && longer.startDays, 0);
  assert.equal(longer.status === 'compared' && longer.finishDays, 3);
  // Igual à foto: no prazo.
  const same = baselineDeviation({ start: '2026-11-02', durationDays: 5 }, base);
  assert.equal(same.status === 'compared' && same.finishDays, 0);
  // Não existia na foto.
  assert.deepEqual(baselineDeviation({ start: '2026-11-02', durationDays: 5 }, undefined), { status: 'new' });
});

test('baselineDeviation: usa o término gravado na foto e o calendário da obra', () => {
  // A foto guardou o término em 06/11; depois a obra ganhou o feriado de 05/11. O bloco, com as mesmas
  // datas de início e duração, hoje termina em 09/11: desvio de +1 dia útil, só por causa do calendário.
  const calendar: LobCalendar = { weekdays: [1, 2, 3, 4, 5], holidays: ['2026-11-05'] };
  const deviation = baselineDeviation({ start: '2026-11-02', durationDays: 5 }, entry('a', '2026-11-02', 5, '2026-11-06'), calendar);
  assert.deepEqual(deviation.status === 'compared' && [deviation.baselineFinish, deviation.startDays, deviation.finishDays], [
    '2026-11-06',
    0,
    1,
  ]);
  // Foto antiga, sem o término: calculado pelo calendário atual, então não há desvio.
  const legacy = baselineDeviation({ start: '2026-11-02', durationDays: 5 }, entry('a', '2026-11-02', 5), calendar);
  assert.deepEqual(legacy.status === 'compared' && [legacy.baselineFinish, legacy.finishDays], ['2026-11-09', 0]);
  // Término da obra na foto: o maior término entre os blocos.
  assert.equal(
    baselineFinishDate(baselineOf([entry('a', '2026-11-02', 5, '2026-11-06'), entry('b', '2026-11-09', 5)]), calendar),
    '2026-11-13',
  );
  assert.equal(baselineFinishDate(baselineOf([])), undefined);
});

test('textos do desvio: por extenso, com o início quando difere, e o selo curto', () => {
  assert.equal(signedWorkdays(12), '+12 dias úteis (atrasado)');
  assert.equal(signedWorkdays(-1), '−1 dia útil (adiantado)');
  assert.equal(signedWorkdays(0), 'no prazo');
  assert.equal(signedWorkdays(3, false), '+3 dias úteis');
  const compared = (startDays: number, finishDays: number) =>
    ({
      status: 'compared',
      baselineStart: '2026-11-02',
      baselineFinish: '2026-11-06',
      baselineDurationDays: 5,
      startDays,
      finishDays,
    }) as const;
  assert.equal(deviationText(compared(5, 5)), '+5 dias úteis (atrasado)');
  assert.equal(deviationText(compared(-3, -3)), '−3 dias úteis (adiantado)');
  assert.equal(deviationText(compared(0, 0)), 'no prazo');
  assert.equal(deviationText(compared(2, 5)), '+5 dias úteis (atrasado) no término; início +2 dias úteis');
  assert.equal(deviationText(compared(0, 3)), '+3 dias úteis (atrasado) no término; início no prazo');
  assert.equal(deviationText(compared(-2, 0)), 'no prazo no término; início −2 dias úteis');
  assert.equal(deviationText({ status: 'new' }), 'não estava na linha de base');
  assert.equal(baselineDatesText(compared(0, 0), '2026-11-23'), '02/11 → 06/11');
  assert.equal(baselineDatesText(compared(0, 0), '2027-01-10'), '02/11/26 → 06/11/26');
  assert.equal(deviationBadge(compared(2, 12)), '+12d');
  assert.equal(deviationBadge(compared(0, -3)), '−3d');
  assert.equal(deviationBadge(compared(4, 0)), '');
  assert.equal(deviationBadge({ status: 'new' }), '');
  assert.equal(deviationBadge(undefined), '');
  assert.ok(badgeWidth('+12d') > badgeWidth('−3d'));
  // O selo completo pede 6 px de folga; no bloco estreito (5 dias úteis no zoom "Mês": ~21 px) entra
  // o compacto, sem o "d"; se nem ele cabe, nada.
  assert.deepEqual(fitBadge('+4d', 80), { text: '+4d', width: badgeWidth('+4d') });
  assert.deepEqual(fitBadge('+4d', 21), { text: '+4', width: 16 });
  assert.deepEqual(fitBadge('−3d', 21), { text: '−3', width: 16 });
  assert.equal(fitBadge('+12d', 21), undefined);
  assert.equal(fitBadge('', 200), undefined);
});

// Locais e serviços são os mesmos objetos entre um layout e outro, como na tela (só os blocos mudam).
const LOCALS = [local('L1', 0), local('L2', 1)];
const SERVICES = [service('S1', 0), service('S2', 1)];
const layoutInput = (activities: LobActivity[], baseline?: LobBaseline, calendar?: LobCalendar) => ({
  data: { locals: LOCALS, services: SERVICES, activities, calendar },
  zoom: 'mes' as const,
  availableWidth: 1100,
  today: '2026-11-23',
  baseline,
});

test('layout: com linha de base, cada bloco leva o desvio; sem ela, não; o cache devolve o mesmo objeto', () => {
  const moved = act('a', 'S1', 'L1', '2026-11-09', 5);
  const kept = act('b', 'S1', 'L2', '2026-11-16', 5);
  const fresh = act('c', 'S2', 'L1', '2026-11-23', 5);
  const baseline = baselineOf([entry('a', '2026-11-02', 5, '2026-11-06'), entry('b', '2026-11-16', 5, '2026-11-20')]);
  const layout = lobLayout(layoutInput([moved, kept, fresh], baseline));
  const a = layout.blockById.get('a')!.deviation;
  assert.equal(a?.status === 'compared' && a.finishDays, 5);
  const b = layout.blockById.get('b')!.deviation;
  assert.equal(b?.status === 'compared' && b.finishDays, 0);
  assert.deepEqual(layout.blockById.get('c')!.deviation, { status: 'new' });
  // Tracejado só para quem saiu do lugar.
  assert.deepEqual(
    layout.ghosts.map(g => g.activityId),
    ['a'],
  );
  assert.equal(lobLayout(layoutInput([moved, kept, fresh])).blockById.get('a')!.deviation, undefined);
  // O mesmo bloco (mesmo objeto) e a mesma linha de base: o desvio é o MESMO objeto, e a linha não redesenha.
  const again = lobLayout(layoutInput([moved, kept, fresh], baseline));
  assert.equal(again.blockById.get('a')!.deviation, a);
  assert.ok(sameBlocks(layout.blocks, again.blocks));
  // Um bloco com data nova é outro objeto: só ele é recalculado.
  const dragged = { ...moved, start: '2026-11-10' };
  const after = lobLayout(layoutInput([dragged, kept, fresh], baseline));
  assert.equal(after.blockById.get('b')!.deviation, b);
  const next = after.blockById.get('a')!.deviation;
  assert.equal(next?.status === 'compared' && next.finishDays, 6);
  assert.equal(baselineDeviations(baseline)(kept), b);
});

test('selo do desvio: o limiar de zoom deixa Semana e Mês com selo e Trimestre sem', () => {
  assert.ok(ZOOM_PX.semana >= DEVIATION_BADGE_MIN_PX);
  assert.ok(ZOOM_PX.mes >= DEVIATION_BADGE_MIN_PX);
  assert.ok(ZOOM_PX.trimestre < DEVIATION_BADGE_MIN_PX);
});

test('escala congelada: mover um bloco não muda a origem nem os px por dia; a janela só cresce se o bloco sair dela', () => {
  const a = act('a', 'S1', 'L1', '2026-11-02', 5);
  const b = act('b', 'S1', 'L2', '2027-03-01', 5);
  const input = { ...layoutInput([a, b]), zoom: 'obra' as const };
  const fit = lobLayout(input);
  const pin = { start: fit.start, end: fit.end, pxPerDay: fit.pxPerDay };
  // Sem congelar, esticar a obra em duas semanas muda a escala do zoom "Obra inteira" (tudo redesenha).
  const later = { ...b, start: '2027-03-15' };
  const refit = lobLayout({ ...input, data: { ...input.data, activities: [a, later] } });
  assert.notEqual(refit.pxPerDay, fit.pxPerDay);
  // Congelado: mesma origem, mesma escala, e o bloco que não mexeu fica no mesmo lugar.
  const pinned = lobLayout({ ...input, data: { ...input.data, activities: [a, later] }, pin });
  assert.equal(pinned.pxPerDay, fit.pxPerDay);
  assert.equal(pinned.start, fit.start);
  assert.equal(pinned.end, fit.end);
  assert.equal(pinned.blockById.get('a')!.x, fit.blockById.get('a')!.x);
  // O bloco saiu da janela: ela cresce para o lado dele, com a escala mantida (aparece a rolagem).
  const far = { ...b, start: '2027-06-01' };
  const grown = lobLayout({ ...input, data: { ...input.data, activities: [a, far] }, pin });
  assert.equal(grown.pxPerDay, fit.pxPerDay);
  assert.equal(grown.start, fit.start);
  assert.ok(grown.end > fit.end);
  assert.ok(grown.width > fit.width);
  // Um bloco puxado para antes do começo: a origem recua (e só aí o gráfico é redesenhado).
  const before = { ...a, start: '2026-09-01' };
  assert.ok(lobLayout({ ...input, data: { ...input.data, activities: [before, b] }, pin }).start < fit.start);
  // Com período escolhido a janela é o período: o congelamento não se aplica.
  const ranged = lobLayout({ ...input, range: { start: '2026-11-01', end: '2026-11-30' }, pin });
  assert.equal(ranged.start, '2026-11-01');
});

test('dragShifts: só as linhas com bloco deslocado entram, com o deslocamento e a largura novos', () => {
  const a = act('a', 'S1', 'L1', '2026-11-02', 5);
  const b = act('b', 'S1', 'L2', '2026-11-09', 5);
  const c = act('c', 'S2', 'L2', '2026-11-16', 5);
  const layout = lobLayout(layoutInput([a, b, c]));
  // "a" vai uma semana para a frente (7 dias corridos); "b" fica; bloco fora do gráfico é ignorado.
  const shifts = dragShifts(layout, [{ ...a, start: '2026-11-09' }, b, act('z', 'S1', 'L1', '2026-11-02', 5)]);
  assert.deepEqual([...shifts.keys()], ['L1']);
  const shift = shifts.get('L1')!.get('a')!;
  assert.equal(shift.dx, 7 * ZOOM_PX.mes);
  assert.equal(shift.w, layout.blockById.get('a')!.w);
  assert.equal(shift.start, '2026-11-09');
  // Com o feriado de quinta 12/11 no calendário da obra, o bloco levado para a semana do feriado
  // termina na segunda 16/11 em vez da sexta: atravessa o feriado e o fim de semana e ocupa três dias
  // corridos a mais (o desenho vai até o fim do último dia trabalhado). A prévia do arrasto já mostra a largura nova.
  const calendar: LobCalendar = { weekdays: [1, 2, 3, 4, 5], holidays: ['2026-11-12'] };
  const withHoliday = lobLayout(layoutInput([a, b, c], undefined, calendar));
  const wider = dragShifts(withHoliday, [{ ...a, start: '2026-11-09' }], calendar)
    .get('L1')!
    .get('a')!;
  assert.equal(wider.w - withHoliday.blockById.get('a')!.w, 3 * ZOOM_PX.mes);
  assert.ok(sameShifts(shifts.get('L1'), dragShifts(layout, [{ ...a, start: '2026-11-09' }]).get('L1')));
  assert.ok(!sameShifts(shifts.get('L1'), dragShifts(layout, [{ ...a, start: '2026-11-10' }]).get('L1')));
  assert.ok(sameShifts(undefined, undefined));
  assert.ok(!sameShifts(shifts.get('L1'), undefined));
});

test('sameBlocks: a linha que não mudou continua igual depois de outra linha mudar', () => {
  const a = act('a', 'S1', 'L1', '2026-11-02', 5);
  const b = act('b', 'S1', 'L2', '2026-11-09', 5);
  const input = layoutInput([a, b]);
  const before = lobLayout(input);
  const pin = { start: before.start, end: before.end, pxPerDay: before.pxPerDay };
  const after = lobLayout({ ...input, data: { ...input.data, activities: [a, { ...b, start: '2026-11-10' }] }, pin });
  const row = (layout: typeof before, id: string) => layout.blocks.filter(block => block.local.id === id);
  assert.ok(sameBlocks(row(before, 'L1'), row(after, 'L1')));
  assert.ok(!sameBlocks(row(before, 'L2'), row(after, 'L2')));
});

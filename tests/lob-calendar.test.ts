import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LOB_CALENDAR,
  LOB_CALENDAR_MAX_HOLIDAYS,
  isDefaultLobCalendar,
  isWorkingDay,
  lobCalendarLabel,
  normalizeLobCalendar,
  sameLobCalendar,
  weekdaysLabel,
  type LobCalendar,
} from '../src/domain/lob-calendar';
import {
  activityEnd,
  activityFinish,
  addWorkdays,
  applyCalendar,
  baselineEntryEnd,
  baselineEntryFinish,
  calendarChangePreview,
  cascade,
  delayDays,
  isLate,
  isWorkday,
  lobSpan,
  moveActivity,
  nextWorkday,
  planLaunch,
  plannedPercent,
  plannedProgress,
  previousWorkday,
  workdaysBetween,
  type LobActivity,
  type LobDependency,
  type LobLocal,
  type ServiceFlowDocument,
} from '../src/domain/lob';
import { lobCriticalPath } from '../src/domain/lob-critical';
import { lobPerformance, plannedPercents, weightedProgress } from '../src/domain/lob-performance';
import { lobServiceRows } from '../src/domain/legalization';
import { buildLobBlock } from '../src/modules/dashboard/extras/blocks';

/** Calendário de dias úteis da Linha de Balanço, por obra (23/11/2026). Novembro de 2026: 02/11 é
 * segunda, 04/11 quarta, 07/11 sábado, 20/11 sexta (Consciência Negra), 23/11 segunda. */
const NOW = '2026-11-01T12:00:00.000Z';
const W = 'obra-1';
/** Segunda a sexta, com a quarta 04/11 e a sexta 20/11 sem trabalho. */
const HOLIDAYS: LobCalendar = { weekdays: [1, 2, 3, 4, 5], holidays: ['2026-11-04', '2026-11-20'] };
/** Segunda a sábado, sem feriados. */
const SATURDAYS: LobCalendar = { weekdays: [1, 2, 3, 4, 5, 6], holidays: [] };

const act = (id: string, start: string, durationDays: number, over: Partial<LobActivity> = {}): LobActivity => ({
  id,
  workId: W,
  serviceId: 's1',
  localId: 'l1',
  start,
  durationDays,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});
const dep = (predecessorId: string, successorId: string, lagDays = 0): LobDependency => ({
  id: `${predecessorId}>${successorId}`,
  workId: W,
  predecessorId,
  successorId,
  lagDays,
  kind: 'fs',
  createdAt: NOW,
});
const starts = (list: LobActivity[]) => Object.fromEntries(list.map(a => [a.id, a.start]).sort());

// ─── O calendário ───────────────────────────────────────────────────────────────

test('o padrão é segunda a sexta sem feriados, e sem calendário vale o padrão', () => {
  assert.deepEqual(DEFAULT_LOB_CALENDAR, { weekdays: [1, 2, 3, 4, 5], holidays: [] });
  for (const date of ['2026-11-02', '2026-11-04', '2026-11-06', '2026-11-20', '2026-12-25'])
    assert.deepEqual([isWorkingDay(date), isWorkingDay(date, DEFAULT_LOB_CALENDAR)], [true, true], date);
  for (const date of ['2026-11-07', '2026-11-08'])
    assert.deepEqual([isWorkingDay(date), isWorkingDay(date, DEFAULT_LOB_CALENDAR)], [false, false]);
  assert.ok(isDefaultLobCalendar(undefined));
  assert.ok(isDefaultLobCalendar({ weekdays: [1, 2, 3, 4, 5], holidays: [] }));
  assert.ok(!isDefaultLobCalendar(HOLIDAYS));
  assert.ok(!isDefaultLobCalendar(SATURDAYS));
});

test('dia da semana fora do calendário e dia sem trabalho não são úteis', () => {
  assert.equal(isWorkday('2026-11-04', HOLIDAYS), false);
  assert.equal(isWorkday('2026-11-05', HOLIDAYS), true);
  assert.equal(isWorkday('2026-11-07', SATURDAYS), true);
  assert.equal(isWorkday('2026-11-08', SATURDAYS), false);
  // Feriado num dia que já não é da semana de trabalho não muda nada.
  assert.equal(isWorkday('2026-11-07', { weekdays: [1, 2, 3, 4, 5], holidays: ['2026-11-07'] }), false);
  // Calendário sem dia da semana (não passa pela validação) cai no padrão, para a conta não travar.
  assert.equal(nextWorkday('2026-11-07', { weekdays: [], holidays: [] }), '2026-11-09');
});

test('normalizeLobCalendar ordena, tira repetidos e recusa o que não é calendário', () => {
  assert.deepEqual(normalizeLobCalendar({ weekdays: [5, 1, 3, 1], holidays: ['2026-12-25', '2026-11-20', '2026-12-25'] }), {
    weekdays: [1, 3, 5],
    holidays: ['2026-11-20', '2026-12-25'],
  });
  assert.throws(() => normalizeLobCalendar(null), { message: 'Dias da semana trabalhados inválidos.' });
  assert.throws(() => normalizeLobCalendar({ weekdays: [1, 7], holidays: [] }), { message: 'Dias da semana trabalhados inválidos.' });
  assert.throws(() => normalizeLobCalendar({ weekdays: ['1'], holidays: [] }), { message: 'Dias da semana trabalhados inválidos.' });
  assert.throws(() => normalizeLobCalendar({ weekdays: [], holidays: [] }), { message: 'Marque ao menos um dia da semana trabalhado.' });
  assert.throws(() => normalizeLobCalendar({ weekdays: [1], holidays: ['25/12/2026'] }), {
    message: 'Lista de dias sem trabalho inválida.',
  });
  assert.throws(() => normalizeLobCalendar({ weekdays: [1], holidays: ['2026-02-30'] }), {
    message: 'Lista de dias sem trabalho inválida.',
  });
  assert.throws(() => normalizeLobCalendar({ weekdays: [1] }), { message: 'Lista de dias sem trabalho inválida.' });
  // O teto de dias sem trabalho barra lista colada com lixo.
  const many = Array.from({ length: LOB_CALENDAR_MAX_HOLIDAYS + 1 }, (_, i) =>
    new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
  );
  assert.throws(() => normalizeLobCalendar({ weekdays: [1], holidays: many }), /no máximo 1500 dias sem trabalho/);
  assert.equal(normalizeLobCalendar({ weekdays: [1], holidays: many.slice(1) }).holidays.length, LOB_CALENDAR_MAX_HOLIDAYS);
});

test('sameLobCalendar compara por conteúdo e os rótulos dizem o calendário em português', () => {
  assert.ok(sameLobCalendar(HOLIDAYS, { weekdays: [1, 2, 3, 4, 5], holidays: ['2026-11-04', '2026-11-20'] }));
  assert.ok(!sameLobCalendar(HOLIDAYS, { ...HOLIDAYS, holidays: ['2026-11-04'] }));
  assert.ok(!sameLobCalendar(SATURDAYS, undefined));
  assert.equal(weekdaysLabel([1, 2, 3, 4, 5]), 'segunda a sexta');
  assert.equal(weekdaysLabel([1, 2, 3, 4, 5, 6]), 'segunda a sábado');
  assert.equal(weekdaysLabel([1, 3, 5]), 'segunda, quarta e sexta');
  assert.equal(weekdaysLabel([6]), 'sábado');
  assert.equal(weekdaysLabel([0, 1, 2, 3, 4, 5, 6]), 'todos os dias');
  assert.equal(lobCalendarLabel(undefined), 'segunda a sexta, sem feriados marcados');
  assert.equal(lobCalendarLabel(HOLIDAYS), 'segunda a sexta, com 2 dias sem trabalho marcados');
  assert.equal(
    lobCalendarLabel({ weekdays: [1, 2, 3, 4, 5, 6], holidays: ['2026-12-25'] }),
    'segunda a sábado, com 1 dia sem trabalho marcado',
  );
});

// ─── Contas de dias úteis ───────────────────────────────────────────────────────

test('nextWorkday e previousWorkday pulam o feriado e o fim de semana emendado', () => {
  assert.equal(nextWorkday('2026-11-04', HOLIDAYS), '2026-11-05');
  // Sexta sem trabalho + sábado + domingo: a segunda.
  assert.equal(nextWorkday('2026-11-20', HOLIDAYS), '2026-11-23');
  assert.equal(previousWorkday('2026-11-22', HOLIDAYS), '2026-11-19');
  // Com sábado trabalhado, o sábado é o próprio dia; o domingo vai à segunda.
  assert.equal(nextWorkday('2026-11-07', SATURDAYS), '2026-11-07');
  assert.equal(nextWorkday('2026-11-08', SATURDAYS), '2026-11-09');
  // Sem calendário, como sempre foi.
  assert.equal(nextWorkday('2026-11-07'), '2026-11-09');
  assert.equal(nextWorkday('2026-11-04'), '2026-11-04');
});

test('addWorkdays e workdaysBetween contam pelos dias úteis do calendário, nos dois sentidos', () => {
  // 5 dias úteis depois da segunda 02/11: sem calendário, 09/11; com a quarta parada, 10/11; com sábado, 07/11.
  assert.equal(addWorkdays('2026-11-02', 5), '2026-11-09');
  assert.equal(addWorkdays('2026-11-02', 5, HOLIDAYS), '2026-11-10');
  assert.equal(addWorkdays('2026-11-02', 5, SATURDAYS), '2026-11-07');
  assert.equal(addWorkdays('2026-11-10', -5, HOLIDAYS), '2026-11-02');
  assert.equal(addWorkdays('2026-11-04', 0, HOLIDAYS), '2026-11-05');
  assert.equal(workdaysBetween('2026-11-02', '2026-11-09'), 5);
  assert.equal(workdaysBetween('2026-11-02', '2026-11-09', HOLIDAYS), 4);
  assert.equal(workdaysBetween('2026-11-02', '2026-11-09', SATURDAYS), 6);
  assert.equal(workdaysBetween('2026-11-09', '2026-11-02', HOLIDAYS), 0);
});

test('a duração em dias úteis fica; o término é que anda com o calendário', () => {
  const block = { start: '2026-11-02', durationDays: 5 };
  assert.deepEqual([activityFinish(block), activityEnd(block)], ['2026-11-06', '2026-11-09']);
  assert.deepEqual([activityFinish(block, HOLIDAYS), activityEnd(block, HOLIDAYS)], ['2026-11-09', '2026-11-10']);
  assert.deepEqual([activityFinish(block, SATURDAYS), activityEnd(block, SATURDAYS)], ['2026-11-06', '2026-11-07']);
  // Bloco que atravessa a sexta parada: 16, 17, 18, 19 e 23/11.
  const span = lobSpan([act('a', '2026-11-16', 5)], HOLIDAYS)!;
  assert.deepEqual([span.start, span.finish, span.end], ['2026-11-16', '2026-11-23', '2026-11-24']);
  assert.equal(lobSpan([act('a', '2026-11-16', 5)])!.finish, '2026-11-20');
});

test('previsto, atraso e avanço planejado contam os dias úteis do calendário', () => {
  const a = act('a', '2026-11-02', 5);
  // Na quinta 05/11: sem calendário, 4 de 5 dias (80%); com a quarta parada, 3 de 5 (60%).
  assert.equal(plannedPercent(a, '2026-11-05'), 80);
  assert.equal(plannedPercent(a, '2026-11-05', HOLIDAYS), 60);
  assert.equal(plannedPercent(a, '2026-11-09', HOLIDAYS), 100);
  assert.equal(plannedProgress([a], '2026-11-05', undefined, HOLIDAYS), 60);
  // Medido 55%: atrasado pelo calendário fixo (80 − 55 ≥ 10), em dia pelo da obra (60 − 55 < 10).
  assert.equal(isLate(a, 55, '2026-11-05'), true);
  assert.equal(isLate(a, 55, '2026-11-05', HOLIDAYS), false);
  assert.equal(delayDays(a, 40, '2026-11-05'), 2);
  assert.equal(delayDays(a, 40, '2026-11-05', HOLIDAYS), 1);
});

// ─── Rede ───────────────────────────────────────────────────────────────────────

test('cascade e moveActivity encaixam a sucessora no fim da predecessora pelo calendário da obra', () => {
  const activities = [act('a', '2026-11-02', 5), act('b', '2026-11-09', 5)];
  const deps = [dep('a', 'b')];
  assert.deepEqual(cascade(activities, deps), []);
  // Com a quarta parada, "a" termina um dia depois e empurra "b".
  assert.deepEqual(starts(cascade(activities, deps, HOLIDAYS)), { b: '2026-11-10' });
  // Soltar o bloco num dia sem trabalho leva ao próximo dia útil.
  assert.deepEqual(starts(moveActivity([act('x', '2026-11-02', 2)], [], 'x', '2026-11-20', undefined, HOLIDAYS)), { x: '2026-11-23' });
  assert.deepEqual(starts(moveActivity([act('x', '2026-11-02', 2)], [], 'x', '2026-11-07', undefined, SATURDAYS)), { x: '2026-11-07' });
  assert.deepEqual(starts(moveActivity([act('x', '2026-11-02', 2)], [], 'x', '2026-11-07')), { x: '2026-11-09' });
});

test('applyCalendar: início em dia sem trabalho vai ao próximo dia útil e a rede acompanha; o que não precisa mudar fica', () => {
  // a → b encostados; c começa na quarta que vira dia sem trabalho; d tem folga dada à mão.
  const activities = [act('a', '2026-11-02', 5), act('b', '2026-11-09', 5), act('c', '2026-11-04', 2), act('d', '2026-11-23', 3)];
  const deps = [dep('a', 'b'), dep('b', 'd')];
  assert.deepEqual(applyCalendar(activities, deps, undefined), [], 'o calendário padrão não move nada');
  assert.deepEqual(applyCalendar(activities, deps, DEFAULT_LOB_CALENDAR), []);
  const moved = applyCalendar(activities, deps, HOLIDAYS);
  // b: fim de a em 10/11. c: quinta 05/11. d: b termina em 16/11 e d (23/11) segue com folga, sem mudar.
  assert.deepEqual(starts(moved), { b: '2026-11-10', c: '2026-11-05' });
  assert.ok(
    moved.every(a => a.durationDays === activities.find(x => x.id === a.id)!.durationDays),
    'as durações ficam',
  );
  // Tirar os dias sem trabalho não puxa ninguém para trás: a folga que sobrou fica.
  const after = activities.map(a => moved.find(m => m.id === a.id) ?? a);
  assert.deepEqual(applyCalendar(after, deps, undefined), []);
  // Sábado trabalhado: nenhum início cai em dia sem trabalho, nada é empurrado.
  assert.deepEqual(applyCalendar(activities, deps, SATURDAYS), []);
});

test('calendarChangePreview conta os blocos que mudam de data (início ou término) e o término da obra antes e depois', () => {
  const activities = [act('a', '2026-11-02', 5), act('b', '2026-11-09', 5), act('c', '2026-11-04', 2)];
  const deps = [dep('a', 'b')];
  // a muda só de término (06/11 → 09/11); b e c mudam de início. A obra terminava em 13/11 e vai a 16/11.
  assert.deepEqual(calendarChangePreview(activities, deps, undefined, HOLIDAYS), {
    changedBlocks: 3,
    movedStarts: 2,
    finishBefore: '2026-11-13',
    finishAfter: '2026-11-16',
  });
  assert.deepEqual(calendarChangePreview(activities, deps, undefined, undefined), {
    changedBlocks: 0,
    movedStarts: 0,
    finishBefore: '2026-11-13',
    finishAfter: '2026-11-13',
  });
  // De volta ao padrão: nenhum início anda, mas "a" volta a terminar na sexta.
  const moved = applyCalendar(activities, deps, HOLIDAYS);
  const after = activities.map(a => moved.find(m => m.id === a.id) ?? a);
  assert.deepEqual(calendarChangePreview(after, deps, HOLIDAYS, undefined), {
    changedBlocks: 1,
    movedStarts: 0,
    finishBefore: '2026-11-16',
    finishAfter: '2026-11-16',
  });
  // Sábado trabalhado encurta os blocos sem mexer nos inícios.
  const saturdays = calendarChangePreview(activities, deps, undefined, SATURDAYS);
  assert.deepEqual([saturdays.movedStarts, saturdays.finishBefore, saturdays.finishAfter], [0, '2026-11-13', '2026-11-13']);
  assert.deepEqual(calendarChangePreview([], [], undefined, HOLIDAYS), {
    changedBlocks: 0,
    movedStarts: 0,
    finishBefore: undefined,
    finishAfter: undefined,
  });
});

test('planLaunch usa o calendário da obra (existing.calendar) no início, no ritmo e nas predecessoras', () => {
  const locals: LobLocal[] = ['Térreo', '1º pavimento'].map((name, index) => ({
    id: `l${index + 1}`,
    workId: W,
    name,
    orderIndex: index,
    createdAt: NOW,
    updatedAt: NOW,
  }));
  const flow: ServiceFlowDocument = {
    name: 'Fluxo',
    direction: 'bottom_up',
    services: [
      { id: 'f1', name: 'Estrutura', color: '#2a78d6', durationDays: 5, predecessors: [] },
      { id: 'f2', name: 'Alvenaria', color: '#eb6834', durationDays: 3, predecessors: [{ serviceId: 'f1', lagDays: 0 }] },
    ],
  };
  let n = 0;
  const launch = (calendar?: LobCalendar) =>
    planLaunch({
      workId: W,
      flow,
      locals,
      // Pedido para a quarta 04/11.
      params: { localIds: ['l1', 'l2'], start: '2026-11-04', direction: 'bottom_up', rhythm: { kind: 'continuous' } },
      existing: { services: [], activities: [], dependencies: [], calendar },
      launchId: 'launch',
      now: NOW,
      newId: () => `n${++n}`,
    });
  const byKey = (plan: ReturnType<typeof launch>) => {
    const service = new Map(plan.services.map(s => [s.id, s.name]));
    return Object.fromEntries(plan.activities.map(a => [`${service.get(a.serviceId)}|${a.localId}`, a.start]));
  };
  assert.deepEqual(byKey(launch()), {
    'Estrutura|l1': '2026-11-04',
    'Estrutura|l2': '2026-11-11',
    'Alvenaria|l1': '2026-11-11',
    'Alvenaria|l2': '2026-11-18',
  });
  // Com a quarta 04/11 e a sexta 20/11 paradas: começa na quinta; Estrutura l1 = 05, 06, 09, 10, 11.
  const plan = launch(HOLIDAYS);
  assert.deepEqual(byKey(plan), {
    'Estrutura|l1': '2026-11-05',
    'Estrutura|l2': '2026-11-12',
    'Alvenaria|l1': '2026-11-12',
    // Estrutura l2 = 12, 13, 16, 17, 18 → Alvenaria l2 em 19/11.
    'Alvenaria|l2': '2026-11-19',
  });
  // Alvenaria l2 = 19, (20 parado), 23 e 24/11: o fim exclusivo do lançamento é 25/11.
  assert.equal(plan.end, '2026-11-25');
  assert.deepEqual(cascade(plan.activities, plan.dependencies, HOLIDAYS), [], 'o que foi lançado não se move com o mesmo calendário');
});

// ─── Caminho crítico, IDP e quem consome a Linha de Balanço ─────────────────────

test('caminho crítico: a folga sai dos dias úteis do calendário da obra', () => {
  // Com a quarta 04/11 parada, a (5 d) termina em 09/11 e b começa em 10/11: encostados.
  const activities = [act('a', '2026-11-02', 5), act('b', '2026-11-10', 5)];
  const critical = lobCriticalPath(activities, [dep('a', 'b')], HOLIDAYS);
  assert.equal(critical.end, '2026-11-17');
  assert.deepEqual([...critical.criticalIds].sort(), ['a', 'b']);
  // Pelo calendário fixo de antes, "a" teria um dia de folga: é por isso que o calendário precisa chegar aqui.
  const fixed = lobCriticalPath(activities, [dep('a', 'b')]);
  assert.equal(fixed.floatDays.get('a'), 1);
  assert.deepEqual([...fixed.criticalIds], ['b']);
});

test('IDP, avanço previsto, legalização e dashboard leem o calendário de `data.calendar`', () => {
  const service = { id: 's1', workId: W, name: 'Estrutura', color: '#2a78d6', orderIndex: 0, createdAt: NOW, updatedAt: NOW };
  const base = {
    services: [service],
    activities: [act('a', '2026-11-02', 5)],
    baselines: [],
    measurements: [
      { id: 'm1', workId: W, number: 1, date: '2026-11-05', status: 'closed' as const, createdBy: 'u1', createdAt: NOW, updatedAt: NOW },
    ],
    items: [
      {
        id: 'i1',
        measurementId: 'm1',
        workId: W,
        activityId: 'a',
        value: 60,
        previousValue: 0,
        createdBy: 'u1',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    costs: [],
  };
  // Medido 60% na quinta 05/11. Segunda a sexta: planejado 80% → IDP 0,75. Com a quarta parada: 60% → 1,00.
  assert.equal(lobPerformance(base).point?.idp, 0.75);
  assert.equal(lobPerformance({ ...base, calendar: HOLIDAYS }).point?.idp, 1);
  assert.deepEqual(plannedPercents(base.activities, '2026-11-05', undefined, HOLIDAYS), { a: 60 });
  assert.equal(weightedProgress(base, '2026-11-05').planned, 80);
  assert.equal(weightedProgress({ ...base, calendar: HOLIDAYS }, '2026-11-05').planned, 60);
  const range = { start: '2026-11-01', end: '2026-11-30', today: '2026-11-30' };
  assert.equal(buildLobBlock(base, range)?.idp, 0.75);
  assert.equal(buildLobBlock({ ...base, calendar: HOLIDAYS }, range)?.idp, 1);
  // "Trazer da Linha de Balanço" (legalização): o término do serviço sai do calendário da obra.
  assert.equal(lobServiceRows(base, range)[0].finish, '2026-11-06');
  assert.equal(lobServiceRows({ ...base, calendar: HOLIDAYS }, range)[0].finish, '2026-11-09');
});

// ─── Linha de base ──────────────────────────────────────────────────────────────

test('linha de base: o término gravado na foto vale mais que o recalculado pelo calendário atual', () => {
  const entry = { activityId: 'a', serviceId: 's1', localId: 'l1', start: '2026-11-02', durationDays: 5 };
  // Foto antiga, sem término: sai do calendário atual.
  assert.equal(baselineEntryFinish(entry), '2026-11-06');
  assert.equal(baselineEntryFinish(entry, HOLIDAYS), '2026-11-09');
  // Foto com o término gravado (tirada com o calendário de então): não muda quando o calendário muda.
  const frozen = { ...entry, finish: '2026-11-06' };
  assert.equal(baselineEntryFinish(frozen, HOLIDAYS), '2026-11-06');
  assert.equal(baselineEntryEnd(frozen, HOLIDAYS), '2026-11-09');
  assert.equal(baselineEntryEnd(frozen, SATURDAYS), '2026-11-07');
  assert.equal(baselineEntryEnd(entry, HOLIDAYS), '2026-11-10');
});

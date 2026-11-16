import test from 'node:test';
import assert from 'node:assert/strict';
import {
  daysBetween,
  holidayNote,
  missingNationalHolidays,
  monthsSpan,
  normalizeDays,
  offDaysSummary,
  optionalHolidayName,
  paintRange,
  toggleDay,
} from '../src/modules/medio-prazo/non-working-days';
import { scheduleTasks, DEFAULT_CALENDAR } from '../src/domain/plan-schedule';

/** Calendário "Dias sem trabalho" do médio prazo (16/11/2026): marcar dia, período e feriados nacionais. */

const WEEK = [1, 2, 3, 4, 5];

test('clique marca e desmarca o dia, e a lista sai ordenada e sem repetição', () => {
  const one = toggleDay(['2026-12-25'], '2026-11-20', WEEK);
  assert.deepEqual(one, ['2026-11-20', '2026-12-25']);
  assert.deepEqual(toggleDay(one, '2026-11-20', WEEK), ['2026-12-25']);
  assert.deepEqual(normalizeDays(['2026-12-25', '2026-11-20', '2026-12-25']), ['2026-11-20', '2026-12-25']);
});

test('sábado e domingo fora da semana de trabalho não viram dia sem trabalho', () => {
  assert.deepEqual(toggleDay([], '2026-11-21', WEEK), []);
  // Com sábado útil, o sábado se marca.
  assert.deepEqual(toggleDay([], '2026-11-21', [1, 2, 3, 4, 5, 6]), ['2026-11-21']);
  // Feriado que ficou num dia que deixou de ser útil ainda se desmarca.
  assert.deepEqual(toggleDay(['2026-11-21'], '2026-11-21', WEEK), []);
});

test('período (recesso) marca só os dias úteis da semana, em qualquer sentido do arrasto', () => {
  const recess = paintRange([], '2027-01-01', '2026-12-21', true, WEEK);
  assert.deepEqual(recess, [
    '2026-12-21',
    '2026-12-22',
    '2026-12-23',
    '2026-12-24',
    '2026-12-25',
    '2026-12-28',
    '2026-12-29',
    '2026-12-30',
    '2026-12-31',
    '2027-01-01',
  ]);
  // Desmarcar o período tira tudo dele e mantém o que está fora.
  assert.deepEqual(paintRange([...recess, '2027-02-15'], '2026-12-24', '2026-12-31', false, WEEK), [
    '2026-12-21',
    '2026-12-22',
    '2026-12-23',
    '2027-01-01',
    '2027-02-15',
  ]);
  assert.equal(daysBetween('2026-02-27', '2026-03-02').length, 4);
});

test('feriados nacionais dos meses à vista: só os de dia útil que ainda faltam', () => {
  const { from, to } = monthsSpan('2026-11', 3);
  assert.deepEqual([from, to], ['2026-11-01', '2027-01-31']);
  // 02/11 (seg), 15/11 (dom, fica de fora), 20/11 (sex), 25/12 (sex), 01/01/2027 (sex).
  assert.deepEqual(missingNationalHolidays([], from, to, WEEK), ['2026-11-02', '2026-11-20', '2026-12-25', '2027-01-01']);
  assert.deepEqual(missingNationalHolidays(['2026-11-20'], from, to, WEEK), ['2026-11-02', '2026-12-25', '2027-01-01']);
  // Com domingo útil, a Proclamação da República entra.
  assert.ok(missingNationalHolidays([], from, to, [0, 1, 2, 3, 4, 5]).includes('2026-11-15'));
  assert.equal(monthsSpan('2028-02', 1).to, '2028-02-29');
});

test('dica do dia: feriado nacional, Carnaval e Corpus Christi como ponto facultativo', () => {
  assert.deepEqual(holidayNote('2026-12-25'), { name: 'Natal', kind: 'nacional' });
  // Páscoa de 2027 em 28/03: Carnaval 08 e 09/02, Corpus Christi 27/05.
  assert.equal(optionalHolidayName('2027-02-08'), 'Carnaval');
  assert.equal(optionalHolidayName('2027-02-09'), 'Carnaval');
  assert.equal(optionalHolidayName('2027-02-10'), undefined);
  assert.deepEqual(holidayNote('2027-05-27'), { name: 'Corpus Christi', kind: 'facultativo' });
  assert.equal(holidayNote('2026-11-16'), undefined);
});

test('resumo ao lado do botão: dias do período e total', () => {
  const period = { start: '2026-11-01', end: '2027-01-31' };
  assert.equal(offDaysSummary([], period), 'Nenhum dia marcado.');
  assert.equal(offDaysSummary(['2026-11-20', '2026-12-25'], period), '2 dias no período: 20/11, 25/12');
  assert.equal(offDaysSummary(['2026-11-20', '2027-04-21'], period), '1 dia no período: 20/11 · 2 no total');
  assert.equal(offDaysSummary(['2027-04-21'], period), 'Nenhum dia no período · 1 no total');
  const many = paintRange([], '2026-12-21', '2027-01-01', true, WEEK);
  assert.match(offDaysSummary(many, period), /^10 dias no período: 21\/12, 22\/12, 23\/12, 24\/12, 25\/12, 28\/12…$/);
});

test('o dia marcado no calendário empurra a tarefa no motor', () => {
  const task = {
    id: 't1',
    planId: 'p1',
    workId: 'w1',
    name: 'Alvenaria',
    plannedStart: '2026-11-19',
    plannedEnd: '2026-11-20',
    progress: 0,
    duration: { value: 2, unit: 'd' as const },
    createdAt: '',
    updatedAt: '',
  };
  const before = scheduleTasks([task] as never, [], DEFAULT_CALENDAR);
  const calendar = { ...DEFAULT_CALENDAR, holidays: toggleDay([], '2026-11-20', WEEK) };
  const after = scheduleTasks([task] as never, [], calendar);
  assert.equal(before[0].plannedEnd, '2026-11-20');
  assert.equal(after[0].plannedEnd, '2026-11-23');
});

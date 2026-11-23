import test from 'node:test';
import assert from 'node:assert/strict';
import type { PlanTask, Team } from '../src/domain/entities';
import { DEFAULT_CALENDAR } from '../src/domain/plan-schedule';
import {
  clampToWeek,
  leavesInWeek,
  leavesOfSelection,
  weekCandidates,
  weekLineFromTask,
  workingSpanInWeek,
} from '../src/domain/plan-to-week';

// Semana de segunda 23/11/2026 a domingo 29/11/2026.
const WEEK = '2026-11-23';
const stamp = { createdAt: '', updatedAt: '' };
const TEAMS: Team[] = [
  { id: 'eq-alv', workId: 'obra', company: 'Alfa', name: 'Alvenaria 1', weeklyCapacity: 2, ...stamp },
  { id: 'eq-ele', workId: 'obra', company: 'Beta', name: 'Elétrica', weeklyCapacity: 1, ...stamp },
];
function task(id: string, start: string, end: string, over: Partial<PlanTask> = {}): PlanTask {
  return { id, planId: 'plano', name: id, level: 1, order: 0, progress: 0, plannedStart: start, plannedEnd: end, ...stamp, ...over };
}

test('clampToWeek traz a data para dentro da semana, de segunda a domingo', () => {
  assert.equal(clampToWeek('2026-11-10', WEEK), '2026-11-23');
  assert.equal(clampToWeek('2026-11-25', WEEK), '2026-11-25');
  assert.equal(clampToWeek('2026-12-15', WEEK), '2026-11-29');
});

test('weekLineFromTask (a regra da assistente): nome, equipe principal, empresa dela e período recortado na semana', () => {
  const line = weekLineFromTask(
    task('Alvenaria 3º pav', '2026-11-18', '2026-11-25', { teamId: 'eq-alv', extraTeamIds: ['eq-ele'] }),
    TEAMS,
    WEEK,
  );
  assert.deepEqual(
    { name: line.name, supplier: line.supplier, teamId: line.teamId, startDate: line.startDate, endDate: line.endDate },
    { name: 'Alvenaria 3º pav', supplier: 'Alfa', teamId: 'eq-alv', startDate: '2026-11-23', endDate: '2026-11-25' },
  );
  assert.equal(line.team, TEAMS[0]);
  // Sem equipe, ou com equipe que não é da obra: linha só com o nome e os dias.
  const semEquipe = weekLineFromTask(task('Limpeza', '2026-11-24', '2026-12-10', { teamId: 'outra-obra' }), TEAMS, WEEK);
  assert.deepEqual([semEquipe.supplier, semEquipe.teamId, semEquipe.team], ['', null, undefined]);
  assert.deepEqual([semEquipe.startDate, semEquipe.endDate], ['2026-11-24', '2026-11-29']);
});

test('workingSpanInWeek: do primeiro ao último dia útil da tarefa dentro da semana', () => {
  // Atravessa a semana inteira: segunda a sexta.
  assert.deepEqual(workingSpanInWeek(task('a', '2026-11-10', '2026-12-10'), WEEK), { startDate: '2026-11-23', endDate: '2026-11-27' });
  // Começa na quinta e segue pela semana seguinte: quinta e sexta.
  assert.deepEqual(workingSpanInWeek(task('b', '2026-11-26', '2026-12-02'), WEEK), { startDate: '2026-11-26', endDate: '2026-11-27' });
  // Um dia só.
  assert.deepEqual(workingSpanInWeek(task('c', '2026-11-25', '2026-11-25'), WEEK), { startDate: '2026-11-25', endDate: '2026-11-25' });
  // Só toca o fim de semana, ou não toca a semana: nada.
  assert.equal(workingSpanInWeek(task('d', '2026-11-28', '2026-11-29'), WEEK), undefined);
  assert.equal(workingSpanInWeek(task('e', '2026-11-30', '2026-12-04'), WEEK), undefined);
  assert.equal(workingSpanInWeek(task('f', '2026-11-02', '2026-11-20'), WEEK), undefined);
});

test('workingSpanInWeek respeita o calendário do cronograma: feriado e sábado de trabalho', () => {
  const feriado = { ...DEFAULT_CALENDAR, holidays: ['2026-11-23', '2026-11-27'] };
  assert.deepEqual(workingSpanInWeek(task('a', '2026-11-10', '2026-12-10'), WEEK, feriado), {
    startDate: '2026-11-24',
    endDate: '2026-11-26',
  });
  assert.equal(workingSpanInWeek(task('b', '2026-11-27', '2026-11-29'), WEEK, feriado), undefined);
  const comSabado = { ...DEFAULT_CALENDAR, weekdays: [1, 2, 3, 4, 5, 6] };
  assert.deepEqual(workingSpanInWeek(task('c', '2026-11-27', '2026-12-10'), WEEK, comSabado), {
    startDate: '2026-11-27',
    endDate: '2026-11-28',
  });
});

test('leavesOfSelection: folha vale por ela, resumo vale pelas folhas dele, sem repetir e na ordem do plano', () => {
  // A (resumo) > B (resumo) > c, d ; e ; F (resumo) > g ; h
  const rows = [
    { id: 'A', level: 0 },
    { id: 'B', level: 1 },
    { id: 'c', level: 2 },
    { id: 'd', level: 2 },
    { id: 'e', level: 1 },
    { id: 'F', level: 0 },
    { id: 'g', level: 1 },
    { id: 'h', level: 0 },
  ];
  const ids = (selected: string[], allowed?: string[]) =>
    leavesOfSelection(rows, new Set(selected), allowed && new Set(allowed)).map(r => r.id);
  assert.deepEqual(ids(['d']), ['d']);
  assert.deepEqual(ids(['B']), ['c', 'd']);
  assert.deepEqual(ids(['A']), ['c', 'd', 'e']);
  // Resumo e subtarefa dele selecionados juntos: a subtarefa não entra duas vezes.
  assert.deepEqual(ids(['h', 'A', 'c']), ['c', 'd', 'e', 'h']);
  assert.deepEqual(ids(['F', 'h']), ['g', 'h']);
  assert.deepEqual(ids([]), []);
  // Com filtro ativo, o resumo só traz as folhas que o filtro deixa passar; a folha selecionada vale sempre.
  assert.deepEqual(ids(['A'], ['A', 'B', 'd']), ['d']);
  assert.deepEqual(ids(['A', 'g'], ['A', 'e']), ['e', 'g']);
});

test('weekCandidates: linha nova marcada, com os dias úteis da tarefa dentro da semana', () => {
  const [c] = weekCandidates([task('Alvenaria', '2026-11-18', '2026-12-02', { teamId: 'eq-alv' })], {
    weekStart: WEEK,
    teams: TEAMS,
    commitments: [],
  });
  assert.deepEqual(c.line, { name: 'Alvenaria', supplier: 'Alfa', teamId: 'eq-alv', startDate: '2026-11-23', endDate: '2026-11-27' });
  assert.deepEqual([c.block, c.duplicate, c.done, c.checked], [undefined, false, false, true]);
});

test('weekCandidates: tarefa sem dia na semana fica indisponível, com o motivo', () => {
  const out = weekCandidates(
    [
      task('Antes', '2026-11-02', '2026-11-20'),
      task('Depois', '2026-11-30', '2026-12-04'),
      task('Fim de semana', '2026-11-28', '2026-11-29'),
    ],
    { weekStart: WEEK, teams: TEAMS, commitments: [] },
  );
  assert.deepEqual(
    out.map(c => [c.task.name, c.block, c.line, c.checked]),
    [
      ['Antes', 'fora_da_semana', undefined, false],
      ['Depois', 'fora_da_semana', undefined, false],
      ['Fim de semana', 'sem_dia_util', undefined, false],
    ],
  );
});

test('weekCandidates: linha de nome igual na semana de destino desmarca; a de outra semana não conta', () => {
  const leaves = [task('Reboco Interno', '2026-11-23', '2026-11-27'), task('Contrapiso', '2026-11-23', '2026-11-27')];
  const commitments = [
    { name: '  reboco   interno ', weekStart: WEEK },
    { name: 'Contrapiso', weekStart: '2026-11-16' },
  ];
  const out = weekCandidates(leaves, { weekStart: WEEK, teams: TEAMS, commitments });
  assert.deepEqual(
    out.map(c => [c.task.name, c.duplicate, c.checked, !!c.line]),
    [
      ['Reboco Interno', true, false, true],
      ['Contrapiso', false, true, true],
    ],
  );
  // Qualquer data dentro da semana vale como a semana: a regra parte da segunda-feira.
  assert.equal(weekCandidates(leaves, { weekStart: '2026-11-26', teams: TEAMS, commitments })[0].duplicate, true);
});

test('weekCandidates: tarefa concluída vem desmarcada, mas pode ser levada', () => {
  const out = weekCandidates(
    [
      task('Feita', '2026-11-23', '2026-11-24', { progress: 100 }),
      task('Com término real', '2026-11-23', '2026-11-24', { actualEnd: '2026-11-24' }),
    ],
    { weekStart: WEEK, teams: TEAMS, commitments: [] },
  );
  assert.deepEqual(
    out.map(c => [c.done, c.checked, !!c.line]),
    [
      [true, false, true],
      [true, false, true],
    ],
  );
});

test('leavesInWeek: as tarefas com algum dia entre a segunda e o domingo', () => {
  const leaves = [
    task('antes', '2026-11-02', '2026-11-22'),
    task('entra', '2026-11-02', '2026-11-23'),
    task('dentro', '2026-11-25', '2026-11-26'),
    task('domingo', '2026-11-29', '2026-12-05'),
    task('depois', '2026-11-30', '2026-12-05'),
  ];
  assert.deepEqual(
    leavesInWeek(leaves, '2026-11-25').map(t => t.name),
    ['entra', 'dentro', 'domingo'],
  );
});

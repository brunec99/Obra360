import test from 'node:test';
import assert from 'node:assert/strict';
import type { LinkType, PlanDependency, PlanTask } from '../src/domain/entities';
import { analyzeSchedule, endFor, parseDuration, DEFAULT_CALENDAR } from '../src/domain/plan-schedule';

/** Vínculo com tarefa-resumo (16/11/2026), como no Project: o resumo como sucessora empurra todas as
 * subtarefas; como predecessora, vale o envelope (o término da última subtarefa, ou o início da
 * primeira). 2026-09-07 é segunda-feira; durações em dias úteis. */

interface Row {
  id: string;
  dur?: string;
  level?: number;
  start?: string;
  actualStart?: string;
  progress?: number;
  constraint?: { type: PlanTask['constraintType']; date?: string };
  deadline?: string;
}
function plan(rows: Row[], links: [string, string, LinkType?, number?][]) {
  const tasks: PlanTask[] = rows.map((r, i) => {
    const duration = parseDuration(r.dur ?? '1d');
    const start = r.start ?? '2026-09-07';
    return {
      id: r.id,
      name: r.id,
      planId: 'p',
      level: r.level ?? 0,
      order: i + 1,
      progress: r.progress ?? 0,
      plannedStart: start,
      plannedEnd: endFor(start, duration, DEFAULT_CALENDAR).end,
      duration,
      createdAt: '',
      updatedAt: '',
      ...(r.actualStart ? { actualStart: r.actualStart } : {}),
      ...(r.constraint ? { constraintType: r.constraint.type, constraintDate: r.constraint.date } : {}),
      ...(r.deadline ? { deadline: r.deadline } : {}),
    };
  });
  const deps: PlanDependency[] = links.map(([from, to, type, lag], i) => ({
    id: `l${i}`,
    predecessorId: from,
    successorId: to,
    type: type ?? 'TI',
    lagDays: lag ?? 0,
    lagBusiness: true,
    createdAt: '',
    updatedAt: '',
  }));
  return { tasks, deps };
}
function run(rows: Row[], links: [string, string, LinkType?, number?][]) {
  const { tasks, deps } = plan(rows, links);
  const out = analyzeSchedule(tasks, deps, DEFAULT_CALENDAR);
  const at = (id: string) => {
    const info = out.info.get(id)!;
    return {
      dates: `${info.earlyStart.slice(5)}→${info.earlyFinish.slice(5)}`,
      late: `${info.lateStart.slice(5)}→${info.lateFinish.slice(5)}`,
      slack: info.totalSlack,
      critical: info.critical,
      conflict: info.conflict,
      drivers: info.driverIds,
    };
  };
  return at;
}

test('resumo como predecessora (TI): a sucessora espera a última subtarefa, e a mais curta ganha folga', () => {
  const at = run([{ id: 'A' }, { id: 'A1', dur: '3d', level: 1 }, { id: 'A2', dur: '5d', level: 1 }, { id: 'B', dur: '2d' }], [['A', 'B']]);
  assert.equal(at('B').dates, '09-14→09-15');
  assert.deepEqual(at('B').drivers, ['A']);
  assert.equal(at('A2').slack, 0);
  assert.equal(at('A2').critical, true);
  assert.equal(at('A1').late, '09-09→09-11');
  assert.equal(at('A1').slack, 2);
  assert.equal(at('A').dates, '09-07→09-11');
});

test('resumo como sucessora (TI): todas as subtarefas começam depois da predecessora', () => {
  const at = run([{ id: 'P', dur: '3d' }, { id: 'S' }, { id: 'S1', dur: '2d', level: 1 }, { id: 'S2', dur: '4d', level: 1 }], [['P', 'S']]);
  assert.equal(at('S1').dates, '09-10→09-11');
  assert.equal(at('S2').dates, '09-10→09-15');
  assert.deepEqual(at('S1').drivers, ['P']);
  assert.equal(at('S1').slack, 2);
  assert.equal(at('P').critical, true);
  assert.equal(at('S').dates, '09-10→09-15');
});

test('resumo intermediário e vínculo entre um resumo e uma tarefa irmã', () => {
  const at = run(
    [
      { id: 'P', dur: '2d' },
      { id: 'A' },
      { id: 'A1', level: 1 },
      { id: 'A11', dur: '2d', level: 2 },
      { id: 'A12', dur: '3d', level: 2 },
      { id: 'A2', dur: '2d', level: 1 },
      { id: 'X' },
    ],
    [
      ['P', 'A1'],
      ['A1', 'A2'],
      ['A', 'X'],
    ],
  );
  assert.equal(at('A11').dates, '09-09→09-10');
  assert.equal(at('A12').dates, '09-09→09-11');
  assert.equal(at('A2').dates, '09-14→09-15');
  assert.equal(at('X').dates, '09-16→09-16');
  assert.equal(at('A11').slack, 1);
});

test('subtarefa com predecessora própria mais tarde que a do resumo segue a mais tarde', () => {
  const at = run(
    [{ id: 'P', dur: '2d' }, { id: 'Q', dur: '5d' }, { id: 'S' }, { id: 'S1', dur: '2d', level: 1 }, { id: 'S2', dur: '2d', level: 1 }],
    [
      ['P', 'S'],
      ['Q', 'S2'],
    ],
  );
  assert.equal(at('S1').dates, '09-09→09-10');
  assert.equal(at('S2').dates, '09-14→09-15');
  assert.deepEqual(at('S2').drivers, ['Q']);
});

test('resumo como sucessora em Início-Início com defasagem', () => {
  const at = run(
    [{ id: 'P', dur: '4d' }, { id: 'S' }, { id: 'S1', dur: '2d', level: 1 }, { id: 'S2', dur: '3d', level: 1 }],
    [['P', 'S', 'II', 2]],
  );
  assert.equal(at('S1').dates, '09-09→09-10');
  assert.equal(at('S2').dates, '09-09→09-11');
});

test('resumo para resumo e resumo que recebe vínculo de dentro de outro resumo', () => {
  const ab = run(
    [{ id: 'A' }, { id: 'A1', dur: '2d', level: 1 }, { id: 'A2', dur: '3d', level: 1 }, { id: 'B' }, { id: 'B1', dur: '2d', level: 1 }],
    [['A', 'B']],
  );
  assert.equal(ab('B1').dates, '09-10→09-11');
  const st = run(
    [{ id: 'S' }, { id: 'S1', dur: '2d', level: 1 }, { id: 'S2', dur: '2d', level: 1 }, { id: 'T' }, { id: 'T1', dur: '3d', level: 1 }],
    [
      ['S1', 'T'],
      ['T', 'S2'],
    ],
  );
  assert.equal(st('T1').dates, '09-09→09-11');
  assert.equal(st('S2').dates, '09-14→09-15');
});

test('prazo final depois do resumo deixa folga negativa na subtarefa que segura o término', () => {
  const at = run(
    [
      { id: 'A' },
      { id: 'A1', dur: '2d', level: 1 },
      { id: 'A2', dur: '4d', level: 1 },
      { id: 'B', dur: '3d', deadline: '2026-09-14' },
      { id: 'C', dur: '6d' },
    ],
    [['A', 'B']],
  );
  assert.equal(at('A2').slack, -1);
  assert.equal(at('A1').slack, 1);
  assert.equal(at('B').slack, -1);
});

test('subtarefa presa antes da predecessora do resumo: o conflito acende no resumo, a folga negativa na subtarefa', () => {
  const at = run(
    [
      { id: 'P', dur: '3d' },
      { id: 'S' },
      { id: 'S1', dur: '2d', level: 1, constraint: { type: 'MSO', date: '2026-09-08' } },
      { id: 'S2', dur: '2d', level: 1 },
    ],
    [['P', 'S']],
  );
  assert.equal(at('S1').dates, '09-08→09-09');
  assert.equal(at('S').conflict, true);
  assert.equal(at('S1').conflict, false);
  assert.equal(at('S1').slack, -2);
  assert.equal(at('S2').dates, '09-10→09-11');
});

test('subtarefa já iniciada: o restante espera a predecessora do resumo, sem conflito', () => {
  const at = run(
    [
      { id: 'P', dur: '3d' },
      { id: 'S' },
      { id: 'S1', dur: '4d', level: 1, actualStart: '2026-09-07', progress: 50 },
      { id: 'S2', dur: '2d', level: 1 },
    ],
    [['P', 'S']],
  );
  assert.equal(at('S1').dates, '09-07→09-11');
  assert.equal(at('S').conflict, false);
});

test('recusas: resumo com a própria subtarefa, TT ou IT chegando ao resumo e ciclo através de resumos', () => {
  const rows = [{ id: 'P' }, { id: 'S' }, { id: 'S1', level: 1 }, { id: 'T' }, { id: 'T1', level: 1 }];
  const fails = (links: [string, string, LinkType?][], message: RegExp) => {
    const { tasks, deps } = plan(rows, links);
    assert.throws(() => analyzeSchedule(tasks, deps, DEFAULT_CALENDAR), message);
  };
  fails([['S', 'S1']], /próprias subtarefas/);
  fails([['S1', 'S']], /próprias subtarefas/);
  fails([['P', 'S', 'TT']], /Término-Início ou Início-Início/);
  fails([['P', 'S', 'IT']], /Término-Início ou Início-Início/);
  // S → T obriga T1 a esperar S; T1 → S1 obriga S1 a esperar T1: ciclo.
  fails(
    [
      ['S', 'T'],
      ['T1', 'S1'],
    ],
    /ciclo/,
  );
  // Do resumo sai qualquer tipo.
  const { tasks, deps } = plan(rows, [
    ['S', 'P', 'TT'],
    ['T', 'P', 'IT'],
  ]);
  assert.doesNotThrow(() => analyzeSchedule(tasks, deps, DEFAULT_CALENDAR));
});

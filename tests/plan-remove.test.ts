import test from 'node:test';
import assert from 'node:assert/strict';
import type { PlanDependency, PlanTask } from '../src/domain/entities';
import { removeTasks } from '../src/modules/medio-prazo/schedule-sheet';

/** Excluir várias tarefas de uma vez no médio prazo (16/11/2026): o intervalo selecionado sai inteiro,
 * cada linha com os subitens, numa pergunta só. */

function task(id: string, level: number): PlanTask {
  return {
    id,
    level,
    name: id,
    progress: 0,
    order: 0,
    planId: 'plan',
    plannedStart: '2026-11-16',
    plannedEnd: '2026-11-20',
    createdAt: '',
    updatedAt: '',
  };
}
const link = (from: string, to: string): PlanDependency => ({
  id: `${from}>${to}`,
  predecessorId: from,
  successorId: to,
  type: 'TI',
  lagDays: 0,
  lagBusiness: true,
  createdAt: '',
  updatedAt: '',
});
const ids = (tasks: PlanTask[]) => tasks.map(t => t.id).join(' ');

test('várias linhas soltas saem juntas, com os vínculos delas, e a ordem é renumerada', () => {
  const tasks = [task('a', 0), task('b', 0), task('c', 0), task('d', 0), task('e', 0)];
  const links = [link('a', 'b'), link('b', 'c'), link('c', 'd'), link('d', 'e'), link('a', 'e')];
  const out = removeTasks(tasks, links, ['b', 'c', 'd']);
  assert.equal(ids(out.tasks), 'a e');
  assert.deepEqual(
    out.tasks.map(t => t.order),
    [1, 2],
  );
  assert.deepEqual(
    out.links.map(l => l.id),
    ['a>e'],
  );
  assert.equal(ids(out.roots), 'b c d');
  assert.equal(out.removed.length, 3);
  // A entrada não muda.
  assert.equal(tasks.length, 5);
  assert.equal(tasks[4].order, 0);
});

test('resumo leva as subtarefas, mesmo recolhidas; subtarefa escolhida dentro dele não conta duas vezes', () => {
  // a0 [b0 c1 d2 e1] f0 g0: escolhe b, d (dentro de b) e f.
  const tasks = [task('a', 0), task('b', 0), task('c', 1), task('d', 2), task('e', 1), task('f', 0), task('g', 0)];
  const out = removeTasks(tasks, [link('a', 'c'), link('e', 'g'), link('a', 'g')], ['b', 'd', 'f']);
  assert.equal(ids(out.tasks), 'a g');
  assert.equal(ids(out.roots), 'b f');
  assert.equal(ids(out.removed), 'b c d e f');
  assert.deepEqual(
    out.links.map(l => l.id),
    ['a>g'],
  );
});

test('subtarefas escolhidas saem sem levar o resumo, e a estrutura continua válida', () => {
  // a0 b1 c2 d1 e0: escolhe b (com c) e d; o resumo a fica sem filhos e vira tarefa comum.
  const tasks = [task('a', 0), task('b', 1), task('c', 2), task('d', 1), task('e', 0)];
  const out = removeTasks(tasks, [], ['b', 'd']);
  assert.equal(ids(out.tasks), 'a e');
  assert.ok(out.tasks.every((t, i) => i === 0 || t.level <= out.tasks[i - 1].level + 1));
});

test('nada escolhido não muda nada; tudo escolhido esvazia', () => {
  const tasks = [task('a', 0), task('b', 1)];
  assert.equal(ids(removeTasks(tasks, [], []).tasks), 'a b');
  assert.equal(removeTasks(tasks, [], ['a']).tasks.length, 0);
});

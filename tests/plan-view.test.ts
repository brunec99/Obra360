import test from 'node:test';
import assert from 'node:assert/strict';
import type { PlanTask } from '../src/domain/entities';
import { rollUpPlan } from '../src/domain/rules';
import {
  dependencyAnchors,
  filterPlanRows,
  foldedForLevel,
  maxOutlineDepth,
  outlineDepth,
  shownLevel,
  type OutlineRow,
  type PlanRowFilter,
} from '../src/modules/medio-prazo/plan-view';

function task(id: string, level: number, name = id, progress = 0, order = 0): PlanTask {
  return {
    id,
    level,
    name,
    progress,
    order,
    planId: 'plan',
    plannedStart: '2026-09-01',
    plannedEnd: '2026-09-30',
    createdAt: '',
    updatedAt: '',
  };
}
const options = (
  overrides: Partial<{ query: string; filter: PlanRowFilter; conflictTaskIds: ReadonlySet<string>; folded: ReadonlySet<string> }> = {},
) => ({
  query: '',
  filter: 'all' as PlanRowFilter,
  conflictTaskIds: new Set<string>(),
  folded: new Set<string>(),
  ...overrides,
});
const ids = (tasks: PlanTask[]) => tasks.map(row => row.id);

test('leitura sem filtro recolhe só descendentes, preservando irmãos e próximos grupos', () => {
  const rows = [task('a', 0), task('b', 1), task('c', 2), task('d', 1), task('e', 0), task('f', 1)];
  assert.deepEqual(ids(filterPlanRows(rows, options({ folded: new Set(['b']) }))), ['a', 'b', 'd', 'e', 'f']);
  assert.deepEqual(ids(filterPlanRows(rows, options({ folded: new Set(['a', 'b']) }))), ['a', 'e', 'f']);
});

test('busca sem acentos combina tokens em qualquer ordem e revela todos os ancestrais', () => {
  const rows = [task('a', 0, 'Prédio'), task('b', 1, 'Pavimento'), task('c', 2, 'Instalação elétrica'), task('d', 1, 'Pintura')];
  const result = filterPlanRows(rows, options({ query: ' ELETRICA  instalacao ', folded: new Set(['a', 'b']) }));
  assert.deepEqual(ids(result), ['a', 'b', 'c']);
});

test('busca não mistura ancestrais entre grupos nem inclui descendentes sem correspondência', () => {
  const rows = [task('a', 0, 'Fundação'), task('b', 1), task('c', 0, 'Estrutura'), task('d', 1, 'Concretagem')];
  assert.deepEqual(ids(filterPlanRows(rows, options({ query: 'concretagem' }))), ['c', 'd']);
  assert.deepEqual(ids(filterPlanRows(rows, options({ query: 'fundacao' }))), ['a']);
});

test('hierarquia considera o nível menor anterior mesmo quando há saltos nos níveis', () => {
  const rows = [task('a', 0), task('b', 3), task('c', 5, 'Encontrada'), task('d', 2), task('e', 0)];
  assert.deepEqual(ids(filterPlanRows(rows, options({ query: 'encontrada' }))), ['a', 'b', 'c']);
  assert.deepEqual(ids(filterPlanRows(rows, options({ folded: new Set(['b']) }))), ['a', 'b', 'd', 'e']);
});

test('incompletas usa apenas progresso das folhas, nunca valor persistido de resumo', () => {
  const rows = [
    task('a', 0, 'Resumo concluído', 0),
    task('b', 1, 'Concluída', 100),
    task('c', 0, 'Resumo pendente', 100),
    task('d', 1, 'Pendente', 40),
    task('e', 1, 'Concluída', 100),
  ];
  assert.deepEqual(ids(filterPlanRows(rows, options({ filter: 'incomplete', folded: new Set(['c']) }))), ['c', 'd']);
});

test('busca e filtro são interseção; ancestrais só precisam contextualizar a folha encontrada', () => {
  const rows = [
    task('a', 0, 'Bloco A'),
    task('b', 1, 'Pintura interna', 50),
    task('c', 1, 'Pintura externa', 100),
    task('d', 0, 'Fundação', 10),
  ];
  assert.deepEqual(ids(filterPlanRows(rows, options({ query: 'pintura', filter: 'incomplete' }))), ['a', 'b']);
  assert.deepEqual(ids(filterPlanRows(rows, options({ query: 'externa', filter: 'incomplete' }))), []);
});

test('filtro de conflitos revela a sucessora com seu contexto sem incluir outras linhas', () => {
  const rows = [task('a', 0, 'Bloco A'), task('b', 1, 'Pintura'), task('c', 1, 'Alvenaria'), task('d', 0, 'Pintura')];
  const selected = options({ filter: 'conflicts', conflictTaskIds: new Set(['c', 'd', 'missing']), folded: new Set(['a']) });
  assert.deepEqual(ids(filterPlanRows(rows, selected)), ['a', 'c', 'd']);
  assert.deepEqual(ids(filterPlanRows(rows, { ...selected, query: 'alvenaria' })), ['a', 'c']);
});

test('mantém ordem de entrada e os objetos originais sem renumerar ou alterar preferências', () => {
  const rows = [task('z', 0, 'Grupo', 0, 19), task('b', 1, 'Busca', 30, 2), task('a', 0, 'Busca', 10, 7)];
  const snapshot = structuredClone(rows);
  const folded = new Set(['z']);
  const result = filterPlanRows(rows, options({ query: 'busca', folded }));
  assert.deepEqual(ids(result), ['z', 'b', 'a']);
  result.forEach((row, index) => assert.equal(row, rows[index]));
  assert.deepEqual(rows, snapshot);
  assert.deepEqual([...folded], ['z']);
  assert.deepEqual(ids(filterPlanRows(rows, options({ folded }))), ['z', 'a']);
});

test('busca vazia ou apenas espaços mantém recolhimento e entrada vazia é válida', () => {
  const rows = [task('a', 0), task('b', 1)];
  assert.deepEqual(ids(filterPlanRows(rows, options({ query: ' \t ', folded: new Set(['a']) }))), ['a']);
  assert.deepEqual(filterPlanRows([], options({ query: 'inexistente', filter: 'incomplete' })), []);
});

test('setas partem e chegam às pontas correspondentes aos quatro tipos de vínculo', () => {
  assert.deepEqual(dependencyAnchors('TI'), { from: 'end', to: 'start' });
  assert.deepEqual(dependencyAnchors('II'), { from: 'start', to: 'start' });
  assert.deepEqual(dependencyAnchors('TT'), { from: 'end', to: 'end' });
  assert.deepEqual(dependencyAnchors('IT'), { from: 'start', to: 'end' });
});

// ─── "Mostrar até o nível" ──────────────────────────────────────────────────────

/** A estrutura como a tela a monta: o número EAP e o resumo saem de `rollUpPlan`. */
function outline(levels: [string, number][]): OutlineRow[] {
  const tasks = levels.map(([id, level], i) => task(id, level, id, 0, i + 1));
  const roll = rollUpPlan(tasks);
  return tasks.map(t => ({ id: t.id, number: roll.get(t.id)!.number, summary: roll.get(t.id)!.summary }));
}
// 1 a · 1.1 b · 1.1.1 c · 1.1.2 d · 1.2 e · 2 f · 2.1 g · 2.1.1 h · 3 i
const TREE: [string, number][] = [
  ['a', 0],
  ['b', 1],
  ['c', 2],
  ['d', 2],
  ['e', 1],
  ['f', 0],
  ['g', 1],
  ['h', 2],
  ['i', 0],
];

test('nível da linha é a profundidade do número EAP, e o cronograma vai até o mais fundo', () => {
  assert.equal(outlineDepth('2'), 1);
  assert.equal(outlineDepth('2.1.3'), 3);
  assert.equal(maxOutlineDepth(outline(TREE)), 3);
  assert.equal(maxOutlineDepth([]), 0);
});

test('mostrar até o nível K recolhe os resumos de profundidade K ou maior e abre os de cima', () => {
  const rows = outline(TREE);
  assert.deepEqual(foldedForLevel(rows, 1), ['a', 'b', 'f', 'g']);
  assert.deepEqual(foldedForLevel(rows, 2), ['b', 'g']);
  assert.deepEqual(foldedForLevel(rows, 3), []);
  // Nível fora da faixa não quebra: abaixo de 1 vale 1; acima do mais fundo, tudo aberto.
  assert.deepEqual(foldedForLevel(rows, 0), foldedForLevel(rows, 1));
  assert.deepEqual(foldedForLevel(rows, 9), []);
});

test('as linhas visíveis depois de escolher o nível são exatamente as de profundidade até K', () => {
  const tasks = TREE.map(([id, level], i) => task(id, level, id, 0, i + 1));
  const rows = outline(TREE);
  for (const level of [1, 2, 3]) {
    const visible = filterPlanRows(tasks, options({ folded: new Set(foldedForLevel(rows, level)) }));
    assert.deepEqual(
      ids(visible),
      rows.filter(r => outlineDepth(r.number) <= level).map(r => r.id),
      `nível ${level}`,
    );
  }
});

test('nível que pula degrau no dado gravado conta pela numeração, não pelo level cru', () => {
  // "b" está gravado no nível 3, mas é filho direto de "a": número 1.1, profundidade 2.
  const rows = outline([
    ['a', 0],
    ['b', 3],
    ['c', 4],
    ['d', 0],
  ]);
  assert.deepEqual(
    rows.map(r => r.number),
    ['1', '1.1', '1.1.1', '2'],
  );
  assert.deepEqual(foldedForLevel(rows, 2), ['b']);
  assert.deepEqual(foldedForLevel(rows, 1), ['a', 'b']);
});

test('o nível mostrado: tudo aberto, um nível exato, ou personalizado depois da seta de um resumo', () => {
  const rows = outline(TREE);
  assert.equal(shownLevel(rows, []), 'all');
  assert.equal(shownLevel(rows, foldedForLevel(rows, 1)), 1);
  assert.equal(shownLevel(rows, foldedForLevel(rows, 2)), 2);
  // A pessoa abriu "b" pela seta depois de escolher o nível 2: deixa de ser um nível exato.
  assert.equal(shownLevel(rows, ['g']), undefined);
  // Abriu "a" depois do nível 1: "b" continua recolhido dentro dele, e a lista vira personalizado.
  assert.equal(shownLevel(rows, ['b', 'f', 'g']), undefined);
  // Id guardado de linha excluída, ou de linha que deixou de ser resumo, não conta.
  assert.equal(shownLevel(rows, ['sumiu', 'c']), 'all');
  assert.equal(shownLevel(rows, ['b', 'g', 'sumiu']), 2);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalPrevisionId,
  canSeePrevisionProject,
  PREVISION_PROJECT_ID,
  previsionProjectAccess,
  visiblePrevisionProjects,
} from '../src/domain/prevision-access';

const works = [
  { id: 'w1', previsionProjectId: '100' },
  { id: 'w2', previsionProjectId: '200' },
  { id: 'w3', previsionProjectId: null },
];
const planejador = { role: 'planner', workIds: ['w1', 'w3'] };

test('projeto da própria obra e projeto livre ficam liberados', () => {
  assert.equal(previsionProjectAccess('100', works, planejador), 'propria');
  assert.equal(previsionProjectAccess('300', works, planejador), 'livre');
});

test('projeto ligado a obra de outra pessoa fica fechado', () => {
  assert.equal(previsionProjectAccess('200', works, planejador), 'de-outra-obra');
  assert.equal(canSeePrevisionProject('200', works, planejador), false);
});

test('admin vê todos os projetos', () => {
  assert.equal(canSeePrevisionProject('200', works, { role: 'admin', workIds: [] }), true);
});

test('a lista leva só os projetos da pessoa e os livres', () => {
  const projetos = [
    { id: '100', name: 'Torre A' },
    { id: '200', name: 'Torre B' },
    { id: '300', name: 'Livre' },
  ];
  assert.deepEqual(
    visiblePrevisionProjects(projetos, works, planejador).map(p => p.id),
    ['100', '300'],
  );
});

test('id com zero à esquerda não escapa da regra: 0100 é o mesmo projeto 100', () => {
  assert.equal(PREVISION_PROJECT_ID.test('0100'), false);
  assert.equal(PREVISION_PROJECT_ID.test('100'), true);
  assert.equal(previsionProjectAccess('0200', works, planejador), 'de-outra-obra');
  assert.equal(canonicalPrevisionId('0200'), '200');
  // vínculo gravado com zero à esquerda (antes da regra) continua valendo para o dono e fechado para os outros
  const legado = [{ id: 'w9', previsionProjectId: '0500' }];
  assert.equal(previsionProjectAccess('500', legado, { role: 'planner', workIds: ['w9'] }), 'propria');
  assert.equal(previsionProjectAccess('500', legado, planejador), 'de-outra-obra');
  assert.equal(previsionProjectAccess('abc', works, planejador), 'de-outra-obra');
});

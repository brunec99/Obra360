import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deletionLabel,
  fulfillmentLabel,
  recreateCommand,
  restorePlan,
  undoFulfillmentCommand,
  undoUpdateCommand,
} from '../src/modules/curto-prazo/undo';
import type { WeeklyCommitment } from '../src/domain/entities';

/* "Desfazer" da planilha (26/10/2026): o comando inverso sai do estado anterior das linhas. */

const base: WeeklyCommitment = {
  id: 'c1',
  createdAt: '2026-10-19T10:00:00.000Z',
  updatedAt: '2026-10-19T10:00:00.000Z',
  workId: 'obra-1',
  name: 'Reboco',
  supplier: 'SM MARTINS',
  weekStart: '2026-10-19',
  weekEnd: '2026-10-25',
  responsibleId: 'user-2',
  teamId: 'equipe-1',
  startDate: '2026-10-20',
  endDate: '2026-10-21',
};

test('desfazer apontamento: quem tinha Status volta a tê-lo, quem não tinha é limpo, num comando só', () => {
  const before: WeeklyCommitment[] = [
    { ...base, id: 'a', fulfilled: false, cause: 'Intempéries', justification: 'Chuva' },
    { ...base, id: 'b', fulfilled: true },
    { ...base, id: 'c' },
  ];
  assert.deepEqual(undoFulfillmentCommand(before), {
    type: 'record_fulfillments',
    items: [
      { commitmentId: 'a', fulfilled: false, cause: 'Intempéries', justification: 'Chuva' },
      { commitmentId: 'b', fulfilled: true, cause: undefined, justification: undefined },
      { commitmentId: 'c', clear: true },
    ],
  });
  assert.equal(fulfillmentLabel(before), 'apontamento de 3 linhas');
  assert.equal(fulfillmentLabel([before[0]]), 'apontamento de “Reboco”');
});

test('desfazer edição devolve as células; desfazer exclusão recria a linha com as mesmas células', () => {
  assert.deepEqual(undoUpdateCommand({ ...base, teamId: undefined }), {
    type: 'update_commitment',
    commitmentId: 'c1',
    name: 'Reboco',
    supplier: 'SM MARTINS',
    teamId: null,
    weekStart: '2026-10-19',
    startDate: '2026-10-20',
    endDate: '2026-10-21',
    // Sempre explícito: sem local antes, desfazer tira o local que a edição pôs (05/11/2026).
    localId: null,
  });
  assert.deepEqual(recreateCommand({ ...base, activityId: 'act-1' }, 'user-1'), {
    type: 'create_commitment',
    workId: 'obra-1',
    name: 'Reboco',
    weekStart: '2026-10-19',
    responsibleId: 'user-1',
    supplier: 'SM MARTINS',
    teamId: 'equipe-1',
    activityId: 'act-1',
    startDate: '2026-10-20',
    endDate: '2026-10-21',
  });
});

/* "Excluir linhas marcadas" (23/11/2026): um Desfazer só devolve todas ao lugar. */

test('exclusão em lote: o rótulo diz a linha (uma) ou quantas (várias)', () => {
  assert.equal(deletionLabel([base]), 'exclusão de “Reboco”');
  assert.equal(deletionLabel([base, { ...base, id: 'c2' }, { ...base, id: 'c3' }]), 'exclusão de 3 linhas');
});

test('exclusão em lote: cada linha volta acima da primeira que ficou depois dela, na ordem da planilha', () => {
  const saved = ['a', 'b', 'c', 'd', 'e', 'f'];
  // b e c são vizinhas: as duas voltam acima de d, b primeiro; f era a última e entra embaixo.
  assert.deepEqual(restorePlan(saved, new Set(['c', 'f', 'b'])), [{ id: 'b', beforeId: 'd' }, { id: 'c', beforeId: 'd' }, { id: 'f' }]);
});

test('exclusão em lote: refazer o plano na ordem devolve a planilha original', () => {
  const saved = ['a', 'b', 'c', 'd', 'e', 'f'];
  for (const removed of [['a'], ['f'], ['a', 'b'], ['b', 'c', 'e'], ['e', 'f'], saved]) {
    const gone = new Set(removed);
    const sheet = saved.filter(id => !gone.has(id));
    for (const step of restorePlan(saved, gone)) {
      const at = step.beforeId ? sheet.indexOf(step.beforeId) : sheet.length;
      sheet.splice(at, 0, step.id);
    }
    assert.deepEqual(sheet, saved, removed.join());
  }
});

test('exclusão em lote: id fora da semana é ignorado, e sem excluídas não há o que devolver', () => {
  assert.deepEqual(restorePlan(['a', 'b'], new Set(['x'])), []);
  assert.deepEqual(restorePlan([], new Set(['a'])), []);
});

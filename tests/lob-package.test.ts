import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activityEnd,
  addWorkdays,
  emptyLobData,
  isWorkday,
  type LobActivity,
  type LobCalendar,
  type LobCommand,
  type LobData,
  type LobDependency,
  type LobLocal,
  type LobPackageEdit,
  type LobService,
} from '../src/domain/lob';
import { createPackageMovePlanner, isStartedActivity, packageLogic, planPackageEdit, planPackageMove } from '../src/domain/lob-package';
import { isLobScheduleCommand, parseLobCommand, planLobCommand } from '../src/application/use-cases/lob-commands';

/** O pacote inteiro na Linha de Balanço (25/11/2026, pedido do Jorge Lucas; modelo aprovado com as
 * regras numeradas citadas abaixo). A obra de teste imita o Atmos: reboco (R) → lixamento? não, três
 * pacotes em quatro pavimentos: R (reboco), E (estruturação de drywall) e I (infras de drywall). Cada
 * E depende do R do mesmo pavimento; E e I andam pavimento a pavimento ("equipe segue"); cada I
 * depende do E do mesmo pavimento. */

const W = 'w';
const NOW = '2026-11-25T12:00:00.000Z';
const TODAY = '2026-11-25';
const local = (id: string, orderIndex: number): LobLocal => ({ id, workId: W, name: id, orderIndex, createdAt: NOW, updatedAt: NOW });
const service = (id: string, orderIndex: number): LobService => ({
  id,
  workId: W,
  name: id,
  color: '#336699',
  orderIndex,
  createdAt: NOW,
  updatedAt: NOW,
});
const act = (
  id: string,
  serviceId: string,
  localId: string,
  start: string,
  durationDays: number,
  over: Partial<LobActivity> = {},
): LobActivity => ({
  id,
  workId: W,
  serviceId,
  localId,
  start,
  durationDays,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});
const dep = (predecessorId: string, successorId: string, lagDays = 0, kind: 'fs' | 'crew' = 'fs', createdAt = NOW): LobDependency => ({
  id: `${predecessorId}>${successorId}`,
  workId: W,
  predecessorId,
  successorId,
  lagDays,
  kind,
  createdAt,
});
let seq = 0;
const newId = () => `new-${++seq}`;
const LOCALS = [local('L0', 0), local('L1', 1), local('L2', 2), local('L3', 3)];

/** Reboco de 5 dias úteis a cada semana; E (5 dias) logo depois do reboco; I (5 dias) logo depois do E.
 * Com `slack`, cada E começa `slack` dias úteis depois do mínimo. */
function obra(options: { slack?: number; calendar?: LobCalendar; started?: string[] } = {}) {
  const calendar = options.calendar;
  const slack = options.slack ?? 0;
  const activities: LobActivity[] = [];
  const dependencies: LobDependency[] = [];
  const base = '2027-03-01'; // segunda-feira
  for (let i = 0; i < 4; i++) {
    const r = act(`R${i}`, 'R', `L${i}`, addWorkdays(base, 5 * i, calendar), 5);
    activities.push(r);
    if (i) dependencies.push(dep(`R${i - 1}`, `R${i}`, 0, 'crew'));
  }
  for (let i = 0; i < 4; i++) {
    const r = activities.find(a => a.id === `R${i}`)!;
    const prevE = activities.find(a => a.id === `E${i - 1}`);
    let start = addWorkdays(activityEnd(r, calendar), slack, calendar);
    if (prevE && activityEnd(prevE, calendar) > start) start = activityEnd(prevE, calendar);
    activities.push(act(`E${i}`, 'E', `L${i}`, start, 5, options.started?.includes(`E${i}`) ? { actualStart: start } : {}));
    dependencies.push(dep(`R${i}`, `E${i}`));
    if (i) dependencies.push(dep(`E${i - 1}`, `E${i}`, 0, 'crew'));
  }
  for (let i = 0; i < 4; i++) {
    const e = activities.find(a => a.id === `E${i}`)!;
    const prevI = activities.find(a => a.id === `I${i - 1}`);
    let start = activityEnd(e, calendar);
    if (prevI && activityEnd(prevI, calendar) > start) start = activityEnd(prevI, calendar);
    activities.push(act(`I${i}`, 'I', `L${i}`, start, 5));
    dependencies.push(dep(`E${i}`, `I${i}`));
    if (i) dependencies.push(dep(`I${i - 1}`, `I${i}`, 0, 'crew'));
  }
  const data: LobData = {
    ...emptyLobData(),
    locals: LOCALS,
    services: [service('R', 0), service('E', 1), service('I', 2)],
    activities,
    dependencies,
    calendar,
  };
  return data;
}
const startOf = (list: LobActivity[], id: string) => list.find(a => a.id === id)!.start;
const after = (data: LobData, changed: LobActivity[]) => {
  const map = new Map(changed.map(a => [a.id, a]));
  return data.activities.map(a => map.get(a.id) ?? a);
};

// ─── Mover o pacote ─────────────────────────────────────────────────────────────

test('regra 2: para a frente, todos os blocos do pacote andam os mesmos dias úteis e as sucessoras são empurradas', () => {
  const data = obra();
  const result = planPackageMove(data.activities, data.dependencies, 'E', 5);
  assert.equal(result.applied, 5);
  assert.deepEqual(result.moved.sort(), ['E0', 'E1', 'E2', 'E3']);
  const next = after(data, result.changed);
  for (let i = 0; i < 4; i++) {
    assert.equal(startOf(next, `E${i}`), addWorkdays(startOf(data.activities, `E${i}`), 5), `E${i}`);
    assert.equal(startOf(next, `R${i}`), startOf(data.activities, `R${i}`), `R${i} não muda`);
    assert.ok(startOf(next, `I${i}`) >= activityEnd(next.find(a => a.id === `E${i}`)!), `I${i} depois de E${i}`);
  }
  assert.equal(result.pushed, 4);
  assert.equal(result.limiter, undefined);
});

test('regra 4: para trás, sem folga, o pacote não anda e o aviso diz quem travou', () => {
  const data = obra();
  const result = planPackageMove(data.activities, data.dependencies, 'E', -3);
  assert.equal(result.applied, 0);
  assert.deepEqual(result.changed, []);
  assert.deepEqual(result.limiter, { activityId: 'E0', predecessorId: 'R0' });
});

test('regra 4: para trás com folga, o pacote para no limite e as sucessoras não são puxadas', () => {
  const data = obra({ slack: 3 });
  const result = planPackageMove(data.activities, data.dependencies, 'E', -10);
  assert.equal(result.applied, -3);
  assert.ok(result.limiter);
  const next = after(data, result.changed);
  for (let i = 0; i < 4; i++) {
    assert.equal(startOf(next, `E${i}`), addWorkdays(startOf(data.activities, `E${i}`), -3));
    assert.equal(startOf(next, `I${i}`), startOf(data.activities, `I${i}`), `I${i} fica (não é puxada)`);
  }
  assert.equal(result.pushed, 0);
  // Só I0 ganha folga: I1 a I3 seguem presas à infra do pavimento anterior, que não andou.
  assert.deepEqual(result.slack, { count: 1, maxDays: 3 });
});

test('regra 3: bloco iniciado fica, e vira âncora ao antecipar', () => {
  // Como na obra: o pavimento de baixo já começou, os de cima ainda não.
  const data = obra({ slack: 3, started: ['E0'] });
  assert.ok(isStartedActivity(data.activities.find(a => a.id === 'E0')!));
  const forward = planPackageMove(data.activities, data.dependencies, 'E', 2);
  assert.deepEqual(forward.kept, ['E0']);
  assert.deepEqual(forward.moved.sort(), ['E1', 'E2', 'E3']);
  assert.equal(startOf(after(data, forward.changed), 'E0'), startOf(data.activities, 'E0'));
  // Para trás, E1 está preso ao fim de E0 (iniciado, fora do grupo que anda): nada anda.
  const back = planPackageMove(data.activities, data.dependencies, 'E', -2);
  assert.equal(back.applied, 0);
  assert.equal(back.limiter?.activityId, 'E1');
});

test('bloco iniciado não anda com o pacote, mas a rede ainda o empurra se a predecessora andar (regra de sempre)', () => {
  const data = obra({ started: ['E3'] });
  const result = planPackageMove(data.activities, data.dependencies, 'E', 2);
  assert.ok(!result.moved.includes('E3'));
  assert.equal(startOf(after(data, result.changed), 'E3'), addWorkdays(startOf(data.activities, 'E3'), 2));
});

test('pacote todo iniciado não anda', () => {
  const data = obra({ started: ['E0', 'E1', 'E2', 'E3'] });
  const result = planPackageMove(data.activities, data.dependencies, 'E', 5);
  assert.equal(result.applied, 0);
  assert.equal(result.kept.length, 4);
});

test('regra 2: o deslocamento é em dias úteis do calendário da obra; nenhum bloco cai em dia sem trabalho', () => {
  const calendar: LobCalendar = { weekdays: [1, 2, 3, 4, 5], holidays: ['2027-03-26', '2027-04-02', '2027-04-21'] };
  const data = obra({ calendar });
  const result = planPackageMove(data.activities, data.dependencies, 'E', 7, calendar);
  const next = after(data, result.changed);
  for (const a of next) assert.ok(isWorkday(a.start, calendar), `${a.id} começa em dia útil`);
  for (let i = 0; i < 4; i++) assert.equal(startOf(next, `E${i}`), addWorkdays(startOf(data.activities, `E${i}`), 7, calendar));
});

test('o planejador responde vários deslocamentos a partir da mesma foto, igual a mover uma vez', () => {
  const data = obra({ slack: 2 });
  const planner = createPackageMovePlanner(data.activities, data.dependencies);
  for (const delta of [1, 5, -1, -2, -9, 12, 0])
    assert.deepEqual(planner.move('E', delta), planPackageMove(data.activities, data.dependencies, 'E', delta), `delta ${delta}`);
});

test('move_service: comando de datas, grava o pacote e as empurradas, recusa o que não anda', () => {
  const data = obra();
  const command: LobCommand = { type: 'move_service', workId: W, serviceId: 'E', deltaDays: 5 };
  assert.ok(isLobScheduleCommand(command));
  const mutation = planLobCommand(data, command, { actorId: 'u', now: NOW, today: TODAY, newId });
  assert.equal(mutation.update.activities.length, 8);
  assert.deepEqual(mutation.summary, { applied: 5, moved: 4, kept: 0, pushed: 4 });
  assert.throws(
    () => planLobCommand(data, { ...command, deltaDays: -2 }, { actorId: 'u', now: NOW, today: TODAY, newId }),
    /Não dá para antecipar: E · L0 já começa logo depois de R · L0\./,
  );
  assert.deepEqual(parseLobCommand({ type: 'move_service', workId: W, serviceId: 'E', deltaDays: '-3' }), {
    type: 'move_service',
    workId: W,
    serviceId: 'E',
    deltaDays: -3,
  });
  assert.throws(() => parseLobCommand({ type: 'move_service', workId: W, serviceId: 'E', deltaDays: 1.5 }), /Deslocamento inválido/);
});

// ─── Editar o pacote ────────────────────────────────────────────────────────────

const edit = (over: Partial<LobPackageEdit> = {}): LobPackageEdit => ({
  serviceId: 'E',
  localIds: LOCALS.map(l => l.id),
  rhythm: 'chain',
  lagDays: 0,
  rules: [{ serviceId: 'R', localOffset: 0, lagDays: 0 }],
  mode: 'replace',
  ...over,
});
const ctx = { workId: W, now: NOW, newId };

test('packageLogic resume a lógica de hoje (abre a janela com ela)', () => {
  const data = obra();
  const logic = packageLogic(data, 'E');
  assert.deepEqual(logic.external, [{ serviceId: 'R', localOffset: 0, lagDays: 0, count: 4 }]);
  assert.deepEqual(logic.internal, [{ lagDays: 0, count: 3 }]);
});

test('regras 8 e 9: duração nova e encadear trazem os locais para trás; as sucessoras ganham folga, não são puxadas', () => {
  // Reboco de 3 dias a cada 3 dias úteis: o E (5 dias) é o gargalo e encadeia pela equipe.
  const data = obra({ slack: 0 });
  const plan = planPackageEdit(data, edit({ durationDays: 3, rules: [] }), ctx);
  const next = after(data, plan.changed);
  assert.equal(next.find(a => a.id === 'E0')!.start, startOf(data.activities, 'E0'), 'o primeiro local fica');
  for (let i = 1; i < 4; i++) {
    const prev = next.find(a => a.id === `E${i - 1}`)!;
    const r = next.find(a => a.id === `R${i}`)!;
    const expected = [activityEnd(prev), activityEnd(r)].sort().pop()!;
    assert.equal(startOf(next, `E${i}`), expected, `E${i} encosta no anterior (ou no reboco)`);
    assert.equal(next.find(a => a.id === `E${i}`)!.durationDays, 3);
  }
  for (let i = 0; i < 4; i++) assert.equal(startOf(next, `I${i}`), startOf(data.activities, `I${i}`), `I${i} não é puxada`);
  assert.equal(plan.changedBlocks, 4);
  assert.equal(plan.pushed, 0);
  assert.ok(plan.slack.count > 0);
  assert.ok(plan.finishAfter < plan.finishBefore);
  assert.equal(plan.workFinishAfter, plan.workFinishBefore);
  // "Equipe segue" já existia com a mesma espera: nenhuma ligação muda.
  assert.deepEqual([plan.insert.length, plan.update.length, plan.remove.length], [0, 0, 0]);
});

test('regra 9: manter os inícios só muda a duração e empurra quem precisar', () => {
  const data = obra();
  const plan = planPackageEdit(data, edit({ durationDays: 8, rhythm: 'keep', rules: [] }), ctx);
  const next = after(data, plan.changed);
  assert.equal(startOf(next, 'E0'), startOf(data.activities, 'E0'));
  assert.ok(plan.pushed > 0, 'E mais longo empurra o pavimento seguinte e as infras');
  for (let i = 1; i < 4; i++) assert.ok(startOf(next, `E${i}`) >= activityEnd(next.find(a => a.id === `E${i - 1}`)!));
});

test('regra 10: substituir troca as ligações do pacote da regra e pula local sem correspondente', () => {
  const data = obra({ slack: 4 });
  const plan = planPackageEdit(data, edit({ rhythm: 'keep', rules: [{ serviceId: 'R', localOffset: -1, lagDays: 2 }] }), ctx);
  assert.deepEqual(plan.remove.sort(), ['R0>E0', 'R1>E1', 'R2>E2', 'R3>E3']);
  assert.deepEqual(plan.insert.map(d => `${d.predecessorId}>${d.successorId}:${d.lagDays}:${d.kind}`).sort(), [
    'R0>E1:2:fs',
    'R1>E2:2:fs',
    'R2>E3:2:fs',
  ]);
  assert.deepEqual(plan.skipped, [{ serviceId: 'R', localIds: ['L0'] }]);
});

test('regra 10: somar mantém as ligações atuais; a mesma ligação com outra espera vira atualização', () => {
  const data = obra({ slack: 4 });
  const plan = planPackageEdit(data, edit({ rhythm: 'keep', mode: 'add', rules: [{ serviceId: 'R', localOffset: 0, lagDays: 2 }] }), ctx);
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.insert, []);
  assert.deepEqual(plan.update.map(d => `${d.id}:${d.lagDays}`).sort(), ['R0>E0:2', 'R1>E1:2', 'R2>E2:2', 'R3>E3:2']);
});

test('regra 10: predecessora que fecharia um ciclo é recusada; do próprio pacote também', () => {
  const data = obra();
  assert.throws(() => planPackageEdit(data, edit({ rules: [{ serviceId: 'I', localOffset: 0, lagDays: 0 }] }), ctx), /fecha um ciclo/);
  assert.throws(() => planPackageEdit(data, edit({ rules: [{ serviceId: 'E', localOffset: -1, lagDays: 0 }] }), ctx), /outro pacote/);
});

test('regra 7: só os locais marcados; iniciados ficam de fora; nada a mudar é recusado', () => {
  const data = obra({ started: ['E0'] });
  const plan = planPackageEdit(data, edit({ localIds: ['L0', 'L1'], durationDays: 4, rules: [] }), ctx);
  assert.deepEqual(plan.blockIds, ['E1']);
  assert.deepEqual(plan.kept, ['E0']);
  assert.equal(plan.changed.find(a => a.id === 'E2')?.durationDays ?? 5, 5, 'E2 não marcado mantém a duração');
  assert.throws(() => planPackageEdit(data, edit({ localIds: ['L0'] }), ctx), /só têm blocos já iniciados/);
  assert.throws(() => planPackageEdit(obra(), edit(), ctx), /Nada a mudar/);
});

test('edit_service grava a linha de base automática, as ligações e as datas; revert_service_edit devolve tudo', () => {
  const data = obra({ slack: 4 });
  const context = { actorId: 'u', now: NOW, today: TODAY, newId };
  const command: LobCommand = {
    type: 'edit_service',
    workId: W,
    ...edit({ durationDays: 3, rules: [{ serviceId: 'R', localOffset: -1, lagDays: 1 }] }),
  };
  const mutation = planLobCommand(data, command, context);
  assert.equal(mutation.insert.baselines.length, 1);
  assert.equal(mutation.insert.baselines[0].name, 'Antes da edição do pacote 25/11/2026');
  assert.ok(mutation.insert.baselines[0].automatic);
  assert.equal(mutation.delete.dependencies.length, 4);
  assert.equal(mutation.insert.dependencies.length, 3);
  assert.ok(mutation.update.activities.length >= 4);
  assert.equal(mutation.summary?.linksAdded, 3);

  // Aplica na memória e desfaz.
  const removed = new Set(mutation.delete.dependencies);
  const changedActs = new Map(mutation.update.activities.map(a => [a.id, a]));
  const edited: LobData = {
    ...data,
    activities: data.activities.map(a => changedActs.get(a.id) ?? a),
    dependencies: [...data.dependencies.filter(d => !removed.has(d.id)), ...mutation.insert.dependencies],
    baselines: mutation.insert.baselines,
  };
  const revert = planLobCommand(
    edited,
    {
      type: 'revert_service_edit',
      workId: W,
      items: data.activities
        .filter(a => changedActs.has(a.id))
        .map(a => ({ activityId: a.id, start: a.start, durationDays: a.durationDays })),
      links: {
        remove: mutation.insert.dependencies.map(d => d.id),
        restore: data.dependencies.filter(d => removed.has(d.id)),
        update: [],
      },
    },
    context,
  );
  const back = new Map(revert.update.activities.map(a => [a.id, a]));
  for (const a of data.activities) {
    const b = back.get(a.id) ?? edited.activities.find(x => x.id === a.id)!;
    assert.equal(b.start, a.start, a.id);
    assert.equal(b.durationDays, a.durationDays, a.id);
  }
  assert.deepEqual(revert.delete.dependencies.sort(), mutation.insert.dependencies.map(d => d.id).sort());
  // A ligação volta com o mesmo id e a data de criação original (o script do Prevision depende dela).
  assert.deepEqual(
    revert.insert.dependencies.map(d => [d.id, d.createdAt]).sort(),
    data.dependencies
      .filter(d => removed.has(d.id))
      .map(d => [d.id, d.createdAt])
      .sort(),
  );
});

test('parseLobCommand: edit_service confere forma e limites', () => {
  const parsed = parseLobCommand({
    type: 'edit_service',
    workId: W,
    serviceId: 'E',
    localIds: ['L0', 'L0', 'L1'],
    durationDays: '',
    rules: [],
    lagDays: 0,
  });
  assert.deepEqual(parsed, {
    type: 'edit_service',
    workId: W,
    serviceId: 'E',
    localIds: ['L0', 'L1'],
    durationDays: undefined,
    rhythm: 'chain',
    lagDays: 0,
    rules: [],
    mode: 'replace',
  });
  assert.throws(
    () => parseLobCommand({ type: 'edit_service', workId: W, serviceId: 'E', localIds: [], rules: [] }),
    /Marque ao menos um local/,
  );
  assert.throws(
    () =>
      parseLobCommand({
        type: 'edit_service',
        workId: W,
        serviceId: 'E',
        localIds: ['L0'],
        rules: [{ serviceId: 'R', localOffset: 4, lagDays: 0 }],
      }),
    /até 3 locais/,
  );
  assert.throws(
    () =>
      parseLobCommand({
        type: 'edit_service',
        workId: W,
        serviceId: 'E',
        localIds: ['L0'],
        rules: [
          { serviceId: 'R', localOffset: 0, lagDays: 0 },
          { serviceId: 'R', localOffset: 0, lagDays: 2 },
        ],
      }),
    /aparece duas vezes/,
  );
});

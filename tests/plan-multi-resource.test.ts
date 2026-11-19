import test from 'node:test';
import assert from 'node:assert/strict';
import { setTaskTeamIds, taskTeamIds, type PlanTask, type Team } from '../src/domain/entities';
import { resourceRows, resourceTasks } from '../src/domain/resource-usage';
import { DEFAULT_CALENDAR } from '../src/domain/plan-schedule';
import { createMockData } from '../src/mocks/planning';
import { applyCommand } from '../src/application/use-cases/commands';
import { planSnapshot } from '../src/domain/plan-schedule';
import { planningDataToPayload, rowsToPlanningData, type Rows } from '../src/infrastructure/repositories/supabase/mappers';

const stamp = { createdAt: '2026-11-01T12:00:00Z', updatedAt: '2026-11-01T12:00:00Z' };
const task = (id: string, extra: Partial<PlanTask> = {}): PlanTask => ({
  id,
  ...stamp,
  planId: 'p',
  name: id,
  plannedStart: '2026-11-16',
  plannedEnd: '2026-11-20',
  duration: { value: 5, unit: 'd' },
  level: 0,
  order: 1,
  progress: 0,
  ...extra,
});
const team = (id: string): Team => ({ id, ...stamp, workId: 'obra-1', company: 'Empresa', name: id, weeklyCapacity: 1 });

test('mais de um recurso: o primeiro fica em teamId e os demais em extraTeamIds, sem repetir', () => {
  const t = task('a');
  assert.deepEqual(taskTeamIds(t), []);
  setTaskTeamIds(t, ['e1', 'e2', 'e1', 'e3']);
  assert.equal(t.teamId, 'e1');
  assert.deepEqual(t.extraTeamIds, ['e2', 'e3']);
  assert.deepEqual(taskTeamIds(t), ['e1', 'e2', 'e3']);
  // Voltar a um só (ou a nenhum) apaga a lista de adicionais.
  setTaskTeamIds(t, ['e2']);
  assert.equal(t.teamId, 'e2');
  assert.equal('extraTeamIds' in t, false);
  setTaskTeamIds(t, []);
  assert.equal(t.teamId, undefined);
  // Tarefa antiga, só com teamId, segue valendo.
  assert.deepEqual(taskTeamIds(task('b', { teamId: 'e1' })), ['e1']);
});

test('mais de um recurso: a tarefa ocupa a linha e a carga de cada equipe', () => {
  const tasks = [
    task('a', { order: 1, teamId: 'e1', extraTeamIds: ['e2'] }),
    task('b', { order: 2, teamId: 'e2' }),
    task('c', { order: 3 }),
  ];
  const rows = resourceRows(resourceTasks(tasks, new Map()), [team('e1'), team('e2')], DEFAULT_CALENDAR);
  const of = (id: string | null) => rows.find(r => (r.team?.id ?? null) === id)!;
  assert.deepEqual(
    of('e1').tasks.map(t => t.id),
    ['a'],
  );
  assert.deepEqual(
    of('e2')
      .tasks.map(t => t.id)
      .sort(),
    ['a', 'b'],
  );
  // e2 tem capacidade 1 e duas tarefas no mesmo período: superalocada. e1 não.
  assert.equal(of('e2').overallocated, true);
  assert.equal(of('e1').overallocated, false);
  // Só a tarefa sem recurso nenhum fica nas não atribuídas.
  assert.deepEqual(
    of(null).tasks.map(t => t.id),
    ['c'],
  );
});

test('mais de um recurso: o servidor grava, recusa equipe de fora e a ida e volta ao banco preserva', () => {
  const data = createMockData();
  const now = '2026-11-16T12:00:00Z';
  let n = 0;
  const context = { actorId: 'user-2', today: '2026-11-16', now, newId: () => `novo-${++n}` };
  const planId = applyCommand(data, { type: 'create_plan', workId: 'obra-1', month: '2026-11', name: 'Teste' }, context);
  const plan = data.plans.find(p => p.id === planId)!;
  const [e1, e2] = data.teams.filter(t => t.workId === 'obra-1');
  const row = { ...task('t1', { planId, teamId: e1.id, extraTeamIds: [e2.id, e1.id] }) };
  const save = (tasks: PlanTask[]) =>
    applyCommand(
      data,
      {
        type: 'save_plan_revision',
        planId,
        expectedSnapshot: planSnapshot(plan, data.planTasks, data.planDependencies),
        reason: 'Salvamento automático',
        tasks,
        links: [],
        calendar: DEFAULT_CALENDAR,
      },
      context,
    );
  save([row]);
  const saved = data.planTasks.find(t => t.id === 't1')!;
  assert.equal(saved.teamId, e1.id);
  assert.deepEqual(saved.extraTeamIds, [e2.id], 'o repetido sai');
  assert.throws(() => save([{ ...row, extraTeamIds: ['equipe-de-outra-obra'] }]), /Equipe deve pertencer à obra/);
  // Ida e volta pelo formato do banco: os adicionais moram no schedule_meta.
  const payload = planningDataToPayload(data);
  const stored = payload.plan_tasks.find(t => t.id === 't1')!;
  assert.deepEqual(stored.schedule_meta?.extraTeamIds, [e2.id]);
  const back = rowsToPlanningData(payload as unknown as Rows);
  assert.deepEqual(taskTeamIds(back.planTasks.find(t => t.id === 't1')!), [e1.id, e2.id]);
  // Equipe usada só como recurso adicional não pode ser excluída.
  assert.throws(() => applyCommand(data, { type: 'delete_team', teamId: e2.id }, context));
});

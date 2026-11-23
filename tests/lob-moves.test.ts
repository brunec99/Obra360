import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activityEnd,
  addWorkdays,
  createMovePlanner,
  moveActivity,
  nextWorkday,
  predecessorsOf,
  topologicalActivities,
  type LobActivity,
  type LobCalendar,
  type LobDependency,
} from '../src/domain/lob';
import { addDays } from '../src/domain/long-term-plan';
import { mergeActivities, planLobCommand } from '../src/application/use-cases/lob-commands';

/** Arrastar na Linha de Balanço (23/11/2026): a ordem topológica em O(V + E) e o planejador de
 * movimentos têm de dar EXATAMENTE o resultado das funções de antes, que ficam aqui como referência. */

const NOW = '2026-11-23T12:00:00.000Z';
const act = (id: string, start: string, durationDays = 5, over: Partial<LobActivity> = {}): LobActivity => ({
  id,
  workId: 'w',
  serviceId: `s-${id}`,
  localId: `l-${id}`,
  start,
  durationDays,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});
const dep = (predecessorId: string, successorId: string, lagDays = 0, kind: 'fs' | 'crew' = 'fs'): LobDependency => ({
  id: `${predecessorId}>${successorId}`,
  workId: 'w',
  predecessorId,
  successorId,
  lagDays,
  kind,
  createdAt: NOW,
});

// ─── Referência: as funções como eram antes de 23/11/2026 ───────────────────────

function oldTopological(activities: LobActivity[], dependencies: LobDependency[]): LobActivity[] {
  const ids = new Set(activities.map(a => a.id));
  const pending = new Map<string, Set<string>>(activities.map(a => [a.id, new Set()]));
  for (const d of dependencies)
    if (ids.has(d.predecessorId) && ids.has(d.successorId) && d.predecessorId !== d.successorId)
      pending.get(d.successorId)!.add(d.predecessorId);
  const byId = new Map(activities.map(a => [a.id, a]));
  const order: LobActivity[] = [];
  let ready = activities.filter(a => pending.get(a.id)!.size === 0).map(a => a.id);
  while (ready.length) {
    const next: string[] = [];
    for (const id of ready) {
      order.push(byId.get(id)!);
      for (const [other, preds] of pending) if (preds.delete(id) && preds.size === 0) next.push(other);
    }
    ready = next;
  }
  return order;
}
function oldMinimum(id: string, activities: Map<string, LobActivity>, preds: Map<string, LobDependency[]>, calendar?: LobCalendar) {
  let best: string | undefined;
  for (const d of preds.get(id) ?? []) {
    const p = activities.get(d.predecessorId);
    if (!p) continue;
    const candidate = addWorkdays(activityEnd(p, calendar), d.lagDays, calendar);
    if (!best || candidate > best) best = candidate;
  }
  return best;
}
function oldCascade(activities: LobActivity[], dependencies: LobDependency[], calendar?: LobCalendar): LobActivity[] {
  const next = new Map(activities.map(a => [a.id, { ...a }]));
  const preds = predecessorsOf(dependencies);
  const changed: LobActivity[] = [];
  for (const original of oldTopological(activities, dependencies)) {
    const a = next.get(original.id)!;
    const minimum = oldMinimum(a.id, next, preds, calendar);
    if (minimum && minimum > a.start) {
      a.start = minimum;
      changed.push(a);
    }
  }
  return changed;
}
function oldMove(
  activities: LobActivity[],
  dependencies: LobDependency[],
  id: string,
  start: string,
  durationDays?: number,
  calendar?: LobCalendar,
): LobActivity[] {
  const byId = new Map(activities.map(a => [a.id, { ...a }]));
  const target = byId.get(id);
  if (!target) return [];
  const preds = predecessorsOf(dependencies);
  const minimum = oldMinimum(id, byId, preds, calendar);
  const wanted = nextWorkday(start, calendar);
  target.start = minimum && minimum > wanted ? minimum : wanted;
  if (durationDays !== undefined) target.durationDays = durationDays;
  const pushed = oldCascade([...byId.values()], dependencies, calendar);
  const result = new Map(pushed.map(a => [a.id, a]));
  const original = activities.find(a => a.id === id)!;
  if (target.start !== original.start || target.durationDays !== original.durationDays) result.set(id, result.get(id) ?? target);
  return [...result.values()];
}

// ─── Redes de teste ─────────────────────────────────────────────────────────────

/** Gerador determinístico (mulberry32). */
function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
/** Rede aleatória: blocos fora de ordem, datas que às vezes violam a predecessora (como numa obra
 * importada), esperas negativas, ligação repetida, ligação com bloco que não existe e, se pedido, um ciclo. */
function randomNetwork(seed: number, size: number, withCycle = false) {
  const random = rng(seed);
  const int = (n: number) => Math.floor(random() * n);
  const activities: LobActivity[] = [];
  for (let i = 0; i < size; i++) activities.push(act(`a${i}`, nextWorkday(addDays('2026-01-05', int(120))), 1 + int(12)));
  // Embaralha: a ordem da lista não é a topológica.
  for (let i = activities.length - 1; i > 0; i--) {
    const j = int(i + 1);
    [activities[i], activities[j]] = [activities[j], activities[i]];
  }
  const dependencies: LobDependency[] = [];
  const edges = Math.floor(size * 2);
  for (let k = 0; k < edges; k++) {
    const from = int(size - 1);
    const to = from + 1 + int(Math.min(8, size - 1 - from));
    dependencies.push({ ...dep(`a${from}`, `a${to}`, int(7) - 2, random() < 0.5 ? 'crew' : 'fs'), id: `d${k}` });
  }
  dependencies.push({ ...dep('a0', 'fantasma'), id: 'solta' });
  if (withCycle && size > 6) {
    dependencies.push({ ...dep('a5', 'a4'), id: 'c1' }, { ...dep('a4', 'a3'), id: 'c2' }, { ...dep('a3', 'a5'), id: 'c3' });
  }
  return { activities, dependencies };
}
const CALENDARS: (LobCalendar | undefined)[] = [
  undefined,
  { weekdays: [1, 2, 3, 4, 5, 6], holidays: ['2026-02-16', '2026-02-17', '2026-04-03', '2026-04-21', '2026-05-01'] },
];
const dates = (list: LobActivity[]) => list.map(a => `${a.id}:${a.start}:${a.durationDays}`);

test('ordem topológica: O(V + E) devolve a mesma ordem da varredura antiga, com ciclo, ligação repetida e bloco inexistente', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const { activities, dependencies } = randomNetwork(seed, 10 + (seed % 7) * 15, seed % 3 === 0);
    assert.deepEqual(
      topologicalActivities(activities, dependencies).map(a => a.id),
      oldTopological(activities, dependencies).map(a => a.id),
      `semente ${seed}`,
    );
  }
  // Ciclo puro: ninguém entra na ordem.
  assert.deepEqual(topologicalActivities([act('x', '2026-01-05'), act('y', '2026-01-05')], [dep('x', 'y'), dep('y', 'x')]), []);
});

test('moveActivity: o planejador dá o mesmo resultado, na mesma ordem, da função antiga', () => {
  let compared = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const { activities, dependencies } = randomNetwork(seed * 7, 12 + (seed % 5) * 20, seed % 4 === 0);
    const calendar = CALENDARS[seed % CALENDARS.length];
    const random = rng(seed);
    for (let k = 0; k < 12; k++) {
      const target = activities[Math.floor(random() * activities.length)];
      const start = addDays('2026-01-01', Math.floor(random() * 160));
      const duration = random() < 0.3 ? 1 + Math.floor(random() * 15) : undefined;
      assert.deepEqual(
        dates(moveActivity(activities, dependencies, target.id, start, duration, calendar)),
        dates(oldMove(activities, dependencies, target.id, start, duration, calendar)),
        `semente ${seed}, movimento ${k}`,
      );
      compared++;
    }
  }
  assert.equal(compared, 360);
  assert.deepEqual(moveActivity([act('a', '2026-01-05')], [], 'nao-existe', '2026-01-06'), []);
});

test('planejador: vários movimentos sobre a mesma foto, cada um igual ao cálculo isolado, sem alterar a foto', () => {
  const { activities, dependencies } = randomNetwork(99, 80);
  const frozen = JSON.stringify(activities);
  const planner = createMovePlanner(activities, dependencies);
  // Um arrasto: o mesmo bloco, um dia de cada vez, para a frente e de volta.
  const target = activities[10];
  for (let day = 0; day < 40; day++) {
    const start = addDays('2026-01-05', day < 25 ? day * 3 : (40 - day) * 3);
    assert.deepEqual(dates(planner.move(target.id, start)), dates(oldMove(activities, dependencies, target.id, start)), `dia ${day}`);
  }
  // E blocos diferentes pelo mesmo planejador (cada movimento parte da foto, não do anterior).
  for (const a of activities.slice(0, 20))
    assert.deepEqual(dates(planner.move(a.id, '2026-06-01', 3)), dates(oldMove(activities, dependencies, a.id, '2026-06-01', 3)));
  assert.equal(JSON.stringify(activities), frozen);
});

test('planejador: o bloco para no fim das predecessoras, as sucessoras são empurradas e ninguém é puxado para trás', () => {
  // A (seg 05/01, 5 d) → B (seg 12/01, 5 d) → C (seg 19/01, 5 d); D solto.
  const activities = [act('a', '2026-01-05'), act('b', '2026-01-12'), act('c', '2026-01-19'), act('d', '2026-01-05')];
  const dependencies = [dep('a', 'b'), dep('b', 'c')];
  const planner = createMovePlanner(activities, dependencies);
  // B dois dias úteis para a frente: C acompanha; A e D ficam.
  assert.deepEqual(dates(planner.move('b', '2026-01-14')), ['c:2026-01-21:5', 'b:2026-01-14:5']);
  // B para antes do fim de A: para no mínimo (onde já estava) e nada muda.
  assert.deepEqual(planner.move('b', '2026-01-07'), []);
  // A para trás: ninguém é puxado junto.
  assert.deepEqual(dates(planner.move('a', '2025-12-29')), ['a:2025-12-29:5']);
  // Esticar A empurra a cadeia inteira.
  assert.deepEqual(dates(planner.move('a', '2026-01-05', 7)), ['b:2026-01-14:5', 'c:2026-01-21:5', 'a:2026-01-05:7']);
});

test('tela e servidor: aplicar a prévia do arrasto dá a mesma obra que o comando gravaria, com o calendário da obra', () => {
  const { activities, dependencies } = randomNetwork(7, 60);
  const calendar = CALENDARS[1];
  const data = {
    locals: [],
    services: [],
    activities,
    dependencies,
    baselines: [],
    launches: [],
    measurements: [],
    items: [],
    photos: [],
    costs: [],
    calendar,
  };
  const planner = createMovePlanner(activities, dependencies, calendar);
  for (const target of activities.slice(0, 15)) {
    const preview = planner.move(target.id, '2026-03-02');
    const mutation = planLobCommand(
      data,
      { type: 'update_activity', activityId: target.id, start: '2026-03-02' },
      { actorId: 'u', now: NOW, newId: () => 'x' },
    );
    // O comando sempre grava o próprio bloco (carimbo), mesmo sem mudar de data: compara as datas da obra.
    assert.deepEqual(dates(mergeActivities(activities, mutation.update.activities)), dates(mergeActivities(activities, preview)));
  }
});

// ─── Desempenho: obra do tamanho do Atmos ───────────────────────────────────────

/** 13 serviços × 47 locais = 611 blocos; "equipe segue" entre locais e precedência entre serviços
 * no mesmo local: 598 + 564 = 1.162 dependências (o Atmos tem 606 blocos, 1.196 dependências e 48 locais). */
function atmosLike() {
  const services = 13,
    locals = 47;
  const activities: LobActivity[] = [];
  const dependencies: LobDependency[] = [];
  const id = (s: number, l: number) => `s${s}l${l}`;
  for (let s = 0; s < services; s++)
    for (let l = 0; l < locals; l++) {
      activities.push(act(id(s, l), addWorkdays('2026-01-05', s * 10 + l * 5), 5 + (s % 3) * 5, { serviceId: `s${s}`, localId: `l${l}` }));
      if (l > 0) dependencies.push(dep(id(s, l - 1), id(s, l), 0, 'crew'));
      if (s > 0) dependencies.push(dep(id(s - 1, l), id(s, l), 0, 'fs'));
    }
  return { activities, dependencies };
}
const time = (runs: number, task: () => void) => {
  const started = performance.now();
  for (let i = 0; i < runs; i++) task();
  return (performance.now() - started) / runs;
};

test('desempenho: arrastar o primeiro bloco de uma obra do tamanho do Atmos custa poucos milissegundos por dia', () => {
  const { activities, dependencies } = atmosLike();
  assert.equal(activities.length, 611);
  assert.equal(dependencies.length, 1162);
  const first = activities[0].id;
  const calendar: LobCalendar = { weekdays: [1, 2, 3, 4, 5], holidays: ['2026-04-03', '2026-04-21', '2026-05-01', '2026-09-07'] };
  // Aquecimento.
  oldMove(activities, dependencies, first, '2026-01-12', undefined, calendar);
  moveActivity(activities, dependencies, first, '2026-01-12', undefined, calendar);

  const oldTopo = time(20, () => oldTopological(activities, dependencies));
  const newTopo = time(20, () => topologicalActivities(activities, dependencies));
  const oldOne = time(10, () => oldMove(activities, dependencies, first, '2026-01-12', undefined, calendar));
  const newOne = time(10, () => moveActivity(activities, dependencies, first, '2026-01-12', undefined, calendar));
  const build = time(10, () => createMovePlanner(activities, dependencies, calendar).move(first, '2026-01-06'));
  const planner = createMovePlanner(activities, dependencies, calendar);
  planner.move(first, '2026-01-06');
  let day = 0;
  // O pior caso: o primeiro bloco empurra quase a obra inteira, um dia útil por vez.
  const perDay = time(60, () => planner.move(first, addWorkdays('2026-01-06', day++ % 30, calendar)));
  const moved = planner.move(first, '2026-01-12').length;
  const ms = (n: number) => `${n.toFixed(2)} ms`;
  console.log(
    `[LOB 611 blocos / 1.162 dependências] ordem topológica: antes ${ms(oldTopo)}, agora ${ms(newTopo)} · ` +
      `mover um bloco (cálculo completo, como no servidor): antes ${ms(oldOne)}, agora ${ms(newOne)} · ` +
      `arrasto no navegador: montar a rede + 1º dia ${ms(build)}, cada dia seguinte ${ms(perDay)} (${moved} blocos deslocados)`,
  );
  assert.ok(moved >= 600, `o primeiro bloco deveria empurrar quase a obra inteira; empurrou ${moved}`);
  // Sozinho, cada dia leva ~5 ms; com a suíte inteira em paralelo, ~9 ms. O teto é folgado de propósito
  // (máquina de CI carregada): o que importa é não voltar a custar muitas dezenas de ms por dia.
  assert.ok(perDay < 50, `cada dia do arrasto levou ${ms(perDay)}`);
  assert.ok(newTopo < oldTopo, 'a ordem topológica nova não pode ser mais lenta que a antiga');
});

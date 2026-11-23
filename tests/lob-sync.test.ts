import test from 'node:test';
import assert from 'node:assert/strict';
import { LobApiError, LobSession, type LobCommandResult, type LobSnapshot } from '../src/modules/longo-prazo/lob/lob-api';
import { isLobScheduleCommand, mergeActivities, planLobCommand } from '../src/application/use-cases/lob-commands';
import type { LobActivity, LobCommand, LobData, LobDependency, LobResponse } from '../src/domain/lob';

/** A sessão da Linha de Balanço no navegador (23/11/2026): mover um bloco aparece na hora, grava em
 * segundo plano, em fila, e a tela converge para o servidor (inclusive quando ele recusa ou diverge). */

const NOW = '2026-11-23T12:00:00.000Z';
const act = (id: string, start: string, durationDays = 5): LobActivity => ({
  id,
  workId: 'w',
  serviceId: `s-${id}`,
  localId: `l-${id}`,
  start,
  durationDays,
  createdAt: NOW,
  updatedAt: NOW,
});
const dep = (predecessorId: string, successorId: string): LobDependency => ({
  id: `${predecessorId}>${successorId}`,
  workId: 'w',
  predecessorId,
  successorId,
  lagDays: 0,
  kind: 'fs',
  createdAt: NOW,
});
/** A (seg 02/11) → B (seg 09/11) → C (seg 16/11); D solto. */
const initial = (): LobData => ({
  locals: [],
  services: [],
  activities: [act('a', '2026-11-02'), act('b', '2026-11-09'), act('c', '2026-11-16'), act('d', '2026-11-02')],
  dependencies: [dep('a', 'b'), dep('b', 'c')],
  baselines: [],
  launches: [],
  measurements: [],
  items: [],
  photos: [],
  costs: [],
});

/** Servidor de mentira: guarda a obra, aplica as mesmas regras e responde quando o teste libera. */
function fakeServer(data: LobData = initial()) {
  const state = { data, fetches: 0, sent: [] as LobCommand[], inFlight: 0, maxInFlight: 0 };
  const gates: (() => void)[] = [];
  let hold = false;
  const failures: Error[] = [];
  const wait = () => (hold ? new Promise<void>(resolve => gates.push(resolve)) : Promise.resolve());
  const full = (): LobResponse => ({ available: true, ...state.data, costAccess: 'full' });
  return {
    state,
    /** Com `true`, cada envio fica parado até `release()`. */
    holdSends(value: boolean) {
      hold = value;
    },
    release() {
      gates.shift()?.();
    },
    /** O próximo envio falha com este erro (sem gravar). */
    failNext(error: Error) {
      failures.push(error);
    },
    /** Outra pessoa mexeu na obra por fora. */
    edit(change: (data: LobData) => LobData) {
      state.data = change(state.data);
    },
    transport: {
      fetch: async () => {
        state.fetches += 1;
        return full();
      },
      send: async (command: LobCommand): Promise<LobCommandResult> => {
        state.sent.push(command);
        state.inFlight += 1;
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
        try {
          await wait();
          const failure = failures.shift();
          if (failure) throw failure;
          let mutation;
          try {
            mutation = planLobCommand(state.data, command, {
              actorId: 'u',
              now: '2026-11-23T13:00:00.000Z',
              today: '2026-11-23',
              newId: () => 'n',
            });
          } catch (error) {
            throw new LobApiError(error instanceof Error ? error.message : 'recusado', 400);
          }
          state.data = {
            ...state.data,
            activities: mergeActivities(state.data.activities, mutation.update.activities),
            baselines: [...state.data.baselines, ...mutation.insert.baselines],
          };
          return isLobScheduleCommand(command) ? { available: true, partial: true, activities: mutation.update.activities } : full();
        } finally {
          state.inFlight -= 1;
        }
      },
    },
  };
}
async function ready(server = fakeServer()) {
  const snapshots: LobSnapshot[] = [];
  const session = new LobSession(
    server.transport,
    snapshot => snapshots.push(snapshot),
    () => NOW,
  );
  await session.load();
  return { server, session, snapshots };
}
const starts = (snapshot: LobSnapshot) =>
  snapshot.state.status === 'ready' ? Object.fromEntries(snapshot.state.data.activities.map(a => [a.id, a.start])) : undefined;
const activities = (snapshot: LobSnapshot) => (snapshot.state.status === 'ready' ? snapshot.state.data.activities : []);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('mover: o bloco e as sucessoras mudam na tela na hora, antes de o servidor responder', async () => {
  const { server, session, snapshots } = await ready();
  server.holdSends(true);
  const before = activities(session.snapshot);
  const emitted = snapshots.length;
  const { previous, done } = session.dispatch({ type: 'update_activity', activityId: 'b', start: '2026-11-11' });
  // Já na tela, com a gravação ainda parada no servidor.
  assert.deepEqual(starts(session.snapshot), { a: '2026-11-02', b: '2026-11-11', c: '2026-11-18', d: '2026-11-02' });
  assert.equal(session.snapshot.sync, 'saving');
  assert.deepEqual(starts({ state: { status: 'ready', data: server.state.data, costAccess: 'full' }, sync: 'idle' })?.b, '2026-11-09');
  // As datas de antes, para o "Desfazer": o bloco e a sucessora empurrada.
  assert.deepEqual(
    previous.sort((x, y) => x.id.localeCompare(y.id)),
    [
      { id: 'b', start: '2026-11-09', durationDays: 5 },
      { id: 'c', start: '2026-11-16', durationDays: 5 },
    ],
  );
  // Quem não mudou continua o MESMO objeto: o gráfico só redesenha as linhas afetadas.
  const now = activities(session.snapshot);
  assert.equal(now[0], before[0]);
  assert.equal(now[3], before[3]);
  assert.notEqual(now[1], before[1]);
  await tick();
  server.release();
  await done;
  // O servidor gravou o que a tela previu: nada é relido e os blocos da tela nem trocam de objeto.
  assert.equal(server.state.fetches, 1);
  assert.equal(activities(session.snapshot), now);
  assert.equal(session.snapshot.sync, 'saved');
  assert.deepEqual(
    starts(session.snapshot),
    starts({ state: { status: 'ready', data: server.state.data, costAccess: 'full' }, sync: 'idle' }),
  );
  // Avisos à tela: a alteração (junto com "salvando") e o "salvo". A obra não foi reenviada na confirmação.
  assert.ok(snapshots.length - emitted <= 3);
});

test('dois arrastos seguidos: vão ao servidor um de cada vez, na ordem, e a tela termina igual a ele', async () => {
  const { server, session } = await ready();
  server.holdSends(true);
  const first = session.dispatch({ type: 'update_activity', activityId: 'a', start: '2026-11-04' });
  const second = session.dispatch({ type: 'update_activity', activityId: 'd', start: '2026-11-10' });
  // Os dois já estão na tela, o segundo calculado por cima do primeiro.
  assert.deepEqual(starts(session.snapshot), { a: '2026-11-04', b: '2026-11-11', c: '2026-11-18', d: '2026-11-10' });
  await tick();
  assert.equal(server.state.sent.length, 1, 'o segundo comando espera o primeiro');
  server.release();
  await first.done;
  await tick();
  assert.equal(server.state.sent.length, 2);
  server.release();
  await second.done;
  assert.equal(server.state.maxInFlight, 1);
  assert.deepEqual(
    server.state.sent.map(c => c.type === 'update_activity' && c.activityId),
    ['a', 'd'],
  );
  assert.deepEqual(starts(session.snapshot), Object.fromEntries(server.state.data.activities.map(a => [a.id, a.start])));
  assert.equal(server.state.fetches, 1, 'nenhuma releitura: a tela previu os dois resultados');
  assert.equal(session.snapshot.sync, 'saved');
});

test('o servidor recusa: a tela volta ao estado confirmado, o erro chega a quem pediu e o que vinha atrás continua valendo', async () => {
  const { server, session } = await ready();
  server.holdSends(true);
  server.failNext(new LobApiError('O servidor recusou.', 400));
  const refused = session.dispatch({ type: 'update_activity', activityId: 'b', start: '2026-11-11' });
  const kept = session.dispatch({ type: 'update_activity', activityId: 'd', start: '2026-11-10' });
  assert.deepEqual(starts(session.snapshot), { a: '2026-11-02', b: '2026-11-11', c: '2026-11-18', d: '2026-11-10' });
  await tick();
  server.release();
  await assert.rejects(refused.done, /recusou/);
  // B e C voltaram; o movimento de D, ainda na fila, continua na tela.
  assert.deepEqual(starts(session.snapshot), { a: '2026-11-02', b: '2026-11-09', c: '2026-11-16', d: '2026-11-10' });
  await tick();
  server.release();
  await kept.done;
  assert.deepEqual(starts(session.snapshot), Object.fromEntries(server.state.data.activities.map(a => [a.id, a.start])));
  assert.equal(server.state.fetches, 1, 'recusa das regras não precisa reler a obra');
  // A fila terminou com um erro no meio: o indicador avisa.
  assert.equal(session.snapshot.sync, 'error');
  // O próximo comando que der certo limpa o aviso.
  server.holdSends(false);
  await session.dispatch({ type: 'update_activity', activityId: 'd', start: '2026-11-11' }).done;
  assert.equal(session.snapshot.sync, 'saved');
});

test('falha de rede ou do servidor: como não dá para saber se gravou, a obra é relida', async () => {
  const { server, session } = await ready();
  server.failNext(new LobApiError('Não foi possível gravar a alteração. Tente novamente.', 502));
  const { done } = session.dispatch({ type: 'update_activity', activityId: 'b', start: '2026-11-11' });
  assert.equal(starts(session.snapshot)?.b, '2026-11-11');
  await assert.rejects(done, /Não foi possível gravar/);
  assert.equal(server.state.fetches, 2);
  assert.deepEqual(starts(session.snapshot), { a: '2026-11-02', b: '2026-11-09', c: '2026-11-16', d: '2026-11-02' });
});

test('o servidor grava diferente do previsto (outra pessoa mexeu na obra): a tela recarrega e fica igual a ele', async () => {
  const { server, session } = await ready();
  // Por fora, alguém esticou A: no servidor, B não pode mais começar em 10/11.
  server.edit(data => ({ ...data, activities: data.activities.map(a => (a.id === 'a' ? { ...a, durationDays: 10 } : a)) }));
  const { done } = session.dispatch({ type: 'update_activity', activityId: 'b', start: '2026-11-10' });
  assert.equal(starts(session.snapshot)?.b, '2026-11-10');
  await done;
  assert.equal(server.state.fetches, 2, 'divergiu: relê a obra');
  assert.deepEqual(starts(session.snapshot), Object.fromEntries(server.state.data.activities.map(a => [a.id, a.start])));
  assert.equal(starts(session.snapshot)?.b, '2026-11-16');
  assert.equal(activities(session.snapshot).find(a => a.id === 'a')?.durationDays, 10);
});

test('recusa imediata: comando que as regras não aceitam lança na hora e não muda nada nem vai ao servidor', async () => {
  const { server, session, snapshots } = await ready();
  const emitted = snapshots.length;
  assert.throws(() => session.dispatch({ type: 'update_activity', activityId: 'nao-existe', start: '2026-11-11' }), /não encontrado/);
  assert.equal(snapshots.length, emitted);
  assert.equal(server.state.sent.length, 0);
  // Antes de carregar, não há o que aplicar.
  const loading = new LobSession(fakeServer().transport, () => undefined);
  assert.throws(() => loading.dispatch({ type: 'update_activity', activityId: 'a', start: '2026-11-11' }), /carregando/);
});

test('desfazer: devolve as datas de vários blocos numa gravação só, também na hora', async () => {
  const { server, session } = await ready();
  const moved = session.dispatch({ type: 'update_activity', activityId: 'a', start: '2026-11-09' });
  await moved.done;
  assert.deepEqual(starts(session.snapshot), { a: '2026-11-09', b: '2026-11-16', c: '2026-11-23', d: '2026-11-02' });
  assert.equal(moved.previous.length, 3);
  server.holdSends(true);
  const undone = session.dispatch({
    type: 'set_activity_dates',
    workId: 'w',
    items: moved.previous.map(p => ({ activityId: p.id, start: p.start, durationDays: p.durationDays })),
  });
  assert.deepEqual(starts(session.snapshot), { a: '2026-11-02', b: '2026-11-09', c: '2026-11-16', d: '2026-11-02' });
  await tick();
  server.release();
  await undone.done;
  assert.equal(server.state.sent.length, 2, 'uma gravação para o arrasto e uma para o desfazer');
  assert.deepEqual(starts(session.snapshot), Object.fromEntries(server.state.data.activities.map(a => [a.id, a.start])));
  assert.equal(server.state.fetches, 1);
});

test('comando comum depois de um arrasto: espera a vez na fila e a obra inteira que volta não desfaz o arrasto', async () => {
  const { server, session } = await ready();
  server.holdSends(true);
  const moved = session.dispatch({ type: 'update_activity', activityId: 'b', start: '2026-11-11' });
  const saved = session.execute({ type: 'create_baseline', workId: 'w', name: 'Depois do arrasto' });
  await tick();
  assert.equal(server.state.sent.length, 1);
  server.release();
  await moved.done;
  await tick();
  server.release();
  const response = await saved;
  assert.ok(response.available && response.baselines.length === 1);
  // A linha de base foi fotografada DEPOIS do movimento, e a tela tem os dois.
  assert.equal(server.state.data.baselines[0].snapshot.find(e => e.activityId === 'b')?.start, '2026-11-11');
  assert.equal(starts(session.snapshot)?.b, '2026-11-11');
  assert.equal(session.snapshot.state.status === 'ready' && session.snapshot.state.data.baselines.length, 1);
  // `execute` com comando de datas também funciona (o painel do bloco usa): aplica na hora e devolve a obra.
  server.holdSends(false);
  const result = await session.execute({ type: 'update_activity', activityId: 'd', durationDays: 8 });
  assert.equal(result.available && result.activities.find(a => a.id === 'd')?.durationDays, 8);
});

test('sessão descartada (obra trocada): para de avisar a tela', async () => {
  const { session, snapshots } = await ready();
  const emitted = snapshots.length;
  session.dispose();
  await session.dispatch({ type: 'update_activity', activityId: 'b', start: '2026-11-11' }).done;
  assert.equal(snapshots.length, emitted);
});

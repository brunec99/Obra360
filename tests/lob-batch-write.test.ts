import test from 'node:test';
import assert from 'node:assert/strict';
import type { LobMutation } from '../src/application/use-cases/lob-commands';
import type { LobActivity } from '../src/domain/lob';

/** Gravação em lote dos blocos (23/11/2026): uma cascata de centenas de blocos vira UMA requisição ao
 * banco, não uma por bloco. O cliente do Supabase é o real, com o `fetch` trocado: nada sai da máquina. */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://supabase.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'chave-de-teste';

const NOW = '2026-11-23T12:00:00.000Z';
const act = (i: number, workId = 'w'): LobActivity => ({
  id: `a${i}`,
  workId,
  serviceId: 's1',
  localId: `l${i}`,
  start: '2026-11-02',
  durationDays: 5,
  notes: i === 0 ? 'obs' : undefined,
  createdAt: NOW,
  updatedAt: NOW,
});
const emptySet = () => ({
  locals: [],
  services: [],
  activities: [] as LobActivity[],
  dependencies: [],
  baselines: [],
  launches: [],
  measurements: [],
  items: [],
  photos: [],
  costs: [],
});
const mutationOf = (activities: LobActivity[]): LobMutation => ({
  workId: 'w',
  insert: emptySet(),
  update: { ...emptySet(), activities },
  delete: {
    locals: [],
    services: [],
    activities: [],
    dependencies: [],
    baselines: [],
    launches: [],
    measurements: [],
    items: [],
    photos: [],
    costs: [],
  },
  removeFiles: [],
});

interface Call {
  method: string;
  url: URL;
  body: unknown;
  prefer: string;
}
async function withFetch<T>(
  respond: (call: Call) => Response,
  task: () => Promise<T>,
): Promise<{ result?: T; error?: unknown; calls: Call[] }> {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined;
    const headers = new Headers(init?.headers ?? request?.headers);
    const raw = init?.body ?? (request ? await request.text() : undefined);
    const call: Call = {
      method: init?.method ?? request?.method ?? 'GET',
      url: new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url),
      body: typeof raw === 'string' && raw ? JSON.parse(raw) : undefined,
      prefer: headers.get('Prefer') ?? '',
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  try {
    return { result: await task(), calls };
  } catch (error) {
    return { error, calls };
  } finally {
    globalThis.fetch = original;
  }
}
const ok = () => new Response(null, { status: 201 });
/** O que o banco devolve no upsert: `id` e `created_at` de cada linha gravada (o `created_at` que já estava lá). */
const echo = (call: Call, createdAt: (id: string) => string = () => NOW) =>
  new Response(JSON.stringify((call.body as { id: string }[]).map(row => ({ id: row.id, created_at: createdAt(row.id) }))), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  });

test('blocos alterados: 606 blocos vão numa requisição só, por upsert no id, com a linha inteira e a obra', async () => {
  const { applyLobMutation } = await import('../src/infrastructure/repositories/supabase/lob-repository');
  const activities = Array.from({ length: 606 }, (_, i) => act(i));
  const { error, calls } = await withFetch(echo, () => applyLobMutation(mutationOf(activities)));
  assert.equal(error, undefined);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.method, 'POST');
  assert.equal(call.url.pathname, '/rest/v1/lob_activities');
  assert.equal(call.url.searchParams.get('on_conflict'), 'id');
  assert.match(call.prefer, /resolution=merge-duplicates/);
  // A resposta traz `id` e `created_at` de cada linha, para acusar bloco recriado.
  assert.match(call.prefer, /return=representation/);
  assert.equal(call.url.searchParams.get('select'), 'id,created_at');
  const rows = call.body as Record<string, unknown>[];
  assert.equal(rows.length, 606);
  assert.deepEqual(rows[0], {
    id: 'a0',
    work_id: 'w',
    service_id: 's1',
    local_id: 'l0',
    start_on: '2026-11-02',
    duration_days: 5,
    actual_start: null,
    actual_finish: null,
    notes: 'obs',
    launch_id: null,
    updated_at: NOW,
  });
  // `created_at` não vai na gravação: na linha que existe ele fica como está; todas as outras colunas
  // NOT NULL da tabela (0038) vão.
  assert.ok(rows.every(row => !('created_at' in row)));
  assert.equal(call.url.searchParams.get('columns')?.includes('created_at'), false);
  assert.ok(rows.every(row => row.work_id === 'w'));
});

test('blocos alterados: acima de mil vai em blocos de mil; nada a gravar não chama o banco', async () => {
  const { applyLobMutation } = await import('../src/infrastructure/repositories/supabase/lob-repository');
  const many = await withFetch(ok, () => applyLobMutation(mutationOf(Array.from({ length: 2300 }, (_, i) => act(i)))));
  assert.deepEqual(
    many.calls.map(call => (call.body as unknown[]).length),
    [1000, 1000, 300],
  );
  const none = await withFetch(ok, () => applyLobMutation(mutationOf([])));
  assert.equal(none.calls.length, 0);
});

test('blocos alterados: bloco de outra obra na gravação é recusado antes de chegar ao banco; erro de chave vira conflito', async () => {
  const { applyLobMutation, LobConflictError } = await import('../src/infrastructure/repositories/supabase/lob-repository');
  const foreign = await withFetch(ok, () => applyLobMutation(mutationOf([act(1), act(2, 'outra-obra')])));
  assert.ok(foreign.error instanceof LobConflictError);
  assert.equal(foreign.calls.length, 0);
  // O serviço do bloco foi apagado por outra pessoa no meio: a chave estrangeira recusa (23503).
  const broken = await withFetch(
    () => new Response(JSON.stringify({ code: '23503', message: 'violates foreign key constraint' }), { status: 409 }),
    () => applyLobMutation(mutationOf([act(1)])),
  );
  assert.ok(broken.error instanceof LobConflictError);
});

test('blocos alterados: bloco apagado por outra pessoa e recriado pelo upsert é apagado de novo e o comando sai como conflito', async () => {
  const { applyLobMutation, LobConflictError, recreatedRows } = await import('../src/infrastructure/repositories/supabase/lob-repository');
  // O banco devolve o `created_at` que estava lá (no formato dele, com microssegundos); o bloco a2 não
  // existia mais e nasceu de novo agora.
  const stored = '2026-11-23T12:00:00.000000+00:00';
  const reborn = '2026-11-23T15:04:05.123456+00:00';
  const { error, calls } = await withFetch(
    call => (call.method === 'POST' ? echo(call, id => (id === 'a2' ? reborn : stored)) : new Response(null, { status: 204 })),
    () => applyLobMutation(mutationOf([act(1), act(2), act(3)])),
  );
  assert.ok(error instanceof LobConflictError);
  assert.deepEqual(
    calls.map(call => call.method),
    ['POST', 'DELETE'],
  );
  const remove = calls[1].url;
  assert.equal(remove.pathname, '/rest/v1/lob_activities');
  assert.deepEqual(
    ['id', 'work_id', 'created_at'].map(key => remove.searchParams.get(key)),
    ['eq.a2', 'eq.w', `eq.${reborn}`],
  );
  // Mesmo instante em formatos diferentes não é recriação; linha sem resposta ou com data ilegível também não.
  assert.deepEqual(recreatedRows([act(1), act(2)], [{ id: 'a1', created_at: stored }]), []);
  assert.deepEqual(recreatedRows([act(1)], [{ id: 'a1', created_at: 'sem data' }]), []);
  assert.deepEqual(recreatedRows([act(1)], [{ id: 'a1', created_at: reborn }]), [{ id: 'a1', created_at: reborn }]);
});

test('linha de base automática vai antes de qualquer mudança: falha no meio deixa a foto das datas salva', async () => {
  const { applyLobMutation } = await import('../src/infrastructure/repositories/supabase/lob-repository');
  const mutation = mutationOf([act(0)]);
  mutation.insert.baselines = [
    { id: 'b1', workId: 'w', name: 'Antes da edição do pacote', automatic: true, createdBy: 'u', createdAt: NOW, snapshot: [] },
  ];
  mutation.delete.dependencies = ['d1'];
  const { error, calls } = await withFetch(
    call => (call.method === 'DELETE' ? new Response('falhou', { status: 500 }) : echo(call)),
    () => applyLobMutation(mutation),
  );
  assert.ok(error);
  assert.deepEqual(
    calls.map(call => `${call.method} ${call.url.pathname}`),
    ['POST /rest/v1/lob_baselines', 'DELETE /rest/v1/lob_dependencies'],
  );
});

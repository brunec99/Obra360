import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { applyCommand, type CommandContext } from '../src/application/use-cases/commands';
import { applyCommandLocally } from '../src/application/use-cases/local-apply';
import { accessBatchChange } from '../src/application/module-access';
import { getPlanning } from '../src/application/use-cases/get-planning';
import { createMockData } from '../src/mocks/planning';

/** Administrador vê todas as obras (24/11/2026): a regra nos comandos e nos gatilhos da migração 0058,
 * estes num PostgreSQL em memória com todas as migrações. Nenhum banco externo é acessado. */

let id = 0;
const context = (actorId: string): CommandContext => ({
  actorId,
  today: '2026-11-24',
  now: '2026-11-24T12:00:00Z',
  newId: () => `aw-${++id}`,
});
const data = () => {
  const d = createMockData();
  d.users.push({ id: 'admin-1', createdAt: '', updatedAt: '', name: 'Admin', role: 'admin', workIds: d.works.map(w => w.id) });
  d.users.push({ id: 'admin-2', createdAt: '', updatedAt: '', name: 'Outra admin', role: 'admin', workIds: [] });
  d.users.push({ id: 'gestor-1', createdAt: '', updatedAt: '', name: 'Gestor', role: 'manager', workIds: [] });
  return d;
};
const worksOf = (d: ReturnType<typeof data>, userId: string) => [...d.users.find(u => u.id === userId)!.workIds].sort();

test('obra cadastrada por um gestor entra para todos os administradores', () => {
  const d = data();
  const workId = applyCommand(d, { type: 'create_work', name: 'Bioma', code: 'BIO' }, context('gestor-1'));
  const all = d.works.map(w => w.id).sort();
  assert.ok(all.includes(workId));
  assert.deepEqual(worksOf(d, 'admin-1'), all);
  assert.deepEqual(worksOf(d, 'admin-2'), all);
  assert.deepEqual(worksOf(d, 'gestor-1'), [workId], 'quem não é admin segue só com as obras liberadas');
});

test('quem vira administrador recebe todas as obras; revogar obra de admin é recusado', () => {
  const d = data();
  applyCommand(d, { type: 'set_role', userId: 'gestor-1', role: 'admin' }, context('admin-1'));
  assert.deepEqual(worksOf(d, 'gestor-1'), d.works.map(w => w.id).sort());
  assert.throws(
    () => applyCommand(d, { type: 'revoke_access', userId: 'gestor-1', workId: d.works[0].id }, context('admin-1')),
    /Administradores veem todas as obras/,
  );
  applyCommand(d, { type: 'set_access_batch', userIds: ['gestor-1'], workIds: [d.works[0].id], enabled: false }, context('admin-1'));
  assert.deepEqual(worksOf(d, 'gestor-1'), d.works.map(w => w.id).sort(), 'o lote não tira obra de admin');
});

test('lote e projeção local seguem a mesma regra', async () => {
  assert.equal(accessBatchChange({ role: 'admin', workIds: ['a', 'b'] }, { workIds: ['a'], enabled: false }), null);
  assert.deepEqual(accessBatchChange({ role: 'planner', workIds: ['a', 'b'] }, { workIds: ['a'], enabled: false }), { workIds: ['b'] });
  const d = data();
  const planning = await getPlanning(
    { getSnapshot: async () => d, transaction: async () => undefined as never, commit: async () => undefined as never },
    '2026-11-24',
  );
  const next = applyCommandLocally(
    planning,
    { type: 'set_role', userId: 'gestor-1', role: 'admin' },
    'gestor-1',
    'admin-1',
    '2026-11-24T12:00:00Z',
  );
  assert.deepEqual([...next!.data.users.find(u => u.id === 'gestor-1')!.workIds].sort(), d.works.map(w => w.id).sort());
});

const ADMIN = '00000000-0000-4000-8000-000000000001';
const ADMIN_2 = '00000000-0000-4000-8000-000000000002';
const PLANNER = '00000000-0000-4000-8000-000000000003';
const STAMP = '2026-10-01T12:00:00Z';

async function database(until?: string) {
  const db = new PGlite();
  await db.exec(
    'create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users(id uuid primary key); create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); create table storage.objects(id uuid,bucket_id text,name text);',
  );
  for (const file of fs
    .readdirSync('supabase/migrations')
    .filter(name => name.endsWith('.sql') && (!until || name < until))
    .sort())
    await db.exec(fs.readFileSync(`supabase/migrations/${file}`, 'utf8'));
  return db;
}
const work = (db: PGlite, workId: string, code: string) =>
  db.query('insert into works (id, created_at, updated_at, name, code) values ($1, $2, $2, $3, $4)', [workId, STAMP, code, code]);
const profile = async (db: PGlite, userId: string, role: string, workIds: string[]) => {
  await db.query('insert into auth.users (id) values ($1)', [userId]);
  await db.query('insert into profiles (id, name, role, work_ids) values ($1, $2, $3, $4)', [userId, role, role, workIds]);
};
const access = async (db: PGlite, userId: string) =>
  (await db.query<{ work_ids: string[] }>('select work_ids from profiles where id = $1', [userId])).rows[0].work_ids;

test('0058: a migração acerta os administradores que já existem e não mexe nos demais', async () => {
  const db = await database('0058');
  await work(db, 'w1', 'BLT');
  await work(db, 'w2', 'BIO');
  await profile(db, ADMIN, 'admin', ['w1']);
  await profile(db, PLANNER, 'planner', ['w1']);
  await db.exec(fs.readFileSync('supabase/migrations/0058_admin_all_works.sql', 'utf8'));
  assert.deepEqual(await access(db, ADMIN), ['w1', 'w2']);
  assert.deepEqual(await access(db, PLANNER), ['w1']);
  // Rodar de novo não duplica nada.
  await db.exec(fs.readFileSync('supabase/migrations/0058_admin_all_works.sql', 'utf8'));
  assert.deepEqual(await access(db, ADMIN), ['w1', 'w2']);
});

test('0058: obra nova, perfil novo, promoção e revogação direta mantêm o admin com todas as obras', async () => {
  const db = await database();
  await work(db, 'w1', 'BLT');
  await profile(db, ADMIN, 'admin', []);
  await profile(db, PLANNER, 'planner', []);
  assert.deepEqual(await access(db, ADMIN), ['w1'], 'perfil admin novo já nasce com as obras');
  await work(db, 'w2', 'BIO');
  assert.deepEqual(await access(db, ADMIN), ['w1', 'w2'], 'obra nova entra para o admin');
  assert.deepEqual(await access(db, PLANNER), [], 'e não entra para quem não é admin');
  await db.query("update profiles set work_ids = '{w2}' where id = $1", [ADMIN]);
  assert.deepEqual((await access(db, ADMIN)).sort(), ['w1', 'w2'], 'gravação que tira obra de admin é completada');
  await db.query("update profiles set role = 'admin' where id = $1", [PLANNER]);
  assert.deepEqual(await access(db, PLANNER), ['w1', 'w2'], 'quem vira admin recebe todas');
  await db.query("update profiles set role = 'planner' where id = $1", [PLANNER]);
  await db.query("update profiles set work_ids = '{}' where id = $1", [PLANNER]);
  assert.deepEqual(await access(db, PLANNER), [], 'deixou de ser admin: as obras voltam a ser por pessoa');
});

test('0058: a obra excluída por delete_work sai do perfil dos administradores', async () => {
  const db = await database();
  await work(db, 'w1', 'BLT');
  await work(db, 'w2', 'BIO');
  await profile(db, ADMIN, 'admin', []);
  await profile(db, ADMIN_2, 'admin', []);
  await db.query('select delete_work($1, $2, $3)', ['w2', 'BIO', ADMIN]);
  assert.deepEqual(await access(db, ADMIN), ['w1']);
  assert.deepEqual(await access(db, ADMIN_2), ['w1']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { PORTAL_APP_SLUG, RPC_USO_UNICO, origensDoApp, trocarTokenDoPortal } from '../src/infrastructure/auth/portal-login';
import { assinarTokenV2 } from '../src/infrastructure/portal-kit/core/ssoV2.mjs';

// Entrada pelo Portal Inteligência: token ES256 gerado na hora, cliente do Supabase falso (sem rede).

const ORIGEM = 'https://obra360.exemplo.com.br';
const silencioso = { log() {}, warn() {}, error() {} };

async function parDeChaves() {
  const par = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const privada = { ...(await crypto.subtle.exportKey('jwk', par.privateKey)), kid: 'teste-1' };
  const { d: _d, ...publica } = privada;
  return { privada, jwks: JSON.stringify({ keys: [{ ...publica, kid: 'teste-1' }] }) };
}

async function token(privada: JsonWebKey & { kid: string }, extra: Record<string, unknown> = {}) {
  const agora = Math.floor(Date.now() / 1000);
  return assinarTokenV2(privada, {
    v: 2,
    iss: 'portal-inteligencia',
    aud: PORTAL_APP_SLUG,
    app_slug: PORTAL_APP_SLUG,
    scope: 'sso',
    jti: crypto.randomUUID(),
    iat: agora,
    exp: agora + 300,
    sub: crypto.randomUUID(),
    email: 'Fulano@AtrIncorporadora.com.br',
    full_name: 'Fulano',
    portal_role: 'user',
    ...extra,
  });
}

type Conta = { id: string; email: string; email_confirmed_at: string; app_metadata: Record<string, unknown>; created_at: string };

/** Cliente falso: contas do Auth, perfis do Obra 360 e a tabela de uso único. Registra o que foi chamado. */
function clienteFalso({ contas = [] as Conta[], perfis = [] as { id: string; role: string }[] } = {}) {
  const usados = new Set<string>();
  const chamadas = { createUser: 0, generateLink: 0, gravacoesPerfil: 0, rpc: [] as string[] };
  const cliente = {
    auth: {
      admin: {
        async listUsers() {
          return { data: { users: contas }, error: null };
        },
        async getUserById(id: string) {
          const user = contas.find(c => c.id === id);
          return user ? { data: { user }, error: null } : { data: { user: null }, error: { status: 404, message: 'User not found' } };
        },
        async createUser() {
          chamadas.createUser++;
          return { data: { user: null }, error: { message: 'não devia criar' } };
        },
        async generateLink({ email }: { email: string }) {
          chamadas.generateLink++;
          return { data: { properties: { hashed_token: `hash-de-${email}` } }, error: null };
        },
      },
    },
    async rpc(nome: string, args: { p_token_hash: string }) {
      chamadas.rpc.push(nome);
      if (usados.has(args.p_token_hash)) return { data: false, error: null };
      usados.add(args.p_token_hash);
      return { data: true, error: null };
    },
    schema() {
      return cliente;
    },
    from(tabela: string) {
      assert.equal(tabela, 'profiles');
      const consulta = {
        _id: '',
        select() {
          return consulta;
        },
        eq(_coluna: string, valor: string) {
          consulta._id = valor;
          return consulta;
        },
        async maybeSingle() {
          return { data: perfis.find(p => p.id === consulta._id) ?? null, error: null };
        },
        update() {
          chamadas.gravacoesPerfil++;
          return consulta;
        },
        insert() {
          chamadas.gravacoesPerfil++;
          return consulta;
        },
      };
      return consulta;
    },
  };
  return { criarCliente: () => cliente, chamadas };
}

const conta = (email: string, extra: Partial<Conta> = {}): Conta => ({
  id: crypto.randomUUID(),
  email,
  email_confirmed_at: '2026-10-01T00:00:00Z',
  app_metadata: { providers: ['google'] },
  created_at: '2026-10-01T00:00:00Z',
  ...extra,
});

async function cenario(opcoes: Parameters<typeof clienteFalso>[0] = {}) {
  const { privada, jwks } = await parDeChaves();
  const falso = clienteFalso(opcoes);
  const env = {
    PUBLIC_SITE_URL: ORIGEM,
    NEXT_PUBLIC_SUPABASE_URL: 'https://projeto.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'chave-de-servico',
    PORTAL_SSO_V2_JWKS: jwks,
  };
  const trocar = (t: unknown, origem = ORIGEM) =>
    trocarTokenDoPortal(t, { origem, env, criarCliente: falso.criarCliente as never, log: silencioso });
  return { privada, trocar, chamadas: falso.chamadas };
}

test('com conta e perfil no Obra 360, entra: devolve o token_hash do magic link e não grava no perfil', async () => {
  const c = conta('fulano@atrincorporadora.com.br');
  const { privada, trocar, chamadas } = await cenario({ contas: [c], perfis: [{ id: c.id, role: 'planner' }] });
  const r = await trocar(await token(privada));
  assert.deepEqual(r, { ok: true, email: 'fulano@atrincorporadora.com.br', tokenHash: 'hash-de-fulano@atrincorporadora.com.br' });
  assert.equal(chamadas.gravacoesPerfil, 0);
  assert.deepEqual(chamadas.rpc, [RPC_USO_UNICO.nome]);
});

test('o mesmo token não entra duas vezes', async () => {
  const c = conta('fulano@atrincorporadora.com.br');
  const { privada, trocar } = await cenario({ contas: [c], perfis: [{ id: c.id, role: 'viewer' }] });
  const t = await token(privada);
  assert.equal((await trocar(t)).ok, true);
  const segunda = await trocar(t);
  assert.equal(segunda.ok, false);
  assert.equal(!segunda.ok && segunda.code, 'token_ja_usado');
});

test('e-mail sem conta no Auth: recusa sem criar conta (o Auth é dividido com o Takt Hub) e sem queimar o token', async () => {
  const { privada, trocar, chamadas } = await cenario();
  const r = await trocar(await token(privada));
  assert.equal(!r.ok && r.code, 'perfil_ausente');
  assert.equal(chamadas.createUser, 0);
  assert.deepEqual(chamadas.rpc, []);
});

test('conta sem perfil do Obra 360 (ex.: só do Takt): recusa, sem magic link nem perfil novo', async () => {
  const c = conta('alguem@taktengenharia.com.br');
  const { privada, trocar, chamadas } = await cenario({ contas: [c] });
  const r = await trocar(await token(privada, { email: c.email }));
  assert.equal(!r.ok && r.status, 403);
  assert.equal(chamadas.generateLink, 0);
  assert.equal(chamadas.gravacoesPerfil, 0);
});

test('conta recente com senha e sem origem comprovada: recusa (pré-sequestro)', async () => {
  const c = conta('fulano@atrincorporadora.com.br', { app_metadata: { providers: ['email'] }, created_at: new Date().toISOString() });
  const { privada, trocar, chamadas } = await cenario({ contas: [c], perfis: [{ id: c.id, role: 'admin' }] });
  const r = await trocar(await token(privada));
  assert.equal(!r.ok && r.code, 'conta_nao_verificada');
  assert.equal(chamadas.generateLink, 0);
});

test('token de outro sistema do Portal é recusado', async () => {
  const c = conta('fulano@atrincorporadora.com.br');
  const { privada, trocar } = await cenario({ contas: [c], perfis: [{ id: c.id, role: 'admin' }] });
  const r = await trocar(await token(privada, { aud: 'mapa-bi', app_slug: 'mapa-bi' }));
  assert.equal(!r.ok && r.status, 401);
});

test('token assinado por outra chave, vencido ou ausente é recusado', async () => {
  const c = conta('fulano@atrincorporadora.com.br');
  const { trocar } = await cenario({ contas: [c], perfis: [{ id: c.id, role: 'admin' }] });
  const outra = await parDeChaves();
  assert.equal((await trocar(await token(outra.privada))).ok, false);
  const { privada, trocar: trocar2 } = await cenario({ contas: [c], perfis: [{ id: c.id, role: 'admin' }] });
  const vencido = await token(privada, { iat: 1_700_000_000, exp: 1_700_000_100 });
  assert.equal((await trocar2(vencido)).ok, false);
  assert.equal(!((await trocar2('')) as { ok: boolean }).ok, true);
  assert.equal(((await trocar2(undefined)) as { code?: string }).code, 'token_ausente');
});

test('origem que não é a do Obra 360 não troca token (configuração)', async () => {
  const c = conta('fulano@atrincorporadora.com.br');
  const { privada, trocar } = await cenario({ contas: [c], perfis: [{ id: c.id, role: 'admin' }] });
  const r = await trocar(await token(privada), 'https://atacante.example');
  assert.equal(!r.ok && r.code, 'config');
});

test('origensDoApp: só https, sem repetição, com o endereço oficial primeiro', () => {
  assert.deepEqual(
    origensDoApp({ PUBLIC_SITE_URL: 'https://obra360.x.com.br/', PORTAL_ORIGENS_APP: ' https://teste.x.com.br ,http://inseguro.x, https://obra360.x.com.br' }),
    ['https://obra360.x.com.br', 'https://teste.x.com.br'],
  );
});

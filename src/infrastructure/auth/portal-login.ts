/** Entrada pelo Portal Inteligência da ATR (login único).
 *
 * O Portal abre `/portal-login?token=<JWT ES256 de 5 min, de uso único>`. Este módulo troca o token por
 * uma sessão do Supabase usando o pacote padrão dos sistemas da ATR (`../portal-kit`, cópia conferida por
 * hash; nunca editar lá dentro). O kit faz a verificação do token, o uso único, a conferência da conta e
 * gera o magic link; aqui fica só o que é do Obra 360:
 *
 * - **Quem entra é decidido pelo Obra 360, não pelo Portal.** O Portal só libera o sistema para a pessoa;
 *   sem perfil em `profiles` (o cadastro em Configurações), a entrada é recusada como no login com Google.
 * - **Nenhuma conta é criada no Auth.** O projeto do Supabase é dividido com o Takt Hub: uma conta criada
 *   aqui poderia valer lá. Por isso a conta é procurada ANTES de chamar o kit (que criaria uma conta para
 *   e-mail desconhecido); como `profiles.id` referencia `auth.users`, quem tem perfil sempre tem conta.
 * - **Nada é gravado no perfil.** Papel, obras e módulos continuam sendo do admin do Obra 360.
 * - A sessão é criada no servidor (`verifyOtp` com o `token_hash`), igual ao link de convite em
 *   `/auth/callback`; o navegador nunca segue o link do Supabase.
 *
 * Funções sem estado global: quem chama passa o ambiente e o cliente do Supabase, para os testes rodarem
 * sem rede. */
import { createClient } from '@supabase/supabase-js';
import { criarReceptorPortal } from '../portal-kit/server/receptor.mjs';
import type { AdaptadorPerfil, ConfigReceptor } from '../portal-kit/server/receptor.d.mts';
import { acharUsuarioPorEmail } from '../portal-kit/server/usuarios.mjs';
import { ErroTokenPortal, lerChavesPublicas, verificarTokenPortal } from '../portal-kit/core/ssoV2.mjs';

/** Identificador do Obra 360 no Portal (`portal.apps.slug`); o token só vale com `aud` igual a ele. */
export const PORTAL_APP_SLUG = 'obra360';

/** Endereços do Portal (só CORS; nunca viram destino de redirecionamento). */
const ORIGENS_PORTAL = ['https://inteligencia.atrincorporadora.com.br', 'https://portal.atrincorporadora.com.br'];

/** Contas criadas antes deste instante podem entrar pelo Portal mesmo sem marca de origem (ver
 * `motivoContaConfiavel` no kit). O cadastro aberto está desligado no projeto dividido, e as contas do
 * Obra 360 nascem pelo Google ou por convite (aceitas pelo kit em qualquer data). ATUALIZAR para o
 * instante logo antes da publicação em produção. */
export const CORTE_CONTA_EXISTENTE = '2026-11-21T00:00:00Z';

/** Função de uso único do token no banco (migração 0055), com nome próprio: o projeto é dividido. */
export const RPC_USO_UNICO = { schema: 'public', nome: 'obra360_consumir_token_sso' } as const;

export const MENSAGENS_PORTAL = {
  semToken: 'Link de acesso sem token. Volte ao Portal Inteligência e entre de novo.',
  tokenInvalido: 'O link do Portal expirou ou não é válido. Volte ao Portal Inteligência e entre de novo.',
  tokenJaUsado: 'Este link do Portal já foi usado. Volte ao Portal Inteligência e entre de novo.',
  semCadastro: 'Seu e-mail ainda não foi cadastrado no Obra 360. Peça o cadastro a um administrador do Obra 360.',
  contaNaoVerificada: 'Não foi possível confirmar a sua conta. Peça ajuda a um administrador do Obra 360.',
  indisponivel: 'Não foi possível entrar pelo Portal agora. Tente de novo em instantes.',
  config: 'A entrada pelo Portal ainda não está configurada neste endereço.',
} as const;

/** Perfil do Obra 360 (`public.profiles`: id, name, role, work_ids, module_access). Sem e-mail na tabela,
 * então a conta é achada pela lista do Auth (`tabelaPerfil: null`). Sem perfil = sem acesso. */
export function perfilObra360(): AdaptadorPerfil {
  return {
    tipo: 'obra360Profiles',
    tabela: 'profiles',
    schema: 'public',
    busca: { tabelaPerfil: null },
    esperarGatilhoMs: 0,
    semPerfilEmContaExistente: 'recusar',
    campoPapelResposta: 'role',
    // Perfil novo nunca nasce pelo Portal (ver `primeiroAcesso`).
    papelInicial: () => null,
    async ler(admin, usuario) {
      const { data, error } = await admin.from('profiles').select('id, role').eq('id', usuario.id).maybeSingle();
      if (error) throw error;
      // Conta criada agora pelo kit (só numa corrida em que a conta sumiu entre a conferência e a troca):
      // sem perfil, cai como bloqueada e nada é gravado.
      return { existe: Boolean(data), bloqueado: !data, papelLocal: (data?.role as string | undefined) ?? null };
    },
    async primeiroAcesso() {
      // Nunca deveria chegar aqui: sem perfil a entrada é recusada antes. Lançar vira 503 (falha fechada).
      throw new Error('obra360: primeiro acesso pelo Portal não cria perfil');
    },
    async atualizarIdentidade() {
      // O nome no Obra 360 é do admin; o Portal não sobrescreve.
    },
  };
}

type Env = Record<string, string | undefined>;

/** Endereços do próprio Obra 360 aceitos pelo kit: o oficial (`PUBLIC_SITE_URL`) e os de
 * `PORTAL_ORIGENS_APP` (lista separada por vírgula, ex.: o endereço de teste). */
export function origensDoApp(env: Env): string[] {
  const lista = [env.PUBLIC_SITE_URL, ...(env.PORTAL_ORIGENS_APP ?? '').split(',')]
    .map(v => v?.trim())
    .filter((v): v is string => Boolean(v))
    .map(v => {
      try {
        return new URL(v).origin;
      } catch {
        return '';
      }
    })
    .filter(v => v.startsWith('https://'));
  return [...new Set(lista)];
}

export function configDoReceptor(env: Env, criarCliente: ConfigReceptor['criarCliente'] = createClient): ConfigReceptor {
  const origensApp = origensDoApp(env);
  return {
    appSlug: PORTAL_APP_SLUG,
    origensApp,
    origemPadrao: origensApp[0],
    origensExtras: ORIGENS_PORTAL,
    exigirOrigem: true,
    env: { get: (nome: string) => (nome === 'SUPABASE_URL' ? env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL : env[nome]) },
    criarCliente,
    rpcUsoUnico: RPC_USO_UNICO,
    perfil: perfilObra360(),
    corteContaExistente: CORTE_CONTA_EXISTENTE,
    // Só a marca do kit, convite, conta só-Google ou anterior ao corte provam o e-mail.
    origensConfiaveis: [],
    mensagens: {
      bloqueado: MENSAGENS_PORTAL.semCadastro,
      perfilAusente: MENSAGENS_PORTAL.semCadastro,
    },
  };
}

export type ResultadoTroca =
  | { ok: true; email: string; tokenHash: string }
  | { ok: false; status: number; code: string; mensagem: string };

const falha = (status: number, code: string, mensagem: string): ResultadoTroca => ({ ok: false, status, code, mensagem });

/** Troca o token do Portal pelo `token_hash` do magic link (para `verifyOtp`). Nunca lança: qualquer
 * erro inesperado vira `indisponivel` (503). `origem` é o endereço público pelo qual o navegador chegou. */
export async function trocarTokenDoPortal(
  token: unknown,
  { origem, env = process.env, criarCliente = createClient, log = console }: {
    origem: string;
    env?: Env;
    criarCliente?: ConfigReceptor['criarCliente'];
    log?: Pick<Console, 'log' | 'warn' | 'error'>;
  },
): Promise<ResultadoTroca> {
  try {
    if (typeof token !== 'string' || token === '') return falha(401, 'token_ausente', MENSAGENS_PORTAL.semToken);
    if (token.length > 4096) return falha(401, 'formato_invalido', MENSAGENS_PORTAL.tokenInvalido);
    const config = configDoReceptor(env, criarCliente);
    if (config.origensApp.length === 0 || !config.origensApp.includes(origem)) {
      log.error(`[${PORTAL_APP_SLUG}] portal-login: origem ${origem} fora de PUBLIC_SITE_URL/PORTAL_ORIGENS_APP`);
      return falha(500, 'config', MENSAGENS_PORTAL.config);
    }
    const supabaseUrl = config.env!.get('SUPABASE_URL');
    const chaveServico = env.SUPABASE_SERVICE_ROLE_KEY;
    let chaves: Map<string, CryptoKey>;
    try {
      chaves = await lerChavesPublicas(env.PORTAL_SSO_V2_JWKS ?? '');
    } catch (err) {
      log.error(`[${PORTAL_APP_SLUG}] portal-login: PORTAL_SSO_V2_JWKS inválido`, err);
      return falha(500, 'config', MENSAGENS_PORTAL.config);
    }
    if (!supabaseUrl || !chaveServico) return falha(500, 'config', MENSAGENS_PORTAL.config);

    // 1. Conferência prévia, sem queimar o token: assinatura, prazo, app e e-mail.
    let email: string;
    try {
      const { payload } = await verificarTokenPortal(token, { chaves, audiencias: [PORTAL_APP_SLUG], escopo: 'sso' });
      if (payload.app_slug !== PORTAL_APP_SLUG) return falha(403, 'app_invalido', MENSAGENS_PORTAL.tokenInvalido);
      email = String(payload.email ?? '').trim().toLowerCase();
    } catch (err) {
      if (err instanceof ErroTokenPortal) return falha(401, err.codigo, MENSAGENS_PORTAL.tokenInvalido);
      throw err;
    }

    // 2. Sem conta no Auth = sem perfil no Obra 360: recusa aqui, antes de o kit criar a conta.
    const admin = criarCliente(supabaseUrl, chaveServico, { auth: { persistSession: false, autoRefreshToken: false } });
    const conta = await acharUsuarioPorEmail(admin, email, { tabelaPerfil: null });
    if (!conta) return falha(403, 'perfil_ausente', MENSAGENS_PORTAL.semCadastro);

    // 3. Troca pelo kit (uso único, conta confiável, perfil, magic link).
    const receptor = criarReceptorPortal({ ...config, log });
    const resposta = await receptor(
      new Request(`${origem}/portal-login`, {
        method: 'POST',
        headers: { origin: origem, 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      }),
    );
    const corpo = (await resposta.json().catch(() => ({}))) as { verify_url?: string; code?: string };
    if (resposta.status !== 200) {
      const code = corpo.code ?? 'indisponivel';
      if (code === 'token_ja_usado') return falha(401, code, MENSAGENS_PORTAL.tokenJaUsado);
      if (code === 'perfil_ausente' || code === 'acesso_bloqueado') return falha(403, code, MENSAGENS_PORTAL.semCadastro);
      if (code === 'conta_nao_verificada' || code === 'conta_nao_confirmada') return falha(403, code, MENSAGENS_PORTAL.contaNaoVerificada);
      if (resposta.status === 401) return falha(401, code, MENSAGENS_PORTAL.tokenInvalido);
      return falha(resposta.status >= 500 ? 503 : resposta.status, code, MENSAGENS_PORTAL.indisponivel);
    }
    const tokenHash = corpo.verify_url ? new URL(corpo.verify_url).searchParams.get('token') : null;
    if (!tokenHash) {
      log.error(`[${PORTAL_APP_SLUG}] portal-login: resposta do kit sem token no verify_url`);
      return falha(503, 'indisponivel', MENSAGENS_PORTAL.indisponivel);
    }
    return { ok: true, email, tokenHash };
  } catch (err) {
    log.error(`[${PORTAL_APP_SLUG}] portal-login: erro inesperado`, err);
    return falha(503, 'indisponivel', MENSAGENS_PORTAL.indisponivel);
  }
}

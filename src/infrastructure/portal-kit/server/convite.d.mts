// Tipos de server/convite.mjs (@atr/portal-kit), escritos à mão, sem dependência.

import type { UsuarioAuth } from './usuarios.d.mts'

/**
 * Cliente supabase-js criado com a chave anônima e o `Authorization` de quem pede: tudo o que ele lê
 * passa pelas policies do app COMO O USUÁRIO. `any` de propósito: o kit não depende dos tipos do supabase-js.
 */
// deno-lint-ignore no-explicit-any
export type ClienteComoUsuario = any

/**
 * O que o gestor passa como 3º argumento do `criarCliente`, e nada além disso: sem sessão guardada e,
 * no cliente de quem pede, o `Authorization` do pedido. O `createClient` do supabase-js 2.x aceita sem cast.
 */
export interface OpcoesClienteDoConvite {
  auth: { persistSession: boolean; autoRefreshToken: boolean }
  global?: { headers: Record<string, string> }
}

/** Log injetado. Só evento, ação, status e código: nunca e-mail, nome, token, segredo, assinatura ou corpo. */
export type LogDoConvite = Pick<Console, 'log' | 'error'>

/** Códigos de `{ ok: false, code }`. */
export type CodigoDoGestorDeConvites =
  | 'metodo_nao_permitido'
  | 'sem_sessao'
  | 'nao_gere_usuarios'
  | 'requisicao_invalida'
  | 'acao_invalida'
  | 'email_invalido'
  | 'nome_invalido'
  | 'papel_invalido'
  | 'convidar_a_si_mesmo'
  | 'extras_invalidos'
  | 'nao_encontrado'
  | 'convite_ja_enviado'
  | 'convite_expirado'
  | 'convite_cancelado'
  | 'convite_desconhecido'
  | 'ja_entrou'
  | 'bloqueado_no_app'
  | 'limite'
  | 'portal_indisponivel'
  | 'canal_nao_configurado'
  | 'indisponivel'

/** Os códigos de `CodigoDoGestorDeConvites`, na ordem do status. */
export const CODIGOS_DO_GESTOR_DE_CONVITES: readonly CodigoDoGestorDeConvites[]

/** Colunas da linha local que saem da função: id, email, papel, extras, estado, criado_em, vale_ate, convite_expira_em, aplicado_em. */
export const COLUNAS_PUBLICAS_DO_CONVITE: readonly string[]

export type EstadoDoConvite = 'pendente' | 'aplicado' | 'cancelado' | 'expirado'

/** A linha de convite como a função a devolve (só as colunas públicas). */
export interface ConviteDoApp {
  /** Id da linha LOCAL: é o que `reenviar` e `cancelar` recebem. */
  id: string
  email: string
  papel: string
  extras: Record<string, unknown> | null
  /** Estado LOCAL. O estado do convite no Portal nunca aparece. */
  estado: EstadoDoConvite
  criado_em: string
  /** Fim da pré-aprovação local (criação + validade, renovada no reenvio até o teto de 3 × a validade). */
  vale_ate: string
  /** Fim do link, como o Portal devolveu no último envio. */
  convite_expira_em: string | null
  aplicado_em: string | null
}

/** Corpo do pedido à função. `id` é o da linha local. O que vier em `por` é ignorado: quem convida sai da sessão. */
export type PedidoDeConvite =
  | { acao: 'listar' }
  | { acao: 'criar'; email: string; papel: string; nome?: string | null; extras?: Record<string, unknown> | null }
  | { acao: 'reenviar'; id: string }
  | { acao: 'cancelar'; id: string }

/** Respostas 200. */
export interface RespostaListarConvites { ok: true; convites: ConviteDoApp[]; /** Hora do servidor (ISO). */ agora: string }
export interface RespostaCriarConvite {
  ok: true
  convite: ConviteDoApp
  /** Saiu e-mail NESTA chamada. `false` = o envio falhou depois de gravar, ou não havia o que mandar (ver `repetido`). */
  email_enviado: boolean
  /** `true` = o Portal devolveu um convite que já era deste app (criar repetido): não havia o que mandar. */
  repetido: boolean
}
export interface RespostaReenviarConvite {
  ok: true
  convite: ConviteDoApp
  /** `false` = o envio falhou, ou o convite já foi aceito ou encerrado no Portal (nada a mandar). */
  email_enviado: boolean
}
export interface RespostaCancelarConvite { ok: true; convite: ConviteDoApp }
export interface RecusaDoGestorDeConvites { ok: false; code: CodigoDoGestorDeConvites }

/** O que `validarExtras` recebe além dos extras. */
export interface ContextoDosExtras {
  papel: string
  usuario: UsuarioAuth
  comoUsuario: ClienteComoUsuario
}

export interface ConfigGestorDeConvites {
  /** Slug do Portal deste app. */
  appSlug: string
  /** Fonte que assina a chamada (cabeçalho `x-atr-fonte`): 'hub' | 'lnyu' | 'nf' | 'rh' | 'srkb'. */
  fonte: string
  /** URL https da função `portal-convite` do Portal. Constante da config; nunca vem do pedido. */
  urlPortal: string
  /** `createClient` do supabase-js do app. */
  // deno-lint-ignore no-explicit-any
  criarCliente: (url: string, chave: string, opcoes: OpcoesClienteDoConvite) => any
  /** Origens do app (CORS). `https://host[:porta]`, sem barra final. */
  origensApp: string[]
  /**
   * Régua do app: quem pede gere usuários? Recebe o cliente COMO O USUÁRIO e a conta da sessão conferida.
   * Só `true` passa. Erro de consulta tem de LANÇAR (vira 503): não é "gere" nem "não gere".
   */
  quemGere: (comoUsuario: ClienteComoUsuario, usuario: UsuarioAuth) => boolean | Promise<boolean>
  /** Lista FECHADA dos papéis que podem ser convidados. Nunca contém o papel de topo. */
  papeis: readonly string[]
  /** O papel de topo do app, que nunca pode ser convidado (D6-04). Se estiver em `papeis`, a fábrica lança. */
  papelDeTopo: string
  /**
   * Valida os extras do convite (obras, cargo…). `true` aceita como vieram; um objeto = os extras
   * NORMALIZADOS (é ele que vai para a tabela); qualquer outra coisa recusa (400). Erro lança (503).
   * Sem esta opção, o app não tem extras: só `{}` é aceito.
   */
  validarExtras?: (extras: Record<string, unknown>, ctx: ContextoDosExtras) => boolean | Record<string, unknown> | null | undefined | Promise<boolean | Record<string, unknown> | null | undefined>
  /** Tabela de pré-aprovação do app. Padrão `{ schema: 'public', nome: 'pre_aprovacao' }`. */
  tabela?: { schema?: string; nome?: string }
  /** Validade local da pré-aprovação de convite, em dias (1 a 90). Padrão 14 (R3). O teto é 3 × este valor. */
  validadeLocalDias?: number
  /** Padrão `Deno.env`. Lê SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, PORTAL_CONVITE_SEGREDO e DEV_ORIGINS. */
  env?: { get(nome: string): string | undefined }
  /** Origens de desenvolvimento (só `http://localhost[:porta]`); padrão: a variável DEV_ORIGINS. */
  devOrigins?: string | string[]
  /** Padrão `fetch`. */
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>
  /** Padrão `console`. */
  log?: LogDoConvite
  /** Relógio em milissegundos (para teste). Padrão `Date.now`. */
  agora?: () => number
  /** Quanto esperar pelo Portal, em ms. Padrão 30 000 (ele espera o envio do e-mail por até ~20 s). */
  esperaPortalMs?: number
  /**
   * v0.4.0 (opcional): quem está BLOQUEADO no app não é reconvidado. Recebe o e-mail normalizado e o
   * cliente de SERVIÇO. `true` → `criar` e `reenviar` respondem 409 `bloqueado_no_app` antes do Portal e
   * de qualquer gravação; `false` segue. Erro tem de LANÇAR (vira 503); outro valor também é 503.
   * Ausente = comportamento da v0.3.0. `listar` e `cancelar` não consultam.
   */
  // deno-lint-ignore no-explicit-any
  bloqueadoNoApp?: (args: { email: string; cliente: any }) => boolean | Promise<boolean>
}

/** HMAC-SHA256 em hexadecimal minúsculo de `timestamp + "." + corpo`, com o segredo da fonte. */
export function assinarPedidoDoConvite(corpo: string, segredo: string, timestamp: string): Promise<string>

/**
 * Chamada assinada ao Portal. Uso INTERNO do kit (gestor de convites e `revogarPermissaoNoPortal`):
 * não é API para o app. Nunca lança; `status` 0 = sem resposta (rede, prazo, redirecionamento).
 */
export function chamarPortalAssinado(
  canal: { urlPortal: string; fonte: string; fetchFn: (url: string, init: RequestInit) => Promise<Response>; agora: () => number; esperaMs: number },
  segredo: string,
  pedido: Record<string, unknown>,
): Promise<{ status: number; corpo: Record<string, unknown> | null; erro?: unknown }>

/** A função de convites do app. Lança na carga se a configuração for inválida. */
export function criarGestorDeConvites(config: ConfigGestorDeConvites): (req: Request) => Promise<Response>

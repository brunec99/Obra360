// Tipos de server/receptor.mjs (@atr/portal-kit), escritos à mão, sem dependência.
// TypeScript acha este arquivo pelo nome (receptor.mjs → receptor.d.mts); o Deno, pela diretiva
// `// @ts-self-types="./receptor.d.mts"` na 1ª linha do .mjs.

import type { PayloadPortal } from '../core/ssoV2.d.mts'
import type { OpcoesBuscaUsuario, UsuarioAuth } from './usuarios.d.mts'

export type { PayloadPortal } from '../core/ssoV2.d.mts'
export type { OpcoesBuscaUsuario, UsuarioAuth } from './usuarios.d.mts'

/**
 * Cliente supabase-js com service_role, injetado pelo app (`criarCliente`).
 * `any` de propósito: o kit não depende dos tipos do supabase-js (cada app usa uma versão).
 */
// deno-lint-ignore no-explicit-any
export type ClienteAdmin = any

/**
 * O que o receptor passa como 3º argumento do `criarCliente`, e nada além disso.
 * Tipo estrutural mínimo: o `createClient` do supabase-js 2.x aceita sem cast.
 */
export interface OpcoesClienteAdmin {
  auth: { persistSession: boolean; autoRefreshToken: boolean }
}

/** Log injetado. `warn` é usado pelo adaptador profilesIsAdmin (conta sem perfil). */
export type LogReceptor = Pick<Console, 'log' | 'warn' | 'error'>

/** O que `perfil.ler` devolve. */
export interface LeituraPerfil {
  existe: boolean
  bloqueado: boolean
  papelLocal: string | null
}

/** Contexto passado ao adaptador em cada etapa. */
export interface ContextoPerfil {
  payload: PayloadPortal
  /** E-mail do token, normalizado (trim + minúsculas). */
  email: string
  /** full_name do token (até 200 caracteres). */
  nome: string
  contaCriadaAgora: boolean
  /** Só em `primeiroAcesso`: se `ler` achou o perfil. */
  existe?: boolean
  /** Só em `primeiroAcesso`: papel lido por `ler`. */
  papelLocal?: string | null
  log: LogReceptor
}

/** Adaptador de perfil: onde mora o perfil do app, papel e bloqueio. */
export interface AdaptadorPerfil {
  /** Nome do adaptador de fábrica ('profilesApproved', 'profilesIsAdmin', 'perfisAtivo', 'rpcComercial'); o contrato usa. */
  tipo: string
  /** Informativo. */
  tabela?: string
  /** Informativo. */
  schema?: string
  /** Opções de `acharUsuarioPorEmail` (ignorado se houver `acharUsuario`). */
  busca?: OpcoesBuscaUsuario
  /** Busca própria da conta (ex.: RPC do Comercial). Erro deve LANÇAR. */
  acharUsuario?: (admin: ClienteAdmin, email: string) => Promise<UsuarioAuth | undefined>
  /** Parâmetros extras do createUser (password, user_metadata…). Sem ele, só e-mail e email_confirm. */
  contaNova?: (ctx: ContextoPerfil) => Record<string, unknown>
  /** Espera depois do createUser, para o gatilho do banco criar o perfil. Sem ele, não espera. */
  esperarGatilhoMs?: number
  /** Conta existente sem perfil: 'criar' (1º acesso, padrão) ou 'recusar' (403 perfil_ausente). */
  semPerfilEmContaExistente?: 'criar' | 'recusar'
  /** Papel de perfil NOVO (nunca de existente). `null` quando o papel vem de fora (RPC). */
  papelInicial: (payload: PayloadPortal) => string | null
  /** Campo extra da resposta 200 com o papel (ex.: 'role', 'admin_role'). */
  campoPapelResposta?: string
  /** Lê o perfil. Erro deve LANÇAR (o receptor responde 503). */
  ler: (admin: ClienteAdmin, usuario: UsuarioAuth, ctx: ContextoPerfil) => Promise<LeituraPerfil>
  /** Conta nova ou sem perfil: grava e devolve o papel. */
  primeiroAcesso: (admin: ClienteAdmin, usuario: UsuarioAuth, ctx: ContextoPerfil) => Promise<string | null | undefined>
  /** Conta e perfil existentes: atualiza só a identificação (nunca papel/aprovação). */
  atualizarIdentidade?: (admin: ClienteAdmin, usuario: UsuarioAuth, ctx: ContextoPerfil) => Promise<void>
}

/** Textos fixos enviados ao navegador. */
export interface MensagensReceptor {
  metodo: string
  origem: string
  config: string
  requisicao: string
  semToken: string
  tokenInvalido: string
  appInvalido: string
  emailInvalido: string
  usoUnicoIndisponivel: string
  tokenJaUsado: string
  indisponivel: string
  perfilAusente: string
  bloqueado: string
  erroInterno: string
  /** 403 `conta_nao_verificada`: conta existente sem origem comprovada (v0.2.4). */
  contaNaoVerificada: string
  /** 403 `conta_nao_confirmada`: conta existente com e-mail não confirmado (v0.2.4). */
  contaNaoConfirmada: string
}

export interface ConfigReceptor {
  /** aud e app_slug esperados no token. */
  appSlug: string
  /** Origens do próprio app (CORS e destinos de redirect). Forma exata `https://host[:porta]`; outra forma lança na carga. */
  origensApp: string[]
  /** Destino quando a origem do pedido não é do app; precisa estar em `origensApp`. */
  origemPadrao: string
  /** Só CORS (ex.: o Portal); nunca viram destino. Mesma forma de `origensApp`. */
  origensExtras?: string[]
  /** true = origem fora da lista recebe 403. Padrão false. */
  exigirOrigem?: boolean
  /** Padrão: `Deno.env`. Lido a cada requisição. */
  env?: { get(nome: string): string | undefined }
  /** Padrão: env DEV_ORIGINS (separada por vírgula). Só `http://localhost[:porta]` e `http://127.0.0.1[:porta]` valem; o resto é ignorado. */
  devOrigins?: string | string[]
  /** createClient do supabase-js do app (`criarCliente: createClient`, sem cast). */
  criarCliente: (url: string, chave: string, opcoes: OpcoesClienteAdmin) => ClienteAdmin
  /** Padrão: { schema: 'public', nome: 'consumir_token_sso' }; cada campo omitido usa o padrão. */
  rpcUsoUnico?: { schema?: string; nome?: string }
  perfil: AdaptadorPerfil
  mensagens?: Partial<MensagensReceptor>
  /** Parâmetros extras do createUser (metadata mesclada raso com a do adaptador). */
  aoCriarConta?: Record<string, unknown> | ((payload: PayloadPortal) => Record<string, unknown>)
  /**
   * v0.2.4, OBRIGATÓRIO: conta existente criada a partir deste instante (ISO) só é aproveitada com
   * origem comprovada. Por app: o instante logo antes do deploy da v0.2.4 naquele app.
   * Ausente, ISO inválido ou no futuro lança na carga.
   */
  corteContaExistente: string
  /** v0.2.4: `app_metadata.origem` / `app_metadata.criado_por` aceitos. Padrão `['comercial', 'portal-admin']`; vazia vale. */
  origensConfiaveis?: readonly string[]
  /** Padrão: setTimeout. */
  esperar?: (ms: number) => Promise<void>
  /** Padrão: console. */
  log?: LogReceptor
}

export const MENSAGENS_PADRAO: Readonly<MensagensReceptor>

/** v0.2.4: `origensConfiaveis` padrão: `['comercial', 'portal-admin']`. */
export const ORIGENS_CONFIAVEIS_PADRAO: readonly string[]

/** Motivo da decisão sobre uma conta existente (vai para o log `conta_existente_recusada`). */
export type MotivoConta = 'nao_confirmada' | 'marca_kit' | 'origem' | 'convite' | 'so_google' | 'anterior_ao_corte' | 'sem_origem'

export interface DecisaoConta {
  aceita: boolean
  motivo: MotivoConta
}

/**
 * v0.2.4: decide se uma conta existente (objeto `user` do GoTrue) pode ser aproveitada.
 * Só lê `app_metadata`, `invited_at`, `created_at` e `email_confirmed_at`; nunca `user_metadata`.
 */
export function motivoContaConfiavel(
  usuario: UsuarioAuth | null | undefined,
  opcoes: { corteMs: number; origensConfiaveis: readonly string[] },
): DecisaoConta

/** Monta o handler do `portal-login`. Lança na carga se a configuração for inválida. */
export function criarReceptorPortal(config: ConfigReceptor): (req: Request) => Promise<Response>

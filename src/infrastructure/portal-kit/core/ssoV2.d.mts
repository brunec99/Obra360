// Tipos do núcleo do @atr/portal-kit v0.2.0 (core/ssoV2.mjs), escritos à mão, sem dependência.
// TypeScript acha este arquivo pelo nome (ssoV2.mjs → ssoV2.d.mts); o Deno, pela diretiva
// `// @ts-self-types="./ssoV2.d.mts"` na 1ª linha do .mjs.

/** Versão do protocolo do token v2 (não muda com a remoção do v1). */
export const SSO_V2_VERSAO: string

/** Recusa de token. `codigo` vai no corpo do 401 como campo `code`. */
export class ErroTokenPortal extends Error {
  constructor(codigo: string, mensagem?: string)
  codigo: string
}

/** Claims do token v2 emitido pelo Portal Inteligência. */
export interface PayloadPortal {
  v: 2
  iss: string
  aud: string
  scope: 'sso' | 'search'
  sub: string
  email: string
  full_name: string
  portal_role: string
  app_slug: string
  jti: string
  iat: number
  exp: number
  /** SHA-256 base64url do corpo exato (só scope=search). */
  bh?: string
  [k: string]: unknown
}

export interface OpcoesVerificacao {
  chaves: Map<string, CryptoKey>
  audiencias: string[]
  escopo: 'sso' | 'search'
  /** Agora em segundos (testes). */
  agora?: number
  /** Corpo exato da requisição — obrigatório em escopo search. */
  corpo?: string
  /** Ignorado desde a v0.2.0: todo HS256 é recusado com `sso_v1_recusado`. */
  v1?: unknown
}

export interface ResultadoVerificacao {
  versao: 2
  payload: PayloadPortal
  chaveUsoUnico: string
}

export function verificarTokenPortal(token: string, opcoes: OpcoesVerificacao): Promise<ResultadoVerificacao>

export function lerChavesPublicas(texto: string): Promise<Map<string, CryptoKey>>

export function assinarTokenV2(
  jwkPrivada: JsonWebKey & { kid?: string },
  claims: Record<string, unknown>,
  opcoes?: { kid?: string },
): Promise<string>

/** SHA-256 hex (64) da string do token. Não é a chave de uso único. */
export function hashDoToken(token: string): Promise<string>

/** SHA-256 hex de `${iss}:${aud}:${jti}` — chave de uso único. */
export function chaveDeUsoUnico(payload: Pick<PayloadPortal, 'iss' | 'aud' | 'jti'>): Promise<string>

/** SHA-256 base64url do corpo — claim `bh`. */
export function hashDoCorpo(corpo: string): Promise<string>

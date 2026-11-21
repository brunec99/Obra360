// Tipos de server/usuarios.mjs (@atr/portal-kit), escritos à mão, sem dependência.

/** Conta de auth.users (só os campos que o kit usa; o resto passa adiante). */
export interface UsuarioAuth {
  id: string
  email?: string
  [k: string]: unknown
}

export interface OpcoesBuscaUsuario {
  /** Tabela com e-mail do usuário (atalho). Padrão 'profiles'; null desliga o atalho. */
  tabelaPerfil?: string | null
  /** Schema da tabela (ex.: 'comercial'); padrão do cliente se omitido. */
  schema?: string
  /** Padrão 'email'. */
  colunaEmail?: string
  /** Coluna com o id da auth.users. Padrão 'id'. */
  colunaId?: string
  /** Padrão 1000. */
  porPagina?: number
  /** Padrão 50. */
  maxPaginas?: number
}

/**
 * Acha a conta de um e-mail (atalho pelo perfil + varredura paginada do listUsers).
 * `undefined` = não existe. Qualquer erro de leitura LANÇA (falha fechada).
 * @param admin cliente supabase-js com service_role (`any`: o kit não depende dos tipos dele)
 */
export function acharUsuarioPorEmail(
  // deno-lint-ignore no-explicit-any
  admin: any,
  email: string,
  opcoes?: OpcoesBuscaUsuario,
): Promise<UsuarioAuth | undefined>

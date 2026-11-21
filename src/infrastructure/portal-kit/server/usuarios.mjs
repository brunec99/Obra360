// @ts-self-types="./usuarios.d.mts"
// @atr/portal-kit · server/usuarios.mjs
// Achar a conta (auth.users) de um e-mail sem depender da 1ª página do listUsers.
//
// Origem: correção do "51º usuário" (06/11/2026). O listUsers do Supabase devolve 50 por
// página por padrão; o receptor que só olhava a 1ª página criava conta duplicada (e falhava)
// para quem estava da 51ª em diante. Esta função é a versão única dessa correção.
//
// O cliente é injetado (`admin` = supabase-js com service_role), então funciona com qualquer
// versão do supabase-js que o app já usa (esm.sh 2.39 ou npm 2.103).

/**
 * @param {any} admin  cliente supabase-js com service_role
 * @param {string} email
 * @param {{
 *   tabelaPerfil?: string | null,   // tabela com e-mail do usuário (atalho); null desliga o atalho
 *   schema?: string,                // schema da tabela (ex.: 'comercial'); padrão do cliente se omitido
 *   colunaEmail?: string,
 *   colunaId?: string,              // coluna que guarda o id da auth.users
 *   porPagina?: number,
 *   maxPaginas?: number,
 * }} [opcoes]
 * @returns {Promise<any | undefined>} o usuário (auth.users) ou undefined se não existir.
 *   Qualquer erro de leitura LANÇA: quem chama deve responder 503 (falha fechada), nunca
 *   tratar como "usuário não existe" (isso levaria a criar conta duplicada).
 */
/** "User not found" do GoTrue: status 404 ou code user_not_found; sem status, pela mensagem. */
function contaNaoEncontrada(erro) {
  if (erro?.status === 404 || erro?.code === 'user_not_found') return true
  return erro?.status === undefined && /user not found/i.test(String(erro?.message ?? ''))
}

export async function acharUsuarioPorEmail(admin, email, opcoes = {}) {
  const {
    tabelaPerfil = 'profiles',
    schema,
    colunaEmail = 'email',
    colunaId = 'id',
    porPagina = 1000,
    maxPaginas = 50,
  } = opcoes
  const alvo = String(email ?? '').trim().toLowerCase()
  if (!alvo) return undefined
  const mesmoEmail = (u) => String(u?.email ?? '').toLowerCase() === alvo

  // 1) Atalho pelo perfil: 1 leitura em vez de varrer a lista.
  if (tabelaPerfil) {
    const base = schema ? admin.schema(schema) : admin
    const { data: perfis, error } = await base.from(tabelaPerfil).select(colunaId).eq(colunaEmail, alvo).limit(2)
    if (error) throw error
    if (Array.isArray(perfis) && perfis.length === 1) {
      const { data: porId, error: erroId } = await admin.auth.admin.getUserById(perfis[0][colunaId])
      // Perfil órfão (conta apagada ou recriada com outro id): o atalho não serve, segue para a
      // varredura (ME-04). Qualquer outro erro LANÇA (falha fechada).
      if (erroId && !contaNaoEncontrada(erroId)) throw erroId
      // Perfil apontando para outra conta não vale: confere o e-mail.
      if (!erroId && porId?.user && mesmoEmail(porId.user)) return porId.user
    }
  }

  // 2) Varredura paginada.
  for (let page = 1; page <= maxPaginas; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: porPagina })
    if (error) throw error
    const usuarios = data?.users ?? []
    const achado = usuarios.find(mesmoEmail)
    if (achado) return achado
    if (usuarios.length < porPagina) return undefined
  }
  // Passou do limite sem terminar a lista: não dá para afirmar que não existe.
  throw new Error(`acharUsuarioPorEmail: mais de ${maxPaginas * porPagina} contas; aumente maxPaginas`)
}

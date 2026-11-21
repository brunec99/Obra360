// @ts-self-types="./pre-aprovacao.d.mts"
// @atr/portal-kit · server/pre-aprovacao.mjs
// Pré-aprovação local por e-mail (v0.3.0): o app guarda, na tabela DELE, "este e-mail entra neste
// app com este papel". O adaptador de perfil consulta no 1º acesso: com linha válida a conta nasce
// aprovada no papel da linha; sem linha, vale a regra do app (`aprovaNoPrimeiroAcesso`).
//
// Tabela (cada app cria a sua, com as mesmas colunas): id, app, email, origem ('convite' | 'pedido' |
// 'carga'), convite_id, papel, extras, estado ('pendente' | 'aplicado' | 'cancelado' | 'expirado'),
// vale_ate, criado_por, criado_em, aplicado_em, aplicado_para, convite_expira_em.
// Índice único de linha pendente por (app, email, origem): podem conviver até três linhas pendentes
// para o mesmo app e e-mail, uma por origem.
//
// Quando uma linha vale (as quatro condições juntas):
//   1. `pendente`, do slug e do e-mail do token, com `vale_ate` no futuro. O leitor só olha `vale_ate`:
//      o prazo é de quem grava a linha. `convite_expira_em` (validade do link) NÃO é lido.
//   2. a conta foi criada pelo kit DESTE app (`app_metadata.portal_kit.app`), ou por um caminho que o
//      app declarou em `marcaExtra` (`app_metadata.criado_por`). `user_metadata` nunca conta.
//   3. a conta nasceu DEPOIS da linha (`created_at > criado_em`): conta que já existia nunca é elevada.
//   4. o papel está na lista fechada `papeis`, conferida aqui e de novo ao aplicar.
// Entre as linhas válidas, a ordem é convite > pedido > carga. Linha inválida de uma origem não
// impede a de outra (convite vencido não tira a carga de quem já estava autorizado).
//
// Janela da segunda tentativa: para conta que NÃO foi criada neste acesso, a linha só vale enquanto a
// conta tem até 15 minutos de vida. O adaptador grava o perfil aprovado e só depois chama `aplicar`;
// se a marcação falhar, as linhas ficam `pendente` até `vale_ate`, e sem a janela quem fosse revogado
// depois voltaria aprovado como "segunda tentativa".
//
// `aplicar` consome TODAS as linhas pendentes do app e do e-mail (a escolhida e as de outras origens):
// nenhuma sobra para reaprovar depois.
//
// Falha FECHADA: erro de leitura ou de gravação LANÇA (o receptor responde 503, sem magic link).
// Nenhum e-mail vai para o log. Sem import e sem API de runtime.

/** Ordem de escolha entre as linhas válidas. Origem fora desta lista nunca é escolhida. */
const ORDEM_DAS_ORIGENS = Object.freeze(['convite', 'pedido', 'carga'])

/** Vida máxima da conta para a pré-aprovação valer fora do acesso que a criou. */
const JANELA_SEGUNDA_TENTATIVA_MS = 15 * 60_000

/** Colunas lidas. `convite_expira_em` fica de fora de propósito (a validade é só `vale_ate`). */
const COLUNAS = 'id, app, email, origem, convite_id, papel, extras, criado_por, criado_em, vale_ate'

const ehObjeto = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const textoNaoVazio = (v) => typeof v === 'string' && v.trim() !== ''
const emailNormalizado = (v) => String(v ?? '').trim().toLowerCase()

/**
 * @param {{
 *   schema?: string,                 // schema da tabela; padrão 'public'
 *   tabela?: string,                 // padrão 'pre_aprovacao'
 *   appSlug: string,                 // slug do Portal: só linha deste app vale
 *   papeis: string[],                // lista FECHADA de papéis que a pré-aprovação pode dar (nunca o papel de topo)
 *   marcaExtra?: string[],           // valores de `app_metadata.criado_por` que também provam a origem da conta
 *   aplicarExtras?: (admin: any, usuario: any, pre: object, ctx: object) => Promise<void>,  // roda antes de marcar; tem de ser idempotente
 * }} opcoes
 * @returns {{ ler: Function, aplicar: Function, schema: string, tabela: string, appSlug: string, papeis: readonly string[], marcaExtra: readonly string[] }}
 */
export function criarPreAprovacao({ schema = 'public', tabela = 'pre_aprovacao', appSlug, papeis, marcaExtra = [], aplicarExtras } = {}) {
  // Erro de configuração aparece na carga da função, não no 1º login.
  if (!textoNaoVazio(appSlug)) throw new Error('criarPreAprovacao: appSlug obrigatório')
  if (!Array.isArray(papeis) || papeis.length === 0 || !papeis.every(textoNaoVazio)) {
    throw new Error('criarPreAprovacao: papeis obrigatório (lista fechada, não vazia, dos papéis que a pré-aprovação pode dar)')
  }
  if (!Array.isArray(marcaExtra) || !marcaExtra.every(textoNaoVazio)) {
    throw new Error('criarPreAprovacao: marcaExtra precisa ser lista de texto não vazio')
  }
  if (aplicarExtras !== undefined && typeof aplicarExtras !== 'function') {
    throw new Error('criarPreAprovacao: aplicarExtras precisa ser função')
  }
  if (!textoNaoVazio(schema) || !textoNaoVazio(tabela)) throw new Error('criarPreAprovacao: schema e tabela precisam ser texto não vazio')

  const papeisAceitos = Object.freeze([...papeis])
  const marcasAceitas = Object.freeze([...marcaExtra])
  const consulta = (admin) => (schema === 'public' ? admin : admin.schema(schema)).from(tabela)

  /** Condições 1 (validade), 2 (origem da conta) e 3 (conta nascida depois da linha). */
  function valeParaAConta(linha, usuario, agora) {
    if (!ehObjeto(linha) || linha.app !== appSlug) return false
    if (!(Date.parse(linha.vale_ate) > agora)) return false
    const meta = ehObjeto(usuario?.app_metadata) ? usuario.app_metadata : {}
    const doKit = (ehObjeto(meta.portal_kit) && meta.portal_kit.app === appSlug)
      || (typeof meta.criado_por === 'string' && marcasAceitas.includes(meta.criado_por))
    if (!doKit) return false
    return Date.parse(usuario?.created_at) > Date.parse(linha.criado_em)
  }

  return {
    schema,
    tabela,
    appSlug,
    papeis: papeisAceitos,
    marcaExtra: marcasAceitas,

    /**
     * A linha de pré-aprovação que vale para esta conta, ou `null`. Erro de leitura LANÇA.
     * @returns {Promise<object | null>}
     */
    async ler(admin, usuario, ctx) {
      const email = emailNormalizado(ctx?.email)
      if (!email) return null
      const agora = Date.now()
      // Conta que não nasceu neste acesso: só na janela da segunda tentativa (fora dela, nem consulta).
      if (ctx?.contaCriadaAgora !== true) {
        const idade = agora - Date.parse(usuario?.created_at)
        if (!(Math.abs(idade) <= JANELA_SEGUNDA_TENTATIVA_MS)) return null
      }

      const { data, error } = await consulta(admin).select(COLUNAS)
        .eq('app', appSlug).eq('email', email).eq('estado', 'pendente')
      if (error) throw error
      const linhas = Array.isArray(data) ? data : []

      for (const origem of ORDEM_DAS_ORIGENS) {
        for (const linha of linhas) {
          if (linha?.origem !== origem || !valeParaAConta(linha, usuario, agora)) continue
          if (!papeisAceitos.includes(linha.papel)) {
            const aviso = typeof ctx?.log?.warn === 'function' ? ctx.log.warn : ctx?.log?.log
            aviso?.(JSON.stringify({ fn: appSlug, evento: 'pre_aprovacao_papel_invalido', origem, linha: linha.id ?? null }))
            continue
          }
          return linha
        }
      }
      return null
    },

    /**
     * Roda `aplicarExtras` (se houver) com a linha escolhida e depois marca `aplicado` TODAS as linhas
     * pendentes do app e do e-mail. Idempotente: sem linha pendente, não muda nada. Erro LANÇA.
     */
    async aplicar(admin, usuario, pre, ctx) {
      if (!ehObjeto(pre)) throw new Error('criarPreAprovacao: aplicar sem linha de pré-aprovação')
      if (pre.app !== undefined && pre.app !== appSlug) throw new Error('criarPreAprovacao: linha de pré-aprovação de outro app')
      if (!papeisAceitos.includes(pre.papel)) throw new Error('criarPreAprovacao: pré-aprovação com papel fora da lista fechada')
      const email = emailNormalizado(pre.email ?? ctx?.email)
      if (!email) throw new Error('criarPreAprovacao: pré-aprovação sem e-mail')
      if (!usuario?.id) throw new Error('criarPreAprovacao: pré-aprovação sem a conta que a recebe')

      if (aplicarExtras) await aplicarExtras(admin, usuario, pre, ctx)

      const { error } = await consulta(admin)
        .update({ estado: 'aplicado', aplicado_em: new Date().toISOString(), aplicado_para: usuario.id })
        .eq('app', appSlug).eq('email', email).eq('estado', 'pendente')
      if (error) throw error
    },
  }
}

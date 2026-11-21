// @ts-self-types="./adaptador-profiles-approved.d.mts"
// @atr/portal-kit · server/adaptador-profiles-approved.mjs
// Adaptador de perfil para apps com `public.profiles(id, email, full_name, role, approved)`:
// Mapa BI (mapa-bi) e NF (financeiro).
//
// Regras (iguais ao portal-login atual do BI v21 e do NF, com as correções da fase 1):
// - Conta criada agora: o gatilho do banco cria o perfil com approved=false; o 1º acesso pelo
//   Portal aprova (update email/full_name/approved). Sem perfil do gatilho → insert com
//   `papelInicial(payload)`.
// - Conta existente sem perfil: `semPerfilEmContaExistente` decide ('criar' no BI, 'recusar' no NF).
// - Conta existente com approved≠true: bloqueada (403), vale para admin do Portal também.
// - NUNCA sobrescreve `role` nem `approved` de perfil existente: o app é a autoridade sobre o
//   próprio acesso; o Portal só atualiza a identificação (email, full_name). Única exceção: a
//   segunda tentativa de um 1º acesso que falhou, com pré-aprovação válida (v0.3.0, abaixo).
// - Erro de leitura/gravação lança → o receptor responde 503 (falha fechada).
//
// v0.3.0 — duas opções, as duas com padrão igual ao da v0.2.5 (sem elas, cada comando gravado é o mesmo):
// - `aprovaNoPrimeiroAcesso(payload)`: só `true` aprova no 1º acesso. Padrão `() => true`. Com falso e
//   sem pré-aprovação, o perfil nasce PENDENTE (nenhum comando grava `approved: true`); o magic link
//   sai e o app mostra a tela de pendente.
// - `preAprovacao` (`criarPreAprovacao`, de `./pre-aprovacao.mjs`): com linha válida, o perfil nasce
//   aprovado no papel DA LINHA, e a linha é marcada depois de o perfil gravar. Padrão `null`.
//   Segunda tentativa: se o 1º acesso falhou no meio, a conta já existe e o perfil ficou pendente;
//   com pré-aprovação ainda válida (o leitor só a aceita até 15 minutos de vida da conta), `ler` não
//   bloqueia e devolve o papel da pré, e `atualizarIdentidade` aprova, grava o papel e aplica.
//   Perfil aprovado nunca consulta a pré-aprovação. O adaptador não tem literal de papel.
// - Perfil que nasce PENDENTE nunca guarda papel derivado de admin do Portal: no insert, o papel gravado
//   (e o da resposta) é o que a régua do app dá a um usuário comum, `papelInicial({ ...payload, portal_role: 'user' })`.
//   Com perfil do gatilho, o papel fica o do gatilho (nenhum `role` é gravado). O papel definitivo é dado
//   por quem aprova no app. Com aprovação ou pré-aprovação, nada muda.
// ATENÇÃO: o estado pendente só protege se as policies e funções do app exigirem `approved` JUNTO com o
// papel. O pendente tem sessão (o magic link sai); o kit não confere as policies do app.

const senhaAleatoria = () => globalThis.crypto.randomUUID() + globalThis.crypto.randomUUID()
/** O mesmo payload do token, visto como o de um usuário comum do Portal (para o papel de quem nasce pendente). */
const comoUsuarioComum = (payload) => ({ ...payload, portal_role: 'user' })

/**
 * @param {{
 *   papelInicial?: (payload: object) => string,      // papel de perfil NOVO (nunca de existente)
 *   semPerfilEmContaExistente?: 'criar' | 'recusar',
 *   tabela?: string,
 *   esperarGatilhoMs?: number,
 *   campoPapelResposta?: string,
 *   aprovaNoPrimeiroAcesso?: (payload: object) => boolean,   // v0.3.0; padrão () => true (como na v0.2.5)
 *   preAprovacao?: { ler: Function, aplicar: Function } | null,  // v0.3.0; padrão null
 * }} [opcoes]
 */
export function profilesApproved({
  papelInicial = () => 'user',
  semPerfilEmContaExistente = 'criar',
  tabela = 'profiles',
  esperarGatilhoMs = 500,
  campoPapelResposta = 'role',
  aprovaNoPrimeiroAcesso = () => true,
  preAprovacao = null,
} = {}) {
  // Erro de configuração aparece na carga da função, não no 1º login.
  if (typeof aprovaNoPrimeiroAcesso !== 'function') {
    throw new Error('profilesApproved: aprovaNoPrimeiroAcesso precisa ser função (payload) => boolean')
  }
  if (preAprovacao !== null && preAprovacao !== undefined
    && (typeof preAprovacao !== 'object' || typeof preAprovacao.ler !== 'function' || typeof preAprovacao.aplicar !== 'function')) {
    throw new Error('profilesApproved: preAprovacao precisa ser { ler, aplicar } (criarPreAprovacao) ou null')
  }
  preAprovacao = preAprovacao ?? null

  /** Linha de pré-aprovação que vale para a conta, ou null. Erro LANÇA (o receptor responde 503). */
  async function lerPre(admin, usuario, ctx) {
    const pre = preAprovacao ? await preAprovacao.ler(admin, usuario, ctx) : null
    if (!pre) return null
    if (typeof pre.papel !== 'string' || pre.papel === '') throw new Error('profilesApproved: pré-aprovação sem papel')
    return pre
  }

  // Segunda tentativa: a pré-aprovação lida em `ler` segue para `atualizarIdentidade` pelo `ctx`
  // (o receptor passa o MESMO objeto às duas etapas). Fora desse caminho, nada fica guardado.
  const preDaSegundaTentativa = new WeakMap()

  return {
    tipo: 'profilesApproved',
    tabela,
    schema: 'public',
    busca: { tabelaPerfil: tabela, colunaEmail: 'email', colunaId: 'id' },
    esperarGatilhoMs,
    semPerfilEmContaExistente,
    papelInicial,
    campoPapelResposta,
    // O contrato lê (como lê `papelInicial`).
    aprovaNoPrimeiroAcesso,
    preAprovacao,

    contaNova: (ctx) => ({ password: senhaAleatoria(), user_metadata: { full_name: ctx.nome } }),

    async ler(admin, usuario, ctx) {
      const { data, error } = await admin.from(tabela).select('id, role, approved').eq('id', usuario.id).maybeSingle()
      if (error) throw error
      const existe = Boolean(data)
      const pendente = existe && data.approved !== true
      // Conta existente com perfil pendente: só a pré-aprovação válida (segunda tentativa) evita o bloqueio.
      const pre = !ctx.contaCriadaAgora && pendente ? await lerPre(admin, usuario, ctx) : null
      if (pre) preDaSegundaTentativa.set(ctx, pre)
      return {
        existe,
        // Conta criada agora: o approved=false é do gatilho, não um bloqueio.
        bloqueado: !ctx.contaCriadaAgora && pendente && !pre,
        // Na segunda tentativa o receptor responde com este papel: tem de ser o da pré, não o do gatilho.
        papelLocal: pre ? pre.papel : (data?.role ?? null),
      }
    },

    async primeiroAcesso(admin, usuario, ctx) {
      const pre = await lerPre(admin, usuario, ctx)
      const aprovar = Boolean(pre) || aprovaNoPrimeiroAcesso(ctx.payload) === true
      let papel
      if (ctx.existe) {
        const { error } = await admin.from(tabela)
          .update({ email: ctx.email, full_name: ctx.nome, ...(aprovar ? { approved: true } : {}), ...(pre ? { role: pre.papel } : {}) })
          .eq('id', usuario.id)
        if (error) throw error
        papel = pre ? pre.papel : ctx.papelLocal
      } else {
        // Pendente nunca guarda papel derivado de admin do Portal: recebe o papel de um usuário comum.
        papel = pre ? pre.papel : papelInicial(aprovar ? ctx.payload : comoUsuarioComum(ctx.payload))
        const { error } = await admin.from(tabela).insert({
          id: usuario.id, email: ctx.email, full_name: ctx.nome, role: papel, approved: aprovar,
        })
        if (error) throw error
      }
      // Depois de o perfil gravar: extras do app e marca `aplicado` em todas as linhas pendentes do par.
      if (pre) await preAprovacao.aplicar(admin, usuario, pre, ctx)
      return papel
    },

    async atualizarIdentidade(admin, usuario, ctx) {
      // Só há pré aqui quando `ler` achou perfil PENDENTE com pré-aprovação válida (segunda tentativa).
      const pre = preDaSegundaTentativa.get(ctx) ?? null
      const { error } = await admin.from(tabela)
        .update({ email: ctx.email, full_name: ctx.nome, ...(pre ? { approved: true, role: pre.papel } : {}) })
        .eq('id', usuario.id)
      if (error) throw error
      if (pre) await preAprovacao.aplicar(admin, usuario, pre, ctx)
    },
  }
}

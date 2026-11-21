// @ts-self-types="./adaptador-profiles-is-admin.d.mts"
// @atr/portal-kit · server/adaptador-profiles-is-admin.mjs
// Adaptador de perfil para `public.profiles(id, full_name, is_admin, admin_role)`: ATR GLOBAL (admin-app).
//
// Regras (iguais ao portal-login atual do GLOBAL):
// - 1º acesso (conta criada agora OU conta existente sem perfil): update
//   { full_name, is_admin: true, admin_role: papelInicial(payload) }. Sem insert: o perfil vem do
//   gatilho do banco. Conta existente sem perfil faz o mesmo update (0 linhas, sem erro) e deixa
//   um aviso no log (Decisão pós-pesquisa 2 — igual a hoje); a resposta sai com papel null (LO-06).
// - Conta existente com perfil: só atualiza full_name; admin_role local (ou 'operator') é a
//   autoridade — nunca re-eleva quem foi rebaixado aqui. Única exceção: perfil com is_admin FALSO e
//   pré-aprovação válida (v0.3.0, abaixo).
// - is_admin=false NÃO é barrado no servidor (D13 / Decisão pós-pesquisa 1): o frontend mostra
//   "Aguardando aprovação". Decidir na fase 3 se passa a ser bloqueio no servidor.
// - profiles do GLOBAL NÃO tem coluna email: sem atalho de busca, só listUsers (Pitfall 5 / D12).
// - Erro de leitura/gravação lança → o receptor responde 503.
//
// v0.3.0 — duas opções, as duas com padrão igual ao da v0.2.5 (sem elas, cada comando gravado é o mesmo):
// - `aprovaNoPrimeiroAcesso(payload)`: só `true` faz o 1º acesso gravar is_admin: true. Padrão `() => true`.
//   Com falso e sem pré-aprovação, o 1º acesso grava só o nome: is_admin fica falso, o magic link sai e o
//   painel mostra a tela de pendente. Nenhum papel é gravado, então a resposta sai com papel null.
// - `preAprovacao` (`criarPreAprovacao`, de `./pre-aprovacao.mjs`): com linha válida, o perfil vira
//   is_admin no papel DA LINHA, e a linha é marcada depois de o perfil gravar. Padrão `null`.
//   No painel a conta do convidado quase sempre já EXISTE (nasce no aceite, no mesmo Auth do Portal):
//   por isso a pré-aprovação também age em conta existente, pelo `atualizarIdentidade`, e SÓ quando o
//   perfil lido tem is_admin falso. Quem prova que a conta é do aceite, que nasceu depois da linha e que
//   está na janela é o leitor (`marcaExtra` e as quatro condições): o adaptador não lê a tabela.
//   `ler` devolve o papel da pré (o receptor responde com ele) e a linha segue para `atualizarIdentidade`.
//   Perfil com is_admin verdadeiro nunca consulta a pré-aprovação: o papel de quem já é admin não é
//   trocado nem rebaixado. Sem linha de perfil não há o que gravar: a pré-aprovação nem é lida e a
//   linha fica como está. O adaptador não tem literal de papel novo.

const senhaAleatoria = () => globalThis.crypto.randomUUID() + globalThis.crypto.randomUUID()

/**
 * @param {{
 *   papelInicial?: (payload: object) => string,
 *   semPerfilEmContaExistente?: 'criar' | 'recusar',
 *   esperarGatilhoMs?: number,
 *   campoPapelResposta?: string,
 *   aprovaNoPrimeiroAcesso?: (payload: object) => boolean,   // v0.3.0; padrão () => true (como na v0.2.5)
 *   preAprovacao?: { ler: Function, aplicar: Function } | null,  // v0.3.0; padrão null
 * }} [opcoes]
 */
export function profilesIsAdmin({
  papelInicial = (p) => (p.portal_role === 'admin' ? 'admin' : 'operator'),
  semPerfilEmContaExistente = 'criar',
  esperarGatilhoMs = 500,
  campoPapelResposta = 'admin_role',
  aprovaNoPrimeiroAcesso = () => true,
  preAprovacao = null,
} = {}) {
  // Erro de configuração aparece na carga da função, não no 1º login.
  if (typeof aprovaNoPrimeiroAcesso !== 'function') {
    throw new Error('profilesIsAdmin: aprovaNoPrimeiroAcesso precisa ser função (payload) => boolean')
  }
  if (preAprovacao !== null && preAprovacao !== undefined
    && (typeof preAprovacao !== 'object' || typeof preAprovacao.ler !== 'function' || typeof preAprovacao.aplicar !== 'function')) {
    throw new Error('profilesIsAdmin: preAprovacao precisa ser { ler, aplicar } (criarPreAprovacao) ou null')
  }
  preAprovacao = preAprovacao ?? null

  const tabela = 'profiles'

  /** Linha de pré-aprovação que vale para a conta, ou null. Erro LANÇA (o receptor responde 503). */
  async function lerPre(admin, usuario, ctx) {
    const pre = preAprovacao ? await preAprovacao.ler(admin, usuario, ctx) : null
    if (!pre) return null
    if (typeof pre.papel !== 'string' || pre.papel === '') throw new Error('profilesIsAdmin: pré-aprovação sem papel')
    return pre
  }

  // Conta existente: a pré-aprovação lida em `ler` segue para `atualizarIdentidade` pelo `ctx`
  // (o receptor passa o MESMO objeto às duas etapas). Fora desse caminho, nada fica guardado.
  const preDaContaExistente = new WeakMap()

  return {
    tipo: 'profilesIsAdmin',
    tabela,
    schema: 'public',
    busca: { tabelaPerfil: null },
    esperarGatilhoMs,
    semPerfilEmContaExistente,
    papelInicial,
    campoPapelResposta,
    // O contrato lê (como lê `papelInicial`).
    aprovaNoPrimeiroAcesso,
    preAprovacao,

    contaNova: (ctx) => ({ password: senhaAleatoria(), user_metadata: { full_name: ctx.nome } }),

    async ler(admin, usuario, ctx) {
      const { data, error } = await admin.from(tabela).select('id, is_admin, admin_role').eq('id', usuario.id).maybeSingle()
      if (error) throw error
      // Conta existente com perfil e is_admin FALSO: só aqui a pré-aprovação é consultada. Quem já é
      // admin do painel nunca passa por ela.
      const semAcesso = Boolean(data) && data.is_admin !== true
      const pre = ctx?.contaCriadaAgora === false && semAcesso ? await lerPre(admin, usuario, ctx) : null
      if (pre) preDaContaExistente.set(ctx, pre)
      return {
        existe: Boolean(data),
        // bloqueado sempre false: is_admin=false é tratado no frontend (decidir na fase 3).
        bloqueado: false,
        // Com pré-aprovação o receptor responde com este papel: tem de ser o da pré, não o antigo.
        papelLocal: pre ? pre.papel : (data?.admin_role ?? 'operator'),
      }
    },

    async primeiroAcesso(admin, usuario, ctx) {
      const semPerfil = !ctx.existe && !ctx.contaCriadaAgora
      if (semPerfil) {
        ctx.log?.warn?.(JSON.stringify({ fn: 'profilesIsAdmin', evento: 'conta_sem_perfil' }))
      }
      // Sem linha de perfil o update atinge 0 linhas: a pré-aprovação não é lida (nem consumida).
      const pre = ctx.existe ? await lerPre(admin, usuario, ctx) : null
      const aprovar = Boolean(pre) || aprovaNoPrimeiroAcesso(ctx.payload) === true
      const papel = !aprovar ? null : (pre ? pre.papel : papelInicial(ctx.payload))
      const { error } = await admin.from(tabela)
        .update({ full_name: ctx.nome, ...(aprovar ? { is_admin: true, admin_role: papel } : {}) })
        .eq('id', usuario.id)
      if (error) throw error
      // Depois de o perfil gravar: extras do app e marca `aplicado` em todas as linhas pendentes do par.
      if (pre) await preAprovacao.aplicar(admin, usuario, pre, ctx)
      // LO-06: conta existente sem perfil → o update atinge 0 linhas; a resposta não afirma um papel
      // que não foi gravado (o frontend do GLOBAL só lê o verify_url). Rever na fase 3 (Decisão 2).
      // v0.3.0: quem fica pendente também não teve papel gravado (papel null).
      return semPerfil ? null : papel
    },

    async atualizarIdentidade(admin, usuario, ctx) {
      // Só há pré aqui quando `ler` achou perfil com is_admin FALSO e pré-aprovação válida.
      const pre = preDaContaExistente.get(ctx) ?? null
      const { error } = await admin.from(tabela)
        .update({ full_name: ctx.nome, ...(pre ? { is_admin: true, admin_role: pre.papel } : {}) })
        .eq('id', usuario.id)
      if (error) throw error
      if (pre) await preAprovacao.aplicar(admin, usuario, pre, ctx)
    },
  }
}

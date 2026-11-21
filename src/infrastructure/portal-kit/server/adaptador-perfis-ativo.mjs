// @ts-self-types="./adaptador-perfis-ativo.d.mts"
// @atr/portal-kit · server/adaptador-perfis-ativo.mjs
// Adaptador de perfil para `rh.perfis(user_id, nome, email, papel, ativo)`: Portal RH (rh).
//
// Regras (iguais ao portal-login atual do RH, com as correções da fase 1):
// - Sem perfil → insert { user_id, nome, email, papel: papelInicial(payload), ativo: true }.
// - ativo=false → 403 ANTES de qualquer gravação (D11: hoje o RH atualizava e só depois recusava).
// - Perfil existente: só atualiza a identificação (nome, email); NUNCA mexe em papel nem reativa.
//   Única exceção: a segunda tentativa de um 1º acesso, com pré-aprovação válida (v0.3.0, abaixo).
// - Erro de leitura lança (D7: hoje o erro virava "sem perfil" e criava outro); erro de
//   gravação lança (D8). O receptor responde 503.
//
// `papelInicial` padrão: admin do Portal herda admin no RH (decisão de manter, 07/11/2026 —
// admins do Portal = sócios/diretoria). É CONFIGURAÇÃO do app, não regra do kit.
//
// v0.3.0 — três opções, todas com padrão igual ao da v0.2.5 (sem elas, cada comando gravado é o mesmo
// e a coluna de aprovação nem aparece):
// - `colunaAprovado`: nome da coluna PRÓPRIA de aprovação do app (ex.: 'aprovado', boolean). Padrão
//   `null`. O pendente do RH NUNCA é `ativo = false`: desativado é outra coisa (mensagem "seu acesso
//   está desativado", ligação com a folha). Só `true` nessa coluna libera; conta existente com a
//   coluna diferente de `true` é barrada (403), como o desativado.
// - `aprovaNoPrimeiroAcesso(payload)`: só `true` aprova no 1º acesso. Padrão `() => true`. Com falso e
//   sem pré-aprovação, o perfil nasce com a coluna em `false` e `ativo: true`; o magic link sai e o
//   app mostra a tela de pendente.
// - `preAprovacao` (`criarPreAprovacao`, de `./pre-aprovacao.mjs`): com linha válida, o perfil nasce
//   aprovado no papel DA LINHA, e a linha é marcada depois de o perfil gravar. Padrão `null`.
//   Segunda tentativa: conta que o kit criou e ficou com perfil pendente; com pré-aprovação ainda
//   válida (o leitor só a aceita até 15 minutos de vida da conta), `ler` não bloqueia e devolve o
//   papel da pré, e `atualizarIdentidade` aprova, grava o papel e aplica.
//   `ativo = false` continua barrado como hoje, com ou sem pré-aprovação (ela nem é lida).
// Declarar `aprovaNoPrimeiroAcesso` ou `preAprovacao` SEM `colunaAprovado` lança na carga.
// - Perfil que nasce PENDENTE nunca guarda papel derivado de admin do Portal: o papel gravado (e o da
//   resposta) é o que a régua do app dá a um usuário comum, `papelInicial({ ...payload, portal_role: 'user' })`.
//   O papel definitivo é dado por quem aprova no app. Com aprovação ou pré-aprovação, nada muda.
// ATENÇÃO: o estado pendente só protege se as policies e funções do app exigirem a coluna de aprovação
// JUNTO com `ativo` e o papel. O pendente tem sessão (o magic link sai) e `ativo: true`; o kit não confere
// as policies do app.

const senhaAleatoria = () => globalThis.crypto.randomUUID() + globalThis.crypto.randomUUID()
const nomeOuEmail = (ctx) => ctx.nome || ctx.email
/** O mesmo payload do token, visto como o de um usuário comum do Portal (para o papel de quem nasce pendente). */
const comoUsuarioComum = (payload) => ({ ...payload, portal_role: 'user' })

/** Colunas que o adaptador já usa: a de aprovação tem de ser outra. */
const COLUNAS_DO_PERFIL = ['user_id', 'nome', 'email', 'papel', 'ativo']
const NOME_DE_COLUNA = /^[A-Za-z_][A-Za-z0-9_]*$/
const INSTRUCAO_COLUNA = "perfisAtivo: aprovaNoPrimeiroAcesso e preAprovacao exigem colunaAprovado, a coluna PRÓPRIA de aprovação do app "
  + "(ex.: perfisAtivo({ colunaAprovado: 'aprovado', … }) para uma coluna boolean `aprovado` na tabela de perfis). "
  + 'O kit nunca usa ativo = false como pendente: desativado é outra coisa.'

/**
 * @param {{
 *   papelInicial?: (payload: object) => string,
 *   semPerfilEmContaExistente?: 'criar' | 'recusar',
 *   schema?: string,
 *   tabela?: string,
 *   esperarGatilhoMs?: number,
 *   campoPapelResposta?: string,
 *   colunaAprovado?: string | null,                           // v0.3.0; padrão null (sem estado pendente, como na v0.2.5)
 *   aprovaNoPrimeiroAcesso?: (payload: object) => boolean,   // v0.3.0; padrão () => true; exige colunaAprovado
 *   preAprovacao?: { ler: Function, aplicar: Function } | null,  // v0.3.0; padrão null; exige colunaAprovado
 * }} [opcoes]
 */
export function perfisAtivo({
  papelInicial = (p) => (p.portal_role === 'admin' ? 'admin' : 'colaborador'),
  semPerfilEmContaExistente = 'criar',
  schema = 'rh',
  tabela = 'perfis',
  esperarGatilhoMs = 0,
  campoPapelResposta = 'papel',
  colunaAprovado = null,
  aprovaNoPrimeiroAcesso,
  preAprovacao = null,
} = {}) {
  // Erro de configuração aparece na carga da função, não no 1º login.
  colunaAprovado = colunaAprovado ?? null
  if (colunaAprovado !== null
    && (typeof colunaAprovado !== 'string' || !NOME_DE_COLUNA.test(colunaAprovado) || COLUNAS_DO_PERFIL.includes(colunaAprovado))) {
    throw new Error(`perfisAtivo: colunaAprovado inválida: ${JSON.stringify(colunaAprovado)} `
      + `(use o nome de uma coluna boolean própria, diferente de ${COLUNAS_DO_PERFIL.join(', ')}; ativo = false é desativado, não pendente)`)
  }
  const declarouAprovacao = aprovaNoPrimeiroAcesso !== undefined
  if (declarouAprovacao && typeof aprovaNoPrimeiroAcesso !== 'function') {
    throw new Error('perfisAtivo: aprovaNoPrimeiroAcesso precisa ser função (payload) => boolean')
  }
  if (preAprovacao !== null && preAprovacao !== undefined
    && (typeof preAprovacao !== 'object' || typeof preAprovacao.ler !== 'function' || typeof preAprovacao.aplicar !== 'function')) {
    throw new Error('perfisAtivo: preAprovacao precisa ser { ler, aplicar } (criarPreAprovacao) ou null')
  }
  preAprovacao = preAprovacao ?? null
  if ((declarouAprovacao || preAprovacao) && colunaAprovado === null) throw new Error(INSTRUCAO_COLUNA)
  if (!declarouAprovacao) aprovaNoPrimeiroAcesso = () => true

  const t = (admin) => admin.schema(schema).from(tabela)
  const colunasLidas = colunaAprovado === null ? 'user_id, papel, ativo' : `user_id, papel, ativo, ${colunaAprovado}`

  /** Linha de pré-aprovação que vale para a conta, ou null. Erro LANÇA (o receptor responde 503). */
  async function lerPre(admin, usuario, ctx) {
    const pre = preAprovacao ? await preAprovacao.ler(admin, usuario, ctx) : null
    if (!pre) return null
    if (typeof pre.papel !== 'string' || pre.papel === '') throw new Error('perfisAtivo: pré-aprovação sem papel')
    return pre
  }

  // Segunda tentativa: a pré-aprovação lida em `ler` segue para `atualizarIdentidade` pelo `ctx`
  // (o receptor passa o MESMO objeto às duas etapas). Fora desse caminho, nada fica guardado.
  const preDaSegundaTentativa = new WeakMap()

  return {
    tipo: 'perfisAtivo',
    tabela,
    schema,
    busca: { schema, tabelaPerfil: tabela, colunaEmail: 'email', colunaId: 'user_id' },
    esperarGatilhoMs,
    semPerfilEmContaExistente,
    papelInicial,
    campoPapelResposta,
    // O contrato lê (como lê `papelInicial`).
    colunaAprovado,
    aprovaNoPrimeiroAcesso,
    preAprovacao,

    contaNova: (ctx) => ({ password: senhaAleatoria(), user_metadata: { nome: nomeOuEmail(ctx) } }),

    async ler(admin, usuario, ctx) {
      const { data, error } = await t(admin).select(colunasLidas).eq('user_id', usuario.id).maybeSingle()
      if (error) throw error
      const existe = Boolean(data)
      const desativado = existe && data.ativo === false
      // Sem a coluna declarada não existe estado pendente (v0.2.5). Com ela, só `true` libera.
      const pendente = existe && colunaAprovado !== null && data[colunaAprovado] !== true
      // Conta existente, ATIVA e pendente: só a pré-aprovação válida (segunda tentativa) evita o bloqueio.
      const pre = ctx?.contaCriadaAgora === false && pendente && !desativado ? await lerPre(admin, usuario, ctx) : null
      if (pre) preDaSegundaTentativa.set(ctx, pre)
      return {
        existe,
        // Desativado é barrado sempre, como hoje. Conta criada agora com perfil pendente (outra aba
        // inseriu no mesmo instante) não é bloqueio: entra pendente e o app mostra a tela.
        bloqueado: desativado || (ctx?.contaCriadaAgora !== true && pendente && !pre),
        // Na segunda tentativa o receptor responde com este papel: tem de ser o da pré, não o antigo.
        papelLocal: pre ? pre.papel : (data?.papel ?? null),
      }
    },

    async primeiroAcesso(admin, usuario, ctx) {
      const nome = nomeOuEmail(ctx)
      if (ctx.existe) {
        // Conta criada agora com perfil já inserido (corrida): só a identificação, como na v0.2.5.
        const { error } = await t(admin).update({ nome, email: ctx.email }).eq('user_id', usuario.id)
        if (error) throw error
        return ctx.papelLocal
      }
      const pre = await lerPre(admin, usuario, ctx)
      const aprovar = Boolean(pre) || aprovaNoPrimeiroAcesso(ctx.payload) === true
      // Pendente nunca guarda papel derivado de admin do Portal: recebe o papel de um usuário comum.
      const papel = pre ? pre.papel : papelInicial(aprovar ? ctx.payload : comoUsuarioComum(ctx.payload))
      // `ativo` nasce sempre true: o pendente mora só na coluna própria.
      const { error } = await t(admin).insert({
        user_id: usuario.id, nome, email: ctx.email, papel, ativo: true, ...(colunaAprovado !== null ? { [colunaAprovado]: aprovar } : {}),
      })
      if (error) throw error
      // Depois de o perfil gravar: extras do app e marca `aplicado` em todas as linhas pendentes do par.
      if (pre) await preAprovacao.aplicar(admin, usuario, pre, ctx)
      return papel
    },

    async atualizarIdentidade(admin, usuario, ctx) {
      // Só há pré aqui quando `ler` achou perfil ATIVO e PENDENTE com pré-aprovação válida (segunda tentativa).
      const pre = preDaSegundaTentativa.get(ctx) ?? null
      const { error } = await t(admin)
        .update({ nome: nomeOuEmail(ctx), email: ctx.email, ...(pre ? { [colunaAprovado]: true, papel: pre.papel } : {}) })
        .eq('user_id', usuario.id)
      if (error) throw error
      if (pre) await preAprovacao.aplicar(admin, usuario, pre, ctx)
    },
  }
}

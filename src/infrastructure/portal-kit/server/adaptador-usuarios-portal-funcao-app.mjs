// @ts-self-types="./adaptador-usuarios-portal-funcao-app.d.mts"
// @atr/portal-kit · server/adaptador-usuarios-portal-funcao-app.mjs
// Adaptador de perfil para o Hub de Engenharia (hub-auditor, hub-sst, hub-fvs, hub-posvenda,
// hub-conferencia): perfil em `auditor.usuarios_portal(auth_user_id, email, role, status_aprovacao)`
// e função POR APP em `shared.funcao_app(usuario_id, app, funcao)`.
//
// Regras (iguais ao portal-login do Hub em produção na migração, a v38):
// - Conta nova com o perfil que o gatilho do banco criou → update { email, status_aprovacao:
//   'aprovado', role: papelPerfil(payload) } por auth_user_id.
// - Sem perfil (o gatilho não rodou, ou conta existente sem perfil) → insert do mesmo conteúdo.
// - A função no app nasce SÓ junto com a conta (`ctx.contaCriadaAgora`): upsert de UMA linha
//   { usuario_id, app, funcao } com onConflict 'usuario_id,app' e ignoreDuplicates (se a linha já
//   existe, alguém já decidiu e o login não reescreve). v0.4.1: com `funcaoNoAcessoSeguinte`, também
//   no acesso seguinte (ver abaixo).
// - Conta existente com perfil: NENHUMA gravação. Papel, status e função locais prevalecem; por isso
//   este adaptador, sem pré-aprovação declarada (nem `funcaoNoAcessoSeguinte`), não tem `atualizarIdentidade`.
// - Erro de leitura lança; erro ao gravar o perfil lança; erro ao gravar a função lança. O receptor
//   responde 503 sem magic link: seguir sem a função deixaria a conta aprovada e sem função, e o
//   acesso seguinte já não é o primeiro.
// - Por padrão NÃO barra ninguém (`barrarBloqueado: false`): bloqueado e pendente recebem sessão e
//   o app mostra a tela, como hoje. Com a opção ligada, só `status_aprovacao = 'bloqueado'` barra.
//
// O que o token concede NÃO mora aqui. `funcaoConcedida` e `papelPerfil` são a régua do app,
// injetada (no Hub: `_shared/funcaoPortal.ts`, com o teste e o gate dele). O kit só grava o que a
// régua devolver; o contrato (`funcao_por_app_primeiro_acesso`) confere a régua do app.
//
// v0.3.0 — quatro opções, todas com padrão igual ao da v0.2.5 (sem elas, cada comando gravado e cada
// resposta são os mesmos, e o objeto continua sem `atualizarIdentidade`):
// - `aprovaNoPrimeiroAcesso(payload)`: só `true` aprova no 1º acesso. Padrão `() => true`. Com falso e
//   sem pré-aprovação, o perfil nasce PENDENTE: o update não leva `status_aprovacao` (fica o 'pendente'
//   do gatilho) e o insert leva 'pendente'. O magic link sai e o app mostra a tela, como hoje.
// - Quem nasce PENDENTE nunca guarda papel nem função derivados de admin do Portal (R10): o `role` e a
//   função gravados são os que a régua dá a um usuário COMUM (o mesmo payload com `portal_role: 'user'`),
//   e nunca mais do que o token concede (se a régua não dá nada ao token, nada é gravado). A função
//   continua nascendo só com a conta. Quem dá a função definitiva é quem aprova, no app.
// - `preAprovacao` (`criarPreAprovacao`, de `./pre-aprovacao.mjs`; padrão `null`): com linha válida
//   para o slug do token, o perfil nasce 'aprovado' e a conta recebe a função que a régua dá a um
//   usuário comum NO APP DO SLUG — nunca a de admin, nem função em outro app. O papel da linha não é
//   gravado em lugar nenhum: os extras do app (obra, cargo, atividades) são do `aplicarExtras` do leitor.
//   `preAprovacao.aplicar` roda DEPOIS de o perfil e a função gravarem; erro lança (503 sem magic link).
// - Segunda tentativa: SÓ com `preAprovacao` declarada o objeto ganha `atualizarIdentidade`, e ele só
//   age quando `ler` achou perfil ainda 'pendente' E linha válida para a conta (o leitor exige conta
//   que o kit DESTE slug criou, nascida depois da linha, com até 15 minutos de vida). Aí aprova, grava
//   a função de usuário comum e aplica. Fora disso não grava nada: conta existente segue intocada.
// - `colunaAppOrigem` + `appDeOrigem(payload)` (padrão `null` e `() => null`; andam juntas): em quem
//   nasce PENDENTE, grava na coluna declarada o app pelo qual a pessoa chegou, para ela aparecer na
//   fila de pendentes daquele app. É rótulo de origem: não concede acesso. Quem nasce aprovado não a recebe.
//
// v0.4.1 — `funcaoNoAcessoSeguinte(admin, usuarioId, app) => Promise<boolean>` (padrão `null`: sem ela,
// cada comando gravado e cada resposta são os da v0.4.0). Com ela, a função no app deixa de nascer só
// com a conta: em TODA entrada de conta que já existia (com perfil, ou sem perfil e o perfil criado
// agora), se a régua dá função para o token e a conta NÃO tem linha em `<schemaFuncao>.<tabelaFuncao>`
// para aquele app, o adaptador grava UMA linha pelo mesmo upsert que não reescreve. O TETO é a função
// de usuário COMUM (a régua com portal_role 'user'): o login de conta existente nunca grava admin, nem
// para admin do Portal — admin em app de conta existente é decisão de quem gere o app. Exceções:
// - perfil `status_aprovacao = 'bloqueado'` → não grava (nem pergunta ao app);
// - o app responde algo diferente de `true` (no Hub: a pessoa tem marca de removida DAQUELE app) → não grava.
// Quem já tem linha naquele app: nada muda (nem a pergunta ao app é feita). Na segunda tentativa da pré-aprovação vale a pré,
// não esta regra. Erro na leitura da função, na pergunta ao app ou na gravação LANÇA (503 sem magic link).
// O kit não sabe o que é "removido": a decisão é do app, injetada.
// ATENÇÃO: o estado pendente só protege se as funções e policies do app exigirem `status_aprovacao =
// 'aprovado'` JUNTO com a função. O pendente tem sessão e pode ter linha de função; o kit não confere
// as policies do app.

const senhaAleatoria = () => globalThis.crypto.randomUUID() + globalThis.crypto.randomUUID()
/** O mesmo payload do token, visto como o de um usuário comum do Portal (papel e função de quem nasce pendente ou entra pela pré-aprovação). */
const comoUsuarioComum = (payload) => ({ ...payload, portal_role: 'user' })
const textoNaoVazio = (v) => typeof v === 'string' && v.trim() !== ''

/** Colunas que o adaptador já usa: a do app de origem tem de ser outra. */
const COLUNAS_DO_PERFIL = ['auth_user_id', 'email', 'role', 'status_aprovacao']
const NOME_DE_COLUNA = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * @param {{
 *   funcaoConcedida: (payload: object) => { app: string, funcao: string } | null,
 *   papelPerfil: (payload: object) => string | null,
 *   schemaPerfil?: string,
 *   tabelaPerfil?: string,
 *   schemaFuncao?: string,
 *   tabelaFuncao?: string,
 *   esperarGatilhoMs?: number,
 *   semPerfilEmContaExistente?: 'criar' | 'recusar',
 *   barrarBloqueado?: boolean,
 *   aprovaNoPrimeiroAcesso?: (payload: object) => boolean,       // v0.3.0; padrão () => true (como na v0.2.5)
 *   preAprovacao?: { ler: Function, aplicar: Function } | null,  // v0.3.0; padrão null
 *   colunaAppOrigem?: string | null,                             // v0.3.0; padrão null; exige appDeOrigem
 *   appDeOrigem?: (payload: object) => string | null,            // v0.3.0; padrão () => null; exige colunaAppOrigem
 *   funcaoNoAcessoSeguinte?: ((admin: object, usuarioId: string, app: string) => Promise<boolean>) | null, // v0.4.1; padrão null
 * }} opcoes
 */
export function usuariosPortalFuncaoApp({
  funcaoConcedida,
  papelPerfil,
  schemaPerfil = 'auditor',
  tabelaPerfil = 'usuarios_portal',
  schemaFuncao = 'shared',
  tabelaFuncao = 'funcao_app',
  esperarGatilhoMs = 500,
  semPerfilEmContaExistente = 'criar',
  barrarBloqueado = false,
  aprovaNoPrimeiroAcesso = () => true,
  preAprovacao = null,
  colunaAppOrigem = null,
  appDeOrigem,
  funcaoNoAcessoSeguinte = null,
} = {}) {
  // Sem régua não há adaptador: falha na carga da função, não no primeiro login.
  if (typeof funcaoConcedida !== 'function') {
    throw new TypeError('usuariosPortalFuncaoApp: funcaoConcedida (payload → { app, funcao } | null) é obrigatória')
  }
  if (typeof papelPerfil !== 'function') {
    throw new TypeError('usuariosPortalFuncaoApp: papelPerfil (payload → papel | null) é obrigatória')
  }
  // v0.3.0: erro de configuração das opções novas também aparece na carga.
  if (typeof aprovaNoPrimeiroAcesso !== 'function') {
    throw new TypeError('usuariosPortalFuncaoApp: aprovaNoPrimeiroAcesso precisa ser função (payload) => boolean')
  }
  if (preAprovacao !== null && preAprovacao !== undefined
    && (typeof preAprovacao !== 'object' || typeof preAprovacao.ler !== 'function' || typeof preAprovacao.aplicar !== 'function')) {
    throw new TypeError('usuariosPortalFuncaoApp: preAprovacao precisa ser { ler, aplicar } (criarPreAprovacao) ou null')
  }
  preAprovacao = preAprovacao ?? null
  colunaAppOrigem = colunaAppOrigem ?? null
  if (colunaAppOrigem !== null
    && (typeof colunaAppOrigem !== 'string' || !NOME_DE_COLUNA.test(colunaAppOrigem) || COLUNAS_DO_PERFIL.includes(colunaAppOrigem))) {
    throw new TypeError(`usuariosPortalFuncaoApp: colunaAppOrigem inválida: ${JSON.stringify(colunaAppOrigem)} `
      + `(use o nome da coluna do app de origem, diferente de ${COLUNAS_DO_PERFIL.join(', ')})`)
  }
  const declarouOrigem = appDeOrigem !== undefined && appDeOrigem !== null
  if (declarouOrigem && typeof appDeOrigem !== 'function') {
    throw new TypeError('usuariosPortalFuncaoApp: appDeOrigem precisa ser função (payload) => app | null')
  }
  if (colunaAppOrigem !== null && !declarouOrigem) {
    throw new TypeError('usuariosPortalFuncaoApp: colunaAppOrigem exige appDeOrigem (payload → app pelo qual a pessoa chegou)')
  }
  if (declarouOrigem && colunaAppOrigem === null) {
    throw new TypeError('usuariosPortalFuncaoApp: appDeOrigem exige colunaAppOrigem (a coluna do perfil que guarda o app de origem)')
  }
  if (!declarouOrigem) appDeOrigem = () => null
  // v0.4.1
  funcaoNoAcessoSeguinte = funcaoNoAcessoSeguinte ?? null
  if (funcaoNoAcessoSeguinte !== null && typeof funcaoNoAcessoSeguinte !== 'function') {
    throw new TypeError('usuariosPortalFuncaoApp: funcaoNoAcessoSeguinte precisa ser função (admin, usuarioId, app) => Promise<boolean>, ou null')
  }

  const perfis = (admin) => admin.schema(schemaPerfil).from(tabelaPerfil)
  const funcoes = (admin) => admin.schema(schemaFuncao).from(tabelaFuncao)

  /** Papel e função que a régua dá a um usuário COMUM do Portal, para o mesmo token. */
  const papelDeUsuarioComum = (payload) => papelPerfil(comoUsuarioComum(payload)) ?? null
  const funcaoDeUsuarioComum = (payload) => funcaoConcedida(comoUsuarioComum(payload)) ?? null
  /** App de origem de quem nasce pendente, ou null (sem coluna declarada, ou a régua não devolveu texto). */
  const origemDe = (payload) => {
    if (colunaAppOrigem === null) return null
    const app = appDeOrigem(payload)
    return textoNaoVazio(app) ? app : null
  }

  /** Linha de pré-aprovação que vale para a conta, ou null. Erro LANÇA (o receptor responde 503). */
  async function lerPre(admin, usuario, ctx) {
    const pre = preAprovacao ? await preAprovacao.ler(admin, usuario, ctx) : null
    if (!pre) return null
    if (typeof pre !== 'object') throw new Error('usuariosPortalFuncaoApp: pré-aprovação fora da forma (esperada a linha lida)')
    return pre
  }

  /** A função que a pré-aprovação concede: a de usuário comum. Sem ela, LANÇA antes de qualquer gravação. */
  function funcaoPelaPre(payload) {
    const funcao = funcaoDeUsuarioComum(payload)
    if (!funcao) throw new Error('usuariosPortalFuncaoApp: pré-aprovação válida, mas a régua não dá função ao usuário comum neste app')
    return funcao
  }

  /** UMA linha de função por app, por upsert que não reescreve a que já existe. Erro LANÇA. */
  async function gravarFuncao(admin, usuario, concedida) {
    if (concedida) {
      const { error: erroFuncao } = await funcoes(admin).upsert(
        { usuario_id: usuario.id, app: concedida.app, funcao: concedida.funcao },
        { onConflict: 'usuario_id,app', ignoreDuplicates: true },
      )
      if (erroFuncao) throw erroFuncao // o login falha se a função no app não gravar
    }
  }

  /**
   * v0.4.1 — acesso seguinte (só com `funcaoNoAcessoSeguinte`). Conta que já existia, perfil com
   * `status`: grava a função de usuário COMUM (teto: nunca admin) quando a conta não tem
   * linha naquele app e o app responde `true`. Bloqueado, régua sem função, linha existente ou resposta
   * diferente de `true` → nada. Erro LANÇA.
   */
  async function funcaoDoAcessoSeguinte(admin, usuario, payload, status) {
    if (funcaoNoAcessoSeguinte === null || status === 'bloqueado') return
    // Só quando o token concede alguma função; e então o teto é a de usuário comum (nunca admin por login
    // de conta existente). Papel do Portal que a régua não reconhece continua sem nada.
    const concedida = funcaoConcedida(payload) ? funcaoDeUsuarioComum(payload) : null
    if (!concedida) return
    const { data, error } = await funcoes(admin)
      .select('usuario_id').eq('usuario_id', usuario.id).eq('app', concedida.app).maybeSingle()
    if (error) throw error
    if (data) return // alguém já decidiu a função neste app: o login não reescreve
    if (await funcaoNoAcessoSeguinte(admin, usuario.id, concedida.app) !== true) return
    await gravarFuncao(admin, usuario, concedida)
  }

  // v0.4.1: status do perfil lido em `ler`, para o acesso seguinte em `atualizarIdentidade` (mesmo `ctx`).
  const statusDoAcesso = new WeakMap()

  // Segunda tentativa: a pré-aprovação lida em `ler` segue para `atualizarIdentidade` pelo `ctx`
  // (o receptor passa o MESMO objeto às duas etapas). Fora desse caminho, nada fica guardado.
  const preDaSegundaTentativa = new WeakMap()

  /**
   * v0.3.0 — só é anexado ao adaptador quando há `preAprovacao`. Age SÓ quando `ler` achou perfil
   * 'pendente' com pré-aprovação válida; sem isso, conta existente com perfil não é tocada.
   */
  async function segundaTentativa(admin, usuario, ctx) {
    const pre = preDaSegundaTentativa.get(ctx) ?? null
    if (!pre) return
    const funcao = funcaoPelaPre(ctx.payload)
    const papel = papelDeUsuarioComum(ctx.payload)
    const { error } = await perfis(admin)
      .update({ email: ctx.email, status_aprovacao: 'aprovado', ...(papel ? { role: papel } : {}) })
      .eq('auth_user_id', usuario.id)
    if (error) throw error
    await gravarFuncao(admin, usuario, funcao)
    // Depois de o perfil e a função gravarem: extras do app e marca `aplicado` em todas as linhas pendentes do par.
    await preAprovacao.aplicar(admin, usuario, pre, ctx)
  }

  const adaptador = {
    tipo: 'usuariosPortalFuncaoApp',
    tabela: tabelaPerfil,
    schema: schemaPerfil,
    tabelaFuncao,
    schemaFuncao,
    busca: { tabelaPerfil: null }, // só listUsers: o perfil do Hub não é fonte de busca por e-mail
    esperarGatilhoMs,
    semPerfilEmContaExistente,
    barrarBloqueado: barrarBloqueado === true,
    papelInicial: (payload) => papelPerfil(payload) ?? null,
    // O contrato lê (como lê `papelInicial`).
    aprovaNoPrimeiroAcesso,
    preAprovacao,
    colunaAppOrigem,
    appDeOrigem,

    // Síncrona e sem cliente: só monta os parâmetros do createUser.
    contaNova: (ctx) => ({ password: senhaAleatoria(), user_metadata: { full_name: ctx.nome || ctx.email } }),

    async ler(admin, usuario, ctx) {
      const { data, error } = await perfis(admin)
        .select('auth_user_id, role, status_aprovacao').eq('auth_user_id', usuario.id).maybeSingle()
      if (error) throw error
      // v0.3.0: conta que NÃO nasceu neste acesso, com perfil ainda 'pendente' — só aqui a pré-aprovação
      // é consultada (segunda tentativa). Perfil aprovado ou bloqueado nunca a consulta.
      const pre = preAprovacao && ctx?.contaCriadaAgora === false && data?.status_aprovacao === 'pendente'
        ? await lerPre(admin, usuario, ctx)
        : null
      if (pre) preDaSegundaTentativa.set(ctx, pre)
      if (funcaoNoAcessoSeguinte !== null && ctx && typeof ctx === 'object' && data) statusDoAcesso.set(ctx, data.status_aprovacao ?? null)
      return {
        existe: Boolean(data),
        bloqueado: barrarBloqueado === true && data?.status_aprovacao === 'bloqueado',
        // Na segunda tentativa o receptor responde com este papel: o que `atualizarIdentidade` vai gravar.
        papelLocal: pre ? (papelDeUsuarioComum(ctx.payload) ?? data.role ?? null) : (data?.role ?? null),
      }
    },

    async primeiroAcesso(admin, usuario, ctx) {
      // v0.3.0: sem `preAprovacao` declarada nada é lido aqui, e `aprovar` é o do app (padrão: aprova).
      const pre = await lerPre(admin, usuario, ctx)
      const aprovar = Boolean(pre) || aprovaNoPrimeiroAcesso(ctx.payload) === true
      const funcaoDaPre = pre ? funcaoPelaPre(ctx.payload) : null
      let papel
      if (pre) {
        papel = papelDeUsuarioComum(ctx.payload)
      } else {
        papel = papelPerfil(ctx.payload) ?? null
        // Pendente nunca guarda papel derivado de admin do Portal (R10), nem mais do que o token concede.
        if (!aprovar && papel !== null) papel = papelDeUsuarioComum(ctx.payload)
      }
      const origem = aprovar ? null : origemDe(ctx.payload)
      // Sem papel da régua, a coluna não vai no comando: fica o que o gatilho (ou o DEFAULT) gravou.
      const linha = aprovar
        ? { email: ctx.email, status_aprovacao: 'aprovado', ...(papel ? { role: papel } : {}) }
        // Pendente: o update não leva status_aprovacao (fica o 'pendente' do gatilho); o insert leva 'pendente'.
        : {
          email: ctx.email, ...(ctx.existe ? {} : { status_aprovacao: 'pendente' }),
          ...(papel ? { role: papel } : {}), ...(origem ? { [colunaAppOrigem]: origem } : {}),
        }
      const { error } = ctx.existe
        ? await perfis(admin).update(linha).eq('auth_user_id', usuario.id)
        : await perfis(admin).insert({ auth_user_id: usuario.id, ...linha })
      if (error) throw error

      // A função por app só nasce com a conta. Conta que já existia (com ou sem perfil) não ganha função aqui.
      const concedida = ctx.contaCriadaAgora ? funcaoConcedida(ctx.payload) : null
      // v0.3.0 — o que é gravado: pela pré-aprovação, a função de usuário comum (também na segunda
      // tentativa sem perfil, em conta que o kit criou); quem nasce PENDENTE recebe a de usuário comum
      // no lugar da que o token concederia, nunca a de admin (R10), e nada se o token não concede nada.
      const funcao = pre ? funcaoDaPre : (aprovar || !concedida ? concedida : funcaoDeUsuarioComum(ctx.payload))
      await gravarFuncao(admin, usuario, funcao)
      // v0.4.1: conta que já existia, sem perfil (o perfil nasceu agora) e sem pré → regra do acesso seguinte.
      if (!ctx.contaCriadaAgora && !pre) await funcaoDoAcessoSeguinte(admin, usuario, ctx.payload, aprovar ? 'aprovado' : 'pendente')
      // Depois de o perfil e a função gravarem: extras do app e marca `aplicado` em todas as linhas pendentes do par.
      if (pre) await preAprovacao.aplicar(admin, usuario, pre, ctx)
      return papel ?? ctx.papelLocal ?? null
    },
  }
  // Sem pré-aprovação declarada (nem `funcaoNoAcessoSeguinte`), o objeto NÃO tem este método: conta
  // existente com perfil não é tocada, como na v0.2.5. Com a pré, o método age na segunda tentativa (ver
  // `segundaTentativa`); v0.4.1: fora dela, com `funcaoNoAcessoSeguinte`, aplica a regra do acesso seguinte.
  if (preAprovacao && funcaoNoAcessoSeguinte === null) {
    adaptador.atualizarIdentidade = segundaTentativa
  } else if (funcaoNoAcessoSeguinte !== null) {
    adaptador.atualizarIdentidade = async (admin, usuario, ctx) => {
      if (preDaSegundaTentativa.has(ctx)) return segundaTentativa(admin, usuario, ctx)
      if (!statusDoAcesso.has(ctx)) return // ctx que `ler` não viu: nada é gravado
      await funcaoDoAcessoSeguinte(admin, usuario, ctx.payload, statusDoAcesso.get(ctx))
    }
  }
  return adaptador
}

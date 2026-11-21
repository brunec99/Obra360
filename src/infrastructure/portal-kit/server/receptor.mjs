// @ts-self-types="./receptor.d.mts"
// @atr/portal-kit · server/receptor.mjs
// Fábrica do receptor `portal-login`: troca o token do Portal Inteligência por sessão local.
//
// Referência: portal-login do Mapa BI (v21), com as correções decididas na fase 1 (D1–D20).
// O comportamento por app (onde mora o perfil, papel, bloqueio) vem do ADAPTADOR (`perfil`).
//
// Ordem fixa (é contrato):
//   OPTIONS → método → origem (opcional) → JWKS → corpo → token → núcleo → app_slug → e-mail
//   → uso único → achar/criar usuário → conta existente com origem comprovada (v0.2.4)
//   → ler perfil → recusas → gravar → magic link
//
// Falha FECHADA: todo erro de leitura/gravação vira 503 e o magic link não sai.
// Para o navegador vão só textos fixos (`mensagens`); o erro cru vai só para `log.error`.
// Sem API de runtime no topo: o ambiente vem por parâmetro (`env`), lido a cada requisição.

import { ErroTokenPortal, lerChavesPublicas, verificarTokenPortal } from '../core/ssoV2.mjs'
import { cabecalhosCors, json, lerListaDeOrigens, origensPermitidas, preflight, redirectSeguro } from './http.mjs'
import { acharUsuarioPorEmail } from './usuarios.mjs'

export const MENSAGENS_PADRAO = Object.freeze({
  metodo: 'Método não permitido.',
  origem: 'Origem não permitida.',
  config: 'Configuração do SSO indisponível.',
  requisicao: 'Requisição inválida.',
  semToken: 'Link de acesso sem token. Volte ao Portal Inteligência e entre de novo.',
  tokenInvalido: 'Link de acesso inválido ou vencido. Volte ao Portal Inteligência e entre de novo.',
  appInvalido: 'Este link de acesso não é para este sistema.',
  emailInvalido: 'O e-mail do seu cadastro no Portal é inválido. Fale com o administrador do Portal.',
  usoUnicoIndisponivel: 'Não foi possível validar o token agora. Volte ao Portal e tente de novo.',
  tokenJaUsado: 'Este link já foi usado. Volte ao Portal Inteligência e entre de novo.',
  indisponivel: 'Não foi possível validar o seu acesso agora. Volte ao Portal e tente de novo.',
  perfilAusente: 'Você ainda não tem cadastro neste sistema. Peça acesso a um administrador.',
  bloqueado: 'Seu acesso a este sistema ainda não foi liberado. Peça a um administrador.',
  erroInterno: 'Erro interno. Tente de novo em instantes.',
  // v0.2.4: o mesmo texto para os dois 403 de conta existente (decisão de 09/11); o motivo fica no `code` e no log.
  contaNaoVerificada: 'Este e-mail já tem uma conta. Fale com o administrador.',
  contaNaoConfirmada: 'Este e-mail já tem uma conta. Fale com o administrador.',
})

/** `app_metadata.origem` / `app_metadata.criado_por` que provam que a conta saiu de um caminho conhecido. */
export const ORIGENS_CONFIAVEIS_PADRAO = Object.freeze(['comercial', 'portal-admin'])

/** Versão da marca `app_metadata.portal_kit` gravada nas contas que o kit cria. */
const VERSAO_MARCA = 1

const ehObjeto = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/**
 * Decide se uma conta EXISTENTE (auth.users) pode ser aproveitada pelo login do Portal.
 * Pré-sequestro: com o cadastro aberto, um terceiro cria antes a conta com o e-mail do funcionário
 * e a senha dele; aproveitar essa conta deixaria a senha do terceiro valendo.
 * Só usa campos que apenas o servidor grava (`app_metadata`, `invited_at`, `created_at`,
 * `email_confirmed_at`); nunca `user_metadata`, que o dono da conta pode alterar.
 * @param {any} usuario  objeto `user` do GoTrue (getUserById / listUsers)
 * @param {{ corteMs: number, origensConfiaveis: readonly string[] }} opcoes
 * @returns {{ aceita: boolean, motivo: 'nao_confirmada' | 'marca_kit' | 'origem' | 'convite' | 'so_google' | 'anterior_ao_corte' | 'sem_origem' }}
 */
export function motivoContaConfiavel(usuario, { corteMs, origensConfiaveis }) {
  if (!usuario?.email_confirmed_at) return { aceita: false, motivo: 'nao_confirmada' }
  const app = ehObjeto(usuario.app_metadata) ? usuario.app_metadata : {}
  if (ehObjeto(app.portal_kit)) return { aceita: true, motivo: 'marca_kit' }
  const origens = Array.isArray(origensConfiaveis) ? origensConfiaveis : []
  for (const campo of ['origem', 'criado_por']) {
    if (typeof app[campo] === 'string' && origens.includes(app[campo])) return { aceita: true, motivo: 'origem' }
  }
  if (usuario.invited_at) return { aceita: true, motivo: 'convite' }
  if (Array.isArray(app.providers) && app.providers.length === 1 && app.providers[0] === 'google') {
    return { aceita: true, motivo: 'so_google' }
  }
  const criadaEm = Date.parse(usuario.created_at ?? '')
  if (Number.isFinite(criadaEm) && Number.isFinite(corteMs) && criadaEm < corteMs) return { aceita: true, motivo: 'anterior_ao_corte' }
  return { aceita: false, motivo: 'sem_origem' }
}

const TAMANHO_MAXIMO_TOKEN = 4096
const FORMATO_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const esperarPadrao = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** DEV_ORIGINS: só http://localhost[:porta] e http://127.0.0.1[:porta]; o resto é ignorado (LO-01). */
const FORMATO_ORIGEM_DEV = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/

/** Origem https na forma exata `https://host[:porta]` (sem barra, caminho, maiúscula nem :443). */
function origemHttpsExata(origem) {
  if (typeof origem !== 'string') return false
  try {
    const url = new URL(origem)
    return url.protocol === 'https:' && url.origin === origem
  } catch {
    return false
  }
}

/** Conta achada depois de erro no createUser só conta como "criada agora" se nasceu há até 2 min (ME-01). */
const JANELA_CONTA_DA_CORRIDA_MS = 120_000

/**
 * Parâmetros do createUser: contaNova do adaptador + aoCriarConta do app (metadata mesclada raso).
 * A marca `app_metadata.portal_kit` entra por ÚLTIMO (v0.2.4): o app não apaga nem troca.
 */
function montarContaNova(email, doAdaptador, doApp, appSlug) {
  const a = doAdaptador && typeof doAdaptador === 'object' ? doAdaptador : {}
  const b = doApp && typeof doApp === 'object' ? doApp : {}
  const params = { ...a, ...b, email, email_confirm: true }
  for (const campo of ['user_metadata', 'app_metadata']) {
    if (a[campo] || b[campo]) params[campo] = { ...(a[campo] ?? {}), ...(b[campo] ?? {}) }
  }
  params.app_metadata = { ...(params.app_metadata ?? {}), portal_kit: { app: appSlug, v: VERSAO_MARCA } }
  return params
}

/**
 * @param {{
 *   appSlug: string,                 // aud e app_slug esperados no token
 *   origensApp: string[],            // origens do próprio app (CORS e destinos de redirect)
 *   origemPadrao: string,            // destino quando a origem do pedido não é do app
 *   origensExtras?: string[],        // só CORS (ex.: o Portal); nunca viram destino
 *   exigirOrigem?: boolean,          // true = origem fora da lista recebe 403
 *   env?: { get(nome: string): string | undefined },
 *   devOrigins?: string[] | string,  // padrão: env DEV_ORIGINS; só http://localhost / 127.0.0.1
 *   criarCliente: Function,          // createClient do supabase-js do app
 *   rpcUsoUnico?: { schema?: string, nome?: string },  // campo omitido usa o padrão
 *   perfil: object,                  // adaptador (contrato no SUMMARY 01-02 / docs)
 *   mensagens?: Partial<typeof MENSAGENS_PADRAO>,
 *   aoCriarConta?: object | ((payload: object) => object),
 *   corteContaExistente: string,      // ISO, OBRIGATÓRIO (v0.2.4): instante logo antes do deploy da v0.2.4 neste app
 *   origensConfiaveis?: string[],     // app_metadata.origem/criado_por aceitos; padrão ['comercial', 'portal-admin']
 *   esperar?: (ms: number) => Promise<void>,
 *   log?: { log: Function, error: Function, warn?: Function },
 * }} config
 * @returns {(req: Request) => Promise<Response>}
 */
export function criarReceptorPortal({
  appSlug,
  origensApp,
  origemPadrao,
  origensExtras = [],
  exigirOrigem = false,
  env = globalThis.Deno?.env,
  devOrigins,
  criarCliente,
  rpcUsoUnico = { schema: 'public', nome: 'consumir_token_sso' },
  perfil,
  mensagens = {},
  aoCriarConta,
  corteContaExistente,
  origensConfiaveis = ORIGENS_CONFIAVEIS_PADRAO,
  esperar = esperarPadrao,
  log = console,
} = {}) {
  // Erro de configuração aparece na carga da função, não no 1º login.
  if (typeof appSlug !== 'string' || appSlug.trim() === '') throw new Error('criarReceptorPortal: appSlug obrigatório')
  if (!Array.isArray(origensApp) || origensApp.length === 0) throw new Error('criarReceptorPortal: origensApp obrigatório')
  // LO-01: origem fora do formato sumia do CORS em silêncio; agora a carga falha.
  for (const o of origensApp) {
    if (!origemHttpsExata(o)) throw new Error(`criarReceptorPortal: origem inválida em origensApp: ${JSON.stringify(o)} (use https://host[:porta], sem barra final nem caminho)`)
  }
  if (!Array.isArray(origensExtras)) throw new Error('criarReceptorPortal: origensExtras precisa ser lista')
  for (const o of origensExtras) {
    if (!origemHttpsExata(o)) throw new Error(`criarReceptorPortal: origem inválida em origensExtras: ${JSON.stringify(o)} (use https://host[:porta], sem barra final nem caminho)`)
  }
  if (!origensApp.includes(origemPadrao)) throw new Error('criarReceptorPortal: origemPadrao precisa estar em origensApp')
  if (typeof criarCliente !== 'function') throw new Error('criarReceptorPortal: criarCliente precisa ser função (createClient do supabase-js)')
  if (!perfil || typeof perfil.ler !== 'function') throw new Error('criarReceptorPortal: perfil.ler obrigatório (adaptador)')
  if (typeof perfil.primeiroAcesso !== 'function') throw new Error('criarReceptorPortal: perfil.primeiroAcesso obrigatório (adaptador)')
  const schemaRpc = rpcUsoUnico?.schema ?? 'public'
  const nomeRpc = rpcUsoUnico?.nome ?? 'consumir_token_sso'
  // v0.2.4: corte POR APP = instante logo antes do deploy da v0.2.4 naquele app. Sem padrão de propósito:
  // corte no futuro deixaria a janela aberta (conta pré-criada até lá vira "anterior ao corte" para
  // sempre); corte fixo antigo recusaria contas legítimas que a v0.2.3 criou até o app receber a v0.2.4.
  if (corteContaExistente === undefined) {
    throw new Error("criarReceptorPortal: corteContaExistente obrigatório (ISO do instante logo antes do deploy da v0.2.4 neste app, ex.: '2026-11-10T18:30:00Z')")
  }
  const corteMs = typeof corteContaExistente === 'string' ? Date.parse(corteContaExistente) : NaN
  if (!Number.isFinite(corteMs)) throw new Error(`criarReceptorPortal: corteContaExistente inválido: ${JSON.stringify(corteContaExistente)} (use data ISO, ex.: '2026-11-10T18:30:00Z')`)
  if (corteMs > Date.now()) {
    throw new Error(`criarReceptorPortal: corteContaExistente no futuro: ${JSON.stringify(corteContaExistente)} (deixaria a janela do pré-sequestro aberta até lá; use o instante logo antes do deploy)`)
  }
  if (!Array.isArray(origensConfiaveis) || origensConfiaveis.some((o) => typeof o !== 'string' || o.trim() === '')) {
    throw new Error('criarReceptorPortal: origensConfiaveis precisa ser lista de texto não vazio')
  }
  const origensDeConfianca = Object.freeze([...origensConfiaveis])
  const m = { ...MENSAGENS_PADRAO, ...mensagens }

  return async function receptor(req) {
    const origin = req.headers.get('origin') || ''
    let cors = {}
    try {
      const dev = (Array.isArray(devOrigins) ? devOrigins : lerListaDeOrigens(devOrigins ?? env?.get('DEV_ORIGINS')))
        .filter((o) => FORMATO_ORIGEM_DEV.test(o))
      const doApp = [...origensApp, ...dev]
      const permitidas = origensPermitidas({ app: doApp, extras: origensExtras })
      cors = cabecalhosCors(origin, permitidas)
      const responder = (status, corpo) => json(status, corpo, cors)

      // D1: preflight 204, com CORS só para origem da lista.
      if (req.method === 'OPTIONS') return preflight(req, permitidas)
      // D2
      if (req.method !== 'POST') return responder(405, { error: m.metodo })
      // D15
      if (exigirOrigem && !permitidas.includes(origin)) return responder(403, { error: m.origem, code: 'origem_invalida' })

      let chaves
      try {
        chaves = await lerChavesPublicas(env?.get('PORTAL_SSO_V2_JWKS') ?? '')
      } catch (err) {
        log.error(`[${appSlug}] configuração do SSO v2 inválida:`, err)
        return responder(500, { error: m.config, code: 'config_sso_v2_invalida' })
      }

      let corpo
      try {
        corpo = await req.json()
      } catch {
        return responder(400, { error: m.requisicao, code: 'requisicao_invalida' })
      }

      // D3: token ausente é 401 (não 400).
      const token = corpo && typeof corpo === 'object' ? corpo.token : undefined
      if (typeof token !== 'string' || token === '') return responder(401, { error: m.semToken, code: 'token_ausente' })
      if (token.length > TAMANHO_MAXIMO_TOKEN) return responder(401, { error: m.tokenInvalido, code: 'formato_invalido' })

      let verificado
      try {
        verificado = await verificarTokenPortal(token, { chaves, audiencias: [appSlug], escopo: 'sso' })
      } catch (err) {
        // D6: só o código do núcleo, nunca o texto do erro.
        if (err instanceof ErroTokenPortal) return responder(401, { error: m.tokenInvalido, code: err.codigo })
        throw err
      }
      const { payload, chaveUsoUnico } = verificado

      if (payload.app_slug !== appSlug) return responder(403, { error: m.appInvalido, code: 'app_invalido' })

      // D16: e-mail conferido ANTES de queimar o token.
      const email = String(payload.email ?? '').trim().toLowerCase()
      if (email.length > 254 || !FORMATO_EMAIL.test(email)) return responder(400, { error: m.emailInvalido, code: 'email_invalido' })
      const nome = String(payload.full_name ?? '').trim().slice(0, 200)

      const supabaseUrl = env?.get('SUPABASE_URL')
      const chaveServico = env?.get('SUPABASE_SERVICE_ROLE_KEY')
      if (!supabaseUrl || !chaveServico) {
        log.error(`[${appSlug}] SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausente`)
        return responder(500, { error: m.erroInterno })
      }
      const admin = criarCliente(supabaseUrl, chaveServico, { auth: { persistSession: false, autoRefreshToken: false } })

      // Uso único: depois de assinatura/prazo/app (token recusado não é queimado) e antes de
      // provisionar (quem perde a corrida não cria nada). Erro → 503; D4: só `true` aceita.
      const argsRpc = { p_token_hash: chaveUsoUnico, p_expira_em: new Date(payload.exp * 1000).toISOString() }
      const { data: primeiroUso, error: erroUso } = schemaRpc === 'public'
        ? await admin.rpc(nomeRpc, argsRpc)
        : await admin.schema(schemaRpc).rpc(nomeRpc, argsRpc)
      if (erroUso) {
        log.error(`[${appSlug}] falha ao consumir token:`, erroUso)
        return responder(503, { error: m.usoUnicoIndisponivel })
      }
      if (primeiroUso !== true) return responder(401, { error: m.tokenJaUsado, code: 'token_ja_usado' })

      log.log(JSON.stringify({ fn: appSlug, evento: 'token_aceito' }))

      // Falha fechada a partir daqui: qualquer erro → 503 com texto fixo, sem magic link.
      const indisponivel = (etapa, err) => {
        log.error(`[${appSlug}] falha ao ${etapa}:`, err)
        return responder(503, { error: m.indisponivel })
      }
      const achar = () => (typeof perfil.acharUsuario === 'function'
        ? perfil.acharUsuario(admin, email)
        : acharUsuarioPorEmail(admin, email, perfil.busca ?? {}))

      // Achar (D10: erro de leitura nunca vira "não existe", que criaria conta duplicada).
      let usuario
      try {
        usuario = await achar()
      } catch (err) {
        return indisponivel('achar o usuário', err)
      }

      // v0.2.4 (CAD-01): conta EXISTENTE só com origem comprovada, antes de ler ou gravar qualquer coisa.
      // A busca própria do adaptador (ex.: RPC do Comercial) devolve só { id, email }: a decisão usa a
      // conta lida do GoTrue por id. Erro → 503 (falha fechada).
      if (usuario) {
        let conta = usuario
        if (typeof perfil.acharUsuario === 'function') {
          try {
            const { data: porId, error: erroId } = await admin.auth.admin.getUserById(usuario.id)
            if (erroId) throw erroId
            conta = porId?.user
            if (!conta) throw new Error('getUserById sem user para a conta achada')
          } catch (err) {
            return indisponivel('conferir a conta existente', err)
          }
        }
        const confianca = motivoContaConfiavel(conta, { corteMs, origensConfiaveis: origensDeConfianca })
        if (!confianca.aceita) {
          const aviso = typeof log.warn === 'function' ? log.warn : log.log
          aviso(JSON.stringify({ fn: appSlug, evento: 'conta_existente_recusada', motivo: confianca.motivo }))
          return confianca.motivo === 'nao_confirmada'
            ? responder(403, { error: m.contaNaoConfirmada, code: 'conta_nao_confirmada' })
            : responder(403, { error: m.contaNaoVerificada, code: 'conta_nao_verificada' })
        }
      }

      // Criar (conta nova). Erro → refaz a busca 1× (outra aba pode ter criado no mesmo instante, ou o
      // GoTrue gravou e respondeu erro/timeout). ME-01: a conta recuperada assim é tratada como criada
      // agora SÓ se o created_at (lido de novo pelo getUserById) estiver na janela; senão 503. Tratar
      // como "existente" lia o approved=false do gatilho como bloqueio, para sempre.
      let contaCriadaAgora = false
      if (!usuario) {
        const ctxConta = { payload, email, nome, contaCriadaAgora: true, log }
        let params
        try {
          params = montarContaNova(email, perfil.contaNova?.(ctxConta) ?? {}, typeof aoCriarConta === 'function' ? aoCriarConta(payload) : aoCriarConta, appSlug)
        } catch (err) {
          return indisponivel('montar a conta nova', err)
        }
        let criado
        let erroCriar
        try {
          ;({ data: criado, error: erroCriar } = await admin.auth.admin.createUser(params))
        } catch (err) {
          erroCriar = err
        }
        if (erroCriar || !criado?.user) {
          let deNovo
          try {
            deNovo = await achar()
          } catch (err) {
            return indisponivel('achar o usuário depois da corrida', err)
          }
          if (!deNovo) return indisponivel('criar o usuário', erroCriar ?? new Error('createUser sem user'))
          let conta
          try {
            const { data: porId, error: erroId } = await admin.auth.admin.getUserById(deNovo.id)
            if (erroId) throw erroId
            conta = porId?.user
          } catch (err) {
            return indisponivel('conferir a conta depois da corrida', err)
          }
          const criadaEm = Date.parse(conta?.created_at ?? '')
          if (!Number.isFinite(criadaEm) || Math.abs(Date.now() - criadaEm) > JANELA_CONTA_DA_CORRIDA_MS) {
            return indisponivel('criar o usuário (corrida com conta fora da janela)', erroCriar ?? new Error('createUser sem user'))
          }
          // v0.2.4: na janela, só vale a conta que o kit deste app criou (pré-sequestro nos 2 min).
          if (conta?.app_metadata?.portal_kit?.app !== appSlug) {
            return indisponivel('criar o usuário (corrida com conta sem a marca do kit)', erroCriar ?? new Error('createUser sem user'))
          }
          usuario = deNovo
        } else {
          usuario = criado.user
        }
        contaCriadaAgora = true
        // D17: dá tempo ao gatilho do banco de criar o perfil.
        if (perfil.esperarGatilhoMs > 0) await esperar(perfil.esperarGatilhoMs)
      }

      const ctx = { payload, email, nome, contaCriadaAgora, log }

      // Ler perfil (D7: erro → 503, nunca "perfil ausente").
      let estado
      try {
        estado = await perfil.ler(admin, usuario, ctx)
        if (!estado || typeof estado !== 'object') throw new Error('perfil.ler devolveu estado inválido')
      } catch (err) {
        return indisponivel('ler o perfil', err)
      }

      // Recusas ANTES de qualquer gravação (D11). Bloqueio vale para admin também.
      if (!contaCriadaAgora && !estado.existe && perfil.semPerfilEmContaExistente === 'recusar') {
        return responder(403, { error: m.perfilAusente, code: 'perfil_ausente' })
      }
      if (estado.bloqueado) return responder(403, { error: m.bloqueado, code: 'acesso_bloqueado' })

      // Gravar (D8, D9).
      let papel
      try {
        if (contaCriadaAgora || !estado.existe) {
          papel = await perfil.primeiroAcesso(admin, usuario, { ...ctx, existe: estado.existe, papelLocal: estado.papelLocal })
        } else {
          await perfil.atualizarIdentidade?.(admin, usuario, ctx)
          papel = estado.papelLocal
        }
      } catch (err) {
        return indisponivel('gravar o perfil', err)
      }

      // Destino só entre as origens do app (+DEV); extras (Portal) nunca viram destino.
      const destino = redirectSeguro(origin, doApp, origemPadrao)

      let verifyUrl
      try {
        const { data: link, error: erroLink } = await admin.auth.admin.generateLink({
          type: 'magiclink', email, options: { redirectTo: `${destino}/` },
        })
        if (erroLink) throw erroLink
        const props = link?.properties ?? {}
        if (props.hashed_token) {
          verifyUrl = `${String(supabaseUrl).replace(/\/+$/, '')}/auth/v1/verify?token=${props.hashed_token}&type=magiclink&redirect_to=${encodeURIComponent(destino)}`
        } else if (props.action_link) {
          verifyUrl = props.action_link
        } else {
          throw new Error('generateLink sem hashed_token nem action_link')
        }
      } catch (err) {
        return indisponivel('gerar o magic link', err)
      }

      const resposta = { verify_url: verifyUrl, email, papel }
      if (perfil.campoPapelResposta) resposta[perfil.campoPapelResposta] = papel
      return responder(200, resposta)
    } catch (err) {
      log.error(`[${appSlug}] erro inesperado no receptor:`, err)
      return json(500, { error: m.erroInterno }, cors)
    }
  }
}

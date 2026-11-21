// @ts-self-types="./convite.d.mts"
// @atr/portal-kit · server/convite.mjs
// Gestor de convites do lado do APP (v0.3.0; `bloqueadoNoApp` na v0.4.0): a função que a tela Usuários chama para convidar gente
// nova por link. O convite nasce e é validado no Portal (função `portal-convite`); o app guarda, na
// tabela DELE de pré-aprovação, "este e-mail entra neste app com este papel" (linha de origem
// `convite`), que o adaptador de perfil aplica no 1º acesso (`server/pre-aprovacao.mjs`).
//
// Uso (no app):
//   // supabase/functions/convites/config.mjs — JS puro, sem esm.sh, sem Deno.env, sem segredo
//   export const config = {
//     appSlug: 'mapa-bi',
//     fonte: 'lnyu',                                  // a fonte que assina (hub | lnyu | nf | rh | srkb)
//     urlPortal: 'https://<projeto do Portal>.supabase.co/functions/v1/portal-convite',
//     origensApp: ['https://mapa-bi.atrincorporadora.com.br'],
//     // Régua do app, perguntada COMO O USUÁRIO (cliente com a chave anônima e o token dele).
//     quemGere: async (comoUsuario) => {
//       const { data, error } = await comoUsuario.rpc('is_admin')
//       if (error) throw error                        // erro não é "gere" nem "não gere": vira 503
//       return data === true
//     },
//     papeis: ['user'],                               // lista FECHADA; nunca o papel de topo
//     papelDeTopo: 'admin',
//     tabela: { schema: 'public', nome: 'pre_aprovacao' },
//     validadeLocalDias: 14,
//     // v0.4.0 (opcional): quem está BLOQUEADO no app não é reconvidado. Recebe o e-mail normalizado e
//     // o cliente de SERVIÇO; só `true` recusa (409 bloqueado_no_app), `false` segue; erro tem de LANÇAR.
//     bloqueadoNoApp: async ({ email, cliente }) => {
//       const { data, error } = await cliente.from('profiles').select('bloqueado').eq('email', email).limit(1)
//       if (error) throw error
//       return data?.[0]?.bloqueado === true
//     },
//   }
//   // supabase/functions/convites/index.ts
//   Deno.serve(criarGestorDeConvites({ ...config, criarCliente: createClient }))
//
// Pedido (POST, JSON, com o `Authorization: Bearer <sessão>` de quem pede):
//   { acao: 'listar' }
//   { acao: 'criar', email, papel, nome?, extras? }
//   { acao: 'reenviar', id }        `id` = id da linha LOCAL (o que `listar` devolve)
//   { acao: 'cancelar', id }
// Resposta: 200 `{ ok: true, ... }` ou `{ ok: false, code }` com os códigos de
// CODIGOS_DO_GESTOR_DE_CONVITES. A linha devolvida traz só as colunas de COLUNAS_PUBLICAS.
//
// A ordem das conferências, que é o que este módulo garante:
//   1. sessão: `auth.getUser(jwt)` num cliente criado com a chave anônima e o Authorization do pedido;
//   2. régua: `quemGere(clienteComoUsuario, usuario)`; só `true` passa. Quem não gere recebe 403 ANTES
//      de qualquer leitura ou escrita com a service role e de qualquer chamada ao Portal;
//   3. papel só da lista fechada, nunca o de topo; nunca para o próprio e-mail; extras validados pelo app;
//   4. quem convidou (`por.label` = e-mail, `por.ref` = id) sai da SESSÃO; o corpo do pedido não manda nisso;
//   3b. (v0.4.0, com `bloqueadoNoApp`) em `criar` e `reenviar`, quem está bloqueado no app recebe 409
//      `bloqueado_no_app` ANTES de qualquer leitura da tabela de pré-aprovação, gravação ou chamada ao
//      Portal. Resposta que não é `true` nem `false`, ou erro, é 503 (nunca deixa passar). `listar` e
//      `cancelar` não consultam a opção (cancelar o convite de quem foi bloqueado é o que o app quer);
//   5. Portal primeiro, tabela local depois: a linha de convite só é gravada depois do 200 do Portal; se a
//      gravação falhar, o convite é cancelado no Portal; cancelar chama o Portal antes de marcar a linha.
//
// O gestor só lê e escreve linhas de origem `convite` do próprio slug. Linhas de `carga` e de `pedido`
// são de outros escritores e convivem com a de convite (índice único por app, e-mail e origem): este
// módulo nunca as lista, altera, apaga nem conta para o 409.
//
// Validade local (R3, R7): `vale_ate` = criação + `validadeLocalDias`; o reenvio renova para o MENOR
// entre agora + validade e o TETO (criação + 3 × validade); depois de `vale_ate` o reenvio é recusado.
// Linha pendente vencida vira `expirado` de forma preguiçosa em `criar` (o par), `listar` (o que a lista
// devolve) e `reenviar` (a linha): depois de vencer, dá para convidar de novo.
//
// Cancelar (N2): a linha local pendente é encerrada com o 200 do Portal (ele responde 200 para qualquer
// estado do convite lá) ou com o 404 cujo corpo é `{ ok: false, erro: 'nao_encontrado' }` (o handler não
// conhece o id). Qualquer outro 404 é do gateway: 502, e a linha fica como está.
//
// Log: uma linha JSON por evento, só com evento, ação, status e código. Nunca e-mail, nome, token,
// segredo, assinatura, corpo do pedido, corpo do Portal nem mensagem do banco (a do Postgres traz o
// e-mail na chave duplicada). Sem dependência: WebCrypto para o HMAC e `server/http.mjs` para o CORS.

import { cabecalhosCors, json, lerListaDeOrigens, origensPermitidas, preflight } from './http.mjs'

/** Códigos que o gestor devolve em `{ ok: false, code }`. A tela traduz com `mensagemDoErroDeConvite`. */
export const CODIGOS_DO_GESTOR_DE_CONVITES = Object.freeze([
  'metodo_nao_permitido',   // 405
  'sem_sessao',             // 401
  'nao_gere_usuarios',      // 403
  'requisicao_invalida',    // 400: corpo que não é JSON de objeto, ou grande demais
  'acao_invalida',          // 400
  'email_invalido',         // 400
  'nome_invalido',          // 400
  'papel_invalido',         // 400: fora da lista fechada, ou o papel de topo
  'convidar_a_si_mesmo',    // 400
  'extras_invalidos',       // 400
  'nao_encontrado',         // 404: id que não é de convite deste app (inclusive linha de carga ou de pedido)
  'convite_ja_enviado',     // 409: já há convite pendente e válido para o e-mail
  'convite_expirado',       // 409: reenviar depois de vale_ate ou do teto
  'convite_cancelado',      // 409: reenviar de linha cancelada
  'convite_desconhecido',   // 409: reenviar de convite que o Portal não conhece
  'ja_entrou',              // 409: reenviar ou cancelar de quem já entrou
  'bloqueado_no_app',       // 409: criar ou reenviar para quem está bloqueado no app (v0.4.0, `bloqueadoNoApp`)
  'limite',                 // 429: tetos do Portal (por app, por gestor, por convite, intervalo entre envios)
  'portal_indisponivel',    // 502: Portal fora do ar, resposta fora do contrato, ou app mal configurado no Portal
  'canal_nao_configurado',  // 503: sem o segredo da fonte no app, ou sem o canal de e-mail no Portal
  'indisponivel',           // 503: falha do banco, da régua ou de configuração
])

/** Colunas da linha local que saem da função (para a tela). `convite_id`, `criado_por` e `aplicado_para` ficam. */
export const COLUNAS_PUBLICAS_DO_CONVITE = Object.freeze(['id', 'email', 'papel', 'extras', 'estado', 'criado_em', 'vale_ate', 'convite_expira_em', 'aplicado_em'])

const COLUNAS = 'id, app, email, origem, convite_id, papel, extras, estado, vale_ate, criado_em, convite_expira_em, aplicado_em'
const ACOES = Object.freeze(['listar', 'criar', 'reenviar', 'cancelar'])
const DIA_MS = 86_400_000
/** R7: `vale_ate` nunca passa da criação + 3 × a validade local. */
const TETO_EM_VALIDADES = 3
/** O Portal trata segredo de fonte com menos de 32 caracteres como ausente; o app também. */
const TAMANHO_MINIMO_DO_SEGREDO = 32
const TAMANHO_MAXIMO_DO_PEDIDO = 16_384
const TAMANHO_MAXIMO_DOS_EXTRAS = 4_096
const TAMANHO_MAXIMO_DA_RESPOSTA_DO_PORTAL = 65_536
const TAMANHO_MAXIMO_DO_TOKEN = 8_192
/** O Portal espera o envio do e-mail por até ~20 s antes de responder. */
const ESPERA_DO_PORTAL_MS = 30_000
const LIMITE_DA_LISTA = 200
const FORMATO_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const FORMATO_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const FORMATO_ORIGEM_DEV = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/
const FORMATO_FONTE = /^[a-z0-9][a-z0-9-]{0,39}$/
const FORMATO_IDENTIFICADOR = /^[a-z_][a-z0-9_]{0,62}$/
// deno-lint-ignore no-control-regex
const CARACTERE_DE_CONTROLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
/** Códigos de erro que o Portal pode devolver: só estes entram no log (nunca o corpo). */
const ERROS_DO_PORTAL = Object.freeze(['corpo_grande', 'corpo_invalido', 'acao_invalida', 'entrada_invalida', 'nao_autorizado',
  'slug_fora_da_fonte', 'nao_encontrado', 'metodo_nao_permitido', 'app_inexistente', 'app_inativo', 'app_sem_sso', 'limite',
  'erro_interno', 'canal_nao_configurado', 'indisponivel'])

const ehObjeto = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const textoNaoVazio = (v) => typeof v === 'string' && v.trim() !== ''
const normalizarEmail = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '')
const emailValido = (email) => email.length > 0 && email.length <= 254 && FORMATO_EMAIL.test(email)
const normalizarPapel = (v) => String(v).trim().toLowerCase()
const iso = (ms) => new Date(ms).toISOString()
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')

function origemHttpsExata(origem) {
  if (typeof origem !== 'string') return false
  try { return new URL(origem).protocol === 'https:' && new URL(origem).origin === origem } catch { return false }
}

/** Do erro só sai o tipo e o código (SQLSTATE e afins), nunca a mensagem. */
function resumoDoErro(err) {
  const tipo = typeof err?.name === 'string' && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : 'desconhecido'
  const codigo = typeof err?.code === 'string' && /^[A-Za-z0-9_]{1,24}$/.test(err.code) ? err.code : null
  return codigo ? { tipo_erro: tipo, codigo_erro: codigo } : { tipo_erro: tipo }
}

/**
 * Assinatura da chamada do app ao Portal: HMAC-SHA256, em hexadecimal minúsculo, de
 * `timestamp + "." + corpo`, com o segredo da fonte. O `corpo` é a string que vai no pedido, byte a byte.
 * @param {string} corpo
 * @param {string} segredo
 * @param {string} timestamp  segundos unix, 10 dígitos
 * @returns {Promise<string>}
 */
export async function assinarPedidoDoConvite(corpo, segredo, timestamp) {
  const enc = new TextEncoder()
  const chave = await globalThis.crypto.subtle.importKey('raw', enc.encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await globalThis.crypto.subtle.sign('HMAC', chave, enc.encode(`${timestamp}.${corpo}`)))
}

/**
 * Chamada assinada do app ao Portal (`portal-convite`). Uso INTERNO do kit: o gestor de convites e
 * `revogarPermissaoNoPortal` (`server/revogacao.mjs`) passam por aqui; não é API para o app.
 * Serializa UMA vez: a string assinada (`assinarPedidoDoConvite`) é a string enviada. Pedido assinado
 * não segue redirecionamento. Nunca lança.
 * @param {{ urlPortal: string, fonte: string, fetchFn: Function, agora: () => number, esperaMs: number }} canal
 * @param {string} segredo
 * @param {object} pedido
 * @returns {Promise<{ status: number, corpo: any, erro?: unknown }>}  status 0 = sem resposta (rede, prazo, redirecionamento)
 */
export async function chamarPortalAssinado({ urlPortal, fonte, fetchFn, agora, esperaMs }, segredo, pedido) {
  const corpo = JSON.stringify(pedido)
  const timestamp = String(Math.floor(agora() / 1000))
  const controle = typeof AbortController === 'function' ? new AbortController() : null
  let relogio = null
  try {
    const assinatura = await assinarPedidoDoConvite(corpo, segredo, timestamp)
    if (controle) relogio = setTimeout(() => controle.abort(), esperaMs)
    const res = await fetchFn(urlPortal, {
      method: 'POST',
      redirect: 'error', // pedido assinado não segue redirecionamento
      signal: controle?.signal,
      headers: { 'Content-Type': 'application/json', 'x-atr-fonte': fonte, 'x-atr-timestamp': timestamp, 'x-atr-assinatura': assinatura },
      body: corpo,
    })
    let lido = null
    try {
      const texto = await res.text()
      if (texto.length <= TAMANHO_MAXIMO_DA_RESPOSTA_DO_PORTAL) lido = JSON.parse(texto)
    } catch { /* resposta que não é JSON: tratada como fora do contrato */ }
    return { status: Number(res.status) || 0, corpo: ehObjeto(lido) ? lido : null }
  } catch (err) {
    return { status: 0, corpo: null, erro: err }
  } finally {
    if (relogio !== null) clearTimeout(relogio)
  }
}

/**
 * @param {{
 *   appSlug: string,                 // slug do Portal deste app
 *   fonte: string,                   // fonte que assina (cabeçalho x-atr-fonte)
 *   urlPortal: string,               // URL https da função portal-convite; constante da config, nunca do pedido
 *   criarCliente: Function,          // createClient do supabase-js do app
 *   origensApp: string[],            // origens do app (CORS)
 *   quemGere: (clienteComoUsuario: any, usuario: any) => boolean | Promise<boolean>,  // só `true` passa
 *   papeis: string[],                // lista FECHADA de papéis convidáveis
 *   papelDeTopo: string,             // o papel que nunca pode ser convidado (não pode estar em `papeis`)
 *   validarExtras?: (extras: object, ctx: { papel: string, usuario: any, comoUsuario: any }) => unknown,
 *   tabela?: { schema?: string, nome?: string },   // padrão public.pre_aprovacao
 *   validadeLocalDias?: number,      // padrão 14 (R3)
 *   env?: { get(nome: string): string | undefined },
 *   devOrigins?: string | string[],
 *   fetchFn?: Function,
 *   log?: { log: Function, error: Function },
 *   agora?: () => number,            // relógio em ms (para teste)
 *   esperaPortalMs?: number,         // padrão 30 000
 *   bloqueadoNoApp?: (args: { email: string, cliente: any }) => boolean | Promise<boolean>,  // v0.4.0; ausente = como na v0.3.0
 * }} config
 * @returns {(req: Request) => Promise<Response>}
 */
export function criarGestorDeConvites({
  appSlug,
  fonte,
  urlPortal,
  criarCliente,
  origensApp,
  quemGere,
  papeis,
  papelDeTopo,
  validarExtras,
  tabela = {},
  validadeLocalDias = 14,
  env = globalThis.Deno?.env,
  devOrigins,
  fetchFn = (...a) => globalThis.fetch(...a),
  log = console,
  agora = () => Date.now(),
  esperaPortalMs = ESPERA_DO_PORTAL_MS,
  bloqueadoNoApp,
} = {}) {
  // Erro de configuração aparece na carga da função, não no 1º convite.
  const E = 'criarGestorDeConvites'
  if (!textoNaoVazio(appSlug)) throw new Error(`${E}: appSlug obrigatório`)
  if (typeof fonte !== 'string' || !FORMATO_FONTE.test(fonte)) throw new Error(`${E}: fonte obrigatória (a fonte que assina a chamada ao Portal, em minúsculas: hub, lnyu, nf, rh ou srkb)`)
  let urlDoPortal
  try { urlDoPortal = new URL(urlPortal) } catch { urlDoPortal = null }
  if (typeof urlPortal !== 'string' || !urlDoPortal || urlDoPortal.protocol !== 'https:' || urlDoPortal.username !== '' || urlDoPortal.password !== '') {
    throw new Error(`${E}: urlPortal obrigatória (URL https da função portal-convite do Portal; constante da config do app)`)
  }
  if (typeof criarCliente !== 'function') throw new Error(`${E}: criarCliente precisa ser função (createClient do supabase-js)`)
  if (!Array.isArray(origensApp) || origensApp.length === 0) throw new Error(`${E}: origensApp obrigatório`)
  for (const o of origensApp) {
    if (!origemHttpsExata(o)) throw new Error(`${E}: origem inválida em origensApp: ${JSON.stringify(o)} (use https://host[:porta], sem barra final nem caminho)`)
  }
  if (typeof quemGere !== 'function') throw new Error(`${E}: quemGere obrigatório (a régua do app: quem gere usuários, perguntada como o usuário)`)
  if (!Array.isArray(papeis) || papeis.length === 0 || !papeis.every(textoNaoVazio)) {
    throw new Error(`${E}: papeis obrigatório (lista fechada, não vazia, dos papéis que podem ser convidados)`)
  }
  if (new Set(papeis).size !== papeis.length) throw new Error(`${E}: papeis tem papel repetido`)
  if (!textoNaoVazio(papelDeTopo)) throw new Error(`${E}: papelDeTopo obrigatório (o papel de topo do app, que nunca pode ser convidado)`)
  if (papeis.some((p) => normalizarPapel(p) === normalizarPapel(papelDeTopo))) {
    throw new Error(`${E}: papelDeTopo (${JSON.stringify(papelDeTopo)}) não pode estar em papeis: o papel de topo nunca é convidado`)
  }
  if (validarExtras !== undefined && typeof validarExtras !== 'function') throw new Error(`${E}: validarExtras precisa ser função`)
  if (!ehObjeto(tabela)) throw new Error(`${E}: tabela precisa ser { schema, nome }`)
  const schema = tabela.schema ?? 'public'
  const nomeDaTabela = tabela.nome ?? 'pre_aprovacao'
  if (typeof schema !== 'string' || !FORMATO_IDENTIFICADOR.test(schema) || typeof nomeDaTabela !== 'string' || !FORMATO_IDENTIFICADOR.test(nomeDaTabela)) {
    throw new Error(`${E}: tabela.schema e tabela.nome precisam ser identificadores simples (minúsculas, números e _)`)
  }
  if (typeof validadeLocalDias !== 'number' || !Number.isFinite(validadeLocalDias) || validadeLocalDias < 1 || validadeLocalDias > 90) {
    throw new Error(`${E}: validadeLocalDias precisa ser número de 1 a 90 (padrão 14)`)
  }
  if (typeof fetchFn !== 'function') throw new Error(`${E}: fetchFn precisa ser função`)
  if (typeof agora !== 'function') throw new Error(`${E}: agora precisa ser função que devolve milissegundos`)
  if (typeof esperaPortalMs !== 'number' || !(esperaPortalMs > 0)) throw new Error(`${E}: esperaPortalMs precisa ser número positivo`)
  if (!log || typeof log.log !== 'function' || typeof log.error !== 'function') throw new Error(`${E}: log precisa ter log e error`)
  if (bloqueadoNoApp !== undefined && typeof bloqueadoNoApp !== 'function') {
    throw new Error(`${E}: bloqueadoNoApp precisa ser função ({ email, cliente }) => boolean (quem está bloqueado no app não é reconvidado)`)
  }

  const papeisAceitos = Object.freeze([...papeis])
  const papelProibido = normalizarPapel(papelDeTopo)
  const validadeMs = validadeLocalDias * DIA_MS
  const tetoMs = TETO_EM_VALIDADES * validadeMs
  const opcoesSemSessao = { auth: { persistSession: false, autoRefreshToken: false } }

  const registrar = (evento, extra = {}) => log.log(JSON.stringify({ fn: 'convites', app: appSlug, evento, ...extra }))
  const registrarErro = (evento, extra = {}) => log.error(JSON.stringify({ fn: 'convites', app: appSlug, evento, ...extra }))

  /** Só as colunas que a tela pode receber. */
  const linhaPublica = (linha) => Object.fromEntries(COLUNAS_PUBLICAS_DO_CONVITE.map((c) => [c, linha?.[c] ?? null]))
  /** Linha pendente cuja validade local acabou: `vale_ate` no passado ou ilegível (falha fechada). */
  const vencida = (linha, agoraMs) => linha.estado === 'pendente' && !(Date.parse(linha.vale_ate) > agoraMs)

  /** Chama o Portal (ver `chamarPortalAssinado`). Nunca lança. */
  const chamarPortal = (segredo, pedido) => chamarPortalAssinado({ urlPortal, fonte, fetchFn, agora, esperaMs: esperaPortalMs }, segredo, pedido)

  /**
   * Lê a resposta do Portal para uma ação. O resultado é fechado:
   *   ok              200 com `ok: true` e os campos do contrato da ação
   *   nao_encontrado  404 com o corpo `{ ok: false, erro: 'nao_encontrado' }` (o HANDLER não conhece o id)
   *   limite          429
   *   canal / indisponivel   503 com o corpo do handler
   *   entrada         400 `entrada_invalida` em `email` ou `nome`
   *   falha           todo o resto (rede, 5xx, 401, 403, 409 do app, 404 do gateway, 200 fora do contrato)
   */
  function lerRespostaDoPortal(r, acao, conviteId) {
    const c = r.corpo
    const erro = typeof c?.erro === 'string' && ERROS_DO_PORTAL.includes(c.erro) ? c.erro : null
    const falha = (motivo) => ({ tipo: 'falha', motivo, erro })
    if (r.status === 200) {
      if (c?.ok !== true) return falha('resposta_fora_do_contrato')
      const id = typeof c.convite_id === 'string' ? c.convite_id.toLowerCase() : null
      if (acao === 'criar') {
        if (!id || !FORMATO_UUID.test(id)) return falha('resposta_fora_do_contrato')
      } else if (id !== null && id !== conviteId) {
        return falha('resposta_de_outro_convite')
      }
      if (acao === 'cancelar') return { tipo: 'ok' }
      const expiraMs = typeof c.expira_em === 'string' ? Date.parse(c.expira_em) : NaN
      if (!Number.isFinite(expiraMs) || typeof c.email_enviado !== 'boolean') return falha('resposta_fora_do_contrato')
      return { tipo: 'ok', conviteId: id, expiraEm: iso(expiraMs), emailEnviado: c.email_enviado }
    }
    if (r.status === 404 && c?.ok === false && c.erro === 'nao_encontrado') return { tipo: 'nao_encontrado' }
    if (r.status === 429) return { tipo: 'limite' }
    if (r.status === 503 && c?.ok === false && c.erro === 'canal_nao_configurado') return { tipo: 'canal' }
    if (r.status === 503 && c?.ok === false && c.erro === 'indisponivel') return { tipo: 'indisponivel' }
    if (r.status === 400 && c?.ok === false && c.erro === 'entrada_invalida' && (c.campo === 'email' || c.campo === 'nome')) {
      return { tipo: 'entrada', campo: c.campo }
    }
    return falha(r.status === 0 ? 'sem_resposta' : 'recusa_do_portal')
  }

  return async function gestorDeConvites(req) {
    const origin = req.headers.get('origin') || ''
    let cors = {}
    let acao = null
    const responder = (status, corpo) => json(status, corpo, { ...cors, 'Cache-Control': 'no-store' })
    const recusar = (status, code, extra = {}) => {
      registrar('recusado', { acao, status, code, ...extra })
      return responder(status, { ok: false, code })
    }
    try {
      const dev = (Array.isArray(devOrigins) ? devOrigins : lerListaDeOrigens(devOrigins ?? env?.get('DEV_ORIGINS')))
        .filter((o) => FORMATO_ORIGEM_DEV.test(o))
      const permitidas = origensPermitidas({ app: [...origensApp, ...dev] })
      cors = cabecalhosCors(origin, permitidas)

      if (req.method === 'OPTIONS') return preflight(req, permitidas)
      if (req.method !== 'POST') return recusar(405, 'metodo_nao_permitido')

      // 1. Sessão de quem pede.
      const autorizacao = /^Bearer\s+(\S+)$/i.exec((req.headers.get('authorization') || '').trim())
      if (!autorizacao || autorizacao[1].length > TAMANHO_MAXIMO_DO_TOKEN) return recusar(401, 'sem_sessao')
      const jwt = autorizacao[1]

      const supabaseUrl = env?.get('SUPABASE_URL')
      const chaveAnonima = env?.get('SUPABASE_ANON_KEY')
      const chaveServico = env?.get('SUPABASE_SERVICE_ROLE_KEY')
      if (!supabaseUrl || !chaveAnonima || !chaveServico || chaveAnonima === chaveServico) {
        registrarErro('config_ausente', { motivo: 'SUPABASE_URL, SUPABASE_ANON_KEY ou SUPABASE_SERVICE_ROLE_KEY ausente (ou a anônima igual à de serviço)' })
        return responder(503, { ok: false, code: 'indisponivel' })
      }

      // Cliente COMO O USUÁRIO: chave anônima + o Authorization do pedido. É com ele que a régua é perguntada.
      const comoUsuario = criarCliente(supabaseUrl, chaveAnonima, { ...opcoesSemSessao, global: { headers: { Authorization: `Bearer ${jwt}` } } })
      let sessao
      try {
        sessao = await comoUsuario.auth.getUser(jwt)
      } catch (err) {
        registrarErro('falha', { etapa: 'conferir_sessao', ...resumoDoErro(err) })
        return responder(503, { ok: false, code: 'indisponivel' })
      }
      const usuario = sessao?.data?.user
      if (sessao?.error || !ehObjeto(usuario) || !textoNaoVazio(usuario.id)) {
        if (Number(sessao?.error?.status) >= 500) {
          registrarErro('falha', { etapa: 'conferir_sessao', ...resumoDoErro(sessao.error) })
          return responder(503, { ok: false, code: 'indisponivel' })
        }
        return recusar(401, 'sem_sessao')
      }
      // Quem convidou sai daqui, da sessão conferida, e de nenhum outro lugar.
      const emailDeQuemPede = normalizarEmail(usuario.email)
      if (usuario.is_anonymous === true || !emailValido(emailDeQuemPede) || usuario.id.length > 200) return recusar(403, 'nao_gere_usuarios')

      // 2. Régua do app, perguntada como o usuário. Só `true` passa; erro não é "gere" nem "não gere".
      let gere
      try {
        gere = await quemGere(comoUsuario, usuario)
      } catch (err) {
        registrarErro('falha', { etapa: 'regua', ...resumoDoErro(err) })
        return responder(503, { ok: false, code: 'indisponivel' })
      }
      if (gere !== true) return recusar(403, 'nao_gere_usuarios')

      // Daqui para baixo, só quem gere usuários.
      let corpo
      try {
        const texto = await req.text()
        corpo = texto.length <= TAMANHO_MAXIMO_DO_PEDIDO ? JSON.parse(texto) : null
      } catch { corpo = null }
      if (!ehObjeto(corpo)) return recusar(400, 'requisicao_invalida')
      if (typeof corpo.acao !== 'string' || !ACOES.includes(corpo.acao)) return recusar(400, 'acao_invalida')
      acao = corpo.acao

      const admin = criarCliente(supabaseUrl, chaveServico, opcoesSemSessao)
      const consulta = () => (schema === 'public' ? admin : admin.schema(schema)).from(nomeDaTabela)
      const por = { label: emailDeQuemPede, ref: usuario.id }
      const agoraMs = agora()
      const falhaLocal = (etapa, err) => {
        registrarErro('falha', { acao, etapa, ...resumoDoErro(err) })
        return responder(503, { ok: false, code: 'indisponivel' })
      }

      /**
       * v0.4.0: quem está bloqueado no app não é reconvidado. Devolve a resposta de recusa (409 ou 503)
       * ou `null` para seguir. Sem a opção, sempre `null` (comportamento da v0.3.0).
       */
      async function recusaDoBloqueio(email) {
        if (!bloqueadoNoApp) return null
        let bloqueado
        try {
          bloqueado = await bloqueadoNoApp({ email, cliente: admin })
        } catch (err) {
          return falhaLocal('bloqueado_no_app', err)
        }
        if (bloqueado === true) return recusar(409, 'bloqueado_no_app')
        if (bloqueado === false) return null
        registrarErro('falha', { acao, etapa: 'bloqueado_no_app', motivo: 'resposta_que_nao_e_booleana' })
        return responder(503, { ok: false, code: 'indisponivel' })
      }

      /** Expiração preguiçosa: marca `expirado` as linhas pendentes vencidas DADAS (sempre de convite deste app). */
      async function expirar(linhas) {
        for (const linha of linhas) {
          if (!vencida(linha, agoraMs)) continue
          const { error } = await consulta().update({ estado: 'expirado' })
            .eq('id', linha.id).eq('app', appSlug).eq('origem', 'convite').eq('estado', 'pendente')
          if (error) throw error
          linha.estado = 'expirado'
        }
      }

      /** Traduz a resposta do Portal que NÃO é sucesso para a resposta à tela. A tabela local não muda. */
      const respostaDaRecusa = (lida, r) => {
        if (lida.tipo === 'limite') return recusar(429, 'limite')
        if (lida.tipo === 'canal') return recusar(503, 'canal_nao_configurado', { origem: 'portal' })
        if (lida.tipo === 'indisponivel') return recusar(503, 'indisponivel', { origem: 'portal' })
        if (lida.tipo === 'entrada') return recusar(400, lida.campo === 'email' ? 'email_invalido' : 'nome_invalido', { origem: 'portal' })
        // Rede, 5xx, 401 (segredo errado), 403 (slug fora da fonte), 409 (app inexistente, inativo ou sem
        // SSO no Portal), 404 do gateway, resposta fora do contrato: erro do canal ou de configuração.
        registrarErro('portal_falhou', { acao, status_portal: r.status, motivo: lida.motivo, ...(lida.erro ? { erro_portal: lida.erro } : {}), ...(r.erro ? resumoDoErro(r.erro) : {}) })
        return responder(502, { ok: false, code: 'portal_indisponivel' })
      }

      // -------------------------------------------------------------------------------
      // listar
      // -------------------------------------------------------------------------------
      if (acao === 'listar') {
        let linhas
        try {
          const { data, error } = await consulta().select(COLUNAS)
            .eq('app', appSlug).eq('origem', 'convite')
            .order('criado_em', { ascending: false }).limit(LIMITE_DA_LISTA)
          if (error) throw error
          // O filtro é repetido aqui: nada que não seja convite deste app sai, nem com filtro ignorado.
          linhas = (Array.isArray(data) ? data : []).filter((l) => ehObjeto(l) && l.app === appSlug && l.origem === 'convite')
          await expirar(linhas)
        } catch (err) {
          return falhaLocal('listar', err)
        }
        registrar('listado', { acao, status: 200, linhas: linhas.length })
        return responder(200, { ok: true, convites: linhas.map(linhaPublica), agora: iso(agoraMs) })
      }

      // As outras três ações falam com o Portal: sem o segredo da fonte, nada é lido nem gravado.
      const segredo = env?.get('PORTAL_CONVITE_SEGREDO')
      if (typeof segredo !== 'string' || segredo.length < TAMANHO_MINIMO_DO_SEGREDO) {
        registrarErro('segredo_ausente', { acao })
        return responder(503, { ok: false, code: 'canal_nao_configurado' })
      }

      // -------------------------------------------------------------------------------
      // criar
      // -------------------------------------------------------------------------------
      if (acao === 'criar') {
        // 3. O que pode ser convidado.
        const email = normalizarEmail(corpo.email)
        if (!emailValido(email)) return recusar(400, 'email_invalido')
        const papel = corpo.papel
        if (typeof papel !== 'string' || !papeisAceitos.includes(papel) || normalizarPapel(papel) === papelProibido) return recusar(400, 'papel_invalido')
        if (email === emailDeQuemPede) return recusar(400, 'convidar_a_si_mesmo')
        let nome = null
        if (corpo.nome !== undefined && corpo.nome !== null) {
          if (typeof corpo.nome !== 'string' || corpo.nome.length > 200 || CARACTERE_DE_CONTROLE.test(corpo.nome)) return recusar(400, 'nome_invalido')
          nome = corpo.nome.trim() === '' ? null : corpo.nome.trim()
        }
        let extras = corpo.extras === undefined || corpo.extras === null ? {} : corpo.extras
        if (!ehObjeto(extras)) return recusar(400, 'extras_invalidos')
        if (validarExtras) {
          let veredito
          try {
            veredito = await validarExtras(extras, { papel, usuario, comoUsuario })
          } catch (err) {
            return falhaLocal('validar_extras', err)
          }
          // `true` aceita como veio; objeto = os extras NORMALIZADOS pelo app; o resto recusa.
          if (ehObjeto(veredito)) extras = veredito
          else if (veredito !== true) return recusar(400, 'extras_invalidos')
        } else if (Object.keys(extras).length > 0) {
          return recusar(400, 'extras_invalidos') // sem validador, o app não tem extras
        }
        let extrasEmTexto
        try { extrasEmTexto = JSON.stringify(extras) } catch { extrasEmTexto = null }
        if (typeof extrasEmTexto !== 'string' || extrasEmTexto.length > TAMANHO_MAXIMO_DOS_EXTRAS) return recusar(400, 'extras_invalidos')
        extras = JSON.parse(extrasEmTexto)

        // 3b. Bloqueado no app: recusa antes de ler os pendentes (a expiração preguiçosa grava), de gravar e do Portal.
        const recusaBloqueio = await recusaDoBloqueio(email)
        if (recusaBloqueio) return recusaBloqueio

        // Convites pendentes do par (SÓ origem convite: carga e pedido convivem e não entram na conta).
        try {
          const { data, error } = await consulta().select(COLUNAS)
            .eq('app', appSlug).eq('email', email).eq('origem', 'convite').eq('estado', 'pendente')
          if (error) throw error
          const pendentes = (Array.isArray(data) ? data : []).filter((l) => ehObjeto(l) && l.origem === 'convite')
          await expirar(pendentes)
          if (pendentes.some((l) => l.estado === 'pendente')) return recusar(409, 'convite_ja_enviado')
        } catch (err) {
          return falhaLocal('ler_pendentes', err)
        }

        // 5. Portal primeiro. `por` é o da sessão; o que veio no corpo do pedido não entra aqui.
        const r = await chamarPortal(segredo, { acao: 'criar', app_slug: appSlug, email, ...(nome ? { nome } : {}), por })
        const lida = lerRespostaDoPortal(r, 'criar', null)
        if (lida.tipo !== 'ok') return respostaDaRecusa(lida, r)

        // `email_enviado: false` tem dois sentidos; o app distingue pela linha local: se o id que o
        // Portal devolveu já é deste app, o convite já existia lá e não havia o que mandar.
        let repetido = false
        if (lida.emailEnviado === false) {
          try {
            const { data, error } = await consulta().select('id').eq('app', appSlug).eq('origem', 'convite').eq('convite_id', lida.conviteId).limit(1)
            if (error) throw error
            repetido = Array.isArray(data) && data.length > 0
          } catch (err) {
            registrarErro('falha', { acao, etapa: 'ler_repeticao', ...resumoDoErro(err) })
          }
        }

        // Só agora a linha local: depois do 200 do Portal.
        const linha = {
          id: globalThis.crypto.randomUUID(), app: appSlug, email, origem: 'convite', convite_id: lida.conviteId, papel, extras,
          estado: 'pendente', vale_ate: iso(agoraMs + validadeMs), criado_por: usuario.id, criado_em: iso(agoraMs), convite_expira_em: lida.expiraEm,
        }
        let erroDoInsert = null
        try {
          const { error } = await consulta().insert(linha)
          erroDoInsert = error ?? null
        } catch (err) { erroDoInsert = err }
        if (erroDoInsert) {
          // Corrida: outro pedido igual gravou a linha deste MESMO convite (o índice único recusou a
          // nossa). Cancelar no Portal mataria o link do convite que ficou: responde como repetição.
          let jaGravado = false
          try {
            const { data, error } = await consulta().select('id, convite_id')
              .eq('app', appSlug).eq('email', email).eq('origem', 'convite').eq('estado', 'pendente')
            if (!error && Array.isArray(data)) jaGravado = data.some((l) => l?.convite_id === lida.conviteId)
          } catch { /* sem leitura, vale o desfazer abaixo */ }
          if (jaGravado) return recusar(409, 'convite_ja_enviado', { motivo: 'corrida' })
          // Desfazer: sem linha local, o convite não pode ficar aberto no Portal.
          registrarErro('falha', { acao, etapa: 'gravar_linha', ...resumoDoErro(erroDoInsert) })
          const desfeito = lerRespostaDoPortal(await chamarPortal(segredo, { acao: 'cancelar', app_slug: appSlug, convite_id: lida.conviteId, por }), 'cancelar', lida.conviteId)
          if (desfeito.tipo !== 'ok' && desfeito.tipo !== 'nao_encontrado') registrarErro('compensacao_falhou', { acao, convite_id: lida.conviteId })
          return responder(503, { ok: false, code: 'indisponivel' })
        }
        registrar('criado', { acao, status: 200, email_enviado: lida.emailEnviado, repetido })
        return responder(200, { ok: true, convite: linhaPublica(linha), email_enviado: lida.emailEnviado, repetido })
      }

      // -------------------------------------------------------------------------------
      // reenviar e cancelar: a linha LOCAL, de convite, deste app. Carga, pedido e outro app = 404.
      // -------------------------------------------------------------------------------
      const idDaLinha = typeof corpo.id === 'string' ? corpo.id.trim().toLowerCase() : ''
      if (!FORMATO_UUID.test(idDaLinha)) return recusar(404, 'nao_encontrado')
      let linha
      try {
        const { data, error } = await consulta().select(COLUNAS).eq('id', idDaLinha).eq('app', appSlug).eq('origem', 'convite').limit(1)
        if (error) throw error
        linha = Array.isArray(data) ? data[0] : null
      } catch (err) {
        return falhaLocal('ler_linha', err)
      }
      if (!ehObjeto(linha) || linha.app !== appSlug || linha.origem !== 'convite') return recusar(404, 'nao_encontrado')
      const conviteId = typeof linha.convite_id === 'string' && FORMATO_UUID.test(linha.convite_id.toLowerCase()) ? linha.convite_id.toLowerCase() : null

      if (acao === 'reenviar') {
        // 3b. Bloqueado no app: recusa antes de qualquer gravação (inclusive expirar a linha) e do Portal.
        const recusaBloqueio = await recusaDoBloqueio(normalizarEmail(linha.email))
        if (recusaBloqueio) return recusaBloqueio
        if (linha.estado === 'aplicado') return recusar(409, 'ja_entrou')
        if (linha.estado === 'cancelado') return recusar(409, 'convite_cancelado')
        // Teto (R7): criação + 3 × a validade. A validade nova é o menor entre agora + validade e o teto.
        const teto = Date.parse(linha.criado_em) + tetoMs
        const novoValeAte = Math.min(agoraMs + validadeMs, teto)
        if (linha.estado === 'pendente' && (vencida(linha, agoraMs) || !(novoValeAte > agoraMs))) {
          // Vencida, ou já além do teto: expira agora e não se reenvia. O caminho é um convite novo.
          try {
            const { error } = await consulta().update({ estado: 'expirado' })
              .eq('id', linha.id).eq('app', appSlug).eq('origem', 'convite').eq('estado', 'pendente')
            if (error) throw error
          } catch (err) {
            return falhaLocal('expirar', err)
          }
          return recusar(409, 'convite_expirado')
        }
        if (linha.estado !== 'pendente') return recusar(409, 'convite_expirado')
        if (!conviteId) return recusar(409, 'convite_desconhecido')

        const r = await chamarPortal(segredo, { acao: 'reenviar', app_slug: appSlug, convite_id: conviteId, por })
        const lida = lerRespostaDoPortal(r, 'reenviar', conviteId)
        // O Portal não conhece o id: não há o que reenviar. A linha fica; o gestor cancela e convida de novo.
        if (lida.tipo === 'nao_encontrado') return recusar(409, 'convite_desconhecido')
        if (lida.tipo !== 'ok') return respostaDaRecusa(lida, r)

        const mudanca = { vale_ate: iso(novoValeAte), convite_expira_em: lida.expiraEm }
        try {
          const { error } = await consulta().update(mudanca)
            .eq('id', linha.id).eq('app', appSlug).eq('origem', 'convite').eq('estado', 'pendente')
          if (error) throw error
        } catch (err) {
          return falhaLocal('renovar', err)
        }
        registrar('reenviado', { acao, status: 200, email_enviado: lida.emailEnviado })
        return responder(200, { ok: true, convite: linhaPublica({ ...linha, ...mudanca }), email_enviado: lida.emailEnviado })
      }

      // cancelar
      if (linha.estado === 'aplicado') return recusar(409, 'ja_entrou') // cancelar não tira acesso de quem já entrou
      if (linha.estado !== 'pendente') {
        registrar('cancelado', { acao, status: 200, motivo: 'ja_encerrado' })
        return responder(200, { ok: true, convite: linhaPublica(linha) })
      }
      if (conviteId) {
        // Portal primeiro. 200 (qualquer estado do convite lá) ou o 404 do HANDLER encerram a linha local;
        // qualquer outra resposta, não: o convite seguiria pendente no Portal e a tela diria "Cancelado".
        const r = await chamarPortal(segredo, { acao: 'cancelar', app_slug: appSlug, convite_id: conviteId, por })
        const lida = lerRespostaDoPortal(r, 'cancelar', conviteId)
        if (lida.tipo !== 'ok' && lida.tipo !== 'nao_encontrado') {
          registrarErro('portal_falhou', { acao, status_portal: r.status, motivo: lida.motivo ?? lida.tipo, ...(lida.erro ? { erro_portal: lida.erro } : {}), ...(r.erro ? resumoDoErro(r.erro) : {}) })
          return responder(502, { ok: false, code: 'portal_indisponivel' })
        }
      } else {
        registrarErro('linha_sem_convite_id', { acao }) // linha que este módulo não gravou: não há o que cancelar no Portal
      }
      try {
        const { error } = await consulta().update({ estado: 'cancelado' })
          .eq('id', linha.id).eq('app', appSlug).eq('origem', 'convite').eq('estado', 'pendente')
        if (error) throw error
      } catch (err) {
        return falhaLocal('cancelar_linha', err)
      }
      registrar('cancelado', { acao, status: 200 })
      return responder(200, { ok: true, convite: linhaPublica({ ...linha, estado: 'cancelado' }) })
    } catch (err) {
      registrarErro('falha', { acao, etapa: 'inesperada', ...resumoDoErro(err) })
      return responder(503, { ok: false, code: 'indisponivel' })
    }
  }
}

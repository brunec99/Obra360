// @ts-self-types="./pedidoCanal.d.mts"
// @atr/portal-kit · core/pedidoCanal.mjs (v0.5.0)
// O canal assinado Portal → app do pedido de acesso com papel (06-78 / 06-80), num lugar só.
//
// Hoje o mesmo formato está escrito duas vezes, e as duas cópias estão no ar:
//   - quem ASSINA: ATR-APP (srkb) supabase/functions/_shared/pedidoCanal.ts (assinarParaOApp,
//     montarCabecalhos, montarCorpo*), chamado pelo portal-pedido do Portal;
//   - quem CONFERE: ATR-HUB-ENGENHARIA (lqql) supabase/functions/portal-pedido/handler.ts
//     (hmacDoPedido, iguaisTempoConstante, CHAVE_NULA, janela de 300 s).
// Este módulo é a extração das duas, SEM mudar um byte do que vai no fio:
//   assinatura = HMAC-SHA256(segredo da fonte, 'atr-pedido-v1.' + ts + '.' + corpo), sobre os BYTES do
//   corpo, em 64 hexadecimais minúsculos; ts = segundos Unix com 10 dígitos; cabeçalhos x-atr-direcao
//   ('portal-para-app'), x-atr-fonte, x-atr-timestamp e x-atr-assinatura; segredo com menos de 32
//   caracteres = ausente; janela de 300 s para os dois lados do relógio; comparação em tempo constante.
// Os vetores fixos que provam isso estão em contrato/pedidoCanal.mjs (os mesmos do 06-78 e do 06-80).
//
// Por que o prefixo 'atr-pedido-v1.' (P-2, T-06-PED-09): o segredo da fonte é o MESMO que já assina o
// portal-convite no sentido app → Portal com HMAC(ts + '.' + corpo). O prefixo separa os domínios:
// uma mensagem válida de um sentido nunca vale no outro.
//
// O que NÃO está aqui, de propósito:
//   - DESTINOS (slug → fonte, segredo, URL): é o mapa de confiança do Portal e fica no srkb. Os
//     montadores daqui só exigem um slug não vazio; quem envia confere o destino ANTES de montar.
//   - o receptor (método, teto do corpo, RPCs, tabela código → HTTP): é o kit (c), ainda não feito.
//
// Puro: nada de ambiente, nada de rede, nenhuma dependência. Só Web Crypto (globalThis.crypto.subtle),
// que existe no Deno das edge functions e no Node 20+.

/** Separação de domínio da assinatura (P-2). */
export const PREFIXO_DOMINIO = 'atr-pedido-v1.'
/** Valor fixo de `x-atr-direcao` no sentido Portal → app. */
export const DIRECAO = 'portal-para-app'
/** Tolerância do relógio, em segundos, para mais e para menos (inclusiva). */
export const JANELA_SEG = 300
/** Teto do corpo cru aceito pelo receptor (16 KiB). */
export const MAX_CORPO = 16 * 1024
/** Segredo vazio ou mais curto que isto é tratado como ausente. */
export const TAMANHO_MINIMO_SEGREDO = 32

/** Nomes dos cabeçalhos (sempre em minúsculas). */
export const CABECALHOS_DO_PEDIDO = Object.freeze({
  direcao: 'x-atr-direcao',
  fonte: 'x-atr-fonte',
  timestamp: 'x-atr-timestamp',
  assinatura: 'x-atr-assinatura',
})

/** Quem aprova pelo Portal (P-1 revista, 16/11): admin do app no Portal ou super admin do Portal. */
export const PAPEIS_DO_APROVADOR = Object.freeze(['app_admin', 'super_admin'])
/** As três ações do canal. */
export const ACOES_DO_PEDIDO = Object.freeze(['catalogo', 'aplicar', 'cancelar'])
/** As duas visões do catálogo. */
export const VISOES_DO_CATALOGO = Object.freeze(['pedido', 'aprovacao'])

const RE_TS = /^\d{10}$/
const RE_HEX_64 = /^[0-9a-f]{64}$/
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const enc = new TextEncoder()

/**
 * Chave usada quando o segredo do receptor é curto: a conta do HMAC é feita do mesmo jeito (o tempo de
 * resposta não diz se o segredo está configurado) e nunca confere. Igual à CHAVE_NULA do Hub.
 */
const CHAVE_NULA = globalThis.crypto.getRandomValues(new Uint8Array(32))

function paraBytes(corpo) {
  if (corpo instanceof Uint8Array) return corpo
  if (typeof corpo === 'string') return enc.encode(corpo)
  throw new TypeError('corpo tem de ser Uint8Array ou string')
}

/** PREFIXO_DOMINIO + ts + '.' seguido dos bytes do corpo, sem reencodar o corpo. */
function mensagemAssinada(ts, corpo) {
  const cabeca = enc.encode(`${PREFIXO_DOMINIO}${ts}.`)
  const mensagem = new Uint8Array(cabeca.byteLength + corpo.byteLength)
  mensagem.set(cabeca, 0)
  mensagem.set(corpo, cabeca.byteLength)
  return mensagem
}

async function hmac(chave, mensagem) {
  const k = await globalThis.crypto.subtle.importKey('raw', chave, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', k, mensagem))
}

const paraHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/** Só 64 hexadecimais minúsculos viram bytes; qualquer outra coisa é null. */
function hexParaBytes(valor) {
  if (typeof valor !== 'string' || !RE_HEX_64.test(valor)) return null
  const bytes = new Uint8Array(32)
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(valor.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

/** XOR acumulado: o tempo não depende de onde os valores diferem. */
function iguaisTempoConstante(a, b) {
  if (a.length !== b.length) return false
  let dif = 0
  for (let i = 0; i < a.length; i++) dif |= a[i] ^ b[i]
  return dif === 0
}

/** O ts atual (segundos Unix, 10 dígitos) a partir de milissegundos. */
export function timestampDoPedido(agoraMs = Date.now()) {
  const ts = String(Math.floor(agoraMs / 1000))
  if (!RE_TS.test(ts)) throw new Error('timestamp fora do formato')
  return ts
}

/**
 * HMAC-SHA256(segredo, PREFIXO_DOMINIO + ts + '.' + corpo) em 64 hexadecimais minúsculos.
 * O corpo pode vir em bytes (o que vai no fio) ou em texto (codificado em UTF-8). Lança com segredo
 * curto ou ts fora de 10 dígitos: nada é assinado. Igual a `assinarParaOApp` do srkb.
 */
export async function assinarPedido(segredo, ts, corpo) {
  if (typeof segredo !== 'string' || segredo.length < TAMANHO_MINIMO_SEGREDO) {
    throw new Error('segredo da fonte ausente ou curto')
  }
  if (typeof ts !== 'string' || !RE_TS.test(ts)) throw new Error('timestamp fora do formato')
  return paraHex(await hmac(enc.encode(segredo), mensagemAssinada(ts, paraBytes(corpo))))
}

/** Cabeçalhos da chamada ao app, na ordem e com os nomes de `montarCabecalhos` do srkb. */
export function montarCabecalhosDoPedido(fonte, ts, assinatura) {
  if (typeof fonte !== 'string' || fonte.trim() === '') throw new Error('fonte ausente')
  if (typeof ts !== 'string' || !RE_TS.test(ts) || typeof assinatura !== 'string' || !RE_HEX_64.test(assinatura)) {
    throw new Error('cabeçalho de assinatura fora do formato')
  }
  return {
    'content-type': 'application/json',
    [CABECALHOS_DO_PEDIDO.direcao]: DIRECAO,
    [CABECALHOS_DO_PEDIDO.fonte]: fonte,
    [CABECALHOS_DO_PEDIDO.timestamp]: ts,
    [CABECALHOS_DO_PEDIDO.assinatura]: assinatura,
  }
}

function lerCabecalho(cabecalhos, nome) {
  if (cabecalhos && typeof cabecalhos.get === 'function') return cabecalhos.get(nome)
  if (cabecalhos && typeof cabecalhos === 'object') {
    for (const [k, v] of Object.entries(cabecalhos)) if (k.toLowerCase() === nome) return typeof v === 'string' ? v : null
  }
  return null
}

/**
 * Lê e confere a FORMA dos cabeçalhos, antes de ler o corpo: direção exata, fonte da lista do receptor,
 * ts de 10 dígitos e assinatura de 64 hexadecimais minúsculos. Qualquer desvio → null (o receptor
 * responde o mesmo 401 de sempre). Aceita `Headers` ou um objeto simples.
 */
export function lerCabecalhosDoPedido(cabecalhos, fontesAceitas) {
  const direcao = lerCabecalho(cabecalhos, CABECALHOS_DO_PEDIDO.direcao)
  const fonte = lerCabecalho(cabecalhos, CABECALHOS_DO_PEDIDO.fonte)
  const ts = lerCabecalho(cabecalhos, CABECALHOS_DO_PEDIDO.timestamp) ?? ''
  const assinatura = lerCabecalho(cabecalhos, CABECALHOS_DO_PEDIDO.assinatura) ?? ''
  const lista = Array.isArray(fontesAceitas) ? fontesAceitas : []
  if (direcao !== DIRECAO || fonte === null || !lista.includes(fonte) || !RE_TS.test(ts) || hexParaBytes(assinatura) === null) {
    return null
  }
  return { fonte, ts, assinatura }
}

/**
 * Confere a assinatura e a janela, sobre os bytes CRUS recebidos. Sempre faz a conta do HMAC (com a
 * chave nula quando o segredo é curto), compara em tempo constante e só depois decide.
 * → `{ ok: true }` ou `{ ok: false, motivo }`, com motivo em `formato` | `sem_segredo` | `assinatura` |
 * `fora_da_janela`. O receptor responde o MESMO 401 para todos (o motivo é só para teste e log interno).
 *
 * @param {{ segredo: string, ts: string, assinatura: string, corpo: Uint8Array | string,
 *           agora?: () => number, janelaSeg?: number }} p   agora em milissegundos (padrão Date.now)
 */
export async function verificarAssinaturaDoPedido({ segredo, ts, assinatura, corpo, agora = () => Date.now(), janelaSeg = JANELA_SEG } = {}) {
  const recebida = hexParaBytes(assinatura)
  if (typeof ts !== 'string' || !RE_TS.test(ts) || recebida === null) return { ok: false, motivo: 'formato' }
  const configurado = typeof segredo === 'string' && segredo.length >= TAMANHO_MINIMO_SEGREDO
  const chave = configurado ? enc.encode(segredo) : CHAVE_NULA
  const esperada = await hmac(chave, mensagemAssinada(ts, paraBytes(corpo)))
  const confere = iguaisTempoConstante(recebida, esperada)
  const agoraSeg = Math.floor(agora() / 1000)
  const naJanela = Math.abs(agoraSeg - Number(ts)) <= janelaSeg
  if (!configurado) return { ok: false, motivo: 'sem_segredo' }
  if (!confere) return { ok: false, motivo: 'assinatura' }
  if (!naJanela) return { ok: false, motivo: 'fora_da_janela' }
  return { ok: true }
}

/**
 * Os dois passos juntos (cabeçalhos e assinatura), para quem já tem o corpo cru em mãos.
 * → `{ ok: true, fonte, ts }` ou `{ ok: false, motivo }` (motivo `cabecalho` ou um dos de
 * `verificarAssinaturaDoPedido`).
 */
export async function verificarPedido({ cabecalhos, corpo, segredo, fontesAceitas, agora, janelaSeg } = {}) {
  const lido = lerCabecalhosDoPedido(cabecalhos, fontesAceitas)
  if (!lido) return { ok: false, motivo: 'cabecalho' }
  const r = await verificarAssinaturaDoPedido({ segredo, ts: lido.ts, assinatura: lido.assinatura, corpo, agora, janelaSeg })
  return r.ok ? { ok: true, fonte: lido.fonte, ts: lido.ts } : r
}

/**
 * Corpo cru → JSON, como o receptor do Hub (passo 6): UTF-8 estrito, objeto, `acao` da lista.
 * → `{ ok: true, corpo }` ou `{ ok: false, erro: 'corpo_invalido' | 'acao_invalida' }`.
 * Só a forma de fora: `app_slug` e os campos de cada ação ficam com o receptor do app.
 */
export function lerCorpoDoPedido(bytes) {
  let corpo = null
  try {
    const v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(paraBytes(bytes)))
    corpo = typeof v === 'object' && v !== null && !Array.isArray(v) ? v : null
  } catch {
    corpo = null
  }
  if (!corpo) return { ok: false, erro: 'corpo_invalido' }
  if (!ACOES_DO_PEDIDO.includes(corpo.acao)) return { ok: false, erro: 'acao_invalida' }
  return { ok: true, corpo }
}

function exigirSlug(v) {
  if (typeof v !== 'string' || v.trim() === '') throw new Error('app_slug ausente')
  return v
}

function exigirUuid(v, campo) {
  if (typeof v !== 'string' || !RE_UUID.test(v)) throw new Error(`${campo} fora do formato`)
  return v.toLowerCase()
}

function exigirTexto(v, campo) {
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`${campo} ausente`)
  return v
}

/** Corpo da ação `catalogo`, em ordem fixa de chaves. */
export function montarCorpoCatalogo(appSlug, visao) {
  exigirSlug(appSlug)
  if (!VISOES_DO_CATALOGO.includes(visao)) throw new Error('visao fora da lista')
  return JSON.stringify({ acao: 'catalogo', app_slug: appSlug, visao })
}

/**
 * Corpo da ação `aplicar`, em ordem fixa de chaves. Lança se faltar qualquer campo obrigatório ou se
 * `aprovador_papel` não for um dos dois da lista: um corpo sem o papel nunca é montado.
 */
export function montarCorpoAplicar(c) {
  if (typeof c !== 'object' || c === null) throw new Error('campos ausentes')
  exigirSlug(c.app_slug)
  const papel = c.aprovador_papel
  if (!PAPEIS_DO_APROVADOR.includes(papel)) throw new Error('aprovador_papel ausente ou fora da lista')
  const escolha = c.escolha
  if (typeof escolha !== 'object' || escolha === null || Array.isArray(escolha)) throw new Error('escolha ausente')
  return JSON.stringify({
    acao: 'aplicar',
    app_slug: c.app_slug,
    pedido_id: exigirUuid(c.pedido_id, 'pedido_id'),
    nonce: exigirUuid(c.nonce, 'nonce'),
    email: exigirTexto(c.email, 'email'),
    nome: typeof c.nome === 'string' && c.nome.trim() !== '' ? c.nome : null,
    aprovador_email: exigirTexto(c.aprovador_email, 'aprovador_email'),
    aprovador_papel: papel,
    escolha,
  })
}

/** Corpo da ação `cancelar`, em ordem fixa de chaves. */
export function montarCorpoCancelar(appSlug, pedidoId, nonce) {
  exigirSlug(appSlug)
  return JSON.stringify({
    acao: 'cancelar',
    app_slug: appSlug,
    pedido_id: exigirUuid(pedidoId, 'pedido_id'),
    nonce: exigirUuid(nonce, 'nonce'),
  })
}

// @ts-self-types="./ssoV2.d.mts"
// =====================================================================================
// NÚCLEO DO @atr/portal-kit v0.2.0 — SSO_V2_VERSAO = '2.0.0' (protocolo do token v2)
// =====================================================================================
// Kit do token v2 do Portal Inteligência (D-03 da Fase 5). O Portal ASSINA com a chave
// privada ES256; cada satélite só CONFERE com a pública. Quem extrai a configuração de um
// satélite não consegue forjar entrada em nenhum outro.
//
// Esta é a cópia do @atr/portal-kit v0.2.0. Ela DIVERGE DE PROPÓSITO das 8 cópias antigas
// (SHA-256 77a9c65b…) por não ter mais o caminho do token v1 (HS256): todo HS256 é
// recusado com `sso_v1_recusado`. Nos apps, a cópia é vendorizada byte a byte e conferida
// pelo PORTAL_KIT.lock (npm run verificar). Para mudar: mude aqui, rode os testes do kit
// (node e deno), atualize o hash no CI e recopie para os apps.
//
// JavaScript ESM puro, SEM import: usa globalThis.crypto.subtle (Edge Functions, Node >= 20, navegador).
//
// Ordem das checagens (é contrato — a sonda da etapa A depende dela):
//   formato/codificação canônica → alg/versão (HS256 sai aqui como sso_v1_recusado) → kid
//   → assinatura (low-S) → v/iss/aud/scope/jti → exp/iat/TTL → bh
//
// Uso único: o receptor consome `chaveUsoUnico` (devolvida pelo verificador), NUNCA o hash da
// string bruta do token — base64url não canônico e maleabilidade ECDSA (s → n−s) gerariam
// variantes válidas com hash diferente. A chave é SHA-256 de `iss:aud:jti`.
// =====================================================================================

export const SSO_V2_VERSAO = '2.0.0'

const EMISSOR = 'portal-inteligencia'
const TTL_MAXIMO = { sso: 300, search: 60 }
const FOLGA_RELOGIO = 60
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' }
const ECDSA_SHA256 = { name: 'ECDSA', hash: 'SHA-256' }
// Ordem do grupo da P-256. Assinatura com s > n/2 (high-S) é recusada; o emissor normaliza para low-S.
const ORDEM_P256 = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551n
const METADE_ORDEM_P256 = ORDEM_P256 >> 1n
const FORMATO_JTI = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const subtle = () => {
  const s = globalThis.crypto && globalThis.crypto.subtle
  if (!s) throw new Error('ssoV2: crypto.subtle indisponível neste runtime')
  return s
}

/** Recusa de token. `codigo` vai no corpo do 401 como campo `code`. */
export class ErroTokenPortal extends Error {
  constructor(codigo, mensagem) {
    super(mensagem || codigo)
    this.name = 'ErroTokenPortal'
    this.codigo = codigo
  }
}

const recusa = (codigo, mensagem) => new ErroTokenPortal(codigo, mensagem)

// ---------------------------------------------------------------- base64url / bytes

const enc = new TextEncoder()
const dec = new TextDecoder()

function paraBase64url(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function deBase64url(texto) {
  if (typeof texto !== 'string' || !/^[A-Za-z0-9_-]*$/.test(texto)) throw new Error('base64url inválido')
  const b64 = texto.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((texto.length + 3) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function objetoDeBytes(bytes) {
  const valor = JSON.parse(dec.decode(bytes))
  if (!valor || typeof valor !== 'object' || Array.isArray(valor)) throw new Error('não é objeto')
  return valor
}

function bytesParaBigInt(bytes) {
  let n = 0n
  for (let i = 0; i < bytes.length; i++) n = (n << 8n) | BigInt(bytes[i])
  return n
}

function bigIntPara32Bytes(n) {
  const out = new Uint8Array(32)
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xFFn)
    n >>= 8n
  }
  return out
}

/** Normaliza assinatura P1363 (r||s) para low-S: se s > n/2, s = n − s. */
function paraLowS(assinatura) {
  const s = bytesParaBigInt(assinatura.subarray(32, 64))
  if (s <= METADE_ORDEM_P256) return assinatura
  const out = new Uint8Array(64)
  out.set(assinatura.subarray(0, 32), 0)
  out.set(bigIntPara32Bytes(ORDEM_P256 - s), 32)
  return out
}

function hex(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0')
  return s
}

// ---------------------------------------------------------------- hashes

/**
 * SHA-256 hex (64 chars) da string do token — mesmo formato de consumir_token_sso.
 * NÃO é a chave de uso único do v2 (use `chaveUsoUnico` / `chaveDeUsoUnico`).
 */
export async function hashDoToken(token) {
  const d = await subtle().digest('SHA-256', enc.encode(String(token)))
  return hex(new Uint8Array(d))
}

/**
 * Chave canônica de uso único do v2: SHA-256 hex de `${iss}:${aud}:${jti}`. Independe da
 * codificação e da assinatura, então variantes do mesmo token caem na mesma chave.
 */
export async function chaveDeUsoUnico(payload) {
  const d = await subtle().digest('SHA-256', enc.encode(`${payload.iss}:${payload.aud}:${payload.jti}`))
  return hex(new Uint8Array(d))
}

/** SHA-256 base64url do corpo exato da requisição — vai no claim `bh` (scope=search). */
export async function hashDoCorpo(corpo) {
  const d = await subtle().digest('SHA-256', enc.encode(String(corpo)))
  return paraBase64url(new Uint8Array(d))
}

// ---------------------------------------------------------------- configuração

/**
 * Lê PORTAL_SSO_V2_JWKS (array JSON de JWKs públicas, ou {keys:[...]}) e devolve
 * Map kid → CryptoKey de verificação. Falha FECHADA: vazio, inválido ou contendo a
 * parte privada (`d`) lança erro de configuração.
 */
export async function lerChavesPublicas(texto) {
  if (typeof texto !== 'string' || texto.trim() === '') {
    throw new Error('ssoV2 configuração: PORTAL_SSO_V2_JWKS ausente')
  }
  let lista
  try {
    lista = JSON.parse(texto)
  } catch {
    throw new Error('ssoV2 configuração: PORTAL_SSO_V2_JWKS não é JSON válido')
  }
  if (lista && !Array.isArray(lista) && Array.isArray(lista.keys)) lista = lista.keys
  if (!Array.isArray(lista) || lista.length === 0) {
    throw new Error('ssoV2 configuração: PORTAL_SSO_V2_JWKS vazio')
  }
  const chaves = new Map()
  for (const jwk of lista) {
    if (!jwk || typeof jwk !== 'object') throw new Error('ssoV2 configuração: JWK inválida')
    if ('d' in jwk) {
      throw new Error('ssoV2 configuração: JWK privada (campo d) em satélite — use só a chave pública')
    }
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) {
      throw new Error('ssoV2 configuração: JWK precisa ser EC P-256 com x e y')
    }
    if (typeof jwk.kid !== 'string' || jwk.kid === '') throw new Error('ssoV2 configuração: JWK sem kid')
    if (chaves.has(jwk.kid)) throw new Error(`ssoV2 configuração: kid repetido ${jwk.kid}`)
    const chave = await subtle().importKey(
      'jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }, ECDSA, false, ['verify'],
    )
    chaves.set(jwk.kid, chave)
  }
  return chaves
}

// ---------------------------------------------------------------- assinatura (só Portal)

/** Assina o token v2 (JWS compacto ES256). Só o Portal chama — só ele tem a privada. */
export async function assinarTokenV2(jwkPrivada, claims, { kid } = {}) {
  const kidFinal = kid || (jwkPrivada && jwkPrivada.kid)
  if (typeof kidFinal !== 'string' || kidFinal === '') throw new Error('ssoV2: kid obrigatório para assinar')
  if (!jwkPrivada || !jwkPrivada.d) throw new Error('ssoV2: JWK privada obrigatória para assinar')
  const chave = await subtle().importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: jwkPrivada.x, y: jwkPrivada.y, d: jwkPrivada.d, ext: true },
    ECDSA,
    false,
    ['sign'],
  )
  const h = paraBase64url(enc.encode(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: kidFinal })))
  const p = paraBase64url(enc.encode(JSON.stringify(claims)))
  // WebCrypto já devolve IEEE P1363 (r||s, 64 bytes) — exatamente o formato JWS. Não converter p/ DER.
  const sig = await subtle().sign(ECDSA_SHA256, chave, enc.encode(`${h}.${p}`))
  // Low-S sempre: o verificador recusa high-S (anti-maleabilidade).
  return `${h}.${p}.${paraBase64url(paraLowS(new Uint8Array(sig)))}`
}

// ---------------------------------------------------------------- verificação

function conferirPrazo(payload, agora) {
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) throw recusa('sem_prazo')
  if (agora >= payload.exp) throw recusa('expirado')
}

/**
 * Verifica um token do Portal.
 * opcoes = { chaves: Map kid→CryptoKey, audiencias: string[], escopo: 'sso'|'search',
 *            agora?: segundos, corpo?: string }
 * `opcoes.v1`, se vier, é IGNORADO desde a v0.2.0 (não lança), para o código atual dos apps
 * não quebrar quando só o núcleo for trocado. Todo HS256 é recusado com `sso_v1_recusado`.
 * Retorna { versao: 2, payload, chaveUsoUnico }. Recusa lança ErroTokenPortal com `codigo`.
 * Uso único é responsabilidade de quem chama, DEPOIS daqui: consumir_token_sso(chaveUsoUnico).
 * Nunca usar o hash da string bruta do token no v2.
 */
export async function verificarTokenPortal(token, opcoes = {}) {
  const agora = typeof opcoes.agora === 'number' ? opcoes.agora : Math.floor(Date.now() / 1000)
  const escopo = opcoes.escopo
  if (escopo !== 'sso' && escopo !== 'search') throw new Error('ssoV2: opcoes.escopo deve ser sso ou search')

  // 1. formato
  if (typeof token !== 'string') throw recusa('formato_invalido')
  const partes = token.split('.')
  if (partes.length !== 3 || partes.some((p) => p === '')) throw recusa('formato_invalido')
  let bytes
  let header
  let payload
  try {
    bytes = partes.map(deBase64url)
    header = objetoDeBytes(bytes[0])
    payload = objetoDeBytes(bytes[1])
  } catch {
    throw recusa('formato_invalido')
  }
  // Codificação canônica: recodificar tem de dar o mesmo texto (bits finais de padding zerados).
  for (let i = 0; i < 3; i++) {
    if (paraBase64url(bytes[i]) !== partes[i]) throw recusa('codificacao_invalida')
  }
  const assinatura = bytes[2]

  // 2. alg / versão — lista fechada. HS256 (token v1) sai aqui, sempre, antes de qualquer chave.
  if (header.alg === 'HS256') throw recusa('sso_v1_recusado')
  if (header.alg !== 'ES256') throw recusa('alg_invalido')

  // 3. kid
  const chaves = opcoes.chaves
  if (!(chaves instanceof Map) || chaves.size === 0) throw new Error('ssoV2: opcoes.chaves vazio')
  if (typeof header.kid !== 'string' || !chaves.has(header.kid)) throw recusa('kid_desconhecido')

  // 4. assinatura — 64 bytes r||s, low-S obrigatório (s → n−s também passaria no verify)
  if (assinatura.length !== 64) throw recusa('assinatura_invalida')
  if (bytesParaBigInt(assinatura.subarray(32, 64)) > METADE_ORDEM_P256) {
    throw recusa('assinatura_invalida', 'assinatura high-S (não canônica)')
  }
  const ok = await subtle().verify(
    ECDSA_SHA256, chaves.get(header.kid), assinatura, enc.encode(`${partes[0]}.${partes[1]}`),
  )
  if (!ok) throw recusa('assinatura_invalida')

  // 5. v / iss / aud / scope / jti
  if (payload.v !== 2) throw recusa('versao_invalida')
  if (payload.iss !== EMISSOR) throw recusa('iss_invalido')
  const audiencias = Array.isArray(opcoes.audiencias) ? opcoes.audiencias : []
  if (typeof payload.aud !== 'string' || !audiencias.includes(payload.aud)) throw recusa('aud_invalido')
  if (payload.scope !== escopo) throw recusa('escopo_invalido')
  if (typeof payload.jti !== 'string' || !FORMATO_JTI.test(payload.jti)) throw recusa('jti_invalido')

  // 6. exp / iat / TTL
  conferirPrazo(payload, agora)
  if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) throw recusa('sem_prazo')
  if (payload.iat > agora + FOLGA_RELOGIO) throw recusa('emitido_no_futuro')
  if (payload.exp - payload.iat > TTL_MAXIMO[escopo]) throw recusa('prazo_longo_demais')

  // 7. bh — token de busca amarrado ao corpo exato. Na busca é obrigatório (falha fechada).
  if (opcoes.corpo !== undefined || escopo === 'search') {
    if (opcoes.corpo === undefined) throw recusa('corpo_divergente', 'busca exige opcoes.corpo')
    const esperado = await hashDoCorpo(opcoes.corpo)
    if (payload.bh !== esperado) throw recusa('corpo_divergente')
  }

  return { versao: 2, payload, chaveUsoUnico: await chaveDeUsoUnico(payload) }
}

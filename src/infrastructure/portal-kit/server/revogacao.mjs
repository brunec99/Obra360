// @ts-self-types="./revogacao.d.mts"
// @atr/portal-kit · server/revogacao.mjs
// Canal app → Portal para TIRAR a permissão daquele app (v0.4.0, PM2 da Onda 14). Quem chama é o
// SERVIDOR do app, ao remover alguém (não a tela): primeiro o app bloqueia a pessoa no banco dele,
// depois avisa o Portal. Falha aqui NUNCA desfaz o bloqueio local: o app só registra o aviso.
//
// Uso (no servidor do app; a fonte e o segredo são os MESMOS do gestor de convites):
//   import { revogarPermissaoNoPortal } from '../_shared/portal-kit/server/revogacao.mjs'
//   import { config } from '../convites/config.mjs'           // appSlug, fonte, urlPortal
//   // porLabel = o E-MAIL de quem removeu (da sessão conferida); o Portal recusa o que não é e-mail
//   const r = await revogarPermissaoNoPortal({ ...config, email, porLabel: emailDoGestor })
//   if (!r.ok) console.warn(JSON.stringify({ evento: 'revogar_no_portal_falhou', codigo: r.codigo }))  // sem e-mail
//
// O pedido é o da ação `revogar` da função `portal-convite` do Portal (06-58):
//   POST urlPortal   x-atr-fonte, x-atr-timestamp (segundos, 10 dígitos), x-atr-assinatura
//   { acao: 'revogar', app_slug, email, por: { label } }
// assinado com HMAC-SHA256 de `timestamp + "." + corpo` (`assinarPedidoDoConvite`, a mesma conta do
// convite), pelo mesmo caminho do gestor (`chamarPortalAssinado`, em server/convite.mjs): serializa uma
// vez, não segue redirecionamento, prazo próprio. O Portal responde `200 { ok: true }` exista ou não a
// pessoa (não há enumeração): é o único sucesso.
//
// Resultado: `{ ok: true }` ou `{ ok: false, codigo }` (CODIGOS_DA_REVOGACAO). NUNCA lança, nem com
// argumento inválido, `env` que lança, relógio que lança ou log que lança.
// Log: uma linha JSON por chamada, só evento, app, status do Portal e código. Nunca o e-mail, o
// `porLabel`, o segredo, a assinatura nem o corpo. Sem dependência.

import { chamarPortalAssinado } from './convite.mjs'

/** Códigos de `{ ok: false, codigo }`. */
export const CODIGOS_DA_REVOGACAO = Object.freeze([
  'entrada_invalida',          // argumento inválido (slug, fonte, urlPortal, e-mail, porLabel, fetchFn, agora, esperaMs): sem rede
  'sem_segredo',               // PORTAL_CONVITE_SEGREDO ausente ou com menos de 32 caracteres: sem rede
  'nao_autorizado',            // 401 do Portal: segredo, fonte ou relógio errados
  'slug_fora_da_fonte',        // 403 do Portal: o slug não é desta fonte
  'recusado_pelo_portal',      // 400 do Portal: pedido fora do formato que ele aceita
  'limite',                    // 429 do Portal
  'indisponivel',              // 503 do Portal
  'tempo_esgotado',            // o Portal não respondeu dentro de `esperaMs`
  'sem_resposta',              // rede, DNS, redirecionamento recusado
  'resposta_fora_do_contrato', // 200 sem `ok: true`, ou corpo que não é JSON de objeto
  'portal_indisponivel',       // todo o resto: 404 (do gateway: a ação não existe lá), 5xx, 409…
])

/** O Portal trata segredo de fonte com menos de 32 caracteres como ausente; o app também (igual ao convite). */
const TAMANHO_MINIMO_DO_SEGREDO = 32
/** O `revogar` não envia e-mail: o Portal responde rápido. */
const ESPERA_DO_PORTAL_MS = 10_000
const FORMATO_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const FORMATO_FONTE = /^[a-z0-9][a-z0-9-]{0,39}$/
const FORMATO_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/
// deno-lint-ignore no-control-regex
const CARACTERE_DE_CONTROLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

const ehObjeto = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const normalizarEmail = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '')

function urlHttpsSemCredencial(v) {
  if (typeof v !== 'string') return false
  try {
    const u = new URL(v)
    return u.protocol === 'https:' && u.username === '' && u.password === ''
  } catch { return false }
}

/** Do erro só sai o tipo (nunca a mensagem). */
const tipoDoErro = (err) => (typeof err?.name === 'string' && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : 'desconhecido')

/**
 * Tira a permissão deste app no Portal para o e-mail. Nunca lança.
 * @param {{
 *   appSlug: string,      // slug do Portal deste app
 *   fonte: string,        // a fonte que assina (hub | lnyu | nf | rh | srkb)
 *   urlPortal: string,    // URL https da função portal-convite (constante da config do app)
 *   email: string,        // de quem sai; normalizado aqui (minúsculas, sem espaço)
 *   porLabel: string,     // o E-MAIL do gestor que removeu (o Portal exige e-mail válido); normalizado aqui
 *   env?: { get(nome: string): string | undefined },   // padrão Deno.env; lê PORTAL_CONVITE_SEGREDO
 *   fetchFn?: Function,   // padrão fetch
 *   agora?: () => number, // relógio em ms (para teste)
 *   esperaMs?: number,    // padrão 10 000
 *   log?: { log: Function, error: Function },          // padrão console
 * }} args
 * @returns {Promise<{ ok: true } | { ok: false, codigo: string }>}
 */
export async function revogarPermissaoNoPortal(args) {
  let appSlug = null
  let log = console
  const escrever = (metodo, evento, extra) => {
    try { log[metodo](JSON.stringify({ fn: 'revogar', app: appSlug, evento, ...extra })) } catch { /* log que lança não muda o resultado */ }
  }
  const registrar = (evento, extra = {}) => escrever('log', evento, extra)
  const falhou = (codigo, extra = {}) => {
    escrever('error', 'revogar_falhou', { codigo, ...extra })
    return { ok: false, codigo }
  }
  const sucesso = () => {
    registrar('revogado', { status_portal: 200 })
    return { ok: true }
  }

  try {
    if (ehObjeto(args?.log) && typeof args.log.log === 'function' && typeof args.log.error === 'function') log = args.log
    if (!ehObjeto(args)) return falhou('entrada_invalida', { campo: 'args' })
    const { fonte, urlPortal, porLabel } = args
    const fetchFn = args.fetchFn ?? ((...a) => globalThis.fetch(...a))
    const agora = args.agora ?? (() => Date.now())
    const esperaMs = args.esperaMs ?? ESPERA_DO_PORTAL_MS
    const env = 'env' in args ? args.env : globalThis.Deno?.env

    if (typeof args.appSlug !== 'string' || !FORMATO_SLUG.test(args.appSlug)) return falhou('entrada_invalida', { campo: 'appSlug' })
    appSlug = args.appSlug
    if (typeof fonte !== 'string' || !FORMATO_FONTE.test(fonte)) return falhou('entrada_invalida', { campo: 'fonte' })
    if (!urlHttpsSemCredencial(urlPortal)) return falhou('entrada_invalida', { campo: 'urlPortal' })
    const email = normalizarEmail(args.email)
    if (email.length === 0 || email.length > 254 || !FORMATO_EMAIL.test(email)) return falhou('entrada_invalida', { campo: 'email' })
    // O Portal (`portal-convite`) só aceita e-mail válido em `por.label`: o que não é e-mail para aqui, sem rede.
    const rotulo = normalizarEmail(porLabel)
    if (typeof porLabel !== 'string' || CARACTERE_DE_CONTROLE.test(porLabel) || rotulo.length === 0 || rotulo.length > 254 || !FORMATO_EMAIL.test(rotulo)) {
      return falhou('entrada_invalida', { campo: 'porLabel' })
    }
    if (typeof fetchFn !== 'function') return falhou('entrada_invalida', { campo: 'fetchFn' })
    if (typeof agora !== 'function') return falhou('entrada_invalida', { campo: 'agora' })
    if (typeof esperaMs !== 'number' || !Number.isFinite(esperaMs) || !(esperaMs > 0)) return falhou('entrada_invalida', { campo: 'esperaMs' })

    // O segredo é o MESMO do convite (a fonte já o tem). Sem ele, nenhum pedido sai.
    let segredo = typeof env?.get === 'function' ? env.get('PORTAL_CONVITE_SEGREDO') : undefined
    if (typeof segredo !== 'string' || segredo.length < TAMANHO_MINIMO_DO_SEGREDO) {
      return falhou('sem_segredo')
    }

    const pedido = { acao: 'revogar', app_slug: appSlug, email, por: { label: rotulo } }
    const r = await chamarPortalAssinado({ urlPortal, fonte, fetchFn, agora, esperaMs }, segredo, pedido)
    segredo = null

    if (r.status === 0) {
      const abortado = ['AbortError', 'TimeoutError'].includes(tipoDoErro(r.erro))
      return falhou(abortado ? 'tempo_esgotado' : 'sem_resposta', { tipo_erro: tipoDoErro(r.erro) })
    }
    if (r.status === 200) {
      if (r.corpo?.ok === true) return sucesso()
      return falhou('resposta_fora_do_contrato', { status_portal: 200 })
    }
    const status = { status_portal: r.status }
    if (r.status === 401) return falhou('nao_autorizado', status)
    if (r.status === 403) return falhou('slug_fora_da_fonte', status)
    if (r.status === 400) return falhou('recusado_pelo_portal', status)
    if (r.status === 429) return falhou('limite', status)
    if (r.status === 503) return falhou('indisponivel', status)
    // 404 (o gateway não achou a função, ou a ação ainda não está publicada), 5xx, 409…: nunca é sucesso.
    return falhou('portal_indisponivel', status)
  } catch (err) {
    return falhou('portal_indisponivel', { etapa: 'inesperada', tipo_erro: tipoDoErro(err) })
  }
}

// @ts-self-types="./http.d.mts"
// @atr/portal-kit · server/http.mjs
// CORS por lista fechada, redirect só para origens do próprio app e respostas JSON.
//
// Regras (endurecimento de 06/11/2026):
// - localhost NUNCA fica fixo na lista de produção: entra só por variável de ambiente
//   (DEV_ORIGINS, separada por vírgula), lida pelo app e passada aqui.
// - O destino do magic link nunca vem direto do header Origin: só uma origem da lista do app,
//   senão a origem padrão.
// - Mensagem de erro para o navegador é texto fixo do app; o erro cru vai só para o log.

export const CABECALHOS_PADRAO = 'authorization, x-client-info, apikey, content-type'

/** "a, b ,c" → ['a','b','c'] (vazio e espaços fora). */
export function lerListaDeOrigens(texto) {
  return String(texto ?? '').split(',').map((o) => o.trim()).filter(Boolean)
}

/**
 * Origens que podem chamar a função.
 * @param {{ app: string[], extras?: string[], dev?: string[] }} p
 *   app: origens do próprio app (também são os destinos válidos de redirect);
 *   extras: quem mais pode chamar (ex.: o Portal); dev: vindas de DEV_ORIGINS.
 */
export function origensPermitidas({ app, extras = [], dev = [] }) {
  return [...new Set([...app, ...dev, ...extras])].filter((o) => /^https?:\/\/[^/\s]+$/.test(o))
}

/** Cabeçalhos CORS para a origem do pedido, ou {} se ela não estiver na lista. */
export function cabecalhosCors(origem, permitidas, { metodos = 'POST, OPTIONS', cabecalhos = CABECALHOS_PADRAO } = {}) {
  if (!origem || !permitidas.includes(origem)) return {}
  return {
    'Access-Control-Allow-Origin': origem,
    'Access-Control-Allow-Headers': cabecalhos,
    'Access-Control-Allow-Methods': metodos,
    'Vary': 'Origin',
  }
}

/** Destino seguro do redirect: a origem do pedido só se for do app; senão a padrão. */
export function redirectSeguro(origem, origensDoApp, padrao) {
  if (!origensDoApp.includes(padrao)) throw new Error('redirectSeguro: a origem padrão precisa estar na lista do app')
  return origem && origensDoApp.includes(origem) ? origem : padrao
}

/** Resposta JSON com os cabeçalhos dados (CORS incluso, se houver). */
export function json(status, corpo, cabecalhos = {}) {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { ...cabecalhos, 'Content-Type': 'application/json' },
  })
}

/** Resposta do preflight (OPTIONS). Origem fora da lista recebe 204 sem CORS: o navegador barra. */
export function preflight(req, permitidas, opcoes) {
  return new Response(null, { status: 204, headers: cabecalhosCors(req.headers.get('origin'), permitidas, opcoes) })
}

// Tipos de core/pedidoCanal.mjs (@atr/portal-kit), escritos à mão, sem dependência.
// É o contrato tipado do payload do canal Portal → app do pedido com papel.

export const PREFIXO_DOMINIO: 'atr-pedido-v1.'
export const DIRECAO: 'portal-para-app'
export const JANELA_SEG: 300
export const MAX_CORPO: 16384
export const TAMANHO_MINIMO_SEGREDO: 32

export const CABECALHOS_DO_PEDIDO: Readonly<{
  direcao: 'x-atr-direcao'
  fonte: 'x-atr-fonte'
  timestamp: 'x-atr-timestamp'
  assinatura: 'x-atr-assinatura'
}>

export const PAPEIS_DO_APROVADOR: readonly ['app_admin', 'super_admin']
export type PapelDoAprovador = 'app_admin' | 'super_admin'

export const ACOES_DO_PEDIDO: readonly ['catalogo', 'aplicar', 'cancelar']
export type AcaoDoPedido = 'catalogo' | 'aplicar' | 'cancelar'

export const VISOES_DO_CATALOGO: readonly ['pedido', 'aprovacao']
export type VisaoDoCatalogo = 'pedido' | 'aprovacao'

// ---------------------------------------------------------------------------------------
// O payload (o JSON assinado), na ordem de chaves em que os montadores escrevem
// ---------------------------------------------------------------------------------------

/** A escolha de quem aprovou. `extras` é do app (no FVS: `{ obras: [{ obra_id, cargo, atividades? }] }`). */
export interface EscolhaDoPedido {
  papel: string
  extras?: Record<string, unknown>
  [outra: string]: unknown
}

export interface CorpoCatalogo {
  acao: 'catalogo'
  app_slug: string
  visao: VisaoDoCatalogo
}

export interface CorpoAplicar {
  acao: 'aplicar'
  app_slug: string
  /** uuid em minúsculas */
  pedido_id: string
  /** uuid em minúsculas */
  nonce: string
  email: string
  nome: string | null
  aprovador_email: string
  aprovador_papel: PapelDoAprovador
  escolha: EscolhaDoPedido
}

export interface CorpoCancelar {
  acao: 'cancelar'
  app_slug: string
  pedido_id: string
  nonce: string
}

export type CorpoDoPedido = CorpoCatalogo | CorpoAplicar | CorpoCancelar

/** Entrada de `montarCorpoAplicar` (o `acao` é posto pelo montador). */
export interface CamposAplicar {
  app_slug: string
  pedido_id: string
  nonce: string
  email: string
  nome: string | null
  aprovador_email: string
  aprovador_papel: PapelDoAprovador
  escolha: EscolhaDoPedido | Record<string, unknown>
}

export interface CabecalhosDoPedido {
  'content-type': 'application/json'
  'x-atr-direcao': 'portal-para-app'
  'x-atr-fonte': string
  'x-atr-timestamp': string
  'x-atr-assinatura': string
}

// ---------------------------------------------------------------------------------------
// Assinar (quem envia: o portal-pedido do srkb)
// ---------------------------------------------------------------------------------------

export function timestampDoPedido(agoraMs?: number): string
export function assinarPedido(segredo: string, ts: string, corpo: Uint8Array | string): Promise<string>
export function montarCabecalhosDoPedido(fonte: string, ts: string, assinatura: string): CabecalhosDoPedido
export function montarCorpoCatalogo(appSlug: string, visao: VisaoDoCatalogo): string
export function montarCorpoAplicar(campos: CamposAplicar): string
export function montarCorpoCancelar(appSlug: string, pedidoId: string, nonce: string): string

// ---------------------------------------------------------------------------------------
// Conferir (quem recebe: o portal-pedido de cada app)
// ---------------------------------------------------------------------------------------

export interface LeitorDeCabecalhos {
  get(nome: string): string | null
}

export interface CabecalhosLidos {
  fonte: string
  ts: string
  assinatura: string
}

export function lerCabecalhosDoPedido(
  cabecalhos: LeitorDeCabecalhos | Record<string, string | undefined>,
  fontesAceitas: readonly string[],
): CabecalhosLidos | null

export type MotivoDaRecusaDaAssinatura = 'formato' | 'sem_segredo' | 'assinatura' | 'fora_da_janela'

export type ResultadoDaAssinatura = { ok: true } | { ok: false; motivo: MotivoDaRecusaDaAssinatura }

export interface EntradaDaVerificacao {
  segredo: string
  ts: string
  assinatura: string
  corpo: Uint8Array | string
  /** milissegundos (padrão `Date.now`) */
  agora?: () => number
  janelaSeg?: number
}

export function verificarAssinaturaDoPedido(entrada: EntradaDaVerificacao): Promise<ResultadoDaAssinatura>

export type ResultadoDoPedidoVerificado =
  | { ok: true; fonte: string; ts: string }
  | { ok: false; motivo: 'cabecalho' | MotivoDaRecusaDaAssinatura }

export function verificarPedido(entrada: {
  cabecalhos: LeitorDeCabecalhos | Record<string, string | undefined>
  corpo: Uint8Array | string
  segredo: string
  fontesAceitas: readonly string[]
  agora?: () => number
  janelaSeg?: number
}): Promise<ResultadoDoPedidoVerificado>

export type ResultadoDoCorpo =
  | { ok: true; corpo: Record<string, unknown> & { acao: AcaoDoPedido } }
  | { ok: false; erro: 'corpo_invalido' | 'acao_invalida' }

export function lerCorpoDoPedido(bytes: Uint8Array | string): ResultadoDoCorpo

// Tipos de server/http.mjs (@atr/portal-kit), escritos à mão, sem dependência.

/** 'authorization, x-client-info, apikey, content-type' */
export const CABECALHOS_PADRAO: string

/** "a, b ,c" → ['a','b','c'] (vazio e espaços fora). */
export function lerListaDeOrigens(texto: string | null | undefined): string[]

/** Origens que podem chamar a função (sem repetição; só `http(s)://host[:porta]`). */
export function origensPermitidas(p: { app: string[]; extras?: string[]; dev?: string[] }): string[]

export interface OpcoesCors {
  /** Padrão 'POST, OPTIONS'. */
  metodos?: string
  /** Padrão CABECALHOS_PADRAO. */
  cabecalhos?: string
}

/** Cabeçalhos CORS para a origem do pedido, ou {} se ela não estiver na lista. */
export function cabecalhosCors(
  origem: string | null | undefined,
  permitidas: string[],
  opcoes?: OpcoesCors,
): Record<string, string>

/** A origem do pedido só se for do app; senão a padrão. Lança se a padrão não estiver na lista. */
export function redirectSeguro(origem: string | null | undefined, origensDoApp: string[], padrao: string): string

/** Resposta JSON com os cabeçalhos dados. */
export function json(status: number, corpo: unknown, cabecalhos?: Record<string, string>): Response

/** Preflight (OPTIONS): 204, com CORS só para origem da lista. */
export function preflight(req: Request, permitidas: string[], opcoes?: OpcoesCors): Response

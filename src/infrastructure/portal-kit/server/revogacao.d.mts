// Tipos de server/revogacao.mjs (@atr/portal-kit), escritos à mão, sem dependência.

/** Códigos de `{ ok: false, codigo }`. */
export type CodigoDaRevogacao =
  | 'entrada_invalida'
  | 'sem_segredo'
  | 'nao_autorizado'
  | 'slug_fora_da_fonte'
  | 'recusado_pelo_portal'
  | 'limite'
  | 'indisponivel'
  | 'tempo_esgotado'
  | 'sem_resposta'
  | 'resposta_fora_do_contrato'
  | 'portal_indisponivel'

export const CODIGOS_DA_REVOGACAO: readonly CodigoDaRevogacao[]

export interface PedidoDeRevogacao {
  /** Slug do Portal deste app. */
  appSlug: string
  /** Fonte que assina (cabeçalho `x-atr-fonte`): 'hub' | 'lnyu' | 'nf' | 'rh' | 'srkb'. A mesma do gestor de convites. */
  fonte: string
  /** URL https da função `portal-convite` do Portal. Constante da config do app. */
  urlPortal: string
  /** De quem sai. Normalizado (minúsculas, sem espaço). Nunca vai para o log. */
  email: string
  /** O E-MAIL do gestor que removeu (o Portal exige e-mail válido em `por.label`). Normalizado; até 254 caracteres. Nunca vai para o log. */
  porLabel: string
  /** Padrão `Deno.env`. Lê PORTAL_CONVITE_SEGREDO (o mesmo segredo do convite). */
  env?: { get(nome: string): string | undefined } | null
  /** Padrão `fetch`. */
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>
  /** Relógio em milissegundos (para teste). Padrão `Date.now`. */
  agora?: () => number
  /** Quanto esperar pelo Portal, em ms. Padrão 10 000. */
  esperaMs?: number
  /** Padrão `console`. Só evento, app, status e código. */
  log?: Pick<Console, 'log' | 'error'>
}

export type ResultadoDaRevogacao = { ok: true } | { ok: false; codigo: CodigoDaRevogacao }

/**
 * Tira a permissão deste app no Portal (ação `revogar` da `portal-convite`). NUNCA lança.
 * Chame DEPOIS do bloqueio local; falha aqui não desfaz o bloqueio (registre o aviso, sem e-mail).
 */
export function revogarPermissaoNoPortal(pedido: PedidoDeRevogacao): Promise<ResultadoDaRevogacao>

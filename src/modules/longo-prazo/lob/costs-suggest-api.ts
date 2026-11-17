import type { LobId } from '@/domain/lob';
import { LobApiError } from './lob-api';
import type { CostSuggestion, SuggestionCandidate } from './costs-model';

/** Cliente da sugestão da Claudia na visão Custos (16/11/2026): POST /api/lob/costs/suggest com um lote
 * de itens não apropriados (id, código e descrição; o valor em reais não sai do navegador). O servidor
 * devolve o pacote sugerido de cada item e não grava nada. */

export interface CostSuggestResponse {
  suggestions: CostSuggestion[];
  costUsd: number;
  model: string;
}

export async function requestCostSuggestions(workId: LobId, items: readonly SuggestionCandidate[]): Promise<CostSuggestResponse> {
  const res = await fetch('/api/lob/costs/suggest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Só os três campos, um a um: nada do rascunho (valor, autor) vai junto por descuido.
    body: JSON.stringify({ workId, items: items.map(({ id, code, description }) => ({ id, code, description })) }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new LobApiError((body as { error?: string }).error ?? 'Falha na comunicação com o servidor.', res.status);
  const suggestions = (body as { suggestions?: unknown }).suggestions;
  if (!Array.isArray(suggestions)) throw new LobApiError('Resposta inválida do servidor.', 502);
  return body as CostSuggestResponse;
}

import { NextResponse } from 'next/server';
import { requireModuleAccess } from '@/infrastructure/auth/supabase-server';
import { loadLobWithCosts, LobCostsUnavailableError, LobUnavailableError } from '@/infrastructure/repositories/supabase/lob-repository';
import { todayInSaoPaulo } from '@/infrastructure/clock';
import { logRouteError } from '@/infrastructure/log';
import { agentConfigFromEnv, budgetDecision, monthKey, type BudgetReason } from '@/domain/agent-cost';
import { LOB_LIMITS } from '@/domain/lob';
import { budgetState, loadLedger } from '@/infrastructure/agent/budget';
import { recordUsage } from '@/infrastructure/agent/ledger';
import {
  COST_LINK_BATCH,
  estimateCostLinksUsd,
  isAgentModelError,
  spentOf,
  suggestCostLinks,
  type CostLinkItem,
  type CostLinksResult,
} from '@/infrastructure/agent/chat';

export const runtime = 'nodejs';
// Um lote de 300 itens pode passar de um minuto no modelo.
export const maxDuration = 300;

/** Sugestão da Claudia na visão Custos (16/11/2026): recebe um lote de itens NÃO apropriados do rascunho
 * (id, código e descrição; o valor em reais não vem e, se vier, é ignorado) e devolve o pacote de serviço
 * sugerido para cada um. Não grava custo nenhum: a tela aplica no rascunho e o "Salvar" de sempre grava
 * com `save_costs`. O teto de gasto é o da Claudia (mês, obra e pessoa), conferido antes da chamada, e o
 * uso entra no livro-razão como `pergunta`. */

const headers = { 'Cache-Control': 'no-store' };
const fail = (error: string, status: number, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error, ...extra }, { status, headers });
const NOT_CONFIGURED = 'Agente de IA não configurado: defina ANTHROPIC_API_KEY (ou API_ANTHROPIC) no servidor.';
const MIGRATION_MESSAGE = 'Aplique a migração 0035_agent.sql no Supabase para usar o agente de IA.';
const MAX_ID = 80;

/** Lê os itens do corpo: lista de 1 a `COST_LINK_BATCH`, cada um com id e descrição; ids sem repetição. */
function parseItems(value: unknown): CostLinkItem[] | string {
  if (!Array.isArray(value) || !value.length) return 'Envie os itens não apropriados.';
  if (value.length > COST_LINK_BATCH) return `Cada chamada aceita até ${COST_LINK_BATCH} itens.`;
  const seen = new Set<string>();
  const items: CostLinkItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return 'Item inválido.';
    const { id, code, description } = raw as Record<string, unknown>;
    if (typeof id !== 'string' || !id || id.length > MAX_ID) return 'Item sem identificador.';
    if (seen.has(id)) return 'Há itens repetidos na lista.';
    seen.add(id);
    const text = typeof description === 'string' ? description.replace(/\s+/g, ' ').trim().slice(0, LOB_LIMITS.costDescription) : '';
    if (!text) return 'Há item sem descrição na lista.';
    const shortCode = typeof code === 'string' ? code.replace(/\s+/g, ' ').trim().slice(0, LOB_LIMITS.costCode) : '';
    items.push({ id, description: text, ...(shortCode ? { code: shortCode } : {}) });
  }
  return items;
}

export async function POST(request: Request) {
  const gate = await requireModuleAccess('longo-prazo');
  if (gate.error) return gate.error;
  const { profile } = gate.access;
  if (!profile) return fail('Perfil não provisionado. Contate o gestor.', 403);
  if (profile.role === 'viewer') return fail('Seu perfil permite apenas consulta.', 403);

  const body = (await request.json().catch(() => null)) as { workId?: unknown; items?: unknown } | null;
  if (!body || typeof body !== 'object') return fail('Corpo da requisição inválido.', 400);
  const workId = typeof body.workId === 'string' ? body.workId : '';
  if (!workId) return fail('Obra não informada.', 400);
  const items = parseItems(body.items);
  if (typeof items === 'string') return fail(items, 400);
  if (!profile.workIds.includes(workId)) return fail('Você não tem acesso a esta obra.', 403);

  const config = agentConfigFromEnv(process.env);
  if (!config.apiKey) return fail(NOT_CONFIGURED, 503);
  const log = (cause: unknown, extra: Record<string, unknown> = {}) =>
    logRouteError('POST /api/lob/costs/suggest', cause, { actorId: profile.id, workId, items: items.length, ...extra });

  let services;
  try {
    const { data, costsAvailable } = await loadLobWithCosts(workId);
    if (!costsAvailable) return fail(new LobCostsUnavailableError().message, 503);
    services = [...data.services]
      .sort((a, b) => a.orderIndex - b.orderIndex || a.name.localeCompare(b.name, 'pt-BR'))
      .map(s => ({ id: s.id, name: s.name, unit: s.unit, team: s.team }));
  } catch (cause) {
    if (cause instanceof LobUnavailableError || cause instanceof LobCostsUnavailableError) return fail(cause.message, 503);
    log(cause, { step: 'lob' });
    return fail('Não foi possível carregar os pacotes de serviço da obra. Tente de novo em instantes.', 502);
  }
  if (!services.length) return fail('Esta obra ainda não tem pacotes de serviço para receber os itens.', 422);

  const month = monthKey(todayInSaoPaulo());
  const ledger = await loadLedger(workId, profile.id, month);
  if (typeof ledger === 'string') {
    log(ledger, { step: 'ledger' });
    return fail('Não foi possível ler o uso do agente de IA. Tente de novo em instantes.', 502);
  }
  if (ledger.missing) return fail(MIGRATION_MESSAGE, 503);
  const state = budgetState(ledger, workId, profile.id, config.budgetUsd);
  const decision = budgetDecision(state, estimateCostLinksUsd(items.length, services.length, config.model));
  if (!decision.allowed) return fail(decision.message, 429, { reason: decision.reason satisfies BudgetReason });

  // A chamada paga entra no livro-razão mesmo quando a resposta não serve (recusa, corte, formato).
  const record = async (result: CostLinksResult) => {
    if (!result.calls) return;
    const recorded = await recordUsage({
      workId,
      actorId: profile.id,
      month,
      kind: 'pergunta',
      model: result.model,
      calls: result.calls,
      usage: result.usage,
      costUsd: result.costUsd,
    });
    if (!recorded.ok) log(recorded.error, { step: 'recordUsage' });
  };
  try {
    const result = await suggestCostLinks({ config: { apiKey: config.apiKey, model: config.model }, services, items });
    await record(result);
    return NextResponse.json({ suggestions: result.suggestions, costUsd: result.costUsd, model: result.model }, { headers });
  } catch (cause) {
    log(cause, { step: 'model' });
    const spent = spentOf(cause);
    if (spent) await record(spent);
    if (isAgentModelError(cause)) return fail(cause.message, cause.status);
    return fail('Falha na sugestão. Tente de novo em instantes.', 502);
  }
}

import type { BudgetState } from '../../domain/agent-cost';
import {
  countActiveWorks,
  monthUsage,
  readInsight,
  userSettings,
  type MonthUsage,
  type StoredInsight,
  type UserAgentSettings,
} from './ledger';

/** Livro-razão e orçamento da Claudia numa obra (extraído de /api/agente em 16/11/2026, para a sugestão
 * de vínculos da visão Custos usar o mesmo teto): o que a rota lê antes de chamar o modelo e o estado que
 * o `budgetDecision` confere. A Claudia geral (/api/agente/geral) tem a versão dela, sem obra. */

export type Ledger =
  | { missing: true }
  | { missing: false; usage: MonthUsage; activeWorks: number; settings: UserAgentSettings | null; insight: StoredInsight | null };
export type LoadedLedger = Extract<Ledger, { missing: false }>;

/** Uso do mês, obras ativas, limites da pessoa e a leitura guardada da obra. `{ missing: true }` sem a
 * migração 0035; texto = erro de leitura (a rota registra e responde 502). */
export async function loadLedger(workId: string, actorId: string, month: string): Promise<Ledger | string> {
  const [usage, works, settings, insight] = await Promise.all([
    monthUsage(month),
    countActiveWorks(),
    userSettings(actorId),
    readInsight(workId),
  ]);
  if (!usage.ok) return usage.missing ? { missing: true } : usage.error;
  if (!settings.ok) return settings.missing ? { missing: true } : settings.error;
  if (!insight.ok) return insight.missing ? { missing: true } : insight.error;
  if (!works.ok) return works.error;
  return { missing: false, usage: usage.value, activeWorks: works.value, settings: settings.value, insight: insight.value };
}

export function budgetState(ledger: LoadedLedger, workId: string, actorId: string, budgetUsd: number): BudgetState {
  return {
    budgetUsd,
    monthUsd: ledger.usage.totalUsd,
    workUsd: ledger.usage.byWork.get(workId)?.usd ?? 0,
    activeWorks: ledger.activeWorks,
    userUsd: ledger.usage.byUser.get(actorId)?.usd ?? 0,
    userLimitUsd: ledger.settings?.monthlyLimitUsd ?? null,
    userBlocked: ledger.settings?.blocked ?? false,
  };
}

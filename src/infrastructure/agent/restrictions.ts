import { pendingSourceOptions } from '../../application/use-cases/pending-commands';
import type { RestrictionLoad, RestrictionLoader } from '../../application/use-cases/agent-restriction-tools';
import { hasSectionAccess, type ModuleAccess } from '../../application/module-access';
import type { PendingSourceOptions } from '../../domain/pending-board';
import { listPeople, loadPendingCards, loadSourceOptions, PendingUnavailableError } from '../repositories/supabase/pending-repository';
import { logRouteError } from '../log';

/** Quadro de Restrições para a Claudia (24/11/2026): os cards, as pessoas da obra e as tarefas e serviços a
 * que um card pode ser ligado — as mesmas leituras da tela do quadro (`GET /api/pendencias` e
 * `/api/pendencias/origens`), sem checklists nem conversa. Lê só quando uma ferramenta de restrição é
 * chamada, uma vez por pergunta. Mesma porta do quadro: módulo `restricoes` liberado para a pessoa (a obra
 * a rota já conferiu). Se a leitura das tarefas e dos serviços falhar, o quadro segue sem ligação
 * (restrição avulsa), como o formulário da tela. */
export function createRestrictionLoader(workId: string, access: ModuleAccess): RestrictionLoader {
  let pending: Promise<RestrictionLoad> | undefined;
  const load = async (): Promise<RestrictionLoad> => {
    if (!hasSectionAccess('restricoes', access)) return { ok: false, reason: 'sem_acesso' };
    try {
      const sources = loadSourceOptions(workId)
        .then(pendingSourceOptions)
        .catch((error): PendingSourceOptions => {
          logRouteError('agente restrições (origens)', error, { workId });
          return { tasks: [], services: [] };
        });
      const [cards, people, options] = await Promise.all([loadPendingCards(workId), listPeople(workId), sources]);
      return { ok: true, value: { cards, people, tasks: options.tasks, services: options.services } };
    } catch (error) {
      if (error instanceof PendingUnavailableError) return { ok: false, reason: 'indisponivel' };
      throw error;
    }
  };
  return () => {
    if (!pending) {
      pending = load();
      // Erro não fica guardado: a próxima chamada tenta de novo.
      pending.catch(() => (pending = undefined));
    }
    return pending;
  };
}

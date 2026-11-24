'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { LocalDate } from '@/domain/long-term-plan';
import { isClosed, PENDING_STATUS_LABELS, startBy, type PendingCard, type PendingPerson } from '@/domain/pending-board';
import { fetchPending, PENDING_CHANGED_EVENT } from '@/modules/pendencias/api';
import { pendingPath, SignalChip } from '@/modules/pendencias/parts';
import { formatDate } from '@/shared/format';

/** Restrições do serviço no painel do bloco da Linha de Balanço (24/11/2026, pedido do usuário: "ao clicar
 * na tarefa do longo prazo, deve aparecer quais são as restrições"). São os cards do Quadro de Restrições
 * (aba 1.4) ligados ao serviço do bloco (`origin: 'longo_prazo'`, `sourceId` = serviço): os mesmos que o
 * botão "Criar pendência do serviço" e a Claudia criam. Só leitura; cada card abre no quadro. */

export type ServiceRestrictionsState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'unavailable' }
  | { status: 'ready'; cards: PendingCard[]; people: PendingPerson[] };

/** Cards do quadro ligados a serviços da Linha de Balanço. Lê uma vez ao abrir a visão, de novo quando a
 * janela volta ao foco e quando um card é criado (pelo painel ou por uma proposta da Claudia). Só lê para
 * quem tem o quadro liberado (`enabled`). */
export function useServiceRestrictions(workId: string, enabled: boolean) {
  const [state, setState] = useState<ServiceRestrictionsState>({ status: 'loading' });
  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      const response = await fetchPending(workId);
      setState(
        response.available
          ? {
              status: 'ready',
              cards: response.cards.filter(card => card.origin === 'longo_prazo' && card.sourceId),
              people: response.people,
            }
          : { status: 'unavailable' },
      );
    } catch {
      // Falha na releitura não apaga o que já está na tela.
      setState(previous => (previous.status === 'ready' ? previous : { status: 'error' }));
    }
  }, [enabled, workId]);
  useEffect(() => {
    if (!enabled) return;
    // Lê fora do corpo do efeito (num microtask), como as outras telas com leitura própria.
    const first = setTimeout(() => void load(), 0);
    const onChanged = () => void load();
    const onVisible = () => document.visibilityState === 'visible' && void load();
    window.addEventListener(PENDING_CHANGED_EVENT, onChanged);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(first);
      window.removeEventListener(PENDING_CHANGED_EVENT, onChanged);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, load]);
  return { state, reload: load };
}

/** Em aberto primeiro, pela entrega; fechados depois, do mais recente para o mais antigo. */
export function restrictionsOfService(cards: readonly PendingCard[], serviceId: string) {
  const own = cards.filter(card => card.origin === 'longo_prazo' && card.sourceId === serviceId);
  const open = own
    .filter(card => !isClosed(card.status))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title, 'pt-BR'));
  const closed = own.filter(card => isClosed(card.status)).sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''));
  return { open, closed };
}

function Row({ card, people, workId, today }: { card: PendingCard; people: readonly PendingPerson[]; workId: string; today: LocalDate }) {
  const responsible = people.find(person => person.id === card.responsibleId)?.name ?? 'Sem responsável';
  return (
    <li className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <Link
          href={pendingPath(workId, card.id)}
          className="text-link min-w-0 font-semibold"
          title="Abrir este card no Quadro de Restrições (aba 1.4)"
        >
          {card.title}
        </Link>
        <SignalChip card={card} today={today} />
      </div>
      <p className="mt-0.5 text-slate-600">
        {PENDING_STATUS_LABELS[card.status]} · entrega {formatDate(card.dueDate)}
        {!isClosed(card.status) && card.leadTimeDays > 0 ? ` · começar até ${formatDate(startBy(card))}` : ''} · {responsible}
      </p>
      {card.statusReason && <p className="mt-0.5 text-slate-500">Motivo: {card.statusReason}</p>}
      {card.description && <p className="mt-0.5 line-clamp-2 whitespace-pre-line text-slate-500">{card.description}</p>}
    </li>
  );
}

export function ServiceRestrictions({
  state,
  serviceId,
  serviceName,
  workId,
  today,
  titleClassName,
}: {
  state: ServiceRestrictionsState;
  serviceId: string;
  serviceName: string;
  workId: string;
  today: LocalDate;
  titleClassName: string;
}) {
  if (state.status === 'unavailable') return null;
  const { open, closed } = state.status === 'ready' ? restrictionsOfService(state.cards, serviceId) : { open: [], closed: [] };
  const people = state.status === 'ready' ? state.people : [];
  return (
    <div data-tour="longo-lob-restricoes">
      <p className={titleClassName}>Restrições do serviço{state.status === 'ready' ? ` (${open.length} em aberto)` : ''}</p>
      {state.status === 'loading' && <p className="mt-1 text-xs text-slate-500">Carregando as restrições…</p>}
      {state.status === 'error' && (
        <p className="mt-1 text-xs text-slate-500">Não foi possível ler o Quadro de Restrições agora. Elas continuam na aba 1.4.</p>
      )}
      {state.status === 'ready' && !open.length && (
        <p className="mt-1 text-xs text-slate-500">
          Nenhuma restrição em aberto ligada a {serviceName}
          {closed.length ? '.' : ' no Quadro de Restrições.'}
        </p>
      )}
      {open.length > 0 && (
        <ul className="mt-1 space-y-1">
          {open.map(card => (
            <Row key={card.id} card={card} people={people} workId={workId} today={today} />
          ))}
        </ul>
      )}
      {closed.length > 0 && (
        <details className="mt-1">
          <summary className="text-link cursor-pointer text-xs">
            {closed.length === 1 ? 'Ver 1 já concluída ou cancelada' : `Ver ${closed.length} já concluídas ou canceladas`}
          </summary>
          <ul className="mt-1 space-y-1">
            {closed.map(card => (
              <Row key={card.id} card={card} people={people} workId={workId} today={today} />
            ))}
          </ul>
        </details>
      )}
      {state.status === 'ready' && (
        <p className="mt-1 text-[11px] text-slate-400">
          São as restrições do serviço inteiro, em todos os locais. Clique numa para abrir no quadro.
        </p>
      )}
    </div>
  );
}

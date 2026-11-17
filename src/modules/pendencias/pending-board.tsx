'use client';
import { useEffect, useState, type DragEvent } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import {
  PENDING_ORIGIN_LABELS,
  PENDING_STATUSES,
  PENDING_STATUS_LABELS,
  checklistProgress,
  statusNeedsReason,
  type PendingCard,
  type PendingOrigin,
  type PendingStatus,
} from '@/domain/pending-board';
import { usePlanning } from '@/modules/planejamento/planning-provider';
import { Callout, LoadState, Missing } from '@/modules/planejamento/ui';
import { TabHeader } from '@/modules/layout/tab-header';
import { useConfirm } from '@/modules/layout/confirm';
import { useToast } from '@/modules/layout/toast';
import { errorText, usePending } from './api';
import { PendingCardDialog } from './card-dialog';
import { CreatePendingDialog } from './create-pending-dialog';
import { PendingCardFace } from './pending-card';
import { ReasonDialog } from './reason-dialog';
import { Chip, SIGNAL_TONE, pendingPath } from './parts';
import {
  NO_FILTERS,
  applyMove,
  cardsByStatus,
  filterCards,
  filterOrigins,
  hasFilters,
  isSamePlace,
  messageCount,
  openItemCount,
  personName,
  plural,
  sortPeople,
  summarizeSignals,
  type MoveTarget,
  type PendingFilters,
} from './pending-view';

/** Folga entre o pé do quadro e o pé da janela, e a altura mínima do quadro em janela baixa (24rem). */
const FIT_GAP = 8;
const FIT_MIN = 384;
/** Abaixo de `sm` o quadro fica como era: colunas da altura dos cards e a página rolando. */
const FIT_QUERY = '(min-width: 640px)';

/** O contêiner que rola a página (o do layout, não a janela). */
function scrollParent(node: HTMLElement): HTMLElement | null {
  for (let el = node.parentElement; el && el !== document.body; el = el.parentElement)
    if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) return el;
  return null;
}

/** Altura do quadro para ele terminar no pé da janela (16/11/2026, retorno do Atmos: "rolar só os cards,
 * como no Prevision"). Antes nenhuma coluna rolava: quem rolava era a página, levando o cabeçalho, os
 * filtros e os contadores. A conta é a altura visível do contêiner que rola menos o que fica acima do
 * quadro (medido com a página no topo) e o respiro de baixo dos contêineres; com isso a página deixa de
 * rolar e cada coluna rola os próprios cards. Em janela baixa o quadro fica com `FIT_MIN` e a página volta
 * a rolar. Devolve o `ref` do quadro e a altura; `undefined` (celular, ou antes da primeira medida) = sem
 * altura fixa. */
function useFitHeight(): [(node: HTMLDivElement | null) => void, number | undefined] {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [height, setHeight] = useState<number>();
  useEffect(() => {
    if (!node) return;
    const wide = window.matchMedia(FIT_QUERY);
    const scroller = scrollParent(node);
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!wide.matches) return setHeight(undefined);
        const box = node.getBoundingClientRect();
        // Topo do quadro dentro do conteúdo rolável: não muda quando a página rola.
        const top = scroller ? box.top - scroller.getBoundingClientRect().top + scroller.scrollTop : box.top + window.scrollY;
        const visible = scroller ? scroller.clientHeight : window.innerHeight;
        let below = FIT_GAP;
        for (let el = node.parentElement; el && el !== scroller && el !== document.body; el = el.parentElement)
          below += parseFloat(getComputedStyle(el).paddingBottom) || 0;
        const next = Math.max(FIT_MIN, Math.floor(visible - top - below));
        setHeight(current => (current === next ? current : next));
      });
    };
    measure();
    // O que fica acima muda de altura (contadores quebrando linha, aviso do link, filtros): o pai acusa.
    const observer = new ResizeObserver(measure);
    if (node.parentElement) observer.observe(node.parentElement);
    if (scroller) observer.observe(scroller);
    window.addEventListener('resize', measure);
    wide.addEventListener('change', measure);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', measure);
      wide.removeEventListener('change', measure);
    };
  }, [node]);
  return [setNode, height];
}

/** Lista de pendência, a segunda visão da aba 2 (10/11/2026, modelo aprovado "Modelo da lista de
 * pendência"): quadro Kanban de cinco colunas — A fazer, Fazendo, Pausado, Concluído, Cancelado — com
 * prazo em dias úteis, responsável, conversa com menções e checklists. Os cards se arrastam entre as
 * colunas e dentro delas; o menu "⋮" de cada card e o seletor "Coluna" do card aberto movem sem
 * arrastar. Pausar e cancelar pedem motivo; concluir com item de checklist aberto pede confirmação.
 * Desde 16/11/2026 o quadro cabe na janela e cada coluna rola os próprios cards (`useFitHeight`).
 * `initialCardId` vem do `?card=` do endereço (o link do e-mail de menção). */
export function PendingBoard({ workId, initialCardId }: { workId: string; initialCardId?: string }) {
  const context = usePlanning();
  const { state, reload, refresh, execute } = usePending(workId);
  const { toast } = useToast();
  const confirm = useConfirm();
  const [filters, setFilters] = useState<PendingFilters>(NO_FILTERS);
  const [openId, setOpenId] = useState(initialCardId);
  const [creating, setCreating] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [dragId, setDragId] = useState<string>();
  const [drop, setDrop] = useState<MoveTarget>();
  const [reasonFor, setReasonFor] = useState<{ cardId: string; target: MoveTarget }>();
  const [boardRef, boardHeight] = useFitHeight();

  if (context.state !== 'ready') return <LoadState error={context.state === 'error'} />;
  const { planning } = context;
  const work = planning.data.works.find(w => w.id === workId);
  const actor = planning.data.users.find(u => u.id === context.actorId);
  if (!work || !actor?.workIds.includes(workId)) return <Missing label="Obra não encontrada" />;
  // "Hoje" no fuso da obra (America/Sao_Paulo), o mesmo das outras abas.
  const today = planning.today;

  const header = (
    <TabHeader
      workId={workId}
      section="restricoes"
      description="As pendências que precisam estar resolvidas antes de cada frente começar, com prazo, responsável, conversa e checklist."
      helpTitle="Como funciona: quadro de restrições"
      help={
        <>
          <p>
            Cada card é uma pendência com data de entrega, tempo de execução em dias úteis e responsável. “Começar até” é a entrega menos o
            tempo de execução: o card fica amarelo quando precisa começar nos próximos 5 dias úteis e vermelho quando passou do começo sem
            sair de A fazer, ou passou da entrega sem concluir.
          </p>
          <p>
            Arraste o card entre as colunas, ou use o menu “⋮” do card. Pausar e cancelar pedem um motivo, que aparece no card. Concluir com
            item de checklist em aberto pede confirmação.
          </p>
          <p>
            O card nasce aqui (“+ Nova pendência”, que já abre para escolher a tarefa do médio prazo ou o serviço do longo prazo), numa
            tarefa do médio prazo ou num serviço do longo prazo. Nesses casos a entrega é o dia útil anterior ao início da tarefa ou do
            serviço e muda junto com ele. “Sem ligação” cria um card avulso, com a data digitada.
          </p>
          <p>
            Trocar o responsável pede confirmação antes de gravar. Cada coluna rola os próprios cards; o cabeçalho e os filtros ficam
            parados.
          </p>
          <p>Na conversa, o @ marca quem tem a obra liberada; quem é marcado recebe um e-mail com a mensagem e o link do card.</p>
        </>
      }
    />
  );

  if (state.status === 'loading')
    return (
      <>
        {header}
        <div role="status" aria-label="Carregando o Quadro de Restrições" className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {PENDING_STATUSES.map(status => (
            <div key={status} className="skeleton h-40" />
          ))}
        </div>
      </>
    );
  if (state.status === 'error')
    return (
      <>
        {header}
        <div className="panel mt-4 space-y-4 p-6">
          <Callout tone="danger" role="alert">
            Não foi possível carregar o Quadro de Restrições. {state.message}
          </Callout>
          <button
            type="button"
            className="button-ghost"
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              reload().finally(() => setRetrying(false));
            }}
          >
            <RefreshCw size={15} aria-hidden />
            {retrying ? 'Tentando…' : 'Tentar de novo'}
          </button>
        </div>
      </>
    );
  if (state.status === 'unavailable')
    return (
      <>
        {header}
        <div className="mt-4">
          <Callout tone="warning" role="status">
            O Quadro de Restrições fica indisponível até a migração 0043 ser aplicada no banco.
          </Callout>
        </div>
      </>
    );

  const data = state.data;
  const people = sortPeople(data.people);
  // Quem perdeu o acesso à obra some de `people`, mas continua autor de mensagens e responsável antigo.
  const nameOf = (id: string) => personName(data.people, id, planning.data.users.find(u => u.id === id)?.name);
  const visible = filterCards(data.cards, filters);
  const columns = cardsByStatus(visible);
  const summary = summarizeSignals(visible, today);
  const openCard = openId ? data.cards.find(c => c.id === openId) : undefined;
  const reasonCard = reasonFor ? data.cards.find(c => c.id === reasonFor.cardId) : undefined;

  // O endereço acompanha o card aberto, para o link copiado da barra abrir no mesmo card.
  const show = (cardId: string | undefined) => {
    setOpenId(cardId);
    window.history.replaceState(null, '', pendingPath(workId, cardId));
  };

  const move = (card: PendingCard, target: MoveTarget, reason?: string) =>
    execute({ type: 'move_card', cardId: card.id, status: target.status, reason, beforeCardId: target.beforeCardId }, view => ({
      ...view,
      cards: applyMove(view.cards, card.id, target, reason),
    }));
  /** Move pelas regras do quadro: motivo ao pausar ou cancelar, confirmação ao concluir com item aberto.
   * Lança o erro do servidor; quem chama decide onde mostrar. */
  const requestMove = async (cardId: string, target: MoveTarget) => {
    const card = data.cards.find(c => c.id === cardId);
    if (!card || isSamePlace(data.cards, cardId, target)) return;
    const changing = card.status !== target.status;
    if (changing && statusNeedsReason(target.status)) return setReasonFor({ cardId, target });
    if (changing && target.status === 'done') {
      const open = openItemCount(data.items, cardId);
      if (open > 0) {
        const ok = await confirm({
          title: 'Concluir com itens em aberto?',
          description: `“${card.title}” ainda tem ${plural(open, 'item de checklist sem marcar', 'itens de checklist sem marcar')}.`,
          confirmLabel: 'Concluir assim mesmo',
        });
        if (!ok) return;
      }
    }
    // Reordenar dentro de Pausado ou Cancelado mantém o motivo que o card já tem.
    await move(card, target, changing ? undefined : card.statusReason);
  };
  const moveFromBoard = (cardId: string, target: MoveTarget) => {
    requestMove(cardId, target).catch(cause =>
      toast({ title: 'O card não foi movido.', description: errorText(cause, ''), tone: 'danger' }),
    );
  };

  // ── Arrastar e soltar (HTML5 nativo) ──
  const sameDrop = (a: MoveTarget | undefined, b: MoveTarget) => a?.status === b.status && a.beforeCardId === b.beforeCardId;
  const aim = (target: MoveTarget) => setDrop(current => (sameDrop(current, target) ? current : target));
  const endDrag = () => {
    setDragId(undefined);
    setDrop(undefined);
  };
  const overCard = (event: DragEvent<HTMLElement>, card: PendingCard, column: PendingCard[]) => {
    if (!dragId) return;
    event.preventDefault();
    event.stopPropagation();
    const box = event.currentTarget.getBoundingClientRect();
    // Sobre o próprio card arrastado: fica onde está.
    if (card.id === dragId) return aim({ status: card.status, beforeCardId: card.id });
    const upper = event.clientY < box.top + box.height / 2;
    // Metade de cima: entra acima deste card. Metade de baixo: acima do próximo (ou no fim da coluna).
    const next = column[column.findIndex(c => c.id === card.id) + 1];
    aim({ status: card.status, beforeCardId: upper ? card.id : next?.id });
  };
  const dropOn = (event: DragEvent<HTMLElement>, status: PendingStatus) => {
    event.preventDefault();
    const cardId = dragId ?? event.dataTransfer.getData('text/plain');
    const target = drop?.status === status ? drop : { status };
    endDrag();
    if (cardId) moveFromBoard(cardId, target);
  };

  const marker = <div aria-hidden className="h-1 shrink-0 rounded-full bg-primary" />;
  const fitted = boardHeight !== undefined;

  return (
    <>
      {header}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div data-tour="pendencias-filtros" className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">
              Responsável
              <select
                className="field w-auto py-1.5"
                value={filters.responsibleId}
                onChange={event => setFilters({ ...filters, responsibleId: event.target.value })}
              >
                <option value="">Todos</option>
                {people.map(person => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">
              Origem
              <select
                className="field w-auto py-1.5"
                value={filters.origin}
                onChange={event => setFilters({ ...filters, origin: event.target.value as PendingOrigin | '' })}
              >
                <option value="">Todas</option>
                {filterOrigins(data.cards).map(origin => (
                  <option key={origin} value={origin}>
                    {PENDING_ORIGIN_LABELS[origin]}
                  </option>
                ))}
              </select>
            </label>
            {hasFilters(filters) && (
              <button type="button" className="text-link text-xs" onClick={() => setFilters(NO_FILTERS)}>
                Limpar filtros
              </button>
            )}
          </div>
          <button type="button" data-tour="pendencias-nova" className="button" onClick={() => setCreating(true)}>
            <Plus size={15} aria-hidden />
            Nova pendência
          </button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Chip tone={SIGNAL_TONE.late}>{plural(summary.late, 'atrasada', 'atrasadas')}</Chip>
        <Chip tone={SIGNAL_TONE.soon}>
          {summary.soon} {summary.soon === 1 ? 'precisa' : 'precisam'} começar em até 5 dias úteis
        </Chip>
        <Chip tone={SIGNAL_TONE.ok}>{summary.ok} no prazo</Chip>
        <span className="text-xs text-slate-500">
          Cada card mostra a entrega e até quando precisa começar (entrega menos o tempo de execução, em dias úteis).
        </span>
      </div>

      {openId && !openCard && (
        <div className="mt-4">
          <Callout tone="warning" role="status">
            O card deste link não existe mais nesta obra.{' '}
            <button type="button" className="text-link" onClick={() => show(undefined)}>
              Dispensar
            </button>
          </Callout>
        </div>
      )}

      {/* O quadro rola de lado dentro da própria caixa em tela estreita; a página não. Com altura medida
          (a partir de `sm`), ele termina no pé da janela e cada coluna rola os próprios cards. */}
      <div
        ref={boardRef}
        data-tour="pendencias-quadro"
        role="region"
        aria-label="Quadro de Restrições"
        tabIndex={0}
        style={fitted ? { height: boardHeight } : undefined}
        className={`custom-scrollbar mt-4 max-w-full overflow-x-auto pb-2 ${fitted ? 'overflow-y-hidden' : ''}`}
      >
        <div
          className={`grid min-w-[70rem] grid-cols-5 gap-3 ${fitted ? 'h-full grid-rows-[minmax(0,1fr)] items-stretch' : 'items-start'}`}
        >
          {PENDING_STATUSES.map(status => {
            const column = columns[status];
            // A lista sem o card arrastado: é entre os outros que ele vai cair.
            const others = column.filter(c => c.id !== dragId);
            const aimed = !!dragId && drop?.status === status;
            return (
              <section
                key={status}
                aria-label={`${PENDING_STATUS_LABELS[status]}: ${plural(column.length, 'card', 'cards')}`}
                onDragOver={event => {
                  if (!dragId) return;
                  event.preventDefault();
                  aim({ status });
                }}
                onDrop={event => dropOn(event, status)}
                className={`flex flex-col gap-2 rounded-2xl p-2.5 transition-colors ${fitted ? 'min-h-0' : 'min-h-32'} ${aimed ? 'bg-primary-soft ring-2 ring-inset ring-primary-ring' : 'bg-slate-200/60'}`}
              >
                <h2 className="flex shrink-0 items-center justify-between px-1 py-0.5 text-sm font-bold text-slate-800">
                  {PENDING_STATUS_LABELS[status]}
                  <span className="text-xs font-semibold tabular-nums text-slate-500">{column.length}</span>
                </h2>
                {/* Só esta lista rola; o título fica em cima e o "+ Nova pendência" embaixo, sempre à vista.
                    A área vazia abaixo do último card continua sendo da coluna: soltar ali é ir para o fim. */}
                <div
                  data-column-cards
                  className={`flex flex-col gap-2 ${fitted ? 'custom-scrollbar -mx-1.5 min-h-0 flex-1 overflow-y-auto px-1.5 py-0.5' : ''}`}
                >
                  {column.map(card => (
                    <div key={card.id} className="flex shrink-0 flex-col gap-2">
                      {aimed && drop?.beforeCardId === card.id && card.id !== dragId && marker}
                      <PendingCardFace
                        card={card}
                        today={today}
                        responsible={nameOf(card.responsibleId)}
                        progress={checklistProgress(data.items, card.id)}
                        messages={messageCount(data.messages, card.id)}
                        selected={card.id === openId}
                        dragging={card.id === dragId}
                        onOpen={() => show(card.id)}
                        onMove={next => moveFromBoard(card.id, { status: next })}
                        onDragStart={event => {
                          event.dataTransfer.effectAllowed = 'move';
                          event.dataTransfer.setData('text/plain', card.id);
                          setDragId(card.id);
                        }}
                        onDragEnd={endDrag}
                        onDragOver={event => overCard(event, card, others)}
                      />
                    </div>
                  ))}
                  {aimed && !drop?.beforeCardId && marker}
                  {column.length === 0 && !aimed && (
                    <p className="rounded-xl border border-dashed border-slate-300 px-3 py-4 text-center text-xs text-slate-500">
                      {hasFilters(filters) ? 'Nenhum card com estes filtros.' : 'Nenhum card aqui.'}
                    </p>
                  )}
                </div>
                {status === 'todo' && (
                  <button
                    type="button"
                    onClick={() => setCreating(true)}
                    className="flex shrink-0 items-center justify-center gap-1.5 rounded-xl border border-dashed border-slate-300 px-3 py-2 text-xs font-semibold text-slate-500 transition-colors hover:border-brand-300 hover:bg-white hover:text-brand-900"
                  >
                    <Plus size={13} aria-hidden />
                    Nova pendência
                  </button>
                )}
              </section>
            );
          })}
        </div>
      </div>

      {openCard && (
        <PendingCardDialog
          card={openCard}
          data={data}
          today={today}
          nameOf={nameOf}
          execute={execute}
          onMove={status => requestMove(openCard.id, { status })}
          onDelete={async () => {
            await execute({ type: 'delete_card', cardId: openCard.id });
            show(undefined);
            toast({ title: 'Card excluído.', description: openCard.title, tone: 'success' });
          }}
          onClose={() => show(undefined)}
        />
      )}
      {reasonFor && reasonCard && (
        <ReasonDialog
          title={reasonCard.title}
          status={reasonFor.target.status}
          onSubmit={reason => move(reasonCard, reasonFor.target, reason)}
          onClose={() => setReasonFor(undefined)}
        />
      )}
      <CreatePendingDialog workId={workId} open={creating} onClose={() => setCreating(false)} onCreated={() => void refresh()} />
    </>
  );
}

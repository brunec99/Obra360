'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent } from 'react';
import { ClipboardPaste, DownloadCloud, Plus, RefreshCw, Sparkles, Trash2, Undo2 } from 'lucide-react';
import { LOB_LIMITS, type LobCostAccess, type LobId, type LobService } from '@/domain/lob';
import {
  formatIdp,
  formatMoney,
  formatMoneyInput,
  IDP_TONE_LABEL,
  idpTone,
  lobPerformance,
  servicePerformance,
  weightingLabel,
  type IdpTone,
  type LobPerformance,
  type LobServicePerformance,
} from '@/domain/lob-performance';
import { HelpNote } from '@/modules/layout/help-note';
import { useConfirm } from '@/modules/layout/confirm';
import { useToast } from '@/modules/layout/toast';
import { usePlanning } from '@/modules/planejamento/planning-provider';
import { Callout, Empty, LoadState, StatCard } from '@/modules/planejamento/ui';
import { workPath } from '@/shared/format';
import { useLob } from './lob-api';
import { CommitField } from './lob-activity-panel';
import { Pill } from './measurement-sheet';
import { CostsImportDialog } from './costs-import-dialog';
import { mergeSiengeBudget } from './costs-sienge';
import { CostsSiengeDialog } from './costs-sienge-dialog';
import { requestCostSuggestions } from './costs-suggest-api';
import {
  addItems,
  applySuggestions,
  byItemOrder,
  columnFill,
  columnValues,
  costsDiff,
  diffSize,
  importBudget,
  itemsOf,
  liveMarks,
  moveItems,
  pastedRows,
  readAmount,
  removeItems,
  saveBlocker,
  setPackageAmount,
  SUGGEST_BATCH,
  SUGGEST_MAX,
  suggestedItems,
  suggestionBatches,
  suggestionCandidates,
  suggestionSummary,
  undoSuggestions,
  updateItem,
  usableSuggestions,
  type DraftContext,
  type DraftCost,
  type SuggestionConfidence,
  type SuggestionMarks,
  type SuggestionSummary,
} from './costs-model';

/** Visão "Custos" da aba 1 (11/11/2026, pedida junto com o IDP ponderado por custo): o orçamento
 * apropriado em cada pacote de serviço. O custo do pacote é a soma dos itens dele; quem tem um valor
 * só digita na linha do pacote, quem tem o orçamento detalhado cola as linhas e aponta cada uma.
 *
 * Toda edição vai para um rascunho local (os mesmos `LobCostItem` do servidor), e os cartões, o peso
 * e o IDP já saem dele; "Salvar" manda um único `save_costs` com o que mudou. Quem só consulta recebe
 * cada valor como % do total (regra 9) e vê a tela sem campos.
 *
 * "Sugerir com a Claudia" (16/11/2026): manda os itens não apropriados (id, código e descrição, nunca o
 * valor) em lotes, aplica os pacotes sugeridos só no rascunho e marca cada item com o selo "Sugestão da
 * Claudia" até a pessoa mexer nele ou salvar. Quem confere e grava é o engenheiro. */

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('pt-BR')} ${n === 1 ? one : many}`;
const pct = (value: number) => `${value.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
const shortDate = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
const errorMessage = (error: unknown) => (error instanceof Error && error.message ? error.message : 'Falha na comunicação com o servidor.');
const PILL_TONE: Record<IdpTone, 'ok' | 'warn' | 'late'> = { good: 'ok', warn: 'warn', bad: 'late' };
const CARD_TONE: Record<IdpTone, 'success' | 'warning' | 'danger'> = { good: 'success', warn: 'warning', bad: 'danger' };
/** Listas compridas (orçamento detalhado) aparecem em lotes, para a tela não travar. */
const PAGE = 100;
const NONE = '__none__';

const Dot = ({ color }: { color: string }) => (
  <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
);

/** Selo do item que a Claudia apontou e ninguém conferiu ainda; "confira" na confiança baixa. */
function SuggestionBadge({ confidence }: { confidence: SuggestionConfidence }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-[11px] leading-4 font-semibold">
      <span className="inline-flex items-center gap-1 rounded-full bg-primary-soft px-2 py-0.5 text-primary">
        <Sparkles size={11} aria-hidden />
        Sugestão da Claudia
      </span>
      {confidence === 'baixa' && <span className="rounded-full bg-warning-soft px-2 py-0.5 text-warning">confira</span>}
    </span>
  );
}

/** Resumo da última rodada de sugestões: o que sobrou fora do teto do clique e por que parou antes. */
type SuggestionRun = SuggestionSummary & { left: number; stopped?: 'cancel' | 'error' };

// ─── Campo de valor ─────────────────────────────────────────────────────────────

/** Campo de valor em reais que grava no rascunho ao sair ou no Enter; Esc volta ao valor anterior.
 * Valor que não se lê fica em vermelho e não entra no rascunho. Com `allowEmpty`, apagar o campo
 * manda `null`. Colar várias linhas chama `onColumnPaste`, se houver. */
function MoneyField({
  value,
  onCommit,
  ariaLabel,
  allowEmpty = false,
  placeholder,
  warn = false,
  disabled,
  onColumnPaste,
  className = '',
}: {
  value: number | undefined;
  onCommit: (amount: number | null) => void;
  ariaLabel: string;
  allowEmpty?: boolean;
  placeholder?: string;
  /** Destaque de "falta preencher" (pacote com blocos sem custo). */
  warn?: boolean;
  disabled?: boolean;
  onColumnPaste?: (text: string) => void;
  className?: string;
}) {
  const [text, setText] = useState<string>();
  const [error, setError] = useState<string>();
  const shown = text ?? (value === undefined ? '' : formatMoneyInput(value));
  const commit = () => {
    if (text === undefined) return;
    const read = readAmount(text);
    if (read.kind === 'invalid') return setError(read.reason);
    if (read.kind === 'empty') {
      if (!allowEmpty) return setError('Informe o valor.');
      if (value !== undefined) onCommit(null);
    } else if (read.amount !== value) onCommit(read.amount);
    setText(undefined);
    setError(undefined);
  };
  const paste = (event: ClipboardEvent<HTMLInputElement>) => {
    if (!onColumnPaste) return;
    const pasted = event.clipboardData.getData('text');
    if (pastedRows(pasted) < 2) return;
    event.preventDefault();
    setText(undefined);
    setError(undefined);
    onColumnPaste(pasted);
  };
  return (
    <span className={`block ${className}`}>
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        aria-label={ariaLabel}
        aria-invalid={error ? true : undefined}
        title={error}
        placeholder={placeholder}
        disabled={disabled}
        value={shown}
        className={`field py-1 text-right tabular-nums ${error ? 'border-danger ring-2 ring-danger-ring' : warn && !shown ? 'border-warning-ring bg-warning-soft/40' : ''}`}
        onChange={event => {
          setText(event.target.value);
          if (error) setError(undefined);
        }}
        onBlur={commit}
        onPaste={paste}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            setText(undefined);
            setError(undefined);
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
      {error && (
        <span role="alert" className="mt-0.5 block text-left text-[11px] leading-4 font-semibold text-danger">
          {error}
        </span>
      )}
    </span>
  );
}

// ─── A visão ────────────────────────────────────────────────────────────────────

export function CostsView({ workId }: { workId: string }) {
  const { state, reload, execute } = useLob(workId);
  const planning = usePlanning();
  const confirm = useConfirm();
  const router = useRouter();
  const { toast } = useToast();
  /** Itens editados e ainda não salvos; `null` = a tela mostra o que está no servidor. */
  const [draft, setDraft] = useState<DraftCost[] | null>(null);
  const [selectedId, setSelectedId] = useState<LobId>();
  const [importing, setImporting] = useState(false);
  const [fetchingSienge, setFetchingSienge] = useState(false);
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState(false);
  /** Itens que a Claudia apontou nesta sessão (pacote e confiança); o selo vale enquanto o item seguir lá. */
  const [marks, setMarks] = useState<SuggestionMarks>(() => new Map());
  const [suggesting, setSuggesting] = useState<{ batch: number; batches: number; done: number; total: number } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [suggestionRun, setSuggestionRun] = useState<SuggestionRun | null>(null);
  const cancelRef = useRef(false);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const ready = planning.state === 'ready' ? planning : undefined;
  const actor = ready?.planning.data.users.find(u => u.id === ready.actorId);
  const readOnly = !actor || actor.role === 'viewer';
  const data = state.status === 'ready' ? state.data : undefined;
  const costAccess: LobCostAccess = state.status === 'ready' ? state.costAccess : 'unavailable';
  // Durante a gravação os campos ficam desabilitados (fieldset), sem sumir da tela.
  const editable = !readOnly && costAccess === 'full';
  const masked = costAccess === 'masked';

  const server = useMemo(() => data?.costs ?? [], [data]);
  const serverRef = useRef(server);
  useEffect(() => {
    serverRef.current = server;
  }, [server]);
  const costs = draft ?? server;
  const costsRef = useRef(costs);
  useEffect(() => {
    costsRef.current = costs;
  }, [costs]);
  const serviceIds = useMemo(() => new Set((data?.services ?? []).map(s => s.id)), [data]);
  /** Itens não apropriados do rascunho, como vão à Claudia: id, código e descrição. */
  const candidates = useMemo(() => suggestionCandidates(costs, serviceIds), [costs, serviceIds]);
  const diff = useMemo(() => (draft ? costsDiff(server, draft) : { upsert: [], remove: [] }), [server, draft]);
  const changes = diffSize(diff);
  const dirty = changes > 0;

  const performanceData = useMemo(() => (data ? { ...data, costs } : undefined), [data, costs]);
  const performance = useMemo(() => (performanceData ? lobPerformance(performanceData) : undefined), [performanceData]);
  const rows = useMemo(
    () => (performanceData && performance ? servicePerformance(performanceData, performance) : []),
    [performanceData, performance],
  );

  const edit = useCallback(
    (change: (current: DraftCost[]) => DraftCost[]) => setDraft(current => change(current ?? serverRef.current)),
    [],
  );
  const unmark = (ids: readonly LobId[]) =>
    setMarks(current => {
      if (!ids.some(id => current.has(id))) return current;
      const next = new Map(current);
      for (const id of ids) next.delete(id);
      return next;
    });
  const clearSuggestions = () => {
    setMarks(new Map());
    setSuggestionRun(null);
  };
  /** Manda os itens não apropriados à Claudia, um lote por vez, e aplica cada resposta no rascunho. */
  const suggest = async () => {
    if (suggesting || !candidates.length) return;
    const sent = candidates.slice(0, SUGGEST_MAX);
    const batches = suggestionBatches(sent, SUGGEST_BATCH);
    const applied = new Map<LobId, { serviceId: LobId; confidence: SuggestionConfidence }>();
    let asked = 0;
    let stopped: SuggestionRun['stopped'];
    cancelRef.current = false;
    setCancelling(false);
    setSuggestionRun(null);
    for (let index = 0; index < batches.length; index++) {
      if (cancelRef.current) {
        stopped = 'cancel';
        break;
      }
      const batch = batches[index];
      setSuggesting({ batch: index + 1, batches: batches.length, done: asked, total: sent.length });
      try {
        const response = await requestCostSuggestions(workId, batch);
        if (!aliveRef.current) return;
        // Só valem respostas sobre itens deste lote que continuam sem pacote no rascunho de agora.
        const askedIds = new Set(batch.map(item => item.id));
        const suggestions = response.suggestions.filter(s => askedIds.has(s.itemId));
        const usable = usableSuggestions(costsRef.current, suggestions, serviceIds);
        for (const [id, mark] of usable) applied.set(id, mark);
        setMarks(current => new Map([...current, ...usable]));
        edit(current => applySuggestions(current, suggestions, serviceIds));
        asked += batch.length;
      } catch (error) {
        if (!aliveRef.current) return;
        toast({
          title: 'A Claudia não conseguiu sugerir',
          description: `${errorMessage(error)}${asked ? ' O que já foi sugerido continua na tela.' : ''}`,
          tone: 'danger',
        });
        stopped = 'error';
        break;
      }
    }
    setSuggesting(null);
    setCancelling(false);
    if (asked) setSuggestionRun({ ...suggestionSummary(asked, applied), left: candidates.length - asked, stopped });
  };
  const draftContext = (): DraftContext => ({
    workId,
    actorId: actor?.id ?? '',
    now: new Date().toISOString(),
    newId: () => crypto.randomUUID(),
  });

  // Saída com alterações pendentes: aviso do navegador ao fechar ou recarregar e, nos links da
  // própria aplicação (as outras visões, o menu), a confirmação do sistema antes de trocar de tela.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor || (anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      event.preventDefault();
      event.stopPropagation();
      confirm({
        title: 'Sair sem salvar os custos?',
        description: `${plural(changes, 'alteração não salva se perde', 'alterações não salvas se perdem')}.`,
        confirmLabel: 'Sair sem salvar',
        cancelLabel: 'Continuar aqui',
        tone: 'danger',
      }).then(ok => {
        if (ok) router.push(`${url.pathname}${url.search}${url.hash}`);
      });
    };
    window.addEventListener('beforeunload', warn);
    document.addEventListener('click', click, true);
    return () => {
      window.removeEventListener('beforeunload', warn);
      document.removeEventListener('click', click, true);
    };
  }, [dirty, changes, confirm, router]);

  const help = (
    <HelpNote title="Como funciona: Custos">
      <p>
        Cada <strong>pacote de serviço</strong> recebe um ou mais itens do orçamento; o custo do pacote é a soma deles. Com um valor só por
        pacote, digite na linha do pacote. Com o orçamento detalhado, use <strong>Colar do orçamento</strong> e aponte cada linha a um
        pacote.
      </p>
      <p>
        O custo do pacote se reparte entre os blocos dele pela duração. Enquanto algum pacote com blocos estiver sem custo, tudo segue{' '}
        <strong>pesado pela duração</strong>. Um item de valor zero conta como informado.
      </p>
      <p>
        O peso é um só na aba: o avanço físico, o previsto, a curva das Medições e o IDP usam o mesmo. Pacote sem blocos não entra no peso.
      </p>
      <p>
        <strong>IDP</strong> = % físico real ÷ % físico planejado, na data da última medição fechada (a medição aberta não conta). O
        planejado vem da linha de base manual mais recente; sem nenhuma, do cronograma atual.
      </p>
      <p>
        Faixas: 1,00 ou mais é <strong>em dia</strong>; de 0,90 a 0,99, <strong>atenção</strong>; abaixo de 0,90, <strong>atrasado</strong>.
      </p>
      <p>
        <strong>Sugerir com a Claudia</strong>: a assistente lê o código e a descrição dos itens não apropriados e propõe o pacote de cada
        um. Ela só propõe: os itens entram na tela com o selo <strong>Sugestão da Claudia</strong> (e <strong>confira</strong> quando ela
        tem dúvida), e quem confere, corrige e clica em Salvar é o engenheiro da obra. Custo indireto (administração, canteiro, taxas) ela
        deixa sem pacote. O valor em reais não é enviado à IA.
      </p>
      <p>Quem só consulta vê o peso de cada pacote em %, nunca o valor em reais.</p>
    </HelpNote>
  );
  const header = (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1">
          <h2 className="text-lg font-bold text-slate-900">Custos</h2>
          {help}
        </div>
        <p className="text-sm text-slate-500">
          O orçamento apropriado em cada pacote de serviço: dá o peso de cada serviço no avanço físico e no IDP.
        </p>
      </div>
      {editable && data && data.services.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {(candidates.length > 0 || suggesting) && (
            <button
              type="button"
              className="button-ghost"
              disabled={saving || !!suggesting}
              title="A Claudia propõe o pacote de cada item não apropriado. Nada é gravado: você confere e salva."
              onClick={suggest}
            >
              <Sparkles size={15} aria-hidden />
              {suggesting ? 'A Claudia está sugerindo…' : 'Sugerir com a Claudia'}
            </button>
          )}
          <button
            type="button"
            className="button-ghost"
            disabled={saving || !!suggesting}
            title="Traz o orçamento do empreendimento do Sienge ligado à obra. Nada é gravado: você confere e salva."
            onClick={() => setFetchingSienge(true)}
          >
            <DownloadCloud size={15} aria-hidden />
            Buscar do Sienge
          </button>
          <button
            data-tour="longo-custos-colar"
            type="button"
            className="button-ghost"
            disabled={saving || !!suggesting}
            onClick={() => setImporting(true)}
          >
            <ClipboardPaste size={15} aria-hidden />
            Colar do orçamento
          </button>
        </div>
      )}
    </div>
  );

  if (state.status === 'error')
    return (
      <>
        {header}
        <div className="panel p-6">
          <p role="alert" className="text-sm font-semibold text-slate-800">
            Não foi possível carregar os custos.
          </p>
          <p className="mt-1 text-sm text-slate-500">{state.message}</p>
          <button
            type="button"
            className="button-ghost mt-4"
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
        <Callout tone="warning" role="status">
          A Linha de Balanço ainda não foi ativada no banco: aplique a migração 0038 (
          <code className="text-xs">supabase/migrations/0038_lob.sql</code>) e recarregue a página.
        </Callout>
      </>
    );
  if (!data || !performance || planning.state === 'loading')
    return (
      <>
        {header}
        <LoadState rows={8} />
      </>
    );

  const services = [...data.services].sort((a, b) => a.orderIndex - b.orderIndex || a.name.localeCompare(b.name, 'pt-BR'));
  if (!services.length)
    return (
      <>
        {header}
        <div className="panel p-6">
          <Empty>
            Esta obra ainda não tem pacotes de serviço. Os pacotes nascem ao lançar um fluxo na{' '}
            <Link className="text-link" href={workPath(workId, 'longo-prazo')}>
              Linha de Balanço
            </Link>
            ; depois é só voltar aqui para apropriar o orçamento.
          </Empty>
        </div>
      </>
    );

  // ─── Derivados do rascunho ────────────────────────────────────────────────
  const serviceById = new Map(services.map(s => [s.id, s]));
  const rowById = new Map(rows.map(r => [r.serviceId, r]));
  const selected = (selectedId && serviceById.get(selectedId)) || services[0];
  const isAssigned = (item: DraftCost) => !!item.serviceId && serviceById.has(item.serviceId);
  const unassigned = costs.filter(item => !isAssigned(item)).sort(byItemOrder);
  const unassignedTotal = unassigned.reduce((sum, item) => sum + item.amount, 0);
  const noBlocksCost = rows.filter(r => !r.blocks && r.cost !== undefined).reduce((sum, r) => sum + (r.cost ?? 0), 0);
  const weights = performance.weights;
  const withBlocks = weights.servicesWithBlocks.length;
  const missing = weights.missingServiceIds.length;
  const money = (value: number) => (masked ? `${pct(value)} do total` : formatMoney(value));
  const pending = dirty ? ' (não salvo)' : '';
  const live = liveMarks(costs, marks);
  const suggested = suggestedItems(costs, marks);
  const undoAll = () => {
    const count = live.size;
    edit(current => undoSuggestions(current, marks));
    clearSuggestions();
    toast({
      title: 'Sugestões desfeitas',
      description: `${plural(count, 'item voltou', 'itens voltaram')} a não apropriado.`,
      tone: 'info',
    });
  };

  const setAmount = (serviceId: LobId, amount: number | null) =>
    edit(current => setPackageAmount(current, serviceId, amount, draftContext()));
  const pasteColumn = (startId: LobId, text: string) => {
    const counts = new Map<LobId, number>();
    for (const item of costs) if (item.serviceId) counts.set(item.serviceId, (counts.get(item.serviceId) ?? 0) + 1);
    const fill = columnFill(
      services.map(s => s.id),
      startId,
      columnValues(text),
      id => counts.get(id) ?? 0,
    );
    if (fill.assignments.length)
      edit(current => fill.assignments.reduce((acc, a) => setPackageAmount(acc, a.serviceId, a.amount, draftContext()), current));
    const notes = [
      fill.skipped &&
        `${plural(fill.skipped, 'pacote pulado', 'pacotes pulados')} por ter vários itens (o valor da linha dele ficou de fora)`,
      fill.invalid && `${plural(fill.invalid, 'linha não era valor', 'linhas não eram valor')}`,
      fill.blank && `${plural(fill.blank, 'linha em branco', 'linhas em branco')}, sem mudança`,
      fill.leftover && `${plural(fill.leftover, 'valor sobrou', 'valores sobraram')} depois do último pacote`,
    ].filter(Boolean);
    toast({
      title: fill.assignments.length
        ? `${plural(fill.assignments.length, 'pacote preenchido', 'pacotes preenchidos')}`
        : 'Nenhum pacote preenchido',
      description: notes.length ? `${notes.join('; ')}.` : 'Confira e clique em Salvar para gravar.',
      tone: notes.length ? 'info' : 'success',
    });
  };
  const discard = async () => {
    const ok = await confirm({
      title: 'Descartar as alterações?',
      description: `${plural(changes, 'alteração volta', 'alterações voltam')} ao que está salvo.`,
      confirmLabel: 'Descartar',
      tone: 'danger',
    });
    if (!ok) return;
    setDraft(null);
    clearSuggestions();
  };
  const save = async () => {
    if (!draft || !dirty || saving) return;
    const blocker = saveBlocker(draft, diff);
    if (blocker) return toast({ title: 'Não dá para salvar assim', description: blocker, tone: 'danger' });
    const before = new Set(server.map(item => item.id));
    const created = diff.upsert.filter(item => !before.has(item.id)).length;
    const changed = diff.upsert.length - created;
    setSaving(true);
    try {
      await execute({ type: 'save_costs', workId, upsert: diff.upsert, remove: diff.remove });
      setDraft(null);
      // Salvou: o engenheiro conferiu, e os selos saem.
      clearSuggestions();
      const parts = [
        created && plural(created, 'item novo', 'itens novos'),
        changed && plural(changed, 'item alterado', 'itens alterados'),
        diff.remove.length && plural(diff.remove.length, 'item excluído', 'itens excluídos'),
      ].filter(Boolean);
      toast({ title: 'Custos salvos', description: `${parts.join(' · ')}.` });
    } catch (error) {
      toast({ title: 'Não foi possível salvar os custos', description: errorMessage(error), tone: 'danger' });
    } finally {
      setSaving(false);
    }
  };
  const showItems = (id: LobId) => {
    setSelectedId(id);
    // Abaixo de 2xl o painel dos itens fica embaixo da tabela: leva a pessoa até ele.
    if (!window.matchMedia('(min-width: 96rem)').matches)
      requestAnimationFrame(() => document.getElementById('custos-itens')?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  };
  const goToMissing = () => {
    const first = weights.missingServiceIds[0];
    if (!first) return;
    setSelectedId(first);
    document.getElementById(`custo-pacote-${first}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  // ─── Cartões ──────────────────────────────────────────────────────────────
  const point = performance.point;
  const idpValue = performance.status === 'ok' && point?.idp !== undefined ? point.idp : undefined;
  const tone = idpValue !== undefined ? idpTone(idpValue) : undefined;
  const baselineText = performance.baseline ? `contra a linha de base “${performance.baseline.name}”` : 'contra o cronograma atual';
  const idpHint =
    performance.status === 'no-blocks'
      ? 'sem blocos na Linha de Balanço'
      : performance.status === 'no-measurement'
        ? 'sem medição'
        : performance.status === 'nothing-planned' && point
          ? `nada previsto até a data (${shortDate(point.date)}, medição nº ${point.number}) · ${baselineText}`
          : point
            ? `${pct(point.real)} ÷ ${pct(point.planned)} em ${shortDate(point.date)} (medição nº ${point.number}) · ${baselineText} · ${weightingLabel(weights.mode)}`
            : undefined;
  const coverageHint = !withBlocks
    ? 'nenhum pacote tem blocos ainda'
    : missing
      ? `faltam ${missing}: o IDP segue pelo peso por duração`
      : weights.fallback === 'zero'
        ? 'todos com custo, mas a soma é zero: o IDP segue pelo peso por duração'
        : 'o IDP usa o peso por custo';

  return (
    <section aria-label="Custos" className="space-y-4">
      {header}

      {costAccess === 'unavailable' && (
        <Callout tone="warning" role="status">
          A apropriação de custos ainda não foi ativada no banco: aplique a migração 0044 (
          <code className="text-xs">supabase/migrations/0044_lob_costs.sql</code>) e recarregue a página.
        </Callout>
      )}
      {masked && <Callout tone="info">Seu acesso é de consulta: você vê o peso de cada pacote em %, sem os valores em reais.</Callout>}
      {costAccess === 'full' && readOnly && actor && (
        <Callout tone="info">Seu acesso é de consulta: os custos aparecem aqui, mas não podem ser alterados.</Callout>
      )}

      {/* Resumo */}
      <div data-tour="longo-custos-resumo" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={`Custo apropriado${pending}`}
          value={masked ? '—' : formatMoney(weights.totalCost)}
          hint={
            masked
              ? 'os valores em R$ ficam com quem edita os custos'
              : noBlocksCost > 0
                ? `nos pacotes com blocos · mais ${formatMoney(noBlocksCost)} em pacotes sem blocos`
                : 'soma dos pacotes com blocos'
          }
        />
        <StatCard
          label={`Pacotes com custo${pending}`}
          value={withBlocks ? `${withBlocks - missing} de ${withBlocks}` : '—'}
          tone={missing ? 'warning' : 'default'}
          hint={coverageHint}
        />
        <StatCard
          label={`Não apropriado${pending}`}
          value={unassigned.length ? (masked ? pct(unassignedTotal) : formatMoney(unassignedTotal)) : '—'}
          hint={
            unassigned.length
              ? `${masked ? 'do total · ' : ''}${plural(unassigned.length, 'item sem pacote', 'itens sem pacote')}`
              : 'todos os itens estão em pacotes'
          }
        />
        <StatCard
          label={`IDP${pending}`}
          value={
            idpValue !== undefined && tone ? (
              <span className="inline-flex flex-wrap items-center gap-2">
                {formatIdp(idpValue)}
                <Pill tone={PILL_TONE[tone]}>{IDP_TONE_LABEL[tone]}</Pill>
              </span>
            ) : (
              '—'
            )
          }
          tone={tone ? CARD_TONE[tone] : 'default'}
          hint={idpHint}
        />
      </div>

      {missing > 0 && editable && (
        <Callout tone="warning" role="status">
          {plural(missing, 'pacote com blocos está', 'pacotes com blocos estão')} sem custo: enquanto faltar algum, o avanço físico e o IDP
          seguem pelo peso por duração.{' '}
          <button type="button" className="text-link" onClick={goToMissing}>
            Ir para o primeiro
          </button>
        </Callout>
      )}

      {suggesting && (
        <Callout tone="info" role="status">
          A Claudia está lendo os itens não apropriados: lote {suggesting.batch} de {suggesting.batches} (
          {suggesting.done.toLocaleString('pt-BR')} de {plural(suggesting.total, 'item', 'itens')} prontos). Cada lote pode levar cerca de
          um minuto.{' '}
          {suggesting.batch < suggesting.batches &&
            (cancelling ? (
              <span className="font-semibold">Ela para ao fim deste lote.</span>
            ) : (
              <button
                type="button"
                className="text-link"
                onClick={() => {
                  cancelRef.current = true;
                  setCancelling(true);
                }}
              >
                Cancelar os próximos lotes
              </button>
            ))}
        </Callout>
      )}
      {suggestionRun && !suggesting && (
        <Callout tone={suggestionRun.linked ? 'info' : 'warning'} role="status">
          A Claudia sugeriu pacote para {suggestionRun.linked.toLocaleString('pt-BR')} de {plural(suggestionRun.asked, 'item', 'itens')};{' '}
          {suggestionRun.unlinked === 1 ? '1 ficou' : `${suggestionRun.unlinked.toLocaleString('pt-BR')} ficaram`} sem pacote. Confira antes
          de salvar.
          {suggestionRun.lowConfidence > 0 &&
            ` ${plural(suggestionRun.lowConfidence, 'sugestão tem', 'sugestões têm')} o selo “confira”: ela ficou em dúvida.`}
          {suggestionRun.stopped === 'cancel' && ' Você cancelou antes do fim.'}
          {suggestionRun.stopped === 'error' && ' Ela parou antes do fim por causa de um erro.'}
          {suggestionRun.left > 0 &&
            ` ${plural(suggestionRun.left, 'item não foi lido', 'itens não foram lidos')}: clique em “Sugerir com a Claudia” de novo para continuar.`}{' '}
          {live.size > 0 && (
            <button type="button" className="text-link" disabled={saving} onClick={undoAll}>
              Desfazer sugestões
            </button>
          )}
        </Callout>
      )}

      <fieldset disabled={saving} className="m-0 min-w-0 space-y-4 border-0 p-0">
        <legend className="sr-only">Apropriação dos custos</legend>
        {editable && suggested.length > 0 && (
          <SuggestionsPanel
            rows={suggested}
            services={services}
            money={money}
            onMove={(id, serviceId) => {
              unmark([id]);
              edit(current => moveItems(current, [id], serviceId));
            }}
            onUndo={undoAll}
          />
        )}
        {/* Itens ao lado da tabela só em tela bem larga (2xl): abaixo disso a tabela de 9 colunas não
            caberia ao lado do painel e rolaria de lado. */}
        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 2xl:grid-cols-[minmax(0,1fr)_22rem]">
          <PackagesTable
            services={services}
            rowById={rowById}
            performance={performance}
            selectedId={selected?.id}
            editable={editable}
            masked={masked}
            money={money}
            onSelect={setSelectedId}
            onShowItems={showItems}
            onAmount={setAmount}
            onColumnPaste={pasteColumn}
          />
          {selected && (
            <ItemsPanel
              key={selected.id}
              service={selected}
              services={services}
              items={itemsOf(costs, selected.id)}
              hasBlocks={!!rowById.get(selected.id)?.blocks}
              editable={editable}
              money={money}
              marks={live}
              onUpdate={(id, patch) => {
                unmark([id]);
                edit(current => updateItem(current, id, patch));
              }}
              onMove={(id, serviceId) => {
                unmark([id]);
                edit(current => moveItems(current, [id], serviceId));
              }}
              onRemove={id => edit(current => removeItems(current, [id]))}
              onAdd={fields => edit(current => addItems(current, [{ ...fields, serviceId: selected.id }], draftContext()))}
            />
          )}
        </div>

        {unassigned.length > 0 && (
          <UnassignedPanel
            items={unassigned}
            services={services}
            total={unassignedTotal}
            editable={editable}
            masked={masked}
            money={money}
            onMove={(ids, serviceId) => edit(current => moveItems(current, ids, serviceId))}
            onRemove={ids => edit(current => removeItems(current, ids))}
          />
        )}
      </fieldset>

      {dirty && (
        <div
          role="region"
          aria-label="Alterações não salvas"
          // Botões à esquerda: os avisos (toasts) aparecem no canto inferior direito e cobririam o Salvar.
          className="sticky bottom-3 z-20 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-primary-ring bg-white/95 px-4 py-3 shadow-lg backdrop-blur"
        >
          <p className="text-sm font-semibold text-slate-800" aria-live="polite">
            {plural(changes, 'alteração não salva', 'alterações não salvas')}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="button" disabled={saving || costAccess !== 'full' || readOnly} onClick={save}>
              {saving ? 'Salvando…' : 'Salvar'}
            </button>
            <button type="button" className="button-ghost" disabled={saving} onClick={discard}>
              Descartar
            </button>
          </div>
        </div>
      )}

      {importing && (
        <CostsImportDialog
          services={services}
          currentCount={costs.length}
          onImport={(lines, replace) => {
            edit(current => importBudget(current, lines, replace, draftContext()));
            if (replace) clearSuggestions();
            const recognized = lines.filter(l => l.serviceId).length;
            toast({
              title: `${plural(lines.length, 'linha entrou', 'linhas entraram')} na tela`,
              description: `${plural(recognized, 'com pacote reconhecido', 'com pacote reconhecido')}${
                lines.length - recognized ? `, ${plural(lines.length - recognized, 'não apropriada', 'não apropriadas')}` : ''
              }. Confira e clique em Salvar para gravar.`,
              tone: 'info',
            });
          }}
          onClose={() => setImporting(false)}
        />
      )}
      {fetchingSienge && (
        <CostsSiengeDialog
          workId={workId}
          draft={costs}
          onImport={(lines, sheetIds) => {
            const context = draftContext();
            const { summary } = mergeSiengeBudget(costsRef.current, lines, sheetIds, context);
            edit(current => mergeSiengeBudget(current, lines, sheetIds, context).draft);
            toast({
              title: `Orçamento do Sienge na tela: ${plural(lines.length, 'linha', 'linhas')}`,
              description: `${plural(summary.added, 'nova', 'novas')}, ${plural(summary.updated, 'atualizada', 'atualizadas')}${
                summary.removed ? `, ${plural(summary.removed, 'item saiu', 'itens saíram')}` : ''
              }. Confira e clique em Salvar para gravar.`,
              tone: 'info',
            });
          }}
          onClose={() => setFetchingSienge(false)}
        />
      )}
    </section>
  );
}

// ─── Tabela dos pacotes ─────────────────────────────────────────────────────────

function PackagesTable({
  services,
  rowById,
  performance,
  selectedId,
  editable,
  masked,
  money,
  onSelect,
  onShowItems,
  onAmount,
  onColumnPaste,
}: {
  services: LobService[];
  rowById: Map<LobId, LobServicePerformance>;
  performance: LobPerformance;
  selectedId?: LobId;
  editable: boolean;
  masked: boolean;
  money: (value: number) => string;
  onSelect: (id: LobId) => void;
  /** Clique no nome: seleciona e, com o painel abaixo da tabela, rola até os itens. */
  onShowItems: (id: LobId) => void;
  onAmount: (serviceId: LobId, amount: number | null) => void;
  onColumnPaste: (startId: LobId, text: string) => void;
}) {
  const byDuration = performance.weights.mode === 'duration';
  const weightTitle = byDuration
    ? performance.weights.fallback === 'zero'
      ? 'Peso pela duração: todos os pacotes têm custo, mas a soma é zero.'
      : 'Peso pela duração: enquanto algum pacote com blocos estiver sem custo, a fatia de cada pacote segue a duração dos blocos dele.'
    : 'Fatia do pacote no peso por custo da obra.';
  const th = 'px-2.5 py-2.5 text-[11px] font-bold tracking-wider whitespace-nowrap text-brand-800 uppercase first:pl-4 last:pr-4';
  const td = 'px-2.5 py-2 align-middle first:pl-4 last:pr-4';
  return (
    <section data-tour="longo-custos-pacotes" aria-labelledby="custos-pacotes-titulo" className="panel min-w-0">
      <div className="border-b border-slate-100 px-4 py-3">
        <h3 id="custos-pacotes-titulo" className="text-sm font-bold text-slate-900">
          Pacotes de serviço
        </h3>
        <p className="mt-0.5 text-xs text-slate-500">
          {editable
            ? 'Na ordem da obra. Digite o custo na linha do pacote ou abra os itens ao lado. Cole uma coluna do Excel num campo de custo para preencher este pacote e os seguintes.'
            : 'Na ordem da obra. Clique num pacote para ver os itens dele.'}
        </p>
      </div>
      <div className="custom-scrollbar overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-brand-100 bg-brand-50">
            <tr>
              {/* A coluna do pacote fica presa à esquerda quando a tabela rola de lado (celular). */}
              <th scope="col" className={`${th} sticky left-0 z-[1] bg-brand-50`}>
                Pacote
              </th>
              <th scope="col" className={`${th} text-right`}>
                Blocos
              </th>
              <th scope="col" className={`${th} text-right`}>
                Dias úteis
              </th>
              <th scope="col" className={`${th} text-right`}>
                Itens
              </th>
              <th scope="col" className={`${th} text-right`}>
                {masked ? 'Custo (% do total)' : 'Custo (R$)'}
              </th>
              <th scope="col" className={`${th} text-right`} title={weightTitle}>
                Peso
              </th>
              <th scope="col" className={`${th} text-right`}>
                Real
              </th>
              <th scope="col" className={`${th} text-right`}>
                Planejado
              </th>
              <th scope="col" className={`${th} text-right`}>
                IDP
              </th>
            </tr>
          </thead>
          <tbody>
            {services.map(service => {
              const row = rowById.get(service.id);
              const blocks = row?.blocks ?? 0;
              const items = row?.itemCount ?? 0;
              const on = service.id === selectedId;
              const muted = !blocks;
              const tone = row?.idp !== undefined ? idpTone(row.idp) : undefined;
              return (
                <tr
                  key={service.id}
                  id={`custo-pacote-${service.id}`}
                  onClick={() => onSelect(service.id)}
                  className={`group cursor-pointer border-t border-slate-100 transition-colors ${on ? 'bg-primary-soft' : 'hover:bg-brand-50'} ${muted ? 'text-slate-400' : 'text-slate-700'}`}
                >
                  <th
                    scope="row"
                    className={`${td} sticky left-0 z-[1] min-w-44 font-semibold transition-colors ${on ? 'bg-primary-soft' : 'bg-white group-hover:bg-brand-50'}`}
                  >
                    <button
                      type="button"
                      aria-pressed={on}
                      aria-label={`Ver os itens de ${service.name}`}
                      className={`flex items-center gap-2 text-left ${muted ? 'text-slate-500' : 'text-slate-900'} hover:text-primary`}
                      onClick={event => {
                        event.stopPropagation();
                        onShowItems(service.id);
                      }}
                    >
                      <Dot color={service.color} />
                      <span className="break-words">{service.name}</span>
                    </button>
                    {muted && (
                      <span className="mt-0.5 block pl-[1.125rem] text-[11px] font-normal">sem blocos: o custo não entra no IDP</span>
                    )}
                  </th>
                  <td className={`${td} text-right tabular-nums`}>{blocks}</td>
                  <td className={`${td} text-right tabular-nums`}>{row?.days ?? 0}</td>
                  <td className={`${td} text-right tabular-nums`}>{items}</td>
                  <td className={`${td} min-w-36 text-right tabular-nums`}>
                    {editable && items <= 1 ? (
                      <MoneyField
                        value={row?.cost}
                        allowEmpty
                        placeholder="sem custo"
                        warn={!muted}
                        ariaLabel={`Custo de ${service.name}, em reais`}
                        onCommit={amount => onAmount(service.id, amount)}
                        onColumnPaste={text => onColumnPaste(service.id, text)}
                      />
                    ) : row?.cost !== undefined ? (
                      <span className="whitespace-nowrap">
                        <span className={muted ? '' : 'text-slate-900'}>{money(row.cost)}</span>
                        {items > 1 && <span className="block text-[11px] text-slate-400">{items} itens</span>}
                      </span>
                    ) : (
                      <span className={muted ? '' : 'font-semibold text-warning'}>sem custo</span>
                    )}
                  </td>
                  <td
                    className={`${td} text-right tabular-nums ${byDuration ? 'text-slate-400' : ''}`}
                    title={row?.share !== undefined ? weightTitle : undefined}
                  >
                    {row?.share !== undefined ? pct(row.share) : '—'}
                  </td>
                  <td className={`${td} text-right tabular-nums`}>{row?.real !== undefined ? pct(row.real) : '—'}</td>
                  <td className={`${td} text-right tabular-nums`}>{row?.planned !== undefined ? pct(row.planned) : '—'}</td>
                  <td className={`${td} text-right`}>
                    {row?.idp !== undefined && tone ? (
                      <Pill tone={PILL_TONE[tone]}>
                        <span title={IDP_TONE_LABEL[tone]}>{formatIdp(row.idp)}</span>
                      </Pill>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ─── Itens do pacote selecionado ────────────────────────────────────────────────

function ItemsPanel({
  service,
  services,
  items,
  hasBlocks,
  marks,
  editable,
  money,
  onUpdate,
  onMove,
  onRemove,
  onAdd,
}: {
  service: LobService;
  services: LobService[];
  items: DraftCost[];
  hasBlocks: boolean;
  /** Itens deste pacote que vieram de sugestão da Claudia e ainda não foram conferidos. */
  marks: SuggestionMarks;
  editable: boolean;
  money: (value: number) => string;
  onUpdate: (id: LobId, patch: { code?: string; description?: string; amount?: number }) => void;
  onMove: (id: LobId, serviceId: LobId | null) => void;
  onRemove: (id: LobId) => void;
  onAdd: (fields: { code?: string; description: string; amount: number }) => void;
}) {
  const [limit, setLimit] = useState(PAGE);
  const [form, setForm] = useState({ code: '', description: '', amount: '' });
  const [formError, setFormError] = useState<string>();
  const descriptionInput = useRef<HTMLInputElement>(null);
  const total = items.reduce((sum, item) => sum + item.amount, 0);
  const others = services.filter(s => s.id !== service.id);

  const add = (event: FormEvent) => {
    event.preventDefault();
    const description = form.description.replace(/\s+/g, ' ').trim();
    if (!description) return setFormError('Informe a descrição do item.');
    const read = readAmount(form.amount);
    if (read.kind === 'empty') return setFormError('Informe o valor do item.');
    if (read.kind === 'invalid') return setFormError(read.reason);
    onAdd({ code: form.code, description, amount: read.amount });
    setForm({ code: '', description: '', amount: '' });
    setFormError(undefined);
    descriptionInput.current?.focus();
  };

  return (
    <aside
      data-tour="longo-custos-itens"
      aria-labelledby="custos-itens-titulo"
      id="custos-itens"
      className="panel custom-scrollbar flex min-w-0 scroll-mt-4 flex-col 2xl:sticky 2xl:top-4 2xl:max-h-[calc(100vh-6rem)] 2xl:overflow-y-auto"
    >
      <div className="border-b border-slate-100 px-4 py-3">
        <p className="eyebrow">Itens do pacote</p>
        <h3 id="custos-itens-titulo" className="mt-1 flex items-center gap-2 text-sm font-bold text-slate-900">
          <Dot color={service.color} />
          <span className="break-words">{service.name}</span>
        </h3>
        {!hasBlocks && <p className="mt-0.5 text-xs text-slate-500">Sem blocos: o custo deste pacote não entra no IDP.</p>}
      </div>

      <div className="flex-1 px-4 py-3">
        {!items.length ? (
          <p className="text-sm text-slate-500">
            Sem itens: o pacote está sem custo.
            {editable && ' Digite o valor na linha do pacote ou adicione itens abaixo.'}
          </p>
        ) : (
          <ul className="space-y-2" aria-label={`Itens de ${service.name}`}>
            {items.slice(0, limit).map(item => (
              <li key={item.id} className="rounded-lg border border-slate-200 p-2">
                {editable ? (
                  <div className="space-y-1.5">
                    {marks.has(item.id) && <SuggestionBadge confidence={marks.get(item.id)!.confidence} />}
                    <div className="flex gap-1.5">
                      <CommitField
                        value={item.code ?? ''}
                        placeholder="Código"
                        ariaLabel={`Código do item ${item.description}`}
                        className="field w-24 shrink-0 py-1 text-xs tabular-nums"
                        onCommit={code => onUpdate(item.id, { code: code.slice(0, LOB_LIMITS.costCode) })}
                      />
                      <CommitField
                        value={item.description}
                        placeholder="Descrição"
                        ariaLabel={`Descrição do item ${item.description}`}
                        className="field min-w-0 flex-1 py-1 text-sm"
                        onCommit={description => {
                          // Descrição vazia não vale: o campo volta ao texto anterior.
                          if (description.trim()) onUpdate(item.id, { description });
                        }}
                      />
                    </div>
                    <div className="flex items-start gap-1.5">
                      <MoneyField
                        value={item.amount}
                        ariaLabel={`Valor do item ${item.description}, em reais`}
                        className="w-36 shrink-0"
                        onCommit={amount => amount !== null && onUpdate(item.id, { amount })}
                      />
                      <select
                        className="field min-w-0 flex-1 py-1 text-xs"
                        aria-label={`Mover ${item.description} para outro pacote`}
                        value=""
                        onChange={event => {
                          const target = event.target.value;
                          if (target) onMove(item.id, target === NONE ? null : target);
                        }}
                      >
                        <option value="">Mover para…</option>
                        {others.map(s => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                        <option value={NONE}>Não apropriado</option>
                      </select>
                      <button
                        type="button"
                        className="button-ghost shrink-0 p-1.5 hover:text-danger"
                        aria-label={`Excluir o item ${item.description}`}
                        title="Excluir item"
                        onClick={() => onRemove(item.id)}
                      >
                        <Trash2 size={14} aria-hidden />
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-3 text-sm">
                    <span className="min-w-0">
                      {item.code && <span className="mr-1.5 text-xs text-slate-400 tabular-nums">{item.code}</span>}
                      <span className="break-words text-slate-800">{item.description}</span>
                    </span>
                    <span className="shrink-0 text-slate-700 tabular-nums">{money(item.amount)}</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {items.length > limit && (
          <button type="button" className="text-link mt-2 text-sm" onClick={() => setLimit(l => l + PAGE)}>
            Mostrar mais {Math.min(PAGE, items.length - limit)} de {items.length.toLocaleString('pt-BR')}
          </button>
        )}

        {editable && (
          <form className="mt-3 space-y-1.5 rounded-lg border border-dashed border-slate-300 p-2" onSubmit={add} noValidate>
            <p className="text-xs font-semibold text-slate-600">Adicionar item</p>
            <div className="flex gap-1.5">
              <input
                className="field w-24 shrink-0 py-1 text-xs tabular-nums"
                placeholder="Código"
                aria-label="Código do novo item (opcional)"
                maxLength={LOB_LIMITS.costCode}
                value={form.code}
                onChange={event => setForm(f => ({ ...f, code: event.target.value }))}
              />
              <input
                ref={descriptionInput}
                className="field min-w-0 flex-1 py-1 text-sm"
                placeholder="Descrição"
                aria-label="Descrição do novo item"
                maxLength={LOB_LIMITS.costDescription}
                value={form.description}
                onChange={event => setForm(f => ({ ...f, description: event.target.value }))}
              />
            </div>
            <div className="flex gap-1.5">
              <input
                className={`field w-36 shrink-0 py-1 text-right tabular-nums ${formError && readAmount(form.amount).kind !== 'value' && form.amount ? 'border-danger ring-2 ring-danger-ring' : ''}`}
                inputMode="decimal"
                placeholder="0,00"
                aria-label="Valor do novo item, em reais"
                value={form.amount}
                onChange={event => setForm(f => ({ ...f, amount: event.target.value }))}
              />
              <button type="submit" className="button-ghost flex-1 py-1">
                <Plus size={14} aria-hidden /> Adicionar item
              </button>
            </div>
            {formError && (
              <p role="alert" className="text-[11px] font-semibold text-danger">
                {formError}
              </p>
            )}
          </form>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-sm">
        <span className="font-semibold text-slate-700">Total do pacote</span>
        <span className="font-bold text-slate-900 tabular-nums">{items.length ? money(total) : 'sem custo'}</span>
      </div>
    </aside>
  );
}

// ─── Sugestões da Claudia ───────────────────────────────────────────────────────

/** Revisão das sugestões num lugar só: os itens que a Claudia apontou e ninguém conferiu, com a
 * confiança baixa primeiro. Trocar o pacote aqui (ou mexer no item no painel do pacote) tira o selo. */
function SuggestionsPanel({
  rows,
  services,
  money,
  onMove,
  onUndo,
}: {
  rows: { item: DraftCost; confidence: SuggestionConfidence }[];
  services: LobService[];
  money: (value: number) => string;
  onMove: (id: LobId, serviceId: LobId | null) => void;
  onUndo: () => void;
}) {
  const [limit, setLimit] = useState(PAGE);
  const th = 'px-3 py-2.5 text-[11px] font-bold tracking-wider whitespace-nowrap text-brand-800 uppercase';
  const td = 'px-3 py-2 align-middle';
  return (
    <section aria-labelledby="custos-sugestoes-titulo" className="panel min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <div className="min-w-0">
          <h3 id="custos-sugestoes-titulo" className="flex items-center gap-2 text-sm font-bold text-slate-900">
            <Sparkles size={15} aria-hidden className="text-primary" />
            Sugestões da Claudia
          </h3>
          <p className="mt-0.5 text-xs text-slate-500">
            {plural(rows.length, 'item com pacote sugerido', 'itens com pacote sugerido')}, ainda não salvos; os marcados com “confira” vêm
            primeiro. Se o pacote estiver errado, troque aqui. O selo sai quando você mexe no item ou salva.
          </p>
        </div>
        <button type="button" className="button-ghost py-1" onClick={onUndo}>
          <Undo2 size={14} aria-hidden /> Desfazer sugestões
        </button>
      </div>
      <div className="custom-scrollbar overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-brand-100 bg-brand-50">
            <tr>
              <th scope="col" className={th}>
                Código
              </th>
              <th scope="col" className={th}>
                Descrição
              </th>
              <th scope="col" className={`${th} text-right`}>
                Valor
              </th>
              <th scope="col" className={th}>
                Pacote sugerido
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, limit).map(({ item, confidence }) => (
              <tr key={item.id} className="border-t border-slate-100 text-slate-700 hover:bg-brand-50/60">
                <td className={`${td} text-xs whitespace-nowrap text-slate-500 tabular-nums`}>{item.code ?? '—'}</td>
                <td className={`${td} min-w-56 text-slate-800`}>
                  {item.description}
                  {confidence === 'baixa' && (
                    <span className="ml-2 rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-semibold text-warning">confira</span>
                  )}
                </td>
                <td className={`${td} text-right whitespace-nowrap tabular-nums`}>{money(item.amount)}</td>
                <td className={`${td} min-w-48`}>
                  <select
                    className="field py-1 text-xs"
                    aria-label={`Pacote sugerido para ${item.description}`}
                    value={item.serviceId ?? NONE}
                    onChange={event => onMove(item.id, event.target.value === NONE ? null : event.target.value)}
                  >
                    {services.map(s => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                    <option value={NONE}>Não apropriado</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > limit && (
        <div className="border-t border-slate-100 px-4 py-2.5">
          <button type="button" className="text-link text-sm" onClick={() => setLimit(l => l + PAGE)}>
            Mostrar mais {Math.min(PAGE, rows.length - limit)} de {rows.length.toLocaleString('pt-BR')}
          </button>
        </div>
      )}
    </section>
  );
}

// ─── Não apropriados ────────────────────────────────────────────────────────────

function UnassignedPanel({
  items,
  services,
  total,
  editable,
  masked,
  money,
  onMove,
  onRemove,
}: {
  items: DraftCost[];
  services: LobService[];
  total: number;
  editable: boolean;
  masked: boolean;
  money: (value: number) => string;
  onMove: (ids: LobId[], serviceId: LobId | null) => void;
  onRemove: (ids: LobId[]) => void;
}) {
  const [checked, setChecked] = useState<ReadonlySet<LobId>>(() => new Set());
  const [target, setTarget] = useState('');
  const [limit, setLimit] = useState(PAGE);
  // Só valem as marcas de itens que continuam aqui (os apropriados saem da lista).
  const selected = items.filter(item => checked.has(item.id)).map(item => item.id);
  const allChecked = selected.length === items.length;
  const toggle = (id: LobId) =>
    setChecked(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const th = 'px-3 py-2.5 text-[11px] font-bold tracking-wider whitespace-nowrap text-brand-800 uppercase';
  const td = 'px-3 py-2 align-middle';

  return (
    <section data-tour="longo-custos-nao-apropriados" aria-labelledby="custos-nao-apropriados-titulo" className="panel min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <div>
          <h3 id="custos-nao-apropriados-titulo" className="text-sm font-bold text-slate-900">
            Não apropriados
          </h3>
          <p className="mt-0.5 text-xs text-slate-500 tabular-nums">
            {plural(items.length, 'item sem pacote', 'itens sem pacote')} · {money(total)}. Eles não entram no peso até serem apontados a um
            pacote.
          </p>
        </div>
      </div>

      {editable && selected.length > 0 && (
        <div
          role="region"
          aria-label="Itens marcados"
          className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-primary-soft/60 px-4 py-2.5 text-sm"
        >
          <label htmlFor="custos-lote-pacote" className="font-semibold text-slate-800">
            Apropriar {plural(selected.length, 'selecionado', 'selecionados')} em
          </label>
          <select
            id="custos-lote-pacote"
            className="field w-auto max-w-full py-1"
            value={target}
            onChange={event => setTarget(event.target.value)}
          >
            <option value="">Escolha o pacote</option>
            {services.map(s => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="button py-1"
            disabled={!target}
            onClick={() => {
              onMove(selected, target);
              setChecked(new Set());
            }}
          >
            Apropriar
          </button>
          <button
            type="button"
            className="button-ghost py-1 hover:text-danger"
            onClick={() => {
              onRemove(selected);
              setChecked(new Set());
            }}
          >
            <Trash2 size={14} aria-hidden /> Excluir selecionados
          </button>
        </div>
      )}

      <div className="custom-scrollbar overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-brand-100 bg-brand-50">
            <tr>
              {editable && (
                <th scope="col" className={`${th} w-10`}>
                  <input
                    type="checkbox"
                    className="accent-primary"
                    aria-label={`Selecionar todos os ${items.length} itens não apropriados`}
                    checked={allChecked}
                    onChange={() => setChecked(allChecked ? new Set() : new Set(items.map(item => item.id)))}
                  />
                </th>
              )}
              <th scope="col" className={th}>
                Código
              </th>
              <th scope="col" className={th}>
                Descrição
              </th>
              <th scope="col" className={`${th} text-right`}>
                {masked ? 'Valor (% do total)' : 'Valor'}
              </th>
              {editable && (
                <th scope="col" className={th}>
                  Pacote
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {items.slice(0, limit).map(item => (
              <tr key={item.id} className="border-t border-slate-100 text-slate-700 hover:bg-brand-50/60">
                {editable && (
                  <td className={td}>
                    <input
                      type="checkbox"
                      className="accent-primary"
                      aria-label={`Selecionar ${item.description}`}
                      checked={checked.has(item.id)}
                      onChange={() => toggle(item.id)}
                    />
                  </td>
                )}
                <td className={`${td} text-xs whitespace-nowrap text-slate-500 tabular-nums`}>{item.code ?? '—'}</td>
                <td className={`${td} min-w-56 text-slate-800`}>{item.description}</td>
                <td className={`${td} text-right whitespace-nowrap tabular-nums`}>{money(item.amount)}</td>
                {editable && (
                  <td className={`${td} min-w-48`}>
                    <select
                      className="field py-1 text-xs"
                      aria-label={`Pacote de ${item.description}`}
                      value=""
                      onChange={event => event.target.value && onMove([item.id], event.target.value)}
                    >
                      <option value="">Não apropriado</option>
                      {services.map(s => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {items.length > limit && (
        <div className="border-t border-slate-100 px-4 py-2.5">
          <button type="button" className="text-link text-sm" onClick={() => setLimit(l => l + PAGE)}>
            Mostrar mais {Math.min(PAGE, items.length - limit)} de {items.length.toLocaleString('pt-BR')}
          </button>
        </div>
      )}
    </section>
  );
}

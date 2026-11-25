'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Building2,
  CalendarDays,
  Check,
  ChevronDown,
  Coins,
  Download,
  Flag,
  History,
  LoaderCircle,
  Lock,
  LockOpen,
  Minus,
  MoreHorizontal,
  Plus,
  Ruler,
  Search,
  Table2,
  TriangleAlert,
  Undo2,
  Upload,
  Waypoints,
} from 'lucide-react';
import {
  activityFinish,
  baselineFinishDate,
  closedMeasurements,
  delayDays,
  isLate,
  lobSpan,
  measuredPercents,
  normalizeName,
  plannedPercent,
  workdayDelta,
  type LobActivity,
  type LobCalendar,
  type LobCommand,
  type LobDependency,
  type LobLinkRevert,
  type LobPackageEdit,
  type LocalDate,
} from '@/domain/lob';
import { isStartedActivity, planPackageMove, type PackageMoveResult } from '@/domain/lob-package';
import { isDefaultLobCalendar, lobCalendarLabel } from '@/domain/lob-calendar';
import {
  formatIdp,
  IDP_TONE_LABEL,
  idpTone,
  lobPerformance,
  performanceBaseline,
  weightedProgress,
  weightingLabel,
  type IdpTone,
  type LobPerformance,
} from '@/domain/lob-performance';
import { lobCriticalPath } from '@/domain/lob-critical';
import { addDays, isLocalDate } from '@/domain/long-term-plan';
import { isLobScheduleCommand } from '@/application/use-cases/lob-commands';
import { useDeveloper, useModules, usePlanning } from '@/modules/planejamento/planning-provider';
import { hasSectionAccess } from '@/application/module-access';
import { CreatePendingDialog, type PendingSource } from '@/modules/pendencias/create-pending-dialog';
import { Callout, LoadState, StatCard } from '@/modules/planejamento/ui';
import { useConfirm } from '@/modules/layout/confirm';
import { useToast } from '@/modules/layout/toast';
import { HelpNote } from '@/modules/layout/help-note';
import { formatDate, workPath } from '@/shared/format';
import { useLob, type LobDateChange, type LobFullResult, type LobSync } from './lob-api';
import { LobChart, type LobZoom } from './lob-chart';
import { CRITICAL_COLOR, ZOOM_SCALE_MAX, ZOOM_SCALE_MIN, ZOOM_SCALE_STEP, signedWorkdays } from './lob-model';
import { LobTable } from './lob-table';
import { LobActivityPanel } from './lob-activity-panel';
import { useServiceRestrictions } from './service-restrictions';
import { LobLocalsPanel } from './lob-locals-panel';
import { LobLaunchDialog } from './lob-launch-dialog';
import { LobBaselinesPanel } from './lob-baselines-panel';
import { LobCalendarDialog } from './lob-calendar-dialog';
import { LobPackageDialog } from './lob-package-dialog';
import { LobHistoryPanel } from './lob-history-panel';
import { Pill } from './measurement-sheet';

/** Visão "Linha de Balanço" da aba 1 (modelo aprovado em 04/11/2026, tela 1): barra de ferramentas,
 * cinco indicadores (o quinto, o IDP, desde 11/11/2026), o painel da atividade selecionada e, abaixo dele,
 * o gráfico (ou tabela) com legenda.
 * Os dados vêm de `useLob`; toda alteração é um comando ao servidor. Os de datas (mover, esticar,
 * desfazer) aparecem NA HORA, calculados aqui com a mesma regra do servidor, e gravam em segundo
 * plano, em fila (23/11/2026); os demais esperam a obra inteira de volta. "Desfazer" guarda, por
 * comando, as datas que ele mudou e as devolve numa gravação só; vale na sessão (regra 16).
 *
 * Pacote inteiro (25/11/2026, pedido do Jorge Lucas; modelo aprovado no mesmo dia): a chave "Arrastar:
 * Pacote | Bloco" escolhe se o arrasto e as setas movem o serviço em todos os locais (`move_service`) ou
 * só o bloco; "Editar o pacote" (no painel do bloco) abre a janela da edição em massa (`edit_service`),
 * cujo "Desfazer" devolve também as ligações (`revert_service_edit`); "Histórico" lista as gravações. */

type Period = 'all' | '3m' | '6m' | 'custom';
type Panel = 'locals' | 'baselines' | 'launch' | 'late' | 'calendar' | 'history';
/** O que um comando alterou, para "Desfazer" devolver: as datas de antes dos blocos e, na edição do
 * pacote (regra 11 do modelo de 25/11/2026), as ligações a devolver. Com ligações, o desfazer vai ao
 * servidor por `revert_service_edit`; sem, só as datas, na hora, por `set_activity_dates`. */
type UndoEntry = { dates: LobDateChange[]; links?: LobLinkRevert };
const UNDO_DEPTH = 50;
/** As ligações que "Desfazer" precisa devolver depois de um comando: as criadas saem, as retiradas
 * voltam com todos os campos (inclusive a data de criação) e as de espera mudada voltam à de antes. */
function linkRevert(before: LobDependency[], after: LobDependency[]): LobLinkRevert {
  const now = new Map(after.map(d => [d.id, d]));
  const old = new Set(before.map(d => d.id));
  return {
    remove: after.filter(d => !old.has(d.id)).map(d => d.id),
    restore: before
      .filter(d => !now.has(d.id))
      .map(d => ({
        id: d.id,
        predecessorId: d.predecessorId,
        successorId: d.successorId,
        lagDays: d.lagDays,
        kind: d.kind,
        createdAt: d.createdAt,
      })),
    update: before
      .filter(d => now.has(d.id) && now.get(d.id)!.lagDays !== d.lagDays)
      .map(d => ({ dependencyId: d.id, lagDays: d.lagDays })),
  };
}
/** Os números que o servidor espalha na resposta de "Editar o pacote". */
type PackageEditResult = LobFullResult & {
  pushed?: number;
  kept?: number;
  linksAdded?: number;
  linksRemoved?: number;
  linksUpdated?: number;
};
const ZOOMS: { id: LobZoom; label: string }[] = [
  { id: 'semana', label: 'Semana' },
  { id: 'mes', label: 'Mês' },
  { id: 'trimestre', label: 'Trimestre' },
  { id: 'obra', label: 'Obra inteira' },
];
/** Trava das datas (16/11/2026): guardada por navegador; sem nada guardado, a tela abre travada. */
const LOCK_KEY = 'obra360.lob.datas-travadas';
const readLock = () => {
  try {
    return window.localStorage.getItem(LOCK_KEY) !== '0';
  } catch {
    return true;
  }
};
/** O que o arrasto move (25/11/2026): o pacote inteiro (padrão) ou só o bloco. Guardado por pessoa
 * neste navegador. */
type DragMode = 'package' | 'block';
const DRAG_MODES: { id: DragMode; label: string; title: string }[] = [
  {
    id: 'package',
    label: 'Pacote',
    title: 'Arrastar um bloco (ou as setas) move todos os blocos do mesmo serviço juntos. Alt + arrastar move só o bloco.',
  },
  { id: 'block', label: 'Bloco', title: 'Arrastar (ou as setas) move só o bloco; as sucessoras se deslocam quando preciso.' },
];
const dragKey = (actorId: string) => `obra360.lob.arrasto:${actorId}`;
const readDragMode = (actorId: string): DragMode => {
  try {
    return window.localStorage.getItem(dragKey(actorId)) === 'bloco' ? 'block' : 'package';
  } catch {
    return 'package';
  }
};

const pct = (value: number) => `${value.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
/** "11/11". */
const dayMonth = (date: LocalDate) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** O resumo do pacote movido (regra 5), com a mesma conta do servidor. */
const packageMoveSummary = (result: PackageMoveResult) =>
  `${plural(result.moved.length, 'bloco do pacote andou', 'blocos do pacote andaram')} ${plural(Math.abs(result.applied), 'dia útil', 'dias úteis')} ` +
  `${result.applied > 0 ? 'para a frente' : 'para trás'}; ` +
  `${result.pushed ? plural(result.pushed, 'sucessora empurrada', 'sucessoras empurradas') : 'nenhuma sucessora empurrada'}.` +
  (result.kept.length ? ` ${plural(result.kept.length, 'bloco já iniciado ficou', 'blocos já iniciados ficaram')}.` : '') +
  (result.slack.count
    ? ` ${plural(result.slack.count, 'sucessora ficou', 'sucessoras ficaram')} com folga de até ${plural(result.slack.maxDays, 'dia útil', 'dias úteis')} (não são puxadas).`
    : '');
const errorMessage = (error: unknown) => (error instanceof Error && error.message ? error.message : 'Falha na comunicação com o servidor.');
/** Atalho de teclado só vale fora de campos de texto. */
const isTyping = (target: EventTarget | null) => {
  const element = target as HTMLElement | null;
  if (!element || !element.tagName) return false;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable;
};

export function LobView({ workId }: { workId: string }) {
  // `useSearchParams` pede uma fronteira de Suspense para a página não travar a pré-renderização.
  return (
    <Suspense fallback={<LoadState />}>
      <LobViewInner workId={workId} />
    </Suspense>
  );
}

// ─── Peças da barra de ferramentas ──────────────────────────────────────────────

/** Botão que abre um painel flutuante; fecha com Esc, clique fora ou quando um item pede. */
function Popover({
  label,
  ariaLabel,
  tourId,
  align = 'start',
  children,
}: {
  label: ReactNode;
  ariaLabel?: string;
  tourId?: string;
  align?: 'start' | 'end';
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // Lado para o qual o painel abre. A barra quebra em várias linhas, e um botão alinhado à direita
  // pode cair no começo da linha: aberto para a esquerda, o painel sumia atrás do menu lateral
  // (retorno do Atmos, 16/11/2026). Ao abrir, mede e troca de lado se não couber.
  const [side, setSide] = useState(align);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || !root.current || !panel.current) return;
    const button = root.current.getBoundingClientRect();
    const width = panel.current.offsetWidth;
    const bounds = root.current.closest('main')?.getBoundingClientRect();
    const min = (bounds?.left ?? 0) + 8;
    const max = Math.min(bounds?.right ?? window.innerWidth, window.innerWidth) - 8;
    const fitsEnd = button.right - width >= min;
    const fitsStart = button.left + width <= max;
    setSide(align === 'end' ? (fitsEnd || !fitsStart ? 'end' : 'start') : fitsStart || !fitsEnd ? 'start' : 'end');
  }, [open, align]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <div ref={root} className="relative" data-tour={tourId}>
      <button
        type="button"
        className="button-ghost"
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={ariaLabel}
        onClick={() => setOpen(o => !o)}
      >
        {label}
        {!ariaLabel && <ChevronDown size={14} aria-hidden className="text-slate-400" />}
      </button>
      {open && (
        <div
          ref={panel}
          className={`absolute z-40 mt-1 w-[min(18rem,calc(100vw-2rem))] rounded-xl border border-slate-200 bg-white p-2 shadow-xl ${side === 'end' ? 'right-0' : 'left-0'}`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/** Lista de marcação para os filtros de serviços e locais. */
function CheckList({
  items,
  isChecked,
  onToggle,
  onAll,
  onNone,
  empty,
}: {
  items: { id: string; label: string; color?: string }[];
  isChecked: (id: string) => boolean;
  onToggle: (id: string) => void;
  onAll: () => void;
  onNone: () => void;
  empty: string;
}) {
  const [query, setQuery] = useState('');
  if (!items.length) return <p className="px-2 py-1.5 text-xs text-slate-500">{empty}</p>;
  const wanted = normalizeName(query);
  const shown = wanted ? items.filter(item => normalizeName(item.label).includes(wanted)) : items;
  return (
    <div>
      {items.length > 8 && (
        <label className="relative mb-1.5 block">
          <span className="sr-only">Buscar na lista</span>
          <Search size={14} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            className="field py-1.5 pl-8 text-sm"
            placeholder="Buscar"
            value={query}
            onChange={event => setQuery(event.target.value)}
          />
        </label>
      )}
      <div className="flex gap-3 px-2 pb-1.5 text-xs">
        <button type="button" className="text-link" onClick={onAll}>
          Todos
        </button>
        <button type="button" className="text-link" onClick={onNone}>
          Nenhum
        </button>
      </div>
      <ul className="custom-scrollbar max-h-64 overflow-y-auto">
        {!shown.length && <li className="px-2 py-1.5 text-xs text-slate-500">Nada encontrado.</li>}
        {shown.map(item => (
          <li key={item.id}>
            <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm text-slate-700 hover:bg-slate-50">
              <input type="checkbox" className="accent-primary" checked={isChecked(item.id)} onChange={() => onToggle(item.id)} />
              {item.color && <span aria-hidden className="h-3 w-3 shrink-0 rounded-sm" style={{ background: item.color }} />}
              <span className="truncate">{item.label}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

const menuItem =
  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';

/** Diálogo "Atrasos": os blocos cujo previsto até hoje passa do medido (regra 14). */
function LateDialog({
  rows,
  onSelect,
  onClose,
}: {
  rows: { id: string; label: string; planned: number; measured: number; delay: number }[];
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby="lob-late-title"
      className="m-auto max-h-[90vh] w-[min(40rem,94vw)] overflow-hidden rounded-2xl border border-slate-200 bg-white p-0 shadow-xl backdrop:bg-slate-900/55"
    >
      <div className="flex max-h-[90vh] flex-col">
        <header className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div>
            <p className="eyebrow">Linha de Balanço</p>
            <h3 id="lob-late-title" className="mt-1 text-base font-bold text-slate-900">
              {plural(rows.length, 'bloco atrasado', 'blocos atrasados')}
            </h3>
            <p className="mt-0.5 text-xs text-slate-500">
              Previsto até hoje acima do medido em 10 pontos ou mais. Clique para ver o bloco.
            </p>
          </div>
          <button type="button" className="button-ghost shrink-0" onClick={() => dialog.current?.close()}>
            Fechar
          </button>
        </header>
        <div className="custom-scrollbar flex-1 overflow-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Serviço · local</th>
                <th className="text-right">Previsto</th>
                <th className="text-right">Medido</th>
                <th className="text-right">Atraso</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.id} className="cursor-pointer" onClick={() => onSelect(row.id)}>
                  <th scope="row" className="font-semibold">
                    <button type="button" className="text-left hover:text-primary">
                      {row.label}
                    </button>
                  </th>
                  <td className="text-right tabular-nums">{row.planned}%</td>
                  <td className="text-right tabular-nums text-danger">{row.measured}%</td>
                  <td className="text-right tabular-nums">{plural(row.delay, 'dia útil', 'dias úteis')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </dialog>
  );
}

/** Indicador discreto da gravação em segundo plano: "Salvando…" enquanto há alteração na fila,
 * "Salvo" por alguns segundos quando ela esvazia, e o aviso quando a última falhou. */
function SaveStatus({ sync }: { sync: LobSync }) {
  const [hidden, setHidden] = useState<LobSync>();
  useEffect(() => {
    if (sync !== 'saved') return;
    const timer = window.setTimeout(() => setHidden('saved'), 3000);
    return () => {
      window.clearTimeout(timer);
      setHidden(undefined);
    };
  }, [sync]);
  const shown = sync === 'idle' || hidden === sync ? undefined : sync;
  return (
    <span role="status" aria-live="polite" className="inline-flex min-w-[5.5rem] items-center gap-1.5 text-xs text-slate-500">
      {shown === 'saving' && (
        <>
          <LoaderCircle size={13} aria-hidden className="animate-spin" /> Salvando…
        </>
      )}
      {shown === 'saved' && (
        <>
          <Check size={13} aria-hidden className="text-success" /> Salvo
        </>
      )}
      {shown === 'error' && (
        <span className="inline-flex items-center gap-1.5 font-semibold text-danger">
          <TriangleAlert size={13} aria-hidden /> Não salvou
        </span>
      )}
    </span>
  );
}

// ─── IDP ─────────────────────────────────────────────────────────────────────────

const IDP_CARD_TONE: Record<IdpTone, 'success' | 'warning' | 'danger'> = { good: 'success', warn: 'warning', bad: 'danger' };
const IDP_PILL_TONE: Record<IdpTone, 'ok' | 'warn' | 'late'> = { good: 'ok', warn: 'warn', bad: 'late' };

/** De onde sai o planejado do IDP (regra 4): a linha de base escolhida, a manual mais recente ou o cronograma atual. */
export const idpReference = (performance: LobPerformance) =>
  performance.baseline ? `contra a linha de base “${performance.baseline.name}”` : 'contra o cronograma atual';

/** A linha da regra 6 (falta custo em algum pacote com blocos) ou do custo somando zero, com o caminho
 * até a visão Custos. Nada quando o peso já é o custo. Sem a migração 0044 (`costsUnavailable`) não há
 * onde apropriar: em vez do aviso em vermelho, diz que a apropriação ainda não foi ativada. */
export function IdpWeightNote({
  performance,
  costsHref,
  readOnly,
  costsUnavailable = false,
}: {
  performance: LobPerformance;
  costsHref: string;
  readOnly: boolean;
  costsUnavailable?: boolean;
}) {
  const { fallback, missingServiceIds, servicesWithBlocks } = performance.weights;
  if (fallback && costsUnavailable)
    return <span className="mt-1 block">A apropriação de custos ainda não foi ativada no banco: peso por duração.</span>;
  if (fallback === 'missing')
    return (
      <span className="mt-1 block font-semibold text-danger">
        Faltam custos em {missingServiceIds.length} de {plural(servicesWithBlocks.length, 'pacote', 'pacotes')}.{' '}
        <Link className="text-link font-semibold" href={costsHref}>
          {readOnly ? 'Ver custos' : 'Apropriar custos'}
        </Link>
      </span>
    );
  if (fallback === 'zero') return <span className="mt-1 block">Os custos apropriados somam zero: peso por duração.</span>;
  return null;
}

/** Quinto indicador (11/11/2026, modelo "IDP na Linha de Balanço"): real ÷ planejado na última medição
 * fechada, na cor da faixa (regra 10), com a conta, a referência e o peso na dica (regras 1, 3, 4 e 7);
 * sem número nos casos da regra 11. */
function IdpCard({
  performance,
  costsHref,
  readOnly,
  costsUnavailable,
}: {
  performance: LobPerformance;
  costsHref: string;
  readOnly: boolean;
  costsUnavailable: boolean;
}) {
  const { status, point, weights } = performance;
  const weight = weightingLabel(weights.mode);
  const note = <IdpWeightNote performance={performance} costsHref={costsHref} readOnly={readOnly} costsUnavailable={costsUnavailable} />;
  if (status === 'ok' && point?.idp !== undefined) {
    const tone = idpTone(point.idp);
    return (
      <StatCard
        label="IDP · desempenho de prazo"
        tone={IDP_CARD_TONE[tone]}
        value={
          <span className="inline-flex flex-wrap items-center gap-2">
            {formatIdp(point.idp)}
            <Pill tone={IDP_PILL_TONE[tone]}>{IDP_TONE_LABEL[tone]}</Pill>
          </span>
        }
        hint={
          <>
            <span className="block tabular-nums">
              {pct(point.real)} ÷ {pct(point.planned)} em {dayMonth(point.date)} (medição nº {point.number}) · {idpReference(performance)} ·{' '}
              {weight}
            </span>
            {note}
          </>
        }
      />
    );
  }
  const reason =
    status === 'no-blocks'
      ? 'sem blocos ainda'
      : status === 'no-measurement'
        ? `sem medição · ${weight}`
        : `nada previsto até a data${point ? ` (medição nº ${point.number}, ${dayMonth(point.date)})` : ''} · ${idpReference(performance)} · ${weight}`;
  return (
    <StatCard
      label="IDP · desempenho de prazo"
      value="—"
      hint={
        <>
          <span className="block">{reason}</span>
          {status !== 'no-blocks' && note}
        </>
      }
    />
  );
}

// ─── A visão ─────────────────────────────────────────────────────────────────────

/** Diálogo dos detalhes do bloco (duplo clique no gráfico, 24/11/2026): o mesmo painel da atividade
 * selecionada, em janela modal. Esc e o clique fora fecham. */
function ActivityDetailsDialog({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label="Detalhes da atividade"
      data-tour="longo-lob-detalhes"
      onCancel={e => {
        e.preventDefault();
        onClose();
      }}
      onClick={e => {
        if (e.target === ref.current) onClose();
      }}
      className="m-auto max-h-[92vh] w-[min(95vw,64rem)] overflow-hidden rounded-2xl border border-slate-200 bg-white p-0 shadow-xl backdrop:bg-slate-900/55"
    >
      <div className="max-h-[92vh] overflow-y-auto p-5">{children}</div>
    </dialog>
  );
}

function LobViewInner({ workId }: { workId: string }) {
  const context = usePlanning();
  const confirm = useConfirm();
  const { toast } = useToast();
  const searchParams = useSearchParams();
  const { state, sync, reload, execute, dispatch } = useLob(workId);

  const [hiddenServiceIds, setHiddenServiceIds] = useState<ReadonlySet<string>>(() => new Set());
  const [localFilter, setLocalFilter] = useState<ReadonlySet<string>>(); // indefinido = todos
  const [period, setPeriod] = useState<Period>('all');
  const [custom, setCustom] = useState({ start: '', end: '' });
  const [baselineId, setBaselineId] = useState('');
  const [zoom, setZoom] = useState<LobZoom>('obra');
  // Ajuste fino do zoom (botões − e +, Ctrl+roda no gráfico): multiplica a escala do nível escolhido.
  const [zoomScale, setZoomScale] = useState(1);
  // Cada clique num nível de zoom pede o encaixe de novo; entre um e outro a escala do gráfico fica
  // congelada, para uma edição de datas não redesenhar a obra inteira.
  const [fitToken, setFitToken] = useState(0);
  // Datas travadas: o gráfico não arrasta nem move pelas setas. Evita reprogramar sem querer.
  const [locked, setLocked] = useState(true);
  const [showCritical, setShowCritical] = useState(false);
  const [showTable, setShowTable] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  /** Duplo clique no bloco (24/11/2026): os detalhes dele abrem num diálogo, como no médio prazo. */
  const [detailsOpen, setDetailsOpen] = useState(false);
  // `?lancar=<fluxo>` (vindo da visão Fluxos) já abre o diálogo com o fluxo escolhido; o efeito
  // abaixo tira o parâmetro do endereço para um recarregamento não reabrir.
  const launchParam = searchParams.get('lancar');
  const [panel, setPanel] = useState<Panel | undefined>(() => (launchParam ? 'launch' : undefined));
  const [launchFlowId, setLaunchFlowId] = useState<string | undefined>(() => launchParam ?? undefined);
  const [todayToken, setTodayToken] = useState(0);
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const [busy, setBusy] = useState(false);
  /** O que o arrasto move: o pacote inteiro (padrão) ou só o bloco (25/11/2026). */
  const [dragMode, setDragMode] = useState<DragMode>('package');
  /** Serviço aberto na janela "Editar o pacote". */
  const [editServiceId, setEditServiceId] = useState<string>();
  const undoRef = useRef<() => void>(() => {});
  // "Criar pendência" de um serviço (10/11/2026): card da Lista de pendência da aba 2, só para quem abre
  // a aba 2 (a API das pendências é do módulo "vagoes").
  const developer = useDeveloper(),
    modules = useModules();
  const canPend = hasSectionAccess('restricoes', { developer, modules });
  // Restrições de cada serviço, para o painel do bloco (24/11/2026): cards do quadro ligados a serviços.
  const restrictions = useServiceRestrictions(workId, canPend);
  const [pending, setPending] = useState<PendingSource>();

  const ready = context.state === 'ready' ? context : undefined;
  const actor = ready?.planning.data.users.find(u => u.id === ready.actorId);
  const readOnly = !actor || actor.role === 'viewer';
  const today: LocalDate = ready?.planning.today ?? new Date().toISOString().slice(0, 10);
  const data = state.status === 'ready' ? state.data : undefined;
  const actorId = ready?.actorId;
  // "Histórico" relê a lista a cada gravação que termina (a fila esvaziou). Estado derivado do render
  // anterior, como em `useStable` no gráfico: sem efeito, sem desenho a mais.
  const [historyToken, setHistoryToken] = useState(0);
  const [seenSync, setSeenSync] = useState(sync);
  if (sync !== seenSync) {
    setSeenSync(sync);
    if (sync === 'saved' || sync === 'error') setHistoryToken(t => t + 1);
  }

  const percents = useMemo(() => (data ? measuredPercents(data.measurements, data.items) : {}), [data]);
  const measurementDates = useMemo(
    () => (data ? closedMeasurements(data.measurements).map(m => ({ number: m.number, date: m.date })) : []),
    [data],
  );
  const lateActivities = useMemo(
    () => (data ? data.activities.filter(a => isLate(a, percents[a.id], today, data.calendar)) : []),
    [data, percents, today],
  );
  // IDP e peso da aba (11/11/2026): o cartão do IDP segue a linha de base do seletor (vazio = regra 4) e
  // o "Avanço físico" usa o mesmo peso (regra 7). Memorizados: a obra chega a 600 blocos e o IDP refaz
  // o acumulado de cada medição fechada.
  const performance = useMemo(() => (data ? lobPerformance(data, { baselineId: baselineId || undefined }) : undefined), [data, baselineId]);
  const weights = performance?.weights;
  const progress = useMemo(() => (data && weights ? weightedProgress(data, today, weights) : undefined), [data, today, weights]);
  // Começo e fim do cronograma e o término da linha de base escolhida: memorizados, porque percorrem
  // todos os blocos e a tela redesenha a cada passagem do mouse.
  const span = useMemo(() => (data ? lobSpan(data.activities, data.calendar) : undefined), [data]);
  const baseline = useMemo(() => data?.baselines.find(b => b.id === baselineId), [data, baselineId]);
  const baselineFinish = useMemo(() => (baseline ? baselineFinishDate(baseline, data?.calendar) : undefined), [baseline, data]);
  // Desvio do término da obra em DIAS ÚTEIS do calendário da obra, como o desvio de cada bloco.
  const finishDelta = useMemo(
    () => (span && baselineFinish ? workdayDelta(baselineFinish, span.finish, data?.calendar) : undefined),
    [span, baselineFinish, data],
  );
  const range = useMemo(() => {
    if (period === '3m') return { start: today, end: addDays(today, 91) };
    if (period === '6m') return { start: today, end: addDays(today, 182) };
    if (period === 'custom' && isLocalDate(custom.start) && isLocalDate(custom.end) && custom.start <= custom.end)
      return { start: custom.start, end: custom.end };
    return undefined;
  }, [period, custom, today]);

  useEffect(() => {
    // Lido depois da montagem (o servidor não conhece o navegador): um quadro travado a mais não faz mal.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocked(readLock());
  }, []);
  useEffect(() => {
    if (!actorId) return;
    // Lido depois da montagem, como a trava: a preferência é deste navegador e desta pessoa.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDragMode(readDragMode(actorId));
  }, [actorId]);
  const chooseDragMode = (mode: DragMode) => {
    setDragMode(mode);
    if (!actorId) return;
    try {
      window.localStorage.setItem(dragKey(actorId), mode === 'block' ? 'bloco' : 'pacote');
    } catch {
      // Navegador sem armazenamento: a escolha vale só nesta visita.
    }
  };
  const toggleLock = () =>
    setLocked(current => {
      try {
        window.localStorage.setItem(LOCK_KEY, current ? '0' : '1');
      } catch {
        // Navegador sem armazenamento: a trava vale só nesta visita.
      }
      return !current;
    });
  const stepZoom = (direction: 1 | -1) =>
    setZoomScale(scale =>
      Math.min(ZOOM_SCALE_MAX, Math.max(ZOOM_SCALE_MIN, direction > 0 ? scale * ZOOM_SCALE_STEP : scale / ZOOM_SCALE_STEP)),
    );
  // Caminho crítico: só calcula com o destaque ligado (a obra chega a 600 blocos e 1.200 dependências).
  const critical = useMemo(
    () => (data && showCritical ? lobCriticalPath(data.activities, data.dependencies, data.calendar) : undefined),
    [data, showCritical],
  );

  // Teclas: H rola até hoje; Ctrl+Z / Cmd+Z desfaz. Fora de campos e com nenhum diálogo aberto.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target) || document.querySelector('dialog[open]')) return;
      if ((event.key === 'z' || event.key === 'Z') && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        undoRef.current();
      } else if ((event.key === 'h' || event.key === 'H') && !event.ctrlKey && !event.metaKey && !event.altKey) {
        setTodayToken(t => t + 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!launchParam) return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has('lancar')) return;
    url.searchParams.delete('lancar');
    window.history.replaceState(null, '', url.toString());
  }, [launchParam]);

  const pushUndo = (entry: UndoEntry) => setUndoStack(stack => [...stack.slice(-(UNDO_DEPTH - 1)), entry]);
  /** Executa um comando e guarda, para "Desfazer", as datas dos blocos que ele mudou. Só comandos
   * que mantêm o mesmo conjunto de blocos entram na pilha: lançar, importar e excluir não se desfazem.
   * Comando de datas (mover, esticar, mover o pacote) aparece na hora e grava em segundo plano: o
   * "Desfazer" já fica disponível, e, se o servidor recusar, a tela volta e a entrada sai da pilha.
   * "Editar o pacote" guarda também as ligações de antes (regra 11: Ctrl+Z desfaz datas e ligações
   * enquanto a tela estiver aberta). */
  const run = async (command: LobCommand) => {
    if (isLobScheduleCommand(command)) {
      const { previous, done } = dispatch(command);
      const entry: UndoEntry | undefined = previous.length ? { dates: previous } : undefined;
      if (entry) pushUndo(entry);
      try {
        await done;
      } catch (error) {
        if (entry) setUndoStack(stack => stack.filter(e => e !== entry));
        throw error;
      }
      return;
    }
    const before = new Map((data?.activities ?? []).map(a => [a.id, a]));
    const linksBefore = command.type === 'edit_service' ? (data?.dependencies ?? []) : undefined;
    const response = await execute(command);
    if (response.available && response.activities.length === before.size && response.activities.every(a => before.has(a.id))) {
      const dates = response.activities
        .filter(a => {
          const b = before.get(a.id)!;
          return b.start !== a.start || b.durationDays !== a.durationDays;
        })
        .map(a => {
          const b = before.get(a.id)!;
          return { id: a.id, start: b.start, durationDays: b.durationDays };
        });
      const links = linksBefore ? linkRevert(linksBefore, response.dependencies) : undefined;
      const withLinks = !!links && links.remove.length + links.restore.length + links.update.length > 0;
      if (dates.length || withLinks) pushUndo(withLinks ? { dates, links } : { dates });
    }
    return response;
  };
  const fail = (error: unknown) => toast({ title: 'Não foi possível salvar', description: errorMessage(error), tone: 'danger' });
  const undo = async () => {
    if (!data || readOnly || busy) return;
    const entry = undoStack[undoStack.length - 1];
    if (!entry) return;
    setUndoStack(stack => stack.slice(0, -1));
    const items = entry.dates.map(item => ({ activityId: item.id, start: item.start, durationDays: item.durationDays }));
    if (entry.links) {
      // Edição do pacote: as datas e as ligações de antes numa gravação só. As ligações não se
      // calculam na tela, então espera a obra de volta do servidor.
      setBusy(true);
      try {
        await execute({ type: 'revert_service_edit', workId, items, links: entry.links });
        toast({
          title: 'Edição do pacote desfeita',
          description: entry.dates.length
            ? `${plural(entry.dates.length, 'bloco voltou', 'blocos voltaram')} às datas anteriores, e as ligações voltaram ao que eram.`
            : 'As ligações voltaram ao que eram.',
        });
      } catch (error) {
        fail(error);
      } finally {
        setBusy(false);
      }
      return;
    }
    try {
      // Uma gravação só para todos os blocos da entrada (o bloco arrastado e as sucessoras): as datas
      // voltam na tela na hora e o servidor confirma em segundo plano.
      const { done } = dispatch({ type: 'set_activity_dates', workId, items });
      toast({
        title: 'Alteração desfeita',
        description: `${plural(entry.dates.length, 'bloco voltou', 'blocos voltaram')} às datas anteriores.`,
      });
      await done;
    } catch (error) {
      fail(error);
    }
  };
  useEffect(() => {
    undoRef.current = undo;
  });

  if (state.status === 'error')
    return (
      <div className="panel p-6">
        <Callout tone="danger" role="alert">
          {state.message}
        </Callout>
        <button type="button" className="button-ghost mt-4" onClick={reload}>
          Tentar de novo
        </button>
      </div>
    );
  if (state.status === 'unavailable')
    return (
      <Callout tone="warning" role="status">
        A Linha de Balanço ainda não foi ativada no banco: aplique a migração 0038 (
        <code className="text-xs">supabase/migrations/0038_lob.sql</code>) e recarregue a página.
      </Callout>
    );
  if (!data || !performance || context.state === 'loading') return <LoadState />;

  // ─── Derivados da obra carregada ──────────────────────────────────────────
  const services = [...data.services].sort((a, b) => a.orderIndex - b.orderIndex);
  const locals = [...data.locals].sort((a, b) => a.orderIndex - b.orderIndex);
  const localName = (id: string) => data.locals.find(l => l.id === id)?.name ?? 'local';
  const serviceName = (id: string) => data.services.find(s => s.id === id)?.name ?? 'Serviço';
  const label = (a: LobActivity) => `${serviceName(a.serviceId)} · ${localName(a.localId)}`;
  const selected = selectedId ? data.activities.find(a => a.id === selectedId) : undefined;
  /** A entrega do card sai do primeiro início do serviço na obra: o menor `start` entre os blocos dele.
   * Serviço sem bloco não tem de onde tirar a data (e nem aparece aqui: chega-se a ele por um bloco). */
  const createPending = (serviceId: string) => {
    const service = data.services.find(s => s.id === serviceId);
    const starts = data.activities.filter(a => a.serviceId === serviceId).map(a => a.start);
    if (!service || !starts.length) return;
    setPending({ origin: 'longo_prazo', sourceId: service.id, label: service.name, start: starts.reduce((a, b) => (b < a ? b : a)) });
  };
  // Calendário de dias úteis da obra (ausente = segunda a sexta sem feriados): toda conta de data
  // desta tela passa por ele, como no servidor.
  const calendar = data.calendar;
  /** A linha de base que o IDP usa quando o seletor está vazio (regra 4), para o rótulo da opção vazia. */
  const defaultIdpBaseline = performanceBaseline(data.baselines);
  const physical = progress?.physical;
  const planned = progress?.planned;
  const weightLabel = weightingLabel(performance.weights.mode);
  const withCost = performance.weights.servicesWithBlocks.length - performance.weights.missingServiceIds.length;
  const behind = physical !== undefined && planned !== undefined && physical < planned - 0.05;
  const visibleServices = services.filter(s => !hiddenServiceIds.has(s.id)).length;
  const visibleLocals = localFilter ? locals.filter(l => localFilter.has(l.id)).length : locals.length;
  const base = workPath(workId, 'longo-prazo');
  const costsHref = `${base}?visao=custos`;
  /** Arrasto do pacote inteiro valendo (25/11/2026): modo Pacote, com permissão e datas liberadas. */
  const packageMode = dragMode === 'package' && !readOnly && !locked;
  /** Rodapé do gráfico com o pacote em destaque (o do bloco selecionado). */
  const packageNote = (() => {
    if (!packageMode || !selected) return '';
    const blocks = data.activities.filter(a => a.serviceId === selected.serviceId);
    const kept = blocks.filter(isStartedActivity).length;
    return (
      `Pacote “${serviceName(selected.serviceId)}” em destaque: ${plural(blocks.length, 'bloco', 'blocos')}` +
      (kept ? `, ${plural(kept, 'já iniciado fica', 'já iniciados ficam')} no lugar` : '') +
      '. Arraste qualquer bloco dele (ou use as setas ← →) para mover o pacote inteiro; Alt + arrastar move só o bloco.'
    );
  })();

  const toggleService = (id: string) =>
    setHiddenServiceIds(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleLocal = (id: string) =>
    setLocalFilter(current => {
      const next = new Set(current ?? locals.map(l => l.id));
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next.size === locals.length ? undefined : next;
    });
  const move = (id: string, start: LocalDate) => {
    if (readOnly || busy || locked) return;
    // `run` aplica na hora; a recusa imediata das regras e a falha da gravação caem no mesmo aviso.
    run({ type: 'update_activity', activityId: id, start }).catch(fail);
  };
  /** Move o pacote inteiro (25/11/2026): o deslocamento pedido, em dias úteis com sinal. A conta é a
   * do servidor (`planPackageMove`, com os dados de agora): para trás, o pacote para quando o primeiro
   * bloco encosta numa predecessora de fora (regra 4) e o aviso diz qual encostou em qual; sem andar
   * nada, nem grava. Um arrasto = uma gravação = um passo do "Desfazer" (regra 5). */
  const movePackage = (serviceId: string, requested: number) => {
    if (readOnly || busy || locked || !requested) return;
    const result = planPackageMove(data.activities, data.dependencies, serviceId, requested, calendar);
    const find = (id: string) => data.activities.find(a => a.id === id);
    const block = result.limiter && find(result.limiter.activityId);
    const predecessor = result.limiter && find(result.limiter.predecessorId);
    if (!result.applied) {
      if (block && predecessor)
        toast({
          title: 'Não dá para antecipar',
          description: `${label(block)} já começa logo depois de ${label(predecessor)}.`,
          tone: 'info',
        });
      else if (result.kept.length)
        toast({
          title: 'Nenhum bloco andou',
          description: 'Todos os blocos deste pacote já começaram: nenhum se move com o pacote.',
          tone: 'info',
        });
      return;
    }
    run({ type: 'move_service', workId, serviceId, deltaDays: result.applied }).catch(fail);
    if (result.applied !== requested && block && predecessor)
      toast({
        title: `Parou em ${plural(Math.abs(result.applied), 'dia útil', 'dias úteis')}`,
        description: `${label(block)} encostou em ${label(predecessor)}. ${packageMoveSummary(result)}`,
        tone: 'info',
      });
    else toast({ title: `Pacote “${serviceName(serviceId)}” movido`, description: packageMoveSummary(result) });
  };
  /** "Editar o pacote" aberto pelo painel do bloco (só com edição liberada). O diálogo de detalhes
   * fecha antes, para as duas janelas não se sobreporem. */
  const openPackageEditor = (serviceId: string) => {
    setDetailsOpen(false);
    setEditServiceId(serviceId);
  };
  const onEditPackage = readOnly || locked ? undefined : openPackageEditor;
  /** Grava a edição do pacote (regras 7 a 11) e resume a resposta. Se falhar, avisa e deixa a promessa
   * rejeitar: a janela continua aberta e mostra o erro. */
  const applyPackageEdit = async (edit: LobPackageEdit) => {
    const name = serviceName(edit.serviceId);
    const baselineIds = new Set(data.baselines.map(b => b.id));
    setBusy(true);
    try {
      const response = (await run({ type: 'edit_service', workId, ...edit })) as PackageEditResult | undefined;
      setEditServiceId(undefined);
      const created = response?.available ? response.baselines.find(b => !baselineIds.has(b.id)) : undefined;
      const changed = response?.changedBlocks ?? 0;
      const pushed = response?.pushed ?? 0;
      const kept = response?.kept ?? 0;
      const updated = response?.linksUpdated ?? 0;
      toast({
        title: `Pacote “${name}” editado`,
        description:
          `${plural(changed, 'bloco mudou', 'blocos mudaram')}, ${plural(pushed, 'sucessora empurrada', 'sucessoras empurradas')}, ` +
          `+${response?.linksAdded ?? 0}/−${response?.linksRemoved ?? 0} ligações` +
          (updated ? ` (${plural(updated, 'espera mudou', 'esperas mudaram')})` : '') +
          '.' +
          (kept ? ` ${plural(kept, 'bloco já iniciado ficou', 'blocos já iniciados ficaram')} de fora.` : '') +
          (created ? ` A linha de base automática “${created.name}” guarda as datas de antes.` : '') +
          ' Ctrl+Z desfaz.',
        duration: 9000,
      });
    } catch (error) {
      fail(error);
      throw error;
    } finally {
      setBusy(false);
    }
  };
  /** Grava o calendário da obra. Não entra no "Desfazer" (que só devolve datas): a pilha é zerada, e o
   * caminho de volta é a linha de base automática que o servidor guarda antes da mudança. */
  const applyCalendar = async (next: LobCalendar) => {
    const response = await execute({ type: 'set_calendar', workId, calendar: next });
    setUndoStack([]);
    const moved = response.changedBlocks ?? 0;
    toast({
      title: 'Calendário da obra atualizado',
      description: moved
        ? `${plural(moved, 'bloco mudou', 'blocos mudaram')} de data. O cronograma anterior ficou na linha de base automática “Antes da mudança de calendário”.`
        : 'Nenhum bloco mudou de data.',
    });
  };
  const openLaunch = (flowId?: string) => {
    if (!data.locals.length) {
      toast({
        title: 'Cadastre os locais da obra primeiro',
        description: 'O fluxo é lançado nos locais marcados; sem locais não há onde colocar os blocos.',
        tone: 'info',
      });
      setPanel('locals');
      return;
    }
    setLaunchFlowId(flowId);
    setPanel('launch');
  };
  const importPlanner = async () => {
    const ok = await confirm({
      title: 'Importar o plano do Planejador?',
      description: data.activities.length
        ? `A importação só funciona com a Linha de Balanço vazia, e esta obra já tem ${plural(data.activities.length, 'bloco', 'blocos')}: ela será recusada. Exclua os blocos antes ou lance o fluxo direto.`
        : 'Cada serviço × pavimento do Planejador vira um bloco com as datas atuais, e os pavimentos viram locais. Só funciona com a Linha de Balanço vazia.',
      confirmLabel: 'Importar',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const response = await execute({ type: 'import_planner', workId });
      if (response.available)
        toast({
          title: 'Plano importado',
          description: `${plural(response.activities.length, 'bloco', 'blocos')} em ${plural(response.locals.length, 'local', 'locais')}.`,
        });
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };
  /** CSV dos blocos, no formato que o Excel em pt-BR lê (`;`, vírgula decimal, BOM). */
  const exportCsv = () => {
    const localOrder = new Map(locals.map((l, i) => [l.id, i]));
    const serviceOrder = new Map(services.map((s, i) => [s.id, i]));
    const sorted = [...data.activities].sort(
      (a, b) =>
        (localOrder.get(a.localId) ?? 0) - (localOrder.get(b.localId) ?? 0) ||
        (serviceOrder.get(a.serviceId) ?? 0) - (serviceOrder.get(b.serviceId) ?? 0),
    );
    const rows: (string | number)[][] = [
      ['Local', 'Serviço', 'Início', 'Término', 'Duração (dias úteis)', 'Previsto até hoje (%)', 'Medido (%)'],
      ...sorted.map(a => [
        localName(a.localId),
        serviceName(a.serviceId),
        formatDate(a.start),
        formatDate(activityFinish(a, calendar)),
        a.durationDays,
        plannedPercent(a, today, calendar),
        percents[a.id] ?? 0,
      ]),
    ];
    const text = rows
      .map(row =>
        row
          .map(cell =>
            typeof cell === 'number'
              ? cell.toLocaleString('pt-BR', { useGrouping: false, maximumFractionDigits: 1 })
              : `"${cell.replace(/"/g, '""')}"`,
          )
          .join(';'),
      )
      .join('\r\n');
    const url = URL.createObjectURL(new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: `linha-de-balanco-${workId}.csv` });
    link.click();
    URL.revokeObjectURL(url);
  };

  const lateRows = lateActivities
    .map(a => ({
      id: a.id,
      label: label(a),
      planned: plannedPercent(a, today, calendar),
      measured: percents[a.id] ?? 0,
      delay: delayDays(a, percents[a.id], today, calendar),
    }))
    .sort((a, b) => b.delay - a.delay || a.label.localeCompare(b.label, 'pt-BR'));

  return (
    <section aria-label="Linha de Balanço" className="space-y-4">
      {/* Ações da obra. Os controles de visualização (filtros, zoom, trava, caminho crítico e tabela)
          ficam no cabeçalho do quadro do gráfico, mais abaixo (16/11/2026, retorno do Atmos). */}
      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Ações da Linha de Balanço">
        {!readOnly && (
          <button data-tour="longo-lob-lancar" type="button" className="button" disabled={busy} onClick={() => openLaunch()}>
            <Plus size={16} aria-hidden /> Lançar fluxo
          </button>
        )}
        <Link data-tour="longo-lob-nova-medicao" href={`${base}?visao=medicoes`} className="button-secondary">
          <Ruler size={15} aria-hidden /> Nova medição
        </Link>
        {/* Custos por pacote (11/11/2026): o selo diz quantos pacotes com blocos já têm custo (regra 6). */}
        <Link
          data-tour="longo-lob-custos"
          href={costsHref}
          className="button-ghost"
          title={
            performance.weights.servicesWithBlocks.length
              ? `${withCost} de ${plural(performance.weights.servicesWithBlocks.length, 'pacote com blocos tem', 'pacotes com blocos têm')} custo apropriado`
              : 'Custos por pacote de serviço: o peso do IDP'
          }
        >
          <Coins size={15} aria-hidden /> Custos
          {performance.weights.servicesWithBlocks.length > 0 && (
            <span
              className={`badge-muted px-2 py-0 tabular-nums ${performance.weights.fallback === 'missing' ? 'border-warning-ring bg-warning-soft text-warning' : ''}`}
            >
              {withCost}/{performance.weights.servicesWithBlocks.length}
            </span>
          )}
        </Link>
        <button data-tour="longo-lob-linha-base" type="button" className="button-ghost" onClick={() => setPanel('baselines')}>
          <Flag size={15} aria-hidden /> {readOnly ? 'Linhas de base' : 'Salvar linha de base'}
          {data.baselines.length > 0 && <span className="badge-muted px-2 py-0">{data.baselines.length}</span>}
        </button>
        <button
          data-tour="longo-lob-atrasos"
          type="button"
          className="button-ghost"
          disabled={!lateActivities.length}
          onClick={() => setPanel('late')}
        >
          <TriangleAlert size={15} aria-hidden className={lateActivities.length ? 'text-danger' : undefined} /> Atrasos
          {lateActivities.length > 0 && <b className="tabular-nums text-danger">{lateActivities.length}</b>}
        </button>
        {/* Calendário de dias úteis da obra (23/11/2026): dias da semana trabalhados e dias sem trabalho. */}
        <button
          data-tour="longo-lob-calendario"
          type="button"
          className="button-ghost"
          title={`Dias úteis desta obra: ${lobCalendarLabel(calendar)}`}
          onClick={() => setPanel('calendar')}
        >
          <CalendarDays size={15} aria-hidden /> Calendário
          {!isDefaultLobCalendar(calendar) && (
            <span className="badge-muted px-2 py-0 tabular-nums">
              {calendar?.holidays.length
                ? plural(calendar.holidays.length, 'dia sem trabalho', 'dias sem trabalho')
                : `${calendar?.weekdays.length ?? 5} dias/semana`}
            </span>
          )}
        </button>
        {/* Histórico das alterações gravadas (25/11/2026). */}
        <button
          data-tour="lob-history"
          type="button"
          className="button-ghost"
          title="As alterações gravadas nesta Linha de Balanço"
          onClick={() => setPanel('history')}
        >
          <History size={15} aria-hidden /> Histórico
        </button>
        <span className="flex-1" />
        {!readOnly && <SaveStatus sync={sync} />}
        {!readOnly && (
          <button
            data-tour="longo-lob-desfazer"
            type="button"
            className="button-ghost"
            disabled={!undoStack.length || busy}
            title="Ctrl+Z"
            onClick={undo}
          >
            <Undo2 size={15} aria-hidden /> Desfazer
          </button>
        )}
        <Popover tourId="longo-lob-mais" label={<MoreHorizontal size={16} aria-hidden />} ariaLabel="Mais ações" align="end">
          {close => (
            <div role="menu">
              <button
                type="button"
                role="menuitem"
                className={menuItem}
                onClick={() => {
                  close();
                  setPanel('locals');
                }}
              >
                <Building2 size={15} aria-hidden /> Locais da obra
              </button>
              {!readOnly && (
                <button
                  type="button"
                  role="menuitem"
                  className={menuItem}
                  disabled={busy}
                  onClick={() => {
                    close();
                    importPlanner();
                  }}
                >
                  <Upload size={15} aria-hidden /> Importar do Planejador
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                className={menuItem}
                disabled={!data.activities.length}
                onClick={() => {
                  close();
                  exportCsv();
                }}
              >
                <Download size={15} aria-hidden /> Exportar CSV
              </button>
            </div>
          )}
        </Popover>
        <HelpNote title="Como funciona: Linha de Balanço" compact>
          <p>
            Cada bloco é um <strong>serviço num local</strong>, com início e duração em dias úteis. A parte transparente é o que já foi
            medido e a parte cheia é o que falta fazer: serviço concluído fica todo transparente e serviço futuro, todo cheio. O contorno
            vermelho marca atraso (previsto até hoje acima do medido). Ao clicar num bloco, linhas vermelhas finas ligam-no às predecessoras
            e às sucessoras; dois cliques abrem os detalhes numa janela.
          </p>
          <p>
            Os dias úteis são os do <strong>Calendário</strong> da obra: os dias da semana trabalhados (de início, segunda a sexta) e os
            dias sem trabalho que você marcar, como feriados e recessos. No gráfico, os dias sem trabalho aparecem como faixas cinza atrás
            dos blocos nos zooms Semana e Mês. Mudar o calendário mantém as durações e reprograma as datas; antes de gravar, a tela mostra
            quantos blocos mudam e o novo término, e o sistema guarda uma linha de base automática.
          </p>
          <p>
            As datas abrem <strong>travadas</strong>, para ninguém reprogramar sem querer. Clique no cadeado para liberar e então{' '}
            <strong>arraste</strong> um bloco: ele nunca entra antes do fim das predecessoras, e as sucessoras se deslocam junto enquanto
            você arrasta. Ao soltar, a mudança aparece na hora e é gravada em segundo plano (“Salvando…”, depois “Salvo”); se a gravação
            falhar, a tela volta ao que estava e avisa. <strong>Desfazer</strong> (Ctrl+Z) devolve as datas (e, na edição do pacote, as
            ligações) enquanto a tela estiver aberta. Duração, dependências, equipe e datas reais se editam no painel do bloco selecionado.
          </p>
          <p>
            <strong>Arrastar: Pacote ou Bloco.</strong> Em <strong>Pacote</strong> (o padrão), clicar num bloco destaca o serviço em todos
            os locais, e arrastar qualquer bloco dele (ou usar as setas ← →, com Shift para uma semana) move todos os blocos do serviço
            juntos, o mesmo número de dias úteis; as sucessoras são empurradas quando preciso. Para trás, o pacote para quando o primeiro
            bloco encosta numa predecessora de outro serviço. Blocos já iniciados (com início real) ficam onde estão. Alt + arrastar move só
            o bloco; em <strong>Bloco</strong>, o arrasto sempre move um bloco só. <strong>Editar o pacote</strong>, no painel do bloco,
            aplica a mesma duração, o ritmo entre os locais e as predecessoras a todos os locais marcados de uma vez, e antes guarda uma
            linha de base automática. <strong>Histórico</strong> lista as alterações gravadas.
          </p>
          <p>
            <strong>Zoom:</strong> Semana, Mês, Trimestre ou a obra inteira na largura da tela; os botões − e + (ou Ctrl + roda do mouse
            sobre o gráfico) fazem o ajuste fino. <strong>Caminho crítico</strong> destaca os blocos sem folga: os que, se atrasarem,
            empurram o término da obra pelas dependências.
          </p>
          <p>
            <strong>Lançar fluxo</strong> cria os blocos a partir de um fluxo da empresa nos locais marcados; antes de cada lançamento numa
            obra que já tem blocos, uma linha de base automática guarda o cronograma. <strong>Salvar linha de base</strong> guarda uma
            versão do cronograma com nome, para comparar no gráfico ou restaurar depois. Com uma linha de base escolhida no filtro, o
            tracejado mostra onde cada bloco estava; passe o mouse no bloco ou no tracejado para ver as datas da linha de base e o{' '}
            <strong>desvio em dias úteis</strong> (+ atrasado, − adiantado), que também aparece como selo no bloco nos zooms Mês e Semana,
            no painel do bloco e na Tabela.
          </p>
          <p>
            O <strong>IDP</strong> (desempenho de prazo) é o avanço real ÷ o planejado na última medição fechada, contra a linha de base
            escolhida (sem escolha, a manual mais recente): 1,00 ou mais está em dia, abaixo de 0,90 atrasado. Com o custo de todos os
            pacotes apropriado em <strong>Custos</strong>, ele e o avanço físico passam a pesar pelo custo; até lá, pela duração.
          </p>
        </HelpNote>
      </div>

      {actor?.role === 'viewer' && (
        <Callout tone="info">Seu acesso é de consulta: a Linha de Balanço aparece aqui, mas não pode ser alterada.</Callout>
      )}
      {!readOnly && !data.locals.length && (
        <Callout tone="warning">
          Antes de lançar um fluxo, cadastre os locais da obra (Térreo, 1º pavimento… de baixo para cima).{' '}
          <button type="button" className="text-link" onClick={() => setPanel('locals')}>
            Locais da obra
          </button>
        </Callout>
      )}

      {/* Indicadores */}
      <div data-tour="longo-lob-indicadores" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <StatCard
          label="Serviços"
          value={data.services.length}
          hint={`${plural(data.launches.length, 'lançamento', 'lançamentos')} · ${plural(data.activities.length, 'bloco', 'blocos')}`}
        />
        <StatCard
          label="Locais"
          value={data.locals.length}
          hint={
            locals.length >= 2 ? `${locals[0].name} a ${locals[locals.length - 1].name}` : (locals[0]?.name ?? 'cadastre os locais da obra')
          }
        />
        <StatCard
          label="Término previsto"
          value={span ? formatDate(span.finish) : '—'}
          hint={
            finishDelta !== undefined && baselineFinish ? (
              <span className={finishDelta > 0 ? 'font-semibold text-danger' : finishDelta < 0 ? 'font-semibold text-success' : undefined}>
                {finishDelta ? `${signedWorkdays(finishDelta, false)} sobre a` : 'igual à'} linha de base
                {baseline ? ` “${baseline.name}”` : ''} ({formatDate(baselineFinish)})
              </span>
            ) : span ? (
              'escolha uma linha de base para comparar'
            ) : (
              'sem blocos ainda'
            )
          }
        />
        <StatCard
          label="Avanço físico"
          value={physical !== undefined ? pct(physical) : '—'}
          hint={
            planned !== undefined ? (
              <>
                <span className={behind ? 'font-semibold text-danger' : undefined}>
                  Previsto até hoje {pct(planned)} · {plural(lateActivities.length, 'bloco atrasado', 'blocos atrasados')}
                </span>{' '}
                · {weightLabel}
              </>
            ) : (
              'sem blocos ainda'
            )
          }
        />
        <div data-tour="longo-lob-idp" className="grid">
          <IdpCard
            performance={performance}
            costsHref={costsHref}
            readOnly={readOnly}
            costsUnavailable={state.status === 'ready' && state.costAccess === 'unavailable'}
          />
        </div>
      </div>

      {/* Atividade selecionada: acima do gráfico, para não tomar a lateral dele (11/11/2026) */}
      <aside className="panel p-4" data-tour="longo-lob-painel" aria-label="Atividade selecionada">
        {selected ? (
          <LobActivityPanel
            key={selected.id}
            activity={selected}
            data={data}
            baseline={baseline}
            percents={percents}
            today={today}
            readOnly={readOnly}
            onExecute={run}
            onClose={() => setSelectedId(undefined)}
            onSelect={setSelectedId}
            onCreatePending={canPend ? createPending : undefined}
            restrictions={canPend ? restrictions.state : undefined}
            onEditPackage={onEditPackage}
            workId={workId}
          />
        ) : data.activities.length ? (
          <div className="text-sm text-slate-500">
            <p className="eyebrow">Atividade selecionada</p>
            <p className="mt-2">
              Clique num bloco para ver detalhes: datas, duração, dependências, equipe, restrições do serviço, situação e fotos da medição.
              As linhas vermelhas finas mostram o que prende o bloco (de quem ele depende e quem depende dele). Dois cliques abrem os
              detalhes numa janela.
            </p>
            {!readOnly && (
              <p className="mt-2 text-xs">
                {locked
                  ? 'As datas estão travadas. Para reprogramar arrastando, libere a edição no cadeado acima do gráfico.'
                  : dragMode === 'package'
                    ? 'Arraste um bloco para mover o pacote inteiro (o serviço em todos os locais); Alt + arrastar move só o bloco. As sucessoras se deslocam junto. H leva até hoje; Ctrl+Z desfaz.'
                    : 'Arraste um bloco para mudar a data; as sucessoras se deslocam junto. H leva até hoje; Ctrl+Z desfaz.'}
              </p>
            )}
          </div>
        ) : (
          <div className="text-sm text-slate-600">
            <p className="eyebrow">Começar</p>
            <p className="mt-2">Nenhum bloco ainda. Cadastre os locais e lance um fluxo da empresa, ou traga o plano do Planejador.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {!readOnly && (
                <button type="button" className="button" disabled={busy} onClick={() => openLaunch()}>
                  <Plus size={16} aria-hidden /> Lançar fluxo
                </button>
              )}
              <button type="button" className="button-ghost" onClick={() => setPanel('locals')}>
                <Building2 size={15} aria-hidden /> Locais da obra
              </button>
              {!readOnly && (
                <button type="button" className="button-ghost" disabled={busy} onClick={importPlanner}>
                  <Upload size={15} aria-hidden /> Importar do Planejador
                </button>
              )}
            </div>
          </div>
        )}
      </aside>
      {/* Gráfico (ou tabela), na largura toda, com os controles de visualização no cabeçalho */}
      <div className="panel p-4" data-tour="longo-lob-grafico">
        <div className="mb-3 flex flex-wrap items-center gap-2" role="toolbar" aria-label="Visualização da Linha de Balanço">
          <Popover
            tourId="longo-lob-filtros"
            label={<>{visibleServices === services.length ? 'Serviços: todos' : `Serviços: ${visibleServices} de ${services.length}`}</>}
          >
            {() => (
              <CheckList
                items={services.map(s => ({ id: s.id, label: s.name, color: s.color }))}
                isChecked={id => !hiddenServiceIds.has(id)}
                onToggle={toggleService}
                onAll={() => setHiddenServiceIds(new Set())}
                onNone={() => setHiddenServiceIds(new Set(services.map(s => s.id)))}
                empty="Nenhum serviço ainda: lance um fluxo."
              />
            )}
          </Popover>
          <Popover label={!localFilter ? 'Locais: todos' : `Locais: ${visibleLocals} de ${locals.length}`}>
            {() => (
              <CheckList
                items={[...locals].reverse().map(l => ({ id: l.id, label: l.name }))}
                isChecked={id => !localFilter || localFilter.has(id)}
                onToggle={toggleLocal}
                onAll={() => setLocalFilter(undefined)}
                onNone={() => setLocalFilter(new Set())}
                empty="Nenhum local cadastrado."
              />
            )}
          </Popover>
          <label htmlFor="lob-period" className="sr-only">
            Período
          </label>
          <select id="lob-period" className="field w-auto py-2" value={period} onChange={event => setPeriod(event.target.value as Period)}>
            <option value="all">Período: obra inteira</option>
            <option value="3m">Período: próximos 3 meses</option>
            <option value="6m">Período: próximos 6 meses</option>
            <option value="custom">Período: personalizado</option>
          </select>
          {period === 'custom' && (
            <>
              <input
                type="date"
                className="field w-auto py-2"
                aria-label="Início do período"
                value={custom.start}
                onChange={event => setCustom(c => ({ ...c, start: event.target.value }))}
              />
              <input
                type="date"
                className="field w-auto py-2"
                aria-label="Fim do período"
                value={custom.end}
                onChange={event => setCustom(c => ({ ...c, end: event.target.value }))}
              />
            </>
          )}
          <label htmlFor="lob-baseline" className="sr-only">
            Linha de base
          </label>
          <select
            id="lob-baseline"
            className="field w-auto max-w-[16rem] py-2"
            value={baselineId}
            onChange={event => setBaselineId(event.target.value)}
          >
            {/* Vazio = nada no gráfico; o IDP cai na regra 4 (manual mais recente) e diz qual usa na dica. */}
            <option value="">
              {defaultIdpBaseline ? `Linha de base: nenhuma no gráfico (IDP: “${defaultIdpBaseline.name}”)` : 'Linha de base: nenhuma'}
            </option>
            {[...data.baselines]
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
              .map(b => (
                <option key={b.id} value={b.id}>
                  {b.name}
                  {b.automatic ? ' (automática)' : ''}
                </option>
              ))}
          </select>
          <span className="hidden flex-1 lg:block" />
          {!showTable && (
            <>
              <div data-tour="longo-lob-zoom" className="flex items-center gap-1">
                <div
                  role="group"
                  aria-label="Escala do tempo"
                  className="inline-flex rounded-lg border border-slate-200 bg-slate-100 p-0.5"
                >
                  {ZOOMS.map(z => (
                    <button
                      key={z.id}
                      type="button"
                      aria-pressed={zoom === z.id}
                      onClick={() => {
                        setZoom(z.id);
                        setZoomScale(1);
                        setFitToken(t => t + 1);
                      }}
                      className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${zoom === z.id ? 'bg-white text-primary-ink shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
                    >
                      {z.label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="button-ghost px-2"
                  aria-label="Diminuir o zoom"
                  title="Diminuir o zoom (Ctrl + roda do mouse)"
                  disabled={zoomScale <= ZOOM_SCALE_MIN}
                  onClick={() => stepZoom(-1)}
                >
                  <Minus size={15} aria-hidden />
                </button>
                <button
                  type="button"
                  className="button-ghost px-2"
                  aria-label="Aumentar o zoom"
                  title="Aumentar o zoom (Ctrl + roda do mouse)"
                  disabled={zoomScale >= ZOOM_SCALE_MAX}
                  onClick={() => stepZoom(1)}
                >
                  <Plus size={15} aria-hidden />
                </button>
              </div>
              <button
                data-tour="longo-lob-hoje"
                type="button"
                className="button-ghost"
                title="Rolar até hoje (tecla H)"
                onClick={() => setTodayToken(t => t + 1)}
              >
                Hoje <kbd className="rounded border border-slate-200 bg-slate-50 px-1 text-[10px] font-semibold text-slate-400">H</kbd>
              </button>
              <button
                data-tour="longo-lob-critico"
                type="button"
                className="button-ghost"
                aria-pressed={showCritical}
                title="Destaca os blocos sem folga: se atrasarem, empurram o término da obra"
                onClick={() => setShowCritical(v => !v)}
              >
                <Waypoints size={15} aria-hidden style={showCritical ? { color: CRITICAL_COLOR } : undefined} /> Caminho crítico
                {critical && <span className="badge-muted px-2 py-0 tabular-nums">{critical.criticalIds.size}</span>}
              </button>
              {!readOnly && (
                <button
                  data-tour="longo-lob-trava"
                  type="button"
                  className="button-ghost"
                  aria-pressed={locked}
                  title={
                    locked
                      ? 'As datas estão travadas: arrastar e as setas não mudam nada. Clique para liberar a edição.'
                      : 'A edição das datas está liberada: arrastar um bloco reprograma. Clique para travar.'
                  }
                  onClick={toggleLock}
                >
                  {locked ? <Lock size={15} aria-hidden /> : <LockOpen size={15} aria-hidden className="text-warning" />}
                  {locked ? 'Datas travadas' : 'Datas liberadas'}
                </button>
              )}
              {/* O que o arrasto move (25/11/2026): o pacote inteiro (padrão) ou só o bloco. */}
              {!readOnly && (
                <div data-tour="lob-drag-mode" role="group" aria-label="Arrastar" className="flex items-center gap-1.5">
                  <span aria-hidden className="text-xs font-semibold text-slate-500">
                    Arrastar:
                  </span>
                  <div className="inline-flex rounded-lg border border-slate-200 bg-slate-100 p-0.5">
                    {DRAG_MODES.map(m => (
                      <button
                        key={m.id}
                        type="button"
                        aria-pressed={dragMode === m.id}
                        title={m.title}
                        onClick={() => chooseDragMode(m.id)}
                        className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${dragMode === m.id ? 'bg-white text-primary-ink shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
          <button
            data-tour="longo-lob-tabela"
            type="button"
            className="button-ghost"
            aria-pressed={showTable}
            onClick={() => setShowTable(v => !v)}
          >
            <Table2 size={15} aria-hidden /> Tabela
          </button>
        </div>
        {!data.activities.length ? (
          <p className="py-12 text-center text-sm text-slate-500">
            A Linha de Balanço desta obra ainda não tem blocos.
            {!readOnly && ' Use "Lançar fluxo" para criar os blocos a partir de um fluxo da empresa, ou importe o plano do Planejador.'}
          </p>
        ) : showTable ? (
          <LobTable
            data={data}
            baseline={baseline}
            percents={percents}
            today={today}
            hiddenServiceIds={hiddenServiceIds}
            visibleLocalIds={localFilter}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        ) : (
          <LobChart
            data={data}
            today={today}
            percents={percents}
            measurementDates={measurementDates}
            baseline={baseline}
            hiddenServiceIds={hiddenServiceIds}
            visibleLocalIds={localFilter}
            range={range}
            zoom={zoom}
            zoomScale={zoomScale}
            fitToken={fitToken}
            onZoomStep={stepZoom}
            criticalIds={critical?.criticalIds}
            floatDays={critical?.floatDays}
            selectedId={selectedId}
            readOnly={readOnly || busy || locked}
            onSelect={setSelectedId}
            onMove={move}
            packageMode={packageMode}
            onMovePackage={movePackage}
            onOpen={id => {
              setSelectedId(id);
              setDetailsOpen(true);
            }}
            scrollToTodayToken={todayToken}
          />
        )}
        {packageNote && !showTable && <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">{packageNote}</p>}
        {showCritical && critical && !showTable && data.activities.length > 0 && (
          <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">
            {critical.criticalIds.size
              ? `${plural(critical.criticalIds.size, 'bloco crítico', 'blocos críticos')} em destaque: não têm folga até o término da obra${span ? ` (${formatDate(span.finish)})` : ''}, pelas dependências cadastradas. Os demais ficam esmaecidos.`
              : 'Nenhum bloco crítico: sem dependências entre os blocos não há caminho para calcular.'}
          </p>
        )}
      </div>

      {panel === 'locals' && (
        <LobLocalsPanel
          workId={workId}
          locals={data.locals}
          blocksOf={id => data.activities.filter(a => a.localId === id).length}
          readOnly={readOnly}
          onExecute={run}
          onClose={() => setPanel(undefined)}
        />
      )}
      {panel === 'baselines' && (
        <LobBaselinesPanel
          data={data}
          readOnly={readOnly}
          activeId={baselineId || undefined}
          onExecute={run}
          onClose={() => setPanel(undefined)}
          onCompare={id => setBaselineId(id ?? '')}
        />
      )}
      {panel === 'launch' && !readOnly && data.locals.length > 0 && (
        <LobLaunchDialog
          workId={workId}
          data={data}
          today={today}
          initialFlowId={launchFlowId}
          onExecute={run}
          onClose={() => {
            setPanel(undefined);
            setLaunchFlowId(undefined);
          }}
        />
      )}
      {panel === 'calendar' && (
        <LobCalendarDialog data={data} today={today} canEdit={!readOnly} onApply={applyCalendar} onClose={() => setPanel(undefined)} />
      )}
      <LobHistoryPanel workId={workId} open={panel === 'history'} onClose={() => setPanel(undefined)} refreshToken={historyToken} />
      {editServiceId && !readOnly && data.services.some(s => s.id === editServiceId) && (
        <LobPackageDialog
          open
          data={data}
          serviceId={editServiceId}
          busy={busy}
          onClose={() => setEditServiceId(undefined)}
          onApply={applyPackageEdit}
        />
      )}
      {detailsOpen && selected && (
        <ActivityDetailsDialog onClose={() => setDetailsOpen(false)}>
          <LobActivityPanel
            key={selected.id}
            activity={selected}
            data={data}
            baseline={baseline}
            percents={percents}
            today={today}
            readOnly={readOnly}
            onExecute={run}
            onClose={() => setDetailsOpen(false)}
            onSelect={setSelectedId}
            onCreatePending={canPend ? createPending : undefined}
            restrictions={canPend ? restrictions.state : undefined}
            onEditPackage={onEditPackage}
            workId={workId}
          />
        </ActivityDetailsDialog>
      )}
      {pending && (
        <CreatePendingDialog
          workId={workId}
          source={pending}
          open
          onClose={() => {
            setPending(undefined);
            void restrictions.reload();
          }}
        />
      )}
      {panel === 'late' && (
        <LateDialog
          rows={lateRows}
          onSelect={id => {
            setSelectedId(id);
            setShowTable(false);
            setPanel(undefined);
          }}
          onClose={() => setPanel(undefined)}
        />
      )}
    </section>
  );
}

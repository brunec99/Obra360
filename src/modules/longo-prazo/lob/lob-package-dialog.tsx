'use client';
import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, Plus, Trash2, X } from 'lucide-react';
import {
  LOB_LIMITS,
  isLobError,
  workdayDelta,
  type LobCalendar,
  type LobData,
  type LobId,
  type LobPackageEdit,
  type LobPackageRule,
  type LocalDate,
} from '@/domain/lob';
import { PACKAGE_LIMITS, isStartedActivity, packageLogic, planPackageEdit, type PackageEditPlan } from '@/domain/lob-package';
import { usePlanning } from '@/modules/planejamento/planning-provider';
import { Callout } from '@/modules/planejamento/ui';
import { formatDate } from '@/shared/format';

/** Janela "Editar o pacote" da Linha de Balanço (25/11/2026, pedido do Jorge Lucas: "configuração em
 * massa, onde eu consigo fazer com que todas as atividades daquele pacote tenham a mesma duração ou
 * então que tenha a mesma lógica de predecessoras"). Modelo aprovado pelo usuário em 25/11/2026, seção 2
 * (regras 7 a 11). O pacote é o serviço; os blocos dele são os do mesmo serviço em cada local.
 *
 * A janela monta a mesma configuração para todos os locais marcados e calcula a prévia no navegador com
 * o mesmo `planPackageEdit` que o servidor usa no comando `edit_service`: o que a prévia mostra é o que
 * será gravado. Nada é gravado até "Aplicar"; quem manda o comando é a visão, em `onApply`. Se a
 * gravação falhar, o motivo aparece aqui e a janela fica aberta; se der certo, a visão fecha. */

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('pt-BR')} ${n === 1 ? one : many}`;
const errorMessage = (error: unknown) => (error instanceof Error && error.message ? error.message : 'Falha na comunicação com o servidor.');
/** "mesmo local", "1 local abaixo", "2 locais acima". */
const offsetLabel = (offset: number) =>
  offset === 0 ? 'mesmo local' : `${plural(Math.abs(offset), 'local', 'locais')} ${offset < 0 ? 'abaixo' : 'acima'}`;
/** As opções do local da predecessora, na ordem do modelo: mesmo local, abaixo (1 a 3), acima (1 a 3). */
const OFFSETS = [
  0,
  ...Array.from({ length: PACKAGE_LIMITS.localOffset }, (_, i) => -(i + 1)),
  ...Array.from({ length: PACKAGE_LIMITS.localOffset }, (_, i) => i + 1),
];
/** Lista de nomes curta: até 6, depois "e mais N". */
const nameList = (names: string[], max = 6) =>
  names.length > max ? `${names.slice(0, max).join(', ')} e mais ${names.length - max}` : names.join(', ');
/** Hoje no fuso da obra, para o nome da linha de base quando a tela ainda não tem o planejamento. */
const localToday = (): LocalDate => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
/** Data de criação das ligações da prévia: nada daqui é gravado. */
const PREVIEW_NOW = '2000-01-01T00:00:00.000Z';
const LAG_ERROR = `Espera inválida: use de −${LOB_LIMITS.lagDays} a ${LOB_LIMITS.lagDays} dias úteis.`;
const DURATION_ERROR = `Duração inválida: informe de 1 a ${LOB_LIMITS.durationDays} dias úteis.`;
/** Inteiro do campo dentro do intervalo; vazio vale `empty`; inválido = indefinido. */
function parseInteger(text: string, min: number, max: number, empty?: number) {
  const value = text.trim();
  if (!value) return empty;
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

/** Uma linha de predecessora como a janela edita: a espera fica em texto enquanto a pessoa digita. */
interface RuleDraft {
  key: number;
  serviceId: LobId;
  localOffset: number;
  lagDays: string;
}
let ruleSeq = 0;

type Draft = { edit: LobPackageEdit; error?: undefined } | { edit?: undefined; error: string };
/** Os campos da janela viram o comando, com as mesmas recusas de forma do servidor (`parsePackageEdit`).
 * Regra de negócio (locais, ciclo, "nada a mudar") fica em `planPackageEdit`. */
function buildDraft(input: {
  serviceId: LobId;
  localIds: LobId[];
  duration: string;
  rhythm: LobPackageEdit['rhythm'];
  lag: string;
  rules: RuleDraft[];
  mode: LobPackageEdit['mode'];
}): Draft {
  const durationDays = parseInteger(input.duration, 1, LOB_LIMITS.durationDays);
  if (input.duration.trim() && durationDays === undefined) return { error: DURATION_ERROR };
  const lagDays = input.rhythm === 'chain' ? parseInteger(input.lag, -LOB_LIMITS.lagDays, LOB_LIMITS.lagDays, 0) : 0;
  if (lagDays === undefined) return { error: LAG_ERROR };
  const rules: LobPackageRule[] = input.rules.map(r => ({
    serviceId: r.serviceId,
    localOffset: r.localOffset,
    lagDays: parseInteger(r.lagDays, -LOB_LIMITS.lagDays, LOB_LIMITS.lagDays, 0) ?? NaN,
  }));
  if (rules.some(r => Number.isNaN(r.lagDays))) return { error: LAG_ERROR };
  if (new Set(rules.map(r => `${r.serviceId}|${r.localOffset}`)).size !== rules.length)
    return { error: 'A mesma predecessora aparece duas vezes. Deixe uma linha por pacote e local.' };
  return {
    edit: {
      serviceId: input.serviceId,
      localIds: input.localIds,
      ...(durationDays !== undefined && { durationDays }),
      rhythm: input.rhythm,
      lagDays,
      rules,
      mode: input.mode,
    },
  };
}
type Preview = { plan: PackageEditPlan; error?: undefined } | { plan?: undefined; error: string };

export function LobPackageDialog(props: {
  open: boolean;
  data: LobData;
  serviceId: string;
  busy?: boolean;
  onClose: () => void;
  onApply: (edit: LobPackageEdit) => Promise<void>;
}) {
  if (!props.open) return null;
  // Montada só enquanto aberta: cada abertura começa da lógica de hoje do pacote.
  return <PackageDialog {...props} />;
}

function PackageDialog({
  data,
  serviceId: initialServiceId,
  busy,
  onClose,
  onApply,
}: {
  data: LobData;
  serviceId: string;
  busy?: boolean;
  onClose: () => void;
  onApply: (edit: LobPackageEdit) => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const planning = usePlanning();
  const [fallbackToday] = useState(localToday);
  const today = planning.state === 'ready' ? planning.planning.today : fallbackToday;
  const [serviceId, setServiceId] = useState(initialServiceId);
  const [submitting, setSubmitting] = useState(false);
  /** Recusa do servidor, presa à configuração que a gerou: mudar qualquer campo tira o aviso. */
  const [failure, setFailure] = useState<{ edit: LobPackageEdit; message: string }>();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
      selectRef.current?.focus();
    }
    return () => dialog?.close();
  }, []);

  const { activities, services } = data;
  const counts = useMemo(() => {
    const map = new Map<LobId, number>();
    for (const a of activities) map.set(a.serviceId, (map.get(a.serviceId) ?? 0) + 1);
    return map;
  }, [activities]);
  // Pacotes com bloco na Linha de Balanço, na ordem dos serviços da obra.
  const packages = useMemo(
    () =>
      services
        .filter(s => counts.has(s.id) || s.id === serviceId)
        .sort((a, b) => a.orderIndex - b.orderIndex || a.name.localeCompare(b.name, 'pt-BR')),
    [services, counts, serviceId],
  );
  const service = services.find(s => s.id === serviceId);

  const submit = async (edit: LobPackageEdit) => {
    if (submitting || busy) return;
    setSubmitting(true);
    setFailure(undefined);
    try {
      await onApply(edit);
    } catch (error) {
      setFailure({ edit, message: errorMessage(error) });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <dialog
      ref={ref}
      aria-labelledby="lob-package-title"
      aria-describedby="lob-package-subtitle"
      onCancel={e => {
        e.preventDefault();
        if (!submitting) onClose();
      }}
      // Fechada pelo navegador sem passar pelo `cancel` (Esc repetido): avisa a visão. No modo estrito do
      // React a limpeza do efeito fecha e reabre a janela; aí ela já está aberta de novo e nada acontece.
      onClose={() => {
        if (!ref.current?.open) onClose();
      }}
      className="m-auto max-h-[92vh] w-[min(52rem,94vw)] overflow-hidden rounded-2xl border border-slate-200 bg-white p-0 shadow-xl backdrop:bg-slate-900/55"
    >
      <div className="flex max-h-[92vh] flex-col">
        <header className="border-b border-slate-100 px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <p className="eyebrow">Linha de Balanço</p>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <h3 id="lob-package-title" className="text-base font-bold text-slate-900">
                  Editar o pacote
                </h3>
                <label htmlFor="lob-package-service" className="sr-only">
                  Pacote
                </label>
                <div className="flex min-w-0 flex-[1_1_16rem] items-center gap-2">
                  <span aria-hidden className="h-3 w-3 shrink-0 rounded-sm" style={{ background: service?.color ?? '#8ea4b7' }} />
                  <select
                    ref={selectRef}
                    id="lob-package-service"
                    className="field min-w-0 flex-1 py-1.5"
                    value={serviceId}
                    disabled={submitting}
                    onChange={event => setServiceId(event.target.value)}
                  >
                    {packages.map(s => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({plural(counts.get(s.id) ?? 0, 'bloco', 'blocos')})
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <p id="lob-package-subtitle" className="mt-1.5 text-xs leading-5 text-slate-500">
                A mesma configuração em todos os locais marcados. Blocos já iniciados ficam de fora.
              </p>
            </div>
            <button
              type="button"
              className="button-ghost shrink-0 px-2"
              disabled={submitting}
              onClick={onClose}
              aria-label="Fechar sem aplicar"
            >
              <X size={16} aria-hidden />
            </button>
          </div>
        </header>
        {/* Trocar de pacote recomeça a janela da lógica de hoje do novo pacote. */}
        <PackageForm
          key={serviceId}
          data={data}
          serviceId={serviceId}
          today={today}
          busy={!!busy}
          submitting={submitting}
          failure={failure}
          onSubmit={submit}
          onCancel={onClose}
        />
      </div>
    </dialog>
  );
}

function PackageForm({
  data,
  serviceId,
  today,
  busy,
  submitting,
  failure,
  onSubmit,
  onCancel,
}: {
  data: LobData;
  serviceId: LobId;
  today: LocalDate;
  busy: boolean;
  submitting: boolean;
  failure?: { edit: LobPackageEdit; message: string };
  onSubmit: (edit: LobPackageEdit) => void;
  onCancel: () => void;
}) {
  const { activities, dependencies, locals, calendar, services } = data;
  const serviceName = useMemo(() => new Map(services.map(s => [s.id, s.name])), [services]);
  const localName = useMemo(() => new Map(locals.map(l => [l.id, l.name])), [locals]);
  const all = useMemo(() => activities.filter(a => a.serviceId === serviceId), [activities, serviceId]);
  /** Regra 7: os locais em que o pacote tem bloco, na ordem da obra (de baixo para cima). */
  const rows = useMemo(() => {
    const count = new Map<LobId, { total: number; started: number }>();
    for (const a of all) {
      const c = count.get(a.localId) ?? { total: 0, started: 0 };
      c.total++;
      if (isStartedActivity(a)) c.started++;
      count.set(a.localId, c);
    }
    return [...locals]
      .sort((a, b) => a.orderIndex - b.orderIndex)
      .flatMap(l => {
        const c = count.get(l.id);
        return c ? [{ id: l.id, name: l.name, ...c }] : [];
      });
  }, [all, locals]);
  const logic = useMemo(() => packageLogic({ activities, dependencies, locals }, serviceId), [activities, dependencies, locals, serviceId]);
  /** Pacotes que podem ser predecessora: os outros serviços com bloco. */
  const candidates = useMemo(() => {
    const withBlocks = new Set(activities.map(a => a.serviceId));
    return services
      .filter(s => s.id !== serviceId && withBlocks.has(s.id))
      .sort((a, b) => a.orderIndex - b.orderIndex || a.name.localeCompare(b.name, 'pt-BR'));
  }, [activities, services, serviceId]);

  const [marked, setMarked] = useState<ReadonlySet<LobId>>(() => new Set(rows.map(r => r.id)));
  const [duration, setDuration] = useState('');
  const [rhythm, setRhythm] = useState<LobPackageEdit['rhythm']>('chain');
  // A espera entre locais e a regra inicial abrem com a lógica mais comum de hoje do pacote.
  const [lag, setLag] = useState(() => String(logic.internal[0]?.lagDays ?? 0));
  const [rules, setRules] = useState<RuleDraft[]>(() => {
    const first = logic.external.find(e => Math.abs(e.localOffset) <= PACKAGE_LIMITS.localOffset);
    return first ? [{ key: ++ruleSeq, serviceId: first.serviceId, localOffset: first.localOffset, lagDays: String(first.lagDays) }] : [];
  });
  const [mode, setMode] = useState<LobPackageEdit['mode']>('replace');

  // O que vai para o servidor, conferido como o servidor confere (`parsePackageEdit`).
  const draft = useMemo(
    () => buildDraft({ serviceId, localIds: rows.filter(r => marked.has(r.id)).map(r => r.id), duration, rhythm, lag, rules, mode }),
    [serviceId, rows, marked, duration, rhythm, lag, rules, mode],
  );

  // Regra 11: a prévia acompanha cada mudança. O cálculo roda com o valor adiado, para a digitação não
  // esperar a rede da obra; enquanto ele não alcança, a prévia fica esmaecida e "Aplicar" espera.
  const deferred = useDeferredValue(draft);
  const stale = deferred !== draft;
  const preview = useMemo((): Preview => {
    if (!deferred.edit) return { error: deferred.error };
    try {
      let n = 0;
      const plan = planPackageEdit({ activities, dependencies, locals, calendar }, deferred.edit, {
        workId: activities[0]?.workId ?? '',
        now: PREVIEW_NOW,
        newId: () => `previa-${n++}`,
      });
      return { plan };
    } catch (error) {
      return { error: isLobError(error) ? error.message : 'Não foi possível calcular a prévia. Recarregue a página.' };
    }
  }, [deferred, activities, dependencies, locals, calendar]);
  const plan = preview.plan;

  const markedRows = rows.filter(r => marked.has(r.id));
  const blockCount = markedRows.reduce((sum, r) => sum + r.total - r.started, 0);
  const startedTotal = rows.reduce((sum, r) => sum + r.started, 0);
  // Regra 8: a duração de hoje dos blocos que a edição pega (sem nenhum marcado, a do pacote todo).
  const durationNote = (() => {
    const editable = all.filter(a => marked.has(a.localId) && !isStartedActivity(a));
    const list = editable.length ? editable : all;
    if (!list.length) return '';
    const days = list.map(a => a.durationDays);
    const min = Math.min(...days);
    const max = Math.max(...days);
    return min === max ? `Hoje: ${min} em todos` : `Hoje: de ${min} a ${max}`;
  })();
  const localOf = useMemo(() => new Map(activities.map(a => [a.id, a.localId])), [activities]);
  const position = useMemo(() => new Map(rows.map((r, i) => [r.id, i])), [rows]);
  /** Nomes dos locais, sem repetir, na ordem da obra. */
  const localNames = (ids: LobId[]) =>
    [...new Set(ids)].sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0)).map(id => localName.get(id) ?? 'local');

  const canApply = !!draft.edit && !!plan && !stale && !busy && !submitting;
  // Pelo conteúdo, não pela referência: uma recarga da obra refaz o rascunho igual e o aviso fica.
  const failed = failure && draft.edit && JSON.stringify(failure.edit) === JSON.stringify(draft.edit) ? failure.message : '';

  const toggle = (id: LobId) =>
    setMarked(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const updateRule = (key: number, patch: Partial<Omit<RuleDraft, 'key'>>) =>
    setRules(list => list.map(r => (r.key === key ? { ...r, ...patch } : r)));
  const addRule = () => {
    if (rules.length >= PACKAGE_LIMITS.rules || !candidates.length) return;
    const used = new Set(rules.map(r => r.serviceId));
    const next = candidates.find(s => !used.has(s.id)) ?? candidates[0];
    const key = ++ruleSeq;
    setRules(list => [...list, { key, serviceId: next.id, localOffset: 0, lagDays: '0' }]);
  };

  const row = 'grid gap-1.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-x-4';
  const rowLabel = 'text-sm font-semibold text-slate-700 sm:pt-2';
  const external = logic.external.slice(0, 4);

  return (
    <>
      <div className="custom-scrollbar flex-1 space-y-5 overflow-y-auto overflow-x-hidden px-5 py-4">
        {/* Locais (regra 7) */}
        <div className={row}>
          <p className={rowLabel}>
            Locais
            <span className="block text-xs font-normal text-slate-500">
              {markedRows.length} de {rows.length}
            </span>
          </p>
          <div className="min-w-0">
            {rows.length ? (
              <>
                <div className="mb-1.5 flex flex-wrap gap-3 text-xs">
                  <button type="button" className="text-link" onClick={() => setMarked(new Set(rows.map(r => r.id)))}>
                    Todos
                  </button>
                  <button type="button" className="text-link" onClick={() => setMarked(new Set())}>
                    Nenhum
                  </button>
                  <span className="text-slate-500">{plural(blockCount, 'bloco entra', 'blocos entram')} na edição</span>
                </div>
                <div role="group" aria-label="Locais do pacote" className="grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-1.5">
                  {rows.map(r => {
                    const on = marked.has(r.id);
                    const allStarted = r.started === r.total;
                    const startedNote = !r.started
                      ? ''
                      : allStarted
                        ? r.total === 1
                          ? 'iniciado'
                          : 'iniciados'
                        : plural(r.started, 'iniciado', 'iniciados');
                    return (
                      <button
                        key={r.id}
                        type="button"
                        role="checkbox"
                        aria-checked={on}
                        aria-label={`${r.name}${startedNote ? ` (${startedNote}: fica de fora)` : ''}`}
                        title={startedNote ? 'Bloco já iniciado: fica de fora da edição em massa' : undefined}
                        onClick={() => toggle(r.id)}
                        className={`flex min-w-0 items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-xs font-semibold ${
                          !on
                            ? 'border-slate-200 text-slate-400 line-through'
                            : allStarted
                              ? 'border-slate-200 bg-slate-50 text-slate-500'
                              : 'border-primary-ring bg-primary-soft text-primary-ink'
                        }`}
                      >
                        <span
                          aria-hidden
                          className={`grid h-3.5 w-3.5 shrink-0 place-items-center rounded border ${
                            !on
                              ? 'border-slate-300'
                              : allStarted
                                ? 'border-slate-400 bg-slate-400 text-white'
                                : 'border-primary bg-primary text-white'
                          }`}
                        >
                          {on && <Check size={10} strokeWidth={3} />}
                        </span>
                        <span className="min-w-0 truncate">{r.name}</span>
                        {startedNote && <span className="ml-auto shrink-0 text-[10px] font-medium text-slate-500">{startedNote}</span>}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-1.5 text-xs text-slate-500">
                  Ordem dos locais da obra, de baixo para cima.
                  {startedTotal > 0 && ' Bloco já iniciado aparece marcado, mas não entra: fica onde está.'}
                </p>
              </>
            ) : (
              <p className="text-sm text-slate-500 sm:pt-2">Este pacote não tem blocos nos locais da obra.</p>
            )}
          </div>
        </div>

        {/* Duração (regra 8) */}
        <div className={row}>
          <p className={rowLabel}>Duração</p>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <input
                id="lob-package-duration"
                type="number"
                inputMode="numeric"
                min={1}
                max={LOB_LIMITS.durationDays}
                className="field w-24 text-right tabular-nums"
                placeholder="manter"
                value={duration}
                onChange={event => setDuration(event.target.value)}
              />
              <label htmlFor="lob-package-duration" className="text-sm text-slate-700">
                Dias úteis em cada local
              </label>
              {durationNote && <span className="text-xs text-slate-500">{durationNote}</span>}
            </div>
            <p className="mt-1 text-xs text-slate-500">Vazio mantém a duração de cada bloco.</p>
          </div>
        </div>

        {/* Ritmo entre os locais (regra 9) */}
        <div className={row}>
          <p className={rowLabel}>Ritmo entre os locais</p>
          <div className="grid min-w-0 gap-1.5">
            <Choice
              name="lob-package-rhythm"
              checked={rhythm === 'chain'}
              onChange={() => setRhythm('chain')}
              title="Encadear"
              description="Cada local começa depois do término do anterior, na ordem de hoje (pela data de início), com a espera abaixo. Encurtar a duração também traz os locais para trás."
            >
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-600">
                <label htmlFor="lob-package-lag">Espera entre locais</label>
                <input
                  id="lob-package-lag"
                  type="number"
                  inputMode="numeric"
                  min={-LOB_LIMITS.lagDays}
                  max={LOB_LIMITS.lagDays}
                  className="field w-16 px-1.5 py-1 text-right text-xs tabular-nums"
                  value={lag}
                  disabled={rhythm !== 'chain'}
                  onChange={event => setLag(event.target.value)}
                />
                <span>dias úteis</span>
              </div>
            </Choice>
            <Choice
              name="lob-package-rhythm"
              checked={rhythm === 'keep'}
              onChange={() => setRhythm('keep')}
              title="Manter os inícios"
              description="Cada bloco fica onde está e só anda se a predecessora empurrar."
            />
          </div>
        </div>

        {/* Predecessoras de outros pacotes (regra 10) */}
        <div className={row}>
          <p className={rowLabel}>Predecessoras de outros pacotes</p>
          <div className="min-w-0 space-y-2">
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">
              <p>
                <b className="text-slate-700">Hoje neste pacote:</b>{' '}
                {external.length ? (
                  <>
                    {external.map((e, index) => (
                      <span key={`${e.serviceId}|${e.localOffset}|${e.lagDays}`}>
                        {index > 0 && '; '}
                        {e.count} de <b className="font-semibold text-slate-700">{serviceName.get(e.serviceId) ?? 'outro pacote'}</b> (
                        {offsetLabel(e.localOffset)}, espera {e.lagDays})
                      </span>
                    ))}
                    {logic.external.length > external.length &&
                      `; e mais ${plural(logic.external.length - external.length, 'combinação', 'combinações')}`}
                    .
                  </>
                ) : (
                  'nenhuma ligação vinda de outro pacote.'
                )}
              </p>
              <p>
                <b className="text-slate-700">Entre os próprios locais:</b>{' '}
                {logic.internal.length
                  ? `${logic.internal.map(i => `${i.count} com espera ${i.lagDays}`).join(', ')}.`
                  : 'nenhuma ligação.'}
              </p>
            </div>

            {rules.length ? (
              <ul className="space-y-1.5" aria-label="Predecessoras de outros pacotes">
                {rules.map((r, index) => {
                  const known = candidates.some(s => s.id === r.serviceId);
                  return (
                    <li key={r.key} className="flex flex-wrap items-center gap-1.5 rounded-lg border border-slate-200 bg-white p-2">
                      <select
                        aria-label={`Pacote da predecessora ${index + 1}`}
                        className="field min-w-0 flex-[1_1_12rem] py-1.5 text-xs"
                        value={r.serviceId}
                        onChange={event => updateRule(r.key, { serviceId: event.target.value })}
                      >
                        {!known && <option value={r.serviceId}>{serviceName.get(r.serviceId) ?? 'Pacote sem blocos'}</option>}
                        {candidates.map(s => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                      <select
                        aria-label={`Local da predecessora ${index + 1}`}
                        className="field w-auto py-1.5 text-xs"
                        value={r.localOffset}
                        onChange={event => updateRule(r.key, { localOffset: Number(event.target.value) })}
                      >
                        {OFFSETS.map(offset => (
                          <option key={offset} value={offset}>
                            {offsetLabel(offset)}
                          </option>
                        ))}
                      </select>
                      <span className="flex items-center gap-1 text-xs text-slate-600">
                        espera
                        <input
                          type="number"
                          inputMode="numeric"
                          min={-LOB_LIMITS.lagDays}
                          max={LOB_LIMITS.lagDays}
                          aria-label={`Espera da predecessora ${index + 1}, em dias úteis`}
                          className="field w-16 px-1.5 py-1 text-right text-xs tabular-nums"
                          value={r.lagDays}
                          onChange={event => updateRule(r.key, { lagDays: event.target.value })}
                        />
                        dias úteis
                      </span>
                      <button
                        type="button"
                        className="button-ghost ml-auto px-2 py-1 text-xs hover:text-danger"
                        onClick={() => setRules(list => list.filter(x => x.key !== r.key))}
                      >
                        <Trash2 size={13} aria-hidden /> Remover
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-xs text-slate-500">Nenhuma regra: as predecessoras de outros pacotes ficam como estão.</p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="button-ghost px-2.5 py-1.5 text-xs"
                disabled={rules.length >= PACKAGE_LIMITS.rules || !candidates.length}
                onClick={addRule}
              >
                <Plus size={13} aria-hidden /> Adicionar predecessora
              </button>
              <span className="text-xs text-slate-500">
                {!candidates.length
                  ? 'Nenhum outro pacote tem blocos nesta obra.'
                  : rules.length >= PACKAGE_LIMITS.rules
                    ? `Até ${PACKAGE_LIMITS.rules} predecessoras por vez.`
                    : 'O local conta pela ordem dos locais da obra, a partir de cada bloco do pacote.'}
              </span>
            </div>
            {rules.length > 0 && (
              <div className="grid gap-1.5 sm:grid-cols-2">
                <Choice
                  name="lob-package-mode"
                  checked={mode === 'replace'}
                  onChange={() => setMode('replace')}
                  title="Substituir as ligações que vêm desses pacotes"
                />
                <Choice name="lob-package-mode" checked={mode === 'add'} onChange={() => setMode('add')} title="Somar às ligações atuais" />
              </div>
            )}
          </div>
        </div>

        {/* Prévia (regra 11) */}
        <div className={row}>
          <p className={rowLabel}>Prévia</p>
          <div className={`min-w-0 space-y-2 transition-opacity ${stale ? 'opacity-60' : ''}`} aria-busy={stale}>
            {preview.error ? (
              <Callout tone="danger" role="alert">
                {preview.error}
              </Callout>
            ) : (
              plan && (
                <>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    <Stat
                      label="Blocos do pacote que mudam"
                      value={`${plan.changedBlocks} de ${all.length}`}
                      hint={`${plural(plan.blockIds.length, 'bloco', 'blocos')} na edição`}
                    />
                    <Stat
                      label="Ligações"
                      value={`+${plan.insert.length} · −${plan.remove.length}`}
                      hint={plan.update.length ? plural(plan.update.length, 'espera muda', 'esperas mudam') : 'nenhuma espera muda'}
                    />
                    <Stat label="Sucessoras empurradas" value={plan.pushed} hint="fora da edição, só para a frente" />
                    <Stat
                      label="Sucessoras com folga nova"
                      value={plan.slack.count}
                      hint={plan.slack.count ? `até ${plural(plan.slack.maxDays, 'dia útil', 'dias úteis')}` : 'nenhuma'}
                    />
                    <FinishStat label="Término do pacote" before={plan.finishBefore} after={plan.finishAfter} calendar={calendar} />
                    <FinishStat label="Término da obra" before={plan.workFinishBefore} after={plan.workFinishAfter} calendar={calendar} />
                  </div>
                  {plan.skipped.map((s, index) => (
                    <p key={`${s.serviceId}-${index}`} className="callout callout-warning text-xs leading-5">
                      Sem bloco correspondente em <b>{serviceName.get(s.serviceId) ?? 'outro pacote'}</b>:{' '}
                      {nameList(localNames(s.localIds))}. Esses locais ficam sem essa predecessora.
                    </p>
                  ))}
                  {plan.slack.count > 0 && (
                    <p className="callout callout-warning text-xs leading-5">
                      As sucessoras não são puxadas: {plural(plan.slack.count, 'bloco ganha', 'blocos ganham')} folga. Para aproveitar,
                      edite o pacote seguinte ou mova-o para trás.
                    </p>
                  )}
                  {plan.kept.length > 0 && (
                    <p className="callout callout-info text-xs leading-5">
                      {plural(plan.kept.length, 'bloco já iniciado fica', 'blocos já iniciados ficam')} de fora:{' '}
                      {nameList(localNames(plan.kept.map(id => localOf.get(id) ?? '')))}.
                    </p>
                  )}
                </>
              )
            )}
          </div>
        </div>
      </div>

      <footer className="flex flex-wrap items-center gap-3 border-t border-slate-100 bg-slate-50 px-5 py-3">
        {failed && (
          <p role="alert" className="basis-full text-xs font-semibold text-danger">
            {failed}
          </p>
        )}
        <p className="min-w-[12rem] flex-1 text-xs text-slate-500">
          {plan && !plan.changed.length
            ? 'Nenhuma data muda: só as ligações são gravadas.'
            : `Antes de gravar, o sistema guarda a linha de base "Antes da edição do pacote ${formatDate(today)}".`}
        </p>
        <button type="button" className="button-ghost" onClick={onCancel} disabled={submitting}>
          Cancelar
        </button>
        <button type="button" className="button" disabled={!canApply} onClick={() => draft.edit && canApply && onSubmit(draft.edit)}>
          {submitting ? 'Aplicando…' : `Aplicar a ${plural(blockCount, 'bloco', 'blocos')}`}
        </button>
      </footer>
    </>
  );
}

/** Opção de rádio em cartão, com explicação e, quando marcada, um campo próprio (fora do rótulo, para o
 * clique no campo não trocar a opção). */
function Choice({
  name,
  checked,
  onChange,
  title,
  description,
  children,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className={`rounded-lg border px-3 py-2 ${checked ? 'border-primary-ring bg-primary-soft' : 'border-slate-200'}`}>
      <label className="flex cursor-pointer items-start gap-2 text-sm">
        <input type="radio" name={name} className="mt-1 shrink-0 accent-primary" checked={checked} onChange={onChange} />
        <span className="min-w-0">
          <span className={`font-semibold ${checked ? 'text-primary-ink' : 'text-slate-700'}`}>{title}</span>
          {description && <span className="block text-xs leading-5 text-slate-600">{description}</span>}
        </span>
      </label>
      {children && <div className="mt-1.5 pl-6">{children}</div>}
    </div>
  );
}

function Stat({ label, value, hint, valueClassName = '' }: { label: string; value: ReactNode; hint?: ReactNode; valueClassName?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
      <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">{label}</p>
      <p className={`font-bold tabular-nums text-slate-900 ${valueClassName || 'text-lg'}`}>{value}</p>
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

/** Término antes → depois: verde quando adianta, vermelho quando atrasa, com a diferença em dias úteis. */
function FinishStat({ label, before, after, calendar }: { label: string; before: LocalDate; after: LocalDate; calendar?: LobCalendar }) {
  const delta = before && after ? workdayDelta(before, after, calendar) : 0;
  const tone = delta < 0 ? 'text-success' : delta > 0 ? 'text-danger' : 'text-slate-900';
  return (
    <Stat
      label={label}
      valueClassName="flex flex-wrap items-baseline gap-x-1.5 text-sm"
      value={
        <>
          <span className="font-semibold text-slate-500">{before ? formatDate(before) : '—'}</span>
          <span className="text-slate-400">→</span>
          <span className={tone}>{after ? formatDate(after) : '—'}</span>
        </>
      }
      hint={
        delta === 0
          ? 'sem mudança'
          : delta < 0
            ? `adianta ${plural(-delta, 'dia útil', 'dias úteis')}`
            : `atrasa ${plural(delta, 'dia útil', 'dias úteis')}`
      }
    />
  );
}

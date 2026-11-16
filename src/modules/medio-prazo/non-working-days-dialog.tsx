'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { monthGrid, shiftMonth } from './month-grid';
import { holidayNote, missingNationalHolidays, monthsSpan, normalizeDays, paintRange, toggleDay, weekdayOf } from './non-working-days';

/* "Dias sem trabalho" do Calendário de trabalho (16/11/2026, pedido do usuário: "está muito manual,
 * abra um calendário para que possamos selecionar dias não úteis"). Três meses lado a lado a partir do
 * início do cronograma; clique marca ou desmarca, arrastar ou Shift+clique marca um período, e um botão
 * marca os feriados nacionais dos meses à vista. Nada vai ao rascunho até "Aplicar", que reagenda as
 * tarefas de uma vez (um passo só no desfazer). */

const WEEKDAYS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
const WEEKDAY_NAMES = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const WEEKDAY_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const MONTH_TITLE = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const DAY_LABEL = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const utc = (date: string) => new Date(`${date}T00:00:00Z`);
const monthTitle = (month: string) => {
  const title = MONTH_TITLE.format(utc(`${month}-01`));
  return title.charAt(0).toUpperCase() + title.slice(1);
};
/** "Sex 25/12/26", como as datas da grade. */
export const shortDay = (date: string) => `${WEEKDAY_SHORT[weekdayOf(date)]} ${date.slice(8)}/${date.slice(5, 7)}/${date.slice(2, 4)}`;
const shiftDay = (date: string, delta: number) => new Date(utc(date).getTime() + delta * 86_400_000).toISOString().slice(0, 10);
/** O mesmo dia `delta` meses depois, preso ao último dia do mês (31/01 + 1 mês = 28/02). */
function shiftDayByMonth(date: string, delta: number) {
  const month = shiftMonth(date.slice(0, 7), delta);
  const day = `${month}-${date.slice(8)}`,
    last = monthsSpan(month, 1).to;
  return day > last ? last : day;
}
const MONTHS = 3;
const plural = (n: number, one: string, many: string) => `${n.toLocaleString('pt-BR')} ${n === 1 ? one : many}`;

interface Drag {
  anchor: string;
  to: string;
  mark: boolean;
}

export interface NonWorkingDaysDialogProps {
  /** Os dias sem trabalho do calendário do cronograma (AAAA-MM-DD). */
  initial: readonly string[];
  /** Dias úteis da semana (0 = domingo): os outros já não são trabalhados e não se marcam. */
  weekdays: readonly number[];
  /** Mês (AAAA-MM) em que o calendário abre: o início do horizonte do cronograma. */
  firstMonth: string;
  today: string;
  /** Edição liberada; sem ela o calendário só mostra. */
  canEdit: boolean;
  /** Grava a lista nova no rascunho e reagenda; devolve a mensagem de erro, se a grade recusar. */
  onApply: (days: string[]) => string | undefined;
  onClose: () => void;
}

export function NonWorkingDaysDialog({ initial, weekdays, firstMonth, today, canEdit, onApply, onClose }: NonWorkingDaysDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [start] = useState(() => normalizeDays(initial));
  const [days, setDays] = useState(start);
  const [first, setFirst] = useState(firstMonth);
  const [focus, setFocus] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  /** O último dia clicado e o que o clique fez com ele: o Shift+clique repete isso até o dia novo. */
  const last = useRef<{ day: string; mark: boolean } | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);
  // Soltar o botão em qualquer ponto encerra o arrasto; o período só vale se passou por outro dia.
  // Sem passar, quem marca é o clique do próprio dia.
  useEffect(() => {
    const end = () => {
      const current = dragRef.current;
      if (!current) return;
      dragRef.current = null;
      setDrag(null);
      if (current.to === current.anchor) return;
      setDays(d => paintRange(d, current.anchor, current.to, current.mark, weekdays));
      last.current = { day: current.to, mark: current.mark };
    };
    addEventListener('pointerup', end);
    addEventListener('pointercancel', end);
    return () => {
      removeEventListener('pointerup', end);
      removeEventListener('pointercancel', end);
    };
  }, [weekdays]);

  const months = Array.from({ length: MONTHS }, (_, i) => shiftMonth(first, i));
  const span = monthsSpan(first, MONTHS);
  const missing = missingNationalHolidays(days, span.from, span.to, weekdays);
  const shown = useMemo(
    () => new Set(drag && drag.to !== drag.anchor ? paintRange(days, drag.anchor, drag.to, drag.mark, weekdays) : days),
    [days, drag, weekdays],
  );
  const startSet = useMemo(() => new Set(start), [start]);
  const added = days.filter(d => !startSet.has(d)).length;
  const removed = start.length - (days.length - added);
  const changed = added > 0 || removed > 0;
  const workWeekday = (day: string) => weekdays.includes(weekdayOf(day));
  const clickable = (day: string) => canEdit && (workWeekday(day) || days.includes(day));
  // O dia que recebe o Tab: o último focado, se estiver à vista; senão hoje ou o primeiro dia dos meses.
  const tabStop = focus && focus >= span.from && focus <= span.to ? focus : today >= span.from && today <= span.to ? today : span.from;

  function onDayClick(day: string, e: MouseEvent) {
    setFocus(day);
    if (!clickable(day)) return;
    const previous = last.current;
    if (e.shiftKey && previous && previous.day !== day) {
      setDays(d => paintRange(d, previous.day, day, previous.mark, weekdays));
      last.current = { day, mark: previous.mark };
    } else {
      last.current = { day, mark: !days.includes(day) };
      setDays(d => toggleDay(d, day, weekdays));
    }
    setError('');
  }
  function onDayPointerDown(day: string, e: PointerEvent) {
    // Só o mouse arrasta: no toque, o dedo rola a página, e o período sai do Shift+clique ou de um dia por vez.
    if (e.pointerType !== 'mouse' || e.button !== 0 || e.shiftKey || !clickable(day)) return;
    const next = { anchor: day, to: day, mark: !days.includes(day) };
    dragRef.current = next;
    setDrag(next);
  }
  function onDayPointerEnter(day: string, e: PointerEvent) {
    const current = dragRef.current;
    if (!current || !(e.buttons & 1) || current.to === day) return;
    const next = { ...current, to: day };
    dragRef.current = next;
    setDrag(next);
  }
  /** Leva o foco ao dia, trocando os meses à vista quando ele sai deles. */
  function moveTo(day: string) {
    const month = day.slice(0, 7);
    if (month < first) setFirst(month);
    else if (month > months[MONTHS - 1]) setFirst(shiftMonth(month, -(MONTHS - 1)));
    setFocus(day);
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`[data-day="${day}"]`)?.focus());
  }
  function onDayKey(day: string, e: KeyboardEvent) {
    const step = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<string, number>)[e.key];
    const next = step
      ? shiftDay(day, step)
      : e.key === 'PageUp' || e.key === 'PageDown'
        ? shiftDayByMonth(day, e.key === 'PageUp' ? -1 : 1)
        : undefined;
    if (!next) return;
    e.preventDefault();
    moveTo(next);
  }
  function apply() {
    if (!canEdit || !changed) return onClose();
    const message = onApply(days);
    if (message) setError(message);
    else onClose();
  }

  const navButton = 'grid h-8 w-8 place-items-center rounded-md text-slate-600 hover:bg-slate-100 hover:text-slate-900';
  return (
    <dialog
      ref={ref}
      aria-labelledby="non-working-days-title"
      onCancel={e => {
        e.preventDefault();
        onClose();
      }}
      className="m-auto max-h-[92vh] w-[min(95vw,68rem)] overflow-hidden rounded-2xl border border-slate-200 bg-white p-0 shadow-xl backdrop:bg-slate-900/55"
    >
      <div className="flex max-h-[92vh] flex-col">
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0">
            <p className="eyebrow">Calendário de trabalho</p>
            <h3 id="non-working-days-title" className="mt-1 text-base font-bold text-slate-900">
              Dias sem trabalho
            </h3>
            <p className="mt-0.5 text-xs leading-5 text-slate-500">
              {canEdit
                ? 'Clique num dia para marcar ou desmarcar. Arraste ou use Shift+clique para marcar um período, como o recesso de fim de ano.'
                : 'Só consulta: libere a edição do cronograma para mudar os dias.'}
            </p>
          </div>
          <button type="button" className="button-ghost shrink-0 px-2" onClick={onClose} aria-label="Fechar sem aplicar">
            <X size={16} aria-hidden />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 overflow-auto lg:grid-cols-[minmax(0,1fr)_17rem]">
          <div className="min-w-0 px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                <button type="button" aria-label="Mês anterior" className={navButton} onClick={() => setFirst(m => shiftMonth(m, -1))}>
                  <ChevronLeft size={16} aria-hidden />
                </button>
                <span className="text-sm font-semibold text-slate-900" aria-live="polite">
                  {monthTitle(months[0])} a {monthTitle(months[MONTHS - 1])}
                </span>
                <button type="button" aria-label="Próximo mês" className={navButton} onClick={() => setFirst(m => shiftMonth(m, 1))}>
                  <ChevronRight size={16} aria-hidden />
                </button>
                {first !== firstMonth && (
                  <button
                    type="button"
                    className="ml-1 rounded-md px-2 py-1 text-xs font-semibold text-primary hover:bg-primary-soft"
                    onClick={() => setFirst(firstMonth)}
                  >
                    Voltar ao início
                  </button>
                )}
              </div>
              {canEdit && (
                <button
                  type="button"
                  className="button-secondary px-3 py-1.5 text-xs"
                  disabled={!missing.length}
                  title={missing.map(d => `${shortDay(d)} · ${holidayNote(d)?.name}`).join('\n') || undefined}
                  onClick={() => {
                    setDays(d => normalizeDays([...d, ...missing]));
                    setError('');
                  }}
                >
                  {missing.length
                    ? `Marcar ${plural(missing.length, 'feriado nacional', 'feriados nacionais')} destes meses`
                    : 'Feriados nacionais destes meses já marcados'}
                </button>
              )}
            </div>

            <div className="mt-3 grid gap-x-6 gap-y-4 select-none sm:grid-cols-2 xl:grid-cols-3">
              {months.map(month => (
                <section key={month} aria-label={monthTitle(month)} className="min-w-0">
                  <h4 className="mb-1 text-center text-sm font-semibold text-slate-800">{monthTitle(month)}</h4>
                  <div className="grid grid-cols-7 gap-0.5 text-center text-xs">
                    {WEEKDAYS.map((d, i) => (
                      <span key={i} title={WEEKDAY_NAMES[i]} aria-hidden className="py-1 text-[10px] font-semibold text-slate-400">
                        {d}
                      </span>
                    ))}
                    {monthGrid(month).map(day => {
                      if (day.slice(0, 7) !== month) return <span key={day} aria-hidden />;
                      const off = shown.has(day);
                      const note = holidayNote(day);
                      const can = clickable(day);
                      const tone = off
                        ? `bg-danger font-semibold text-white ${can ? 'hover:bg-rose-800' : ''}`
                        : !workWeekday(day)
                          ? 'bg-slate-50 text-slate-300'
                          : `text-slate-800 ${can ? 'hover:bg-slate-100' : ''}`;
                      const state = off ? 'sem trabalho' : workWeekday(day) ? 'dia útil' : 'fora dos dias úteis da semana';
                      const label = `${DAY_LABEL.format(utc(day))}${note ? `, ${note.name} (${note.kind === 'nacional' ? 'feriado nacional' : 'ponto facultativo'})` : ''}`;
                      return (
                        <button
                          key={day}
                          type="button"
                          data-day={day}
                          tabIndex={day === tabStop ? 0 : -1}
                          aria-label={label}
                          aria-pressed={off}
                          aria-disabled={!can || undefined}
                          aria-current={day === today ? 'date' : undefined}
                          title={`${label} — ${state}`}
                          onClick={e => onDayClick(day, e)}
                          onPointerDown={e => onDayPointerDown(day, e)}
                          onPointerEnter={e => onDayPointerEnter(day, e)}
                          onKeyDown={e => onDayKey(day, e)}
                          onFocus={() => setFocus(day)}
                          className={`relative h-8 rounded-md tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-primary ${tone} ${
                            day === today && !off ? 'font-semibold ring-1 ring-inset ring-primary' : ''
                          } ${can ? '' : 'cursor-default'}`}
                        >
                          {Number(day.slice(8))}
                          {note && (
                            <span
                              aria-hidden
                              className={`absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full ${
                                off ? 'bg-white' : note.kind === 'nacional' ? 'bg-warning' : 'bg-slate-400'
                              }`}
                            />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>

            <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-slate-500" aria-label="Legenda">
              <li className="inline-flex items-center gap-1.5">
                <span aria-hidden className="h-3 w-3 rounded bg-danger" /> Sem trabalho
              </li>
              <li className="inline-flex items-center gap-1.5">
                <span aria-hidden className="h-3 w-3 rounded border border-slate-200 bg-slate-50" /> Fora dos dias úteis da semana
              </li>
              <li className="inline-flex items-center gap-1.5">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-warning" /> Feriado nacional
              </li>
              <li className="inline-flex items-center gap-1.5">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-slate-400" /> Ponto facultativo (Carnaval, Corpus Christi)
              </li>
              <li className="inline-flex items-center gap-1.5">
                <span aria-hidden className="h-3 w-3 rounded ring-1 ring-inset ring-primary" /> Hoje
              </li>
            </ul>
          </div>

          <aside className="flex min-h-0 flex-col border-t border-slate-100 px-5 py-4 lg:border-l lg:border-t-0" aria-label="Dias marcados">
            <div className="flex items-baseline justify-between gap-2">
              <h4 className="whitespace-nowrap text-sm font-semibold text-slate-800">
                {days.length ? plural(days.length, 'dia marcado', 'dias marcados') : 'Nenhum dia marcado'}
              </h4>
              {canEdit && days.length > 0 && (
                <button
                  type="button"
                  className="whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-semibold text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                  onClick={() => {
                    setDays([]);
                    setError('');
                  }}
                >
                  Desmarcar todos
                </button>
              )}
            </div>
            {days.length ? (
              <ul className="mt-2 max-h-72 space-y-0.5 overflow-auto text-xs lg:max-h-none lg:flex-1">
                {days.map(day => {
                  const note = holidayNote(day);
                  const visible = day >= span.from && day <= span.to;
                  return (
                    <li key={day} className="group flex items-center justify-between gap-1 rounded-md hover:bg-slate-50">
                      <button
                        type="button"
                        className={`min-w-0 flex-1 px-1.5 py-1 text-left ${visible ? 'text-slate-800' : 'text-slate-500'}`}
                        title={visible ? undefined : 'Mostrar no calendário'}
                        onClick={() => moveTo(day)}
                      >
                        <span className="tabular-nums">{shortDay(day)}</span>
                        {!startSet.has(day) && <span className="ml-1.5 text-[11px] font-semibold text-success">novo</span>}
                        {note && <span className="block truncate text-[11px] text-slate-500">{note.name}</span>}
                      </button>
                      {canEdit && (
                        <button
                          type="button"
                          aria-label={`Desmarcar ${shortDay(day)}`}
                          className="grid h-6 w-6 shrink-0 place-items-center rounded text-slate-400 hover:bg-slate-200 hover:text-slate-800"
                          onClick={() => {
                            setDays(d => d.filter(x => x !== day));
                            setError('');
                          }}
                        >
                          <X size={12} aria-hidden />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="mt-2 text-xs leading-5 text-slate-500">
                Os fins de semana já ficam fora pelos dias úteis da semana. Marque aqui feriados, pontos facultativos e recessos.
              </p>
            )}
          </aside>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-slate-100 px-5 py-3">
          {error && (
            <p role="alert" className="mr-auto text-xs font-semibold text-danger">
              {error}
            </p>
          )}
          {canEdit && !error && changed && (
            <p className="mr-auto text-xs text-slate-500">
              {[added && plural(added, 'dia marcado', 'dias marcados'), removed && plural(removed, 'desmarcado', 'desmarcados')]
                .filter(Boolean)
                .join(' e ')}
              . Ao aplicar, as tarefas são reagendadas no rascunho.
            </p>
          )}
          {canEdit ? (
            <>
              <button type="button" className="button-ghost" onClick={onClose}>
                Cancelar
              </button>
              <button type="button" className="button" disabled={!changed} onClick={apply}>
                Aplicar
              </button>
            </>
          ) : (
            <button type="button" className="button-ghost" onClick={onClose}>
              Fechar
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
}

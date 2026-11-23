'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { calendarChangePreview, lobSpan, type LobCalendar, type LobData, type LocalDate } from '@/domain/lob';
import { DEFAULT_LOB_CALENDAR, LOB_CALENDAR_MAX_HOLIDAYS, sameLobCalendar, weekdaysLabel } from '@/domain/lob-calendar';
import { monthGrid, shiftMonth } from '@/modules/medio-prazo/month-grid';
import {
  holidayNote,
  missingNationalHolidays,
  monthsSpan,
  normalizeDays,
  paintRange,
  toggleDay,
  weekdayOf,
} from '@/modules/medio-prazo/non-working-days';
import { calendarPreviewText } from './lob-model';

/* Calendário de dias úteis da Linha de Balanço, por obra (23/11/2026, retorno de quem vem do Prevision).
 * Duas escolhas num diálogo só: (1) os dias da semana trabalhados e (2) os dias sem trabalho (feriados
 * e recessos), num calendário clicável de três meses no molde do "Dias sem trabalho" do médio prazo
 * (`medio-prazo/non-working-days-dialog.tsx`, de onde vêm as regras puras; a tela é uma adaptação
 * própria porque lá os dias da semana são fixos e a gravação é no rascunho).
 *
 * Nada é gravado até a confirmação. "Revisar e aplicar" calcula a prévia no navegador, com a mesma
 * função pura do servidor (`calendarChangePreview`): quantos blocos mudam de data e para quando vai o
 * término da obra. As durações em dias úteis ficam; o início que cair em dia sem trabalho vai ao
 * próximo dia útil e a rede é recalculada em cascata. O servidor guarda antes a linha de base
 * automática "Antes da mudança de calendário". */

const WEEKDAYS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
const WEEKDAY_NAMES = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const WEEKDAY_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
/** Ordem dos botões: a semana de trabalho começa na segunda. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const MONTH_TITLE = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const DAY_LABEL = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const utc = (date: string) => new Date(`${date}T00:00:00Z`);
const monthTitle = (month: string) => {
  const title = MONTH_TITLE.format(utc(`${month}-01`));
  return title.charAt(0).toUpperCase() + title.slice(1);
};
/** "Sex 25/12/26". */
const shortDay = (date: string) => `${WEEKDAY_SHORT[weekdayOf(date)]} ${date.slice(8)}/${date.slice(5, 7)}/${date.slice(2, 4)}`;
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
const errorMessage = (error: unknown) => (error instanceof Error && error.message ? error.message : 'Falha na comunicação com o servidor.');

interface Drag {
  anchor: string;
  to: string;
  mark: boolean;
}

export interface LobCalendarDialogProps {
  /** A obra carregada: o calendário atual (`data.calendar`, ausente = padrão) e os blocos para a prévia. */
  data: Pick<LobData, 'activities' | 'dependencies' | 'calendar'>;
  today: LocalDate;
  /** Quem pode editar a Linha de Balanço altera; consulta só vê. */
  canEdit: boolean;
  /** Grava o calendário (comando `set_calendar`); erro vira exceção com a mensagem para a tela. */
  onApply: (calendar: LobCalendar) => Promise<void>;
  onClose: () => void;
}

export function LobCalendarDialog({ data, today, canEdit, onApply, onClose }: LobCalendarDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [current] = useState<LobCalendar>(() => ({
    weekdays: [...(data.calendar ?? DEFAULT_LOB_CALENDAR).weekdays].sort((a, b) => a - b),
    holidays: normalizeDays((data.calendar ?? DEFAULT_LOB_CALENDAR).holidays),
  }));
  const [weekdays, setWeekdays] = useState<number[]>(current.weekdays);
  const [days, setDays] = useState<string[]>(current.holidays);
  const firstMonth = today.slice(0, 7);
  const [first, setFirst] = useState(firstMonth);
  const [focus, setFocus] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
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
  useEffect(() => {
    const end = () => {
      const active = dragRef.current;
      if (!active) return;
      dragRef.current = null;
      setDrag(null);
      if (active.to === active.anchor) return;
      setDays(d => paintRange(d, active.anchor, active.to, active.mark, weekdays));
      last.current = { day: active.to, mark: active.mark };
    };
    addEventListener('pointerup', end);
    addEventListener('pointercancel', end);
    return () => {
      removeEventListener('pointerup', end);
      removeEventListener('pointercancel', end);
    };
  }, [weekdays]);

  const draft = useMemo<LobCalendar>(() => ({ weekdays, holidays: days }), [weekdays, days]);
  const changed = !sameLobCalendar(current, draft);
  const months = Array.from({ length: MONTHS }, (_, i) => shiftMonth(first, i));
  const span = monthsSpan(first, MONTHS);
  // Atalho dos feriados nacionais: do mês de hoje (ou do primeiro mês à vista, se estiver antes) até o
  // fim do ano em que a obra termina (ou o fim dos meses à vista, se for depois). Feriado de mês
  // passado só entra se a pessoa navegar até ele: datas de blocos já executados não mudam sem querer.
  const obra = useMemo(() => lobSpan(data.activities, data.calendar), [data.activities, data.calendar]);
  const obraEnd = obra && obra.finish >= today ? `${obra.finish.slice(0, 4)}-12-31` : span.to;
  const todayMonth = `${today.slice(0, 7)}-01`;
  const holidayRange = { from: span.from < todayMonth ? span.from : todayMonth, to: obraEnd > span.to ? obraEnd : span.to };
  const holidayRangeLabel = `${holidayRange.from.slice(5, 7)}/${holidayRange.from.slice(0, 4)} a ${holidayRange.to.slice(5, 7)}/${holidayRange.to.slice(0, 4)}`;
  const missing = useMemo(
    () => missingNationalHolidays(days, holidayRange.from, holidayRange.to, weekdays),
    [days, holidayRange.from, holidayRange.to, weekdays],
  );
  const shown = useMemo(
    () => new Set(drag && drag.to !== drag.anchor ? paintRange(days, drag.anchor, drag.to, drag.mark, weekdays) : days),
    [days, drag, weekdays],
  );
  const startSet = useMemo(() => new Set(current.holidays), [current]);
  const added = days.filter(d => !startSet.has(d)).length;
  const removed = current.holidays.length - (days.length - added);
  const weekChanged = weekdays.length !== current.weekdays.length || weekdays.some((d, i) => d !== current.weekdays[i]);
  const tooMany = days.length > LOB_CALENDAR_MAX_HOLIDAYS;
  const workWeekday = (day: string) => weekdays.includes(weekdayOf(day));
  const editing = canEdit && !review && !busy;
  const clickable = (day: string) => editing && (workWeekday(day) || days.includes(day));
  // O dia que recebe o Tab: o último focado, se estiver à vista; senão hoje ou o primeiro dia dos meses.
  const tabStop = focus && focus >= span.from && focus <= span.to ? focus : today >= span.from && today <= span.to ? today : span.from;
  // A prévia só é calculada na revisão: a cascata de uma obra grande não roda a cada clique.
  const preview = useMemo(
    () => (review ? calendarChangePreview(data.activities, data.dependencies, data.calendar, draft) : undefined),
    [review, data.activities, data.dependencies, data.calendar, draft],
  );

  function toggleWeekday(day: number) {
    if (!editing) return;
    setWeekdays(list => {
      const next = list.includes(day) ? list.filter(d => d !== day) : [...list, day].sort((a, b) => a - b);
      // Ao menos um dia trabalhado: desmarcar o último não faz nada.
      return next.length ? next : list;
    });
    setError('');
  }
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
    const active = dragRef.current;
    if (!active || !(e.buttons & 1) || active.to === day) return;
    const next = { ...active, to: day };
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
  async function apply() {
    if (!canEdit || !changed || busy) return;
    setBusy(true);
    setError('');
    try {
      await onApply(draft);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }

  const navButton = 'grid h-8 w-8 place-items-center rounded-md text-slate-600 hover:bg-slate-100 hover:text-slate-900';
  const changes = [
    weekChanged && `semana de trabalho: ${weekdaysLabel(weekdays)}`,
    added && plural(added, 'dia marcado', 'dias marcados'),
    removed && plural(removed, 'desmarcado', 'desmarcados'),
  ].filter(Boolean);
  return (
    <dialog
      ref={ref}
      aria-labelledby="lob-calendar-title"
      onCancel={e => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      className="m-auto max-h-[92vh] w-[min(95vw,68rem)] overflow-hidden rounded-2xl border border-slate-200 bg-white p-0 shadow-xl backdrop:bg-slate-900/55"
    >
      <div className="flex max-h-[92vh] flex-col">
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0">
            <p className="eyebrow">Linha de Balanço</p>
            <h3 id="lob-calendar-title" className="mt-1 text-base font-bold text-slate-900">
              Calendário da obra
            </h3>
            <p className="mt-0.5 text-xs leading-5 text-slate-500">
              {canEdit
                ? 'Os dias úteis desta obra na Linha de Balanço: datas dos blocos, dependências, previsto, atraso e IDP contam por este calendário. As durações em dias úteis não mudam.'
                : 'Só consulta: quem pode editar a Linha de Balanço altera o calendário.'}
            </p>
          </div>
          <button type="button" className="button-ghost shrink-0 px-2" disabled={busy} onClick={onClose} aria-label="Fechar sem aplicar">
            <X size={16} aria-hidden />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 overflow-auto lg:grid-cols-[minmax(0,1fr)_17rem]">
          <div className="min-w-0 px-5 py-4">
            <section aria-labelledby="lob-calendar-week">
              <h4 id="lob-calendar-week" className="text-sm font-semibold text-slate-800">
                Dias da semana trabalhados
              </h4>
              <div className="mt-2 flex flex-wrap items-center gap-1.5" role="group" aria-labelledby="lob-calendar-week">
                {WEEK_ORDER.map(day => {
                  const on = weekdays.includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      aria-pressed={on}
                      aria-label={WEEKDAY_NAMES[day]}
                      disabled={!editing || (on && weekdays.length === 1)}
                      title={on && weekdays.length === 1 ? 'A obra precisa de ao menos um dia trabalhado na semana' : WEEKDAY_NAMES[day]}
                      onClick={() => toggleWeekday(day)}
                      className={`h-8 min-w-12 rounded-lg border px-2.5 text-xs font-semibold transition-colors disabled:cursor-default ${
                        on ? 'border-primary bg-primary text-white' : 'border-slate-200 bg-white text-slate-500'
                      } ${editing && !(on && weekdays.length === 1) ? (on ? 'hover:opacity-90' : 'hover:border-slate-300 hover:text-slate-800') : ''}`}
                    >
                      {WEEKDAY_SHORT[day]}
                    </button>
                  );
                })}
                <span className="ml-1 text-xs text-slate-500">{weekdaysLabel(weekdays)}</span>
              </div>
            </section>

            <section aria-labelledby="lob-calendar-days" className="mt-5">
              <h4 id="lob-calendar-days" className="text-sm font-semibold text-slate-800">
                Dias sem trabalho
              </h4>
              <p className="mt-0.5 text-xs leading-5 text-slate-500">
                {canEdit
                  ? 'Clique num dia para marcar ou desmarcar. Arraste ou use Shift+clique para marcar um período, como o recesso de fim de ano.'
                  : 'Feriados e recessos marcados para esta obra.'}
              </p>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
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
                      Voltar a hoje
                    </button>
                  )}
                </div>
                {canEdit && (
                  <button
                    type="button"
                    className="button-secondary px-3 py-1.5 text-xs"
                    disabled={!missing.length || !editing}
                    title={
                      missing
                        .slice(0, 40)
                        .map(d => `${shortDay(d)} · ${holidayNote(d)?.name}`)
                        .join('\n') || undefined
                    }
                    onClick={() => {
                      setDays(d => normalizeDays([...d, ...missing]));
                      setError('');
                    }}
                  >
                    {missing.length
                      ? `Incluir ${plural(missing.length, 'feriado nacional que falta', 'feriados nacionais que faltam')} (${holidayRangeLabel})`
                      : `Feriados nacionais de ${holidayRangeLabel} já marcados`}
                  </button>
                )}
              </div>

              <div className="mt-3 grid gap-x-6 gap-y-4 select-none sm:grid-cols-2 xl:grid-cols-3">
                {months.map(month => (
                  <section key={month} aria-label={monthTitle(month)} className="min-w-0">
                    <h5 className="mb-1 text-center text-sm font-semibold text-slate-800">{monthTitle(month)}</h5>
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
                        const state = off ? 'sem trabalho' : workWeekday(day) ? 'dia útil' : 'fora dos dias da semana trabalhados';
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
                  <span aria-hidden className="h-3 w-3 rounded border border-slate-200 bg-slate-50" /> Fora dos dias da semana trabalhados
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
            </section>
          </div>

          <aside className="flex min-h-0 flex-col border-t border-slate-100 px-5 py-4 lg:border-l lg:border-t-0" aria-label="Dias marcados">
            <div className="flex items-baseline justify-between gap-2">
              <h4 className="whitespace-nowrap text-sm font-semibold text-slate-800">
                {days.length ? plural(days.length, 'dia marcado', 'dias marcados') : 'Nenhum dia marcado'}
              </h4>
              {editing && days.length > 0 && (
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
                      {editing && (
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
                Os dias fora da semana de trabalho já não contam. Marque aqui feriados, pontos facultativos e recessos.
              </p>
            )}
          </aside>
        </div>

        {review && preview && (
          <div className="border-t border-slate-100 px-5 py-3" role="status" aria-live="polite">
            <p className="callout callout-warning text-sm leading-6">
              <strong>{calendarPreviewText(preview, data.activities.length)}</strong>{' '}
              {preview.changedBlocks > 0 &&
                'As durações em dias úteis ficam como estão: o início que cair em dia sem trabalho vai para o próximo dia útil e as sucessoras acompanham. Antes de gravar, o sistema guarda a linha de base automática “Antes da mudança de calendário”, para comparar ou restaurar depois.'}
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-slate-100 px-5 py-3">
          {error && (
            <p role="alert" className="mr-auto text-xs font-semibold text-danger">
              {error}
            </p>
          )}
          {canEdit && !error && tooMany && (
            <p role="alert" className="mr-auto text-xs font-semibold text-danger">
              O calendário aceita no máximo {LOB_CALENDAR_MAX_HOLIDAYS.toLocaleString('pt-BR')} dias sem trabalho.
            </p>
          )}
          {canEdit && !error && !tooMany && changed && !review && (
            <p className="mr-auto text-xs text-slate-500">{changes.join(' · ')}. Antes de gravar, você vê quantos blocos mudam de data.</p>
          )}
          {!canEdit ? (
            <button type="button" className="button-ghost" onClick={onClose}>
              Fechar
            </button>
          ) : review ? (
            <>
              <button type="button" className="button-ghost" disabled={busy} onClick={() => setReview(false)}>
                Voltar
              </button>
              <button type="button" className="button" disabled={busy || !changed} onClick={apply}>
                {busy ? 'Gravando…' : 'Confirmar e aplicar'}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="button-ghost" onClick={onClose}>
                Cancelar
              </button>
              <button
                type="button"
                className="button"
                disabled={!changed || tooMany}
                onClick={() => {
                  setError('');
                  setReview(true);
                }}
              >
                Revisar e aplicar
              </button>
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}

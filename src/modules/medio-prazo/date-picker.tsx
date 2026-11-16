'use client';

import { useLayoutEffect, useState, type CSSProperties, type RefObject, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { isWorking, type WorkCalendar } from '@/domain/plan-schedule';
import { monthGrid, shiftMonth } from './month-grid';

const WEEKDAYS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
const WEEKDAY_NAMES = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const MONTH_TITLE = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const DAY_LABEL = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const utc = (date: string) => new Date(`${date}T00:00:00Z`);
const WIDTH = 248;
/** Altura aproximada (seis semanas + cabeçalho + rodapé), para decidir se abre embaixo ou em cima. */
const HEIGHT = 290;
// O calendário vai para o body; eventos de portal sobem pela árvore React e não podem chegar à grade.
const stop = (event: SyntheticEvent) => event.stopPropagation();

/**
 * Calendário que abre sob a célula de data da grade do cronograma. O foco fica no campo de texto da
 * célula (o mousedown aqui é cancelado), então digitar continua valendo e o Esc, o Enter e o Tab da
 * grade seguem iguais. Escolher um dia chama `onPick` com a data; "Limpar" chama com `undefined`.
 */
export function DatePopover({
  anchor,
  value,
  today,
  calendar,
  clearable,
  label,
  onPick,
}: {
  anchor: RefObject<HTMLElement | null>;
  /** A data que está no campo, se o texto digitado for uma data válida. */
  value?: string;
  today: string;
  /** Calendário de trabalho do cronograma: fins de semana e feriados saem esmaecidos. */
  calendar: WorkCalendar;
  clearable?: boolean;
  label: string;
  onPick: (date: string | undefined) => void;
}) {
  const [month, setMonth] = useState((value ?? today).slice(0, 7));
  // Data digitada no campo leva o calendário ao mês dela (ajuste durante o render, sem efeito).
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    if (value) setMonth(value.slice(0, 7));
  }
  const [box, setBox] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const below = innerHeight - rect.bottom - 8,
        above = rect.top - 8;
      const up = below < HEIGHT && above > below;
      setBox({
        position: 'fixed',
        left: Math.max(8, Math.min(rect.left, innerWidth - WIDTH - 8)),
        width: WIDTH,
        ...(up ? { bottom: innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
      });
    };
    place();
    addEventListener('resize', place);
    addEventListener('scroll', place, true);
    return () => {
      removeEventListener('resize', place);
      removeEventListener('scroll', place, true);
    };
  }, [anchor]);
  if (!box) return null;

  const title = MONTH_TITLE.format(utc(`${month}-01`));
  const navButton = 'grid h-7 w-7 place-items-center rounded-md text-slate-600 hover:bg-slate-100 hover:text-slate-900';
  const footButton = 'rounded-md px-2 py-1 text-xs font-semibold';
  return createPortal(
    <div
      role="dialog"
      aria-label={label}
      data-date-popover=""
      style={box}
      // Mantém o foco no campo da célula: sem isso, o clique aqui tiraria o foco e gravaria a célula antes da escolha.
      onMouseDown={e => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onPointerDown={stop}
      onClick={stop}
      onDoubleClick={stop}
      onKeyDown={stop}
      className="z-50 select-none rounded-xl border border-slate-200 bg-white p-2 text-xs font-normal text-slate-700 shadow-lg"
    >
      <div className="flex items-center justify-between">
        <button
          type="button"
          tabIndex={-1}
          aria-label="Mês anterior"
          className={navButton}
          onClick={() => setMonth(m => shiftMonth(m, -1))}
        >
          <ChevronLeft size={16} aria-hidden />
        </button>
        <span className="text-sm font-semibold text-slate-900" aria-live="polite">
          {title.charAt(0).toUpperCase() + title.slice(1)}
        </span>
        <button type="button" tabIndex={-1} aria-label="Próximo mês" className={navButton} onClick={() => setMonth(m => shiftMonth(m, 1))}>
          <ChevronRight size={16} aria-hidden />
        </button>
      </div>
      <div className="mt-1 grid grid-cols-7 gap-0.5 text-center">
        {WEEKDAYS.map((d, i) => (
          <span key={i} title={WEEKDAY_NAMES[i]} aria-hidden className="py-1 text-[10px] font-semibold text-slate-400">
            {d}
          </span>
        ))}
        {monthGrid(month).map(day => {
          const chosen = day === value;
          const outside = day.slice(0, 7) !== month;
          const tone = chosen
            ? 'bg-primary font-semibold text-white hover:bg-primary-strong'
            : `${outside ? 'text-slate-300' : isWorking(day, calendar) ? 'text-slate-800' : 'text-slate-400'} hover:bg-slate-100`;
          return (
            <button
              key={day}
              type="button"
              tabIndex={-1}
              aria-label={DAY_LABEL.format(utc(day))}
              aria-pressed={chosen}
              aria-current={day === today ? 'date' : undefined}
              onClick={() => onPick(day)}
              className={`h-7 rounded-md tabular-nums ${tone} ${day === today && !chosen ? 'font-semibold ring-1 ring-inset ring-primary' : ''}`}
            >
              {Number(day.slice(8))}
            </button>
          );
        })}
      </div>
      <div className="mt-1.5 flex items-center justify-between border-t border-slate-100 pt-1.5">
        <button type="button" tabIndex={-1} className={`${footButton} text-primary hover:bg-primary-soft`} onClick={() => onPick(today)}>
          Hoje
        </button>
        {clearable && (
          <button
            type="button"
            tabIndex={-1}
            className={`${footButton} text-slate-600 hover:bg-slate-100`}
            onClick={() => onPick(undefined)}
          >
            Limpar
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}

import { easterSunday, nationalHolidayName } from '@/domain/holidays';

/* Regras puras do calendário "Dias sem trabalho" do cronograma (16/11/2026): marcar e desmarcar dias,
 * períodos (recesso) e os feriados nacionais de uma faixa de meses. A lista é a `holidays` do
 * `WorkCalendar`, em AAAA-MM-DD, ordenada e sem repetição. */

const DAY_MS = 86_400_000;
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
const fromDayNumber = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);
export const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** Ponto facultativo que costuma parar a obra: Carnaval (segunda e terça) e Corpus Christi. Não é
 * feriado nacional (`src/domain/holidays.ts`), então só aparece como sugestão no calendário. */
export function optionalHolidayName(date: string): string | undefined {
  const offset = dayNumber(date) - dayNumber(easterSunday(Number(date.slice(0, 4))));
  if (offset === -48 || offset === -47) return 'Carnaval';
  if (offset === 60) return 'Corpus Christi';
  return undefined;
}

export interface HolidayNote {
  name: string;
  kind: 'nacional' | 'facultativo';
}
/** O feriado nacional ou o ponto facultativo do dia, para a dica do calendário. */
export function holidayNote(date: string): HolidayNote | undefined {
  const national = nationalHolidayName(date);
  if (national) return { name: national, kind: 'nacional' };
  const optional = optionalHolidayName(date);
  return optional ? { name: optional, kind: 'facultativo' } : undefined;
}

/** Ordenada e sem repetição. */
export const normalizeDays = (days: Iterable<string>) => [...new Set(days)].sort();

/** Os dias de `a` a `b`, em qualquer ordem, os dois inclusive. */
export function daysBetween(a: string, b: string): string[] {
  const [from, to] = a <= b ? [a, b] : [b, a];
  const days: string[] = [];
  for (let day = dayNumber(from), end = dayNumber(to); day <= end; day++) days.push(fromDayNumber(day));
  return days;
}

/**
 * Marca ou desmarca o período de `from` a `to`. Ao marcar, só entram os dias da semana de trabalho:
 * o recesso que atravessa um fim de semana não vira feriado no sábado, como na importação do Project.
 * Ao desmarcar, sai tudo do período, inclusive feriado que tinha ficado num dia que deixou de ser útil.
 */
export function paintRange(days: readonly string[], from: string, to: string, mark: boolean, weekdays: readonly number[]): string[] {
  const range = daysBetween(from, to);
  if (!mark) {
    const out = new Set(range);
    return days.filter(d => !out.has(d));
  }
  return normalizeDays([...days, ...range.filter(d => weekdays.includes(weekdayOf(d)))]);
}

/** O dia passa a ser sem trabalho, ou volta a ser útil. */
export const toggleDay = (days: readonly string[], day: string, weekdays: readonly number[]) =>
  paintRange(days, day, day, !days.includes(day), weekdays);

/** Feriados nacionais de `from` a `to` que caem em dia da semana de trabalho e ainda não estão na lista. */
export function missingNationalHolidays(days: readonly string[], from: string, to: string, weekdays: readonly number[]): string[] {
  const have = new Set(days);
  return daysBetween(from, to).filter(d => !have.has(d) && weekdays.includes(weekdayOf(d)) && nationalHolidayName(d) !== undefined);
}

/** Primeiro e último dia dos `count` meses a partir de `month` (AAAA-MM). */
export function monthsSpan(month: string, count: number): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  return {
    from: `${month}-01`,
    to: new Date(Date.UTC(y, m - 1 + count, 0)).toISOString().slice(0, 10),
  };
}

/** A frase ao lado do botão "Dias sem trabalho": os dias que caem no período do cronograma (até seis
 * datas) e, quando há outros fora dele, o total. */
export function offDaysSummary(days: readonly string[], period: { start: string; end: string }): string {
  if (!days.length) return 'Nenhum dia marcado.';
  const inside = days.filter(d => d >= period.start && d <= period.end).sort();
  const list = inside.slice(0, 6).map(d => `${d.slice(8)}/${d.slice(5, 7)}`);
  const head = inside.length
    ? `${inside.length} ${inside.length === 1 ? 'dia' : 'dias'} no período: ${list.join(', ')}${inside.length > 6 ? '…' : ''}`
    : 'Nenhum dia no período';
  return inside.length === days.length ? head : `${head} · ${days.length} no total`;
}

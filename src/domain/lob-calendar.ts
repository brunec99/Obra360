/** Calendário de dias úteis da Linha de Balanço, POR OBRA (23/11/2026, retorno de quem vem do
 * Prevision): os dias da semana trabalhados e os dias sem trabalho (feriados e recessos). Vale para
 * todas as contas de dias úteis da Linha de Balanço: datas dos blocos, cascata das dependências,
 * lançamento de fluxo, previsto, atraso, caminho crítico e IDP.
 *
 * O padrão é segunda a sexta, sem feriados, que era a regra fixa até aqui: obra sem calendário gravado
 * (ou banco sem a migração 0056) calcula exatamente as mesmas datas de antes.
 *
 * As durações dos blocos são sempre em dias úteis DESTE calendário e não são convertidas quando ele
 * muda: mudam as datas (ver `applyCalendar` em `lob.ts`). */
import { isLocalDate, toMs, type LocalDate } from './long-term-plan';

export interface LobCalendar {
  /** Dias da semana trabalhados (0 = domingo … 6 = sábado), em ordem e sem repetição. */
  weekdays: number[];
  /** Dias sem trabalho (AAAA-MM-DD), em ordem e sem repetição. */
  holidays: LocalDate[];
}

export const DEFAULT_LOB_CALENDAR: LobCalendar = { weekdays: [1, 2, 3, 4, 5], holidays: [] };
export const defaultLobCalendar = (): LobCalendar => ({ weekdays: [...DEFAULT_LOB_CALENDAR.weekdays], holidays: [] });

/** Teto de dias sem trabalho por obra: cabe uma obra de dez anos com recessos, e barra lista colada com lixo. */
export const LOB_CALENDAR_MAX_HOLIDAYS = 1500;

/** Consulta rápida por calendário: a cascata de uma obra grande pergunta "é dia útil?" milhares de vezes. */
interface Lookup {
  week: boolean[];
  off: Set<LocalDate>;
}
const lookups = new WeakMap<LobCalendar, Lookup>();
const DEFAULT_WEEK = [false, true, true, true, true, true, false];
function lookupOf(calendar: LobCalendar): Lookup {
  let lookup = lookups.get(calendar);
  if (!lookup) {
    const week = [0, 1, 2, 3, 4, 5, 6].map(day => calendar.weekdays.includes(day));
    // Sem nenhum dia da semana (não passa pela validação), vale o padrão: a conta nunca fica sem dia útil.
    lookup = { week: week.some(Boolean) ? week : DEFAULT_WEEK, off: new Set(calendar.holidays) };
    lookups.set(calendar, lookup);
  }
  return lookup;
}

/** Dia trabalhado no calendário; sem calendário, segunda a sexta. */
export function isWorkingDay(date: LocalDate, calendar?: LobCalendar): boolean {
  const day = new Date(toMs(date)).getUTCDay();
  if (!calendar) return day !== 0 && day !== 6;
  const lookup = lookupOf(calendar);
  return lookup.week[day] && !lookup.off.has(date);
}

export const sameLobCalendar = (a: LobCalendar | undefined, b: LobCalendar | undefined) => {
  const x = a ?? DEFAULT_LOB_CALENDAR,
    y = b ?? DEFAULT_LOB_CALENDAR;
  return (
    x.weekdays.length === y.weekdays.length &&
    x.weekdays.every((d, i) => d === y.weekdays[i]) &&
    x.holidays.length === y.holidays.length &&
    x.holidays.every((d, i) => d === y.holidays[i])
  );
};
export const isDefaultLobCalendar = (calendar: LobCalendar | undefined) => sameLobCalendar(calendar, DEFAULT_LOB_CALENDAR);

/** Confere e limpa um calendário vindo de fora (navegador ou banco): dias da semana de 0 a 6, ao menos
 * um; dias sem trabalho em AAAA-MM-DD; os dois em ordem e sem repetição. Lança `Error` com a mensagem
 * pronta para a tela. */
export function normalizeLobCalendar(input: unknown): LobCalendar {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (!Array.isArray(raw.weekdays) || !raw.weekdays.every(d => Number.isInteger(d) && d >= 0 && d <= 6))
    throw new Error('Dias da semana trabalhados inválidos.');
  const weekdays = [...new Set(raw.weekdays as number[])].sort((a, b) => a - b);
  if (!weekdays.length) throw new Error('Marque ao menos um dia da semana trabalhado.');
  if (!Array.isArray(raw.holidays) || !raw.holidays.every(d => isLocalDate(d))) throw new Error('Lista de dias sem trabalho inválida.');
  const holidays = [...new Set(raw.holidays as LocalDate[])].sort();
  if (holidays.length > LOB_CALENDAR_MAX_HOLIDAYS)
    throw new Error(`O calendário aceita no máximo ${LOB_CALENDAR_MAX_HOLIDAYS} dias sem trabalho.`);
  return { weekdays, holidays };
}

const WEEKDAY_NAMES = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
/** "segunda a sexta", "segunda a sábado", "segunda, quarta e sexta". */
export function weekdaysLabel(weekdays: readonly number[]): string {
  const days = [...new Set(weekdays)].sort((a, b) => a - b);
  if (!days.length) return 'nenhum dia';
  if (days.length === 7) return 'todos os dias';
  const names = days.map(d => WEEKDAY_NAMES[d]);
  if (days.length >= 3 && days.every((d, i) => i === 0 || d === days[i - 1] + 1)) return `${names[0]} a ${names[names.length - 1]}`;
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`;
}
/** "segunda a sexta, sem feriados" / "segunda a sábado, com 12 dias sem trabalho". */
export function lobCalendarLabel(calendar: LobCalendar | undefined): string {
  const c = calendar ?? DEFAULT_LOB_CALENDAR;
  const off = c.holidays.length;
  return `${weekdaysLabel(c.weekdays)}, ${off ? `com ${off} ${off === 1 ? 'dia sem trabalho marcado' : 'dias sem trabalho marcados'}` : 'sem feriados marcados'}`;
}

import type { LocalDate } from './entities';
import { addDays } from './validation';

/** Acessos ao Obra 360 (15/11/2026, modelo aprovado "Aba Acessos no Dashboard geral"): o navegador conta o tempo
 * ativo em cada tela e manda ao servidor (`POST /api/acessos`); a aba "Acessos" do Dashboard geral, só para admin,
 * mostra quem entrou, em quais módulos e por quanto tempo. Este arquivo tem o que o servidor e a tela dividem: o
 * catálogo das telas (regra 6), a leitura do endereço, o aparelho (regra 8), o período em dias corridos (regra 7)
 * e os formatos de tempo. As contas da tela ficam em `access-report.ts`. Funções puras. */

/** Grupos da barra "Onde passa o tempo", na ordem do menu. */
export type AccessGroup = 'dash' | 'prazo' | 'ctrl' | 'sst' | 'adm';
export const ACCESS_GROUPS: readonly { id: AccessGroup; label: string }[] = [
  { id: 'dash', label: 'Dashboards e lista de obras' },
  { id: 'prazo', label: '1 Prazo' },
  { id: 'ctrl', label: '2 Controles de obra' },
  { id: 'sst', label: '3 SST' },
  { id: 'adm', label: 'Apoio e administração' },
];

export interface AccessScreen {
  /** A seção da obra (`curto-prazo`) ou a tela fora da obra (`obras`, `dashboard-geral`…). É o que fica gravado. */
  key: string;
  /** O número do menu (12/11/2026); as telas de apoio e as de fora da obra não têm. */
  number?: string;
  label: string;
  group: AccessGroup;
  /** Fora das obras: Lista de obras, Dashboard geral e as telas de administração. */
  outside?: boolean;
}

/** Regra 6: o módulo vem da tela aberta. Na ordem do menu; Vagões leva o 1.1 do longo prazo, por onde abre. */
export const ACCESS_SCREENS: readonly AccessScreen[] = [
  { key: 'obras', label: 'Lista de obras', group: 'dash', outside: true },
  { key: 'dashboard-geral', label: 'Dashboard geral', group: 'dash', outside: true },
  { key: 'dashboard', number: '0', label: 'Dashboard da obra', group: 'dash' },
  { key: 'longo-prazo', number: '1.1', label: 'Longo prazo', group: 'prazo' },
  { key: 'vagoes', number: '1.1', label: 'Vagões', group: 'prazo' },
  { key: 'medio-prazo', number: '1.2', label: 'Médio prazo', group: 'prazo' },
  { key: 'curto-prazo', number: '1.3', label: 'Curto prazo', group: 'prazo' },
  { key: 'restricoes', number: '1.4', label: 'Quadro de Restrições', group: 'prazo' },
  { key: 'terminalidade', number: '2.1', label: 'Terminalidade', group: 'ctrl' },
  { key: 'histograma', number: '2.2', label: 'Histograma', group: 'ctrl' },
  { key: 'produtividade', number: '2.3', label: 'Produtividade', group: 'ctrl' },
  { key: 'diario', number: '2.4', label: 'Diário de Obra', group: 'ctrl' },
  { key: 'seguranca', number: '3.1', label: 'Vistoria de segurança', group: 'sst' },
  { key: 'checklist', number: '3.2', label: 'Checklist de equipamentos', group: 'sst' },
  { key: 'federacao', label: 'Modelo federado', group: 'adm' },
  { key: 'ifc', label: 'Arquivos IFC', group: 'adm' },
  { key: 'dividas', label: 'Dívidas', group: 'adm' },
  { key: 'importar', label: 'Integrações', group: 'adm' },
  { key: 'configuracoes', label: 'Configurações da obra', group: 'adm' },
  { key: 'configuracoes-gerais', label: 'Configurações', group: 'adm', outside: true },
  { key: 'agente', label: 'Agente de IA', group: 'adm', outside: true },
];
const SCREEN_BY_KEY = new Map(ACCESS_SCREENS.map(screen => [screen.key, screen]));
const SCREEN_ORDER = new Map(ACCESS_SCREENS.map((screen, index) => [screen.key, index]));
/** A tela pelo que ficou gravado; uma chave que o catálogo não conhece (tela removida) aparece pelo nome cru. */
export const accessScreen = (key: string): AccessScreen => SCREEN_BY_KEY.get(key) ?? { key, label: key, group: 'adm' };
/** "1.3 Curto prazo", "Dashboard geral". */
export const screenLabel = (key: string): string => {
  const screen = accessScreen(key);
  return screen.number ? `${screen.number} ${screen.label}` : screen.label;
};
/** Ordem do menu, para desempatar e para a lista de módulos sem uso. */
export const screenOrder = (key: string): number => SCREEN_ORDER.get(key) ?? ACCESS_SCREENS.length;
/** Telas com modo de campo no celular (`/campo/…`). */
export const FIELD_SCREENS = new Set(['seguranca', 'terminalidade', 'diario']);

/** Regra 8: computador ou celular/tablet, pelo navegador. */
export type AccessDevice = 'desktop' | 'mobile';
export const DEVICE_LABEL: Record<AccessDevice, string> = { desktop: 'Computador', mobile: 'Celular' };
export function deviceOfUserAgent(userAgent: string | null | undefined): AccessDevice {
  return /Mobi|Android|iPhone|iPad|iPod|Tablet|Silk|Kindle/i.test(userAgent ?? '') ? 'mobile' : 'desktop';
}

/** O que um registro de tempo grava além da pessoa e dos segundos. */
export interface AccessTarget {
  screen: string;
  /** A obra da tela; `null` nas telas fora das obras e no modo de campo sem `?obra=`. */
  workId: string | null;
  /** Modo de campo (`/campo/seguranca`, `/campo/terminalidade`, `/campo/diario`). */
  field: boolean;
}
const WORK_SCREENS = new Set(ACCESS_SCREENS.filter(screen => !screen.outside).map(screen => screen.key));
/** Ids de obra são texto (0001); aceitamos o que o sistema gera e nada que pareça outra coisa. */
const WORK_ID = /^[A-Za-z0-9_-]{1,80}$/;
const workIdOf = (raw: string | null | undefined): string | null => {
  if (!raw) return null;
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return WORK_ID.test(id) ? id : null;
};

/** A tela e a obra de um endereço do sistema. `null` = endereço que não conta (impressão, login, rota desconhecida).
 * No modo de campo a obra não está no caminho: vem do `?obra=` que o navegador manda à parte (`fieldWorkId`). */
export function screenOfPath(path: string, fieldWorkId?: string | null): AccessTarget | null {
  if (typeof path !== 'string' || path.length > 400) return null;
  const clean = path.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  if (clean === '/obras') return { screen: 'obras', workId: null, field: false };
  if (clean === '/dashboard' || clean.startsWith('/dashboard/')) return { screen: 'dashboard-geral', workId: null, field: false };
  if (clean === '/configuracoes/agente') return { screen: 'agente', workId: null, field: false };
  if (clean === '/configuracoes' || clean.startsWith('/configuracoes/'))
    return { screen: 'configuracoes-gerais', workId: null, field: false };
  const work = clean.match(/^\/obras\/([^/]+)\/([^/]+)(?:\/.*)?$/);
  if (work) {
    const workId = workIdOf(work[1]);
    return workId && WORK_SCREENS.has(work[2]) ? { screen: work[2], workId, field: false } : null;
  }
  const field = clean.match(/^\/campo\/([^/]+)$/);
  if (field && FIELD_SCREENS.has(field[1])) return { screen: field[1], workId: workIdOf(fieldWorkId), field: true };
  return null;
}

/** Limites de um registro: o navegador manda a cada minuto (no máximo 120 s); 300 s é folga para atraso. */
export const MAX_RECORD_SECONDS = 300;
/** Regra 9: "No sistema agora" = uso ativo nos últimos 5 minutos. */
export const ONLINE_MS = 5 * 60_000;

// ---------------------------------------------------------------- período (regra 7)

export type AccessPeriodKind = 'hoje' | '7d' | '30d' | 'mes' | 'mes-anterior' | 'intervalo';
export const ACCESS_PERIOD_KINDS: readonly { kind: AccessPeriodKind; label: string }[] = [
  { kind: 'hoje', label: 'Hoje' },
  { kind: '7d', label: '7 dias' },
  { kind: '30d', label: '30 dias' },
  { kind: 'mes', label: 'Este mês' },
  { kind: 'mes-anterior', label: 'Mês anterior' },
  { kind: 'intervalo', label: 'Intervalo' },
];
export const DEFAULT_ACCESS_PERIOD: AccessPeriodKind = '7d';
export const isAccessPeriodKind = (value: unknown): value is AccessPeriodKind => ACCESS_PERIOD_KINDS.some(item => item.kind === value);
/** Teto do intervalo: a guarda é de 13 meses (regra 15). */
export const MAX_ACCESS_DAYS = 400;

export interface AccessPeriodChoice {
  kind: AccessPeriodKind;
  /** Só no intervalo. */
  from?: LocalDate;
  to?: LocalDate;
}
export interface AccessPeriod {
  kind: AccessPeriodKind;
  from: LocalDate;
  to: LocalDate;
  /** Todos os dias, corridos, de `from` a `to`. */
  days: LocalDate[];
  /** O período anterior do mesmo tamanho, para as setas dos cartões. */
  previousFrom: LocalDate;
  previousTo: LocalDate;
  /** Para a frase: "nos últimos 7 dias", "em outubro". */
  phrase: string;
  /** Para a linha de escopo: "sáb 07/11 a sex 13/11". */
  label: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const isLocalDate = (value: unknown): value is LocalDate =>
  typeof value === 'string' && DATE.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
export const daysBetween = (from: LocalDate, to: LocalDate): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
export function dayList(from: LocalDate, to: LocalDate): LocalDate[] {
  const out: LocalDate[] = [];
  for (let day = from; day <= to && out.length <= MAX_ACCESS_DAYS + 31; day = addDays(day, 1)) out.push(day);
  return out;
}
/** O período anterior do mesmo tamanho, colado antes de `from`. */
export function previousRange(from: LocalDate, to: LocalDate): { previousFrom: LocalDate; previousTo: LocalDate } {
  const length = daysBetween(from, to) + 1;
  return { previousFrom: addDays(from, -length), previousTo: addDays(from, -1) };
}

const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const MONTHS = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];
export const weekdayOf = (day: LocalDate): string => WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()];
/** "13/11". */
export const dayMonthOf = (day: LocalDate): string => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
/** "sex 13/11". */
export const shortDay = (day: LocalDate): string => `${weekdayOf(day)} ${dayMonthOf(day)}`;

/** Resolve a escolha da tela contra o dia de hoje em Brasília. Intervalo inválido cai nos 7 dias; datas trocadas se
 * invertem; nada passa de hoje; o intervalo tem no máximo `MAX_ACCESS_DAYS` dias (fica o fim). */
export function resolveAccessPeriod(choice: AccessPeriodChoice, today: LocalDate): AccessPeriod {
  let kind = choice.kind;
  let from: LocalDate;
  let to: LocalDate = today;
  let phrase: string;
  if (kind === 'intervalo' && !(isLocalDate(choice.from) && isLocalDate(choice.to))) kind = DEFAULT_ACCESS_PERIOD;
  switch (kind) {
    case 'hoje':
      from = today;
      phrase = 'hoje';
      break;
    case '30d':
      from = addDays(today, -29);
      phrase = 'nos últimos 30 dias';
      break;
    case 'mes':
      from = `${today.slice(0, 8)}01`;
      phrase = 'neste mês';
      break;
    case 'mes-anterior': {
      to = addDays(`${today.slice(0, 8)}01`, -1);
      from = `${to.slice(0, 8)}01`;
      phrase = `em ${MONTHS[Number(to.slice(5, 7)) - 1]}`;
      break;
    }
    case 'intervalo': {
      let a = choice.from as LocalDate;
      let b = choice.to as LocalDate;
      if (a > b) [a, b] = [b, a];
      if (b > today) b = today;
      if (a > b) a = b;
      if (daysBetween(a, b) + 1 > MAX_ACCESS_DAYS) a = addDays(b, -(MAX_ACCESS_DAYS - 1));
      from = a;
      to = b;
      phrase = from === to ? `em ${dayMonthOf(from)}` : `de ${dayMonthOf(from)} a ${dayMonthOf(to)}`;
      break;
    }
    default:
      kind = '7d';
      from = addDays(today, -6);
      phrase = 'nos últimos 7 dias';
  }
  const label = from === to ? shortDay(from) : `${shortDay(from)} a ${shortDay(to)}`;
  return { kind, from, to, days: dayList(from, to), ...previousRange(from, to), phrase, label };
}

// ---------------------------------------------------------------- formatos

/** Tempo para cartões e tabelas: "9 h 40", "46 min", "2 h", "< 1 min". */
export function formatDuration(seconds: number): string {
  if (!(seconds > 0)) return '0 min';
  const minutes = Math.round(seconds / 60);
  if (minutes === 0) return '< 1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${String(rest).padStart(2, '0')}` : `${hours} h`;
}
/** Tempo para a frase: "52 h 10 min". */
export function formatDurationLong(seconds: number): string {
  const short = formatDuration(seconds);
  return /h \d{2}$/.test(short) ? `${short} min` : short;
}

/** Dia e hora em Brasília de um instante gravado em UTC. */
export function brasiliaMoment(iso: string): { day: LocalDate; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(iso))
      .map(part => [part.type, part.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** "agora", "há 3 min", "hoje 11:02", "ontem 17:52", "qui 12/11 10:22", "02/11/2026". */
export function relativeMoment(iso: string, nowIso: string): string {
  const diff = Date.parse(nowIso) - Date.parse(iso);
  if (diff < 60_000) return 'agora';
  if (diff < 60 * 60_000) return `há ${Math.floor(diff / 60_000)} min`;
  const at = brasiliaMoment(iso);
  const today = brasiliaMoment(nowIso).day;
  if (at.day === today) return `hoje ${at.time}`;
  const back = daysBetween(at.day, today);
  if (back === 1) return `ontem ${at.time}`;
  if (back > 1 && back < 7) return `${shortDay(at.day)} ${at.time}`;
  return `${dayMonthOf(at.day)}/${at.day.slice(0, 4)}`;
}

/** "sex 13/11 · 10:55 – agora" (sessão em andamento) ou "qui 12/11 · 08:02 – 09:48". */
export function sessionRange(startedAt: string, lastAt: string, nowIso: string): string {
  const start = brasiliaMoment(startedAt);
  const end = brasiliaMoment(lastAt);
  const open = Date.parse(nowIso) - Date.parse(lastAt) <= ONLINE_MS;
  const endText = open ? 'agora' : end.day === start.day ? end.time : `${shortDay(end.day)} ${end.time}`;
  return `${shortDay(start.day)} · ${start.time} – ${endText}`;
}

// ---------------------------------------------------------------- dados que a rota entrega à tela

export type AccessRole = 'viewer' | 'planner' | 'manager' | 'admin';
/** Papel para o filtro: o TST é o papel consulta com a marca de técnico (0040), como no menu. */
export type AccessRoleKey = AccessRole | 'tst';
export const ACCESS_ROLE_LABEL: Record<AccessRoleKey, string> = {
  admin: 'Admin',
  manager: 'Gestor',
  planner: 'Planejador',
  viewer: 'Consulta',
  tst: 'TST',
};
export const ACCESS_ROLE_ORDER: readonly AccessRoleKey[] = ['admin', 'manager', 'planner', 'viewer', 'tst'];

export interface AccessPerson {
  id: string;
  name: string;
  role: AccessRole;
  tst: boolean;
  workIds: string[];
  createdAt: string;
  email?: string;
  /** Último login guardado pelo Supabase Auth (dividido com o Takt Hub): o único dado de antes da medição. */
  lastSignInAt?: string;
}
export const roleKeyOf = (person: Pick<AccessPerson, 'role' | 'tst'>): AccessRoleKey =>
  person.role === 'viewer' && person.tst ? 'tst' : person.role;

export interface AccessWork {
  id: string;
  name: string;
  code: string;
}
export interface AccessSessionRow {
  id: string;
  profileId: string;
  startedAt: string;
  lastAt: string;
  seconds: number;
}
/** Segundos ativos de uma sessão numa tela, num dia (Brasília), numa obra, num aparelho. */
export interface AccessUsageRow {
  sessionId: string;
  profileId: string;
  day: LocalDate;
  workId: string | null;
  screen: string;
  field: boolean;
  device: AccessDevice;
  seconds: number;
  lastAt: string;
}
/** O registro mais recente de cada pessoa, de qualquer data: o "Último acesso". */
export interface AccessLastSeen {
  profileId: string;
  at: string;
  workId: string | null;
  screen: string;
  field: boolean;
  device: AccessDevice;
}
/** Resposta de `GET /api/dashboard/acessos?de=&ate=`: o período pedido e o anterior do mesmo tamanho. */
export interface AccessPayload {
  /** Hora do servidor, para "agora" e "há 3 min". */
  now: string;
  from: LocalDate;
  to: LocalDate;
  previousFrom: LocalDate;
  previousTo: LocalDate;
  /** `false` enquanto a migração 0051 não foi aplicada: tudo vem vazio e a tela avisa. */
  migrated: boolean;
  /** Primeiro dia com algum registro guardado ("medindo desde"). */
  since?: LocalDate;
  people: AccessPerson[];
  works: AccessWork[];
  /** Sessões com uso entre `previousFrom` e `to`. */
  sessions: AccessSessionRow[];
  /** Uso entre `previousFrom` e `to`. */
  usage: AccessUsageRow[];
  last: AccessLastSeen[];
}

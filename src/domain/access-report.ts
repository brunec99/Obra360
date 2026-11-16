import type { LocalDate } from './entities';
import { startOfWeek } from './validation';
import {
  ACCESS_GROUPS,
  ACCESS_ROLE_LABEL,
  ACCESS_SCREENS,
  ONLINE_MS,
  accessScreen,
  dayMonthOf,
  formatDurationLong,
  relativeMoment,
  roleKeyOf,
  screenLabel,
  screenOrder,
  sessionRange,
  shortDay,
  type AccessDevice,
  type AccessGroup,
  type AccessPayload,
  type AccessPeriod,
  type AccessPerson,
  type AccessRoleKey,
  type AccessUsageRow,
} from './access-usage';

/** As contas da aba "Acessos" (15/11/2026, modelo aprovado): cartões e frase (regra 9), a tabela por pessoa e o
 * detalhe dela (regra 10), tempo por módulo e por obra (regra 11) e o uso por dia (regra 12). Tudo sai das linhas de
 * uso que a rota entrega (`AccessPayload`), recortadas pelos filtros na própria tela: trocar filtro não vai ao
 * servidor. Funções puras; a tela só desenha. */

/** Chave do filtro de obras para as telas fora das obras. */
export const OUTSIDE_WORKS = 'fora';
export const OUTSIDE_WORKS_LABEL = 'Fora das obras';
/** Até 31 dias, uma coluna por dia no "Uso por dia"; mais que isso, uma por semana (regra 12). */
export const HEAT_DAY_LIMIT = 31;

/** Regra 11: pessoa e papel recortam quem aparece; obra, módulo e aparelho recortam o uso. Ausente = todos. */
export interface AccessFilters {
  people?: ReadonlySet<string>;
  roles?: ReadonlySet<AccessRoleKey>;
  /** Ids de obra e `OUTSIDE_WORKS`. */
  works?: ReadonlySet<string>;
  screens?: ReadonlySet<string>;
  devices?: ReadonlySet<AccessDevice>;
}
export const hasUsageFilter = (filters: AccessFilters) => !!(filters.works || filters.screens || filters.devices);
export const hasAnyFilter = (filters: AccessFilters) => !!(filters.people || filters.roles || hasUsageFilter(filters));

const personMatches = (filters: AccessFilters) => (person: AccessPerson) =>
  (!filters.people || filters.people.has(person.id)) && (!filters.roles || filters.roles.has(roleKeyOf(person)));
const usageMatches = (filters: AccessFilters) => (row: Pick<AccessUsageRow, 'workId' | 'screen' | 'device'>) =>
  (!filters.works || filters.works.has(row.workId ?? OUTSIDE_WORKS)) &&
  (!filters.screens || filters.screens.has(row.screen)) &&
  (!filters.devices || filters.devices.has(row.device));

/** As pessoas e as linhas de uso que passam pelos filtros, separadas em período e período anterior. A planilha
 * (.csv) usa o mesmo recorte. */
export function filteredUsage(payload: AccessPayload, filters: AccessFilters) {
  const people = payload.people.filter(personMatches(filters));
  const ids = new Set(people.map(person => person.id));
  const matches = usageMatches(filters);
  const rows = payload.usage.filter(row => ids.has(row.profileId) && row.seconds > 0 && matches(row));
  return {
    people,
    current: rows.filter(row => row.day >= payload.from && row.day <= payload.to),
    previous: rows.filter(row => row.day >= payload.previousFrom && row.day <= payload.previousTo),
  };
}

/** Nome da obra para a tela; nomes repetidos levam o código. Id que não existe mais = obra excluída (o uso fica). */
export function workLabeler(payload: Pick<AccessPayload, 'works'>): (workId: string | null) => string {
  const count = new Map<string, number>();
  for (const work of payload.works) count.set(work.name, (count.get(work.name) ?? 0) + 1);
  const names = new Map(
    payload.works.map(work => [work.id, (count.get(work.name) ?? 0) > 1 && work.code ? `${work.name} (${work.code})` : work.name]),
  );
  return workId => (workId === null ? OUTSIDE_WORKS_LABEL : (names.get(workId) ?? 'Obra excluída'));
}

export interface AccessKpis {
  /** Pessoas com uso no período (no recorte). */
  entered: number;
  enteredPrevious: number;
  /** Pessoas no universo dos filtros de pessoa e papel. */
  registered: number;
  seconds: number;
  secondsPrevious: number;
  /** Média por pessoa que entrou. */
  averageSeconds: number;
  sessions: number;
  averageSessionSeconds: number;
  /** Uso ativo nos últimos 5 minutos (a última tela passa pelos filtros de uso). */
  online: { id: string; name: string }[];
  /** Cadastradas sem uso no período. */
  absent: number;
  /** Sem registro nenhum e sem login no Supabase. */
  never: number;
}

export interface AccessScreenShare {
  screen: string;
  label: string;
  group: AccessGroup;
  seconds: number;
  /** Parte do tempo da pessoa (ou do total), de 0 a 1. */
  share: number;
  /** Parte deste tempo feita no modo de campo, de 0 a 1. */
  fieldShare: number;
}

export interface AccessLast {
  /** "agora", "hoje 11:02"… ou, sem uso medido, "último login 28/10". */
  text: string;
  /** A tela do último acesso ("1.3 Curto prazo · Horizonte"); vazio quando só há o login. */
  where: string;
  source: 'usage' | 'login';
  /** O login é anterior ao primeiro dia medido. */
  beforeMeasurement?: boolean;
}

export interface AccessPersonRow {
  person: AccessPerson;
  roleKey: AccessRoleKey;
  roleLabel: string;
  /** "Horizonte, Mirante", "todas as obras", "nenhuma obra". */
  worksLabel: string;
  active: boolean;
  online: boolean;
  /** Sem registro de uso e sem login: "Nunca entrou". */
  never: boolean;
  last?: AccessLast;
  /** Instante do último acesso (uso ou login), para ordenar quem não entrou. */
  lastAt?: string;
  daysWithUse: number;
  /** Um por dia do período, só até `HEAT_DAY_LIMIT` dias (vazio acima disso). */
  dayFlags: boolean[];
  sessions: number;
  seconds: number;
  /** Tempo por dia com uso. */
  perDaySeconds: number;
  /** Segundos por grupo do menu, na ordem de `ACCESS_GROUPS` (zeros incluídos). */
  groups: { group: AccessGroup; seconds: number }[];
  /** As três telas com mais tempo. */
  topScreens: AccessScreenShare[];
  devices: Record<AccessDevice, number>;
}

export interface AccessTotalRow {
  key: string;
  label: string;
  seconds: number;
  people: number;
  share: number;
}
export interface AccessScreenRow extends AccessTotalRow {
  number?: string;
  group: AccessGroup;
  fieldSeconds: number;
}
export interface AccessWorkRow extends AccessTotalRow {
  workId: string | null;
}

export interface AccessHeat {
  grouping: 'day' | 'week';
  columns: { key: LocalDate; label: string; title: string }[];
  rows: { profileId: string; name: string; cells: number[]; total: number }[];
  /** Pessoas com uso em cada coluna, e no período todo. */
  peoplePerColumn: number[];
  peopleTotal: number;
}

export interface AccessView {
  kpis: AccessKpis;
  sentence: { text: string; strong?: boolean }[];
  people: AccessPersonRow[];
  screens: AccessScreenRow[];
  /** Telas sem uso no período, pelo rótulo (vazio quando há filtro de módulo). */
  unusedScreens: string[];
  works: AccessWorkRow[];
  heat: AccessHeat;
  filtered: boolean;
  usageFiltered: boolean;
}

const emptyDevices = (): Record<AccessDevice, number> => ({ desktop: 0, mobile: 0 });
const byTimeDesc = <T extends { seconds: number }>(a: T, b: T) => b.seconds - a.seconds;
const sum = (rows: readonly { seconds: number }[]) => rows.reduce((total, row) => total + row.seconds, 0);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const share = (part: number, whole: number) => (whole > 0 ? part / whole : 0);

/** As linhas de uso agregadas por tela, com a parte de cada uma. */
function screenShares(rows: readonly AccessUsageRow[]): AccessScreenShare[] {
  const total = sum(rows);
  const map = new Map<string, { seconds: number; field: number }>();
  for (const row of rows) {
    const entry = map.get(row.screen) ?? { seconds: 0, field: 0 };
    entry.seconds += row.seconds;
    if (row.field) entry.field += row.seconds;
    map.set(row.screen, entry);
  }
  return [...map.entries()]
    .map(([screen, entry]) => ({
      screen,
      label: screenLabel(screen),
      group: accessScreen(screen).group,
      seconds: entry.seconds,
      share: share(entry.seconds, total),
      fieldShare: share(entry.field, entry.seconds),
    }))
    .sort((a, b) => b.seconds - a.seconds || screenOrder(a.screen) - screenOrder(b.screen));
}

/** As colunas do "Uso por dia": os dias do período, ou as semanas (de segunda) cortadas no período. */
function heatColumns(days: readonly LocalDate[]): {
  grouping: AccessHeat['grouping'];
  columns: AccessHeat['columns'];
  columnOf: (day: LocalDate) => number;
} {
  if (days.length <= HEAT_DAY_LIMIT) {
    const index = new Map(days.map((day, i) => [day, i]));
    return {
      grouping: 'day',
      columns: days.map(day => ({ key: day, label: shortDay(day), title: dayMonthOf(day) })),
      columnOf: day => index.get(day) ?? -1,
    };
  }
  const starts: LocalDate[] = [];
  const index = new Map<LocalDate, number>();
  for (const day of days) {
    const week = startOfWeek(day);
    if (!index.has(week)) {
      index.set(week, starts.length);
      starts.push(week);
    }
  }
  return {
    grouping: 'week',
    columns: starts.map((week, i) => {
      const first = i === 0 ? days[0] : week;
      return { key: first, label: `sem ${dayMonthOf(first)}`, title: `semana de ${dayMonthOf(first)}` };
    }),
    columnOf: day => index.get(startOfWeek(day)) ?? -1,
  };
}

/** Monta a aba inteira para o período e os filtros escolhidos. `period` deve ser o mesmo pedido à rota. */
export function buildAccessView(payload: AccessPayload, period: AccessPeriod, filters: AccessFilters): AccessView {
  const { people, current, previous } = filteredUsage(payload, filters);
  const usageFiltered = hasUsageFilter(filters);
  const label = workLabeler(payload);
  const workNames = new Map(payload.works.map(work => [work.id, work.name]));
  const lastOf = new Map(payload.last.map(entry => [entry.profileId, entry]));
  const matches = usageMatches(filters);
  const nowMs = Date.parse(payload.now);
  const dayIndex = new Map(period.days.map((day, i) => [day, i]));
  const showDays = period.days.length <= HEAT_DAY_LIMIT;

  const byPerson = new Map<string, AccessUsageRow[]>();
  for (const row of current) byPerson.set(row.profileId, [...(byPerson.get(row.profileId) ?? []), row]);

  const rows: AccessPersonRow[] = people.map(person => {
    const mine = byPerson.get(person.id) ?? [];
    const seconds = sum(mine);
    const days = new Set(mine.map(row => row.day));
    const sessions = new Set(mine.map(row => row.sessionId));
    const devices = emptyDevices();
    const groups = new Map<AccessGroup, number>();
    for (const row of mine) {
      devices[row.device] += row.seconds;
      const group = accessScreen(row.screen).group;
      groups.set(group, (groups.get(group) ?? 0) + row.seconds);
    }
    const seen = lastOf.get(person.id);
    let last: AccessLast | undefined;
    let lastAt: string | undefined;
    if (seen) {
      lastAt = seen.at;
      const where = [screenLabel(seen.screen) + (seen.field ? ' (campo)' : ''), seen.workId ? label(seen.workId) : '']
        .filter(Boolean)
        .join(' · ');
      last = { text: relativeMoment(seen.at, payload.now), where, source: 'usage' };
    } else if (person.lastSignInAt) {
      lastAt = person.lastSignInAt;
      const day = person.lastSignInAt.slice(0, 10);
      last = {
        text: `último login ${dayMonthOf(day)}`,
        where: '',
        source: 'login',
        beforeMeasurement: !payload.since || day < payload.since,
      };
    }
    const flags = showDays ? period.days.map(() => false) : [];
    if (showDays) for (const day of days) if (dayIndex.has(day)) flags[dayIndex.get(day)!] = true;
    const roleKey = roleKeyOf(person);
    const workList = person.workIds.map(id => workNames.get(id)).filter((name): name is string => !!name);
    return {
      person,
      roleKey,
      roleLabel: ACCESS_ROLE_LABEL[roleKey],
      worksLabel: person.role === 'admin' ? 'todas as obras' : workList.length ? workList.join(', ') : 'nenhuma obra',
      active: seconds > 0,
      online: !!seen && nowMs - Date.parse(seen.at) <= ONLINE_MS && matches(seen),
      never: !seen && !person.lastSignInAt,
      last,
      lastAt,
      daysWithUse: days.size,
      dayFlags: flags,
      sessions: sessions.size,
      seconds,
      perDaySeconds: days.size ? seconds / days.size : 0,
      groups: ACCESS_GROUPS.map(group => ({ group: group.id, seconds: groups.get(group.id) ?? 0 })),
      topScreens: screenShares(mine).slice(0, 3),
      devices,
    };
  });
  // Regra 10: quem entrou primeiro, por tempo; depois quem não entrou, do acesso mais recente ao mais antigo, e
  // por fim quem nunca entrou. Empate pelo nome.
  rows.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.active) return b.seconds - a.seconds || a.person.name.localeCompare(b.person.name, 'pt-BR');
    if (!!a.lastAt !== !!b.lastAt) return a.lastAt ? -1 : 1;
    return (b.lastAt ?? '').localeCompare(a.lastAt ?? '') || a.person.name.localeCompare(b.person.name, 'pt-BR');
  });

  const seconds = sum(current);
  const entered = rows.filter(row => row.active).length;
  const enteredPrevious = new Set(previous.map(row => row.profileId)).size;
  const sessionCount = new Set(current.map(row => row.sessionId)).size;
  const kpis: AccessKpis = {
    entered,
    enteredPrevious,
    registered: people.length,
    seconds,
    secondsPrevious: sum(previous),
    averageSeconds: entered ? seconds / entered : 0,
    sessions: sessionCount,
    averageSessionSeconds: sessionCount ? seconds / sessionCount : 0,
    online: rows.filter(row => row.online).map(row => ({ id: row.person.id, name: row.person.name })),
    absent: people.length - entered,
    never: rows.filter(row => !row.active && row.never).length,
  };

  // Regra 11: módulos e obras, maior primeiro, com quantas pessoas.
  const screenMap = new Map<string, { seconds: number; field: number; people: Set<string> }>();
  const workMap = new Map<string, { workId: string | null; seconds: number; people: Set<string> }>();
  for (const row of current) {
    const screen = screenMap.get(row.screen) ?? { seconds: 0, field: 0, people: new Set<string>() };
    screen.seconds += row.seconds;
    if (row.field) screen.field += row.seconds;
    screen.people.add(row.profileId);
    screenMap.set(row.screen, screen);
    const key = row.workId ?? OUTSIDE_WORKS;
    const work = workMap.get(key) ?? { workId: row.workId, seconds: 0, people: new Set<string>() };
    work.seconds += row.seconds;
    work.people.add(row.profileId);
    workMap.set(key, work);
  }
  const screens: AccessScreenRow[] = [...screenMap.entries()]
    .map(([key, entry]) => {
      const screen = accessScreen(key);
      return {
        key,
        label: screen.label,
        number: screen.number,
        group: screen.group,
        seconds: entry.seconds,
        fieldSeconds: entry.field,
        people: entry.people.size,
        share: share(entry.seconds, seconds),
      };
    })
    .sort((a, b) => b.seconds - a.seconds || screenOrder(a.key) - screenOrder(b.key));
  const works: AccessWorkRow[] = [...workMap.entries()]
    .map(([key, entry]) => ({
      key,
      workId: entry.workId,
      label: label(entry.workId),
      seconds: entry.seconds,
      people: entry.people.size,
      share: share(entry.seconds, seconds),
    }))
    .sort(byTimeDesc);
  const unusedScreens = filters.screens
    ? []
    : ACCESS_SCREENS.filter(screen => !screenMap.has(screen.key)).map(screen => screenLabel(screen.key));

  // Regra 12: pessoa × dia (ou semana), na ordem da tabela.
  const { grouping, columns, columnOf } = heatColumns(period.days);
  const columnPeople = columns.map(() => new Set<string>());
  const heatRows = rows
    .filter(row => row.active)
    .map(row => {
      const cells = columns.map(() => 0);
      for (const usage of byPerson.get(row.person.id) ?? []) {
        const column = columnOf(usage.day);
        if (column < 0) continue;
        cells[column] += usage.seconds;
        columnPeople[column].add(row.person.id);
      }
      return { profileId: row.person.id, name: row.person.name, cells, total: row.seconds };
    });

  return {
    kpis,
    sentence: payload.migrated ? accessSentence(kpis, screens, period, usageFiltered) : NOT_MEASURED_SENTENCE,
    people: rows,
    screens,
    unusedScreens,
    works,
    heat: {
      grouping,
      columns,
      rows: heatRows,
      peoplePerColumn: columnPeople.map(set => set.size),
      peopleTotal: entered,
    },
    filtered: hasAnyFilter(filters),
    usageFiltered,
  };
}

/** Sem a migração 0051 ninguém tem uso medido; "ninguém entrou" seria falso para quem fez login no período. */
export const NOT_MEASURED_SENTENCE: { text: string; strong?: boolean }[] = [
  { text: 'A contagem do tempo de uso ainda não começou.', strong: true },
  { text: ' Até a migração 0051 ser aplicada, a tabela mostra só o último login de cada pessoa.' },
];

/** A frase do topo (regra 9). Os percentuais são os mesmos arredondados que a tela mostra. */
export function accessSentence(
  kpis: AccessKpis,
  screens: readonly AccessScreenRow[],
  period: Pick<AccessPeriod, 'phrase'>,
  usageFiltered: boolean,
): { text: string; strong?: boolean }[] {
  const verb = usageFiltered ? 'usaram o recorte escolhido' : 'entraram no Obra 360';
  if (kpis.registered === 0) return [{ text: 'Nenhuma pessoa no recorte escolhido.' }];
  if (kpis.entered === 0)
    return [
      { text: usageFiltered ? `Ninguém usou o recorte escolhido ${period.phrase}.` : `Ninguém entrou no Obra 360 ${period.phrase}.` },
    ];
  const out: { text: string; strong?: boolean }[] = [
    { text: `${kpis.entered} de ${plural(kpis.registered, 'pessoa', 'pessoas')}`, strong: true },
    {
      text: ` ${kpis.entered === 1 ? verb.replace('entraram', 'entrou').replace('usaram', 'usou') : verb} ${period.phrase} e ${kpis.entered === 1 ? 'somou' : 'somaram'} `,
    },
    { text: formatDurationLong(kpis.seconds), strong: true },
    { text: ' de uso ativo.' },
  ];
  const [first, second] = screens;
  if (first) {
    out.push(
      { text: ' O módulo com mais tempo foi ' },
      { text: screenLabel(first.key), strong: true },
      { text: ` (${Math.round(first.share * 100)}%)` },
    );
    out.push({ text: second ? `, seguido de ${screenLabel(second.key)} (${Math.round(second.share * 100)}%).` : '.' });
  }
  if (kpis.absent > 0) {
    const absent = usageFiltered
      ? plural(kpis.absent, 'pessoa sem uso no recorte', 'pessoas sem uso no recorte')
      : `${plural(kpis.absent, 'pessoa', 'pessoas')} ${kpis.absent === 1 ? 'não entrou' : 'não entraram'}`;
    out.push({ text: ' ' }, { text: absent, strong: true });
    out.push({
      text:
        kpis.never > 0
          ? `; ${kpis.never === 1 ? (kpis.absent === 1 ? 'ela nunca entrou' : '1 delas nunca entrou') : `${kpis.never} delas nunca entraram`}.`
          : '.',
    });
  }
  return out;
}

export interface AccessSessionView {
  id: string;
  /** "sex 13/11 · 10:55 – agora". */
  range: string;
  startedAt: string;
  lastAt: string;
  open: boolean;
  /** Segundos ativos no recorte. */
  seconds: number;
  devices: AccessDevice[];
  works: { workId: string | null; label: string; screens: { screen: string; label: string; field: boolean; seconds: number }[] }[];
}
export interface AccessPersonDetail {
  sessions: AccessSessionView[];
  screens: AccessScreenShare[];
  works: AccessWorkRow[];
}

/** O detalhe de uma pessoa (regra 10): as sessões do período no recorte, da mais recente para a mais antiga, e o
 * tempo dela por módulo e por obra. */
export function personDetail(payload: AccessPayload, filters: AccessFilters, profileId: string): AccessPersonDetail {
  const { current } = filteredUsage(payload, filters);
  const mine = current.filter(row => row.profileId === profileId);
  const label = workLabeler(payload);
  const total = sum(mine);
  const sessionsById = new Map(payload.sessions.map(session => [session.id, session]));
  const grouped = new Map<string, AccessUsageRow[]>();
  for (const row of mine) grouped.set(row.sessionId, [...(grouped.get(row.sessionId) ?? []), row]);
  const nowMs = Date.parse(payload.now);
  const sessions: AccessSessionView[] = [...grouped.entries()].map(([id, rows]) => {
    const stored = sessionsById.get(id);
    const lastAt = stored?.lastAt ?? rows.reduce((max, row) => (row.lastAt > max ? row.lastAt : max), rows[0].lastAt);
    const startedAt = stored?.startedAt ?? lastAt;
    const byWork = new Map<
      string,
      { workId: string | null; seconds: number; screens: Map<string, { screen: string; field: boolean; seconds: number }> }
    >();
    for (const row of rows) {
      const key = row.workId ?? OUTSIDE_WORKS;
      const work = byWork.get(key) ?? { workId: row.workId, seconds: 0, screens: new Map() };
      work.seconds += row.seconds;
      const screenKey = `${row.screen}|${row.field ? 1 : 0}`;
      const screen = work.screens.get(screenKey) ?? { screen: row.screen, field: row.field, seconds: 0 };
      screen.seconds += row.seconds;
      work.screens.set(screenKey, screen);
      byWork.set(key, work);
    }
    return {
      id,
      range: sessionRange(startedAt, lastAt, payload.now),
      startedAt,
      lastAt,
      open: nowMs - Date.parse(lastAt) <= ONLINE_MS,
      seconds: sum(rows),
      devices: (['desktop', 'mobile'] as const).filter(device => rows.some(row => row.device === device)),
      works: [...byWork.values()].sort(byTimeDesc).map(work => ({
        workId: work.workId,
        label: label(work.workId),
        screens: [...work.screens.values()]
          .sort(byTimeDesc)
          .map(screen => ({ ...screen, label: screenLabel(screen.screen) + (screen.field ? ' (campo)' : '') })),
      })),
    };
  });
  sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const workMap = new Map<string, { workId: string | null; seconds: number }>();
  for (const row of mine) {
    const key = row.workId ?? OUTSIDE_WORKS;
    const work = workMap.get(key) ?? { workId: row.workId, seconds: 0 };
    work.seconds += row.seconds;
    workMap.set(key, work);
  }
  const works: AccessWorkRow[] = [...workMap.entries()]
    .map(([key, work]) => ({
      key,
      workId: work.workId,
      label: label(work.workId),
      seconds: work.seconds,
      people: 1,
      share: share(work.seconds, total),
    }))
    .sort(byTimeDesc);
  return { sessions, screens: screenShares(mine), works };
}

'use client';
import { Fragment, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChartColumn, FileDown, RefreshCw } from 'lucide-react';
import { HelpNote } from '@/modules/layout/help-note';
import { LoadState } from '@/modules/planejamento/ui';
import { FilterPicker } from '@/modules/curto-prazo/closing-filter';
import { formatDate } from '@/shared/format';
import { brasiliaClock } from '@/domain/weekly-summary';
import type { LocalDate } from '@/domain/entities';
import {
  buildAccessView,
  hasAnyFilter,
  OUTSIDE_WORKS,
  OUTSIDE_WORKS_LABEL,
  personDetail,
  workLabeler,
  type AccessFilters,
  type AccessHeat,
  type AccessPersonRow,
  type AccessScreenShare,
  type AccessView,
} from '@/domain/access-report';
import {
  ACCESS_GROUPS,
  ACCESS_PERIOD_KINDS,
  ACCESS_ROLE_LABEL,
  ACCESS_ROLE_ORDER,
  ACCESS_SCREENS,
  DEVICE_LABEL,
  accessScreen,
  brasiliaMoment,
  dayMonthOf,
  formatDuration,
  isLocalDate,
  resolveAccessPeriod,
  roleKeyOf,
  screenLabel,
  shortDay,
  type AccessDevice,
  type AccessGroup,
  type AccessPayload,
  type AccessPeriod,
  type AccessPeriodKind,
  type AccessRoleKey,
} from '@/domain/access-usage';
import { DASHBOARD_STYLE } from '../styles';
import { DashboardTabs } from '../dashboard-tabs';
import { ACCESS_STYLE } from './access-styles';
import { accessCsv, accessCsvFileName } from './access-csv';
import { accessPath, type AccessParams } from './params';
import { useAccessData } from './use-access-data';

/** Aba "Acessos" do Dashboard geral (15/11/2026, modelo aprovado "Aba Acessos no Dashboard geral"): quem entrou no
 * Obra 360, em quais módulos e por quanto tempo. Só admin (regra 2; a página e a rota barram os demais). De cima
 * para baixo, como no modelo: cabeçalho com "Como funciona" e a planilha (regra 13), as abas (regra 1), período em
 * dias corridos e filtros (regras 7 e 11, todos na URL), a linha de escopo, a frase e os seis cartões (regra 9), a
 * tabela "Por pessoa" com o detalhe aberto embaixo (regra 10), tempo por módulo e por obra (regra 11) e o uso por dia
 * (regra 12). Toda conta está em `access-report.ts`; aqui só se desenha. Os filtros recortam na tela, sem ir ao
 * servidor; trocar de período lê de novo e, enquanto o novo chega, o anterior fica na tela, apagado. Nada se edita.
 * No celular, uma coluna e as tabelas rolando de lado com a pessoa fixa. */

const HELP = (
  <>
    <p>
      <strong>Tempo ativo.</strong> Conta cada segundo em que a aba do Obra 360 está na frente e houve clique, tecla, rolagem ou toque nos
      últimos 5 minutos. Aba escondida, janela minimizada, computador parado e tela bloqueada não contam: deixar o sistema aberto o dia todo
      não soma o dia todo.
    </p>
    <p>
      <strong>Sessão.</strong> Uma entrada no sistema; voltar depois de 30 minutos sem uso abre outra. Duas abas abertas ao mesmo tempo
      nunca somam mais que o relógio.
    </p>
    <p>
      <strong>Módulo.</strong> Vem da tela aberta, com o número do menu (0 a 3.2, Vagões e as telas de Apoio). Lista de obras, Dashboard
      geral, Configurações e Agente de IA somam em "Fora das obras". O modo de campo da terminalidade e da segurança conta no módulo,
      marcado "campo"; o tempo com a janela da Claudia aberta conta para a tela que está embaixo.
    </p>
    <p>
      <strong>Período.</strong> Dias corridos no horário de Brasília, contando sábado e domingo; não usa as semanas da aba Obras. As setas
      dos cartões comparam com o período anterior do mesmo tamanho.
    </p>
    <p>
      <strong>Aparelho.</strong> Computador ou celular (tablet conta como celular), reconhecido pelo navegador; o modo de campo conta sempre
      como celular. Não ficam gravados IP, localização nem o que foi digitado ou visto na tela.
    </p>
    <p>
      <strong>Desde quando.</strong> A contagem começou no dia da publicação da aba; o uso de antes não tem como ser recuperado. Para quem
      ainda não tem uso medido, a tabela mostra a data do último login, que é o mesmo do Takt Hub e pode ser de lá. O uso fica guardado por
      13 meses; o mais antigo é apagado sozinho.
    </p>
    <p>
      <strong>Sem sinal.</strong> No modo de campo, o minuto sem internet não conta, e a tela nunca trava por isso: o tempo do celular na
      obra pode sair um pouco abaixo do real.
    </p>
  </>
);

// ---------------------------------------------------------------- textos pequenos

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const listText = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} e ${items.at(-1)}`);
/** "46%"; uma fatia que existe mas arredonda para zero não some: "<1%". */
const pct = (share: number) => (share > 0 && share < 0.005 ? '<1%' : `${Math.round(share * 100)}%`);
const sumSeconds = (rows: readonly { seconds: number }[]) => rows.reduce((total, row) => total + row.seconds, 0);
const GROUP_LABEL = Object.fromEntries(ACCESS_GROUPS.map(group => [group.id, group.label])) as Record<AccessGroup, string>;

/** Nome curto para "Onde passa o tempo" ("1.3 Curto 46% · 1.4 Restrições 22%", como no modelo); as demais telas
 * já têm nome curto no catálogo. */
const SHORT_SCREEN: Record<string, string> = {
  dashboard: 'Dashboard',
  'longo-prazo': 'Longo',
  'medio-prazo': 'Médio',
  'curto-prazo': 'Curto',
  restricoes: 'Restrições',
  seguranca: 'Segurança',
  checklist: 'Checklist',
  ifc: 'IFC',
  configuracoes: 'Config. da obra',
};
const shortScreen = (key: string) => {
  const screen = accessScreen(key);
  const label = SHORT_SCREEN[key] ?? screen.label;
  return screen.number ? `${screen.number} ${label}` : label;
};

/** Regra 7: as setas comparam com o período anterior do mesmo tamanho. */
const COMPARE: Record<AccessPeriodKind, { over: string; same: string }> = {
  hoje: { over: 'sobre ontem', same: 'a ontem' },
  '7d': { over: 'sobre os 7 dias anteriores', same: 'aos 7 dias anteriores' },
  '30d': { over: 'sobre os 30 dias anteriores', same: 'aos 30 dias anteriores' },
  mes: { over: 'sobre o período anterior', same: 'ao período anterior' },
  'mes-anterior': { over: 'sobre o período anterior', same: 'ao período anterior' },
  intervalo: { over: 'sobre o período anterior', same: 'ao período anterior' },
};

// ---------------------------------------------------------------- tela

/** "Hoje" é o dia de Brasília no navegador; vira sozinho à meia-noite com a aba aberta. */
function useBrasiliaToday(): LocalDate {
  const [today, setToday] = useState(() => brasiliaClock(new Date()).day);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const day = brasiliaClock(new Date()).day;
      setToday(current => (current === day ? current : day));
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return today;
}

/** Regra 13: a planilha leva o período e os filtros de agora. */
function downloadCsv(payload: AccessPayload, filters: AccessFilters) {
  const url = URL.createObjectURL(new Blob([accessCsv(payload, filters)], { type: 'text/csv;charset=utf-8' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: accessCsvFileName(payload) });
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function AccessOverview({ initial }: { initial: AccessParams }) {
  const [params, setParams] = useState<AccessParams>(initial);
  const [sort, setSort] = useState<PeopleSort>(DEFAULT_SORT);
  const [openId, setOpenId] = useState<string>();
  const today = useBrasiliaToday();
  const period = useMemo(() => resolveAccessPeriod(params.period, today), [params.period, today]);
  const state = useAccessData(period);
  // A URL acompanha cada escolha, sem recarregar nem rolar (como na aba Obras): o link copiado reproduz a visão.
  const update = (next: AccessParams) => {
    setParams(next);
    window.history.replaceState(null, '', accessPath(next));
  };

  const shown = state.status === 'ready' ? { payload: state.payload, period } : state.previous;
  const shownPayload = shown?.payload;
  const filters = useMemo(
    () => (shownPayload ? cleanFilters(params.filters, shownPayload) : params.filters),
    [params.filters, shownPayload],
  );
  const ready = state.status === 'ready' ? state.payload : undefined;

  return (
    <Shell onDownload={ready ? () => downloadCsv(ready, filters) : undefined}>
      {shown && <Filters payload={shown.payload} filters={filters} params={params} period={period} today={today} update={update} />}
      {state.status === 'error' ? (
        <div className="panel p-6">
          <p role="alert" className="text-sm font-semibold text-slate-800">
            Não foi possível carregar os acessos.
          </p>
          <p className="mt-1 text-sm text-slate-500">{state.message || 'Verifique a conexão e tente de novo.'}</p>
          <button type="button" className="button-ghost mt-4" onClick={state.retry}>
            <RefreshCw size={15} aria-hidden />
            Tentar de novo
          </button>
        </div>
      ) : shown ? (
        <Content
          payload={shown.payload}
          period={shown.period}
          filters={filters}
          stale={state.status !== 'ready'}
          sort={sort}
          onSort={setSort}
          openId={openId}
          onOpen={setOpenId}
        />
      ) : (
        <LoadState />
      )}
    </Shell>
  );
}

function Shell({ onDownload, children }: { onDownload?: () => void; children: ReactNode }) {
  return (
    <div className="dsh">
      <style>{DASHBOARD_STYLE}</style>
      <style>{ACCESS_STYLE}</style>
      <header data-tour="acessos-cabecalho" className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 items-start gap-4">
          <span
            aria-hidden
            className="mt-1 hidden h-12 w-12 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-brand-500 to-brand-800 text-white shadow-md shadow-brand-900/20 ring-1 ring-brand-900/10 sm:grid"
          >
            <ChartColumn size={24} strokeWidth={2.2} />
          </span>
          <div className="min-w-0">
            <p className="eyebrow">Empreendimentos</p>
            <h1 className="page-title">Dashboard geral</h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
              <p className="text-sm text-slate-500">Quem entrou no Obra 360, em quais módulos e por quanto tempo.</p>
              <span data-tour="acessos-ajuda" className="inline-flex">
                <HelpNote title="Como funciona: acessos" label="Como funciona">
                  {HELP}
                </HelpNote>
              </span>
            </div>
          </div>
        </div>
        <button type="button" className="button-ghost" data-tour="acessos-planilha" onClick={onDownload} disabled={!onDownload}>
          <FileDown size={16} aria-hidden />
          Baixar planilha (.csv)
        </button>
      </header>
      <DashboardTabs active="acessos" />
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- filtros (regras 7 e 11)

interface Option<T extends string> {
  id: T;
  label: string;
}
interface FilterOptions {
  people: Option<string>[];
  roles: Option<AccessRoleKey>[];
  works: Option<string>[];
  screens: Option<string>[];
  devices: Option<AccessDevice>[];
}

/** O seletor trabalha com rótulos: cada rótulo precisa ser único para a escolha voltar ao id certo. */
function uniqueLabels<T extends string>(options: Option<T>[], fallback: (option: Option<T>) => string = () => ''): Option<T>[] {
  const count = new Map<string, number>();
  for (const option of options) count.set(option.label, (count.get(option.label) ?? 0) + 1);
  const used = new Set<string>();
  return options.map(option => {
    const extra = (count.get(option.label) ?? 0) > 1 ? fallback(option) : '';
    let label = extra ? `${option.label} (${extra})` : option.label;
    for (let n = 2; used.has(label); n++) label = `${option.label} (${n})`;
    used.add(label);
    return { id: option.id, label };
  });
}

function filterOptions(payload: AccessPayload): FilterOptions {
  const emails = new Map(payload.people.map(person => [person.id, person.email ?? '']));
  const people = uniqueLabels(
    [...payload.people].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')).map(person => ({ id: person.id, label: person.name })),
    option => emails.get(option.id) ?? '',
  );
  const present = new Set(payload.people.map(roleKeyOf));
  const roleKeys = ACCESS_ROLE_ORDER.filter(role => present.has(role));
  const label = workLabeler(payload);
  const works = uniqueLabels([
    ...payload.works.map(work => ({ id: work.id, label: label(work.id) })).sort((a, b) => a.label.localeCompare(b.label, 'pt-BR')),
    { id: OUTSIDE_WORKS, label: OUTSIDE_WORKS_LABEL },
  ]);
  return {
    people,
    roles: (roleKeys.length ? roleKeys : ACCESS_ROLE_ORDER).map(role => ({ id: role, label: ACCESS_ROLE_LABEL[role] })),
    works,
    screens: ACCESS_SCREENS.map(screen => ({ id: screen.key, label: screenLabel(screen.key) })),
    devices: (['desktop', 'mobile'] as const).map(device => ({ id: device, label: DEVICE_LABEL[device] })),
  };
}

/** Os filtros da URL contra o que existe: id que sumiu (pessoa removida, obra excluída) sai; sobrando nada ou tudo,
 * o filtro vale "todos". Assim o seletor, as contas e a planilha usam o mesmo recorte. */
function cleanFilters(filters: AccessFilters, payload: AccessPayload): AccessFilters {
  const options = filterOptions(payload);
  const keep = <T extends string>(set: ReadonlySet<T> | undefined, valid: readonly Option<T>[]): Set<T> | undefined => {
    if (!set) return undefined;
    const kept = valid.filter(option => set.has(option.id)).map(option => option.id);
    return kept.length && kept.length < valid.length ? new Set(kept) : undefined;
  };
  return {
    people: keep(filters.people, options.people),
    roles: keep(filters.roles, options.roles),
    works: keep(filters.works, options.works),
    screens: keep(filters.screens, options.screens),
    devices: keep(filters.devices, options.devices),
  };
}

function IdPicker<T extends string>({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: Option<T>[];
  selected: ReadonlySet<T> | undefined;
  onChange: (ids: Set<T> | undefined) => void;
}) {
  const chosen = selected ? new Set(options.filter(option => selected.has(option.id)).map(option => option.label)) : undefined;
  return (
    <FilterPicker
      label={label}
      values={options.map(option => ({ value: option.label }))}
      selected={chosen?.size ? chosen : undefined}
      onChange={next => {
        const ids = next ? options.filter(option => next.has(option.label)).map(option => option.id) : [];
        onChange(next && ids.length && ids.length < options.length ? new Set(ids) : undefined);
      }}
    />
  );
}

function Filters({
  payload,
  filters,
  params,
  period,
  today,
  update,
}: {
  payload: AccessPayload;
  filters: AccessFilters;
  params: AccessParams;
  period: AccessPeriod;
  today: LocalDate;
  update: (next: AccessParams) => void;
}) {
  const options = useMemo(() => filterOptions(payload), [payload]);
  const setFilters = (patch: Partial<AccessFilters>) => update({ period: params.period, filters: { ...filters, ...patch } });
  const choose = (kind: AccessPeriodKind) => {
    if (kind === period.kind) return;
    // Intervalo abre com os dias que já estão na tela.
    update({ filters, period: kind === 'intervalo' ? { kind, from: period.from, to: period.to } : { kind } });
  };
  const setRange = (from: string, to: string) => {
    if (isLocalDate(from) && isLocalDate(to)) update({ filters, period: { kind: 'intervalo', from, to } });
  };

  return (
    <div
      data-tour="acessos-filtros"
      role="group"
      aria-label="Filtros dos acessos"
      className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs font-semibold text-slate-600"
    >
      <span data-tour="acessos-periodo" className="flex flex-wrap items-center gap-2">
        Período
        <span
          role="group"
          aria-label="Período"
          className="inline-flex flex-wrap gap-0.5 rounded-lg border border-slate-300 bg-white p-0.5 shadow-sm"
        >
          {ACCESS_PERIOD_KINDS.map(item => {
            const on = period.kind === item.kind;
            return (
              <button
                key={item.kind}
                type="button"
                aria-pressed={on}
                onClick={() => choose(item.kind)}
                className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
                  on ? 'bg-primary text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </span>
        {period.kind === 'intervalo' && (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <label className="font-medium text-slate-500" htmlFor="acessos-de">
              de
            </label>
            <input
              id="acessos-de"
              type="date"
              className="field w-auto py-1.5"
              defaultValue={period.from}
              max={period.to}
              onChange={e => setRange(e.target.value, period.to)}
            />
            <label className="font-medium text-slate-500" htmlFor="acessos-ate">
              até
            </label>
            <input
              id="acessos-ate"
              type="date"
              className="field w-auto py-1.5"
              defaultValue={period.to}
              min={period.from}
              max={today}
              onChange={e => setRange(period.from, e.target.value)}
            />
          </span>
        )}
      </span>
      <IdPicker label="Pessoas" options={options.people} selected={filters.people} onChange={people => setFilters({ people })} />
      <IdPicker label="Papel" options={options.roles} selected={filters.roles} onChange={roles => setFilters({ roles })} />
      <IdPicker label="Obras" options={options.works} selected={filters.works} onChange={works => setFilters({ works })} />
      <IdPicker label="Módulos" options={options.screens} selected={filters.screens} onChange={screens => setFilters({ screens })} />
      <IdPicker label="Aparelho" options={options.devices} selected={filters.devices} onChange={devices => setFilters({ devices })} />
      {hasAnyFilter(filters) && (
        <button type="button" className="text-link text-xs" onClick={() => update({ period: params.period, filters: {} })}>
          Limpar
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- conteúdo

function Content({
  payload,
  period,
  filters,
  stale,
  sort,
  onSort,
  openId,
  onOpen,
}: {
  payload: AccessPayload;
  period: AccessPeriod;
  filters: AccessFilters;
  stale: boolean;
  sort: PeopleSort;
  onSort: (sort: PeopleSort) => void;
  openId: string | undefined;
  onOpen: (id: string | undefined) => void;
}) {
  const view = useMemo(() => buildAccessView(payload, period, filters), [payload, period, filters]);
  const total = payload.people.length;
  const usageParts = [filters.works && 'obra', filters.screens && 'módulo', filters.devices && 'aparelho'].filter(
    (part): part is string => !!part,
  );
  const days = period.days.length;
  const empty = !payload.migrated
    ? 'A contagem começa quando a migração 0051 for aplicada no banco.'
    : view.usageFiltered
      ? 'Ninguém usou o recorte escolhido no período.'
      : 'Ninguém entrou no Obra 360 no período.';

  return (
    <div className={stale ? 'ac-stale' : undefined} aria-busy={stale || undefined}>
      {stale && (
        <span role="status" className="sr-only">
          Carregando o período escolhido…
        </span>
      )}
      <p data-tour="acessos-escopo" className="mb-4 text-xs text-slate-500">
        <b className="font-semibold text-slate-700">
          {filters.people || filters.roles
            ? `${view.kpis.registered} de ${plural(total, 'pessoa', 'pessoas')} (recorte)`
            : plural(total, 'pessoa cadastrada', 'pessoas cadastradas')}
        </b>{' '}
        · {period.label} ({days === 1 ? '1 dia' : `${days} dias corridos`}, horário de Brasília) · tempo ativo: aba visível e uso nos
        últimos 5 min · {payload.since ? `medindo desde ${formatDate(payload.since)}` : 'ainda sem registro'}
        {usageParts.length > 0 && ` · recorte por ${listText(usageParts)}`}
      </p>

      {!payload.migrated && (
        <p className="dsh-callout warn ac-callout" role="status">
          <strong>A contagem ainda não começou:</strong> falta aplicar a migração 0051 no banco. Até lá, a tabela mostra só o último login
          de cada pessoa.
        </p>
      )}

      <p data-tour="acessos-resumo" className="dsh-summary">
        {view.sentence.map((segment, index) =>
          segment.strong ? <strong key={index}>{segment.text}</strong> : <span key={index}>{segment.text}</span>,
        )}
      </p>

      <Cards view={view} payload={payload} period={period} />

      <div className="dsh-mods">
        <PeopleBoard
          view={view}
          payload={payload}
          period={period}
          filters={filters}
          sort={sort}
          onSort={onSort}
          openId={openId}
          onOpen={onOpen}
        />
        <div className="ac-cols-2">
          <ScreensBoard view={view} empty={empty} />
          <WorksBoard view={view} empty={empty} />
        </div>
        <HeatBoard heat={view.heat} empty={empty} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- cartões (regra 9)

function Trend({
  current,
  previous,
  kind,
  percent,
  comparable,
}: {
  current: number;
  previous: number;
  kind: AccessPeriodKind;
  percent: boolean;
  comparable: boolean;
}) {
  if (!(previous > 0)) return <>sem uso medido no período anterior</>;
  // Período anterior que começa antes do primeiro dia medido (regra 14) daria uma seta enganosa.
  if (!comparable) return <>o período anterior não foi todo medido</>;
  const text = COMPARE[kind];
  if (current === previous)
    return (
      <>
        <span className="ac-eq">= igual</span> {text.same}
      </>
    );
  const up = current > previous;
  const diff = Math.abs(current - previous);
  const rate = Math.round((diff / previous) * 100);
  const amount = percent ? (rate === 0 ? 'menos de 1%' : `${rate}%`) : String(diff);
  return (
    <>
      <span className={up ? 'ac-up' : 'ac-down'}>
        {up ? '▲' : '▼'} {amount}
      </span>{' '}
      {text.over}
    </>
  );
}

/** "Carla, Diego e Renata" / "Carla, Diego, Renata e mais 2": o primeiro nome, ou o nome todo se dois coincidem. */
function onlineHint(online: readonly { name: string }[]): string {
  if (!online.length) return 'ninguém com uso nos últimos 5 min';
  const firsts = online.map(person => person.name.trim().split(/\s+/)[0] || person.name);
  const repeated = new Set(firsts.filter((name, index) => firsts.indexOf(name) !== index));
  const names = online.map((person, index) => (repeated.has(firsts[index]) ? person.name : firsts[index]));
  return names.length <= 3 ? listText(names) : `${names.slice(0, 3).join(', ')} e mais ${names.length - 3}`;
}

function Card({ label, value, hint, tone = '' }: { label: string; value: ReactNode; hint: ReactNode; tone?: string }) {
  return (
    <div className="dsh-stat">
      <div className="l">
        <span>{label}</span>
      </div>
      <div className={`v ${tone}`}>{value}</div>
      <div className="h">{hint}</div>
    </div>
  );
}

function Cards({ view, payload, period }: { view: AccessView; payload: AccessPayload; period: AccessPeriod }) {
  const k = view.kpis;
  const comparable = !!payload.since && payload.since <= payload.previousFrom;
  const trend = { kind: period.kind, comparable };
  return (
    <div className="ac-kpis">
      <div data-tour="acessos-cartoes" className="dsh-kpis ac6">
        <Card
          label="Pessoas que entraram"
          value={
            <>
              {k.entered} <small>de {k.registered}</small>
            </>
          }
          hint={<Trend current={k.entered} previous={k.enteredPrevious} percent={false} {...trend} />}
        />
        <Card
          label="Tempo ativo"
          value={formatDuration(k.seconds)}
          hint={<Trend current={k.seconds} previous={k.secondsPrevious} percent {...trend} />}
        />
        <Card label="Média por pessoa" value={k.entered ? formatDuration(k.averageSeconds) : '—'} hint="de quem entrou, no período" />
        <Card
          label="Sessões"
          value={k.sessions}
          hint={k.sessions ? `${formatDuration(k.averageSessionSeconds)} em média` : 'nenhuma no período'}
        />
        <Card
          label="No sistema agora"
          value={
            <>
              {k.online.length > 0 && <span className="ac-live" aria-hidden />}
              {k.online.length}
            </>
          }
          hint={onlineHint(k.online)}
        />
        <Card
          label={view.usageFiltered ? 'Sem uso no recorte' : 'Sem acesso no período'}
          value={payload.migrated ? k.absent : '—'}
          tone={payload.migrated && k.absent > 0 ? 't-bad' : ''}
          hint={
            !payload.migrated
              ? 'a contagem ainda não começou'
              : k.never > 0
                ? `${k.never} ${k.never === 1 ? 'nunca entrou' : 'nunca entraram'}`
                : k.absent > 0
                  ? 'todas já entraram alguma vez'
                  : view.usageFiltered
                    ? 'todas usaram o recorte'
                    : 'todas entraram no período'
          }
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- por pessoa (regra 10)

type SortKey = 'pessoa' | 'ultimo' | 'dias' | 'sessoes' | 'tempo' | 'dia' | 'onde' | 'aparelho';
interface PeopleSort {
  key: SortKey;
  dir: 1 | -1;
}
/** Regra 10: abre em tempo ativo, maior primeiro. */
const DEFAULT_SORT: PeopleSort = { key: 'tempo', dir: -1 };

const mobileShare = (row: AccessPersonRow) => {
  const total = row.devices.desktop + row.devices.mobile;
  return total ? row.devices.mobile / total : 0;
};
/** O grupo do menu com mais tempo da pessoa e a parte dele. */
const mainGroup = (row: AccessPersonRow) => {
  let index = ACCESS_GROUPS.length;
  let seconds = 0;
  row.groups.forEach((group, i) => {
    if (group.seconds > seconds) {
      index = i;
      seconds = group.seconds;
    }
  });
  return { index, share: row.seconds ? seconds / row.seconds : 0 };
};
const atOf = (row: AccessPersonRow) => (row.lastAt ? Date.parse(row.lastAt) || 0 : 0);

const PEOPLE_COLUMNS: {
  key: SortKey;
  label: string;
  num?: boolean;
  /** A direção do primeiro clique. */
  first: 1 | -1;
  /** Como a ordem aparece no subtítulo: [crescente, decrescente]. */
  order: [string, string];
  compare: (a: AccessPersonRow, b: AccessPersonRow) => number;
}[] = [
  {
    key: 'pessoa',
    label: 'Pessoa',
    first: 1,
    order: ['de A a Z', 'de Z a A'],
    compare: (a, b) => a.person.name.localeCompare(b.person.name, 'pt-BR'),
  },
  {
    key: 'ultimo',
    label: 'Último acesso',
    first: -1,
    order: ['mais antigo primeiro', 'mais recente primeiro'],
    compare: (a, b) => atOf(a) - atOf(b),
  },
  {
    key: 'dias',
    label: 'Dias com uso',
    first: -1,
    order: ['menos dias primeiro', 'mais dias primeiro'],
    compare: (a, b) => a.daysWithUse - b.daysWithUse,
  },
  {
    key: 'sessoes',
    label: 'Sessões',
    num: true,
    first: -1,
    order: ['menor primeiro', 'maior primeiro'],
    compare: (a, b) => a.sessions - b.sessions,
  },
  {
    key: 'tempo',
    label: 'Tempo ativo',
    num: true,
    first: -1,
    order: ['menor primeiro', 'maior primeiro'],
    compare: (a, b) => a.seconds - b.seconds,
  },
  {
    key: 'dia',
    label: 'Por dia de uso',
    num: true,
    first: -1,
    order: ['menor primeiro', 'maior primeiro'],
    compare: (a, b) => a.perDaySeconds - b.perDaySeconds,
  },
  {
    key: 'onde',
    label: 'Onde passa o tempo',
    first: 1,
    order: ['pelo grupo do menu', 'pelo grupo do menu, de trás para a frente'],
    compare: (a, b) => {
      const x = mainGroup(a);
      const y = mainGroup(b);
      return x.index - y.index || y.share - x.share;
    },
  },
  {
    key: 'aparelho',
    label: 'Aparelho',
    first: 1,
    order: ['computador primeiro', 'celular primeiro'],
    compare: (a, b) => mobileShare(a) - mobileShare(b),
  },
];
const columnOf = (key: SortKey) => PEOPLE_COLUMNS.find(column => column.key === key) ?? PEOPLE_COLUMNS[4];

/** A ordenação vale para quem tem uso; quem não entrou fica sempre no fim, na ordem que o domínio já dá. */
function sortPeople(rows: readonly AccessPersonRow[], sort: PeopleSort): AccessPersonRow[] {
  const column = columnOf(sort.key);
  const active = rows
    .filter(row => row.active)
    .sort((a, b) => column.compare(a, b) * sort.dir || b.seconds - a.seconds || a.person.name.localeCompare(b.person.name, 'pt-BR'));
  return [...active, ...rows.filter(row => !row.active)];
}

function PeopleBoard({
  view,
  payload,
  period,
  filters,
  sort,
  onSort,
  openId,
  onOpen,
}: {
  view: AccessView;
  payload: AccessPayload;
  period: AccessPeriod;
  filters: AccessFilters;
  sort: PeopleSort;
  onSort: (sort: PeopleSort) => void;
  openId: string | undefined;
  onOpen: (id: string | undefined) => void;
}) {
  const rows = useMemo(() => sortPeople(view.people, sort), [view.people, sort]);
  const column = columnOf(sort.key);
  const anyActive = rows.some(row => row.active);
  const choose = (key: SortKey) => onSort(sort.key === key ? { key, dir: sort.dir === 1 ? -1 : 1 } : { key, dir: columnOf(key).first });

  return (
    <section data-tour="acessos-pessoas" className="dsh-mod" aria-labelledby="acessos-pessoas-titulo">
      <div className="dsh-mod-h">
        <h2 id="acessos-pessoas-titulo">
          Por pessoa
          <span className="sub">
            {anyActive ? 'clique numa linha para ver as sessões · ' : ''}ordenado por {column.label.toLowerCase()},{' '}
            {column.order[sort.dir === 1 ? 0 : 1]}
          </span>
        </h2>
      </div>
      <div className="dsh-mod-b ac-legend-b">
        <div className="dsh-legend ac-legend">
          {ACCESS_GROUPS.map(group => (
            <span key={group.id}>
              <i className={`ac-g-${group.id}`} />
              {group.label}
            </span>
          ))}
        </div>
      </div>
      <div className="ac-xscroll">
        <table className="ac-table">
          <thead>
            <tr>
              {PEOPLE_COLUMNS.map(item => {
                const sorted = sort.key === item.key;
                return (
                  <th
                    key={item.key}
                    scope="col"
                    className={item.num ? 'num' : undefined}
                    aria-sort={sorted ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
                  >
                    <button type="button" onClick={() => choose(item.key)} title={`Ordenar por ${item.label.toLowerCase()}`}>
                      {item.label}
                      <span className="ar" aria-hidden>
                        {sorted ? (sort.dir === 1 ? '↑' : '↓') : ''}
                      </span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={PEOPLE_COLUMNS.length} className="ac-none">
                  Nenhuma pessoa no recorte escolhido.
                </td>
              </tr>
            )}
            {rows.map(row => {
              const open = row.active && openId === row.person.id;
              const detailId = `acessos-detalhe-${row.person.id}`;
              return (
                <Fragment key={row.person.id}>
                  <PersonRow
                    row={row}
                    period={period}
                    usageFiltered={view.usageFiltered}
                    measured={payload.migrated}
                    open={open}
                    detailId={detailId}
                    onToggle={() => onOpen(open ? undefined : row.person.id)}
                  />
                  {open && (
                    <tr className="ac-detail" id={detailId}>
                      <td colSpan={PEOPLE_COLUMNS.length}>
                        <div className="ac-detail-in">
                          <PersonDetailPanel key={row.person.id} payload={payload} filters={filters} profileId={row.person.id} />
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PersonRow({
  row,
  period,
  usageFiltered,
  measured,
  open,
  detailId,
  onToggle,
}: {
  row: AccessPersonRow;
  period: AccessPeriod;
  usageFiltered: boolean;
  /** Sem a 0051 ninguém tem uso medido: "Sem acesso" seria falso para quem fez login no período. */
  measured: boolean;
  open: boolean;
  detailId: string;
  onToggle: () => void;
}) {
  const days = period.days.length;
  const who = (
    <td className="who">
      <b>{row.person.name}</b>
      <span className="dsh-tag neutral">{row.roleLabel}</span>
      <small>{row.worksLabel}</small>
    </td>
  );

  if (!row.active) {
    const last = row.last;
    let note = '';
    if (row.never) {
      const created = Date.parse(row.person.createdAt) ? brasiliaMoment(row.person.createdAt).day : '';
      note = created ? `cadastrada em ${dayMonthOf(created)}` : '';
    } else if (last?.source === 'login') note = `${last.text}${last.beforeMeasurement ? ', antes da medição' : ''}`;
    else if (last) note = `último acesso ${last.text}${last.where ? ` · ${last.where}` : ''}`;
    return (
      <tr className="off">
        {who}
        <td className="last">
          {row.never ? (
            <span className="dsh-tag bad">Nunca entrou</span>
          ) : !measured ? (
            <span className="dsh-tag neutral">Sem medição</span>
          ) : (
            <span className="dsh-tag warn">{usageFiltered ? 'Sem uso no recorte' : 'Sem acesso'}</span>
          )}
          {note && <small>{note}</small>}
        </td>
        <td className="days">0 de {days}</td>
        <td className="num">—</td>
        <td className="num">—</td>
        <td className="num">—</td>
        <td>—</td>
        <td className="dev">—</td>
      </tr>
    );
  }

  const keyDown = (event: KeyboardEvent<HTMLTableRowElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onToggle();
    }
  };
  const groups = row.groups.filter(group => group.seconds > 0);
  const top = row.topScreens.map(
    (screen: AccessScreenShare) =>
      `${shortScreen(screen.screen)} ${pct(screen.share)}${screen.fieldShare > 0 ? ` (${pct(screen.fieldShare)} no campo)` : ''}`,
  );
  return (
    <tr
      className={`link${open ? ' open' : ''}`}
      tabIndex={0}
      aria-expanded={open}
      aria-controls={open ? detailId : undefined}
      aria-label={`${row.person.name}: ${open ? 'fechar' : 'ver'} as sessões`}
      onClick={onToggle}
      onKeyDown={keyDown}
    >
      {who}
      <td className="last">
        {row.online && <span className="ac-live" aria-hidden />}
        <b>{row.last?.text ?? '—'}</b>
        {row.last?.where && <small>{row.last.where}</small>}
      </td>
      <td className="days">
        {row.daysWithUse} de {days}
        {row.dayFlags.length > 0 && (
          <span className={`ac-dots${row.dayFlags.length > 14 ? ' dense' : ''}`} aria-hidden>
            {row.dayFlags.map((on, index) => (
              <i
                key={period.days[index] ?? index}
                className={on ? 'on' : undefined}
                title={period.days[index] ? shortDay(period.days[index]) : undefined}
              />
            ))}
          </span>
        )}
      </td>
      <td className="num">{row.sessions}</td>
      <td className="num">
        <b>{formatDuration(row.seconds)}</b>
      </td>
      <td className="num">{formatDuration(row.perDaySeconds)}</td>
      <td className="where">
        <span
          className="ac-stack"
          role="img"
          aria-label={groups.map(group => `${GROUP_LABEL[group.group]} ${pct(group.seconds / row.seconds)}`).join(', ')}
        >
          {groups.map(group => (
            <b
              key={group.group}
              className={`ac-g-${group.group}`}
              style={{ width: `${(group.seconds / row.seconds) * 100}%` }}
              title={`${GROUP_LABEL[group.group]}: ${pct(group.seconds / row.seconds)}`}
            />
          ))}
        </span>
        <small>{top.join(' · ')}</small>
      </td>
      <DeviceCell row={row} />
    </tr>
  );
}

/** "Computador"; "Celular 81%" e, embaixo, "computador 19%". */
function DeviceCell({ row }: { row: AccessPersonRow }) {
  const total = row.devices.desktop + row.devices.mobile;
  if (!total) return <td className="dev">—</td>;
  const [main, other]: [AccessDevice, AccessDevice] =
    row.devices.mobile > row.devices.desktop ? ['mobile', 'desktop'] : ['desktop', 'mobile'];
  if (!row.devices[other]) return <td className="dev">{DEVICE_LABEL[main]}</td>;
  return (
    <td className="dev">
      {DEVICE_LABEL[main]} {pct(row.devices[main] / total)}
      <small>
        {DEVICE_LABEL[other].toLowerCase()} {pct(row.devices[other] / total)}
      </small>
    </td>
  );
}

const SESSION_PREVIEW = 5;

/** O detalhe aberto embaixo da linha (regra 10): as sessões, da mais recente para a mais antiga, e o tempo da pessoa
 * por módulo e por obra. Tudo no recorte da tela. */
function PersonDetailPanel({ payload, filters, profileId }: { payload: AccessPayload; filters: AccessFilters; profileId: string }) {
  const detail = useMemo(() => personDetail(payload, filters, profileId), [payload, filters, profileId]);
  const [all, setAll] = useState(false);
  const total = detail.sessions.length;
  const sessions = all ? detail.sessions : detail.sessions.slice(0, SESSION_PREVIEW);
  const heading =
    total <= SESSION_PREVIEW
      ? `Sessões (${total})`
      : all
        ? `Sessões (todas as ${total})`
        : `Sessões (${SESSION_PREVIEW} mais recentes de ${total})`;

  // Até cinco módulos, um por linha; mais que isso, os quatro maiores e "Outros N módulos" (como no modelo).
  const screenRows = (screens: AccessScreenShare[]): BarRow[] => {
    const toRow = (screen: AccessScreenShare): BarRow => ({
      key: screen.screen,
      number: accessScreen(screen.screen).number,
      label: accessScreen(screen.screen).label,
      seconds: screen.seconds,
      tone: `ac-g-${screen.group}`,
      right: pct(screen.share),
      title: screen.fieldShare > 0 ? `${pct(screen.fieldShare)} no modo de campo` : undefined,
    });
    if (screens.length <= SESSION_PREVIEW) return screens.map(toRow);
    const rest = screens.slice(SESSION_PREVIEW - 1);
    return [
      ...screens.slice(0, SESSION_PREVIEW - 1).map(toRow),
      {
        key: 'outros',
        label: `Outros ${rest.length} módulos`,
        seconds: sumSeconds(rest),
        tone: 'ac-g-adm',
        right: pct(rest.reduce((sum, screen) => sum + screen.share, 0)),
        title: rest.map(screen => screenLabel(screen.screen)).join(', '),
      },
    ];
  };

  return (
    <div className="ac-detail-grid">
      <div>
        <p className="ac-mini-h">{heading}</p>
        <div className="ac-sess">
          {sessions.map(session => (
            <div key={session.id}>
              <div className="top">
                <span>{session.range}</span>
                <span>
                  {formatDuration(session.seconds)} ativos · {session.devices.map(device => DEVICE_LABEL[device].toLowerCase()).join(' e ')}
                </span>
              </div>
              <div className="mods">
                {session.works
                  .map(
                    work =>
                      `${work.workId === null ? OUTSIDE_WORKS_LABEL.toLowerCase() : work.label}: ${work.screens
                        .map(screen => `${screen.label} ${formatDuration(screen.seconds)}`)
                        .join(' · ')}`,
                  )
                  .join(' · ')}
              </div>
            </div>
          ))}
        </div>
        {total > SESSION_PREVIEW && (
          <button type="button" className="text-link ac-more" onClick={() => setAll(value => !value)}>
            {all ? `Mostrar só as ${SESSION_PREVIEW} mais recentes` : `Ver as ${total} sessões`}
          </button>
        )}
      </div>
      <div className="ac-detail-side">
        <div>
          <p className="ac-mini-h">Tempo por módulo</p>
          <Bars rows={screenRows(detail.screens)} />
        </div>
        <div>
          <p className="ac-mini-h">Tempo por obra</p>
          <Bars
            rows={detail.works.map(work => ({
              key: work.key,
              label: work.label,
              seconds: work.seconds,
              tone: work.workId === null ? 'ac-g-adm' : 'ac-g-work',
              right: pct(work.share),
            }))}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- tempo por módulo e por obra (regra 11)

interface BarRow {
  key: string;
  number?: string;
  label: string;
  seconds: number;
  tone: string;
  /** A última coluna: pessoas (quadros) ou parte do tempo (detail). */
  right: string;
  title?: string;
}

/** Barras proporcionais à maior linha, com o tempo e a última coluna. */
function Bars({ rows, head }: { rows: BarRow[]; head?: [string, string] }) {
  const max = Math.max(0, ...rows.map(row => row.seconds));
  return (
    <div className="ac-bars">
      {head && (
        <div className="thd">
          <span>{head[0]}</span>
          <span />
          <span className="r">Tempo</span>
          <span className="p">{head[1]}</span>
        </div>
      )}
      {rows.map(row => (
        <div key={row.key} title={row.title}>
          <span className="txt">
            {row.number && <span className="n">{row.number}</span>}
            {row.label}
          </span>
          <span className="dsh-track">
            <b className={row.tone} style={{ width: `${max ? (row.seconds / max) * 100 : 0}%` }} />
          </span>
          <span className="r">{formatDuration(row.seconds)}</span>
          <span className="p">{row.right}</span>
        </div>
      ))}
    </div>
  );
}

function ScreensBoard({ view, empty }: { view: AccessView; empty: string }) {
  return (
    <section data-tour="acessos-modulos" className="dsh-mod" aria-labelledby="acessos-modulos-titulo">
      <div className="dsh-mod-h">
        <h2 id="acessos-modulos-titulo">
          Tempo por módulo
          <span className="sub">{view.filtered ? 'no recorte' : 'todas as pessoas'} · maior primeiro</span>
        </h2>
      </div>
      <div className="dsh-mod-b">
        {view.screens.length ? (
          <Bars
            head={['Módulo', 'Pessoas']}
            rows={view.screens.map(screen => ({
              key: screen.key,
              number: screen.number,
              label: screen.label,
              seconds: screen.seconds,
              tone: `ac-g-${screen.group}`,
              right: String(screen.people),
              title: screen.fieldSeconds > 0 ? `${formatDuration(screen.fieldSeconds)} no modo de campo` : undefined,
            }))}
          />
        ) : (
          <p className="ac-empty">{empty}</p>
        )}
        {view.screens.length > 0 && view.unusedScreens.length > 0 && (
          <p className="ac-note">Sem uso no período: {view.unusedScreens.join(', ')}.</p>
        )}
      </div>
    </section>
  );
}

function WorksBoard({ view, empty }: { view: AccessView; empty: string }) {
  return (
    <section data-tour="acessos-obras" className="dsh-mod" aria-labelledby="acessos-obras-titulo">
      <div className="dsh-mod-h">
        <h2 id="acessos-obras-titulo">
          Tempo por obra
          <span className="sub">{view.filtered ? 'no recorte' : 'todas as pessoas'} · maior primeiro</span>
        </h2>
      </div>
      <div className="dsh-mod-b">
        {view.works.length ? (
          <Bars
            head={['Obra', 'Pessoas']}
            rows={view.works.map(work => ({
              key: work.key,
              label: work.label,
              seconds: work.seconds,
              tone: work.workId === null ? 'ac-g-adm' : 'ac-g-work',
              right: String(work.people),
            }))}
          />
        ) : (
          <p className="ac-empty">{empty}</p>
        )}
        <p className="ac-note">"Fora das obras" = Lista de obras, Dashboard geral e as telas de administração.</p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- uso por dia (regra 12)

/** Limites da rampa em minutos ativos: dia 0 / 1–30 / 31–60 / 61–90 / 91+; semana 0 / 1–120 / 121–300 / 301–600 / 601+. */
const HEAT_STEPS: Record<AccessHeat['grouping'], [number, number, number]> = { day: [30, 60, 90], week: [120, 300, 600] };
const RAMP = ['#eef3f7', '#dbeafe', '#93c5fd', '#3b82f6', '#1d4ed8'];
const zoneOf = (seconds: number, steps: [number, number, number]) => {
  if (!(seconds > 0)) return 0;
  const minutes = Math.round(seconds / 60);
  return minutes <= steps[0] ? 1 : minutes <= steps[1] ? 2 : minutes <= steps[2] ? 3 : 4;
};
const minutesOf = (seconds: number) => {
  if (!(seconds > 0)) return '0';
  const minutes = Math.round(seconds / 60);
  return minutes ? String(minutes) : '<1';
};

function Ramp({ grouping }: { grouping: AccessHeat['grouping'] }) {
  const [a, b, c] = HEAT_STEPS[grouping];
  const ranges = ['nenhum minuto', `1 a ${a} min`, `${a + 1} a ${b} min`, `${b + 1} a ${c} min`, `${c + 1} min ou mais`];
  return (
    <span className="ac-ramp" role="img" aria-label={`Cores: ${ranges.join(', ')}`}>
      0
      {RAMP.map((color, index) => (
        <i key={color} style={{ background: color }} title={ranges[index]} />
      ))}
      {c + 1}+
    </span>
  );
}

function HeatBoard({ heat, empty }: { heat: AccessHeat; empty: string }) {
  const steps = HEAT_STEPS[heat.grouping];
  return (
    <section data-tour="acessos-dias" className="dsh-mod" aria-labelledby="acessos-dias-titulo">
      <div className="dsh-mod-h">
        <h2 id="acessos-dias-titulo">
          Uso por dia
          <span className="sub">
            minutos ativos por pessoa{heat.grouping === 'week' ? ', por semana' : ''} · <Ramp grouping={heat.grouping} />
          </span>
        </h2>
      </div>
      {heat.rows.length ? (
        <div className="ac-xscroll">
          <table className="ac-heat">
            <thead>
              <tr>
                <th scope="col">Pessoa</th>
                {heat.columns.map(column => {
                  const [top, ...rest] = column.label.split(' ');
                  return (
                    <th key={column.key} scope="col" title={column.title}>
                      {top}
                      <small>{rest.join(' ')}</small>
                    </th>
                  );
                })}
                <th scope="col" className="tot">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {heat.rows.map(row => (
                <tr key={row.profileId}>
                  <td className="nm" title={row.name}>
                    {row.name}
                  </td>
                  {row.cells.map((seconds, index) => (
                    <td
                      key={heat.columns[index]?.key ?? index}
                      className={`h z${zoneOf(seconds, steps)}`}
                      title={`${row.name} · ${heat.columns[index]?.title ?? ''}: ${formatDuration(seconds)}`}
                    >
                      <span>{minutesOf(seconds)}</span>
                    </td>
                  ))}
                  <td className="tot">{formatDuration(row.total)}</td>
                </tr>
              ))}
              <tr className="total">
                <td className="nm">{heat.grouping === 'day' ? 'Pessoas no dia' : 'Pessoas na semana'}</td>
                {heat.peoplePerColumn.map((count, index) => (
                  <td key={heat.columns[index]?.key ?? index}>{count}</td>
                ))}
                <td className="tot">{heat.peopleTotal}</td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <div className="dsh-mod-b">
          <p className="ac-empty">{empty}</p>
        </div>
      )}
    </section>
  );
}

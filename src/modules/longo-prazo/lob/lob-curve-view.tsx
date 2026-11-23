'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { LocalDate } from '@/domain/lob';
import { curveWeightingText, lobCurve, type LobCurve, type LobCurveMonth } from '@/domain/lob-curve';
import { performanceBaseline } from '@/domain/lob-performance';
import { HelpNote } from '@/modules/layout/help-note';
import { usePlanning } from '@/modules/planejamento/planning-provider';
import { Callout, LoadState, StatCard } from '@/modules/planejamento/ui';
import { formatDate, workPath } from '@/shared/format';
import { useLob } from './lob-api';
import { CurveChart, Legend, monthLong, monthShort, MonthlyChart, pct, points } from './lob-curve-charts';

/** Visão "Curva S" da aba 1 (23/11/2026, retorno do Atmos: os gráficos de curva S e de progresso mensal
 * que a equipe usava no Prevision). Só leitura, para todos os perfis: são percentuais. Os números saem
 * de `lobCurve` (`src/domain/lob-curve.ts`), no mesmo peso do avanço físico e do IDP. */

/** Data civil de hoje no fuso do navegador, para quando o planejamento ainda não respondeu. */
const localToday = (): LocalDate => new Date().toLocaleDateString('en-CA');
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3,2 pp abaixo do previsto" na cor do sinal; o texto diz o lado, a cor só reforça. */
function Deviation({ value, against }: { value: number; against: string }) {
  const shown = Math.round(Math.abs(value) * 10) / 10;
  if (shown === 0) return <b className="text-slate-700">igual {against}</b>;
  return (
    <b className={value < 0 ? 'text-danger' : 'text-success'}>
      {points(Math.abs(value)).replace('+', '')} {value < 0 ? 'abaixo' : 'acima'} {against}
    </b>
  );
}

/** A linha do critério do peso, com o caminho até a visão Custos quando falta custo em algum pacote. */
function WeightNote({
  curve,
  costsHref,
  readOnly,
  costsUnavailable,
}: {
  curve: LobCurve;
  costsHref: string;
  readOnly: boolean;
  costsUnavailable: boolean;
}) {
  const { weights } = curve;
  const missing = weights.fallback === 'missing';
  return (
    <p data-tour="longo-curva-peso" className="text-xs text-slate-500">
      Avanço <strong className="font-semibold text-slate-700">{curveWeightingText(weights)}</strong>
      {missing &&
        !costsUnavailable &&
        ` (${weights.missingServiceIds.length} de ${plural(weights.servicesWithBlocks.length, 'pacote', 'pacotes')})`}
      {missing && costsUnavailable && ' (a apropriação de custos ainda não foi ativada no banco)'}.{' '}
      {missing && !costsUnavailable && (
        <>
          <Link className="text-link font-semibold print:hidden" href={costsHref}>
            {readOnly ? 'Ver custos' : 'Apropriar custos'}
          </Link>{' '}
        </>
      )}
      É o mesmo peso dos cartões “Avanço físico” e “IDP” da Linha de Balanço.
    </p>
  );
}

const th = 'px-3 py-2 text-[11px] font-bold tracking-wider whitespace-nowrap text-brand-800 uppercase first:pl-4 last:pr-4';
const td = 'px-3 py-1.5 whitespace-nowrap tabular-nums first:pl-4 last:pr-4';

/** A tabela dos dois gráficos: os mesmos números, mês a mês. É também a alternativa acessível aos SVG. */
function CurveTable({
  months,
  today,
  hasBaseline,
  hasReal,
}: {
  months: readonly LobCurveMonth[];
  today: LocalDate;
  hasBaseline: boolean;
  hasReal: boolean;
}) {
  const carried = months.some(m => m.realCarried);
  const currentMonth = today.slice(0, 7);
  const dash = <span className="text-slate-400">—</span>;
  return (
    <section data-tour="longo-curva-tabela" aria-labelledby="curva-tabela-titulo" className="panel min-w-0">
      <div className="border-b border-slate-100 px-4 py-3">
        <h3 id="curva-tabela-titulo" className="text-sm font-bold text-slate-900">
          Mês a mês
        </h3>
        <p className="mt-0.5 text-xs text-slate-500">
          Acumulado no último dia de cada mês e ganho no mês, em % do avanço físico da obra. O desvio é o realizado menos o previsto, em
          pontos percentuais.
          {carried && ' Realizado em cinza: mês sem medição nova, que repete a última.'}
        </p>
      </div>
      <div className="custom-scrollbar overflow-x-auto print:overflow-visible">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-brand-100 bg-brand-50">
            <tr>
              <th scope="col" rowSpan={2} className={`${th} sticky left-0 z-[1] bg-brand-50 align-bottom`}>
                Mês
              </th>
              <th
                scope="colgroup"
                colSpan={(hasBaseline ? 1 : 0) + 1 + (hasReal ? 2 : 0)}
                className={`${th} border-l border-brand-100 pb-0 text-center`}
              >
                Acumulado no fim do mês
              </th>
              <th
                scope="colgroup"
                colSpan={(hasBaseline ? 1 : 0) + 1 + (hasReal ? 1 : 0)}
                className={`${th} border-l border-brand-100 pb-0 text-center`}
              >
                Ganho no mês
              </th>
            </tr>
            <tr>
              {hasBaseline && (
                <th scope="col" className={`${th} border-l border-brand-100 text-right`}>
                  Linha de base
                </th>
              )}
              <th scope="col" className={`${th} text-right ${hasBaseline ? '' : 'border-l border-brand-100'}`}>
                Previsto
              </th>
              {hasReal && (
                <>
                  <th scope="col" className={`${th} text-right`}>
                    Realizado
                  </th>
                  <th scope="col" className={`${th} text-right`}>
                    Desvio
                  </th>
                </>
              )}
              {hasBaseline && (
                <th scope="col" className={`${th} border-l border-brand-100 text-right`}>
                  Linha de base
                </th>
              )}
              <th scope="col" className={`${th} text-right ${hasBaseline ? '' : 'border-l border-brand-100'}`}>
                Previsto
              </th>
              {hasReal && (
                <th scope="col" className={`${th} text-right`}>
                  Realizado
                </th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {months.map(m => {
              const current = m.month === currentMonth;
              const deviation = m.real !== undefined ? m.real - m.planned : undefined;
              const realTitle = m.realFrom
                ? m.realCarried
                  ? `Sem medição no mês: repete a medição nº ${m.realFrom.number}, de ${formatDate(m.realFrom.date)}`
                  : `Medição nº ${m.realFrom.number}, de ${formatDate(m.realFrom.date)}`
                : undefined;
              return (
                <tr key={m.month} className={current ? 'bg-amber-50/70' : undefined}>
                  <th
                    scope="row"
                    className={`${td} sticky left-0 z-[1] font-semibold text-slate-800 ${current ? 'bg-amber-50' : 'bg-white'}`}
                  >
                    {monthShort(m.month)}
                    {current && <span className="ml-1.5 text-[11px] font-bold text-warning">mês atual</span>}
                  </th>
                  {hasBaseline && (
                    <td className={`${td} border-l border-slate-100 text-right text-slate-700`}>
                      {m.baseline !== undefined ? pct(m.baseline) : dash}
                    </td>
                  )}
                  <td className={`${td} text-right text-slate-700 ${hasBaseline ? '' : 'border-l border-slate-100'}`}>{pct(m.planned)}</td>
                  {hasReal && (
                    <>
                      <td
                        className={`${td} text-right ${m.realCarried ? 'text-slate-400' : 'font-semibold text-slate-900'}`}
                        title={realTitle}
                      >
                        {m.real !== undefined ? pct(m.real) : dash}
                      </td>
                      <td className={`${td} text-right`}>
                        {deviation !== undefined ? (
                          <span
                            className={
                              Math.abs(deviation) < 0.05
                                ? 'text-slate-600'
                                : deviation < 0
                                  ? 'font-semibold text-danger'
                                  : 'font-semibold text-success'
                            }
                          >
                            {points(deviation)}
                          </span>
                        ) : (
                          dash
                        )}
                      </td>
                    </>
                  )}
                  {hasBaseline && (
                    <td className={`${td} border-l border-slate-100 text-right text-slate-700`}>
                      {m.baselineGain !== undefined ? pct(m.baselineGain) : dash}
                    </td>
                  )}
                  <td className={`${td} text-right text-slate-700 ${hasBaseline ? '' : 'border-l border-slate-100'}`}>
                    {pct(m.plannedGain)}
                  </td>
                  {hasReal && (
                    <td className={`${td} text-right ${m.realCarried ? 'text-slate-400' : 'text-slate-900'}`} title={realTitle}>
                      {m.realGain !== undefined ? pct(m.realGain) : dash}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function LobCurveView({ workId }: { workId: string }) {
  const { state, reload } = useLob(workId);
  const planning = usePlanning();
  const [baselineId, setBaselineId] = useState('');
  const [retrying, setRetrying] = useState(false);

  const ready = planning.state === 'ready' ? planning : undefined;
  const today = ready?.planning.today ?? localToday();
  const me = ready?.planning.data.users.find(u => u.id === ready.actorId);
  // Só muda o texto do atalho para os custos: a visão é de leitura para todos.
  const readOnly = !me || me.role === 'viewer';

  const data = state.status === 'ready' ? state.data : undefined;
  const curve = useMemo(
    () => (data ? lobCurve(data, { baselineId: baselineId || undefined, today }) : undefined),
    [data, baselineId, today],
  );
  const baselines = useMemo(() => (data ? [...data.baselines].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : []), [data]);
  const base = workPath(workId, 'longo-prazo');

  const help = (
    <HelpNote title="Como ler a Curva S">
      <p>
        A <strong>Curva S</strong> mostra o avanço físico acumulado da obra, mês a mês, em três séries: a <strong>linha de base</strong> (as
        datas guardadas), o <strong>previsto</strong> (o cronograma atual da Linha de Balanço) e o <strong>realizado</strong> (as medições
        salvas). O valor de cada mês é o do último dia do mês.
      </p>
      <p>
        O <strong>realizado</strong> só existe onde há medição salva: o mês usa a última medição até o fim dele, e a medição em aberto não
        entra. Mês passado sem medição nova repete a última (sem ponto na curva e com ganho zero); mês futuro fica em branco. O realizado do
        mês em andamento é desenhado até a linha de “hoje”.
      </p>
      <p>
        O <strong>Progresso mensal</strong> é o ganho de cada série no mês: o acumulado do mês menos o do mês anterior. O primeiro mês com
        medição leva tudo o que foi realizado até ali.
      </p>
      <p>
        O peso de cada bloco é o mesmo do avanço físico e do IDP: pelo custo quando todos os pacotes com blocos têm custo apropriado, senão
        pela duração. A linha de base é a escolhida no seletor; sem escolha, a manual mais recente, como no IDP. Bloco criado depois da
        linha de base entra nela com as datas atuais.
      </p>
    </HelpNote>
  );
  const selectedBaseline = curve?.baseline?.id ?? '';
  const hasDefaultBaseline = !!data && !!performanceBaseline(data.baselines);
  const header = (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1">
          <h2 className="text-lg font-bold text-slate-900">Curva S</h2>
          {help}
        </div>
        <p className="text-sm text-slate-500">
          O avanço físico acumulado e o ganho de cada mês: linha de base, previsto pelo cronograma atual e realizado pelas medições.
        </p>
      </div>
      {data && baselines.length > 0 && (
        <label data-tour="longo-curva-linha-base" className="flex items-center gap-2 text-sm font-semibold text-slate-700 print:hidden">
          Linha de base
          <select
            className="field w-auto max-w-[18rem] py-2 font-normal"
            value={selectedBaseline}
            onChange={event => setBaselineId(event.target.value)}
          >
            {/* Sem linha de base manual não há padrão (regra do IDP): a curva abre sem a série. */}
            {!hasDefaultBaseline && <option value="">Nenhuma</option>}
            {baselines.map(b => (
              <option key={b.id} value={b.id}>
                {b.name}
                {b.automatic ? ' (automática)' : ''}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );

  if (state.status === 'loading')
    return (
      <>
        {header}
        <LoadState rows={8} />
      </>
    );
  if (state.status === 'error')
    return (
      <>
        {header}
        <div className="panel p-6">
          <p role="alert" className="text-sm font-semibold text-slate-800">
            Não foi possível carregar a Curva S.
          </p>
          <p className="mt-1 text-sm text-slate-500">{state.message}</p>
          <button
            type="button"
            className="button-ghost mt-4"
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              reload().finally(() => setRetrying(false));
            }}
          >
            <RefreshCw size={15} aria-hidden />
            {retrying ? 'Tentando…' : 'Tentar de novo'}
          </button>
        </div>
      </>
    );
  if (state.status === 'unavailable' || !data || !curve)
    return (
      <>
        {header}
        <Callout tone="warning" role="status">
          A Linha de Balanço ainda não foi ativada no banco: aplique a migração 0038.
        </Callout>
      </>
    );
  if (curve.status === 'no-blocks' || !curve.months.length)
    return (
      <>
        {header}
        <div className="panel flex flex-col items-start gap-3 p-6">
          <p className="text-sm font-semibold text-slate-800">Nenhum bloco lançado ainda.</p>
          <p className="text-sm text-slate-500">
            A Curva S nasce do cronograma da Linha de Balanço: lance um fluxo de serviços nos locais da obra e ela aparece aqui.
          </p>
          <Link className="button-ghost" href={base}>
            Abrir a Linha de Balanço
          </Link>
        </div>
      </>
    );

  const { months, last } = curve;
  const hasBaseline = !!curve.baseline;
  const hasReal = curve.measurements.length > 0;
  const costsUnavailable = state.status === 'ready' && state.costAccess === 'unavailable';
  const period = `${monthLong(months[0].month)} a ${monthLong(months[months.length - 1].month)}`;
  const baselineName = curve.baseline ? `“${curve.baseline.name}”${curve.baseline.automatic ? ' (automática)' : ''}` : undefined;

  return (
    <div className="space-y-4">
      {header}
      {!hasBaseline && (
        <Callout tone="info" role="status">
          {baselines.length
            ? 'Esta obra só tem linhas de base automáticas: escolha uma no seletor acima ou guarde uma linha de base na Linha de Balanço. Por enquanto, a curva mostra só o previsto e o realizado.'
            : 'Esta obra ainda não tem linha de base: a curva mostra só o previsto e o realizado. Guarde uma no botão “Linhas de base” da Linha de Balanço para comparar com o plano original.'}
        </Callout>
      )}
      {!hasReal && (
        <Callout tone="info" role="status">
          Ainda não há medição salva nesta obra, então não há curva de realizado. Ela aparece depois da primeira medição salva na visão{' '}
          <Link className="text-link font-semibold" href={`${base}?visao=medicoes`}>
            Medições
          </Link>
          .
        </Callout>
      )}

      {last && (
        <div data-tour="longo-curva-resumo" className={`grid gap-4 sm:grid-cols-2 ${hasBaseline ? 'xl:grid-cols-3' : ''}`}>
          <StatCard
            label="Realizado"
            value={pct(last.real)}
            hint={`na última medição salva: nº ${last.number}, de ${formatDate(last.date)}`}
          />
          <StatCard
            label="Previsto na mesma data"
            value={pct(last.planned)}
            hint={
              <>
                pelo cronograma atual · realizado <Deviation value={last.real - last.planned} against="do previsto" />
              </>
            }
          />
          {last.baseline !== undefined && (
            <StatCard
              label="Linha de base na mesma data"
              value={pct(last.baseline)}
              hint={
                <>
                  {baselineName} · realizado <Deviation value={last.real - last.baseline} against="da linha de base" />
                </>
              }
            />
          )}
        </div>
      )}

      <WeightNote curve={curve} costsHref={`${base}?visao=custos`} readOnly={readOnly} costsUnavailable={costsUnavailable} />

      <section data-tour="longo-curva-grafico" aria-labelledby="curva-s-titulo" className="panel min-w-0 break-inside-avoid p-4">
        <div className="mb-2 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div>
            <h3 id="curva-s-titulo" className="text-sm font-bold text-slate-900">
              Curva S — avanço acumulado
            </h3>
            <p className="mt-0.5 text-xs text-slate-500">
              % do avanço físico no fim de cada mês, de {period}
              {baselineName ? ` · linha de base ${baselineName}` : ''}
            </p>
          </div>
          <Legend
            items={[
              ...(hasBaseline ? [{ series: 'baseline' as const, shape: 'line' as const, text: 'Linha de base' }] : []),
              { series: 'planned', shape: 'line', text: 'Previsto (cronograma atual)' },
              ...(hasReal ? [{ series: 'real' as const, shape: 'line' as const, text: 'Realizado (ponto = mês com medição)' }] : []),
              { series: 'today', shape: 'line', text: `Hoje (${formatDate(today)})` },
            ]}
          />
        </div>
        <CurveChart months={months} today={today} hasBaseline={hasBaseline} />
      </section>

      <section data-tour="longo-curva-mensal" aria-labelledby="curva-mensal-titulo" className="panel min-w-0 break-inside-avoid p-4">
        <div className="mb-2 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div>
            <h3 id="curva-mensal-titulo" className="text-sm font-bold text-slate-900">
              Progresso mensal
            </h3>
            <p className="mt-0.5 text-xs text-slate-500">
              Ganho de cada mês, em % do avanço físico da obra: o acumulado do mês menos o do mês anterior
            </p>
          </div>
          <Legend
            items={[
              ...(hasBaseline ? [{ series: 'baseline' as const, shape: 'bar' as const, text: 'Linha de base' }] : []),
              { series: 'planned', shape: 'bar', text: 'Previsto' },
              ...(hasReal ? [{ series: 'real' as const, shape: 'bar' as const, text: 'Realizado' }] : []),
            ]}
          />
        </div>
        <MonthlyChart months={months} today={today} hasBaseline={hasBaseline} hasReal={hasReal} />
      </section>

      <CurveTable months={months} today={today} hasBaseline={hasBaseline} hasReal={hasReal} />
    </div>
  );
}

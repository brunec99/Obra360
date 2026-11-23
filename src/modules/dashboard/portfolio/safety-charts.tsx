'use client';
import { SAFETY_CONSEQUENCES } from '@/domain/safety';
import { DonutRing, donutColor, sharePercent } from '@/modules/terminalidade/donut-chart';
import type { DonutSlice } from '@/modules/terminalidade/terminality-view';
import { Legend } from '../charts';
import { pct, plural, signedDays } from '../model';
import { oneDecimal, SAFETY_CONSEQUENCE_COLORS, safetyGrave } from './portfolio-charts';
import type { PortfolioRow, PortfolioSafetyDeath, PortfolioSafetyTypes, PortfolioTotals } from './types';

/** O quadro "3.1 Segurança do trabalho" do Dashboard geral, redesenhado em 23/11/2026 a pedido da equipe de SST
 * ("não está muito claro e didático"; "colunas e gráfico de pizza"; "os dias de risco de morte no geral e não
 * somente no campo da obra"). No lugar das três listas de barras com os números numa linha só de texto:
 * 1. seis cartões com o nome de cada número por extenso, o último deles "Risco de morte em aberto";
 * 2. colunas de feitos × finalizados por obra, com o valor em cima de cada coluna;
 * 3. duas pizzas (a rosca da aba 3.1) dos feitos no período, somando as obras: por consequência e por tipo;
 * 4. uma tabela por obra, com título em cada coluna, a linha "Todas as obras" e o risco de morte de cada obra.
 * Os mesmos componentes servem à tela e à folha do PDF; as regras de cálculo são as de `safety.ts`. */

type SafetyTotals = PortfolioTotals['safety'];

const OPENED = '#eb6834';
const RESOLVED = '#2a78d6';
const NOUN = ['apontamento', 'apontamentos'] as const;
const sumOf = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const days = (value: number) => plural(value, 'dia', 'dias');
const average = (value: number | undefined) => (value === undefined ? '—' : oneDecimal(value));

/** A linha de baixo do cartão "Risco de morte em aberto": com aberto, há quanto tempo o mais antigo espera e em
 * que obra; sem nenhum, quanto tempo levaram os finalizados no período. */
export function deathHint(death: SafetyTotals['death']): string {
  if (death.open) {
    const oldest = death.oldestOpenDays ?? 0;
    const where = death.oldestWork ? ` (${death.oldestWork.code || death.oldestWork.name})` : '';
    return `o mais antigo ${oldest === 0 ? 'aberto hoje' : `há ${days(oldest)}`}${where} · em ${plural(death.works, 'obra', 'obras')}`;
  }
  if (death.resolved)
    return `nenhum aberto · ${plural(death.resolved, 'finalizado', 'finalizados')} no período, em ${average(death.averageDaysToResolve)} dias em média`;
  return 'nenhum aberto';
}

/** Os seis números do quadro, somando as obras, cada um com o nome por extenso e de onde vem. */
export function SafetyKpis({ total, end }: { total: SafetyTotals; end: string }) {
  const diff = total.open - total.openAtStart;
  const death = total.death;
  return (
    <div className="dsh-kpis pf-sst-kpis">
      <div className="dsh-kpi">
        <div className="l">
          <span>Feitos no período</span>
        </div>
        <div className="v">{total.opened}</div>
        <div className="h">pela data do apontamento</div>
      </div>
      <div className="dsh-kpi">
        <div className="l">
          <span>Finalizados no período</span>
        </div>
        <div className="v">{total.resolved}</div>
        <div className="h">pela data de correção</div>
      </div>
      <div className="dsh-kpi main">
        <div className="l">
          <span>Em aberto em {end}</span>
        </div>
        <div className="v">
          {total.open}
          <span className={`dl ${diff > 0 ? 't-bad' : diff < 0 ? 't-good' : 't-mut'}`}>
            {diff > 0 ? `▲ ${diff}` : diff < 0 ? `▼ ${-diff}` : '= 0'}
          </span>
        </div>
        <div className="h">{total.openAtStart} no início do período</div>
      </div>
      <div className="dsh-kpi">
        <div className="l">
          <span>Abertos há mais de 7 dias</span>
        </div>
        <div className={`v ${total.openOver7 ? 't-bad' : 't-good'}`}>{total.openOver7}</div>
        <div className="h">{total.worksOver7 ? `em ${plural(total.worksOver7, 'obra', 'obras')}` : 'em nenhuma obra'}</div>
      </div>
      <div className="dsh-kpi">
        <div className="l">
          <span>Média de dias para resolver</span>
        </div>
        <div className="v">{average(total.averageDaysToResolve)}</div>
        <div className="h">dos finalizados no período</div>
      </div>
      <div className={`dsh-kpi${death.open ? ' death' : ''}`}>
        <div className="l">
          <span>Risco de morte em aberto</span>
        </div>
        <div className={`v ${death.open ? 't-bad' : 't-good'}`}>{death.open}</div>
        <div className="h">{deathHint(death)}</div>
      </div>
    </div>
  );
}

/** Colunas por obra: feitos (laranja) e finalizados (azul) no período, com o valor em cima de cada coluna. */
export function SafetyColumns({ rows }: { rows: readonly PortfolioRow[] }) {
  const list = rows.filter(row => row.safety);
  if (!list.length) return <p className="dsh-empty">Nenhuma obra com apontamentos de segurança.</p>;
  const peak = Math.max(1, ...list.map(row => Math.max(row.safety!.opened, row.safety!.resolved)));
  // A altura desconta a linha do número, para a coluna mais alta não empurrar o valor para fora.
  const height = (value: number) => `calc((100% - 15px) * ${value / peak})`;
  return (
    <>
      <div className="pf-cols">
        {list.map(row => {
          const s = row.safety!;
          return (
            <div
              key={row.work.id}
              className="pf-col"
              role="img"
              aria-label={`${row.work.name}: ${plural(s.opened, 'feito', 'feitos')} e ${plural(s.resolved, 'finalizado', 'finalizados')} no período`}
              title={`${row.work.name}\n${plural(s.opened, 'feito', 'feitos')} e ${plural(s.resolved, 'finalizado', 'finalizados')} no período`}
            >
              <div className="bars">
                <span className="c">
                  <em>{s.opened}</em>
                  <b style={{ height: height(s.opened), background: OPENED }} />
                </span>
                <span className="c">
                  <em>{s.resolved}</em>
                  <b style={{ height: height(s.resolved), background: RESOLVED }} />
                </span>
              </div>
              <span className="nm">{row.work.code || row.work.name}</span>
            </div>
          );
        })}
      </div>
      <Legend
        items={[
          { color: OPENED, text: 'feitos no período' },
          { color: RESOLVED, text: 'finalizados no período' },
        ]}
      />
    </>
  );
}

function Pie({
  slices,
  total,
  title,
  colors,
  hints,
}: {
  slices: DonutSlice[];
  total: number;
  title: string;
  colors?: readonly string[];
  /** Dica de cada fatia na legenda (a contagem por obra), na ordem de `slices`. */
  hints?: readonly (string | undefined)[];
}) {
  return (
    <div className="dsh-donut pf-pie">
      <DonutRing slices={slices} total={total} title={title} noun={NOUN} colors={colors} />
      <div className="dsh-donut-leg">
        {slices.map((slice, index) => (
          <div key={slice.key} title={hints?.[index]}>
            <i style={{ background: colors?.[index] ?? donutColor(slice, index) }} />
            <span className="txt">
              {slice.label}
              {slice.others ? ` (${plural(slice.others, 'tipo', 'tipos')})` : ''}
            </span>
            <span className="num">{slice.count}</span>
            <span className="pc">{sharePercent(slice)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Pizza dos feitos no período pela consequência, somando as obras, com a cor de cada consequência (Morte em
 * vermelho) e, embaixo, os graves (Morte + Severa). */
export function SafetyConsequencePie({ total }: { total: SafetyTotals }) {
  const made = sumOf(total.byConsequence);
  if (!made) return <p className="dsh-empty">Nenhum apontamento feito no período.</p>;
  const kept = SAFETY_CONSEQUENCES.map((name, index) => ({ name, index, count: total.byConsequence[index] ?? 0 })).filter(
    item => item.count > 0,
  );
  const grave = safetyGrave(total.byConsequence);
  return (
    <>
      <Pie
        title="Apontamentos feitos no período por consequência"
        total={made}
        slices={kept.map(item => ({ key: item.name, label: item.name, count: item.count, share: item.count / made }))}
        colors={kept.map(item => SAFETY_CONSEQUENCE_COLORS[item.index])}
      />
      <p className="pf-pie-note">
        <b>{grave}</b> {grave === 1 ? 'grave' : 'graves'} (Morte + Severa) · {pct((grave / made) * 100)} dos feitos
      </p>
    </>
  );
}

/** Quantos tipos a pizza "Por tipo" mostra antes de juntar o resto em "Outros". */
const TYPES_IN_PIE = 5;

/** As fatias da pizza "Por tipo": os tipos de `types.rows` (até 6) cabem inteiros quando não há mais nenhum;
 * havendo mais, ficam os 5 maiores e o resto vira "Outros", com a quantidade de tipos juntados. */
export function safetyTypeSlices(types: PortfolioSafetyTypes, made: number): DonutSlice[] {
  if (!made) return [];
  const whole = types.kinds <= types.rows.length;
  const kept = whole ? types.rows : types.rows.slice(0, TYPES_IN_PIE);
  const slices: DonutSlice[] = kept.map(row => ({ key: row.key, label: row.label, count: row.total, share: row.total / made }));
  const rest = made - sumOf(kept.map(row => row.total));
  if (!whole && rest > 0)
    slices.push({ key: 'outros', label: 'Outros', count: rest, share: rest / made, others: types.kinds - kept.length });
  return slices;
}

/** Pizza dos feitos no período pelo tipo de apontamento, somando as obras; a dica de cada tipo traz a contagem
 * em cada obra. */
export function SafetyTypePie({ types, total }: { types: PortfolioSafetyTypes; total: SafetyTotals }) {
  const slices = safetyTypeSlices(types, total.opened);
  if (!slices.length) return <p className="dsh-empty">Nenhum apontamento feito no período.</p>;
  const byKey = new Map(types.rows.map(row => [row.key, row]));
  return (
    <Pie
      title="Apontamentos feitos no período por tipo"
      total={total.opened}
      slices={slices}
      hints={slices.map(slice => {
        const row = byKey.get(slice.key);
        return row && !slice.others ? `${row.label}\n${row.byWork.map(item => `${item.work.name}: ${item.count}`).join('\n')}` : undefined;
      })}
    />
  );
}

function DeathCells({ death }: { death: PortfolioSafetyDeath }) {
  return (
    <>
      <td className={`v ${death.open ? 't-bad' : 't-good'}`}>{death.open}</td>
      <td className={death.open ? 't-bad' : 't-mut'}>
        {death.oldestOpenDays === undefined ? '—' : death.oldestOpenDays === 0 ? 'hoje' : `há ${days(death.oldestOpenDays)}`}
      </td>
      <td>{death.resolved}</td>
      <td>{average(death.averageDaysToResolve)}</td>
    </>
  );
}

function Cells({ block }: { block: Omit<SafetyTotals, 'works' | 'worksOver7' | 'death'> & { death: PortfolioSafetyDeath } }) {
  const diff = block.open - block.openAtStart;
  const made = sumOf(block.byConsequence);
  const grave = safetyGrave(block.byConsequence);
  return (
    <>
      <td>{block.opened}</td>
      <td>{block.resolved}</td>
      <td>{average(block.averageDaysToResolve)}</td>
      <td>
        {grave}
        {made ? <span className="t-mut"> · {pct((grave / made) * 100)}</span> : null}
      </td>
      <td className="v sep">{block.open}</td>
      <td className={diff > 0 ? 't-bad' : diff < 0 ? 't-good' : 't-mut'}>{signedDays(diff)}</td>
      <td className={block.openOver7 ? 't-bad' : 't-mut'}>{block.openOver7}</td>
      <DeathCells death={block.death} />
    </>
  );
}

/** A tabela por obra: o que aconteceu no período, o retrato no sábado final e o risco de morte, cada número na
 * sua coluna com o título por extenso; a última linha soma as obras. */
export function SafetyWorksTable({ rows, total, end }: { rows: readonly PortfolioRow[]; total: SafetyTotals; end: string }) {
  const list = rows.filter(row => row.safety);
  if (!list.length) return <p className="dsh-empty">Nenhuma obra com apontamentos de segurança.</p>;
  return (
    <div className="pf-sstt-scroll">
      <table className="pf-cmp pf-sstt">
        <thead>
          <tr>
            <th scope="col">Obra</th>
            <th scope="col">
              <span className="grp">No período</span>Feitos
            </th>
            <th scope="col">
              <span className="grp">&nbsp;</span>Finalizados
            </th>
            <th scope="col" title="Média de dias entre o apontamento e a correção, dos finalizados no período">
              <span className="grp">&nbsp;</span>Dias para resolver
            </th>
            <th scope="col" title="Feitos no período com consequência Morte ou Severa, e a parte deles nos feitos da obra">
              <span className="grp">&nbsp;</span>Graves (Morte + Severa)
            </th>
            <th scope="col" className="sep">
              <span className="grp">Em {end}</span>Em aberto
            </th>
            <th scope="col" title="Diferença do em aberto entre o início e o fim do período">
              <span className="grp">&nbsp;</span>Variação
            </th>
            <th scope="col">
              <span className="grp">&nbsp;</span>Há mais de 7 dias
            </th>
            <th scope="col" className="sep">
              <span className="grp">Risco de morte</span>Em aberto
            </th>
            <th scope="col" title="Há quantos dias está aberto o apontamento com risco de morte mais antigo">
              <span className="grp">&nbsp;</span>Mais antigo
            </th>
            <th scope="col">
              <span className="grp">&nbsp;</span>Finalizados
            </th>
            <th scope="col" title="Média de dias para resolver os apontamentos com risco de morte finalizados no período">
              <span className="grp">&nbsp;</span>Dias para resolver
            </th>
          </tr>
        </thead>
        <tbody>
          {list.map(row => (
            <tr key={row.work.id}>
              <td className="ob">
                <b>{row.work.name}</b>
                {row.work.code ? <small>{row.work.code}</small> : null}
              </td>
              <Cells block={row.safety!} />
            </tr>
          ))}
          <tr className="total">
            <td className="ob">
              <b>Todas as obras</b>
            </td>
            <Cells block={total} />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

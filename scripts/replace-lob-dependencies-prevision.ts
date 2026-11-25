/**
 * Troca as ligações deduzidas da Linha de Balanço de uma obra pelas reais do Prevision (25/11/2026,
 * Atmos). As regras ficam em `src/domain/lob-dependency-replacement.ts`; aqui só a leitura, o
 * relatório e a gravação.
 *
 * Uso:
 *   node --import tsx scripts/replace-lob-dependencies-prevision.ts --obra <código> --prevision <id> --out <pasta>
 *     [--json <resposta do Prevision>] [--linha-de-base "<nome>"] [--env-file <arquivo>]
 *   node --import tsx scripts/replace-lob-dependencies-prevision.ts --obra <código> --prevision <id> --out <pasta>
 *     --json <pasta>/prevision-<id>.json --actor <profileId> --confirmar <código do plano> [--backup <arquivo>]
 *     [--env-file <arquivo>] --apply
 *
 * Sem --apply é SIMULAÇÃO: só lê o banco (consultas, nada é gravado) e o Prevision (GraphQL, chave em
 * PREVISION_GRAPHQL_TOKEN; com --json, a resposta guardada), imprime o relatório e grava na pasta de
 * --out a resposta do Prevision (quando consultada), o relatório completo em JSON, a lista de
 * conflitos em CSV (para o Jorge) e todas as ligações em CSV, com a ação de cada uma. O fim do
 * relatório traz o "código do plano", que muda se qualquer coisa do plano mudar.
 *
 * Deduzidas = ligações com o instante de gravação da linha de base da importação (por padrão, a mais
 * antiga não automática que começa com "Prevision —"; --linha-de-base escolhe outra pelo nome). O
 * conjunto deduzido original é refeito pela mesma importação sobre as datas dessa linha de base, em
 * segunda a sexta sem feriados (a importação de 11/11/2026 é anterior ao calendário da obra).
 *
 * Com --apply grava, depois de conferir que o código do plano é o informado em --confirmar (o mesmo
 * da simulação revisada) e que não há ciclo, bloco que se mova nem reconstrução que falhou. Exige
 * --json, para gravar exatamente a resposta do Prevision que foi simulada. Antes de gravar, as
 * ligações e as datas atuais vão para o --backup (padrão: na pasta de --out). Numa gravação só
 * (`applyLobMutation`, a mesma da tela, que grava em ordem e sem transação do banco): linha de base
 * automática "Antes das ligações do Prevision dd/mm/aaaa", ligações que saem e ligações que entram.
 * Se a gravação falhar no meio, o estado anterior é restaurado a partir do backup. Nenhuma data muda.
 *
 * Ambiente: NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY, do processo ou de --env-file (para o
 * takt-hub, o .env.local do App-Takt; o deste repositório é do banco antigo). Nenhum segredo é impresso.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { activityFinish, type LobDependency } from '../src/domain/lob';
import { lobCalendarLabel } from '../src/domain/lob-calendar';
import { previsionApiCalendar, type PrevisionApiProject } from '../src/domain/lob-prevision-import';
import {
  planDependencyReplacement,
  reconstructDeducedDependencies,
  replacementBaseline,
  translatePrevisionLinks,
  type DependencyReplacementPlan,
  type MergedRealLink,
  type RealLink,
} from '../src/domain/lob-dependency-replacement';
import { fetchPrevisionGraphqlProject } from '../src/infrastructure/integrations/prevision/graphql';
import type { LobMutation, LobTable } from '../src/application/use-cases/lob-commands';
import { applyLobMutation, loadLob } from '../src/infrastructure/repositories/supabase/lob-repository';
import { getServiceClient } from '../src/infrastructure/repositories/supabase/client';

const USAGE =
  'Uso: node --import tsx scripts/replace-lob-dependencies-prevision.ts --obra <código> --prevision <id> --out <pasta> [--json <arquivo>] [--linha-de-base "<nome>"] [--env-file <arquivo>]\n     com --apply: --json <arquivo> --actor <profileId> --confirmar <código do plano> [--backup <arquivo>]';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const { values } = (() => {
  try {
    return parseArgs({
      options: {
        obra: { type: 'string' },
        prevision: { type: 'string' },
        out: { type: 'string' },
        json: { type: 'string' },
        'linha-de-base': { type: 'string' },
        actor: { type: 'string' },
        confirmar: { type: 'string' },
        backup: { type: 'string' },
        'env-file': { type: 'string' },
        apply: { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    return fail(`${(error as Error).message}\n${USAGE}`);
  }
})();
if (!values.obra || !values.prevision || !values.out) fail(USAGE);
if (!/^\d+$/.test(values.prevision)) fail('--prevision é o número da obra no Prevision (ex.: 29875 no Atmos).');
if (values.apply && (!values.json || !values.actor || !values.confirmar))
  fail('--apply exige --json (a resposta do Prevision simulada), --actor e --confirmar (o código do plano da simulação).');
const envFile = values['env-file'] ?? '.env.local';
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
else if (values['env-file']) fail(`Arquivo de ambiente não encontrado: ${envFile}`);
if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)
  fail('Defina NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY (no ambiente ou em --env-file).');

/** A importação de 11/11/2026 contou os dias em segunda a sexta sem feriados (não havia calendário). */
const IMPORT_CALENDAR = undefined;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const br = (date: string | undefined) => (date ? `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}` : '');
const brTime = (iso: string) =>
  new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(iso));
const EMPTY = (): Record<LobTable, never[]> => ({
  locals: [],
  services: [],
  activities: [],
  dependencies: [],
  baselines: [],
  launches: [],
  measurements: [],
  items: [],
  photos: [],
  costs: [],
});
const KIND = { crew: 'equipe segue', fs: 'sequência' } as const;
const KEPT = {
  manual: 'criada à mão (não está no Prevision)',
  'manual-tambem-no-prevision': 'criada à mão, também no Prevision',
  'deduzida-igual-ao-prevision': 'deduzida igual ao Prevision',
} as const;
const IGNORED = {
  'apagada-a-mao': 'está no Prevision, mas a deduzida foi apagada à mão: não volta',
  'a-conferir': 'a conferir: a reconstrução não explica as deduzidas destes blocos',
  'sem-bloco': 'sem bloco na obra',
} as const;

/** "término → início +1 d.ú." */
const describeLink = (l: Pick<RealLink, 'from' | 'to' | 'delayDays'>) =>
  `${l.from === 'start' ? 'início' : 'término'} → ${l.to === 'start' ? 'início' : 'término'} ${l.delayDays < 0 ? '−' : '+'}${Math.abs(l.delayDays)} d.ú.`;
const describeLinks = (m: MergedRealLink) => m.links.map(describeLink).join(' | ');

function csv(rows: (string | number | undefined)[][]): string {
  const cell = (v: string | number | undefined) => {
    const s = v === undefined ? '' : String(v);
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // BOM e ponto e vírgula: o Excel em português abre direto, com os acentos.
  return `﻿${rows.map(r => r.map(cell).join(';')).join('\r\n')}\r\n`;
}

/** Impressão digital do plano: muda se mudar qualquer ligação que sai ou que entra. */
function planCode(plan: DependencyReplacementPlan) {
  const content = JSON.stringify({
    remove: plan.remove.map(r => r.dependency.id).sort(),
    insert: plan.insert
      .map(i => `${i.dependency.predecessorId}|${i.dependency.successorId}|${i.dependency.lagDays}|${i.dependency.kind}`)
      .sort(),
  });
  return createHash('sha256').update(content).digest('hex').slice(0, 12);
}

async function main() {
  console.log(`${values.apply ? 'GRAVAÇÃO' : 'SIMULAÇÃO (só leitura; use --apply para gravar)'} — ligações do Prevision`);
  console.log(`Banco: ${new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).host}`);
  fs.mkdirSync(values.out!, { recursive: true });
  const client = getServiceClient();
  const works = await client.from('works').select('id, name, code');
  if (works.error) fail(`Falha ao ler as obras: ${works.error.message}`);
  const work = (works.data as { id: string; name: string; code: string }[]).find(w => w.code.toLowerCase() === values.obra!.toLowerCase());
  if (!work) fail(`Obra ${values.obra} não encontrada.`);
  let actor: { id: string; name: string; role: string } | undefined;
  if (values.apply) {
    const found = await client.from('profiles').select('id, name, role').eq('id', values.actor!).maybeSingle();
    if (found.error || !found.data) fail(`Perfil ${values.actor} não encontrado.`);
    actor = found.data as { id: string; name: string; role: string };
  }
  console.log(`Obra: ${work.name} (${work.code})${actor ? ` · Ator: ${actor.name} (${actor.role})` : ''}`);

  const current = await loadLob(work.id);
  const services = new Map(current.services.map(s => [s.id, s.name]));
  const locals = new Map(current.locals.map(l => [l.id, l.name]));
  const activities = new Map(current.activities.map(a => [a.id, a]));
  const serviceOf = (id: string) => services.get(activities.get(id)?.serviceId ?? '') ?? id;
  const localOf = (id: string) => locals.get(activities.get(id)?.localId ?? '') ?? '';
  const label = (id: string) => `${serviceOf(id)} › ${localOf(id)}`;
  console.log(
    `Linha de Balanço: ${current.activities.length} blocos, ${current.dependencies.length} ligações; calendário: ${lobCalendarLabel(current.calendar)}`,
  );

  // Prevision: a resposta guardada (--json) ou a API, guardada na pasta do relatório.
  let project: PrevisionApiProject;
  if (values.json) {
    project = JSON.parse(fs.readFileSync(values.json, 'utf8')) as PrevisionApiProject;
    if (String(project.id) !== values.prevision)
      fail(`O arquivo ${values.json} é da obra ${project.id} do Prevision, não da ${values.prevision}.`);
  } else {
    project = await fetchPrevisionGraphqlProject(values.prevision!);
    const saved = path.join(values.out!, `prevision-${values.prevision}.json`);
    fs.writeFileSync(saved, JSON.stringify(project));
    console.log(`Resposta do Prevision guardada em ${saved}`);
  }
  const previsionLinks = project.activities.reduce((n, a) => n + a.predecessors.length, 0);
  console.log(`Prevision: ${project.name} (obra ${project.id}), ${project.activities.length} atividades, ${previsionLinks} vínculos`);

  // Linha de base da importação: o instante dela é o das ligações deduzidas.
  const baseline = values['linha-de-base']
    ? current.baselines.find(b => b.name === values['linha-de-base'])
    : [...current.baselines]
        .filter(b => !b.automatic && b.name.startsWith('Prevision —'))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (!baseline) fail('Linha de base da importação não encontrada (use --linha-de-base "<nome>").');
  const importedAt = baseline.createdAt;

  const reconstruction = reconstructDeducedDependencies({
    workId: work.id,
    workName: work.name,
    baseline,
    services: current.services,
    locals: current.locals,
    activities: current.activities,
    calendar: IMPORT_CALENDAR,
  });
  const translation = translatePrevisionLinks(project, current, current.calendar);
  const plan = planDependencyReplacement({
    workId: work.id,
    activities: current.activities,
    dependencies: current.dependencies,
    calendar: current.calendar,
    previsionCalendar: previsionApiCalendar(project),
    importedAt,
    realLinks: translation.links,
    unmatchedLinks: translation.unmatched,
    deduced: reconstruction.error ? undefined : reconstruction.dependencies,
    newId: randomUUID,
    now: new Date().toISOString(),
  });
  if (!plan.imported.length) fail(`Nenhuma ligação tem o instante da linha de base "${baseline.name}" (${importedAt}). Nada a trocar.`);
  const code = planCode(plan);

  // ─── Relatório no terminal ───
  const r = plan.reconstruction;
  const crew = (list: { kind: string }[]) => list.filter(d => d.kind === 'crew').length;
  console.log(
    `\nLigações da importação (linha de base "${baseline.name}", gravada em ${brTime(importedAt)}): ${plan.imported.length} ainda existem (${crew(plan.imported)} "equipe segue" + ${plan.imported.length - crew(plan.imported)} de sequência)`,
  );
  console.log(`Ligações criadas depois (à mão): ${plan.manual.length}`);
  console.log(
    `Vínculos do Prevision nos blocos da obra: ${translation.links.length} de ${translation.total}; sem bloco: ${translation.unmatched.length}; blocos do Prevision sem par na obra: ${translation.missingBlocks.length}; blocos da obra fora do Prevision: ${translation.extraActivities.length}`,
  );
  for (const w of translation.warnings) console.log(`  aviso do Prevision: ${w}`);
  console.log('\n=== Reconstrução do conjunto deduzido ===');
  if (reconstruction.error) console.log(`NÃO FOI POSSÍVEL refazer a importação: ${reconstruction.error}`);
  else {
    console.log(
      `${r.status === 'ok' ? 'BATEU' : 'NÃO BATEU'}: a importação deduziu ${r.total} ligações (${crew(reconstruction.dependencies)} "equipe segue"); das ${plan.imported.length} que restam, ${plan.imported.length - r.unexplained.length} estão no conjunto refeito${r.unexplained.length ? ` e ${r.unexplained.length} NÃO` : ''}.`,
    );
    console.log(
      `Apagadas à mão desde a importação: ${r.deleted.length} (${crew(r.deleted)} "equipe segue"); recriadas à mão no mesmo par: ${r.deleted.filter(d => d.recreated).length}`,
    );
    console.log(`Deduzidas com a espera mudada à mão depois da importação: ${r.lagChanged.length}`);
    if (reconstruction.missingActivities) console.log(`Blocos da linha de base que não existem mais: ${reconstruction.missingActivities}`);
  }

  const count = <T>(list: T[], key: (item: T) => string) => {
    const map = new Map<string, number>();
    for (const item of list) map.set(key(item), (map.get(key(item)) ?? 0) + 1);
    return map;
  };
  const swaps = plan.insert.filter(i => i.replaces).length;
  const removedOnly = plan.remove.length - swaps;
  console.log('\n=== Plano ===');
  console.log(`Remover: ${removedOnly} deduzidas que não estão no Prevision`);
  console.log(`Trocar a espera: ${swaps} deduzidas que estão no Prevision com outra espera (sai a deduzida, entra a real)`);
  console.log(`Inserir: ${plan.insert.length - swaps} ligações do Prevision que não existem`);
  const kept = count(plan.kept, k => k.reason);
  console.log(
    `Manter: ${plan.kept.length} (${kept.get('deduzida-igual-ao-prevision') ?? 0} deduzidas iguais ao Prevision, ${kept.get('manual-tambem-no-prevision') ?? 0} criadas à mão que também estão no Prevision, ${kept.get('manual') ?? 0} criadas à mão fora do Prevision)`,
  );
  const ignored = count(plan.ignored, i => i.reason);
  console.log(
    `Ignorar: ${plan.ignored.length} (${ignored.get('apagada-a-mao') ?? 0} apagadas à mão que estão no Prevision, ${ignored.get('sem-bloco') ?? 0} sem bloco na obra, ${ignored.get('a-conferir') ?? 0} a conferir)`,
  );
  const lagChangedIds = new Map(r.lagChanged.map(x => [x.dependency.id, x.importedLag]));
  if (lagChangedIds.size) {
    const fate = (id: string) =>
      plan.remove.find(x => x.dependency.id === id)?.reason === 'troca-de-espera'
        ? 'trocam de espera'
        : plan.remove.some(x => x.dependency.id === id)
          ? 'saem (não estão no Prevision)'
          : 'ficam como estão';
    const fates = count([...lagChangedIds.keys()], fate);
    console.log(
      `  Das ${lagChangedIds.size} deduzidas com espera mudada à mão: ${[...fates].map(([what, n]) => `${n} ${what}`).join(', ')}`,
    );
  }
  console.log(`Ligações depois da troca: ${plan.finalDependencies.length} (eram ${current.dependencies.length})`);

  const successors = new Set(plan.conflicts.map(c => c.link.successorId));
  console.log(
    `\n=== Conflitos com as datas atuais: ${plan.conflicts.length} ligações, ${successors.size} blocos sucessores${plan.conflicts.length ? `, até ${plan.conflicts[0].link.conflictDays} dias úteis` : ''} ===`,
  );
  console.log(
    `(o bloco começa antes do que o Prevision pede depois da predecessora; a espera gravada fica na folga atual, e nenhuma data muda. Nas datas do próprio Prevision: ${plan.conflicts.filter(c => (c.link.previsionConflictDays ?? 0) > 0).length} desses conflitos)`,
  );
  for (const c of plan.conflicts.slice(0, 10)) {
    const p = activities.get(c.link.predecessorId)!;
    const s = activities.get(c.link.successorId)!;
    console.log(
      `  ${String(c.link.conflictDays).padStart(3)} d.ú.  ${label(s.id)} (início ${br(s.start)}) ⟵ ${label(p.id)} (término ${br(activityFinish(p, current.calendar))}); ${describeLinks(c.link)}; pede início em ${br(c.link.minimumStart)}${c.status === 'mantida' ? ' · ligação deduzida igual, mantida' : ''}${s.actualStart ? ' · sucessora já iniciada' : ''}`,
    );
  }
  console.log(`\nCiclos: ${plan.cycles.length}`);
  for (const cycle of plan.cycles)
    console.log(`  ${cycle.dependencies.map(d => `${label(d.predecessorId)} → ${label(d.successorId)} (${d.origin})`).join('; ')}`);
  console.log(`Conferência: ${plan.moved.length ? `${plan.moved.length} BLOCOS SE MOVERIAM` : 'nenhum bloco se move com a rede nova'}`);

  const sample = <T>(title: string, list: T[], line: (item: T) => string) => {
    if (!list.length) return;
    console.log(`\n${title} (amostra de ${Math.min(8, list.length)} de ${list.length}):`);
    for (const item of list.slice(0, 8)) console.log(`  ${line(item)}`);
  };
  sample(
    'Saem',
    plan.remove.filter(x => x.reason === 'deduzida'),
    x =>
      `${label(x.dependency.predecessorId)} → ${label(x.dependency.successorId)} (${KIND[x.dependency.kind]}, espera ${x.dependency.lagDays})`,
  );
  sample(
    'Entram',
    plan.insert.filter(i => !i.replaces),
    i =>
      `${label(i.dependency.predecessorId)} → ${label(i.dependency.successorId)} (${KIND[i.dependency.kind]}, espera ${i.dependency.lagDays}; ${describeLinks(i.link)})`,
  );
  const removedById = new Map(plan.remove.map(x => [x.dependency.id, x.dependency]));
  sample(
    'Trocam a espera',
    plan.insert.filter(i => i.replaces),
    i =>
      `${label(i.dependency.predecessorId)} → ${label(i.dependency.successorId)}: ${removedById.get(i.replaces!)!.lagDays} → ${i.dependency.lagDays} (${describeLinks(i.link)})`,
  );

  // ─── Arquivos ───
  const stamp = (id: string) => {
    const a = activities.get(id)!;
    return {
      servico: serviceOf(id),
      local: localOf(id),
      inicio: a.start,
      termino: activityFinish(a, current.calendar),
      inicioReal: a.actualStart,
    };
  };
  const linkJson = (m: MergedRealLink) => ({
    vinculos: m.links.map(describeLink),
    esperaPedida: m.wantedLag,
    folgaAtual: m.gap,
    esperaGravada: m.lagDays,
    diasDeConflito: m.conflictDays,
    inicioMinimo: m.minimumStart,
    conflitoNasDatasDoPrevision: m.previsionConflictDays,
  });
  const depJson = (d: LobDependency) => ({
    id: d.id,
    predecessora: stamp(d.predecessorId),
    sucessora: stamp(d.successorId),
    tipo: KIND[d.kind],
    espera: d.lagDays,
    criadaEm: d.createdAt,
  });
  // A gravação escreve ao lado, sem sobrescrever o relatório da simulação que foi revisado.
  const prefix = path.join(values.out!, `${work.code}-ligacoes-prevision${values.apply ? '-gravacao' : ''}`);
  const report = {
    geradoEm: new Date().toISOString(),
    modo: values.apply ? 'gravação' : 'simulação',
    banco: new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).host,
    obra: { id: work.id, nome: work.name, codigo: work.code, calendario: current.calendar ?? null },
    prevision: { id: project.id, nome: project.name, atividades: project.activities.length, vinculos: previsionLinks },
    linhaDeBaseDaImportacao: { id: baseline.id, nome: baseline.name, gravadaEm: importedAt },
    codigoDoPlano: code,
    contagens: {
      blocos: current.activities.length,
      ligacoesAtuais: current.dependencies.length,
      deduzidasQueRestam: plan.imported.length,
      criadasAMao: plan.manual.length,
      vinculosDoPrevision: translation.total,
      vinculosNosBlocos: translation.links.length,
      remover: removedOnly,
      trocarEspera: swaps,
      inserir: plan.insert.length - swaps,
      manter: Object.fromEntries(kept),
      ignorar: Object.fromEntries(ignored),
      conflitos: plan.conflicts.length,
      blocosEmConflito: successors.size,
      ciclos: plan.cycles.length,
      blocosQueSeMoveriam: plan.moved.length,
      ligacoesDepois: plan.finalDependencies.length,
    },
    reconstrucao: {
      situacao: reconstruction.error ? 'não refeita' : r.status,
      erro: reconstruction.error,
      deduzidasNaImportacao: r.total,
      naoExplicadas: r.unexplained.map(depJson),
      apagadasAMao: r.deleted.map(d => ({
        predecessora: stamp(d.predecessorId),
        sucessora: stamp(d.successorId),
        tipo: KIND[d.kind],
        espera: d.lagDays,
        recriadaAMao: d.recreated,
        noPrevision: plan.ignored.some(
          i => i.link && i.link.predecessorId === d.predecessorId && i.link.successorId === d.successorId && i.reason === 'apagada-a-mao',
        ),
      })),
      esperaMudadaAMao: r.lagChanged.map(x => ({ ...depJson(x.dependency), esperaNaImportacao: x.importedLag })),
    },
    conflitos: plan.conflicts.map(c => ({
      situacao: c.status === 'nova' ? 'ligação nova' : 'deduzida igual, mantida',
      predecessora: stamp(c.link.predecessorId),
      sucessora: stamp(c.link.successorId),
      previsionPredecessora: c.link.links[0].prevision?.predecessor,
      previsionSucessora: c.link.links[0].prevision?.successor,
      ...linkJson(c.link),
    })),
    remover: plan.remove.map(x => ({ motivo: x.reason, ...depJson(x.dependency) })),
    inserir: plan.insert.map(i => ({ ...depJson(i.dependency), substitui: i.replaces, ...linkJson(i.link) })),
    manter: plan.kept.map(k => ({ motivo: KEPT[k.reason], ...depJson(k.dependency), ...(k.link ? linkJson(k.link) : {}) })),
    ignorar: plan.ignored.map(i => ({
      motivo: IGNORED[i.reason],
      ...(i.link ? { predecessora: stamp(i.link.predecessorId), sucessora: stamp(i.link.successorId), ...linkJson(i.link) } : {}),
      ...(i.unmatched ? { semBloco: i.unmatched } : {}),
    })),
    blocosDoPrevisionSemPar: translation.missingBlocks,
    blocosDaObraForaDoPrevision: translation.extraActivities.map(stamp),
    avisos: translation.warnings,
  };
  fs.writeFileSync(`${prefix}.json`, JSON.stringify(report, null, 2));

  const conflictRows: (string | number | undefined)[][] = [
    [
      'Dias úteis de conflito',
      'Serviço sucessor',
      'Local sucessor',
      'Início atual da sucessora',
      'Início pedido pelo Prevision',
      'Serviço predecessor',
      'Local predecessor',
      'Término atual da predecessora',
      'Vínculo no Prevision',
      'Espera pedida (dias úteis após o término)',
      'Folga atual (dias úteis)',
      'Espera que será gravada',
      'Sucessora no Prevision',
      'Predecessora no Prevision',
      'Sucessora já iniciada',
      'Situação',
    ],
    ...plan.conflicts.map(c => {
      const p = activities.get(c.link.predecessorId)!;
      const s = activities.get(c.link.successorId)!;
      const pv = c.link.links[0].prevision;
      return [
        c.link.conflictDays,
        serviceOf(s.id),
        localOf(s.id),
        br(s.start),
        br(c.link.minimumStart),
        serviceOf(p.id),
        localOf(p.id),
        br(activityFinish(p, current.calendar)),
        describeLinks(c.link),
        c.link.wantedLag,
        c.link.gap,
        c.link.lagDays,
        pv ? `${br(pv.successor.start)} a ${br(pv.successor.finish)}` : '',
        pv ? `${br(pv.predecessor.start)} a ${br(pv.predecessor.finish)}` : '',
        s.actualStart ? `sim (${br(s.actualStart)})` : 'não',
        c.status === 'nova' ? 'ligação nova' : 'deduzida igual, mantida',
      ];
    }),
  ];
  fs.writeFileSync(`${prefix}-conflitos.csv`, csv(conflictRows));

  const row = (
    action: string,
    reason: string,
    predecessorId: string,
    successorId: string,
    kind: LobDependency['kind'],
    before: number | undefined,
    after: number | undefined,
    m: MergedRealLink | undefined,
    createdAt: string | undefined,
    note = '',
  ) => [
    action,
    reason,
    serviceOf(predecessorId),
    localOf(predecessorId),
    serviceOf(successorId),
    localOf(successorId),
    KIND[kind],
    before,
    after,
    m?.wantedLag,
    m?.gap,
    m ? describeLinks(m) : '',
    m?.conflictDays || '',
    createdAt ? brTime(createdAt) : '',
    note,
  ];
  const lagNote = (id: string) => (lagChangedIds.has(id) ? `espera mudada à mão (na importação: ${lagChangedIds.get(id)})` : '');
  const linkRows: (string | number | undefined)[][] = [
    [
      'Ação',
      'Motivo',
      'Serviço predecessor',
      'Local predecessor',
      'Serviço sucessor',
      'Local sucessor',
      'Tipo',
      'Espera atual (dias úteis)',
      'Espera depois (dias úteis)',
      'Espera pedida pelo Prevision',
      'Folga atual',
      'Vínculo no Prevision',
      'Dias úteis de conflito',
      'Criada em',
      'Observação',
    ],
    ...plan.remove
      .filter(x => x.reason === 'deduzida')
      .map(x => {
        const d = x.dependency;
        return row(
          'remover',
          'deduzida, não está no Prevision',
          d.predecessorId,
          d.successorId,
          d.kind,
          d.lagDays,
          undefined,
          undefined,
          d.createdAt,
          lagNote(d.id),
        );
      }),
    ...plan.insert.map(i => {
      const d = i.dependency;
      const old = i.replaces ? removedById.get(i.replaces) : undefined;
      return old
        ? row(
            'trocar a espera',
            'deduzida, está no Prevision com outra espera',
            d.predecessorId,
            d.successorId,
            d.kind,
            old.lagDays,
            d.lagDays,
            i.link,
            old.createdAt,
            lagNote(old.id),
          )
        : row('inserir', 'do Prevision, não existe', d.predecessorId, d.successorId, d.kind, undefined, d.lagDays, i.link, undefined);
    }),
    ...plan.kept.map(k => {
      const d = k.dependency;
      return row(
        'manter',
        KEPT[k.reason],
        d.predecessorId,
        d.successorId,
        d.kind,
        d.lagDays,
        d.lagDays,
        k.link,
        d.createdAt,
        lagNote(d.id),
      );
    }),
    ...plan.ignored
      .filter(i => i.link)
      .map(i => {
        const m = i.link!;
        return row('ignorar', IGNORED[i.reason], m.predecessorId, m.successorId, m.kind, undefined, undefined, m, undefined);
      }),
    ...plan.ignored
      .filter(i => i.unmatched)
      .map(i => [
        'ignorar',
        `${IGNORED['sem-bloco']}: ${i.unmatched!.reason}`,
        i.unmatched!.predecessor,
        '',
        i.unmatched!.successor,
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
      ]),
    ...r.deleted.map(d =>
      row(
        'já apagada',
        `deduzida na importação e apagada à mão${d.recreated ? ' (recriada à mão)' : ''}`,
        d.predecessorId,
        d.successorId,
        d.kind,
        undefined,
        undefined,
        undefined,
        undefined,
        `espera na importação: ${d.lagDays}`,
      ),
    ),
  ];
  fs.writeFileSync(`${prefix}.csv`, csv(linkRows));
  console.log(`\nRelatório: ${prefix}.json`);
  console.log(`Conflitos (para o Jorge): ${prefix}-conflitos.csv`);
  console.log(`Todas as ligações: ${prefix}.csv`);
  console.log(`\nCódigo do plano: ${code}`);

  if (!values.apply) {
    const json = values.json ?? path.join(values.out!, `prevision-${values.prevision}.json`);
    console.log(
      `Para gravar este plano (depois do retorno do Jorge):\n  node --import tsx scripts/replace-lob-dependencies-prevision.ts --obra ${work.code} --prevision ${values.prevision} --out ${values.out} --json ${json}${values['env-file'] ? ` --env-file ${values['env-file']}` : ''} --actor <profileId> --confirmar ${code} --apply`,
    );
    return;
  }

  // ─── Gravação ───
  if (values.confirmar !== code)
    fail(`\nO plano mudou desde a simulação (código ${code}, informado ${values.confirmar}). Simule de novo. Nada foi gravado.`);
  if (reconstruction.error || r.status !== 'ok') fail('\nA reconstrução do conjunto deduzido não bateu: nada foi gravado.');
  if (plan.cycles.length) fail('\nA rede nova teria ciclo: nada foi gravado.');
  if (plan.moved.length) fail('\nA rede nova moveria blocos: nada foi gravado.');
  if (!plan.remove.length && !plan.insert.length) {
    console.log('\nNada a trocar.');
    return;
  }
  const backupFile = values.backup ?? path.join(values.out!, `${work.code}-backup-ligacoes-${Date.now()}.json`);
  fs.writeFileSync(
    backupFile,
    JSON.stringify({
      workId: work.id,
      takenAt: new Date().toISOString(),
      dependencies: current.dependencies,
      activities: current.activities.map(a => ({ id: a.id, start: a.start, durationDays: a.durationDays })),
    }),
  );
  console.log(`\nLigações e datas atuais guardadas em ${backupFile}`);
  const newBaseline = replacementBaseline({
    workId: work.id,
    activities: current.activities,
    baselines: current.baselines,
    calendar: current.calendar,
    date: today,
    actorId: actor!.id,
    now: new Date().toISOString(),
    newId: randomUUID,
  });
  const mutation: LobMutation = {
    workId: work.id,
    insert: { ...EMPTY(), dependencies: plan.insert.map(i => i.dependency), baselines: [newBaseline] },
    update: EMPTY(),
    delete: { ...EMPTY(), dependencies: plan.remove.map(x => x.dependency.id) },
    removeFiles: [],
  };
  try {
    await applyLobMutation(mutation);
  } catch (error) {
    console.error(`Falha na gravação: ${(error as Error).message}. Restaurando o estado anterior…`);
    await restore(
      work.id,
      plan.remove.map(x => x.dependency),
      mutation.insert.dependencies,
      newBaseline.id,
    );
    process.exit(1);
  }
  const after = await loadLob(work.id);
  const expected = new Set(plan.finalDependencies.map(d => d.id));
  const same = after.dependencies.length === expected.size && after.dependencies.every(d => expected.has(d.id));
  console.log(
    `\nGravado: ${plan.remove.length} ligações saíram, ${plan.insert.length} entraram; linha de base "${newBaseline.name}". Releitura: ${after.dependencies.length} ligações${same ? ', iguais às do plano' : ' — DIFERENTE DO PLANO, confira'}.`,
  );
  const moved = after.activities.filter(a => {
    const before = activities.get(a.id);
    return !before || before.start !== a.start || before.durationDays !== a.durationDays;
  });
  console.log(`Blocos com data diferente da leitura anterior: ${moved.length}`);
}

/** Desfaz uma gravação que parou no meio: tira as ligações novas e a linha de base, e devolve as que
 * saíram, com o mesmo id e o mesmo instante de criação (as deduzidas continuam reconhecíveis). */
async function restore(workId: string, removed: LobDependency[], inserted: LobDependency[], baselineId: string) {
  const client = getServiceClient();
  const report = (what: string, error: { message: string } | null) => error && console.error(`  não consegui ${what}: ${error.message}`);
  for (let i = 0; i < inserted.length; i += 100)
    report(
      'apagar as ligações novas',
      (
        await client
          .from('lob_dependencies')
          .delete()
          .in(
            'id',
            inserted.slice(i, i + 100).map(d => d.id),
          )
      ).error,
    );
  report('apagar a linha de base automática', (await client.from('lob_baselines').delete().eq('id', baselineId)).error);
  // Releitura paginada (a API devolve no máximo mil linhas por consulta, e a obra tem mais ligações).
  const present = new Set((await loadLob(workId)).dependencies.map(d => d.id));
  try {
    await applyLobMutation({
      workId,
      insert: { ...EMPTY(), dependencies: removed.filter(d => !present.has(d.id)) },
      update: EMPTY(),
      delete: EMPTY(),
      removeFiles: [],
    });
  } catch (error) {
    console.error(`  não consegui devolver as ligações: ${(error as Error).message}`);
  }
}

main().catch(error => fail(error instanceof Error ? (error.stack ?? error.message) : String(error)));

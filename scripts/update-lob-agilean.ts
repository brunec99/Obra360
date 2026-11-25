/**
 * Atualiza a Linha de Balanço de uma obra pela exportação em Excel do Agilean (25/11/2026, Blentt).
 * As regras ficam em `src/domain/lob-agilean-import.ts`; aqui só a leitura, o relatório e a gravação.
 *
 * Uso:
 *   node --import tsx scripts/update-lob-agilean.ts <exportação.xlsx> --obra <código> --actor <profileId>
 *     [--env-file .env.local] [--backup <arquivo.json>] [--apply]
 *
 * Sem --apply é SIMULAÇÃO: lê o banco e a planilha e imprime a ligação de cada serviço do Agilean com
 * um serviço da obra e quantos blocos mudam de data. Com --apply, numa gravação só: calendário do
 * Agilean (se a obra não tiver um), linha de base automática com as datas de antes, dependências
 * deduzidas trocadas, datas novas nos blocos (mesmo id: medições, datas reais e restrições ficam) e as
 * cores do Agilean nos serviços. Antes de gravar, o estado atual vai para o --backup (padrão: pasta
 * temporária do sistema); se a gravação falhar no meio, ele é restaurado.
 *
 * Recusa quando algum bloco do Agilean ou da obra fica sem par, ou quando algum local da planilha não
 * existe na obra. Ambiente: NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY, do processo ou de
 * --env-file. Nenhum segredo é impresso.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { activityFinish, type LobDependency } from '../src/domain/lob';
import { lobCalendarLabel } from '../src/domain/lob-calendar';
import { planAgileanUpdate, readAgileanLob } from '../src/domain/lob-agilean-import';
import type { LobMutation, LobTable } from '../src/application/use-cases/lob-commands';
import { readXlsxSheet } from '../src/infrastructure/files/xlsx';
import { applyLobMutation, loadLob } from '../src/infrastructure/repositories/supabase/lob-repository';
import { getServiceClient } from '../src/infrastructure/repositories/supabase/client';

const USAGE =
  'Uso: node --import tsx scripts/update-lob-agilean.ts <exportação.xlsx> --obra <código> --actor <profileId> [--env-file .env.local] [--backup <arquivo.json>] [--apply]';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const { values, positionals } = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        obra: { type: 'string' },
        actor: { type: 'string' },
        backup: { type: 'string' },
        'env-file': { type: 'string' },
        apply: { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    return fail(`${(error as Error).message}\n${USAGE}`);
  }
})();
const [file] = positionals;
if (positionals.length !== 1 || !values.obra || !values.actor) fail(USAGE);
const envFile = values['env-file'] ?? '.env.local';
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
else if (values['env-file']) fail(`Arquivo de ambiente não encontrado: ${envFile}`);
if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)
  fail('Defina NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY (no ambiente ou em --env-file).');

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const br = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
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

async function main() {
  console.log(`${values.apply ? 'GRAVAÇÃO' : 'SIMULAÇÃO (use --apply para gravar)'} — ${file}`);
  console.log(`Banco: ${new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).host}`);
  const agilean = readAgileanLob(readXlsxSheet(fs.readFileSync(file)));
  console.log(
    `Planilha "${agilean.sheet}": ${agilean.blocks.length} blocos, ${agilean.locals.length} linhas de local, ${br(agilean.days[0])} a ${br(agilean.days[agilean.days.length - 1])}`,
  );
  console.log(`Calendário do Agilean: ${lobCalendarLabel(agilean.calendar)} (${agilean.calendar.holidays.map(br).join(', ')})`);

  const client = getServiceClient();
  const works = await client.from('works').select('id, name, code');
  if (works.error) fail(`Falha ao ler as obras: ${works.error.message}`);
  const work = (works.data as { id: string; name: string; code: string }[]).find(w => w.code.toLowerCase() === values.obra!.toLowerCase());
  if (!work) fail(`Obra ${values.obra} não encontrada.`);
  const actor = await client.from('profiles').select('id, name, role').eq('id', values.actor!).maybeSingle();
  if (actor.error || !actor.data) fail(`Perfil ${values.actor} não encontrado.`);
  console.log(`Obra: ${work.name} (${work.code}) · Ator: ${actor.data.name} (${actor.data.role})`);

  const current = await loadLob(work.id);
  console.log(
    `Linha de Balanço atual: ${current.activities.length} blocos, ${current.services.length} serviços, ${current.dependencies.length} dependências, ${current.measurements.length} medição(ões) com ${current.items.length} itens, ${current.baselines.length} linha(s) de base; calendário: ${lobCalendarLabel(current.calendar)}`,
  );
  const plan = planAgileanUpdate(current, agilean, {
    workId: work.id,
    workName: work.name,
    actorId: actor.data.id,
    now: new Date().toISOString(),
    newId: randomUUID,
    date: today,
  });

  console.log('\n=== Serviços do Agilean → serviços da obra ===');
  const how = { nome: 'nome igual', sigla: 'sigla', eliminacao: 'POR ELIMINAÇÃO' } as const;
  for (const m of [...plan.matches].sort((a, b) => a.serviceName.localeCompare(b.serviceName, 'pt-BR')))
    console.log(
      `  ${m.label.padEnd(24)} → ${m.serviceName.padEnd(44)} ${String(m.blocks).padStart(3)} blocos · ${how[m.how]}${m.distanceDays ? ` · início ${m.distanceDays} dias corridos diferente no total` : ''}`,
    );
  if (plan.missingLocals.length) console.log(`\nLocais da planilha que não existem na obra: ${plan.missingLocals.join(', ')}`);
  if (plan.unmatchedBlocks.length) {
    console.log(`\nBlocos do Agilean sem par na obra (${plan.unmatchedBlocks.length}):`);
    for (const b of plan.unmatchedBlocks) console.log(`  linha ${b.row}: ${b.label} › ${b.localName} (${br(b.start)} a ${br(b.finish)})`);
  }
  if (plan.leftoverActivities.length) {
    const service = new Map(current.services.map(s => [s.id, s.name]));
    const local = new Map(current.locals.map(l => [l.id, l.name]));
    console.log(`\nBlocos da obra sem par no Agilean (${plan.leftoverActivities.length}):`);
    for (const a of plan.leftoverActivities) console.log(`  ${service.get(a.serviceId)} › ${local.get(a.localId)} (${br(a.start)})`);
  }

  const service = new Map(current.services.map(s => [s.id, s.name]));
  const local = new Map(current.locals.map(l => [l.id, l.name]));
  const measured = new Map(current.items.map(i => [i.activityId, i.value]));
  console.log(`\n=== Datas ===`);
  console.log(`Blocos que mudam de início ou término: ${plan.changed.length} de ${plan.activities.length}`);
  const shift = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
  const byShift = new Map<string, number>();
  for (const { activity, before } of plan.changed) {
    const days = shift(activityFinish(before, current.calendar), activityFinish(activity, plan.calendar));
    const bucket =
      days === 0
        ? 'término igual'
        : days < 0
          ? 'término antes'
          : days <= 30
            ? 'término até 30 dias depois'
            : 'término mais de 30 dias depois';
    byShift.set(bucket, (byShift.get(bucket) ?? 0) + 1);
  }
  for (const [bucket, count] of byShift) console.log(`  ${bucket}: ${count}`);
  const sample = [...plan.changed]
    .sort((a, b) => Math.abs(shift(b.before.start, b.activity.start)) - Math.abs(shift(a.before.start, a.activity.start)))
    .slice(0, 12);
  if (sample.length) console.log('Maiores mudanças de início:');
  for (const { activity, before } of sample)
    console.log(
      `  ${service.get(activity.serviceId)} › ${local.get(activity.localId)}: ${br(before.start)}–${br(activityFinish(before, current.calendar))} → ${br(activity.start)}–${br(activityFinish(activity, plan.calendar))}${measured.has(activity.id) ? ` (medido ${measured.get(activity.id)}%)` : ''}`,
    );
  const doneMoved = plan.changed.filter(c => c.activity.actualFinish).length;
  if (doneMoved) console.log(`Blocos já concluídos (com término real) que mudam de data planejada: ${doneMoved}`);
  console.log(
    `\nDependências: ${plan.deleteDependencies.length} deduzidas saem, ${plan.insertDependencies.length} entram (nenhum bloco se move)`,
  );
  console.log(`Linha de base automática: "${plan.baseline.name}" com ${plan.baseline.snapshot.length} blocos`);
  console.log(`Cores do Agilean em ${plan.services.length} serviço(s)`);
  if (plan.newCalendar) console.log(`Calendário a gravar na obra: ${lobCalendarLabel(plan.newCalendar)}`);
  if (plan.warnings.length) {
    console.log('\nAvisos:');
    for (const w of plan.warnings) console.log(`  - ${w}`);
  }
  if (plan.missingLocals.length || plan.unmatchedBlocks.length || plan.leftoverActivities.length)
    fail('\nHá blocos ou locais sem par: nada foi gravado.');
  if (!values.apply) return;

  const backupFile = values.backup ?? path.join(os.tmpdir(), `lob-${work.code}-antes-agilean-${Date.now()}.json`);
  fs.writeFileSync(
    backupFile,
    JSON.stringify({
      workId: work.id,
      calendar: current.calendar ?? null,
      activities: current.activities,
      services: current.services,
      dependencies: current.dependencies,
    }),
  );
  console.log(`\nEstado anterior guardado em ${backupFile}`);
  const mutation: LobMutation = {
    workId: work.id,
    insert: { ...EMPTY(), dependencies: plan.insertDependencies, baselines: [plan.baseline] },
    update: { ...EMPTY(), activities: plan.activities.filter((a, i) => a !== current.activities[i]), services: plan.services },
    delete: { ...EMPTY(), dependencies: plan.deleteDependencies.map(d => d.id) },
    removeFiles: [],
    ...(plan.newCalendar ? { calendar: { value: plan.newCalendar, updatedBy: actor.data.id, updatedAt: new Date().toISOString() } } : {}),
  };
  try {
    await applyLobMutation(mutation);
  } catch (error) {
    console.error(`Falha na gravação: ${(error as Error).message}. Restaurando o estado anterior…`);
    await restore(work.id, current, plan.insertDependencies, plan.baseline.id, Boolean(plan.newCalendar));
    process.exit(1);
  }
  console.log(
    `\nLinha de Balanço atualizada: ${mutation.update.activities.length} blocos com datas novas, ${plan.insertDependencies.length} dependências.`,
  );
}

/** Desfaz uma gravação que parou no meio: devolve datas, cores e dependências e tira o que entrou. */
async function restore(
  workId: string,
  before: Awaited<ReturnType<typeof loadLob>>,
  inserted: LobDependency[],
  baselineId: string,
  calendarCreated: boolean,
) {
  const client = getServiceClient();
  const report = (what: string, error: { message: string } | null) => error && console.error(`  não consegui ${what}: ${error.message}`);
  for (let i = 0; i < inserted.length; i += 200)
    report(
      'apagar as dependências novas',
      (
        await client
          .from('lob_dependencies')
          .delete()
          .in(
            'id',
            inserted.slice(i, i + 200).map(d => d.id),
          )
      ).error,
    );
  report('apagar a linha de base automática', (await client.from('lob_baselines').delete().eq('id', baselineId)).error);
  const present = new Set(((await client.from('lob_dependencies').select('id').eq('work_id', workId)).data ?? []).map(r => r.id as string));
  try {
    await applyLobMutation({
      workId,
      insert: { ...EMPTY(), dependencies: before.dependencies.filter(d => !present.has(d.id)) },
      update: { ...EMPTY(), activities: before.activities, services: before.services },
      delete: EMPTY(),
      removeFiles: [],
    });
  } catch (error) {
    console.error(`  não consegui devolver datas, cores e dependências: ${(error as Error).message}`);
  }
  if (calendarCreated) report('apagar o calendário', (await client.from('lob_calendars').delete().eq('work_id', workId)).error);
}

main().catch(error => fail(error instanceof Error ? (error.stack ?? error.message) : String(error)));

import test from 'node:test';
import assert from 'node:assert/strict';
import { cascade, type LobLocal } from '../src/domain/lob';
import { buildPrevisionImport, type PrevisionImportOptions } from '../src/domain/lob-prevision-import';
import { localKey, parseCsv, readProgressReportSchedule } from '../src/domain/lob-progress-report-import';

const HEADER = [
  '"Atividade","","","","","","","","","","","","","","","","","","","","",""',
  '"","","","","","","","","","","","","","Contribuição","","","Avanço Físico-Financeiro","","","","",""',
  '"Código","Unidade","Local","Macro Etapa","Etapa","Data","Início Planejado Base","Término Planejado Base","Início Planejado","Término Planejado","Início Real","Término Real","Caminho Crítico","Real","Reprog","Base","Real (R$)","Reprog (R$)","Base (R$)","Real (%)","Reprog (%)","Base (%)"',
];
/** Uma linha do relatório: código, unidade, local, etapa, mês, base, planejado, real e o Real (%) do mês. */
const row = (code: string, unit: string, local: string, stage: string, month: string, dates: string[], real = '0.00%') =>
  [code, unit, local, 'Macro', stage, month, ...dates, 'Não', '0%', '0%', '0%', 'R$ 1,00', 'R$ 1,00', 'R$ 1,00', real, '0%', '0%']
    .map(cell => `"${cell}"`)
    .join(',');
/** Novembro de 2026: 02/11 é segunda-feira. */
const REPORT = [
  ...HEADER,
  // Alvenaria no térreo: concluída, em duas linhas de mês.
  row(
    '1.2.3.3',
    'Edificação',
    'Térreo',
    'Alvenaria',
    'Out/2026',
    ['26/10/2026', '30/10/2026', '02/11/2026', '06/11/2026', '03/11/2026', '09/11/2026'],
    '40.00%',
  ),
  row(
    '1.2.3.3',
    'Edificação',
    'Térreo',
    'Alvenaria',
    'Nov/2026',
    ['26/10/2026', '30/10/2026', '02/11/2026', '06/11/2026', '03/11/2026', '09/11/2026'],
    '60.00%',
  ),
  // Alvenaria no 2º pavimento: em andamento, sem linha de base.
  row('1.3.3.3', 'Edificação', '2º pavto.', 'Alvenaria', 'Nov/2026', ['', '', '09/11/2026', '13/11/2026', '10/11/2026', ''], '30.00%'),
  // Forro de gesso duas vezes no térreo: duas passadas.
  row('1.2.4.19', 'Edificação', 'Térreo', 'Forro de gesso', 'Nov/2026', ['09/11/2026', '13/11/2026', '09/11/2026', '13/11/2026', '', '']),
  row('1.2.8.8', 'Edificação', 'Térreo', 'Forro de gesso', 'Nov/2026', ['23/11/2026', '24/11/2026', '23/11/2026', '24/11/2026', '', '']),
  row('1.3.4.19', 'Edificação', '2º pavto.', 'Forro de gesso', 'Nov/2026', [
    '16/11/2026',
    '20/11/2026',
    '16/11/2026',
    '20/11/2026',
    '',
    '',
  ]),
  // Subsolo vem depois no arquivo, mas é o local 1 do código.
  row('1.1.3.3', 'Edificação', 'SS1', 'Alvenaria', 'Out/2026', [
    '19/10/2026',
    '23/10/2026',
    '26/10/2026',
    '30/10/2026',
    '26/10/2026',
    '30/10/2026',
  ]),
  row('2.1.3.3', 'Fachadas', 'Pano 1', 'Textura', 'Nov/2026', ['16/11/2026', '20/11/2026', '16/11/2026', '20/11/2026', '', '']),
  row('1.2.4.33', 'Edificação', 'Térreo', 'Impermeabilização', 'Nov/2026', ['', '', '', '', '', '']),
  row('', 'Despesas Indiretas', 'Despesas Indiretas', 'Despesas Indiretas', 'Nov/2026', ['', '', '', '', '', '']),
].join('\r\n');

let uid = 0;
const options = (extra: Partial<PrevisionImportOptions> = {}): PrevisionImportOptions => ({
  workId: 'w1',
  workName: 'Obra',
  actorId: 'u1',
  now: '2026-11-24T12:00:00.000Z',
  newId: () => `id-${++uid}`,
  measurementDate: '2026-11-24',
  sourceName: 'Avanço Físico-Financeiro',
  sourceLabel: 'Relatório',
  ...extra,
});

test('Relatório: o CSV respeita aspas, vírgulas dentro do campo e o BOM', () => {
  assert.deepEqual(parseCsv('﻿"a","b, c","d ""e"""\r\n"1","",""\r\n'), [
    ['a', 'b, c', 'd "e"'],
    ['1', '', ''],
  ]);
});

test('Relatório: grafias do mesmo pavimento dão a mesma chave', () => {
  assert.equal(localKey('2º pavto.'), localKey('2 PAV'));
  assert.equal(localKey('4ºpavto'), localKey('4 pav'));
  assert.notEqual(localKey('2 PAV'), localKey('12 PAV'));
  assert.equal(localKey('Térreo'), localKey('TÉRREO'));
});

test('Relatório: um bloco por código, com datas planejadas, reais, base e avanço', () => {
  const schedule = readProgressReportSchedule(REPORT);
  assert.deepEqual(
    schedule.locals.map(l => `${l.name}:${l.group}`),
    ['SS1:demais', 'Térreo:demais', '2º pavto.:pavimento_tipo', 'Pano 1:fachada'],
  );
  assert.deepEqual(schedule.services, ['Alvenaria', 'Forro de gesso', 'Forro de gesso (2)', 'Textura']);
  const of = (service: string, local: string) => schedule.blocks.find(b => b.serviceName === service && b.localName === local)!;
  const done = of('Alvenaria', 'Térreo');
  assert.deepEqual(
    [done.start, done.finish, done.workDays, done.percent, done.actualStart, done.actualFinish, done.baseStart, done.baseFinish],
    ['2026-11-02', '2026-11-06', 5, 100, '2026-11-03', '2026-11-09', '2026-10-26', '2026-10-30'],
  );
  const running = of('Alvenaria', '2º pavto.');
  assert.deepEqual(
    [running.percent, running.actualStart, running.actualFinish, running.baseStart],
    [30, '2026-11-10', undefined, undefined],
  );
  // Concluída sem custo: 0% financeiro, mas com término real é 100%.
  assert.equal(of('Alvenaria', 'SS1').percent, 100);
  assert.equal(of('Forro de gesso (2)', 'Térreo').start, '2026-11-23');
  assert.equal(schedule.blocks.length, 7);
  assert.ok(schedule.warnings.some(w => w.includes('sem código')));
  assert.ok(schedule.warnings.some(w => w.includes('"Impermeabilização": 1 atividade(s) sem datas')));
  assert.ok(schedule.warnings.some(w => w.includes('"Forro de gesso" acontece 2 vezes')));
});

test('Relatório: arquivo de outro formato é recusado', () => {
  assert.throws(
    () => readProgressReportSchedule('"Código","Local","Etapa","Data","Real (R$)"\n"1.1","SS1","Alvenaria","Nov/2026","1"'),
    /Início Planejado/,
  );
});

test('Relatório: grava datas reais, linha de base do relatório e reordena os locais já cadastrados', () => {
  const stamp = { createdAt: 'x', updatedAt: 'x' };
  const existing: LobLocal[] = [
    { id: 'l-terreo', workId: 'w1', name: 'TÉRREO', orderIndex: 0, ...stamp },
    { id: 'l-2', workId: 'w1', name: '2 PAV', orderIndex: 1, ...stamp },
    { id: 'l-cob', workId: 'w1', name: 'COBERTURA', orderIndex: 2, ...stamp },
  ];
  const schedule = readProgressReportSchedule(
    REPORT,
    undefined,
    existing.map(l => l.name),
  );
  const result = buildPrevisionImport(schedule, options({ existingLocals: existing, reorderLocals: true, withFlows: false }));
  // SS1 (novo) entra embaixo; os cadastrados são reaproveitados e sobem; o sem bloco vai para o fim.
  assert.deepEqual(
    result.localOrder.map(l => `${l.local.orderIndex}:${l.local.name}`),
    ['0:SS1', '1:TÉRREO', '2:2 PAV', '3:Pano 1'],
  );
  assert.deepEqual(result.locals.map(l => l.name).sort(), ['Pano 1', 'SS1']);
  assert.deepEqual(result.localUpdates.map(l => `${l.id}:${l.orderIndex}`).sort(), ['l-2:2', 'l-cob:4', 'l-terreo:1']);
  const service = new Map(result.services.map(s => [s.id, s.name]));
  const of = (name: string, localId: string) => result.activities.find(a => service.get(a.serviceId) === name && a.localId === localId)!;
  const done = of('Alvenaria', 'l-terreo');
  assert.deepEqual([done.start, done.durationDays, done.actualStart, done.actualFinish], ['2026-11-02', 5, '2026-11-03', '2026-11-09']);
  const running = of('Alvenaria', 'l-2');
  assert.deepEqual([running.actualStart, running.actualFinish], ['2026-11-10', undefined]);
  // Linha de base: as datas "Planejado Base"; o bloco sem elas fica de fora.
  const entry = result.baseline.snapshot.find(e => e.activityId === done.id)!;
  assert.deepEqual([entry.start, entry.durationDays, entry.finish], ['2026-10-26', 5, '2026-10-30']);
  assert.equal(
    result.baseline.snapshot.some(e => e.activityId === running.id),
    false,
  );
  assert.equal(result.baseline.snapshot.length, 6);
  assert.match(result.baseline.name, /^Relatório — Avanço Físico-Financeiro/);
  const value = (id: string) => result.items.find(i => i.activityId === id)?.value;
  assert.deepEqual([value(done.id), value(running.id)], [100, 30]);
  assert.equal(cascade(result.activities, result.dependencies).length, 0);
});

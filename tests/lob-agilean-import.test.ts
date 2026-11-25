import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateRawSync } from 'node:zlib';
import { activityFinish, cascade, type LobActivity, type LobLocal, type LobService } from '../src/domain/lob';
import { abbreviationFits, planAgileanUpdate, readAgileanLob, type AgileanUpdateOptions } from '../src/domain/lob-agilean-import';
import { cellKey, parseCellRef, type XlsxCell, type XlsxGrid, type XlsxRange } from '../src/domain/xlsx-grid';
import { readXlsxSheet } from '../src/infrastructure/files/xlsx';

// ─── Planilha de exemplo no formato do Agilean ──────────────────────────────────
// Setembro de 2024: 02/09 é segunda-feira. Aparecem 02, 03, 05, 06, 09, 10 e 11: a quarta 04/09 não tem
// coluna (feriado no Agilean). Cada dia ocupa 4 colunas a partir da coluna 4; grupo na coluna 1, local
// na coluna 2; cada local tem 4 linhas.
const DAYS = ['2024-09-02', '2024-09-03', '2024-09-05', '2024-09-06', '2024-09-09', '2024-09-10', '2024-09-11'];
const FIRST = 4;
const col = (day: string, quarter = 0) => FIRST + DAYS.indexOf(day) * 4 + quarter;

function sheet(blocks: { row: number; from: string; to: string; text: string; fill: string; quarter?: number; rows?: number }[]): XlsxGrid {
  const cells = new Map<string, XlsxCell>();
  const merges: XlsxRange[] = [];
  const put = (row: number, c: number, value: string | number, fill?: string) =>
    cells.set(cellKey(row, c), fill ? { value, fill } : { value });
  put(1, FIRST, 'setembro de 2024');
  merges.push({ r0: 1, c0: FIRST, r1: 1, c1: FIRST + DAYS.length * 4 - 1 });
  DAYS.forEach((day, i) => {
    const c = FIRST + i * 4;
    put(2, c, 'SSTQQSD'[new Date(`${day}T12:00:00Z`).getUTCDay()]);
    put(3, c, Number(day.slice(8)));
    merges.push({ r0: 2, c0: c, r1: 2, c1: c + 3 }, { r0: 3, c0: c, r1: 3, c1: c + 3 });
  });
  put(4, 1, 'Edificação Fluxo geral');
  put(4, 2, '2º pavto.');
  put(8, 2, '3º pavto.');
  put(12, 1, 'Fachadas Fachada');
  put(12, 2, 'Fachada Sul');
  for (const b of blocks) {
    const c0 = col(b.from, b.quarter ?? 0);
    put(b.row, c0, b.text, b.fill);
    merges.push({ r0: b.row, c0, r1: b.row + (b.rows ?? 4) - 1, c1: col(b.to) + 3 });
  }
  return { name: 'Agilean', cells, merges };
}

const AGILEAN_BLOCKS = [
  { row: 4, from: '2024-09-02', to: '2024-09-03', text: 'Alvenaria - 2 d', fill: '#f3767a' },
  { row: 8, from: '2024-09-05', to: '2024-09-06', text: 'Alvenaria - 2 d', fill: '#f3767a' },
  // Começa no terceiro quarto do dia 03 e atravessa o feriado: 03 e 05 são 2 dias úteis.
  { row: 4, from: '2024-09-03', to: '2024-09-05', text: 'Esq Alum - 1.5 d', fill: '#cf1c27', quarter: 2, rows: 1 },
  { row: 8, from: '2024-09-09', to: '2024-09-09', text: 'Esq Alum - 1 d', fill: '#cf1c27', rows: 1 },
  // Sigla sem relação com o nome: só por eliminação.
  { row: 5, from: '2024-09-06', to: '2024-09-06', text: 'DW1 - 1 d', fill: '#4c5be4', rows: 1 },
  { row: 9, from: '2024-09-10', to: '2024-09-10', text: 'DW1 - 1 d', fill: '#4c5be4', rows: 1 },
  // Dois "Forro de gesso" (cores diferentes) no mesmo local: decidem as datas.
  { row: 6, from: '2024-09-09', to: '2024-09-09', text: 'Forro de gesso - 1 d', fill: '#dd47b8', rows: 1 },
  { row: 7, from: '2024-09-11', to: '2024-09-11', text: 'Forro de gesso - 1 d', fill: '#35913e', rows: 1 },
  { row: 12, from: '2024-09-02', to: '2024-09-05', text: 'Pastilha - 3 d', fill: '#24a0ab' },
];

test('Agilean: cabeçalho de dias, feriado pela coluna que falta, locais, faixas e quartos de dia', () => {
  const lob = readAgileanLob(sheet(AGILEAN_BLOCKS));
  assert.deepEqual(lob.days, DAYS);
  assert.deepEqual(lob.calendar, { weekdays: [1, 2, 3, 4, 5], holidays: ['2024-09-04'] });
  assert.deepEqual(lob.locals, [
    { name: '2º pavto.', group: 'Edificação Fluxo geral' },
    { name: '3º pavto.', group: 'Edificação Fluxo geral' },
    { name: 'Fachada Sul', group: 'Fachadas Fachada' },
  ]);
  const esq = lob.blocks.find(b => b.label === 'Esq Alum' && b.localName === '2º pavto.')!;
  assert.deepEqual([esq.start, esq.finish, esq.labelDays, esq.color], ['2024-09-03', '2024-09-05', 1.5, '#cf1c27']);
  const dw = lob.blocks.find(b => b.label === 'DW1' && b.row === 5)!;
  assert.equal(dw.localName, '2º pavto.', 'a faixa de uma linha pertence ao local de cima');
  assert.equal(lob.blocks.find(b => b.label === 'Pastilha')!.group, 'Fachadas Fachada');
  assert.equal(lob.blocks.length, AGILEAN_BLOCKS.length);
});

test('Agilean: planilha sem a linha dos meses é recusada', () => {
  assert.throws(() => readAgileanLob({ name: 'x', cells: new Map([[cellKey(1, 1), { value: 'Obra' }]]), merges: [] }), /linha dos meses/);
});

test('sigla do Agilean: pedaços em ordem, começo de palavra, pulando palavras', () => {
  assert.ok(abbreviationFits('Esq Alum', 'Esquadrias de alumínio'));
  assert.ok(abbreviationFits('ELE-DW', 'Infra elétrica no DW'));
  assert.ok(abbreviationFits('Reg. e. pin. d', 'Regularização e pintura do poço'));
  assert.ok(abbreviationFits('Balancins', 'Montagem de balancins'));
  assert.ok(!abbreviationFits('Est. de. con.', 'Estacas da fundação'), '"de" não é começo de "da"');
  assert.ok(!abbreviationFits('Pint. 1', 'Pintura Final'));
  assert.ok(!abbreviationFits('DW1', 'Drywall estrutura + 1ªchapa'));
});

// ─── Linha de Balanço da obra ────────────────────────────────────────────────────
const NOW = '2024-09-12T12:00:00.000Z';
const stamp = { createdAt: '2024-08-01T00:00:00.000Z', updatedAt: '2024-08-01T00:00:00.000Z' };
const local = (id: string, name: string, orderIndex: number): LobLocal => ({ id, workId: 'w', name, orderIndex, ...stamp });
const service = (id: string, name: string, orderIndex: number): LobService => ({
  id,
  workId: 'w',
  name,
  color: '#2a78d6',
  orderIndex,
  ...stamp,
});
const activity = (
  id: string,
  serviceId: string,
  localId: string,
  start: string,
  durationDays: number,
  extra: Partial<LobActivity> = {},
): LobActivity => ({
  id,
  workId: 'w',
  serviceId,
  localId,
  start,
  durationDays,
  ...stamp,
  ...extra,
});
function currentLob() {
  const locals = [local('l2', '2 PAV', 0), local('l3', '3 PAV', 1), local('lf', 'Fachada Sul', 2)];
  const services = [
    service('alv', 'Alvenaria', 0),
    service('esq', 'Esquadrias de alumínio', 1),
    service('dw', 'Drywall estrutura + 1ªchapa', 2),
    service('forro', 'Forro de gesso', 3),
    service('forro2', 'Forro de gesso (2)', 4),
    service('pas', 'Pastilha', 5),
  ];
  const activities = [
    activity('a2', 'alv', 'l2', '2024-09-02', 2, { actualStart: '2024-09-02', actualFinish: '2024-09-03' }),
    activity('a3', 'alv', 'l3', '2024-09-04', 2),
    activity('e2', 'esq', 'l2', '2024-09-05', 1),
    activity('e3', 'esq', 'l3', '2024-09-06', 1),
    activity('d2', 'dw', 'l2', '2024-09-06', 1),
    activity('d3', 'dw', 'l3', '2024-09-09', 1),
    activity('f2', 'forro', 'l2', '2024-09-09', 1),
    activity('g2', 'forro2', 'l2', '2024-09-10', 1),
    activity('p', 'pas', 'lf', '2024-09-02', 3),
  ];
  const dependencies = [
    { id: 'old', workId: 'w', predecessorId: 'a2', successorId: 'a3', lagDays: 0, kind: 'crew' as const, createdAt: stamp.createdAt },
  ];
  return { locals, services, activities, dependencies };
}
let counter = 0;
const OPTIONS: AgileanUpdateOptions = {
  workId: 'w',
  workName: 'Obra',
  actorId: 'u',
  now: NOW,
  newId: () => `n${++counter}`,
  date: '2024-09-12',
};

test('atualização: liga por nome, sigla, eliminação e datas; mantém os blocos e refaz as dependências', () => {
  const current = currentLob();
  const plan = planAgileanUpdate(current, readAgileanLob(sheet(AGILEAN_BLOCKS)), OPTIONS);
  assert.deepEqual([plan.missingLocals, plan.unmatchedBlocks, plan.leftoverActivities], [[], [], []]);
  const how = Object.fromEntries(plan.matches.map(m => [`${m.label}|${m.color}`, `${m.serviceName}|${m.how}`]));
  assert.equal(how['Alvenaria|#f3767a'], 'Alvenaria|nome');
  assert.equal(how['Esq Alum|#cf1c27'], 'Esquadrias de alumínio|sigla');
  assert.equal(how['DW1|#4c5be4'], 'Drywall estrutura + 1ªchapa|eliminacao');
  assert.equal(how['Forro de gesso|#dd47b8'], 'Forro de gesso|nome', 'o que começa antes fica com o primeiro');
  assert.equal(how['Forro de gesso|#35913e'], 'Forro de gesso (2)|nome');

  const byId = new Map(plan.activities.map(a => [a.id, a]));
  assert.equal(plan.activities.length, current.activities.length);
  assert.deepEqual([byId.get('a3')!.start, byId.get('a3')!.durationDays], ['2024-09-05', 2]);
  // 03 a 05 atravessa o feriado do Agilean, que vai para a obra: 2 dias úteis.
  assert.deepEqual([byId.get('e2')!.start, byId.get('e2')!.durationDays], ['2024-09-03', 2]);
  assert.equal(activityFinish(byId.get('e2')!, plan.calendar), '2024-09-05');
  assert.deepEqual([byId.get('p')!.start, byId.get('p')!.durationDays], ['2024-09-02', 3], '02, 03 e 05');
  assert.equal(byId.get('a2')!.actualFinish, '2024-09-03', 'datas reais ficam');
  assert.equal(byId.get('a2'), current.activities[0], 'bloco igual não é regravado');
  assert.deepEqual(plan.newCalendar, { weekdays: [1, 2, 3, 4, 5], holidays: ['2024-09-04'] });

  // Linha de base automática com as datas de antes.
  assert.equal(plan.baseline.automatic, true);
  assert.equal(plan.baseline.snapshot.find(e => e.activityId === 'a3')!.start, '2024-09-04');
  // Dependências: as antigas saem; as novas ligam blocos existentes e nada se move.
  assert.deepEqual(
    plan.deleteDependencies.map(d => d.id),
    ['old'],
  );
  const ids = new Set(current.activities.map(a => a.id));
  assert.ok(plan.insertDependencies.length > 0);
  assert.ok(plan.insertDependencies.every(d => ids.has(d.predecessorId) && ids.has(d.successorId)));
  assert.ok(plan.insertDependencies.some(d => d.predecessorId === 'a2' && d.successorId === 'a3' && d.kind === 'crew'));
  assert.deepEqual(cascade(plan.activities, plan.insertDependencies, plan.calendar), []);
  // Cores do Agilean.
  assert.equal(plan.services.find(s => s.id === 'esq')!.color, '#cf1c27');
});

test('atualização: bloco sem par ou local que não existe impede a gravação', () => {
  const extra = [...AGILEAN_BLOCKS, { row: 10, from: '2024-09-11', to: '2024-09-11', text: 'Laminado - 1 d', fill: '#7129d8', rows: 1 }];
  const plan = planAgileanUpdate(currentLob(), readAgileanLob(sheet(extra)), OPTIONS);
  assert.deepEqual(
    plan.unmatchedBlocks.map(b => b.label),
    ['Laminado'],
  );
  assert.deepEqual(plan.insertDependencies, [], 'sem par, não refaz dependências');

  const current = currentLob();
  current.locals = current.locals.filter(l => l.id !== 'lf');
  current.activities = current.activities.filter(a => a.localId !== 'lf');
  const noFacade = planAgileanUpdate(current, readAgileanLob(sheet(AGILEAN_BLOCKS)), OPTIONS);
  assert.deepEqual(noFacade.missingLocals, ['Fachada Sul']);

  const missing = currentLob();
  missing.activities.push(activity('x', 'pas', 'l2', '2024-09-11', 1));
  assert.equal(planAgileanUpdate(missing, readAgileanLob(sheet(AGILEAN_BLOCKS)), OPTIONS).leftoverActivities[0].id, 'x');
});

test('atualização: obra com calendário próprio fica com ele', () => {
  const current = { ...currentLob(), calendar: { weekdays: [1, 2, 3, 4, 5], holidays: [] } };
  const plan = planAgileanUpdate(current, readAgileanLob(sheet(AGILEAN_BLOCKS)), OPTIONS);
  assert.equal(plan.newCalendar, undefined);
  assert.equal(plan.activities.find(a => a.id === 'e2')!.durationDays, 3, 'sem o feriado, 03 a 05 são 3 dias');
  assert.ok(plan.warnings.some(w => w.includes('calendário próprio')));
});

// ─── Leitura do .xlsx ────────────────────────────────────────────────────────────

/** Zip mínimo: a primeira entrada sem compressão, as demais com deflate. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  Object.entries(files).forEach(([name, text], index) => {
    const raw = Buffer.from(text, 'utf8');
    const method = index === 0 ? 0 : 8;
    const data = method ? deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name, 'utf8');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(crc32(raw), 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    locals.push(header, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(crc32(raw), 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  });
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

test('xlsx: valores, textos compartilhados e ricos, cor de preenchimento e células mescladas', () => {
  const file = zip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Agilean &amp; cia" sheetId="1" r:id="rId7"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId7" Target="worksheets/folha.xml"/></Relationships>',
    'xl/sharedStrings.xml':
      '<sst><si><t>setembro de 2024</t></si><si><r><t>Alvenaria</t></r><r><t xml:space="preserve"> - 2 d</t></r></si></sst>',
    'xl/styles.xml':
      '<styleSheet><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF3767A"/></patternFill></fill></fills>' +
      '<cellXfs count="2"><xf fillId="0"/><xf fillId="2" applyFill="1"/></cellXfs></styleSheet>',
    'xl/worksheets/folha.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>2</v></c><c r="C1" s="1"/></row>' +
      '<row r="4"><c r="DEU4" s="1" t="s"><v>1</v></c><c r="D4" t="inlineStr"><is><t>Térreo &lt;A&gt;</t></is></c></row></sheetData>' +
      '<mergeCells count="1"><mergeCell ref="DEU4:DEX7"/></mergeCells></worksheet>',
  });
  const grid = readXlsxSheet(file);
  assert.equal(grid.name, 'Agilean & cia');
  assert.deepEqual(grid.cells.get(cellKey(1, 1)), { value: 'setembro de 2024' });
  assert.deepEqual(grid.cells.get(cellKey(1, 2)), { value: 2 });
  assert.deepEqual(grid.cells.get(cellKey(1, 3)), { fill: '#f3767a' }, 'célula vazia pintada guarda só a cor');
  assert.deepEqual(grid.cells.get(cellKey(4, 2855)), { value: 'Alvenaria - 2 d', fill: '#f3767a' });
  assert.deepEqual(grid.cells.get(cellKey(4, 4)), { value: 'Térreo <A>' });
  assert.deepEqual(grid.merges, [{ r0: 4, c0: 2855, r1: 7, c1: 2858 }]);
  assert.deepEqual(parseCellRef('DEU193'), { row: 193, col: 2855 });
  assert.throws(() => readXlsxSheet(Buffer.from('não é zip')), /não é um \.xlsx/);
});

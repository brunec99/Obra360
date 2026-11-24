import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareWbs,
  normalizeEnterprises,
  normalizeSheetItems,
  parseSiengeBuildingId,
  siengeCode,
  siengeCostLines,
  siengeSheetOfCode,
  suggestEnterprise,
} from '../src/domain/sienge-budget';
import type { DraftCost } from '../src/modules/longo-prazo/lob/costs-model';
import { mergeSiengeBudget } from '../src/modules/longo-prazo/lob/costs-sienge';
import { siengeConfigFromEnv } from '../src/infrastructure/integrations/sienge/client';

const group = (wbsCode: string, description: string) => ({ id: wbsCode, wbsCode, workItemId: null, description, totalPrice: null });
const leaf = (wbsCode: string, description: string, totalPrice: number) => ({
  id: wbsCode,
  wbsCode,
  workItemId: 10,
  description,
  unitOfMeasure: 'm2',
  quantity: 2,
  unitPrice: totalPrice / 2,
  totalPrice,
});
const SHEET = { id: 7, description: 'EDIFICAÇÃO' };
const RAW = [
  group('03', 'ALVENARIA'),
  group('03.001', 'ALVENARIA DE VEDAÇÃO'),
  group('03.001.003', 'CANALETA - Materiais'),
  leaf('03.001.003.010', 'Cimento CP II', 100.004),
  leaf('03.001.003.002', 'Areia Média', 50),
  leaf('03.001.003.003', 'Item zerado', 0),
  group('03.001.004', 'ALVENARIA DE VEDAÇÃO - Mão de Obra'),
  leaf('03.001.004.001', 'Assentamento', 1000),
  leaf('03.001.004.001', 'Assentamento repetido', 5),
  { wbsCode: '', description: 'sem código', totalPrice: 9 },
  null,
];

test('código do empreendimento: inteiro positivo', () => {
  assert.equal(parseSiengeBuildingId(32), 32);
  assert.equal(parseSiengeBuildingId(' 110 '), 110);
  for (const bad of [0, -1, 1.5, '03', 'abc', '', null, undefined, '1234567890']) assert.equal(parseSiengeBuildingId(bad), null);
});

test('código do item leva a unidade construtiva e é reconhecido de volta', () => {
  assert.equal(siengeCode(7, '03.001.004'), 'UC7 03.001.004');
  assert.equal(siengeSheetOfCode('UC7 03.001.004'), 7);
  assert.equal(siengeSheetOfCode('03.001.004'), null);
  assert.equal(siengeSheetOfCode(undefined), null);
});

test('códigos da EAP ordenam parte a parte', () => {
  assert.deepEqual(['01.010', '01.002', '01', '02'].sort(compareWbs), ['01', '01.002', '01.010', '02']);
});

test('itens da unidade: só folhas com valor, na ordem do código, com o grupo e o caminho', () => {
  const { summary, lines } = normalizeSheetItems(SHEET, RAW);
  assert.deepEqual(summary, { id: 7, description: 'EDIFICAÇÃO', items: 4, valued: 3, total: 1150 });
  assert.deepEqual(
    lines.map(l => [l.code, l.description, l.amount]),
    [
      ['UC7 03.001.003.002', 'Areia Média', 50],
      ['UC7 03.001.003.010', 'Cimento CP II', 100],
      ['UC7 03.001.004.001', 'Assentamento', 1000],
    ],
  );
  assert.deepEqual(lines[0].path, ['ALVENARIA', 'ALVENARIA DE VEDAÇÃO', 'CANALETA - Materiais']);
  assert.deepEqual(lines[0].group, { wbsCode: '03.001.003', description: 'CANALETA - Materiais' });
  assert.deepEqual(normalizeSheetItems(SHEET, 'lixo').lines, []);
});

test('linhas por grupo somam os itens; item a item levam o grupo na descrição', () => {
  const { lines } = normalizeSheetItems(SHEET, [...RAW, leaf('09', 'Item solto', 7)]);
  assert.deepEqual(siengeCostLines(lines, 'grupo'), [
    { sheetId: 7, code: 'UC7 03.001.003', description: 'CANALETA - Materiais', amount: 150 },
    { sheetId: 7, code: 'UC7 03.001.004', description: 'ALVENARIA DE VEDAÇÃO - Mão de Obra', amount: 1000 },
    { sheetId: 7, code: 'UC7 09', description: 'Item solto', amount: 7 },
  ]);
  const items = siengeCostLines(lines, 'item');
  assert.equal(items.length, 4);
  assert.equal(items[0].description, 'CANALETA - Materiais › Areia Média');
  assert.equal(items[3].description, 'Item solto');
});

test('empreendimentos: lista limpa e sugestão pelo nome da obra (o ENG de código maior)', () => {
  const list = normalizeEnterprises([
    { id: 31, name: 'Atmos (ADM)' },
    { id: 32, name: 'Atmos (ENG)' },
    { id: 110, name: 'ATMOS - IMPORTAÇÃO ORÇAMENTO (auxiliar)' },
    { id: 20, name: 'Essenza (ENG)' },
    { id: 33, name: 'Essenza (ENG)' },
    { id: 25, name: 'Mozine - Casa Amariles (ENG)' },
    { id: 34, name: 'Mozine (ENG)' },
    { id: 0, name: 'inválido' },
    { id: 5, name: '  ' },
  ]);
  assert.equal(list.length, 7);
  assert.equal(suggestEnterprise('Atmos', list)?.id, 32);
  assert.equal(suggestEnterprise('ESSENZA', list)?.id, 33);
  assert.equal(suggestEnterprise('Mozine', list)?.id, 34);
  assert.equal(suggestEnterprise('Tauá', list), null);
  assert.equal(suggestEnterprise('', list), null);
});

test('credencial: as três variáveis ou nada', () => {
  assert.equal(siengeConfigFromEnv({}), null);
  assert.equal(siengeConfigFromEnv({ SIENGE_SUBDOMAIN: 'a/b', SIENGE_API_USER: 'u', SIENGE_API_PASSWORD: 'p' }), null);
  assert.deepEqual(siengeConfigFromEnv({ SIENGE_SUBDOMAIN: ' empresa ', SIENGE_API_USER: 'u', SIENGE_API_PASSWORD: 'p' }), {
    subdomain: 'empresa',
    user: 'u',
    password: 'p',
  });
});

// ─── Junção com o rascunho ────────────────────────────────────────────────────

const item = (id: string, code: string | undefined, amount: number, serviceId?: string, description = id): DraftCost => ({
  id,
  workId: 'w',
  ...(serviceId ? { serviceId } : {}),
  ...(code ? { code } : {}),
  description,
  amount,
  orderIndex: Number(id.replace(/\D/g, '')) || 0,
  createdBy: 'u',
  createdAt: '2026-11-23T00:00:00.000Z',
  updatedAt: '2026-11-23T00:00:00.000Z',
});
const context = () => {
  let n = 0;
  return { workId: 'w', actorId: 'u', now: '2026-11-23T12:00:00.000Z', newId: () => `novo-${++n}` };
};
const line = (code: string, amount: number, description = code, sheetId = 7) => ({ sheetId, code, description, amount });

test('nova busca: mantém o pacote, atualiza o valor, acrescenta o novo e tira o que saiu do orçamento', () => {
  const draft = [
    item('i1', 'UC7 03.001.003', 150, 's-alvenaria', 'CANALETA - Materiais'),
    item('i2', 'UC7 03.001.004', 900, 's-alvenaria', 'Mão de Obra'),
    item('i3', 'UC7 05.001.001', 10, 's-outro', 'Saiu do orçamento'),
    item('i4', 'UC8 01.001.001', 20, undefined, 'Outra unidade, não trazida'),
    item('i5', '01.02', 30, 's-outro', 'Colado da planilha'),
    item('i6', undefined, 40, 's-outro', 'Custo do pacote'),
  ];
  const lines = [
    line('UC7 03.001.003', 150, 'CANALETA - Materiais'),
    line('UC7 03.001.004', 1000, 'Mão de Obra'),
    line('UC7 04.001.001', 500, 'CONTRAMARCOS'),
    line('UC9 01.001.001', 1, 'Unidade não marcada', 9),
  ];
  const { draft: next, summary } = mergeSiengeBudget(draft, lines, [7], context());
  assert.deepEqual(summary, { added: 1, inherited: 0, updated: 1, unchanged: 1, removed: 1, total: 1650 });
  assert.deepEqual(
    next.map(i => [i.id, i.code, i.amount, i.serviceId]),
    [
      ['i1', 'UC7 03.001.003', 150, 's-alvenaria'],
      ['i2', 'UC7 03.001.004', 1000, 's-alvenaria'],
      ['i4', 'UC8 01.001.001', 20, undefined],
      ['i5', '01.02', 30, 's-outro'],
      ['i6', undefined, 40, 's-outro'],
      ['novo-1', 'UC7 04.001.001', 500, undefined],
    ],
  );
  // Repetir a mesma busca não muda nada.
  const again = mergeSiengeBudget(next, lines, [7], context());
  assert.deepEqual(again.summary, { added: 0, inherited: 0, updated: 0, unchanged: 3, removed: 0, total: 1650 });
  assert.deepEqual(again.draft, next);
});

test('troca de nível de detalhe: a linha nova herda o pacote do mesmo ramo e a antiga sai', () => {
  // De grupo para item: os itens herdam o pacote do grupo.
  const grouped = [item('g1', 'UC7 03.001.003', 150, 's-alvenaria')];
  const toItems = mergeSiengeBudget(grouped, [line('UC7 03.001.003.002', 50), line('UC7 03.001.003.010', 100)], [7], context());
  assert.deepEqual(toItems.summary, { added: 2, inherited: 2, updated: 0, unchanged: 0, removed: 1, total: 150 });
  assert.deepEqual(
    toItems.draft.map(i => [i.code, i.serviceId]),
    [
      ['UC7 03.001.003.002', 's-alvenaria'],
      ['UC7 03.001.003.010', 's-alvenaria'],
    ],
  );
  // De item para grupo: herda só quando todos os itens do grupo estão no mesmo pacote.
  const same = mergeSiengeBudget(toItems.draft, [line('UC7 03.001.003', 150)], [7], context());
  assert.equal(same.draft.length, 1);
  assert.equal(same.draft[0].serviceId, 's-alvenaria');
  const mixed = [item('a1', 'UC7 03.001.003.002', 50, 's-a'), item('a2', 'UC7 03.001.003.010', 100, 's-b')];
  assert.equal(mergeSiengeBudget(mixed, [line('UC7 03.001.003', 150)], [7], context()).draft[0].serviceId, undefined);
  const partial = [item('a1', 'UC7 03.001.003.002', 50, 's-a'), item('a2', 'UC7 03.001.003.010', 100)];
  assert.equal(mergeSiengeBudget(partial, [line('UC7 03.001.003', 150)], [7], context()).draft[0].serviceId, undefined);
});

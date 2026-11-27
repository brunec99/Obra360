import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isUuid,
  joinParts,
  matchOrcamentoObra,
  normalizeObraName,
  parseIndex,
  partRequestProblem,
  toOrcamentoElement,
  toOrcamentoModels,
  type OrcamentoModelRow,
} from '../src/domain/orcamento-models';

const obras = [
  { id: 'o-taua', nome: 'Tauá' },
  { id: 'o-atmos', nome: 'Atmos' },
  { id: 'o-501', nome: 'Apto 501' },
];

test('obra do Orçamento 4D: casa pelo nome, sem acento nem caixa', () => {
  assert.equal(normalizeObraName('  TAUÁ  '), 'taua');
  assert.deepEqual(matchOrcamentoObra('taua', obras, []), { id: 'o-taua', name: 'Tauá' });
  assert.deepEqual(matchOrcamentoObra('ATMOS', obras, []), { id: 'o-atmos', name: 'Atmos' });
  assert.equal(matchOrcamentoObra('Nova Sede', obras, []), null);
  assert.equal(matchOrcamentoObra('', obras, []), null);
});

test('obra do Orçamento 4D: obra privada nunca casa, mesmo com o nome igual', () => {
  assert.equal(matchOrcamentoObra('Apto 501', obras, ['o-501']), null);
  assert.deepEqual(matchOrcamentoObra('Apto 501', obras, []), { id: 'o-501', name: 'Apto 501' });
});

test('obra do Orçamento 4D: dois empreendimentos com o mesmo nome não casam', () => {
  assert.equal(matchOrcamentoObra('Atmos', [...obras, { id: 'o-atmos-2', nome: 'atmos' }], []), null);
  // se um dos dois é privado, sobra um só e ele casa
  assert.deepEqual(matchOrcamentoObra('Atmos', [...obras, { id: 'o-atmos-2', nome: 'atmos' }], ['o-atmos-2']), {
    id: 'o-atmos',
    name: 'Atmos',
  });
});

const row = (patch: Partial<OrcamentoModelRow>): OrcamentoModelRow => ({
  id: 'm1',
  disciplina: 'Estrutura',
  arquivo: 'EST.ifc',
  status: 'pronto',
  revisao: 2,
  geometria_partes: 3,
  fragments_tamanho: 5_000_000,
  total_elementos: 1200,
  ...patch,
});

test('modelos: só os prontos, em ordem de disciplina, com a geometria em partes', () => {
  const models = toOrcamentoModels([
    row({ id: 'm2', disciplina: 'Hidrossanitário' }),
    row({ id: 'm3', status: 'processando' }),
    row({ id: 'm4', status: 'erro' }),
    row({ id: 'm1', disciplina: 'Arquitetura', geometria_partes: null, fragments_tamanho: null }),
  ]);
  assert.deepEqual(
    models.map(model => model.id),
    ['m1', 'm2'],
  );
  assert.deepEqual(models[0], {
    id: 'm1',
    discipline: 'Arquitetura',
    file: 'EST.ifc',
    revision: 2,
    parts: 0,
    byteSize: 0,
    elements: 1200,
  });
  assert.equal(models[1].parts, 3);
});

test('modelos: sem disciplina, o nome é o do arquivo', () => {
  assert.equal(toOrcamentoModels([row({ disciplina: ' ' })])[0].discipline, 'EST.ifc');
});

test('parâmetros da URL: uuid e inteiro não negativo', () => {
  assert.ok(isUuid('f697e02b-55a5-49f3-8a30-2b2ea7af0208'));
  assert.ok(!isUuid('f697e02b-55a5-49f3-8a30'));
  assert.ok(!isUuid("f697e02b-55a5-49f3-8a30-2b2ea7af0208' or 1=1"));
  assert.equal(parseIndex('0'), 0);
  assert.equal(parseIndex('17'), 17);
  for (const bad of [null, '', '-1', '1.5', 'abc', '1e3', '12345678901']) assert.equal(parseIndex(bad), null);
});

test('parte da geometria: só da revisão atual e dentro do intervalo', () => {
  const model = { revision: 2, parts: 3 };
  assert.equal(partRequestProblem(model, 2, 0), null);
  assert.equal(partRequestProblem(model, 2, 2), null);
  assert.match(partRequestProblem(model, 2, 3) ?? '', /fora do intervalo/);
  assert.match(partRequestProblem(model, 1, 0) ?? '', /revisão nova/);
  assert.match(partRequestProblem({ revision: 2, parts: 0 }, 2, 0) ?? '', /não tem geometria/);
});

test('geometria: as partes voltam a ser um arquivo só, na ordem', () => {
  const bytes = joinParts([new Uint8Array([1, 2]), new Uint8Array([]), new Uint8Array([3])]);
  assert.deepEqual([...bytes], [1, 2, 3]);
  assert.equal(joinParts([]).byteLength, 0);
});

test('elemento: propriedades do tipo somadas, as da instância por cima; só valores simples', () => {
  const element = toOrcamentoElement(
    {
      express_id: 4521,
      global_id: '2O2Fr$t4X7Zf8NOew3FLOH',
      ifc_classe: 'IfcWall',
      nome: 'Parede 14',
      tipo_nome: '',
      pavimento: null,
      materiais: ['Bloco cerâmico', 7],
      classificacoes: null,
      props: { 'Pset.Externa': true, Marca: 'P14', ruim: { a: 1 } },
      qtd_ifc: { area: 12.5, texto: 'x' },
      qtd_geo: { volume: 1.75 },
    },
    { Marca: 'do tipo', 'Tipo.Espessura': 0.14 },
  );
  assert.equal(element.expressId, 4521);
  assert.equal(element.typeName, null);
  assert.equal(element.storey, null);
  assert.deepEqual(element.materials, ['Bloco cerâmico']);
  assert.deepEqual(element.classifications, []);
  assert.deepEqual(element.ifcQuantities, { area: 12.5 });
  assert.deepEqual(element.geometryQuantities, { volume: 1.75 });
  assert.deepEqual(element.properties, { Marca: 'P14', 'Tipo.Espessura': 0.14, 'Pset.Externa': true });
});

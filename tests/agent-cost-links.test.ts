import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COST_LINK_BATCH,
  costLinkItemsText,
  costLinkServicesText,
  estimateCostLinksUsd,
  isAgentModelError,
  parseCostLinks,
  suggestCostLinks,
} from '../src/infrastructure/agent/chat';

/** Sugestão de vínculos da visão Custos (16/11/2026): o texto que vai ao modelo e a validação da
 * resposta dele. Nenhum teste chama a API. */

const services = [
  { id: 's-alv', name: 'Alvenaria', unit: 'm²', team: 'Empreiteira A' },
  { id: 's-ele', name: 'Instalações elétricas' },
  { id: 's-pin', name: 'Pintura' },
];
const items = [
  { id: 'i1', code: '01.02.003', description: 'Bloco cerâmico 14x19x29' },
  { id: 'i2', description: 'Eletroduto corrugado 25 mm' },
  { id: 'i3', description: 'Administração local' },
  { id: 'i4', description: 'Tinta acrílica fosca' },
];

test('texto do prompt: listas numeradas a partir de 1, com código e sem valores', () => {
  const packages = costLinkServicesText(services);
  assert.match(packages, /^1\. Alvenaria \(unidade: m²; equipe: Empreiteira A\)$/m);
  assert.match(packages, /^3\. Pintura$/m);
  const list = costLinkItemsText([...items, { id: 'i5', description: ' Massa\n corrida  PVA ' }]);
  assert.match(list, /^1\. \[01\.02\.003\] Bloco cerâmico 14x19x29$/m);
  assert.match(list, /^5\. Massa corrida PVA$/m);
  assert.match(list, /destes 5 itens/);
  assert.doesNotMatch(list, /R\$/);
});

test('parseCostLinks: traduz números para ids; item que não aparece fica sem pacote', () => {
  const raw = JSON.stringify({
    vinculos: [
      { i: 1, p: 1, c: 'alta' },
      { i: 2, p: 2, c: 'media' },
      { i: 4, p: 3, c: 'baixa' },
    ],
  });
  assert.deepEqual(parseCostLinks(raw, items, services), [
    { itemId: 'i1', serviceId: 's-alv', confidence: 'alta' },
    { itemId: 'i2', serviceId: 's-ele', confidence: 'media' },
    { itemId: 'i3', serviceId: null, confidence: 'baixa' },
    { itemId: 'i4', serviceId: 's-pin', confidence: 'baixa' },
  ]);
});

test('parseCostLinks: descarta índice inválido, entrada torta e confiança desconhecida', () => {
  const parsed = parseCostLinks(
    {
      vinculos: [
        { i: 5, p: 1, c: 'alta' }, // item fora da lista
        { i: 1, p: 4, c: 'alta' }, // pacote fora da lista
        { i: 2, p: 2.5, c: 'alta' }, // não é inteiro
        { i: '3', p: 1, c: 'alta' }, // texto no lugar de número
        { i: 3, p: null, c: 'alta' }, // sem pacote
        null,
        'lixo',
        { i: 4, p: 3, c: 'certeza' }, // confiança desconhecida → baixa
      ],
    },
    items,
    services,
  );
  assert.deepEqual(
    parsed.map(s => [s.itemId, s.serviceId, s.confidence]),
    [
      ['i1', null, 'baixa'],
      ['i2', null, 'baixa'],
      ['i3', null, 'baixa'],
      ['i4', 's-pin', 'baixa'],
    ],
  );
});

test('parseCostLinks: item repetido — mesmo pacote fica com a menor confiança; pacotes diferentes, sem pacote', () => {
  const parsed = parseCostLinks(
    {
      vinculos: [
        { i: 1, p: 1, c: 'alta' },
        { i: 1, p: 1, c: 'baixa' },
        { i: 2, p: 2, c: 'alta' },
        { i: 2, p: 3, c: 'alta' },
        { i: 2, p: 2, c: 'alta' }, // depois do conflito, nada mais vale para o item
        { i: 4, p: 3, c: 'media' },
        { i: 4, p: 3, c: 'alta' },
      ],
    },
    items,
    services,
  );
  assert.deepEqual(
    parsed.map(s => [s.serviceId, s.confidence]),
    [
      ['s-alv', 'baixa'],
      [null, 'baixa'],
      [null, 'baixa'],
      ['s-pin', 'media'],
    ],
  );
});

test('parseCostLinks: resposta fora do formato vira erro 502', () => {
  const bad: unknown[] = [
    'não é json',
    '[]',
    'null',
    {},
    { vinculos: 'nada' },
    { vinculos: Array.from({ length: items.length * 2 + 1 }, () => ({ i: 1, p: 1, c: 'alta' })) },
  ];
  for (const raw of bad)
    assert.throws(
      () => parseCostLinks(raw, items, services),
      (error: unknown) => isAgentModelError(error) && error.status === 502,
    );
  // Lista vazia é resposta válida: nenhum item tem pacote.
  assert.ok(parseCostLinks({ vinculos: [] }, items, services).every(s => s.serviceId === null));
});

test('estimateCostLinksUsd: reserva proporcional ao lote e ao preço do modelo', () => {
  const sonnet = estimateCostLinksUsd(COST_LINK_BATCH, 60, 'claude-sonnet-5-5');
  assert.ok(sonnet > 0.08 && sonnet < 0.15, `reserva do lote cheio no Sonnet: ${sonnet}`);
  assert.ok(estimateCostLinksUsd(10, 60, 'claude-sonnet-5-5') < sonnet / 3);
  assert.ok(estimateCostLinksUsd(COST_LINK_BATCH, 60, 'claude-opus-5-5') > sonnet * 1.9);
});

test('suggestCostLinks: sem itens ou sem pacotes não chama o modelo', async () => {
  const config = { apiKey: 'chave-de-teste', model: 'claude-sonnet-5-5' };
  const empty = await suggestCostLinks({ config, services, items: [] });
  assert.deepEqual([empty.suggestions, empty.calls, empty.costUsd], [[], 0, 0]);
  const noPackages = await suggestCostLinks({ config, services: [], items });
  assert.equal(noPackages.calls, 0);
  assert.ok(noPackages.suggestions.every(s => s.serviceId === null));
});

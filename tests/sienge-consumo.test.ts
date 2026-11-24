import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enviarConsumo, itemDeConsumo, novoContador } from '../src/infrastructure/integrations/sienge/consumo';
import { BudgetCache, BUDGET_MIN_INTERVAL_MS } from '../src/infrastructure/integrations/sienge/budget-cache';
import type { SiengeBudget } from '../src/domain/sienge-budget';

// Regras do receptor api-consumo-receber (contrato consumo/1), copiadas para o teste não depender da rede.
const RE_ORIGEM = /^[a-z0-9][a-z0-9-]{0,59}$/;
const RE_SUFIXO_CHAVE = /^[A-Za-z0-9T:._-]{1,64}$/;

test('item de consumo passa nas regras do receptor', () => {
  for (const origem of ['orcamento', 'empreendimentos'] as const) {
    const c = novoContador(origem);
    c.conta();
    c.conta();
    const item = itemDeConsumo(c, new Date('2026-11-24T02:30:00Z'), 'ab12cd34');
    assert.equal(item.sistema, 'obra360');
    assert.equal(item.api, 'sienge');
    assert.equal(item.requisicoes, 2);
    assert.match(item.origem, RE_ORIGEM);
    const prefixo = `${item.sistema}:${item.api}:${item.origem}:`;
    assert.ok(item.chave.startsWith(prefixo));
    assert.match(item.chave.slice(prefixo.length), RE_SUFIXO_CHAVE);
    // Hora de Brasília: 02:30Z é 23h do dia anterior.
    assert.equal(item.chave, `${prefixo}2026-11-23T23.ab12cd34`);
  }
});

test('envio: sem chamada não envia; sem token só avisa; recusa e rede fora não lançam', async () => {
  const chamadas: Array<{ url: string; init: RequestInit }> = [];
  const falso = (async (url: string, init: RequestInit) => {
    chamadas.push({ url, init });
    return new Response(JSON.stringify({ code: 'item_invalido' }), { status: 400 });
  }) as unknown as typeof fetch;

  await enviarConsumo(novoContador('orcamento'), { CONSUMO_RECEBER_TOKEN: 't' }, falso);
  assert.equal(chamadas.length, 0, 'zero chamada não vira item');

  const c = novoContador('orcamento');
  c.conta();
  await enviarConsumo(c, {}, falso);
  assert.equal(chamadas.length, 0, 'sem token não envia');

  await enviarConsumo(c, { CONSUMO_RECEBER_TOKEN: 'segredo' }, falso);
  assert.equal(chamadas.length, 1);
  assert.match(chamadas[0].url, /api-consumo-receber$/);
  assert.equal((chamadas[0].init.headers as Record<string, string>).Authorization, 'Bearer segredo');
  const corpo = JSON.parse(String(chamadas[0].init.body));
  assert.equal(corpo.itens.length, 1);
  assert.equal(corpo.itens[0].requisicoes, 1);

  const quebrado = (async () => {
    throw new TypeError('rede');
  }) as unknown as typeof fetch;
  await enviarConsumo(c, { CONSUMO_RECEBER_TOKEN: 'segredo' }, quebrado);
});

const orcamento = (id: number): SiengeBudget => ({ buildingId: id, sheets: [], lines: [], total: 0, readAt: new Date(0).toISOString() });

test('cache: dentro de 15 minutos não lê de novo; depois lê', async () => {
  let agora = 1_000_000;
  let leituras = 0;
  const cache = new BudgetCache(
    async id => {
      leituras++;
      return orcamento(id);
    },
    () => agora,
  );
  const r1 = await cache.get(7);
  await cache.get(7);
  agora += BUDGET_MIN_INTERVAL_MS - 1;
  await cache.get(7);
  assert.equal(leituras, 1);
  assert.equal(r1.nextReadAt, new Date(1_000_000 + BUDGET_MIN_INTERVAL_MS).toISOString());
  agora += 1;
  await cache.get(7);
  assert.equal(leituras, 2);
  await cache.get(8);
  assert.equal(leituras, 3, 'cada empreendimento tem a sua janela');
});

test('cache: pedidos simultâneos viram uma leitura; erro não fica guardado', async () => {
  let leituras = 0;
  let falhar = true;
  const cache = new BudgetCache(async id => {
    leituras++;
    await new Promise(r => setTimeout(r, 10));
    if (falhar) throw new Error('sienge fora');
    return orcamento(id);
  });
  const juntos = await Promise.allSettled([cache.get(1), cache.get(1), cache.get(1)]);
  assert.equal(leituras, 1);
  assert.ok(juntos.every(r => r.status === 'rejected'));
  falhar = false;
  await cache.get(1);
  assert.equal(leituras, 2, 'depois do erro lê de novo');
});

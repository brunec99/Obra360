import test from 'node:test';
import assert from 'node:assert/strict';
import { fitWidths, layoutWidths, parseStoredWidths, rescaleWidths, serializeStoredWidths } from '../src/modules/curto-prazo/column-widths';
import { isFullWidthPath } from '../src/modules/curto-prazo/full-width';

const base = { empresa: 200, atividade: 400, dia: 100 };
const min = { empresa: 100, atividade: 150, dia: 40 };
const sum = (w: Record<string, number>) => Object.values(w).reduce((a, b) => a + b, 0);

test('Ajustar à tela reduz proporcionalmente quando há espaço acima dos mínimos', () => {
  const fitted = fitWidths(base, min, 525);
  assert.deepEqual(fitted, { empresa: 150, atividade: 300, dia: 75 });
});

test('Quem bate no mínimo para nele, e o resto divide o espaço que sobra', () => {
  // 340/700 levaria a empresa a 97 (< 100): ela para em 100 e os outros dividem os 240 restantes.
  const fitted = fitWidths(base, min, 340);
  assert.equal(fitted.empresa, 100);
  assert.deepEqual([fitted.atividade, fitted.dia], [192, 48]);
  assert.ok(sum(fitted) <= 340);
});

test('Sem espaço nem para os mínimos, fica nos mínimos (e a planilha rola de lado)', () => {
  assert.deepEqual(fitWidths(base, min, 100), min);
});

test('Tela maior que o padrão amplia proporcionalmente', () => {
  const fitted = fitWidths(base, min, 1400);
  assert.deepEqual(fitted, { empresa: 400, atividade: 800, dia: 200 });
});

/* 23/11/2026: a planilha acompanha a largura da tela (aba levada para a TV), só com as colunas à vista. */

const defaults = { empresa: 200, atividade: 400, dia: 100, seguimento: 100 };
const minimums = { empresa: 100, atividade: 150, dia: 40, seguimento: 80 };

test('Sem larguras escolhidas, só as colunas visíveis dividem o painel; a escondida fica no padrão', () => {
  const semApontamento = layoutWidths(defaults, minimums, ['empresa', 'atividade', 'dia'], null, 1400);
  assert.deepEqual(semApontamento, { empresa: 400, atividade: 800, dia: 200, seguimento: 100 });
  // "Apontamento" apareceu: as quatro colunas voltam a caber no mesmo painel.
  const comApontamento = layoutWidths(defaults, minimums, ['empresa', 'atividade', 'dia', 'seguimento'], null, 1400);
  assert.deepEqual(comApontamento, { empresa: 350, atividade: 700, dia: 175, seguimento: 175 });
});

test('O ajuste automático acompanha o painel: tela maior amplia, tela menor encolhe', () => {
  const visible = ['empresa', 'atividade', 'dia'];
  const notebook = layoutWidths(defaults, minimums, visible, null, 700);
  const tv = layoutWidths(defaults, minimums, visible, null, 2100);
  assert.deepEqual([notebook.empresa, notebook.atividade, notebook.dia], [200, 400, 100]);
  assert.deepEqual([tv.empresa, tv.atividade, tv.dia], [600, 1200, 300]);
});

test('Antes da primeira medição do painel valem as larguras padrão (ou as escolhidas), sem ajuste', () => {
  assert.deepEqual(layoutWidths(defaults, minimums, ['empresa'], null, 0), defaults);
  assert.deepEqual(layoutWidths(defaults, minimums, ['empresa'], { widths: { empresa: 300 }, panel: 1000 }, 0), {
    ...defaults,
    empresa: 300,
  });
});

test('Larguras escolhidas à mão mudam na proporção do painel em que foram definidas', () => {
  const stored = { widths: { empresa: 300, atividade: 500, dia: 60, seguimento: 100 }, panel: 1000 };
  const visible = ['empresa', 'atividade', 'dia'];
  // No mesmo painel, exatamente as escolhidas.
  assert.deepEqual(layoutWidths(defaults, minimums, visible, stored, 1000), stored.widths);
  // Na TV (o dobro), tudo dobra, inclusive a coluna escondida.
  assert.deepEqual(layoutWidths(defaults, minimums, visible, stored, 2000), { empresa: 600, atividade: 1000, dia: 120, seguimento: 200 });
  // Num painel menor, ninguém desce do mínimo (e a planilha rola de lado).
  assert.deepEqual(layoutWidths(defaults, minimums, visible, stored, 500), { empresa: 150, atividade: 250, dia: 40, seguimento: 80 });
});

test('Larguras escolhidas valem para as colunas guardadas; as outras ficam no padrão', () => {
  const widths = layoutWidths(defaults, minimums, ['empresa', 'atividade'], { widths: { empresa: 300 }, panel: 1000 }, 1000);
  assert.deepEqual(widths, { ...defaults, empresa: 300 });
});

test('Formato antigo (sem a largura de referência): as larguras valem como estão em qualquer painel', () => {
  const old = { widths: { empresa: 300, atividade: 500, dia: 60, seguimento: 100 } };
  assert.deepEqual(layoutWidths(defaults, minimums, ['empresa'], old, 2000), old.widths);
});

test('Reescalar sem as duas medidas não muda nada, e arredonda para o pixel', () => {
  assert.deepEqual(rescaleWidths({ empresa: 300 }, minimums, 0, 2000), { empresa: 300 });
  assert.deepEqual(rescaleWidths({ empresa: 300 }, minimums, 1000, 0), { empresa: 300 });
  assert.deepEqual(rescaleWidths({ empresa: 301 }, minimums, 1000, 1500), { empresa: 452 });
});

test('Leitura do que está guardado: formato antigo, formato novo e lixo', () => {
  // Antigo: só as colunas.
  assert.deepEqual(parseStoredWidths('{"empresa":300,"dia":60}', defaults), { widths: { empresa: 300, dia: 60 } });
  // Novo: as colunas e a largura do painel em que foram definidas.
  assert.deepEqual(parseStoredWidths('{"empresa":300,"_painel":1432}', defaults), { widths: { empresa: 300 }, panel: 1432 });
  // Coluna desconhecida, largura absurda e painel inválido são ignorados.
  assert.deepEqual(parseStoredWidths('{"empresa":300,"outra":200,"dia":3,"atividade":"x","_painel":-1}', defaults), {
    widths: { empresa: 300 },
  });
  // Nada aproveitável = sem escolha guardada: a planilha segue no ajuste automático.
  for (const raw of [null, undefined, '', '{}', '[]', 'null', '"texto"', '{"_painel":1400}', '{quebrado'])
    assert.equal(parseStoredWidths(raw, defaults), null, String(raw));
});

test('O que se grava volta igual na leitura, com ou sem a largura do painel', () => {
  const novo = { widths: { empresa: 300, dia: 60 }, panel: 1432 };
  assert.deepEqual(parseStoredWidths(serializeStoredWidths(novo), defaults), novo);
  const antigo = { widths: { empresa: 300 } };
  assert.equal(serializeStoredWidths(antigo), '{"empresa":300}');
  assert.deepEqual(parseStoredWidths(serializeStoredWidths(antigo), defaults), antigo);
});

test('Largura inteira da janela: só a aba Curto prazo da obra', () => {
  assert.equal(isFullWidthPath('/obras/atm/curto-prazo'), true);
  assert.equal(isFullWidthPath('/obras/atm/curto-prazo/'), true);
  assert.equal(isFullWidthPath('/obras/obra%20nova/curto-prazo'), true);
  for (const path of [
    '/obras',
    '/obras/atm',
    '/obras/atm/medio-prazo',
    '/obras/atm/curto-prazo-antigo',
    '/dashboard',
    '/curto-prazo',
    '',
    null,
    undefined,
  ])
    assert.equal(isFullWidthPath(path), false, String(path));
});

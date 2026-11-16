import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeGrid, decodeGrid, pasteTargets } from '../src/modules/medio-prazo/clipboard';
test('TSV preserva anotações multilinha, aspas e tabulações', () => {
  const rows = [
    ['Frente', 'Primeira linha\nSegunda "linha"'],
    ['Outra', 'com\ttabulação'],
  ];
  assert.deepEqual(decodeGrid(encodeGrid(rows)), rows);
});
test('aceita CRLF final e rejeita lote irregular ou acima do limite', () => {
  assert.deepEqual(decodeGrid('1\t2\r\n3\t4\r\n'), [
    ['1', '2'],
    ['3', '4'],
  ]);
  assert.throws(() => decodeGrid('1\t2\n3'), /retangular/);
  assert.throws(() => decodeGrid('1\t2', 1), /Limite/);
  assert.throws(() => decodeGrid('"ab'), /aspas/);
});
test('colagem repete o bloco quando a seleção é múltipla dele, como no Excel', () => {
  // Uma célula copiada enche a seleção inteira.
  assert.deepEqual(pasteTargets([['5 dias']], { r0: 2, r1: 3, c0: 4, c1: 5 }), [
    { row: 2, col: 4, text: '5 dias' },
    { row: 2, col: 5, text: '5 dias' },
    { row: 3, col: 4, text: '5 dias' },
    { row: 3, col: 5, text: '5 dias' },
  ]);
  // Bloco de 1×2 numa seleção de 2×4: repete nas duas direções.
  assert.deepEqual(
    pasteTargets([['a', 'b']], { r0: 0, r1: 1, c0: 0, c1: 3 }).map(p => p.text),
    ['a', 'b', 'a', 'b', 'a', 'b', 'a', 'b'],
  );
});
test('colagem que não divide a seleção entra inteira a partir do canto de cima à esquerda', () => {
  const block = [
    ['1', '2'],
    ['3', '4'],
  ];
  // Seleção de uma célula: o bloco passa dela (quem chama decide o que fazer com a sobra).
  assert.deepEqual(pasteTargets(block, { r0: 5, r1: 5, c0: 1, c1: 1 }), [
    { row: 5, col: 1, text: '1' },
    { row: 5, col: 2, text: '2' },
    { row: 6, col: 1, text: '3' },
    { row: 6, col: 2, text: '4' },
  ]);
  // Seleção de 3 linhas para um bloco de 2: não repete.
  assert.equal(pasteTargets(block, { r0: 0, r1: 2, c0: 0, c1: 1 }).length, 4);
  assert.deepEqual(pasteTargets([[]], { r0: 0, r1: 0, c0: 0, c1: 0 }), []);
});

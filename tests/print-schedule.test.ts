import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHART_W,
  PRINT_COLUMNS,
  SHEET_H,
  SHEET_W,
  TABLE_W,
  labelSide,
  mixWhite,
  offDayRuns,
  paginate,
  printBar,
  printFileName,
  printScale,
  rowsPerSheet,
} from '../src/modules/medio-prazo/print-layout';

test('impressão do médio prazo: folha A3 deitada com 7 mm de margem', () => {
  // 406 × 282 mm a 96 px por polegada.
  assert.equal(SHEET_W, 1534);
  assert.equal(SHEET_H, 1065);
  // As colunas fixas enchem a tabela, e tabela + Gantt + bordas enchem a folha.
  assert.equal(
    PRINT_COLUMNS.reduce((n, c) => n + c.width, 0),
    TABLE_W,
  );
  assert.equal(TABLE_W + CHART_W + 3, SHEET_W);
  assert.deepEqual(
    PRINT_COLUMNS.map(c => c.label),
    ['Id', 'Nome da tarefa', 'Duração', 'Início', 'Término', '% concl.', 'Recursos'],
  );
});

test('impressão do médio prazo: linhas por folha e paginação', () => {
  assert.equal(rowsPerSheet(false), 41);
  // A faixa do rascunho come uma linha.
  assert.equal(rowsPerSheet(true), 40);
  const rows = Array.from({ length: 95 }, (_, i) => i);
  const sheets = paginate(rows, 41);
  assert.deepEqual(
    sheets.map(s => s.length),
    [41, 41, 13],
  );
  assert.equal(sheets[2][0], 82);
  // Sem linhas, uma folha vazia; tamanho inválido vira uma linha por folha.
  assert.deepEqual(paginate([], 41), [[]]);
  assert.equal(paginate([1, 2, 3], 0).length, 3);
});

test('impressão do médio prazo: régua de três meses com meses e semanas', () => {
  const scale = printScale({ start: '2026-11-01', end: '2027-01-31' }, 920);
  assert.equal(scale.px, 10);
  assert.deepEqual(
    scale.top.map(c => [c.label, c.x, c.width]),
    [
      ['novembro/2026', 0, 300],
      ['dezembro/2026', 300, 310],
      ['janeiro/2027', 610, 310],
    ],
  );
  // Semanas começam na segunda: 02/11/2026 é segunda, 1 dia depois do início.
  assert.equal(scale.bottom[0].label, '02/11');
  assert.equal(scale.bottom[0].x, 10);
  assert.equal(scale.bottom.at(-1)!.label, '25/01');
  // A última semana é cortada no fim da janela (25 a 31/01 = 7 dias).
  assert.equal(scale.bottom.at(-1)!.width, 70);
});

test('impressão do médio prazo: janela de 12 meses vira anos e meses', () => {
  const scale = printScale({ start: '2026-11-01', end: '2027-10-31' }, 841);
  assert.ok(scale.px * 7 < 26);
  assert.deepEqual(
    scale.top.map(c => c.label),
    ['2026', '2027'],
  );
  assert.equal(scale.bottom.length, 12);
  assert.equal(scale.bottom[0].label, 'nov');
  assert.equal(scale.bottom[2].label, 'jan');
});

test('impressão do médio prazo: dias sem trabalho pelo calendário, juntando os seguidos', () => {
  const scale = printScale({ start: '2026-11-01', end: '2026-11-30' }, 300);
  const runs = offDayRuns(scale, { weekdays: [1, 2, 3, 4, 5], holidays: ['2026-11-20'] });
  // Domingo 01/11 sozinho, sábado+domingo 07–08, a sexta 20/11 (feriado) junto com 21–22.
  assert.deepEqual(runs[0], { x: 0, width: 10 });
  assert.deepEqual(runs[1], { x: 60, width: 20 });
  assert.ok(runs.some(r => r.x === 190 && r.width === 30));
  // Escala apertada: sem faixa.
  assert.deepEqual(
    offDayRuns(printScale({ start: '2026-01-01', end: '2026-12-31' }, 841), { weekdays: [1, 2, 3, 4, 5], holidays: [] }),
    [],
  );
});

test('impressão do médio prazo: barra entre as bordas do dia e cortada na janela', () => {
  const scale = printScale({ start: '2026-11-01', end: '2026-11-30' }, 300);
  // 02/11 a 06/11, término às 17:00: da borda esquerda de 02 à direita de 06.
  assert.deepEqual(printBar(scale, 300, { start: '2026-11-02', end: '2026-11-06' }), { left: 10, right: 60 });
  // Término às 08:00 (IT sem defasagem): acaba na borda esquerda do dia.
  assert.deepEqual(printBar(scale, 300, { start: '2026-11-02', end: '2026-11-06', endEdge: 'start' }), { left: 10, right: 50 });
  // Começa antes da janela: cortada na borda.
  assert.deepEqual(printBar(scale, 300, { start: '2026-10-20', end: '2026-11-03' }), { left: 0, right: 30 });
  // Inteira fora da janela: nada.
  assert.equal(printBar(scale, 300, { start: '2026-12-02', end: '2026-12-05' }), null);
});

test('impressão do médio prazo: nome do recurso à direita, ou à esquerda perto da borda', () => {
  assert.equal(labelSide(10, 60, 'Formas Silva', 300), 'right');
  assert.equal(labelSide(200, 290, 'Formas Silva', 300), 'left');
  // Barra da largura toda: fica à direita e a folha corta.
  assert.equal(labelSide(0, 300, 'Formas Silva', 300), 'right');
});

test('impressão do médio prazo: cores claras e nome do arquivo', () => {
  assert.equal(mixWhite('#2a78d6', 28), '#c3d9f4');
  assert.equal(mixWhite('#000000', 100), '#000000');
  assert.equal(mixWhite('#000000', 0), '#ffffff');
  assert.equal(
    printFileName({ code: 'ATM', month: '2026-11', planName: 'Plano de novembro', sameMonthPlans: 1 }),
    'Médio prazo ATM - Novembro 2026',
  );
  assert.equal(
    printFileName({ code: 'ATM', month: '2026-11', planName: 'Revisão 2/B', sameMonthPlans: 2 }),
    'Médio prazo ATM - Novembro 2026 - Revisão 2-B',
  );
  assert.equal(
    printFileName({ code: 'BLT', month: '2026-11', planName: 'x', sameMonthPlans: 1, variantTitle: 'Gantt de legalização' }),
    'Gantt de legalização BLT',
  );
});

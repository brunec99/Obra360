import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assignLanes,
  calendarPreviewText,
  DAY_LABEL_MIN_PX,
  dragShifts,
  filterPredecessorOptions,
  GEOMETRY,
  HEADER_SCALE_PX,
  headerScaleFor,
  lobHeader,
  lobLayout,
  nearestWorkday,
  nonWorkingRuns,
  OFF_DAY_MIN_PX,
  PX_PER_DAY_MAX,
  PX_PER_DAY_MIN,
  pxPerDayFor,
  rowHeightFor,
  ZOOM_PX,
  ZOOM_SCALE_MAX,
  ZOOM_SCALE_MIN,
  ZOOM_SCALE_STEP,
} from '../src/modules/longo-prazo/lob/lob-model';
import type { LobActivity, LobBaseline, LobCalendar, LobLocal, LobService } from '../src/domain/lob';

const NOW = '2026-11-11T12:00:00.000Z';
const local = (id: string, orderIndex: number): LobLocal => ({ id, workId: 'w', name: id, orderIndex, createdAt: NOW, updatedAt: NOW });
const service = (id: string, orderIndex: number): LobService => ({
  id,
  workId: 'w',
  name: id,
  color: '#2a78d6',
  orderIndex,
  createdAt: NOW,
  updatedAt: NOW,
});
const act = (id: string, serviceId: string, localId: string, start: string, durationDays: number): LobActivity => ({
  id,
  workId: 'w',
  serviceId,
  localId,
  start,
  durationDays,
  createdAt: NOW,
  updatedAt: NOW,
});

test('faixas: blocos em sequência ficam numa só; simultâneos repartem a linha', () => {
  // A e B em sequência (B começa no fim exclusivo de A); C, D e E juntos; F sozinho depois.
  const lanes = assignLanes([
    { start: '2026-11-02', end: '2026-11-09', order: 0 },
    { start: '2026-11-09', end: '2026-11-16', order: 1 },
    { start: '2026-11-16', end: '2026-11-23', order: 4 },
    { start: '2026-11-16', end: '2026-11-23', order: 2 },
    { start: '2026-11-16', end: '2026-11-23', order: 3 },
    { start: '2026-11-30', end: '2026-12-07', order: 5 },
  ]);
  assert.deepEqual(lanes, [
    { lane: 0, lanes: 1 },
    { lane: 0, lanes: 1 },
    { lane: 2, lanes: 3 },
    { lane: 0, lanes: 3 },
    { lane: 1, lanes: 3 },
    { lane: 0, lanes: 1 },
  ]);
});

test('faixas: sobreposição em cadeia reaproveita a faixa que vagou', () => {
  // Grua longa; Cremalheira 1 no meio; Elevador começa quando a Cremalheira acaba e volta à faixa dela.
  const lanes = assignLanes([
    { start: '2026-01-05', end: '2026-12-28', order: 0 },
    { start: '2026-03-02', end: '2026-06-01', order: 1 },
    { start: '2026-06-01', end: '2026-08-03', order: 2 },
  ]);
  assert.deepEqual(lanes, [
    { lane: 0, lanes: 2 },
    { lane: 1, lanes: 2 },
    { lane: 1, lanes: 2 },
  ]);
});

test('layout: linha com simultâneos cresce e os blocos não se cobrem; as demais seguem com 30 px', () => {
  const layout = lobLayout({
    data: {
      locals: [local('L1', 0), local('L2', 1)],
      services: [service('ALV', 0), service('ELE', 1), service('HID', 2), service('ACA', 3)],
      activities: [
        act('a1', 'ALV', 'L1', '2026-11-02', 5),
        act('a2', 'ELE', 'L1', '2026-11-09', 5),
        act('a3', 'HID', 'L1', '2026-11-09', 5),
        act('a4', 'ACA', 'L1', '2026-11-09', 5),
        act('b1', 'ALV', 'L2', '2026-11-09', 5),
      ],
    },
    zoom: 'semana',
    availableWidth: 1200,
    today: '2026-11-11',
  });
  const [l1, l2] = layout.rows;
  assert.equal(l1.lanes, 3);
  assert.equal(l1.height, rowHeightFor(3));
  assert.ok(l1.height > GEOMETRY.row);
  assert.deepEqual([l2.lanes, l2.height], [1, GEOMETRY.row]);
  // L2 (índice 1) fica em cima, encostada no topo; L1 logo abaixo.
  assert.equal(l2.y, GEOMETRY.top);
  assert.equal(l1.y, GEOMETRY.top + GEOMETRY.row);
  assert.equal(layout.innerH, l1.height + l2.height);
  const block = (id: string) => layout.blockById.get(id)!;
  // O bloco sem sobreposição ocupa a linha inteira; os três simultâneos, uma faixa cada, sem se cobrir.
  assert.equal(block('a1').h, l1.height - 2 * GEOMETRY.blockPad);
  const lanes = ['a2', 'a3', 'a4'].map(block).sort((a, b) => a.y - b.y);
  for (const b of lanes) assert.ok(b.h >= GEOMETRY.lane - 0.01);
  for (let i = 1; i < lanes.length; i++) assert.ok(lanes[i].y >= lanes[i - 1].y + lanes[i - 1].h);
  assert.ok(lanes[2].y + lanes[2].h <= l1.y + l1.height - GEOMETRY.blockPad + 0.01);
  // Ordem das faixas pela ordem dos serviços: Elétrica em cima.
  assert.deepEqual(
    lanes.map(b => b.service.id),
    ['ELE', 'HID', 'ACA'],
  );
});

test('layout: serviço escondido não ocupa faixa', () => {
  const layout = lobLayout({
    data: {
      locals: [local('L1', 0)],
      services: [service('ELE', 0), service('HID', 1)],
      activities: [act('a', 'ELE', 'L1', '2026-11-09', 5), act('b', 'HID', 'L1', '2026-11-09', 5)],
    },
    zoom: 'semana',
    availableWidth: 1200,
    today: '2026-11-11',
    hiddenServiceIds: new Set(['HID']),
  });
  assert.deepEqual([layout.rows[0].lanes, layout.rows[0].height], [1, GEOMETRY.row]);
});

// ─── Zoom ───────────────────────────────────────────────────────────────────────

test('zoom: semana, mês e trimestre têm escalas fixas e bem diferentes entre si', () => {
  const days = 730; // obra de 2 anos
  const [semana, mes, trimestre] = (['semana', 'mes', 'trimestre'] as const).map(zoom => pxPerDayFor(zoom, days, 1200));
  assert.deepEqual([semana, mes, trimestre], [ZOOM_PX.semana, ZOOM_PX.mes, ZOOM_PX.trimestre]);
  // Cada nível mostra pelo menos o triplo do tempo do anterior: a troca não pode só "comprimir um pouco".
  assert.ok(semana / mes >= 3);
  assert.ok(mes / trimestre >= 3);
  // Escala fixa: não depende da largura nem do tamanho da obra.
  assert.equal(pxPerDayFor('mes', 90, 2400), ZOOM_PX.mes);
});

test("zoom 'obra': encaixa a obra inteira na largura, dentro dos limites", () => {
  const inner = 1200 - GEOMETRY.left - GEOMETRY.right - 2;
  const px = pxPerDayFor('obra', 730, 1200);
  assert.equal(px, inner / 730);
  assert.ok(730 * px <= inner);
  // Obra curta não estica além do máximo; obra enorme não some abaixo do mínimo.
  assert.equal(pxPerDayFor('obra', 30, 1200), ZOOM_PX.obraMax);
  assert.equal(pxPerDayFor('obra', 20000, 1200), ZOOM_PX.obraMin);
  const layout = lobLayout({
    data: { locals: [local('L1', 0)], services: [service('ALV', 0)], activities: [act('a', 'ALV', 'L1', '2026-01-05', 500)] },
    zoom: 'obra',
    availableWidth: 1200,
    today: '2026-11-11',
  });
  assert.ok(layout.width <= 1200);
  assert.equal(layout.header.scale, 'quarter');
});

test('zoomScale: multiplica a escala do nível e respeita os limites', () => {
  assert.equal(pxPerDayFor('mes', 730, 1200, 2), ZOOM_PX.mes * 2);
  assert.equal(pxPerDayFor('trimestre', 730, 1200, 0.5), ZOOM_PX.trimestre * 0.5);
  assert.equal(pxPerDayFor('obra', 730, 1200, 2), pxPerDayFor('obra', 730, 1200) * 2);
  // Sem ajuste, ou com valor inválido, vale a escala do nível.
  for (const bad of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(pxPerDayFor('mes', 730, 1200, bad), ZOOM_PX.mes);
  // Nos extremos do ajuste fino a escala efetiva fica dentro do intervalo seguro.
  assert.equal(pxPerDayFor('semana', 730, 1200, ZOOM_SCALE_MAX), PX_PER_DAY_MAX);
  assert.equal(pxPerDayFor('obra', 20000, 1200, ZOOM_SCALE_MIN), PX_PER_DAY_MIN);
  for (const zoom of ['semana', 'mes', 'trimestre', 'obra'] as const)
    for (const scale of [ZOOM_SCALE_MIN, 1, ZOOM_SCALE_MAX]) {
      const px = pxPerDayFor(zoom, 730, 1200, scale);
      assert.ok(px >= PX_PER_DAY_MIN && px <= PX_PER_DAY_MAX);
    }
  assert.ok(ZOOM_SCALE_MIN < 1 && ZOOM_SCALE_MAX > 1 && ZOOM_SCALE_STEP > 1);
  // O layout usa a escala efetiva.
  const input = {
    data: { locals: [local('L1', 0)], services: [service('ALV', 0)], activities: [act('a', 'ALV', 'L1', '2026-11-02', 5)] },
    zoom: 'mes' as const,
    availableWidth: 1200,
    today: '2026-11-11',
  };
  const base = lobLayout(input),
    doubled = lobLayout({ ...input, zoomScale: 2 });
  assert.equal(doubled.pxPerDay, base.pxPerDay * 2);
  assert.equal(doubled.innerW, base.innerW * 2);
});

// ─── Cabeçalho do tempo ─────────────────────────────────────────────────────────

test('cabeçalho: a escala efetiva escolhe semanas, meses ou trimestres', () => {
  assert.equal(headerScaleFor(ZOOM_PX.semana), 'week');
  assert.equal(headerScaleFor(ZOOM_PX.mes), 'month');
  assert.equal(headerScaleFor(ZOOM_PX.trimestre), 'quarter');
  assert.equal(headerScaleFor(HEADER_SCALE_PX.week), 'week');
  assert.equal(headerScaleFor(HEADER_SCALE_PX.month), 'month');
  assert.equal(headerScaleFor(HEADER_SCALE_PX.month - 0.01), 'quarter');
  // O ajuste fino atravessa os níveis: semana bem afastada vira cabeçalho de meses.
  assert.equal(headerScaleFor(pxPerDayFor('semana', 730, 1200, ZOOM_SCALE_MIN)), 'month');
});

test('cabeçalho de semanas: meses por extenso em cima, dia da segunda-feira embaixo', () => {
  // 21/10/2026 é quarta-feira; a janela vai até 15/12 (exclusivo).
  const h = lobHeader('2026-10-21', '2026-12-15', 16, 100);
  assert.equal(h.scale, 'week');
  // Outubro aparece cortado (11 dias = 176 px), novembro inteiro (480 px), dezembro até o dia 14.
  assert.deepEqual(h.top, [
    { x: 100, w: 176, label: 'outubro 2026', strong: false },
    { x: 276, w: 480, label: 'novembro 2026', strong: false },
    { x: 756, w: 224, label: 'dezembro 2026', strong: false },
  ]);
  // A semana cortada pela borda esquerda fica sem número; as outras levam o dia da segunda. A última
  // (só o dia 14, 16 px) é estreita demais para o rótulo.
  assert.deepEqual(
    h.bottom.map(c => c.label),
    ['', '26', '02', '09', '16', '23', '30', '07', ''],
  );
  assert.deepEqual([h.bottom[0].x, h.bottom[0].w], [100, 5 * 16]);
  assert.deepEqual([h.bottom[1].x, h.bottom[1].w], [180, 7 * 16]);
  // A última semana é recortada no fim da janela.
  const last = h.bottom.at(-1)!;
  assert.equal(last.x + last.w, 100 + 55 * 16);
  // Grade: forte no dia 1 de cada mês, leve nas segundas-feiras.
  assert.deepEqual(
    h.lines.filter(l => l.strong).map(l => l.x),
    [276, 756],
  );
  assert.equal(h.lines.filter(l => !l.strong).length, 8);
  assert.ok(h.lines.every((l, i) => i === 0 || l.x > h.lines[i - 1].x));
  assert.deepEqual(h.ticks, []);
});

test('cabeçalho de semanas: mês que começa numa segunda-feira ganha uma linha só, a forte', () => {
  // 01/06/2026 é segunda-feira.
  const h = lobHeader('2026-05-28', '2026-06-15', 10, 0);
  assert.deepEqual(h.lines, [
    { x: 40, strong: true },
    { x: 110, strong: false },
  ]);
  // Célula estreita (4 dias de maio = 40 px): o nome do mês encolhe até caber.
  assert.deepEqual(
    h.top.map(c => c.label),
    ['mai', 'junho 2026'],
  );
});

test('cabeçalho de meses: anos em cima, meses embaixo, com "jan/27" na virada', () => {
  const h = lobHeader('2026-10-21', '2027-03-11', 4.5, 100);
  assert.equal(h.scale, 'month');
  assert.deepEqual(
    h.top.map(c => [c.label, c.x]),
    [
      ['2026', 100],
      ['2027', 100 + 72 * 4.5],
    ],
  );
  assert.deepEqual(
    h.bottom.map(c => c.label),
    ['out', 'nov', 'dez', 'jan/27', 'fev', 'mar'],
  );
  assert.deepEqual(
    h.bottom.map(c => !!c.strong),
    [false, false, false, true, false, false],
  );
  // Novembro: 30 dias a 4,5 px, a partir de 1º/11 (11 dias depois do início).
  assert.deepEqual([h.bottom[1].x, h.bottom[1].w], [100 + 11 * 4.5, 135]);
  // Grade por mês, forte só em janeiro; traço curto em cada segunda-feira.
  assert.deepEqual(
    h.lines.map(l => l.strong),
    [false, false, true, false, false],
  );
  assert.equal(h.ticks[0], 100 + 5 * 4.5);
  assert.equal(h.ticks.length, 20);
  // As células cobrem a janela inteira, sem buraco nem sobra.
  const right = 100 + Math.round(141 * 4.5);
  for (const band of [h.top, h.bottom]) {
    assert.equal(band[0].x, 100);
    assert.ok(Math.abs(band.at(-1)!.x + band.at(-1)!.w - right) < 0.02);
    for (let i = 1; i < band.length; i++) assert.ok(Math.abs(band[i].x - (band[i - 1].x + band[i - 1].w)) < 0.02);
  }
});

test('cabeçalho de trimestres: anos em cima, T1…T4 embaixo, grade forte por trimestre', () => {
  const h = lobHeader('2026-08-10', '2027-08-10', 1.5, 100);
  assert.equal(h.scale, 'quarter');
  assert.deepEqual(
    h.top.map(c => c.label),
    ['2026', '2027'],
  );
  assert.deepEqual(
    h.bottom.map(c => c.label),
    ['T3', 'T4', 'T1/27', 'T2', 'T3'],
  );
  // Uma linha por mês; forte em outubro, janeiro, abril e julho.
  assert.equal(h.lines.length, 12);
  assert.deepEqual(
    h.lines.map(l => l.strong),
    [false, true, false, false, true, false, false, true, false, false, true, false],
  );
  assert.deepEqual(h.ticks, []);
});

test('cabeçalho de trimestres bem afastado: rótulo que não cabe some, a célula fica', () => {
  // 0,3 px/dia: o trimestre tem ~27 px ("T1/27" não cabe, "T1" cabe); o resto de 2026 tem 12 px e
  // fica sem rótulo; o pedaço de 2028 (31,5 px) só comporta o ano abreviado.
  const h = lobHeader('2026-11-21', '2028-04-15', PX_PER_DAY_MIN, 0);
  assert.deepEqual(
    h.top.map(c => c.label),
    ['', '2027', "'28"],
  );
  assert.deepEqual(
    h.bottom.map(c => c.label),
    ['', 'T1', 'T2', 'T3', 'T4', 'T1', ''],
  );
  assert.equal(h.top.length + h.bottom.length, 10);
});

test('layout: expõe o cabeçalho da escala efetiva e reserva as duas faixas no topo', () => {
  const input = {
    data: { locals: [local('L1', 0)], services: [service('ALV', 0)], activities: [act('a', 'ALV', 'L1', '2026-11-02', 5)] },
    availableWidth: 1200,
    today: '2026-11-11',
  };
  assert.equal(GEOMETRY.top, 2 * GEOMETRY.band);
  const scales = (['semana', 'mes', 'trimestre'] as const).map(zoom => lobLayout({ ...input, zoom }).header.scale);
  assert.deepEqual(scales, ['week', 'month', 'quarter']);
  const layout = lobLayout({ ...input, zoom: 'semana' });
  assert.deepEqual(layout.header, lobHeader(layout.start, layout.end, layout.pxPerDay));
  assert.equal(layout.header.top[0].x, layout.left);
  const last = layout.header.bottom.at(-1)!;
  assert.ok(Math.abs(last.x + last.w - (layout.left + layout.innerW)) < 0.02);
  // A semana aproximada o bastante continua com cabeçalho de semanas; afastada, passa a meses.
  assert.equal(lobLayout({ ...input, zoom: 'semana', zoomScale: 0.5 }).header.scale, 'month');
  assert.equal(lobLayout({ ...input, zoom: 'trimestre', zoomScale: 2 }).header.scale, 'month');
});

// ─── Dias sem trabalho (calendário da obra) ─────────────────────────────────────

/** Segunda a sexta, com a quarta 04/11/2026 e a sexta 20/11/2026 sem trabalho. */
const HOLIDAYS: LobCalendar = { weekdays: [1, 2, 3, 4, 5], holidays: ['2026-11-04', '2026-11-20'] };
/** Um bloco de 5 dias a partir da segunda 02/11, na janela de 02/11 a 29/11 (quatro semanas inteiras). */
const november = (calendar?: LobCalendar) => ({
  data: {
    locals: [local('L1', 0)],
    services: [service('ALV', 0)],
    activities: [act('a', 'ALV', 'L1', '2026-11-02', 5)],
    ...(calendar ? { calendar } : {}),
  },
  availableWidth: 1200,
  today: '2026-11-11',
  range: { start: '2026-11-02', end: '2026-11-29' },
});

test('nonWorkingRuns: dias seguidos sem trabalho viram uma sequência só; o feriado na sexta emenda com o fim de semana', () => {
  assert.deepEqual(nonWorkingRuns('2026-11-02', '2026-11-30'), [
    { start: '2026-11-07', days: 2 },
    { start: '2026-11-14', days: 2 },
    { start: '2026-11-21', days: 2 },
    { start: '2026-11-28', days: 2 },
  ]);
  assert.deepEqual(nonWorkingRuns('2026-11-02', '2026-11-30', HOLIDAYS), [
    { start: '2026-11-04', days: 1 },
    { start: '2026-11-07', days: 2 },
    { start: '2026-11-14', days: 2 },
    { start: '2026-11-20', days: 3 },
    { start: '2026-11-28', days: 2 },
  ]);
  // Sábado trabalhado: só o domingo. A sequência é recortada nas bordas da janela.
  assert.deepEqual(nonWorkingRuns('2026-11-08', '2026-11-15', { weekdays: [1, 2, 3, 4, 5, 6], holidays: [] }), [
    { start: '2026-11-08', days: 1 },
  ]);
  assert.deepEqual(nonWorkingRuns('2026-11-08', '2026-11-15'), [
    { start: '2026-11-08', days: 1 },
    { start: '2026-11-14', days: 1 },
  ]);
  assert.deepEqual(nonWorkingRuns('2026-11-09', '2026-11-14'), []);
});

test('layout: faixas dos dias sem trabalho na Semana e no Mês, com a largura dos dias; nada quando o dia fica estreito', () => {
  assert.equal(OFF_DAY_MIN_PX, 2.5);
  const week = lobLayout({ ...november(), zoom: 'semana' });
  // 16 px por dia: o sábado 07/11 fica 5 dias depois do início da janela e a faixa cobre sábado e domingo.
  assert.deepEqual(
    week.offRuns.map(r => [r.start, r.days, r.x, r.w]),
    [
      ['2026-11-07', 2, GEOMETRY.left + 5 * 16, 32],
      ['2026-11-14', 2, GEOMETRY.left + 12 * 16, 32],
      ['2026-11-21', 2, GEOMETRY.left + 19 * 16, 32],
      ['2026-11-28', 2, GEOMETRY.left + 26 * 16, 32],
    ],
  );
  // Com o calendário da obra: a quarta parada é uma faixa de um dia e a sexta emenda com o fim de semana.
  const holidays = lobLayout({ ...november(HOLIDAYS), zoom: 'semana' });
  assert.deepEqual(
    holidays.offRuns.map(r => [r.start, r.days, r.x, r.w]),
    [
      ['2026-11-04', 1, GEOMETRY.left + 2 * 16, 16],
      ['2026-11-07', 2, GEOMETRY.left + 5 * 16, 32],
      ['2026-11-14', 2, GEOMETRY.left + 12 * 16, 32],
      ['2026-11-20', 3, GEOMETRY.left + 18 * 16, 48],
      ['2026-11-28', 2, GEOMETRY.left + 26 * 16, 32],
    ],
  );
  // Mês (4,5 px por dia): a faixa do fim de semana tem 9 px.
  const month = lobLayout({ ...november(), zoom: 'mes' });
  assert.deepEqual([month.offRuns.length, month.offRuns[0].x, month.offRuns[0].w], [4, GEOMETRY.left + 5 * 4.5, 9]);
  // Abaixo do limiar (fim de semana com menos de 5 px) não desenha: viraria ruído.
  assert.deepEqual(lobLayout({ ...november(), zoom: 'trimestre' }).offRuns, []);
  assert.deepEqual(lobLayout({ ...november(), zoom: 'mes', zoomScale: 0.5 }).offRuns, []);
  assert.equal(lobLayout({ ...november(), zoom: 'mes', zoomScale: 0.6 }).offRuns.length, 4);
  // Todas as faixas ficam dentro da área do gráfico.
  for (const run of holidays.offRuns) assert.ok(run.x >= holidays.left && run.x + run.w <= holidays.left + holidays.innerW);
});

test('cabeçalho: com o dia largo (Semana) cada dia ganha o número, e o dia sem trabalho vem marcado', () => {
  assert.ok(ZOOM_PX.semana >= DAY_LABEL_MIN_PX);
  const days = lobLayout({ ...november(HOLIDAYS), zoom: 'semana' }).header.days;
  assert.equal(days.length, 28);
  assert.deepEqual(days[0], { x: GEOMETRY.left, w: 16, label: '02', off: false });
  assert.deepEqual(
    days.filter(d => d.off).map(d => d.label),
    ['04', '07', '08', '14', '15', '20', '21', '22', '28', '29'],
  );
  // Sem calendário, só os fins de semana.
  assert.deepEqual(
    lobHeader('2026-11-02', '2026-11-16', 16, 0)
      .days.filter(d => d.off)
      .map(d => d.label),
    ['07', '08', '14', '15'],
  );
  // Dia estreito demais para o número (semana afastada, mês, trimestre): a faixa segue com o dia da segunda-feira.
  assert.deepEqual(lobLayout({ ...november(), zoom: 'semana', zoomScale: 0.75 }).header.days, []);
  assert.equal(lobLayout({ ...november(), zoom: 'semana', zoomScale: 0.75 }).header.scale, 'week');
  assert.deepEqual(lobLayout({ ...november(), zoom: 'mes' }).header.days, []);
  assert.deepEqual(lobHeader('2026-11-02', '2026-11-16', DAY_LABEL_MIN_PX - 0.5, 0).days, []);
});

test('nearestWorkday e dateAtX: o arrasto nunca solta o bloco num dia sem trabalho do calendário da obra', () => {
  // Sem calendário: sábado volta para sexta, domingo avança para segunda.
  assert.deepEqual(
    ['2026-11-06', '2026-11-07', '2026-11-08'].map(d => nearestWorkday(d)),
    ['2026-11-06', '2026-11-06', '2026-11-09'],
  );
  // Feriado no meio da semana: empate entre a véspera e o dia seguinte, vale o seguinte.
  assert.equal(nearestWorkday('2026-11-04', HOLIDAYS), '2026-11-05');
  // Sexta parada emendada com o fim de semana: a sexta volta para quinta; o sábado fica a dois dias da
  // quinta e da segunda (empate: vale a segunda); o domingo vai à segunda.
  assert.deepEqual(
    ['2026-11-20', '2026-11-21', '2026-11-22'].map(d => nearestWorkday(d, HOLIDAYS)),
    ['2026-11-19', '2026-11-23', '2026-11-23'],
  );
  // Sábado trabalhado é destino válido.
  assert.equal(nearestWorkday('2026-11-07', { weekdays: [1, 2, 3, 4, 5, 6], holidays: [] }), '2026-11-07');
  const layout = lobLayout({ ...november(HOLIDAYS), zoom: 'semana' });
  assert.equal(layout.dateAtX(layout.xOf('2026-11-04')), '2026-11-05');
  assert.equal(layout.dateAtX(layout.xOf('2026-11-20')), '2026-11-19');
  assert.equal(layout.dateAtX(layout.xOf('2026-11-10')), '2026-11-10');
});

test('layout: o bloco e o fantasma da linha de base seguem o calendário da obra', () => {
  // Com a quarta 04/11 parada, os 5 dias úteis vão de 02/11 a 09/11 (fim exclusivo em 10/11).
  const baseline = (finish?: string): LobBaseline => ({
    id: 'b',
    workId: 'w',
    name: 'Antes',
    automatic: true,
    createdBy: 'u',
    createdAt: NOW,
    snapshot: [{ activityId: 'a', serviceId: 'ALV', localId: 'L1', start: '2026-11-02', durationDays: 5, ...(finish ? { finish } : {}) }],
  });
  const layout = lobLayout({ ...november(HOLIDAYS), zoom: 'semana', baseline: baseline('2026-11-06') });
  const block = layout.blockById.get('a')!;
  assert.deepEqual([block.finish, block.end, block.w], ['2026-11-09', '2026-11-10', 8 * 16 - GEOMETRY.blockGap]);
  // A foto foi tirada antes do feriado: mesmo início e duração, mas terminava na sexta 06/11. O fantasma aparece,
  // desenhado até o fim do último dia trabalhado (a sexta), sem cobrir o sábado e o domingo.
  assert.deepEqual(
    layout.ghosts.map(g => [g.activityId, g.start, g.finish, g.w]),
    [['a', '2026-11-02', '2026-11-06', 5 * 16 - GEOMETRY.blockGap]],
  );
  // Foto igual ao bloco (ou antiga, sem término gravado) não desenha fantasma.
  assert.deepEqual(lobLayout({ ...november(HOLIDAYS), zoom: 'semana', baseline: baseline('2026-11-09') }).ghosts, []);
  assert.deepEqual(lobLayout({ ...november(HOLIDAYS), zoom: 'semana', baseline: baseline() }).ghosts, []);
  assert.deepEqual(lobLayout({ ...november(), zoom: 'semana', baseline: baseline('2026-11-06') }).ghosts, []);
});
test('layout: o bloco é desenhado até o fim do último dia trabalhado e não cobre o fim de semana seguinte', () => {
  // 5 dias úteis a partir da segunda 02/11: termina na sexta 06/11; o fim exclusivo é a segunda 09/11.
  const layout = lobLayout({ ...november(), zoom: 'semana' });
  const block = layout.blockById.get('a')!;
  assert.deepEqual([block.finish, block.end, block.w], ['2026-11-06', '2026-11-09', 5 * 16 - GEOMETRY.blockGap]);
  // A faixa do sábado e do domingo fica livre, logo depois do bloco.
  const weekend = layout.offRuns.find(run => run.start === '2026-11-07')!;
  assert.ok(block.x + block.w <= weekend.x);
  // No arrasto, a prévia usa a mesma largura: levado para a quarta 04/11, o bloco atravessa um fim de
  // semana (04/11 a 10/11) e ocupa 7 dias corridos.
  const moved = dragShifts(layout, [{ ...block.activity, start: '2026-11-04' }]);
  assert.deepEqual(moved.get(block.local.id)?.get('a'), { dx: 2 * 16, w: 7 * 16 - GEOMETRY.blockGap, start: '2026-11-04' });
});

test('calendarPreviewText: a frase da prévia da mudança de calendário', () => {
  const preview = { changedBlocks: 12, movedStarts: 9, finishBefore: '2027-03-12', finishAfter: '2027-03-19' };
  assert.equal(calendarPreviewText(preview, 40), '12 blocos mudam de data; o término da obra passa de 12/03/2027 para 19/03/2027.');
  assert.equal(
    calendarPreviewText({ ...preview, changedBlocks: 1, finishAfter: '2027-03-12' }, 40),
    '1 bloco muda de data; o término da obra continua em 12/03/2027.',
  );
  assert.equal(calendarPreviewText({ ...preview, changedBlocks: 0 }, 40), 'Nenhum bloco muda de data com este calendário.');
  assert.match(calendarPreviewText({ changedBlocks: 0, movedStarts: 0 }, 0), /ainda não tem blocos/);
});

test('busca de predecessora: ignora acento e maiúscula, e cada palavra precisa aparecer', () => {
  const options = [
    { id: 'a', label: 'Alvenaria · 12º pavimento' },
    { id: 'b', label: 'Alvenaria · 2º pavimento' },
    { id: 'c', label: 'Instalações elétricas · 12º pavimento' },
    { id: 'd', label: 'Forro · Térreo' },
  ];
  const ids = (query: string) => filterPredecessorOptions(options, query).map(o => o.id);
  assert.deepEqual(ids(''), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids('   '), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids('ALV'), ['a', 'b']);
  assert.deepEqual(ids('instalacoes eletricas'), ['c']);
  assert.deepEqual(ids('12 alv'), ['a']);
  assert.deepEqual(ids('terreo'), ['d']);
  assert.deepEqual(ids('pintura'), []);
});

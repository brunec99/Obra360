import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAILY_LIMITS,
  DAILY_SENT_MESSAGE,
  dailyPhotoPaths,
  emptyDailyContent,
  type DailyContent,
  type DailyCrew,
  type DailyPhoto,
  type DailyReport,
  type DailyReportCommand,
  type DailyReportPlanData,
} from '../src/domain/daily-report';
import type { HeadcountEntry } from '../src/domain/headcount';
import {
  canAdminDailyReport,
  canWriteDailyReport,
  crewsOfDay,
  dailyReportCommandTarget,
  emptyDailyMutation,
  lastCrewsBefore,
  markDailyReportError,
  markDailyReportSent,
  parseDailyReportCommand,
  planDailyReportCommand,
  reopenDailyReport,
  type DailyReportContext,
} from '../src/application/use-cases/daily-report-commands';

/** Diário de Obra (2.4), 24/11/2026: regras dos comandos, acerto do histograma e marcações do envio. */

const W = 'obra-1';
const DAY = '2026-11-23';
const NOW = '2026-11-24T15:00:00.000Z';
let seq = 0;
const ctx = (over: Partial<DailyReportContext> = {}): DailyReportContext => ({
  actorId: 'u-2',
  now: NOW,
  today: '2026-11-24',
  newId: () => `id-${++seq}`,
  ...over,
});

const content = (over: Partial<DailyContent> = {}): DailyContent => ({ ...emptyDailyContent(), ...over });
const report = (over: Partial<DailyReport> = {}): DailyReport => ({
  ...emptyDailyContent(),
  id: 'r-1',
  workId: W,
  date: DAY,
  status: 'draft',
  siengeBuildingId: null,
  siengeId: null,
  sentAt: null,
  sentBy: null,
  lastError: '',
  version: 3,
  createdBy: 'u-1',
  createdAt: '2026-11-23T20:00:00.000Z',
  updatedBy: 'u-1',
  updatedAt: '2026-11-23T20:00:00.000Z',
  ...over,
});
const photo = (id: string, over: Partial<DailyPhoto> = {}): DailyPhoto => ({
  id,
  reportId: 'r-1',
  workId: W,
  ...dailyPhotoPaths(W, 'r-1', id),
  description: 'Concretagem da laje',
  localId: 'loc-1',
  showInReports: true,
  siengeStatus: 'pending',
  siengeError: '',
  createdBy: 'u-1',
  createdAt: NOW,
  ...over,
});
const entry = (id: string, workedOn: string, company: string, role: string, quantity: number, over: Partial<HeadcountEntry> = {}) => ({
  id,
  workId: W,
  workedOn,
  company,
  role,
  quantity,
  note: '',
  origin: 'app' as const,
  createdBy: 'u-1',
  createdAt: NOW,
  updatedAt: '2026-11-23T20:00:00.000Z',
  ...over,
});
const HEADCOUNT: HeadcountEntry[] = [
  entry('h-1', '2026-11-20', 'AWA', 'Carpinteiro', 6),
  entry('h-2', '2026-11-20', 'ATR', 'Engenheiro', 1),
  entry('h-3', DAY, 'AWA', 'Carpinteiro', 5, { note: 'faltou 1', origin: 'planilha' }),
  entry('h-4', DAY, 'AWA', 'Servente', 2),
  entry('h-5', DAY, 'Hidrotec', 'Encanador', 4),
];
const data = (over: Partial<DailyReportPlanData> = {}): DailyReportPlanData => ({
  report: null,
  photos: [],
  headcount: HEADCOUNT.map(e => ({ ...e })),
  localIds: ['loc-1', 'loc-2'],
  ...over,
});
const save = (over: Partial<Extract<DailyReportCommand, { type: 'save_report' }>> = {}): DailyReportCommand => ({
  type: 'save_report',
  workId: W,
  id: 'r-1',
  date: DAY,
  baseVersion: null,
  content: content(),
  crews: null,
  ...over,
});
const plan = (d: DailyReportPlanData, command: DailyReportCommand, c = ctx()) => planDailyReportCommand(d, command, c, W);
const refuses = (fn: () => unknown, message: RegExp) => assert.throws(fn, message);

test('parse: forma de cada comando e alvo', () => {
  const body = { type: 'save_report', workId: W, id: 'r-1', date: DAY, baseVersion: null, content: content(), crews: null, extra: 1 };
  assert.deepEqual(parseDailyReportCommand(body), save());
  assert.deepEqual(
    parseDailyReportCommand({ ...body, baseVersion: 2, crews: [{ company: 'AWA', role: 'Servente', quantity: 2, x: 1 }] }),
    save({ baseVersion: 2, crews: [{ company: 'AWA', role: 'Servente', quantity: 2 }] }),
  );
  refuses(() => parseDailyReportCommand({ ...body, baseVersion: '2' }), /baseVersion/);
  refuses(() => parseDailyReportCommand({ ...body, content: null }), /content/);
  refuses(() => parseDailyReportCommand({ ...body, content: { ...content(), tasks: 'x' } }), /content\.tasks/);
  refuses(() => parseDailyReportCommand({ ...body, content: { ...content(), rainfall: '3' } }), /rainfall/);
  refuses(() => parseDailyReportCommand({ ...body, crews: [{ company: 'AWA', role: 'Servente', quantity: '2' }] }), /crews\.quantity/);
  refuses(() => parseDailyReportCommand({ ...body, crews: undefined }), /crews/);
  refuses(
    () => parseDailyReportCommand({ type: 'add_photo', id: 'p', reportId: 'r-1', description: 'x', localId: null, showInReports: 'sim' }),
    /showInReports/,
  );
  refuses(() => parseDailyReportCommand({ type: 'link_local', workId: W, localId: 'loc-1', siengeSiteId: '7' }), /siengeSiteId/);
  refuses(() => parseDailyReportCommand({ type: 'outro' }), /desconhecido/);
  refuses(() => parseDailyReportCommand([]), /inválido/);

  assert.deepEqual(dailyReportCommandTarget(save()), { workId: W });
  assert.deepEqual(dailyReportCommandTarget({ type: 'link_local', workId: W, localId: 'loc-1', siengeSiteId: 7 }), { workId: W });
  assert.deepEqual(dailyReportCommandTarget({ type: 'delete_report', id: 'r-1' }), { reportId: 'r-1' });
  assert.deepEqual(
    dailyReportCommandTarget({ type: 'add_photo', id: 'p-1', reportId: 'r-1', description: 'x', localId: null, showInReports: false }),
    { reportId: 'r-1' },
  );
  assert.deepEqual(dailyReportCommandTarget({ type: 'update_photo', id: 'p-1', description: 'x', localId: null, showInReports: false }), {
    photoId: 'p-1',
  });
  assert.deepEqual(dailyReportCommandTarget({ type: 'delete_photo', id: 'p-1' }), { photoId: 'p-1' });
  assert.deepEqual(dailyReportCommandTarget({ type: 'link_company', company: 'AWA', crewTypeId: 3 }), { global: true });
  assert.deepEqual(dailyReportCommandTarget({ type: 'set_sienge_user', code: 'X' }), { global: true });
});

test('quem grava: todos menos consulta; reabrir é só do administrador', () => {
  assert.ok(canWriteDailyReport({ role: 'planner' }));
  assert.ok(canWriteDailyReport({ role: 'admin' }));
  assert.ok(!canWriteDailyReport({ role: 'viewer' }));
  assert.ok(!canWriteDailyReport(null));
  assert.ok(canAdminDailyReport({ role: 'admin' }));
  assert.ok(!canAdminDailyReport({ role: 'planner' }));
  assert.ok(!canAdminDailyReport(undefined));
});

test('save_report cria o rascunho do dia, normalizado', () => {
  const m = plan(
    data(),
    save({
      content: content({
        shifts: [
          { key: 'afternoon', startTime: '13:00', finishTime: '17:00', weather: 'light_rain' },
          { key: 'morning', startTime: '07:00', finishTime: '12:00', weather: 'fine' },
        ],
        rainfall: 12.345,
        notes: '  Dia produtivo.\nSem paradas.  ',
        tasks: [
          {
            id: 't-1',
            description: '  Alvenaria do 3º  ',
            quantity: 12.123456,
            unit: 'm2',
            localId: 'loc-1',
            notes: ' ok ',
            commitmentId: 'c-9',
          },
          { id: 't-2', description: 'Limpeza', quantity: null, unit: '', localId: null, notes: '', commitmentId: '  ' },
        ],
        events: [{ id: 'e-1', typeId: 4, typeLabel: ' Visita ', description: ' Visita do cliente ' }],
        equipments: [{ id: 'q-1', typeId: 2, typeLabel: ' Betoneira ', quantity: 2, status: 'idle' }],
      }),
    }),
  );
  const saved = m.saveReport!;
  assert.equal(m.expectVersion, null);
  assert.equal(m.headcount, null);
  assert.deepEqual(
    [saved.id, saved.workId, saved.date, saved.status, saved.version, saved.createdBy, saved.updatedBy, saved.createdAt, saved.lastError],
    ['r-1', W, DAY, 'draft', 1, 'u-2', 'u-2', NOW, ''],
  );
  assert.deepEqual([saved.siengeBuildingId, saved.siengeId, saved.sentAt, saved.sentBy], [null, null, null, null]);
  assert.deepEqual(
    saved.shifts.map(s => s.key),
    ['morning', 'afternoon'],
    'manhã antes da tarde',
  );
  assert.equal(saved.rainfall, 12.35);
  assert.equal(saved.notes, 'Dia produtivo.\nSem paradas.');
  assert.deepEqual(saved.tasks[0], {
    id: 't-1',
    description: 'Alvenaria do 3º',
    quantity: 12.1235,
    unit: 'm2',
    localId: 'loc-1',
    notes: 'ok',
    commitmentId: 'c-9',
  });
  assert.equal(saved.tasks[1].commitmentId, null);
  assert.deepEqual(saved.events[0], { id: 'e-1', typeId: 4, typeLabel: 'Visita', description: 'Visita do cliente' });
  assert.deepEqual(saved.equipments[0], { id: 'q-1', typeId: 2, typeLabel: 'Betoneira', quantity: 2, status: 'idle' });
  // Tudo o mais fica nulo ou vazio.
  assert.deepEqual({ ...m, saveReport: null }, emptyDailyMutation(W));
});

test('save_report: o rascunho pode ficar sem turno', () => {
  assert.deepEqual(plan(data(), save({ content: content({ shifts: [] }) })).saveReport!.shifts, []);
});

test('save_report edita com a versão lida e recusa conflito', () => {
  const current = report();
  const m = plan(data({ report: current }), save({ baseVersion: 3, content: content({ notes: 'nova' }) }));
  assert.equal(m.expectVersion, 3);
  assert.deepEqual(
    [m.saveReport!.version, m.saveReport!.notes, m.saveReport!.updatedBy, m.saveReport!.updatedAt, m.saveReport!.createdBy],
    [4, 'nova', 'u-2', NOW, 'u-1'],
  );
  assert.equal(m.saveReport!.createdAt, current.createdAt);
  refuses(() => plan(data({ report: current }), save({ baseVersion: 2 })), /Outra pessoa gravou/);
  refuses(() => plan(data({ report: current }), save({ baseVersion: null })), /Outra pessoa gravou/);
  refuses(() => plan(data({ report: current }), save({ id: 'r-outro', baseVersion: 3 })), /já tem um diário/);
  refuses(() => plan(data({ report: report({ date: '2026-11-20' }) }), save({ baseVersion: 3 })), /data de um diário não muda/);
});

test('diário enviado fica travado para gravar e excluir', () => {
  const sent = data({ report: report({ status: 'sent', siengeId: 88 }) });
  refuses(() => plan(sent, save({ baseVersion: 3 })), new RegExp(DAILY_SENT_MESSAGE.slice(0, 40)));
  refuses(() => plan(sent, { type: 'delete_report', id: 'r-1' }), /travado/);
});

test('save_report: data', () => {
  refuses(() => plan(data(), save({ date: '2026-11-25' })), /futuro/);
  refuses(() => plan(data(), save({ date: '2026-02-31' })), /inválida/);
  refuses(() => plan(data(), save({ date: '23/11/2026' })), /inválida/);
  refuses(() => plan(data(), save({ date: '2019-12-31' })), /2020/);
  assert.ok(plan(data(), save({ date: '2026-11-24' })).saveReport, 'hoje vale');
});

test('save_report: validações do conteúdo', () => {
  const bad = (over: Partial<DailyContent>, message: RegExp) => refuses(() => plan(data(), save({ content: content(over) })), message);
  const shift = { key: 'morning', startTime: '08:00', finishTime: '12:00', weather: 'fine' } as const;
  const task = { id: 't-1', description: 'Alvenaria', quantity: 1, unit: 'm2', localId: null, notes: '', commitmentId: null };
  const event = { id: 'e-1', typeId: 1, typeLabel: 'Visita', description: 'Visita' };
  const equipment = { id: 'q-1', typeId: 1, typeLabel: 'Grua', quantity: 1, status: 'in_use' } as const;

  bad({ shifts: [shift, { ...shift, startTime: '09:00' }] }, /Manhã aparece mais de uma vez/);
  bad({ shifts: [{ ...shift, startTime: '8:00' }] }, /HH:mm/);
  bad({ shifts: [{ ...shift, finishTime: '24:00' }] }, /HH:mm/);
  bad({ shifts: [{ ...shift, finishTime: '08:00' }] }, /depois do início/);
  bad({ shifts: [{ ...shift, weather: 'neve' as never }] }, /clima inválido/);
  bad({ shifts: [{ ...shift, key: 'madrugada' as never }] }, /Turno inválido/);

  bad({ rainfall: -1 }, /pluviométrico/);
  bad({ rainfall: 9999.99 }, /pluviométrico/);
  bad({ rainfall: 9999.989 }, /pluviométrico/);
  assert.equal(plan(data(), save({ content: content({ rainfall: 0 }) })).saveReport!.rainfall, 0);
  assert.equal(plan(data(), save({ content: content({ rainfall: 9999.98 }) })).saveReport!.rainfall, 9999.98);
  bad({ notes: 'x'.repeat(DAILY_LIMITS.notes + 1) }, /4000/);

  bad({ tasks: [{ ...task, id: ' ' }] }, /sem identificador/);
  bad({ tasks: [task, { ...task }] }, /repetida/);
  bad({ tasks: [{ ...task, description: '   ' }] }, /Descreva a atividade/);
  bad({ tasks: [{ ...task, description: 'x'.repeat(201) }] }, /200/);
  bad({ tasks: [{ ...task, quantity: -0.5 }] }, /quantidade/);
  bad({ tasks: [{ ...task, unit: 'km' }] }, /unidade inválida/);
  bad({ tasks: [{ ...task, localId: 'loc-de-outra-obra' }] }, /Local não encontrado nesta obra\./);
  bad({ tasks: [{ ...task, notes: 'x'.repeat(4001) }] }, /4000/);
  bad({ tasks: Array.from({ length: DAILY_LIMITS.tasks + 1 }, (_, i) => ({ ...task, id: `t-${i}` })) }, /até 60/);

  bad({ events: [{ ...event, typeId: 0 }] }, /tipo da ocorrência/);
  bad({ events: [{ ...event, typeId: 1.5 }] }, /tipo da ocorrência/);
  bad({ events: [{ ...event, description: ' ' }] }, /Descreva a ocorrência/);
  bad({ events: Array.from({ length: DAILY_LIMITS.events + 1 }, (_, i) => ({ ...event, id: `e-${i}` })) }, /até 30/);

  bad({ equipments: [{ ...equipment, typeId: -2 }] }, /tipo do equipamento/);
  bad({ equipments: [{ ...equipment, quantity: 0 }] }, /inteiro a partir de 1/);
  bad({ equipments: [{ ...equipment, quantity: 1.5 }] }, /inteiro a partir de 1/);
  bad({ equipments: [{ ...equipment, quantity: 1000 }] }, /999/);
  bad({ equipments: [{ ...equipment, status: 'vendido' as never }] }, /Situação/);
  bad({ equipments: Array.from({ length: DAILY_LIMITS.equipments + 1 }, (_, i) => ({ ...equipment, id: `q-${i}` })) }, /até 40/);
});

test('mão de obra: o diário acerta o histograma do dia (insere, atualiza, apaga)', () => {
  const crews: DailyCrew[] = [
    { company: ' awa ', role: 'CARPINTEIRO', quantity: 7 }, // muda a quantidade
    { company: 'AWA', role: 'Servente', quantity: 2 }, // igual: não grava
    { company: 'atr', role: 'engenheiro', quantity: 1 }, // nova no dia, na grafia da obra
    { company: 'Nova Ltda', role: 'Pintor', quantity: 3 }, // nova na obra
    // Hidrotec saiu da lista: apaga
  ];
  const m = plan(data(), save({ crews }));
  const h = m.headcount!;
  assert.deepEqual(h.delete, ['h-5']);
  assert.equal(h.update.length, 1);
  assert.deepEqual(
    [
      h.update[0].id,
      h.update[0].quantity,
      h.update[0].note,
      h.update[0].origin,
      h.update[0].company,
      h.update[0].role,
      h.update[0].updatedAt,
    ],
    ['h-3', 7, 'faltou 1', 'planilha', 'AWA', 'Carpinteiro', NOW],
  );
  assert.deepEqual(
    h.insert.map(e => [e.company, e.role, e.quantity, e.workedOn, e.note, e.origin, e.workId, e.createdBy]),
    [
      ['ATR', 'Engenheiro', 1, DAY, '', 'app', W, 'u-2'],
      ['Nova Ltda', 'Pintor', 3, DAY, '', 'app', W, 'u-2'],
    ],
  );
  assert.equal(new Set(h.insert.map(e => e.id)).size, 2);
  assert.ok(m.saveReport, 'grava o diário junto');
});

test('mão de obra: crews nulo deixa o histograma como está; lista vazia apaga o dia', () => {
  assert.equal(plan(data(), save({ crews: null })).headcount, null);
  assert.deepEqual(plan(data(), save({ crews: [] })).headcount, { insert: [], update: [], delete: ['h-3', 'h-4', 'h-5'] });
  // Dia sem lançamento e lista igual: nada a gravar.
  const same = plan(data(), save({ date: '2026-11-20', crews: crewsOfDay(HEADCOUNT, '2026-11-20') })).headcount;
  assert.deepEqual(same, { insert: [], update: [], delete: [] });
});

test('mão de obra: recusa linha repetida e número fora do histograma', () => {
  const crew = (over: Partial<DailyCrew>): DailyCrew[] => [{ company: 'AWA', role: 'Pintor', quantity: 2, ...over }];
  refuses(
    () =>
      plan(
        data(),
        save({
          crews: [
            { company: 'AWA', role: 'Carpinteiro', quantity: 2 },
            { company: 'awa ', role: 'carpinteiro', quantity: 3 },
          ],
        }),
      ),
    /Carpinteiro da AWA aparece mais de uma vez/,
  );
  refuses(() => plan(data(), save({ crews: crew({ company: '  ' }) })), /empresa/);
  refuses(() => plan(data(), save({ crews: crew({ role: '' }) })), /função/);
  refuses(() => plan(data(), save({ crews: crew({ quantity: 0 }) })), /inteiro a partir de 1/);
  refuses(() => plan(data(), save({ crews: crew({ quantity: 2.5 }) })), /inteiro a partir de 1/);
  refuses(() => plan(data(), save({ crews: crew({ quantity: 501 }) })), /500/);
  refuses(() => plan(data(), save({ crews: crew({ company: 'x'.repeat(81) }) })), /80/);
  refuses(
    () =>
      plan(
        data(),
        save({ crews: Array.from({ length: DAILY_LIMITS.crews + 1 }, (_, i) => ({ company: 'AWA', role: `F${i}`, quantity: 1 })) }),
      ),
    /até 80 linhas/,
  );
  refuses(() => plan(data(), save({ date: '2026-11-25', crews: crew({}) })), /futuro/);
});

test('mão de obra: empresa nova escrita de dois jeitos no mesmo envio nasce com uma grafia só', () => {
  const h = plan(
    data(),
    save({
      crews: [
        { company: 'Nova Ltda', role: 'Pintor', quantity: 1 },
        { company: 'NOVA LTDA', role: 'Ajudante', quantity: 2 },
      ],
    }),
  ).headcount!;
  assert.deepEqual(
    h.insert.map(e => e.company),
    ['Nova Ltda', 'Nova Ltda'],
  );
});

test('delete_report: só rascunho, e leva os arquivos das fotos', () => {
  const m = plan(data({ report: report(), photos: [photo('p-1'), photo('p-2')] }), { type: 'delete_report', id: 'r-1' });
  assert.equal(m.deleteReportId, 'r-1');
  assert.deepEqual(m.removeFiles, [`${W}/r-1/p-1.jpg`, `${W}/r-1/p-1-thumb.jpg`, `${W}/r-1/p-2.jpg`, `${W}/r-1/p-2-thumb.jpg`]);
  refuses(() => plan(data(), { type: 'delete_report', id: 'r-1' }), /não encontrado/);
});

test('add_photo: entra pendente, também em diário enviado; sem local não vai ao relatório', () => {
  const add = (over: Partial<Extract<DailyReportCommand, { type: 'add_photo' }>> = {}): DailyReportCommand => ({
    type: 'add_photo',
    id: 'p-9',
    reportId: 'r-1',
    description: '  Forma da laje  ',
    localId: 'loc-2',
    showInReports: true,
    ...over,
  });
  const m = plan(data({ report: report({ status: 'sent' }) }), add());
  assert.deepEqual(m.insertPhoto, {
    id: 'p-9',
    reportId: 'r-1',
    workId: W,
    storagePath: `${W}/r-1/p-9.jpg`,
    thumbPath: `${W}/r-1/p-9-thumb.jpg`,
    description: 'Forma da laje',
    localId: 'loc-2',
    showInReports: true,
    siengeStatus: 'pending',
    siengeError: '',
    createdBy: 'u-2',
    createdAt: NOW,
  });
  assert.equal(plan(data({ report: report() }), add({ localId: null })).insertPhoto!.showInReports, false);
  assert.equal(plan(data({ report: report() }), add({ showInReports: false })).insertPhoto!.showInReports, false);

  refuses(() => plan(data(), add()), /Diário não encontrado/);
  refuses(() => plan(data({ report: report({ id: 'r-outro' }) }), add()), /Diário não encontrado/);
  refuses(() => plan(data({ report: report(), photos: [photo('p-9')] }), add()), /já foi anexada/);
  refuses(() => plan(data({ report: report() }), add({ description: '  ' })), /Descreva a foto/);
  refuses(() => plan(data({ report: report() }), add({ description: 'x'.repeat(501) })), /500/);
  refuses(() => plan(data({ report: report() }), add({ localId: 'loc-x' })), /Local não encontrado/);
  const full = Array.from({ length: DAILY_LIMITS.photos }, (_, i) => photo(`f-${i}`));
  refuses(() => plan(data({ report: report(), photos: full }), add()), /30 fotos/);
  assert.ok(plan(data({ report: report(), photos: full.slice(1) }), add()).insertPhoto);
});

test('update_photo e delete_photo: foto que já está no Sienge fica travada', () => {
  const photos = [photo('p-1', { siengeStatus: 'error', siengeError: 'recusada' }), photo('p-2', { siengeStatus: 'sent' })];
  const d = () => data({ report: report(), photos });
  const m = plan(d(), { type: 'update_photo', id: 'p-1', description: ' Nova ', localId: null, showInReports: true });
  assert.deepEqual(m.updatePhoto, {
    ...photos[0],
    description: 'Nova',
    localId: null,
    showInReports: false,
    siengeStatus: 'pending',
    siengeError: '',
  });
  refuses(() => plan(d(), { type: 'update_photo', id: 'p-1', description: '', localId: null, showInReports: false }), /Descreva a foto/);
  refuses(
    () => plan(d(), { type: 'update_photo', id: 'p-1', description: 'x', localId: 'loc-x', showInReports: false }),
    /Local não encontrado/,
  );
  refuses(
    () => plan(d(), { type: 'update_photo', id: 'p-2', description: 'x', localId: null, showInReports: false }),
    /não pode ser alterada/,
  );
  refuses(() => plan(d(), { type: 'update_photo', id: 'p-x', description: 'x', localId: null, showInReports: false }), /não encontrada/);

  const removal = plan(d(), { type: 'delete_photo', id: 'p-1' });
  assert.equal(removal.deletePhotoId, 'p-1');
  assert.deepEqual(removal.removeFiles, [`${W}/r-1/p-1.jpg`, `${W}/r-1/p-1-thumb.jpg`]);
  refuses(() => plan(d(), { type: 'delete_photo', id: 'p-2' }), /não pode ser excluída/);
  refuses(() => plan(d(), { type: 'delete_photo', id: 'p-x' }), /não encontrada/);
});

test('ligações com o Sienge: local e empresa', () => {
  assert.deepEqual(plan(data(), { type: 'link_local', workId: W, localId: 'loc-1', siengeSiteId: 12 }).localLink, {
    localId: 'loc-1',
    siengeSiteId: 12,
  });
  assert.equal(plan(data(), { type: 'link_local', workId: W, localId: 'loc-1', siengeSiteId: null }).localLink!.siengeSiteId, null);
  refuses(() => plan(data(), { type: 'link_local', workId: W, localId: 'loc-x', siengeSiteId: 12 }), /Local não encontrado/);
  refuses(() => plan(data(), { type: 'link_local', workId: W, localId: 'loc-1', siengeSiteId: 0 }), /inválido/);
  refuses(() => plan(data(), { type: 'link_local', workId: W, localId: 'loc-1', siengeSiteId: 1.5 }), /inválido/);

  assert.deepEqual(plan(data(), { type: 'link_company', company: '  Construtora  São  José ', crewTypeId: 5 }).companyLink, {
    companyKey: 'construtora sao jose',
    company: 'Construtora São José',
    crewTypeId: 5,
  });
  assert.equal(plan(data(), { type: 'link_company', company: 'AWA', crewTypeId: null }).companyLink!.crewTypeId, null);
  refuses(() => plan(data(), { type: 'link_company', company: '   ', crewTypeId: 5 }), /empresa/);
  refuses(() => plan(data(), { type: 'link_company', company: 'AWA', crewTypeId: -1 }), /inválido/);
});

test('usuário do Sienge: aparado, em maiúsculas; vazio limpa', () => {
  assert.deepEqual(plan(data(), { type: 'set_sienge_user', code: '  bruno.santos_1-a ' }).siengeUser, {
    userId: 'u-2',
    code: 'BRUNO.SANTOS_1-A',
  });
  assert.deepEqual(plan(data(), { type: 'set_sienge_user', code: '   ' }).siengeUser, { userId: 'u-2', code: '' });
  refuses(() => plan(data(), { type: 'set_sienge_user', code: 'bruno santos' }), /só letras/);
  refuses(() => plan(data(), { type: 'set_sienge_user', code: 'bruno@atr' }), /só letras/);
  refuses(() => plan(data(), { type: 'set_sienge_user', code: 'x'.repeat(61) }), /60/);
  refuses(() => plan(data(), { type: 'set_sienge_user', code: '.bruno' }), /2 a 50/);
  refuses(() => plan(data(), { type: 'set_sienge_user', code: 'B' }), /2 a 50/);
});

test('crewsOfDay e lastCrewsBefore leem o histograma', () => {
  assert.deepEqual(crewsOfDay(HEADCOUNT, DAY), [
    { company: 'AWA', role: 'Carpinteiro', quantity: 5 },
    { company: 'AWA', role: 'Servente', quantity: 2 },
    { company: 'Hidrotec', role: 'Encanador', quantity: 4 },
  ]);
  assert.deepEqual(crewsOfDay(HEADCOUNT, '2026-11-21'), []);
  assert.deepEqual(lastCrewsBefore(HEADCOUNT, '2026-11-24'), { date: DAY, crews: crewsOfDay(HEADCOUNT, DAY) });
  assert.deepEqual(lastCrewsBefore(HEADCOUNT, DAY), {
    date: '2026-11-20',
    crews: [
      { company: 'ATR', role: 'Engenheiro', quantity: 1 },
      { company: 'AWA', role: 'Carpinteiro', quantity: 6 },
    ],
  });
  assert.equal(lastCrewsBefore(HEADCOUNT, '2026-11-20'), null);
  assert.equal(lastCrewsBefore([], DAY), null);
});

test('marcações do envio: enviado, recusado e reaberto', () => {
  const draft = report({ lastError: 'recusa antiga' });
  const sent = markDailyReportSent(draft, { siengeBuildingId: 32, siengeId: 501, actorId: 'u-2', now: NOW });
  assert.deepEqual(
    [sent.status, sent.siengeBuildingId, sent.siengeId, sent.sentAt, sent.sentBy, sent.lastError, sent.version],
    ['sent', 32, 501, NOW, 'u-2', '', 4],
  );
  assert.equal(draft.status, 'draft', 'não altera o original');

  const failed = markDailyReportError(report(), 'O Sienge recusou: turno inválido.', NOW);
  assert.deepEqual(
    [failed.status, failed.lastError, failed.version, failed.siengeId],
    ['draft', 'O Sienge recusou: turno inválido.', 4, null],
  );

  const reopened = reopenDailyReport(sent, { actorId: 'admin-1', now: '2026-11-24T18:00:00.000Z' });
  assert.deepEqual(
    [reopened.status, reopened.siengeId, reopened.sentAt, reopened.sentBy, reopened.lastError, reopened.version, reopened.updatedBy],
    ['draft', null, null, null, '', 5, 'admin-1'],
  );
  // Reaberto, volta a aceitar gravação.
  assert.ok(plan(data({ report: reopened }), save({ baseVersion: 5 })).saveReport);
});

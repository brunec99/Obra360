import assert from 'node:assert/strict';
import test from 'node:test';
import { planDailyReportCommand } from '../src/application/use-cases/daily-report-commands';
import { emptyDailyContent, type DailyContent, type DailyPhotoView, type DailyReport, type DailySupport } from '../src/domain/daily-report';
import {
  alreadyApplied,
  applyResult,
  clampDate,
  cleanContent,
  companiesToLink,
  conference,
  dayFromPackage,
  dayStrip,
  diarySituation,
  discardOperation,
  draftProblems,
  editPhoto,
  isStaleDraftRefusal,
  localDay,
  markError,
  mergeDays,
  operationCommand,
  packageFromDay,
  putCommand,
  putPhoto,
  putSave,
  removePhoto,
  resolveConflict,
  retryOperation,
  sameAsServer,
  sendable,
  settle,
  shiftDate,
  type DiaryDay,
  type DiaryOperation,
} from '../src/modules/diario/diary-model';

/* Regras puras da tela do Diário de Obra (2.4): a fila do aparelho aplicada sobre o que veio do servidor,
 * o rascunho virando comando, a situação do dia e a conferência antes do envio. */

const WORK = 'obra-1';
const DATE = '2026-11-24';
let counter = 0;
const ids = () => ({ id: `op-${++counter}`, now: '2026-11-24T12:00:00.000Z' });

const support = (over: Partial<DailySupport> = {}): DailySupport => ({
  siengeBuildingId: 32,
  siengeConfigured: true,
  eventTypes: [{ id: 7, label: 'Recebimento de material' }],
  crewTypes: [
    { id: 1, label: 'ATR' },
    { id: 5, label: 'HIDROTEC' },
  ],
  equipmentTypes: [{ id: 2, label: 'Escavadeira' }],
  sites: null,
  supportError: '',
  locals: [
    { id: 'l1', name: '7º Pavimento', siengeSiteId: 9 },
    { id: 'l2', name: 'Cobertura', siengeSiteId: null },
  ],
  companyLinks: [],
  companies: ['ATR', 'Hidrotec'],
  roles: ['Pedreiro'],
  commitments: [],
  siengeUserCode: 'MARIA.EXEMPLO',
  siengeUserMatches: [],
  ...over,
});
const report = (over: Partial<DailyReport> = {}): DailyReport => ({
  ...emptyDailyContent(),
  id: 'r1',
  workId: WORK,
  date: DATE,
  status: 'draft',
  siengeBuildingId: null,
  siengeId: null,
  sentAt: null,
  sentBy: null,
  lastError: '',
  version: 3,
  createdBy: 'u1',
  createdAt: '2026-11-24T10:00:00.000Z',
  updatedBy: 'u1',
  updatedAt: '2026-11-24T10:00:00.000Z',
  ...over,
});
const photo = (over: Partial<DailyPhotoView> = {}): DailyPhotoView => ({
  id: 'p1',
  reportId: 'r1',
  workId: WORK,
  storagePath: 'a.jpg',
  thumbPath: 'a-thumb.jpg',
  description: 'Alvenaria',
  localId: 'l1',
  showInReports: true,
  siengeStatus: 'pending',
  siengeError: '',
  createdBy: 'u1',
  createdAt: '2026-11-24T11:00:00.000Z',
  url: 'https://x/a.jpg',
  thumbUrl: 'https://x/a-thumb.jpg',
  ...over,
});
const day = (over: Partial<DiaryDay> = {}): DiaryDay => ({
  workId: WORK,
  date: DATE,
  today: DATE,
  canEdit: true,
  canAdmin: false,
  report: null,
  photos: [],
  crews: [],
  lastCrews: null,
  days: [],
  support: support(),
  savedAt: '2026-11-24T09:00:00.000Z',
  ...over,
});
const save = (over: Partial<Extract<DiaryOperation, { kind: 'save' }>> = {}): Extract<DiaryOperation, { kind: 'save' }> => ({
  kind: 'save',
  reportId: 'r1',
  date: DATE,
  baseVersion: null,
  content: emptyDailyContent(),
  crews: null,
  ...over,
});
const photoOp = (over: Partial<Extract<DiaryOperation, { kind: 'photo' }>> = {}): Extract<DiaryOperation, { kind: 'photo' }> => ({
  kind: 'photo',
  reportId: 'r1',
  date: DATE,
  photoId: 'p9',
  description: 'Laje',
  localId: null,
  showInReports: true,
  ...over,
});

test('dia sem diário abre com os turnos padrão e nada na fila', () => {
  const view = localDay(day(), [], 'novo');
  assert.equal(view.exists, false);
  assert.equal(view.reportId, 'novo');
  assert.deepEqual(
    view.content.shifts.map(shift => shift.key),
    ['morning', 'afternoon'],
  );
  assert.equal(view.pending, 0);
  assert.deepEqual(diarySituation(view), { key: 'empty', label: 'Sem diário' });
});

test('o rascunho é uma operação só: cada alteração reescreve a que está na fila', () => {
  let queue = putSave([], WORK, save({ content: { ...emptyDailyContent(), notes: 'a' } }), ids());
  queue = putSave(queue, WORK, save({ content: { ...emptyDailyContent(), notes: 'ab' } }), ids());
  assert.equal(queue.length, 1);
  assert.equal(queue[0].rev, 1);
  const view = localDay(day(), queue, 'novo');
  assert.equal(view.reportId, 'r1');
  assert.equal(view.content.notes, 'ab');
  assert.equal(view.crewsTouched, false);
  assert.deepEqual(diarySituation(view), { key: 'device', label: 'Guardado no aparelho' });
});

test('a mão de obra só vai no comando quando a pessoa mexeu nela', () => {
  const untouched = operationCommand(WORK, save());
  assert.equal(untouched.type === 'save_report' && untouched.crews, null);
  const touched = operationCommand(
    WORK,
    save({
      crews: [
        { company: ' ATR ', role: 'Pedreiro', quantity: 4 },
        { company: 'atr', role: 'pedreiro', quantity: 2 },
        { company: '', role: 'Servente', quantity: 3 },
        { company: 'Hidrotec', role: 'Encanador', quantity: 0 },
      ],
    }),
  );
  assert.deepEqual(touched.type === 'save_report' && touched.crews, [{ company: 'ATR', role: 'Pedreiro', quantity: 6 }]);
});

test('o comando não leva linha em branco, e a tela continua com ela', () => {
  const content: DailyContent = {
    ...emptyDailyContent(),
    shifts: [
      { key: 'afternoon', startTime: '13:00', finishTime: '17:00', weather: 'light_rain' },
      { key: 'morning', startTime: '08:00', finishTime: '12:00', weather: 'fine' },
    ],
    rainfall: 2.456,
    notes: '  choveu  ',
    tasks: [
      { id: 't1', description: '  Alvenaria ', quantity: 30.123456, unit: 'm2', localId: 'l1', notes: '', commitmentId: 'c1' },
      { id: 't2', description: ' ', quantity: null, unit: '', localId: null, notes: '', commitmentId: null },
    ],
    events: [
      { id: 'e1', typeId: 7, typeLabel: 'Recebimento', description: '' },
      { id: 'e2', typeId: 7, typeLabel: 'Recebimento', description: 'Blocos' },
    ],
    equipments: [
      { id: 'q1', typeId: 2, typeLabel: 'Escavadeira', quantity: 0, status: 'in_use' },
      { id: 'q2', typeId: 2, typeLabel: 'Escavadeira', quantity: 1.9, status: 'idle' },
    ],
  };
  const clean = cleanContent(content);
  assert.deepEqual(
    clean.shifts.map(shift => shift.key),
    ['morning', 'afternoon'],
  );
  assert.equal(clean.rainfall, 2.46);
  assert.equal(clean.notes, 'choveu');
  assert.deepEqual(clean.tasks, [
    { id: 't1', description: 'Alvenaria', quantity: 30.1235, unit: 'm2', localId: 'l1', notes: '', commitmentId: 'c1' },
  ]);
  assert.deepEqual(
    clean.events.map(event => event.id),
    ['e2'],
  );
  assert.deepEqual(clean.equipments, [{ id: 'q2', typeId: 2, typeLabel: 'Escavadeira', quantity: 1, status: 'idle' }]);
  // A fila guarda o que a pessoa digitou, com as linhas em branco.
  const view = localDay(day(), putSave([], WORK, save({ content }), ids()), 'novo');
  assert.equal(view.content.tasks.length, 2);
});

test('turno com fim antes do início segura o rascunho no aparelho, e as fotos do diário novo esperam junto', () => {
  const content = {
    ...emptyDailyContent(),
    shifts: [{ key: 'morning' as const, startTime: '12:00', finishTime: '08:00', weather: 'fine' as const }],
  };
  assert.equal(draftProblems(content).length, 1);
  let queue = putSave([], WORK, save({ content }), ids());
  queue = putPhoto(queue, WORK, photoOp(), ids());
  queue = putCommand(queue, WORK, DATE, { type: 'set_sienge_user', code: 'JOAO' }, ids());
  assert.deepEqual(
    sendable(queue).map(queued => queued.operation.kind),
    ['command'],
  );
  // Corrigido o turno, tudo segue na ordem: o diário antes da foto.
  queue = putSave(queue, WORK, save(), ids());
  assert.deepEqual(
    sendable(queue).map(queued => queued.operation.kind),
    ['save', 'photo', 'command'],
  );
});

test('foto sem descrição espera no aparelho; com descrição, sobe', () => {
  let queue = putPhoto([], WORK, photoOp({ description: ' ' }), ids());
  assert.equal(sendable(queue).length, 0);
  const held = localDay(day({ report: report() }), queue, 'novo').photos[0];
  assert.equal(held.local, true);
  assert.equal(held.held, true);
  queue = editPhoto(queue, WORK, DATE, 'p9', { description: 'Laje', localId: 'l1', showInReports: true }, ids());
  assert.equal(queue.length, 1);
  assert.equal(sendable(queue).length, 1);
  const command = operationCommand(WORK, queue[0].operation);
  assert.deepEqual(command, { type: 'add_photo', id: 'p9', reportId: 'r1', description: 'Laje', localId: 'l1', showInReports: true });
});

test('recusa de regra fica marcada na operação e não trava as que não dependem dela', () => {
  let queue = putSave([], WORK, save(), ids());
  queue = putPhoto(queue, WORK, photoOp(), ids());
  queue = putSave(queue, 'obra-2', save({ reportId: 'r2' }), ids());
  queue = markError(queue, queue[0], 'Data no futuro.');
  // A foto do diário recusado espera; o diário da outra obra segue.
  assert.deepEqual(
    sendable(queue).map(queued => queued.workId),
    ['obra-2'],
  );
  const view = localDay(day(), queue, 'novo');
  assert.equal(view.failed.length, 1);
  // A próxima alteração limpa a recusa e tenta de novo.
  queue = putSave(queue, WORK, save({ content: { ...emptyDailyContent(), notes: 'x' } }), ids());
  assert.equal(queue[0].error, undefined);
  assert.equal(sendable(queue).length, 3);
  // "Tentar de novo" também.
  const marked = markError(queue, queue[0], 'Erro');
  assert.equal(retryOperation(marked, marked[0].id)[0].error, undefined);
});

test('recusa de uma versão antiga da operação não fica marcada', () => {
  const first = putSave([], WORK, save(), ids());
  const edited = putSave(first, WORK, save({ content: { ...emptyDailyContent(), notes: 'novo' } }), ids());
  assert.equal(markError(edited, first[0], 'Erro')[0].error, undefined);
});

test('envio aceito: sai da fila se não mudou; se mudou no meio do caminho, fica com a versão nova como base', () => {
  const first = putSave([], WORK, save(), ids());
  assert.deepEqual(settle(first, first[0], { report: report({ version: 1 }) }, ids()), []);
  const edited = putSave(first, WORK, save({ content: { ...emptyDailyContent(), notes: 'digitado durante o envio' } }), ids());
  const after = settle(edited, first[0], { report: report({ version: 1 }) }, ids());
  assert.equal(after.length, 1);
  const operation = after[0].operation;
  assert.equal(operation.kind === 'save' && operation.baseVersion, 1);
  assert.equal(operation.kind === 'save' && operation.content.notes, 'digitado durante o envio');
});

test('foto alterada ou excluída enquanto subia vira o comando certo depois', () => {
  const first = putPhoto([], WORK, photoOp(), ids());
  const edited = editPhoto(first, WORK, DATE, 'p9', { description: 'Laje pronta', localId: 'l1', showInReports: false }, ids());
  const afterEdit = settle(edited, first[0], {}, ids());
  assert.deepEqual(afterEdit[0].operation, {
    kind: 'command',
    date: DATE,
    command: { type: 'update_photo', id: 'p9', description: 'Laje pronta', localId: 'l1', showInReports: false },
  });
  const removed = removePhoto(first, WORK, DATE, 'p9', ids());
  assert.equal(removed.length, 0);
  const afterRemove = settle(removed, first[0], {}, ids());
  assert.deepEqual(afterRemove[0].operation, { kind: 'command', date: DATE, command: { type: 'delete_photo', id: 'p9' } });
});

test('foto que já subiu: alteração vira update_photo (uma só) e exclusão troca as alterações por delete_photo', () => {
  const base = day({ report: report(), photos: [photo()] });
  let queue = editPhoto([], WORK, DATE, 'p1', { description: 'A', localId: null, showInReports: true }, ids());
  queue = editPhoto(queue, WORK, DATE, 'p1', { description: 'AB', localId: null, showInReports: true }, ids());
  assert.equal(queue.length, 1);
  const edited = localDay(base, queue, 'novo').photos[0];
  assert.equal(edited.description, 'AB');
  assert.equal(edited.localId, null);
  assert.equal(edited.local, false);
  queue = removePhoto(queue, WORK, DATE, 'p1', ids());
  assert.deepEqual(
    queue.map(queued => queued.operation.kind === 'command' && queued.operation.command.type),
    ['delete_photo'],
  );
  assert.equal(localDay(base, queue, 'novo').photos.length, 0);
});

test('conflito (409): a tela mostra, e recarregar descarta o rascunho e passa as fotos para o diário do servidor', () => {
  let queue = putSave([], WORK, save({ reportId: 'meu' }), ids());
  queue = putPhoto(queue, WORK, photoOp({ reportId: 'meu' }), ids());
  queue = markError(queue, queue[0], 'Outra pessoa gravou este diário antes de você.', true);
  const view = localDay(day({ report: report({ id: 'r1' }) }), queue, 'novo');
  assert.equal(view.conflict?.id, queue[0].id);
  assert.equal(view.failed.length, 0);
  assert.equal(view.reportId, 'r1');
  const resolved = resolveConflict(queue, 'meu', 'r1');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].operation.kind === 'photo' && resolved[0].operation.reportId, 'r1');
});

test('409 depois de resposta perdida: se o servidor já tem o que ia ser gravado, não é conflito', () => {
  const content = { ...emptyDailyContent(), notes: 'igual ' };
  const crews = [{ company: 'ATR', role: 'Pedreiro', quantity: 4 }];
  const stored = report({ ...cleanContent(content), version: 4 });
  assert.equal(sameAsServer(save({ content, crews }), stored, [{ company: 'atr', role: 'pedreiro', quantity: 4 }]), true);
  assert.equal(sameAsServer(save({ content, crews }), stored, []), false);
  assert.equal(sameAsServer(save({ content: { ...content, notes: 'outro' } }), stored, []), false);
  assert.equal(sameAsServer(save({ content, reportId: 'outro' }), stored, []), false);
  assert.equal(sameAsServer(save({ content }), null, []), false);
  assert.equal(alreadyApplied('Esta foto já foi anexada. Recarregue a página.'), true);
  assert.equal(alreadyApplied('Foto não encontrada.'), false);
});

test('versão defasada recusada pela regra do servidor conta como conflito, como o 409', () => {
  // As mensagens vêm do planejador real: se o texto dele mudar, este teste avisa que a tela deixou de reconhecer.
  const stored = report({ version: 4 });
  const ctx = { actorId: 'u', now: '2026-11-24T12:00:00Z', today: '2026-11-24', newId: () => 'novo' };
  const data = { report: stored, photos: [], headcount: [], localIds: [] };
  const refusal = (id: string, baseVersion: number | null) => {
    try {
      planDailyReportCommand(
        data,
        { type: 'save_report', workId: WORK, id, date: stored.date, baseVersion, content: emptyDailyContent(), crews: null },
        ctx,
        WORK,
      );
    } catch (error) {
      return (error as Error).message;
    }
    return '';
  };
  assert.equal(isStaleDraftRefusal(refusal(stored.id, 3)), true, 'versão defasada');
  assert.equal(isStaleDraftRefusal(refusal('outro-diario', null)), true, 'o dia já ganhou um diário de outra pessoa');
  assert.equal(refusal(stored.id, 4), '', 'na versão certa o planejador aceita');
  assert.equal(isStaleDraftRefusal('Descreva a atividade.'), false);
});

test('descartar o rascunho de um diário que não existe no servidor leva as fotos dele', () => {
  let queue = putSave([], WORK, save(), ids());
  queue = putPhoto(queue, WORK, photoOp(), ids());
  queue = putCommand(queue, WORK, DATE, { type: 'set_sienge_user', code: 'JOAO' }, ids());
  assert.deepEqual(
    discardOperation(queue, queue[0].id).map(queued => queued.operation.kind),
    ['command'],
  );
});

test('ligações com o Sienge na fila já aparecem na tela, e comando igual é reescrito', () => {
  let queue = putCommand([], WORK, DATE, { type: 'link_local', workId: WORK, localId: 'l2', siengeSiteId: 10 }, ids());
  queue = putCommand(queue, WORK, DATE, { type: 'link_local', workId: WORK, localId: 'l2', siengeSiteId: 11 }, ids());
  queue = putCommand(queue, WORK, DATE, { type: 'link_company', company: 'Gesso Minas', crewTypeId: 5 }, ids());
  queue = putCommand(queue, WORK, DATE, { type: 'set_sienge_user', code: 'JOAO' }, ids());
  assert.equal(queue.length, 3);
  // Feitas em outro dia, valem para a obra.
  const view = localDay(day({ date: '2026-11-23' }), queue, 'novo');
  assert.equal(view.support.locals.find(local => local.id === 'l2')?.siengeSiteId, 11);
  assert.deepEqual(view.support.companyLinks, [{ companyKey: 'gesso minas', company: 'Gesso Minas', crewTypeId: 5 }]);
  assert.equal(view.support.siengeUserCode, 'JOAO');
  assert.equal(view.pending, 3);
});

test('a resposta do comando atualiza o dia guardado, com o resumo da faixa de dias', () => {
  const base = day({ days: [{ date: '2026-11-23', status: 'sent', siengeId: 369, photos: 2, photosPending: 0 }] });
  const saved = applyResult(base, { report: report({ version: 1 }), crews: [{ company: 'ATR', role: 'Pedreiro', quantity: 4 }] });
  assert.equal(saved.report?.version, 1);
  assert.equal(saved.crews.length, 1);
  assert.deepEqual(saved.days[0], { date: DATE, status: 'draft', siengeId: null, photos: 0, photosPending: 0 });
  const withPhoto = applyResult(saved, { photo: photo() });
  assert.equal(withPhoto.days[0].photosPending, 1);
  const sent = applyResult(withPhoto, { photo: photo({ siengeStatus: 'sent' }), report: report({ status: 'sent', siengeId: 370 }) });
  assert.deepEqual(sent.days[0], { date: DATE, status: 'sent', siengeId: 370, photos: 1, photosPending: 0 });
  assert.deepEqual(diarySituation(localDay(sent, [], 'novo')), { key: 'sent', label: 'Enviado · nº 370' });
  assert.equal(applyResult(sent, { deletedPhotoId: 'p1' }).photos.length, 0);
  assert.equal(applyResult(sent, { siengeUserCode: 'ANA' }).support.siengeUserCode, 'ANA');
});

test('situação: erro no envio quando o Sienge recusou e nada está pendente', () => {
  const refused = localDay(day({ report: report({ lastError: 'Usuário inválido.' }) }), [], 'novo');
  assert.deepEqual(diarySituation(refused), { key: 'error', label: 'Erro no envio' });
  assert.deepEqual(diarySituation(localDay(day({ report: report() }), [], 'novo')), { key: 'draft', label: 'Rascunho' });
});

test('conferência: pessoas por empresa, fotos com e sem local do Sienge, bloqueios e avisos do montador', () => {
  const base = day({
    report: report(),
    crews: [
      { company: 'ATR', role: 'Pedreiro', quantity: 6 },
      { company: 'ATR', role: 'Servente', quantity: 4 },
      { company: 'Gesso Minas', role: 'Gesseiro', quantity: 5 },
    ],
    photos: [photo(), photo({ id: 'p2', localId: 'l2' }), photo({ id: 'p3', localId: null }), photo({ id: 'p4', siengeStatus: 'sent' })],
  });
  const data = conference(base, localDay(base, [], 'novo'));
  assert.equal(data.people, 15);
  assert.deepEqual(data.companies, [
    { company: 'ATR', quantity: 10, own: true, linked: true },
    { company: 'Gesso Minas', quantity: 5, own: false, linked: false },
  ]);
  assert.deepEqual(data.photos, { toSend: 3, withLocal: 1, withoutLocal: 2, alreadySent: 1 });
  assert.equal(data.shifts.length, 2);
  assert.deepEqual(data.build.blocking, []);
  assert.equal(data.build.warnings.length, 2);
  assert.deepEqual(companiesToLink(base.crews, base.support.crewTypes), ['Gesso Minas']);
  // Sem empreendimento ligado e sem turno, o envio fica bloqueado.
  const blocked = day({ report: report({ shifts: [] }), support: support({ siengeBuildingId: null }) });
  assert.equal(conference(blocked, localDay(blocked, [], 'novo')).build.blocking.length, 2);
});

test('datas: futuro vira hoje, e a faixa dos últimos dias marca rascunho e enviado', () => {
  assert.equal(clampDate('2026-11-30', DATE), DATE);
  assert.equal(clampDate('ontem', DATE), DATE);
  assert.equal(clampDate('2026-11-20', DATE), '2026-11-20');
  assert.equal(shiftDate(DATE, 1, DATE), DATE);
  assert.equal(shiftDate(DATE, -1, DATE), '2026-11-23');
  const strip = dayStrip(
    [
      { date: '2026-11-23', status: 'sent', siengeId: 369, photos: 0, photosPending: 0 },
      { date: DATE, status: 'draft', siengeId: null, photos: 1, photosPending: 1 },
    ],
    DATE,
    '2026-11-23',
  );
  assert.equal(strip.length, 14);
  assert.equal(strip.at(-1)?.date, DATE);
  assert.equal(strip.at(-1)?.state, 'draft');
  assert.deepEqual([strip.at(-2)?.state, strip.at(-2)?.selected], ['sent', true]);
  assert.equal(strip[0].state, 'none');
  // Data antiga: a faixa acompanha a data escolhida.
  assert.equal(dayStrip([], DATE, '2026-09-01').at(-1)?.date, '2026-09-04');
});

test('pacote de apoio: dia nunca lido abre em branco, sem sinal, com as listas e o último efetivo conhecido', () => {
  const read = day({
    crews: [{ company: 'ATR', role: 'Pedreiro', quantity: 6 }],
    days: [{ date: DATE, status: 'draft', siengeId: null, photos: 0, photosPending: 0 }],
    support: support({ commitments: [{ id: 'c1', name: 'Alvenaria', supplier: 'ATR', localId: 'l1' }] }),
  });
  const pkg = packageFromDay(read, null);
  assert.equal(pkg.lastCrews?.date, DATE);
  const blank = dayFromPackage(pkg, '2026-11-25', '2026-11-25');
  assert.equal(blank.fromPackage, true);
  assert.equal(blank.report, null);
  assert.equal(blank.lastCrews?.date, DATE);
  assert.deepEqual(blank.support.commitments, []);
  assert.equal(blank.support.locals.length, 2);
  // Para um dia anterior ao efetivo conhecido, não há "último dia" a repetir.
  assert.equal(dayFromPackage(pkg, '2026-11-20', '2026-11-25').lastCrews, null);
  // A leitura nova vale para os 60 dias que cobre; o resto do que já se sabia fica.
  const merged = mergeDays(
    [
      { date: '2026-11-25', status: 'draft', siengeId: null, photos: 0, photosPending: 0 },
      { date: DATE, status: 'draft', siengeId: null, photos: 0, photosPending: 0 },
    ],
    [{ date: DATE, status: 'sent', siengeId: 370, photos: 0, photosPending: 0 }],
    DATE,
  );
  assert.deepEqual(
    merged.map(item => [item.date, item.status]),
    [
      ['2026-11-25', 'draft'],
      [DATE, 'sent'],
    ],
  );
});

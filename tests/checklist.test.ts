import test from 'node:test';
import assert from 'node:assert/strict';
import {
  awaitsRun,
  checklistBoard,
  checklistSummary,
  isSkippedRun,
  openNonConformities,
  equipmentTypes,
  CHECKLIST_TOKEN,
  doneLocations,
  modelsFor,
  operatorLabel,
  operatorDues,
  periodKey,
  type ChecklistData,
  type ChecklistEquipment,
  type ChecklistModel,
  type ChecklistRun,
} from '../src/domain/equipment-checklist';
import {
  canManageChecklist,
  canWriteChecklist,
  checklistCommandNeedsAdmin,
  checklistCommandTarget,
  parseChecklistCommand,
  parseOperatorRun,
  planChecklistCommand,
  planOperatorRun,
} from '../src/application/use-cases/checklist-commands';
import { checklistNcEmail, checklistNcKey } from '../src/infrastructure/email/checklist-nc';
import { hasSectionAccess, isRestrictedApi, MODULES } from '../src/application/module-access';

const NOW = '2026-11-11T12:00:00.000Z';
const TODAY = '2026-11-11'; // quarta-feira
function ctx() {
  let n = 0;
  return { actorId: 'tst-1', now: NOW, today: TODAY, newId: () => `new-${++n}` };
}
const model = (over: Partial<ChecklistModel> = {}): ChecklistModel => ({
  id: 'm-dia',
  name: 'Betoneira — diário',
  equipmentType: 'Betoneira',
  frequency: 'daily',
  items: [
    { id: 'i1', text: 'Proteção das partes móveis' },
    { id: 'i2', text: 'Aterramento' },
  ],
  asksLocation: false,
  active: true,
  createdBy: 'tst-1',
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});
const equipment = (over: Partial<ChecklistEquipment> = {}): ChecklistEquipment => ({
  id: 'e1',
  workId: 'obra-1',
  name: 'Betoneira 01',
  equipmentType: 'Betoneira',
  active: true,
  publicToken: 'segredo-do-equipamento-e1-0123456789',
  extraModelIds: [],
  hiddenModelIds: [],
  createdBy: 'tst-1',
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});
const run = (over: Partial<ChecklistRun> = {}): ChecklistRun => ({
  id: 'r1',
  workId: 'obra-1',
  equipmentId: 'e1',
  modelId: 'm-dia',
  modelName: 'Betoneira — diário',
  frequency: 'daily',
  doneOn: TODAY,
  location: '',
  answers: [
    { itemId: 'i1', text: 'Proteção das partes móveis', answer: 'c', note: '' },
    { itemId: 'i2', text: 'Aterramento', answer: 'c', note: '' },
  ],
  note: '',
  operatorName: '',
  operatorCompany: '',
  signaturePath: null,
  signedAt: null,
  photos: [],
  source: 'app',
  createdBy: 'tst-1',
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});
const data = (over: Partial<ChecklistData> = {}): ChecklistData => ({ models: [model()], equipment: [equipment()], runs: [], ...over });
const plan = (d: ChecklistData, command: unknown) => planChecklistCommand(d, parseChecklistCommand(command), ctx(), 'obra-1');
const answersOk = [
  { itemId: 'i1', answer: 'c' },
  { itemId: 'i2', answer: 'c' },
];

test('checklist: só TST e admin editam; a aba é liberada por pessoa (12/11/2026) e o link do operador não', () => {
  assert.equal(canWriteChecklist({ tst: true, role: 'viewer' }), true);
  assert.equal(canWriteChecklist({ role: 'admin' }), true);
  assert.equal(canWriteChecklist({ role: 'manager' }), false);
  assert.equal(canWriteChecklist({ role: 'planner' }), false);
  assert.equal(canWriteChecklist(null), false);
  assert.equal(hasSectionAccess('checklist', { developer: false, modules: [] }), false);
  assert.equal(hasSectionAccess('checklist', { developer: false, modules: ['checklist'] }), true);
  assert.equal(isRestrictedApi('/api/checklist'), true);
  assert.equal(isRestrictedApi('/api/publico/checklist/abc'), false);
  assert.equal(MODULES.find(m => m.section === 'checklist')?.open, undefined);
});

test('checklist: o período é o dia, a semana de segunda a domingo e o mês', () => {
  assert.equal(periodKey('daily', '2026-11-11'), '2026-11-11');
  assert.equal(periodKey('weekly', '2026-11-11'), '2026-11-09');
  assert.equal(periodKey('weekly', '2026-11-09'), '2026-11-09');
  assert.equal(periodKey('weekly', '2026-11-15'), '2026-11-09'); // domingo fecha a semana
  assert.equal(periodKey('weekly', '2026-11-16'), '2026-11-16');
  assert.equal(periodKey('monthly', '2026-11-30'), '2026-11');
});

test('checklist: o equipamento recebe os modelos ativos do tipo dele, sem acento nem maiúsculas', () => {
  const models = [
    model(),
    model({ id: 'm-mes', name: 'Betoneira — mensal', frequency: 'monthly', equipmentType: 'betoneira ' }),
    model({ id: 'm-off', name: 'Betoneira antigo', active: false }),
    model({ id: 'm-serra', name: 'Serra — diário', equipmentType: 'Serra circular' }),
  ];
  assert.deepEqual(
    modelsFor(equipment({ equipmentType: 'BETONEIRA' }), models).map(m => m.id),
    ['m-dia', 'm-mes'],
  );
  assert.deepEqual(equipmentTypes({ models, equipment: [equipment()] }), ['Betoneira', 'Serra circular']);
});

test('checklist: o quadro mostra pendente, feito e não conforme no período corrente', () => {
  const weekly = model({ id: 'm-sem', name: 'Betoneira — semanal', frequency: 'weekly' });
  const monthly = model({ id: 'm-mes', name: 'Betoneira — mensal', frequency: 'monthly' });
  const d = data({
    models: [model(), weekly, monthly],
    equipment: [equipment(), equipment({ id: 'e2', name: 'Guincho 01', equipmentType: 'Guincho' }), equipment({ id: 'e3', active: false })],
    runs: [
      run({ id: 'r-ontem', doneOn: '2026-11-10' }), // diário de ontem não vale hoje
      run({ id: 'r-sem', modelId: 'm-sem', frequency: 'weekly', doneOn: '2026-11-09' }), // segunda desta semana
      run({
        id: 'r-mes',
        modelId: 'm-mes',
        frequency: 'monthly',
        doneOn: '2026-11-02',
        answers: [{ itemId: 'i1', text: 'x', answer: 'nc', note: 'sem proteção' }],
      }),
    ],
  });
  const board = checklistBoard(d, TODAY);
  assert.deepEqual(
    board.map(r => r.equipment.id),
    ['e1', 'e2'],
  );
  const [daily, week, month] = board[0].dues;
  assert.equal(daily.status, 'pending');
  assert.equal(daily.lastDoneOn, '2026-11-10');
  assert.equal(week.status, 'done');
  assert.equal(month.status, 'nonconforming');
  assert.equal(board[1].dues.length, 0);
  const summary = checklistSummary(board);
  assert.deepEqual(summary.due.daily, { total: 1, pending: 1 });
  assert.deepEqual(summary.due.weekly, { total: 1, pending: 0 });
  assert.equal(summary.nonconforming, 1);
  assert.equal(summary.withoutModel, 1);
});

test('checklist: criar modelo limpa os textos e recusa nome repetido, item em branco ou repetido', () => {
  const m = plan(data(), {
    type: 'save_model',
    name: '  Serra   circular — diário ',
    equipmentType: 'Serra circular',
    frequency: 'daily',
    items: [{ text: ' Coifa  instalada ' }, { text: 'Empurrador disponível' }],
  });
  assert.equal(m.workId, undefined);
  assert.equal(m.insert.models[0].name, 'Serra circular — diário');
  assert.deepEqual(
    m.insert.models[0].items.map(i => i.text),
    ['Coifa instalada', 'Empurrador disponível'],
  );
  const base = { type: 'save_model', equipmentType: 'Betoneira', frequency: 'daily' };
  assert.throws(() => plan(data(), { ...base, name: 'betoneira — DIÁRIO', items: [{ text: 'a' }] }), /Já existe um checklist/);
  assert.throws(() => plan(data(), { ...base, name: 'Novo', items: [] }), /pelo menos um item/);
  assert.throws(() => plan(data(), { ...base, name: 'Novo', items: [{ text: '  ' }] }), /em branco/);
  assert.throws(() => plan(data(), { ...base, name: 'Novo', items: [{ text: 'A' }, { text: 'a' }] }), /repetido/);
  assert.throws(() => parseChecklistCommand({ ...base, name: 'Novo', frequency: 'anual', items: [] }), /Periodicidade/);
});

test('checklist: editar modelo mantém o id dos itens que ficaram e a grafia do tipo que já existe', () => {
  const m = plan(data(), {
    type: 'save_model',
    id: 'm-dia',
    name: 'Betoneira — diário',
    equipmentType: 'betoneira',
    frequency: 'daily',
    items: [
      { id: 'i2', text: 'Aterramento conferido' },
      { id: 'de-outro-modelo', text: 'Chave liga/desliga' },
    ],
  });
  const saved = m.update.models[0];
  assert.equal(saved.equipmentType, 'Betoneira');
  assert.equal(saved.items[0].id, 'i2');
  assert.notEqual(saved.items[1].id, 'de-outro-modelo');
});

test('checklist: equipamento é da obra aberta e não repete o nome nela', () => {
  const m = plan(data(), { type: 'save_equipment', workId: 'obra-1', name: 'Betoneira 02', equipmentType: 'betoneira' });
  assert.equal(m.workId, 'obra-1');
  assert.equal(m.insert.equipment[0].equipmentType, 'Betoneira');
  assert.throws(
    () => plan(data(), { type: 'save_equipment', workId: 'obra-1', name: 'betoneira 01', equipmentType: 'Betoneira' }),
    /Já existe/,
  );
  const off = plan(data(), { type: 'set_equipment_active', id: 'e1', active: false });
  assert.equal(off.update.equipment[0].active, false);
  assert.deepEqual(checklistCommandTarget(parseChecklistCommand({ type: 'set_equipment_active', id: 'e1', active: false })), {
    table: 'equipment',
    id: 'e1',
  });
});

test('checklist: a inspeção guarda o texto dos itens e exige todos respondidos', () => {
  const m = plan(data(), { type: 'save_run', workId: 'obra-1', equipmentId: 'e1', modelId: 'm-dia', doneOn: TODAY, answers: answersOk });
  const saved = m.insert.runs[0];
  assert.equal(saved.modelName, 'Betoneira — diário');
  assert.equal(saved.frequency, 'daily');
  assert.deepEqual(
    saved.answers.map(a => a.text),
    ['Proteção das partes móveis', 'Aterramento'],
  );
  const base = { type: 'save_run', workId: 'obra-1', equipmentId: 'e1', modelId: 'm-dia', doneOn: TODAY };
  assert.throws(() => plan(data(), { ...base, answers: [answersOk[0]] }), /Responda o item "Aterramento"/);
  assert.throws(() => plan(data(), { ...base, answers: [...answersOk, { itemId: 'x', answer: 'c' }] }), /mudou enquanto/);
  assert.throws(() => plan(data(), { ...base, answers: [answersOk[0], { itemId: 'i2', answer: 'nc' }] }), /Descreva a não conformidade/);
  assert.throws(() => parseChecklistCommand({ ...base, answers: [{ itemId: 'i1', answer: 'ok' }] }), /Resposta inválida/);
});

test('checklist: recusa data futura, tipo diferente e modelo ou equipamento desativado; o dia repetido é aceito', () => {
  const base = { type: 'save_run', workId: 'obra-1', equipmentId: 'e1', modelId: 'm-dia', answers: answersOk };
  assert.throws(() => plan(data(), { ...base, doneOn: '2026-11-12' }), /futuro/);
  assert.throws(() => plan(data(), { ...base, doneOn: '2026-02-30' }), /Data inválida/);
  // 20/11/2026: o mesmo checklist aceita outra inspeção no mesmo dia (o equipamento usado por mais de uma pessoa).
  assert.equal(plan(data({ runs: [run()] }), { ...base, doneOn: TODAY }).insert.runs.length, 1);
  assert.throws(() => plan(data({ models: [model({ active: false })] }), { ...base, doneOn: TODAY }), /checklist está desativado/);
  assert.throws(() => plan(data({ equipment: [equipment({ active: false })] }), { ...base, doneOn: TODAY }), /equipamento está desativado/);
  assert.throws(() => plan(data({ equipment: [equipment({ equipmentType: 'Guincho' })] }), { ...base, doneOn: TODAY }), /é de Betoneira/);
});

test('checklist: editar a inspeção usa os itens que ela guardou, mesmo com o modelo já alterado', () => {
  const changed = model({ items: [{ id: 'i9', text: 'Item novo' }] });
  const d = data({ models: [changed], runs: [run()] });
  const m = plan(d, {
    type: 'save_run',
    id: 'r1',
    workId: 'obra-1',
    equipmentId: 'e1',
    modelId: 'm-dia',
    doneOn: '2026-11-10',
    answers: [
      { itemId: 'i1', answer: 'nc', note: 'correia exposta' },
      { itemId: 'i2', answer: 'na' },
    ],
  });
  const saved = m.update.runs[0];
  assert.equal(saved.doneOn, '2026-11-10');
  assert.equal(saved.answers[0].note, 'correia exposta');
  assert.equal(saved.answers[1].answer, 'na');
  const del = plan(d, { type: 'delete_run', id: 'r1' });
  assert.deepEqual(del.deleteRuns, ['r1']);
  assert.throws(() => plan(d, { type: 'delete_run', id: 'nao-existe' }), /não encontrada/);
});

// 12/11/2026: cadastro só com admin, link do operador (QR, sem login), assinatura e fotos.
const PNG = `iVBORw0KGgo${'A'.repeat(40)}`;
const JPEG = `/9j/${'A'.repeat(40)}`;

test('checklist: cadastro (modelo, equipamento, link do QR) é só do admin; TST segue nas inspeções', () => {
  assert.equal(canManageChecklist({ role: 'admin' }), true);
  assert.equal(canManageChecklist({ role: 'viewer', tst: true } as { role: string }), false);
  assert.equal(canManageChecklist(null), false);
  for (const type of [
    'save_model',
    'set_model_active',
    'save_equipment',
    'set_equipment_active',
    'set_equipment_models',
    'rotate_equipment_token',
  ])
    assert.equal(checklistCommandNeedsAdmin({ type } as never), true, type);
  for (const type of ['save_run', 'delete_run']) assert.equal(checklistCommandNeedsAdmin({ type } as never), false, type);
});

test('checklist: equipamento novo nasce com link próprio e "gerar novo link" troca o segredo', () => {
  const created = plan(data({ equipment: [] }), { type: 'save_equipment', workId: 'obra-1', name: 'Guincho 01', equipmentType: 'Guincho' });
  assert.match(created.insert.equipment[0].publicToken, /^[A-Za-z0-9_-]+$/);
  const rotated = plan(data(), { type: 'rotate_equipment_token', id: 'e1' });
  assert.notEqual(rotated.update.equipment[0].publicToken, equipment().publicToken);
  assert.deepEqual(checklistCommandTarget(parseChecklistCommand({ type: 'rotate_equipment_token', id: 'e1' })), {
    table: 'equipment',
    id: 'e1',
  });
  // Renomear não troca o link: a etiqueta colada continua valendo.
  const renamed = plan(data(), { type: 'save_equipment', id: 'e1', workId: 'obra-1', name: 'Betoneira A', equipmentType: 'Betoneira' });
  assert.equal(renamed.update.equipment[0].publicToken, equipment().publicToken);
  assert.equal(CHECKLIST_TOKEN.test('curto'), false);
  assert.equal(CHECKLIST_TOKEN.test('a'.repeat(32)), true);
  assert.equal(CHECKLIST_TOKEN.test(`${'a'.repeat(31)}/`), false);
});

test('checklist pelo QR: registra hoje com nome, assinatura e fotos, e os arquivos vão para a pasta da inspeção', () => {
  const input = parseOperatorRun({
    modelId: 'm-dia',
    answers: answersOk,
    operatorName: '  Carlos   Henrique da Silva ',
    operatorCompany: '  Construtora   Alfa ',
    signature: PNG,
    photos: [{ id: 'foto-1', data: JPEG }],
    // O que o operador tentar mandar a mais é ignorado: obra, equipamento, data e id são do servidor.
    workId: 'outra-obra',
    doneOn: '2026-01-01',
    id: 'r1',
  });
  const m = planOperatorRun(data(), input, ctx(), equipment());
  const saved = m.insert.runs[0];
  assert.equal(saved.workId, 'obra-1');
  assert.equal(saved.equipmentId, 'e1');
  assert.equal(saved.doneOn, TODAY);
  assert.equal(saved.source, 'link');
  assert.equal(saved.operatorName, 'Carlos Henrique da Silva');
  assert.equal(saved.operatorCompany, 'Construtora Alfa');
  assert.equal(saved.signedAt, NOW);
  assert.ok(saved.signaturePath?.startsWith(`obra-1/${saved.id}/assinatura-`));
  assert.deepEqual(saved.photos, [{ id: 'foto-1', path: `obra-1/${saved.id}/foto-1.jpg` }]);
  assert.deepEqual(
    m.uploads.map(u => [u.path, u.contentType]),
    [
      [saved.signaturePath, 'image/png'],
      [`obra-1/${saved.id}/foto-1.jpg`, 'image/jpeg'],
    ],
  );
});

test('checklist pelo QR: exige nome completo, empresa e assinatura, e aceita de novo o que já foi feito no período', () => {
  const base = { modelId: 'm-dia', answers: answersOk, operatorName: 'Carlos Silva', operatorCompany: 'Construtora Alfa', signature: PNG };
  const send = (d: ChecklistData, body: unknown) => planOperatorRun(d, parseOperatorRun(body), ctx(), equipment());
  assert.throws(() => send(data(), { ...base, operatorName: 'Carlos' }), /nome completo/);
  assert.throws(() => parseOperatorRun({ ...base, operatorCompany: undefined }), /operatorCompany/);
  assert.throws(() => send(data(), { ...base, operatorCompany: '   ' }), /Informe a empresa/);
  assert.throws(() => send(data(), { ...base, operatorCompany: 'x'.repeat(81) }), /Empresa do operador: até 80/);
  assert.throws(() => parseOperatorRun({ ...base, signature: undefined }), /signature/);
  assert.throws(() => send(data(), { ...base, signature: 'nao-e-png' }), /Assinatura inválida/);
  assert.throws(() => send(data(), { ...base, photos: [{ id: 'f1', data: PNG }] }), /Foto inválida/);
  assert.throws(() => send(data(), { ...base, photos: [{ id: '../x', data: JPEG }] }), /Foto inválida/);
  assert.throws(() => send(data(), { ...base, photos: [1, 2, 3, 4, 5].map(n => ({ id: `f${n}`, data: JPEG })) }), /até 4 fotos/);
  // Já feito hoje (por outra pessoa): o link aceita mais uma inspeção.
  assert.equal(send(data({ runs: [run()] }), base).insert.runs[0].operatorCompany, 'Construtora Alfa');
  assert.throws(() => send(data({ equipment: [equipment({ active: false })] }), base), /desativado/);
  // Semanal feito na segunda: na quarta da mesma semana o link aceita de novo.
  const weekly = model({ id: 'm-sem', name: 'Betoneira — semanal', frequency: 'weekly' });
  const done = run({ id: 'r-sem', modelId: 'm-sem', frequency: 'weekly', doneOn: '2026-11-09' });
  assert.equal(send(data({ models: [weekly], runs: [done] }), { ...base, modelId: 'm-sem' }).insert.runs[0].doneOn, TODAY);
  // A tela logada segue podendo repetir o semanal em outro dia da semana.
  const again = plan(data({ models: [weekly], runs: [done] }), {
    type: 'save_run',
    workId: 'obra-1',
    equipmentId: 'e1',
    modelId: 'm-sem',
    doneOn: TODAY,
    answers: answersOk,
  });
  assert.equal(again.insert.runs[0].source, 'app');
  assert.equal(again.insert.runs[0].signaturePath, null);
});

test('checklist: editar mantém assinatura e fotos, troca o que mudou e a exclusão leva os arquivos', () => {
  const signed = run({
    operatorName: 'Carlos Silva',
    signaturePath: 'obra-1/r1/assinatura-a.png',
    signedAt: NOW,
    photos: [
      { id: 'f1', path: 'obra-1/r1/f1.jpg' },
      { id: 'f2', path: 'obra-1/r1/f2.jpg' },
    ],
    source: 'link',
  });
  const d = data({ runs: [signed] });
  const base = { type: 'save_run', id: 'r1', workId: 'obra-1', equipmentId: 'e1', modelId: 'm-dia', doneOn: TODAY, answers: answersOk };
  const kept = plan(d, base).update.runs[0];
  assert.equal(kept.signaturePath, signed.signaturePath);
  assert.equal(kept.photos.length, 2);
  assert.equal(kept.operatorName, 'Carlos Silva');
  assert.equal(kept.source, 'link');
  const changed = plan(d, { ...base, signature: PNG, photos: [{ id: 'f2' }, { id: 'f3', data: JPEG }] });
  assert.deepEqual(
    changed.update.runs[0].photos.map(p => p.id),
    ['f2', 'f3'],
  );
  assert.deepEqual(changed.removeFiles.sort(), ['obra-1/r1/assinatura-a.png', 'obra-1/r1/f1.jpg']);
  assert.equal(changed.uploads.length, 2);
  assert.throws(() => plan(d, { ...base, photos: [{ id: 'f9' }] }), /Foto não encontrada/);
  assert.throws(() => plan(data(), { ...base, id: undefined, signature: PNG }), /nome de quem assina/);
  assert.deepEqual(plan(d, { type: 'delete_run', id: 'r1' }).removeFiles.sort(), [
    'obra-1/r1/assinatura-a.png',
    'obra-1/r1/f1.jpg',
    'obra-1/r1/f2.jpg',
  ]);
});

test('checklist pelo QR: o operador vê só os checklists do equipamento, com a situação e quem fez', () => {
  const weekly = model({ id: 'm-sem', name: 'Betoneira — semanal', frequency: 'weekly' });
  const other = equipment({ id: 'e2', name: 'Betoneira 02' });
  const d = data({
    models: [model(), weekly],
    equipment: [equipment(), other],
    runs: [run({ operatorName: 'José Almeida', source: 'link' }), run({ id: 'r2', equipmentId: 'e2' })],
  });
  const dues = operatorDues(d, 'e1', TODAY);
  assert.deepEqual(
    dues.map(due => [due.modelId, due.status, due.doneBy]),
    [
      ['m-dia', 'done', 'José Almeida'],
      ['m-sem', 'pending', ''],
    ],
  );
  assert.equal(dues[0].items.length, 2);
  assert.deepEqual(operatorDues(d, 'nao-existe', TODAY), []);
});

// 16/11/2026: escolher os checklists de cada QR (incluir de outro tipo, tirar um do tipo).
test('checklists do QR: o admin tira um modelo do tipo e inclui um de outro tipo; o quadro e o operador seguem a escolha', () => {
  const weekly = model({ id: 'm-sem', name: 'Betoneira — semanal', frequency: 'weekly' });
  const serra = model({ id: 'm-serra', name: 'Serra — diário', equipmentType: 'Serra circular' });
  const off = model({ id: 'm-off', name: 'Guincho antigo', equipmentType: 'Guincho', active: false });
  const d = data({ models: [model(), weekly, serra, off] });
  const command = parseChecklistCommand({ type: 'set_equipment_models', id: 'e1', modelIds: ['m-dia', 'm-serra'] });
  assert.deepEqual(checklistCommandTarget(command), { table: 'equipment', id: 'e1' });
  const m = planChecklistCommand(d, command, ctx(), 'obra-1');
  assert.deepEqual(m.equipmentModels, [{ id: 'e1', workId: 'obra-1', extraModelIds: ['m-serra'], hiddenModelIds: ['m-sem'] }]);
  // A escolha é gravada à parte: cadastrar, renomear e desativar não mexem nessas colunas.
  assert.equal(m.update.equipment.length, 0);

  const linked = equipment({ extraModelIds: ['m-serra'], hiddenModelIds: ['m-sem'] });
  const after = data({ models: [model(), weekly, serra, off], equipment: [linked] });
  assert.deepEqual(
    modelsFor(linked, after.models).map(x => x.id),
    ['m-dia', 'm-serra'],
  );
  assert.deepEqual(
    operatorDues(after, 'e1', TODAY).map(due => due.modelId),
    ['m-dia', 'm-serra'],
  );
  // Um modelo novo do tipo entra sozinho; o mesmo pedido de novo não grava nada.
  const fresh = model({ id: 'm-mes', name: 'Betoneira — mensal', frequency: 'monthly' });
  assert.deepEqual(
    modelsFor(linked, [...after.models, fresh]).map(x => x.id),
    ['m-dia', 'm-serra', 'm-mes'],
  );
  assert.deepEqual(plan(after, { type: 'set_equipment_models', id: 'e1', modelIds: ['m-serra', 'm-dia'] }).equipmentModels, []);
  // Desmarcar tudo vale: o QR abre sem checklists.
  assert.deepEqual(plan(after, { type: 'set_equipment_models', id: 'e1', modelIds: [] }).equipmentModels[0], {
    id: 'e1',
    workId: 'obra-1',
    extraModelIds: [],
    hiddenModelIds: ['m-dia', 'm-sem'],
  });
});

test('checklists do QR: modelo desativado guarda a marcação; recusa modelo inexistente, desativado e repetido', () => {
  const offExtra = model({ id: 'm-x', name: 'Guincho antigo', equipmentType: 'Guincho', active: false });
  const offHidden = model({ id: 'm-y', name: 'Betoneira antigo', active: false });
  const linked = equipment({ extraModelIds: ['m-x'], hiddenModelIds: ['m-y'] });
  const d = data({ models: [model(), offExtra, offHidden], equipment: [linked] });
  // Reativados depois, voltam como estavam: m-x incluído, m-y fora.
  assert.deepEqual(plan(d, { type: 'set_equipment_models', id: 'e1', modelIds: [] }).equipmentModels[0], {
    id: 'e1',
    workId: 'obra-1',
    extraModelIds: ['m-x'],
    hiddenModelIds: ['m-dia', 'm-y'],
  });
  assert.throws(() => plan(d, { type: 'set_equipment_models', id: 'e1', modelIds: ['nao-existe'] }), /não existe mais/);
  assert.throws(() => plan(d, { type: 'set_equipment_models', id: 'e1', modelIds: ['m-x'] }), /está desativado/);
  assert.throws(() => plan(d, { type: 'set_equipment_models', id: 'e1', modelIds: ['m-dia', 'm-dia'] }), /duas vezes/);
  assert.throws(() => plan(d, { type: 'set_equipment_models', id: 'e9', modelIds: [] }), /Equipamento não encontrado/);
  assert.throws(() => parseChecklistCommand({ type: 'set_equipment_models', id: 'e1', modelIds: 'm-dia' }), /modelIds/);
});

test('checklists do QR: inspeção nova só do que está ligado ao QR; a antiga segue editável', () => {
  const serra = model({ id: 'm-serra', name: 'Serra — diário', equipmentType: 'Serra circular' });
  const hidden = equipment({ hiddenModelIds: ['m-dia'], extraModelIds: ['m-serra'] });
  const d = data({ models: [model(), serra], equipment: [hidden] });
  const base = { type: 'save_run', workId: 'obra-1', equipmentId: 'e1', doneOn: TODAY, answers: answersOk };
  assert.throws(() => plan(d, { ...base, modelId: 'm-dia' }), /foi tirado do QR/);
  const included = plan(d, { ...base, modelId: 'm-serra' });
  assert.equal(included.insert.runs[0].modelId, 'm-serra');
  // Pelo link do operador vale a mesma escolha.
  assert.throws(
    () =>
      planOperatorRun(
        d,
        { modelId: 'm-dia', answers: answersOk as never, operatorName: 'José Almeida', operatorCompany: 'Alfa', signature: PNG },
        ctx(),
        {
          id: 'e1',
          workId: 'obra-1',
        },
      ),
    /foi tirado do QR/,
  );
  // A inspeção feita antes de tirar o modelo continua editável.
  const edited = plan(data({ models: [model(), serra], equipment: [hidden], runs: [run()] }), { ...base, id: 'r1', modelId: 'm-dia' });
  assert.equal(edited.update.runs[0].id, 'r1');
});

// ─── 17/11/2026: nº do equipamento ou pavimento, liberação e aviso ao TST ─────────────────────────────

const SIGNATURE = `iVBORw0KGgo${'A'.repeat(40)}`;
const redeU = () => model({ id: 'm-rede', name: 'Rede U (piso a piso)', frequency: 'weekly', asksLocation: true });
const fill = (over: Record<string, unknown> = {}) => ({
  type: 'save_run',
  workId: 'obra-1',
  equipmentId: 'e1',
  modelId: 'm-rede',
  doneOn: TODAY,
  answers: answersOk,
  ...over,
});

test('checklist com local: o modelo pede o nº do equipamento ou pavimento e a inspeção o guarda', () => {
  const created = plan(data(), {
    type: 'save_model',
    name: 'Rede U (piso a piso)',
    equipmentType: 'Betoneira',
    frequency: 'weekly',
    asksLocation: true,
    items: [{ text: 'Redes íntegras' }],
  });
  assert.equal(created.insert.models[0].asksLocation, true);
  // Sem o campo no comando, o modelo mantém o que tinha; modelo novo nasce sem pedir.
  const kept = plan(data({ models: [redeU()] }), {
    type: 'save_model',
    id: 'm-rede',
    name: 'Rede U',
    equipmentType: 'Betoneira',
    frequency: 'weekly',
    items: [{ id: 'i1', text: 'Redes íntegras' }],
  });
  assert.equal(kept.update.models[0].asksLocation, true);
  assert.equal(
    plan(data(), { type: 'save_model', name: 'Outro', equipmentType: 'Betoneira', frequency: 'daily', items: [{ text: 'x' }] }).insert
      .models[0].asksLocation,
    false,
  );
  assert.throws(() => parseChecklistCommand({ ...fill(), location: 3 }), /location/);

  const d = data({ models: [redeU()] });
  assert.throws(() => plan(d, fill()), /Informe o nº do equipamento ou o pavimento/);
  assert.throws(() => plan(d, fill({ location: '   ' })), /Informe o nº/);
  assert.throws(() => plan(d, fill({ location: 'x'.repeat(61) })), /até 60/);
  assert.equal(plan(d, fill({ location: '  3º   pavimento ' })).insert.runs[0].location, '3º pavimento');
  // Modelo que não pede não guarda local, mesmo que o comando traga um.
  assert.equal(plan(data(), fill({ modelId: 'm-dia', location: 'Térreo' })).insert.runs[0].location, '');
});

test('checklist com local: repete no período, por local e no mesmo local, na tela e pelo QR', () => {
  const done = run({ id: 'r-3', modelId: 'm-rede', frequency: 'weekly', doneOn: '2026-11-09', location: '3º Pavimento' });
  const d = data({ models: [redeU()], runs: [done] });
  // Outro pavimento no mesmo dia e na mesma semana: aceito.
  assert.equal(plan(d, fill({ doneOn: '2026-11-09', location: '4º pavimento' })).insert.runs[0].location, '4º pavimento');
  // O mesmo pavimento no mesmo dia: aceito desde 20/11/2026 (outra pessoa conferiu o mesmo lugar).
  assert.equal(plan(d, fill({ doneOn: '2026-11-09', location: '3º pavimento' })).insert.runs[0].location, '3º pavimento');
  assert.equal(plan(d, fill({ location: '3º pavimento' })).insert.runs.length, 1);

  const viaQr = (location: string) =>
    planOperatorRun(
      d,
      parseOperatorRun({
        modelId: 'm-rede',
        location,
        answers: answersOk,
        operatorName: 'José da Silva',
        operatorCompany: 'Alfa',
        signature: SIGNATURE,
      }),
      ctx(),
      {
        id: 'e1',
        workId: 'obra-1',
      },
    );
  assert.equal(viaQr('3º PAVIMENTO').insert.runs[0].location, '3º PAVIMENTO');
  assert.equal(viaQr('5º pavimento').insert.runs[0].location, '5º pavimento');
  assert.equal(
    parseOperatorRun({
      modelId: 'm-rede',
      location: 'Térreo',
      answers: answersOk,
      operatorName: 'a b',
      operatorCompany: 'c',
      signature: 'x',
    }).location,
    'Térreo',
  );

  // O quadro soma as inspeções do período; o operador vê os locais feitos e pode preencher outro.
  const bad = run({
    id: 'r-4',
    modelId: 'm-rede',
    frequency: 'weekly',
    location: '4º pavimento',
    answers: [
      { itemId: 'i1', text: 'Proteção das partes móveis', answer: 'nc', note: 'Rede rasgada' },
      { itemId: 'i2', text: 'Aterramento', answer: 'c', note: '' },
    ],
  });
  const both = data({ models: [redeU()], runs: [done, bad] });
  const due = checklistBoard(both, TODAY)[0].dues[0];
  assert.equal(due.status, 'nonconforming');
  assert.equal(due.periodRuns.length, 2);
  const [seen] = operatorDues(both, 'e1', TODAY);
  assert.equal(seen.asksLocation, true);
  assert.deepEqual(seen.doneLocations, ['3º Pavimento', '4º pavimento']);
  assert.deepEqual(doneLocations([done, done, bad, run({ location: '' })]), ['3º Pavimento', '4º pavimento']);
  // Editar a inspeção mantém o local quando o comando não o traz, e aceita a troca.
  const edit = { ...fill({ id: 'r-3', doneOn: '2026-11-09' }) };
  assert.equal(plan(both, edit).update.runs[0].location, '3º Pavimento');
  assert.equal(plan(both, { ...edit, location: '6º pavimento' }).update.runs[0].location, '6º pavimento');
  assert.equal(plan(both, { ...edit, doneOn: TODAY, location: '4º pavimento' }).update.runs[0].location, '4º pavimento');
});

test('liberação: periodicidade feita uma única vez, pendente até ser preenchida e depois feita para sempre', () => {
  assert.equal(periodKey('once', '2026-11-11'), 'once');
  assert.equal(periodKey('once', '2025-01-02'), 'once');
  const release = model({ id: 'm-lib', name: 'Liberação da betoneira', frequency: 'once' });
  assert.equal(
    plan(data(), { type: 'save_model', name: 'Liberação', equipmentType: 'Betoneira', frequency: 'once', items: [{ text: 'x' }] }).insert
      .models[0].frequency,
    'once',
  );
  const empty = data({ models: [release] });
  let summary = checklistSummary(checklistBoard(empty, TODAY));
  assert.deepEqual(summary.due.once, { total: 1, pending: 1 });
  const first = plan(empty, fill({ modelId: 'm-lib' }));
  assert.equal(first.insert.runs[0].frequency, 'once');

  // Liberado no ano anterior: segue feito, e não se registra de novo, nem pela tela nem pelo QR.
  const old = run({ id: 'r-lib', modelId: 'm-lib', frequency: 'once', doneOn: '2025-03-10' });
  const released = data({ models: [release], runs: [old] });
  const due = checklistBoard(released, TODAY)[0].dues[0];
  assert.equal(due.status, 'done');
  assert.equal(due.run?.id, 'r-lib');
  summary = checklistSummary(checklistBoard(released, TODAY));
  assert.deepEqual(summary.due.once, { total: 1, pending: 0 });
  assert.throws(() => plan(released, fill({ modelId: 'm-lib' })), /já foi registrada em 10\/03\/2025\. Abra a inspeção para editar/);
  assert.throws(
    () =>
      planOperatorRun(
        released,
        parseOperatorRun({
          modelId: 'm-lib',
          answers: answersOk,
          operatorName: 'José da Silva',
          operatorCompany: 'Alfa',
          signature: SIGNATURE,
        }),
        ctx(),
        {
          id: 'e1',
          workId: 'obra-1',
        },
      ),
    /já foi registrada em 10\/03\/2025\. Procure o técnico de segurança/,
  );
  // A própria liberação segue editável.
  assert.equal(plan(released, fill({ id: 'r-lib', modelId: 'm-lib', doneOn: '2025-03-11' })).update.runs[0].doneOn, '2025-03-11');

  // Com local, a liberação é uma por nº de equipamento ou pavimento.
  const perPlace = model({ id: 'm-lib', name: 'Liberação da betoneira', frequency: 'once', asksLocation: true });
  const some = data({ models: [perPlace], runs: [{ ...old, location: 'Betoneira 02' }] });
  assert.throws(() => plan(some, fill({ modelId: 'm-lib', location: 'betoneira 02' })), /\(betoneira 02\) já foi registrada/);
  assert.equal(plan(some, fill({ modelId: 'm-lib', location: 'Betoneira 03' })).insert.runs[0].location, 'Betoneira 03');
});

test('aviso ao TST: o e-mail da não conformidade leva o checklist, o local, quem preencheu e os itens', () => {
  const ok = run();
  assert.equal(checklistNcEmail(ok, { workName: 'Atmos', equipment: { name: 'GERAL' }, origin: 'https://site' }), null);
  const bad = run({
    id: 'r-nc',
    modelName: 'Grua grande porte — operador',
    location: 'Grua 02',
    operatorName: 'Paulo Sampaio',
    operatorCompany: 'Gruas Beta',
    source: 'link',
    createdBy: 'qr',
    answers: [
      { itemId: 'i1', text: 'Cabos de aço íntegros', answer: 'nc', note: 'Fio rompido no cabo de elevação' },
      { itemId: 'i2', text: 'Aterramento', answer: 'c', note: '' },
      { itemId: 'i3', text: 'Limitador de carga', answer: 'nc', note: 'Sem lacre' },
    ],
  });
  const email = checklistNcEmail(bad, { workName: 'Atmos', equipment: { name: 'GERAL' }, origin: 'https://site' })!;
  assert.equal(email.subject, 'Não conformidade no checklist: GERAL (Grua 02) · Grua grande porte — operador (Atmos)');
  assert.deepEqual(email.payload, {
    obra: 'Atmos',
    equipamento: 'GERAL',
    checklist: 'Grua grande porte — operador',
    periodicidade: 'Diário',
    local: 'Grua 02',
    operador: 'Paulo Sampaio (Gruas Beta)',
    origem: 'qr',
    data: '11/11/2026',
    total: 2,
    itens: [
      { texto: 'Cabos de aço íntegros', descricao: 'Fio rompido no cabo de elevação' },
      { texto: 'Limitador de carga', descricao: 'Sem lacre' },
    ],
    link: 'https://site/obras/obra-1/checklist',
  });
  assert.equal(checklistNcKey('r-nc', 'u1'), 'obra360.checklist_nc:r-nc:u1');

  // Sessenta itens não conformes com texto no limite: o payload fica abaixo do teto da fila (4096 bytes).
  const many = run({
    answers: Array.from({ length: 60 }, (_, i) => ({
      itemId: `i${i}`,
      text: 'ç'.repeat(200),
      answer: 'nc' as const,
      note: 'ã'.repeat(300),
    })),
  });
  const big = checklistNcEmail(many, { workName: 'Atmos', equipment: { name: 'GERAL' }, origin: 'https://site' })!;
  assert.equal(big.payload.total, 60);
  assert.ok(big.payload.itens.length >= 1 && big.payload.itens.length <= 10);
  assert.ok(new TextEncoder().encode(JSON.stringify({ primeiroNome: 'x'.repeat(40), ...big.payload })).length < 4096);
  assert.ok(big.subject.length <= 200);
});

// ─── 20/11/2026: empresa do operador e preenchimento repetido no dia ─────────────────────────────────

test('checklist: guarda a empresa do operador e aceita mais de uma inspeção do mesmo checklist no dia', () => {
  const base = { type: 'save_run', workId: 'obra-1', equipmentId: 'e1', modelId: 'm-dia', doneOn: TODAY, answers: answersOk };
  // Na tela logada a empresa é opcional; a edição mantém a que existe quando o comando não a traz.
  assert.equal(plan(data(), base).insert.runs[0].operatorCompany, '');
  assert.equal(plan(data(), { ...base, operatorCompany: ' Construtora  Alfa ' }).insert.runs[0].operatorCompany, 'Construtora Alfa');
  const first = run({ operatorName: 'José Almeida', operatorCompany: 'Alfa', source: 'link', createdBy: 'qr' });
  assert.equal(plan(data({ runs: [first] }), { ...base, id: 'r1' }).update.runs[0].operatorCompany, 'Alfa');
  assert.equal(plan(data({ runs: [first] }), { ...base, id: 'r1', operatorCompany: 'Beta' }).update.runs[0].operatorCompany, 'Beta');
  assert.equal(operatorLabel(first), 'José Almeida (Alfa)');
  assert.equal(operatorLabel(run({ operatorName: 'José Almeida' })), 'José Almeida');
  assert.equal(operatorLabel(run()), '');

  // Segunda pessoa no mesmo dia, pelo QR: entra, e o quadro passa a ter duas inspeções no período.
  const body = { modelId: 'm-dia', answers: answersOk, operatorName: 'Maria Souza', operatorCompany: 'Beta', signature: SIGNATURE };
  const send = (d: ChecklistData, input: unknown, now = NOW) =>
    planOperatorRun(d, parseOperatorRun(input), { ...ctx(), now }, { id: 'e1', workId: 'obra-1' });
  const second = send(data({ runs: [first] }), body).insert.runs[0];
  assert.equal(second.operatorCompany, 'Beta');
  const both = data({ runs: [first, { ...second, createdAt: '2026-11-11T12:30:00.000Z' }] });
  const [due] = operatorDues(both, 'e1', TODAY);
  assert.equal(due.doneCount, 2);
  assert.equal(due.canRepeat, true);
  assert.equal(due.doneBy, 'Maria Souza');
  assert.equal(due.doneCompany, 'Beta');
  assert.equal(checklistBoard(both, TODAY)[0].dues[0].periodRuns.length, 2);

  // O reenvio da mesma pessoa em menos de um minuto (toque dobrado, queda de sinal) não duplica; depois disso, sim.
  const mine = { ...body, operatorName: 'josé  almeida', operatorCompany: 'Alfa' };
  assert.throws(() => send(data({ runs: [first] }), mine, '2026-11-11T12:00:40.000Z'), /acabou de ser enviado por josé almeida/);
  assert.equal(send(data({ runs: [first] }), mine, '2026-11-11T12:02:00.000Z').insert.runs.length, 1);

  // A liberação segue única: feita, o QR não oferece preencher de novo.
  const release = model({ id: 'm-lib', name: 'Liberação', frequency: 'once' });
  const released = data({ models: [release], runs: [run({ id: 'r-lib', modelId: 'm-lib', frequency: 'once' })] });
  assert.equal(operatorDues(released, 'e1', TODAY)[0].canRepeat, false);
  assert.throws(() => send(released, { ...body, modelId: 'm-lib' }), /já foi registrada/);
});

// ─── 23/11/2026: tratativa do TST nas não conformidades e "não se aplica" no período ─────────────────

test('checklist: a tratativa do TST valida a não conformidade e acompanha a edição da inspeção', () => {
  const nc = run({
    id: 'r-nc',
    answers: [
      { itemId: 'i1', text: 'Proteção das partes móveis', answer: 'nc', note: 'Sem a tampa' },
      { itemId: 'i2', text: 'Aterramento', answer: 'nc', note: 'Fio solto' },
    ],
  });
  const base = data({ runs: [nc] });
  assert.equal(checklistBoard(base, TODAY)[0].dues[0].status, 'nonconforming');
  assert.equal(openNonConformities(nc), 2);
  assert.deepEqual(checklistCommandTarget({ type: 'treat_run', id: 'r-nc', treatments: [] }), { table: 'runs', id: 'r-nc' });
  assert.equal(checklistCommandNeedsAdmin({ type: 'treat_run', id: 'r-nc', treatments: [] }), false);

  // Um item tratado: segue vermelho, com um em aberto. O texto é limpo e assinado por quem gravou.
  const who = { ...ctx(), actorName: 'Renata TST' };
  const treat = (d: ChecklistData, treatments: { itemId: string; text: string }[], now = NOW) =>
    planChecklistCommand(d, parseChecklistCommand({ type: 'treat_run', id: 'r-nc', treatments }), { ...who, now }, 'obra-1');
  const one = treat(base, [{ itemId: 'i1', text: '  Tampa  recolocada ' }]).update.runs[0];
  assert.deepEqual(one.answers[0].treatment, { text: 'Tampa recolocada', by: 'tst-1', byName: 'Renata TST', at: NOW });
  assert.equal(one.answers[1].treatment, undefined);
  assert.equal(openNonConformities(one), 1);
  assert.equal(checklistBoard(data({ runs: [one] }), TODAY)[0].dues[0].status, 'nonconforming');

  // Os dois tratados: "tratada", fora da contagem de não conformidade em aberto. Texto igual não reassina.
  const later = '2026-11-11T15:00:00.000Z';
  const both = treat(
    data({ runs: [one] }),
    [
      { itemId: 'i1', text: 'Tampa recolocada' },
      { itemId: 'i2', text: 'Cobrado da empresa, prazo dia 30' },
    ],
    later,
  ).update.runs[0];
  assert.equal(both.answers[0].treatment?.at, NOW);
  assert.equal(both.answers[1].treatment?.at, later);
  const treated = data({ runs: [both] });
  assert.equal(checklistBoard(treated, TODAY)[0].dues[0].status, 'treated');
  const summary = checklistSummary(checklistBoard(treated, TODAY));
  assert.equal(summary.nonconforming, 0);
  assert.equal(summary.treated, 1);
  assert.equal(operatorDues(treated, 'e1', TODAY)[0].status, 'treated');
  // Nada mudou: nada a gravar. Texto vazio tira a tratativa.
  assert.equal(treat(treated, [{ itemId: 'i1', text: 'Tampa recolocada' }]).update.runs.length, 0);
  assert.equal(treat(treated, [{ itemId: 'i1', text: ' ' }]).update.runs[0].answers[0].treatment, undefined);

  // Só item não conforme desta inspeção recebe tratativa; o limite vale por item.
  const ok = data({ runs: [run({ id: 'r-nc' })] });
  assert.throws(() => treat(ok, [{ itemId: 'i1', text: 'x' }]), /mudou enquanto você escrevia/);
  assert.throws(() => treat(base, [{ itemId: 'i1', text: 'x'.repeat(301) }]), /até 300 caracteres/);
  assert.throws(
    () =>
      treat(base, [
        { itemId: 'i1', text: 'a' },
        { itemId: 'i1', text: 'b' },
      ]),
    /tratado duas vezes/,
  );

  // Editar a inspeção mantém a tratativa do item que segue não conforme e a tira do que passou a conforme.
  const edited = plan(treated, {
    type: 'save_run',
    id: 'r-nc',
    workId: 'obra-1',
    equipmentId: 'e1',
    modelId: 'm-dia',
    doneOn: TODAY,
    answers: [
      { itemId: 'i1', answer: 'nc', note: 'Sem a tampa' },
      { itemId: 'i2', answer: 'c' },
    ],
  }).update.runs[0];
  assert.equal(edited.answers[0].treatment?.text, 'Tampa recolocada');
  assert.equal('treatment' in edited.answers[1], false);
});

test('checklist: "não se aplica" tira o checklist dos pendentes do período, e a inspeção vale mais que a marca', () => {
  const weekly = model({ id: 'm-sem', name: 'Betoneira — semanal', frequency: 'weekly' });
  const release = model({ id: 'm-lib', name: 'Liberação', frequency: 'once' });
  const base = data({ models: [model(), weekly, release] });
  const skip = (d: ChecklistData, modelId: string, note?: string) =>
    plan(d, { type: 'skip_run', workId: 'obra-1', equipmentId: 'e1', modelId, ...(note !== undefined ? { note } : {}) });
  assert.deepEqual(checklistCommandTarget({ type: 'skip_run', workId: 'obra-1', equipmentId: 'e1', modelId: 'm-dia' }), {
    workId: 'obra-1',
  });
  assert.equal(checklistCommandNeedsAdmin({ type: 'skip_run', workId: 'obra-1', equipmentId: 'e1', modelId: 'm-dia' }), false);

  const mark = skip(base, 'm-dia', '  Sem serviço  no dia ').insert.runs[0];
  assert.equal(isSkippedRun(mark), true);
  assert.deepEqual([mark.doneOn, mark.note, mark.answers.length, mark.source], [TODAY, 'Sem serviço no dia', 0, 'app']);
  const marked = data({ models: base.models, runs: [mark] });
  const due = checklistBoard(marked, TODAY)[0].dues.find(d => d.model.id === 'm-dia')!;
  assert.deepEqual([due.status, due.run, due.periodRuns.length, due.skip?.id, due.lastDoneOn], ['skipped', null, 0, mark.id, null]);
  // Fora dos devidos e dos pendentes; o semanal segue pendente.
  const summary = checklistSummary(checklistBoard(marked, TODAY));
  assert.deepEqual(summary.due.daily, { total: 0, pending: 0 });
  assert.deepEqual(summary.due.weekly, { total: 1, pending: 1 });
  assert.equal(summary.skipped, 1);
  // No QR o operador ainda pode preencher, e a marca não conta como inspeção.
  const mine = operatorDues(marked, 'e1', TODAY).find(d => d.modelId === 'm-dia')!;
  assert.deepEqual([mine.status, mine.doneCount, mine.doneOn], ['skipped', 0, null]);
  assert.equal(awaitsRun('skipped'), true);
  assert.equal(awaitsRun('treated'), false);

  // Uma marca por período; com inspeção feita não há o que marcar; a liberação não tem dia.
  assert.throws(() => skip(marked, 'm-dia'), /já está marcado como não se aplica hoje/);
  assert.throws(() => skip(data({ models: base.models, runs: [run()] }), 'm-dia'), /já foi preenchido hoje/);
  assert.throws(() => skip(base, 'm-lib'), /A liberação não tem dia/);
  assert.equal(skip(marked, 'm-sem').insert.runs[0].frequency, 'weekly');
  assert.throws(() => skip(data({ models: base.models, equipment: [equipment({ active: false })] }), 'm-dia'), /desativado/);

  // A inspeção feita depois vale mais que a marca; a marca não se edita como inspeção e sai por exclusão.
  const filled = plan(marked, {
    type: 'save_run',
    workId: 'obra-1',
    equipmentId: 'e1',
    modelId: 'm-dia',
    doneOn: TODAY,
    answers: answersOk,
  });
  const after = data({ models: base.models, runs: [mark, filled.insert.runs[0]] });
  assert.equal(checklistBoard(after, TODAY)[0].dues.find(d => d.model.id === 'm-dia')!.status, 'done');
  assert.throws(
    () =>
      plan(marked, { type: 'save_run', id: mark.id, workId: 'obra-1', equipmentId: 'e1', modelId: 'm-dia', doneOn: TODAY, answers: [] }),
    /marca "não se aplica"/,
  );
  assert.deepEqual(plan(marked, { type: 'delete_run', id: mark.id }).deleteRuns, [mark.id]);
  // A marca de ontem não vale hoje.
  const yesterday = data({ models: base.models, runs: [{ ...mark, doneOn: '2026-11-10' }] });
  assert.equal(checklistBoard(yesterday, TODAY)[0].dues.find(d => d.model.id === 'm-dia')!.status, 'pending');
});

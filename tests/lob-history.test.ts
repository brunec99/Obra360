import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activityEnd,
  addWorkdays,
  emptyLobData,
  type LobActivity,
  type LobCommand,
  type LobData,
  type LobDependency,
} from '../src/domain/lob';
import { planLobCommand, type LobMutation } from '../src/application/use-cases/lob-commands';
import {
  buildLobHistoryEntry,
  describeLobHistory,
  lobHistoryAuthor,
  LOB_HISTORY_BLOCK_LIMIT,
  type LobHistoryNames,
  type LobHistoryRecord,
} from '../src/application/use-cases/lob-history';

/** Histórico da Linha de Balanço (25/11/2026): quem alterou, quando, o quê e as datas antes e depois.
 * A obra de teste tem três pacotes em quatro pavimentos: ACA (lixamento de teto) anda pavimento a
 * pavimento; cada DRY depende do ACA do mesmo pavimento e o DRY do 1º pavimento já começou; cada INF
 * depende do DRY do mesmo pavimento. */

const W = 'w';
const NOW = '2026-11-25T12:00:00.000Z';
let seq = 0;
const newId = () => `id-${++seq}`;
const context = { actorId: 'u1', now: NOW, today: '2026-11-25', newId };

const act = (
  id: string,
  serviceId: string,
  localId: string,
  start: string,
  durationDays: number,
  over: Partial<LobActivity> = {},
): LobActivity => ({
  id,
  workId: W,
  serviceId,
  localId,
  start,
  durationDays,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});
const dep = (predecessorId: string, successorId: string, lagDays = 0, kind: 'fs' | 'crew' = 'fs'): LobDependency => ({
  id: `${predecessorId}>${successorId}`,
  workId: W,
  predecessorId,
  successorId,
  lagDays,
  kind,
  createdAt: NOW,
});

function obra(): LobData {
  const data = emptyLobData();
  data.locals = ['1ºpavto', '2ºpavto', '3ºpavto', '4ºpavto'].map((name, i) => ({
    id: `L${i}`,
    workId: W,
    name,
    orderIndex: i,
    createdAt: NOW,
    updatedAt: NOW,
  }));
  data.services = [
    ['ACA', 'ACA - Lixamento de teto'],
    ['DRY', 'DRY - Estruturação'],
    ['INF', 'INF - Infra de drywall'],
  ].map(([id, name], i) => ({ id, workId: W, name, color: '#336699', orderIndex: i, createdAt: NOW, updatedAt: NOW }));
  const base = '2027-03-01'; // segunda-feira
  for (let i = 0; i < 4; i++) {
    data.activities.push(act(`ACA${i}`, 'ACA', `L${i}`, addWorkdays(base, 5 * i), 5));
    if (i) data.dependencies.push(dep(`ACA${i - 1}`, `ACA${i}`, 0, 'crew'));
  }
  for (let i = 0; i < 4; i++) {
    const start = activityEnd(data.activities.find(a => a.id === `ACA${i}`)!);
    data.activities.push(act(`DRY${i}`, 'DRY', `L${i}`, start, 5, i === 0 ? { actualStart: start } : {}));
    data.dependencies.push(dep(`ACA${i}`, `DRY${i}`));
    if (i) data.dependencies.push(dep(`DRY${i - 1}`, `DRY${i}`, 0, 'crew'));
  }
  for (let i = 0; i < 4; i++) {
    data.activities.push(act(`INF${i}`, 'INF', `L${i}`, activityEnd(data.activities.find(a => a.id === `DRY${i}`)!), 5));
    data.dependencies.push(dep(`DRY${i}`, `INF${i}`));
  }
  return data;
}
/** O caminho curto dos comandos de datas: só blocos, ligações e calendário, sem nomes. */
const schedule = (data: LobData): LobData => ({ ...emptyLobData(), activities: data.activities, dependencies: data.dependencies });
const namesOf = (data: LobData): LobHistoryNames => ({
  services: new Map(data.services.map(s => [s.id, s.name])),
  locals: new Map(data.locals.map(l => [l.id, l.name])),
  activities: new Map(data.activities.map(a => [a.id, { serviceId: a.serviceId, localId: a.localId }])),
  authors: new Map([['u1', 'Jorge Lucas']]),
});
const noNames: LobHistoryNames = { services: new Map(), locals: new Map(), activities: new Map(), authors: new Map() };

function record(before: LobData, command: LobCommand) {
  const mutation = planLobCommand(before, command, context);
  const entry = buildLobHistoryEntry(before, command, mutation, context);
  assert.ok(entry, `${command.type} deveria gerar registro`);
  return { entry, mutation };
}

test('move_service: guarda pedido e aplicado, datas de cada bloco e descreve o pacote', () => {
  const data = obra();
  const { entry, mutation } = record(schedule(data), { type: 'move_service', workId: W, serviceId: 'DRY', deltaDays: 5 });
  assert.equal(entry.entityType, 'lob');
  assert.equal(entry.entityId, W);
  assert.equal(entry.action, 'move_service');
  assert.equal(entry.authorId, 'u1');
  assert.equal(entry.occurredAt, NOW);
  assert.equal(entry.changes.v, 1);
  assert.equal(entry.changes.serviceId, 'DRY');
  assert.equal(entry.changes.deltaDays, 5);
  assert.equal(entry.changes.appliedDays, 5);
  assert.deepEqual(entry.changes.summary, { applied: 5, moved: 3, kept: 1, pushed: 3 });
  assert.equal(entry.changes.blocksTotal, mutation.update.activities.length);
  // Antes e depois de cada bloco: DRY1 começava em 15/03 e passa a 22/03 (5 dias úteis depois).
  const dry1 = entry.changes.blocks.find(b => b[0] === 'DRY1')!;
  assert.deepEqual(dry1, ['DRY1', '2027-03-15', 5, '2027-03-22', 5]);
  assert.ok(!entry.changes.blocks.some(b => b[0] === 'DRY0'), 'o bloco iniciado não andou');
  assert.deepEqual(describeLobHistory(entry, namesOf(data)), {
    text: 'Moveu o pacote DRY - Estruturação 5 dias úteis para a frente (3 blocos; 3 sucessoras empurradas; 1 iniciado ficou).',
    blocks: 6,
  });
});

test('move_service: antecipação travada diz quanto foi pedido', () => {
  const data = obra();
  // INF começa logo depois do DRY: para trás não anda nada; com folga de 2 dias, anda só 2 dos 5.
  data.activities = data.activities.map(a => (a.serviceId === 'INF' ? { ...a, start: addWorkdays(a.start, 2) } : a));
  const { entry } = record(schedule(data), { type: 'move_service', workId: W, serviceId: 'INF', deltaDays: -5 });
  assert.equal(entry.changes.deltaDays, -5);
  assert.equal(entry.changes.appliedDays, -2);
  assert.equal(
    describeLobHistory(entry, namesOf(data)).text,
    'Moveu o pacote INF - Infra de drywall 2 dias úteis para trás, dos 5 pedidos (4 blocos).',
  );
});

test('edit_service: guarda o pedido da janela, as ligações e a linha de base automática', () => {
  const data = obra();
  const command: LobCommand = {
    type: 'edit_service',
    workId: W,
    serviceId: 'INF',
    localIds: ['L0', 'L1', 'L2', 'L3'],
    durationDays: 8,
    rhythm: 'chain',
    lagDays: 0,
    rules: [{ serviceId: 'ACA', localOffset: 0, lagDays: 0 }],
    mode: 'replace',
  };
  const { entry, mutation } = record(data, command);
  assert.deepEqual(entry.changes.edit, {
    localCount: 4,
    durationDays: 8,
    rhythm: 'chain',
    lagDays: 0,
    rules: [{ serviceId: 'ACA', localOffset: 0, lagDays: 0 }],
    mode: 'replace',
  });
  assert.deepEqual(entry.changes.links, {
    added: mutation.insert.dependencies.length,
    removed: mutation.delete.dependencies.length,
    updated: mutation.update.dependencies.length,
  });
  assert.equal(entry.changes.links.added, 7); // 4 de ACA e 3 do encadeamento
  assert.equal(entry.changes.automaticBaseline, 'Antes da edição do pacote 25/11/2026');
  assert.equal(entry.changes.blocksTotal, 4);
  assert.deepEqual(describeLobHistory(entry, namesOf(data)), {
    text: 'Editou o pacote INF - Infra de drywall: 8 dias úteis, encadeado com espera 0, predecessora ACA - Lixamento de teto no mesmo local (4 blocos; +7 −0 ligações).',
    blocks: 4,
  });
});

test('revert_service_edit: acha o pacote pelas ligações devolvidas', () => {
  const data = obra();
  const edit: LobCommand = {
    type: 'edit_service',
    workId: W,
    serviceId: 'INF',
    localIds: ['L0', 'L1', 'L2', 'L3'],
    durationDays: 8,
    rhythm: 'keep',
    lagDays: 0,
    rules: [{ serviceId: 'ACA', localOffset: 0, lagDays: 1 }],
    mode: 'add',
  };
  const mutation = planLobCommand(data, edit, context);
  const after: LobData = {
    ...data,
    activities: data.activities.map(a => mutation.update.activities.find(u => u.id === a.id) ?? a),
    dependencies: [...data.dependencies, ...mutation.insert.dependencies],
  };
  const revert: LobCommand = {
    type: 'revert_service_edit',
    workId: W,
    items: data.activities
      .filter(a => a.serviceId === 'INF')
      .map(a => ({ activityId: a.id, start: a.start, durationDays: a.durationDays })),
    links: { remove: mutation.insert.dependencies.map(d => d.id), restore: [], update: [] },
  };
  const { entry } = record(after, revert);
  assert.equal(entry.changes.serviceId, 'INF');
  assert.equal(
    describeLobHistory(entry, namesOf(data)).text,
    'Desfez a edição do pacote INF - Infra de drywall (4 blocos; +0 −4 ligações).',
  );
  const first = describeLobHistory(buildLobHistoryEntry(data, edit, mutation, context)!, namesOf(data)).text;
  assert.equal(
    first,
    'Editou o pacote INF - Infra de drywall: 8 dias úteis, ritmo mantido, predecessora ACA - Lixamento de teto no mesmo local com espera 1, somada às atuais (4 blocos; +4 −0 ligações).',
  );
});

test('set_activity_dates: o "Desfazer" conta os blocos devolvidos', () => {
  const data = obra();
  const moved = planLobCommand(schedule(data), { type: 'move_service', workId: W, serviceId: 'DRY', deltaDays: 5 }, context);
  const after = schedule({ ...data, activities: data.activities.map(a => moved.update.activities.find(u => u.id === a.id) ?? a) });
  const items = data.activities
    .filter(a => moved.update.activities.some(u => u.id === a.id))
    .map(a => ({ activityId: a.id, start: a.start, durationDays: a.durationDays }));
  const { entry } = record(after, { type: 'set_activity_dates', workId: W, items });
  assert.equal(entry.changes.count, 6);
  assert.equal(entry.changes.blocksTotal, 6);
  const dry1 = entry.changes.blocks.find(b => b[0] === 'DRY1')!;
  assert.deepEqual(dry1, ['DRY1', '2027-03-22', 5, '2027-03-15', 5]);
  assert.deepEqual(describeLobHistory(entry, namesOf(data)), { text: 'Devolveu datas de 6 blocos (Desfazer).', blocks: 6 });
});

test('update_activity: mover o bloco guarda os dias úteis aplicados e as sucessoras empurradas', () => {
  const data = obra();
  const { entry } = record(schedule(data), { type: 'update_activity', activityId: 'ACA1', start: '2027-03-15' });
  assert.equal(entry.changes.activityId, 'ACA1');
  assert.deepEqual(entry.changes.refs, { ACA1: ['ACA', 'L1'] });
  assert.equal(entry.changes.start, '2027-03-15');
  assert.equal(entry.changes.appliedDays, 5);
  assert.equal(entry.changes.pushed, 8);
  assert.deepEqual(
    entry.changes.blocks.find(b => b[0] === 'ACA1'),
    ['ACA1', '2027-03-08', 5, '2027-03-15', 5],
  );
  assert.deepEqual(describeLobHistory(entry, namesOf(data)), {
    text: 'Moveu o bloco ACA - Lixamento de teto · 2ºpavto 5 dias úteis para a frente (8 sucessoras empurradas).',
    blocks: 9,
  });
});

test('update_activity: duração, datas reais e observação', () => {
  const data = obra();
  const duration = record(schedule(data), { type: 'update_activity', activityId: 'INF3', durationDays: 8 }).entry;
  assert.equal(duration.changes.previousDurationDays, 5);
  assert.equal(duration.changes.durationDays, 8);
  assert.equal(
    describeLobHistory(duration, namesOf(data)).text,
    'Mudou a duração do bloco INF - Infra de drywall · 4ºpavto de 5 para 8 dias úteis.',
  );
  const real = record(schedule(data), {
    type: 'update_activity',
    activityId: 'ACA0',
    actualStart: '2026-11-20',
    notes: 'Começou antes',
  }).entry;
  assert.deepEqual(real.changes.actualStart, [null, '2026-11-20']);
  assert.equal(real.changes.notesChanged, true);
  assert.equal(real.changes.blocksTotal, 0, 'datas planejadas não mudaram');
  assert.equal(
    describeLobHistory(real, namesOf(data)).text,
    'Alterou o bloco ACA - Lixamento de teto · 1ºpavto: início real 20/11/2026, observação editada.',
  );
});

test('save_costs: só contagens, nunca valor, descrição ou código', () => {
  const data = obra();
  const { entry } = record(data, {
    type: 'save_costs',
    workId: W,
    upsert: [
      {
        id: '8f8f8f8f-1111-4111-8111-111111111111',
        serviceId: 'DRY',
        code: '01.02.003',
        description: 'Drywall sigiloso',
        amount: 123456.78,
      },
      { id: '8f8f8f8f-2222-4222-8222-222222222222', serviceId: null, description: 'Item solto', amount: 999 },
    ],
    remove: [],
  });
  assert.deepEqual(entry.changes.costs, { inserted: 2, updated: 0, removed: 0 });
  const json = JSON.stringify(entry);
  for (const secret of ['123456', '999', 'sigiloso', 'Item solto', '01.02.003', 'amount', 'description'])
    assert.ok(!json.includes(secret), `o histórico não pode levar "${secret}"`);
  assert.equal(describeLobHistory(entry, namesOf(data)).text, 'Salvou a apropriação de custos (2 itens novos).');
});

test('comandos de medição não entram no histórico', () => {
  const data = obra();
  const empty = planLobCommand(data, { type: 'create_baseline', workId: W, name: 'Qualquer' }, context);
  const commands: LobCommand[] = [
    { type: 'open_measurement', workId: W, measurementId: 'm', date: '2026-11-25' },
    { type: 'update_measurement', measurementId: 'm', note: 'x' },
    { type: 'save_items', measurementId: 'm', items: [] },
    { type: 'remove_item', itemId: 'i' },
    { type: 'close_measurement', measurementId: 'm' },
    { type: 'delete_measurement', measurementId: 'm' },
    { type: 'add_photo', itemId: 'i', photoId: 'p', storagePath: 'a', thumbPath: 'b' },
    { type: 'delete_photo', photoId: 'p' },
  ];
  for (const command of commands) assert.equal(buildLobHistoryEntry(data, command, empty, context), null, command.type);
});

test('comando que não grava nada não vira registro', () => {
  const data = obra();
  const mutation = planLobCommand(data, { type: 'reorder_locals', workId: W, localIds: ['L0', 'L1', 'L2', 'L3'] }, context);
  assert.equal(
    buildLobHistoryEntry(data, { type: 'reorder_locals', workId: W, localIds: ['L0', 'L1', 'L2', 'L3'] }, mutation, context),
    null,
  );
});

test('corta as datas em 2000 blocos, com o total sempre exato', () => {
  const activities = Array.from({ length: 2500 }, (_, i) => act(`B${i}`, 'S', 'L', '2027-03-01', 5));
  const mutation: LobMutation = {
    workId: W,
    insert: { ...emptyLobData() },
    update: { ...emptyLobData(), activities: activities.map(a => ({ ...a, start: '2027-03-08' })) },
    delete: {
      locals: [],
      services: [],
      activities: [],
      dependencies: [],
      baselines: [],
      launches: [],
      measurements: [],
      items: [],
      photos: [],
      costs: [],
    },
    removeFiles: [],
    summary: { applied: 5, moved: 2500, kept: 0, pushed: 0 },
  };
  const entry = buildLobHistoryEntry(
    { activities, dependencies: [] },
    { type: 'move_service', workId: W, serviceId: 'S', deltaDays: 5 },
    mutation,
    context,
  )!;
  assert.equal(entry.changes.blocks.length, LOB_HISTORY_BLOCK_LIMIT);
  assert.equal(entry.changes.blocksTotal, 2500);
  assert.equal(describeLobHistory(entry, noNames).blocks, 2500);
});

test('nomes ausentes: pacote, bloco e local excluídos; autor sem perfil', () => {
  const data = obra();
  const moved = record(schedule(data), { type: 'move_service', workId: W, serviceId: 'DRY', deltaDays: 5 }).entry;
  assert.equal(
    describeLobHistory(moved, noNames).text,
    'Moveu o pacote excluído 5 dias úteis para a frente (3 blocos; 3 sucessoras empurradas; 1 iniciado ficou).',
  );
  // O bloco foi excluído depois, mas o registro guardou pacote e local: o nome sai pelos de hoje.
  const block = record(schedule(data), { type: 'update_activity', activityId: 'ACA1', start: '2027-03-15' }).entry;
  const withoutBlock = { ...namesOf(data), activities: new Map() };
  assert.match(describeLobHistory(block, withoutBlock).text, /^Moveu o bloco ACA - Lixamento de teto · 2ºpavto /);
  const withoutLocal = { ...withoutBlock, locals: new Map() };
  assert.match(describeLobHistory(block, withoutLocal).text, /^Moveu o bloco ACA - Lixamento de teto · local excluído /);
  assert.match(describeLobHistory(block, noNames).text, /^Moveu o bloco excluído 5 dias úteis/);
  const link = record(data, { type: 'add_dependency', workId: W, predecessorId: 'ACA3', successorId: 'INF0', lagDays: 2 }).entry;
  assert.equal(describeLobHistory(link, noNames).text, 'Ligou bloco excluído → bloco excluído (espera 2; 1 sucessora empurrada).');
  // Exclusões guardam o nome do momento.
  const deleted = record(data, { type: 'delete_service', serviceId: 'INF' }).entry;
  assert.equal(describeLobHistory(deleted, noNames).text, 'Excluiu o pacote INF - Infra de drywall (4 blocos; 4 ligações).');
  assert.equal(lobHistoryAuthor('u1', namesOf(data).authors), 'Jorge Lucas');
  assert.equal(lobHistoryAuthor('sumiu', namesOf(data).authors), 'Usuário removido');
});

test('registro fora do formato não quebra a frase', () => {
  const odd = {
    id: 'x',
    entityId: W,
    entityType: 'lob',
    action: 'acao_nova',
    authorId: 'u1',
    occurredAt: NOW,
    changes: {},
  } as unknown as LobHistoryRecord;
  assert.deepEqual(describeLobHistory(odd, noNames), { text: 'Alterou a Linha de Balanço.', blocks: 0 });
  const broken = { ...odd, action: 'edit_service', changes: { v: 1, edit: { rules: 'x' } } } as unknown as LobHistoryRecord;
  assert.equal(describeLobHistory(broken, noNames).text, 'Editou o pacote excluído: ritmo mantido.');
});

test('calendário, linhas de base, locais e ligações', () => {
  const data = obra();
  const names = namesOf(data);
  const calendar = record(data, {
    type: 'set_calendar',
    workId: W,
    calendar: { weekdays: [1, 2, 3, 4, 5, 6], holidays: ['2027-03-03', '2027-04-21'] },
  }).entry;
  assert.deepEqual(calendar.changes.calendar, {
    weekdaysFrom: [1, 2, 3, 4, 5],
    weekdaysTo: [1, 2, 3, 4, 5, 6],
    holidaysFrom: 0,
    holidaysTo: 2,
    added: ['2027-03-03', '2027-04-21'],
    addedTotal: 2,
    removed: [],
    removedTotal: 0,
  });
  assert.match(
    describeLobHistory(calendar, names).text,
    /^Mudou o calendário da obra \(dias trabalhados: segunda a sexta → segunda a sábado; 2 dias sem trabalho marcados \(03\/03\/2027, 21\/04\/2027\); \d+ (bloco mudou|blocos mudaram) de data\)\.$/,
  );
  const baseline = record(data, { type: 'create_baseline', workId: W, name: 'Aprovada pela diretoria' });
  assert.equal(describeLobHistory(baseline.entry, names).text, 'Guardou a linha de base "Aprovada pela diretoria".');
  const withBaseline = { ...data, baselines: baseline.mutation.insert.baselines };
  const moved = { ...withBaseline, activities: data.activities.map(a => (a.id === 'INF3' ? { ...a, start: '2027-06-01' } : a)) };
  const restored = record(moved, { type: 'restore_baseline', baselineId: baseline.mutation.insert.baselines[0].id }).entry;
  assert.equal(describeLobHistory(restored, names).text, 'Restaurou a linha de base "Aprovada pela diretoria" (1 bloco).');
  const locals = record(data, { type: 'create_locals', workId: W, names: ['Cobertura', 'Ático'] }).entry;
  assert.equal(describeLobHistory(locals, names).text, 'Cadastrou 2 locais: Cobertura, Ático.');
  const rename = record(data, { type: 'rename_local', localId: 'L0', name: 'Térreo' }).entry;
  assert.equal(describeLobHistory(rename, names).text, 'Renomeou o local 1ºpavto para Térreo.');
  const lag = record(data, { type: 'update_dependency', dependencyId: 'DRY0>INF0', lagDays: 2 }).entry;
  assert.equal(
    describeLobHistory(lag, names).text,
    'Mudou a espera da ligação DRY - Estruturação · 1ºpavto → INF - Infra de drywall · 1ºpavto de 0 para 2 dias úteis (1 sucessora empurrada).',
  );
  const removed = record(data, { type: 'remove_dependency', dependencyId: 'DRY0>INF0' }).entry;
  assert.equal(
    describeLobHistory(removed, names).text,
    'Removeu a ligação DRY - Estruturação · 1ºpavto → INF - Infra de drywall · 1ºpavto.',
  );
});

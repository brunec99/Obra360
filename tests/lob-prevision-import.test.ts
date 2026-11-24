import test from 'node:test';
import assert from 'node:assert/strict';
import { activityFinish, cascade, type LobLocal } from '../src/domain/lob';
import type { MspdiProject, MspdiTask } from '../src/domain/mspdi-import';
import {
  buildPrevisionImport,
  detachFlowIds,
  localGroup,
  previsionApiCalendar,
  readPrevisionApiSchedule,
  readPrevisionSchedule,
  type PrevisionApiProject,
  type PrevisionImportOptions,
} from '../src/domain/lob-prevision-import';

/** Novembro e dezembro de 2026: 02/11 é segunda-feira. */
let uid = 0;
const task = (name: string, level: number, start?: string, finish?: string, days?: number, percent = 0): MspdiTask => ({
  uid: ++uid,
  id: uid,
  name,
  active: true,
  manual: true,
  isNull: false,
  outlineLevel: level,
  summary: false,
  milestone: false,
  estimated: false,
  start: start && `${start}T09:00:00`,
  finish: finish && `${finish}T18:00:00`,
  duration: days ? `PT${days * 8}H0M0S` : undefined,
  percentComplete: percent,
  constraintType: 0,
  predecessorLinks: [],
  baselines: [],
});
const service = (name: string) => task(name, 1, '2026-11-02', '2026-12-18', 35);
const block = (local: string, start: string, finish: string, days: number, percent = 0) => task(local, 2, start, finish, days, percent);

/** Arquivo no formato do Prevision: serviço no nível 1, locais no nível 2, sem vínculos. */
function project(extra: MspdiTask[] = []): MspdiProject {
  return {
    title: 'Obra teste',
    minutesPerDay: 480,
    calendars: [],
    resources: [],
    assignments: [],
    tasks: [
      service('EST - Estrutura'),
      block('Térreo', '2026-11-02', '2026-11-06', 5, 100),
      block('2ºpavto', '2026-11-09', '2026-11-13', 5, 40),
      block('3ºpavto', '2026-11-16', '2026-11-20', 5),
      ...extra,
      service('ALV - Alvenaria'),
      block('Subsolo 01', '2026-11-09', '2026-11-13', 5),
      block('Térreo', '2026-11-16', '2026-11-20', 5),
      block('2ºpavto', '2026-11-23', '2026-11-27', 5),
      block('3ºpavto', '2026-11-30', '2026-12-04', 5),
      service('INF - Elétrica'),
      block('Térreo', '2026-11-23', '2026-11-27', 5),
      block('2ºpavto', '2026-11-30', '2026-12-04', 5),
      block('3ºpavto', '2026-12-07', '2026-12-11', 5),
      service('INF - Hidráulica'),
      block('Térreo', '2026-11-23', '2026-11-27', 5),
      block('2ºpavto', '2026-11-30', '2026-12-04', 5),
      block('3ºpavto', '2026-12-07', '2026-12-11', 5),
      service('REB - Reboco'),
      block('Térreo', '2026-11-30', '2026-12-04', 5),
      // 4 dias no calendário do Prevision num intervalo de 5 dias úteis: um feriado no meio.
      block('2ºpavto', '2026-12-07', '2026-12-11', 4),
      block('3ºpavto', '2026-12-14', '2026-12-18', 5),
      service('PRU - Prumada'),
      block('Hall - 2ºpavto', '2026-12-01', '2026-12-01', 1),
      block('Hall - 3ºpavto', '2026-12-02', '2026-12-02', 1),
      service('FAC - Balancim'),
      // O Prevision lista a fachada do último pano ao primeiro.
      block('Sul - 2 ao 9', '2026-12-07', '2026-12-11', 5),
      block('Sul - 10 ao 15', '2026-11-30', '2026-12-04', 5),
      service('EQP - Grua'),
      block('Equipamentos', '2026-11-02', '2026-12-18', 35, 30),
      service('EQP - Cremalheira'),
      block('Equipamentos', '2026-11-09', '2026-12-04', 20),
    ],
  };
}
let n = 0;
const options = (over: Partial<PrevisionImportOptions> = {}): PrevisionImportOptions => ({
  workId: 'obra-1',
  workName: 'Teste',
  actorId: 'user-1',
  now: '2026-11-11T12:00:00.000Z',
  newId: () => `id-${++n}`,
  measurementDate: '2026-11-11',
  sourceName: 'Teste.xml',
  ...over,
});

test('grupo do local pelo nome', () => {
  assert.equal(localGroup('Hall - 2ºpavto'), 'hall');
  assert.equal(localGroup('10º Pavimento'), 'pavimento_tipo');
  assert.equal(localGroup('5ºpavto'), 'pavimento_tipo');
  assert.equal(localGroup('Pavimento 3'), 'pavimento_tipo');
  assert.equal(localGroup('Térreo'), 'demais');
  assert.equal(localGroup('Caixa de água'), 'demais');
  assert.equal(localGroup('Leste - 2 ao 9'), 'fachada');
  assert.equal(localGroup('Equipamentos'), 'equipamentos');
});

test('leitura: serviços, blocos e locais de baixo para cima, com a fachada pela data de início', () => {
  const schedule = readPrevisionSchedule(project());
  assert.equal(schedule.services.length, 9);
  assert.equal(schedule.blocks.length, 22);
  assert.deepEqual(
    schedule.locals.map(l => l.name),
    ['Subsolo 01', 'Térreo', '2ºpavto', '3ºpavto', 'Hall - 2ºpavto', 'Hall - 3ºpavto', 'Sul - 10 ao 15', 'Sul - 2 ao 9', 'Equipamentos'],
  );
  const reboco = schedule.blocks.find(b => b.serviceName === 'REB - Reboco' && b.localName === '2ºpavto')!;
  assert.deepEqual([reboco.start, reboco.finish, reboco.workDays], ['2026-12-07', '2026-12-11', 4]);
  assert.deepEqual(schedule.warnings, []);
});

test('leitura: bloco repetido e serviço sem local viram aviso', () => {
  const schedule = readPrevisionSchedule(project([block('Térreo', '2026-11-09', '2026-11-13', 5)]));
  assert.equal(schedule.blocks.filter(b => b.serviceName === 'EST - Estrutura' && b.localName === 'Térreo').length, 1);
  assert.match(schedule.warnings.join(' '), /aparece duas vezes/);
  const lonely = readPrevisionSchedule({ ...project(), tasks: [...project().tasks, service('VAZ - Sem locais')] });
  assert.match(lonely.warnings.join(' '), /não tem locais/);
});

test('importação mantém as datas do Prevision e nada se move com as dependências', () => {
  const result = buildPrevisionImport(readPrevisionSchedule(project()), options());
  const schedule = readPrevisionSchedule(project());
  const localName = new Map(result.localOrder.map(l => [l.local.id, l.local.name]));
  const serviceName = new Map(result.services.map(s => [s.id, s.name]));
  for (const a of result.activities) {
    const original = schedule.blocks.find(b => b.serviceName === serviceName.get(a.serviceId) && b.localName === localName.get(a.localId))!;
    assert.equal(a.start, original.start);
    assert.equal(activityFinish(a), original.finish);
  }
  assert.equal(result.stats.withHolidays, 1);
  assert.deepEqual(cascade(result.activities, result.dependencies), []);
  assert.equal(result.baseline.snapshot.length, result.activities.length);
  // Serviços pela data do primeiro início: Estrutura e Grua começam em 02/11.
  assert.deepEqual(
    result.services.slice(0, 2).map(s => s.name),
    ['EST - Estrutura', 'EQP - Grua'],
  );
});

test('dependências: equipe segue entre locais e sequência dentro do local', () => {
  const result = buildPrevisionImport(readPrevisionSchedule(project()), options());
  const id = (svc: string, local: string) =>
    result.activities.find(
      a =>
        result.services.find(s => s.id === a.serviceId)!.name === svc &&
        result.localOrder.find(l => l.local.id === a.localId)!.local.name === local,
    )!.id;
  const find = (p: string, s: string) => result.dependencies.find(d => d.predecessorId === p && d.successorId === s);
  // Alvenaria: Subsolo → Térreo → 2º → 3º, uma semana atrás da outra.
  assert.deepEqual(
    [
      find(id('ALV - Alvenaria', 'Subsolo 01'), id('ALV - Alvenaria', 'Térreo'))?.kind,
      find(id('ALV - Alvenaria', 'Subsolo 01'), id('ALV - Alvenaria', 'Térreo'))?.lagDays,
    ],
    ['crew', 0],
  );
  // No 2º: Alvenaria depois da Estrutura com a espera de 5 dias do fluxo; as duas infras em paralelo
  // depois da Alvenaria; o Reboco depois das duas.
  assert.equal(find(id('EST - Estrutura', '2ºpavto'), id('ALV - Alvenaria', '2ºpavto'))?.lagDays, 5);
  assert.ok(find(id('ALV - Alvenaria', '2ºpavto'), id('INF - Elétrica', '2ºpavto')));
  assert.ok(find(id('ALV - Alvenaria', '2ºpavto'), id('INF - Hidráulica', '2ºpavto')));
  assert.ok(find(id('INF - Elétrica', '2ºpavto'), id('REB - Reboco', '2ºpavto')));
  assert.ok(find(id('INF - Hidráulica', '2ºpavto'), id('REB - Reboco', '2ºpavto')));
  assert.equal(find(id('INF - Elétrica', '2ºpavto'), id('INF - Hidráulica', '2ºpavto')), undefined);
  // Equipamentos não dependem uns dos outros.
  assert.equal(find(id('EQP - Grua', 'Equipamentos'), id('EQP - Cremalheira', 'Equipamentos')), undefined);
});

test('medição com o avanço do arquivo, datas reais e data inválida recusada', () => {
  const result = buildPrevisionImport(readPrevisionSchedule(project()), options());
  assert.equal(result.measurement?.status, 'closed');
  assert.equal(result.measurement?.date, '2026-11-11');
  assert.deepEqual(
    result.items.map(i => i.value).sort((a, b) => a - b),
    [30, 40, 100],
  );
  const done = result.activities.find(a => a.id === result.items.find(i => i.value === 100)!.activityId)!;
  assert.deepEqual([done.actualStart, done.actualFinish], ['2026-11-02', '2026-11-06']);
  const partial = result.activities.find(a => a.id === result.items.find(i => i.value === 40)!.activityId)!;
  assert.deepEqual([partial.actualStart, partial.actualFinish], ['2026-11-09', undefined]);
  assert.throws(
    () => buildPrevisionImport(readPrevisionSchedule(project()), options({ measurementDate: '2026-13-01' })),
    /Data da medição/,
  );
});

test('fluxo dos pavimentos tipo deduzido; demais pavimentos sem repetição não viram fluxo', () => {
  const result = buildPrevisionImport(readPrevisionSchedule(project()), options());
  assert.equal(result.flows.length, 1);
  const [tipo] = result.flows;
  assert.equal(tipo.group, 'pavimento_tipo');
  assert.equal(tipo.document.name, 'Pavimentos tipo — Teste');
  const byName = new Map(tipo.document.services.map(s => [s.name, s]));
  const nameOf = new Map(tipo.document.services.map(s => [s.id, s.name]));
  assert.deepEqual(
    tipo.document.services.map(s => s.name),
    ['EST - Estrutura', 'ALV - Alvenaria', 'INF - Elétrica', 'INF - Hidráulica', 'REB - Reboco'],
  );
  assert.deepEqual(byName.get('ALV - Alvenaria')!.predecessors, [{ serviceId: byName.get('EST - Estrutura')!.id, lagDays: 5 }]);
  assert.deepEqual(
    byName
      .get('REB - Reboco')!
      .predecessors.map(p => nameOf.get(p.serviceId))
      .sort(),
    ['INF - Elétrica', 'INF - Hidráulica'],
  );
  // Duração: a mais frequente; no empate (4 e 5), a menor.
  assert.equal(byName.get('REB - Reboco')!.durationDays, 4);
  assert.match(result.warnings.join(' '), /Demais pavimentos — Teste/);
});

test('fluxo para a empresa ganha ids próprios com as predecessoras refeitas', () => {
  const [tipo] = buildPrevisionImport(readPrevisionSchedule(project()), options()).flows;
  let k = 0;
  const detached = detachFlowIds(tipo.document, () => `novo-${++k}`);
  const ids = new Set(detached.services.map(s => s.id));
  assert.ok(detached.services.every(s => s.id.startsWith('novo-')));
  assert.ok(detached.services.every(s => s.predecessors.every(p => ids.has(p.serviceId))));
  assert.equal(detached.services.find(s => s.name === 'ALV - Alvenaria')!.predecessors[0].lagDays, 5);
});

test('locais já cadastrados na obra são reaproveitados pelo nome', () => {
  const existing: LobLocal = {
    id: 'L-terreo',
    workId: 'obra-1',
    name: 'térreo',
    orderIndex: 0,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
  const result = buildPrevisionImport(readPrevisionSchedule(project()), options({ existingLocals: [existing] }));
  assert.equal(result.locals.length, 8);
  assert.ok(result.locals.every(l => l.orderIndex >= 1));
  assert.equal(result.activities.filter(a => a.localId === 'L-terreo').length, 5);
});

test('calendário da obra: a duração importada conta os dias úteis dele e nada se move com as dependências', () => {
  // A obra já tem a quarta 09/12/2026 marcada como dia sem trabalho: é o feriado que o Prevision descontava no Reboco.
  const calendar = { weekdays: [1, 2, 3, 4, 5], holidays: ['2026-12-09'] };
  const schedule = readPrevisionSchedule(project(), calendar);
  const result = buildPrevisionImport(schedule, options({ calendar }));
  const serviceName = new Map(result.services.map(s => [s.id, s.name]));
  const localName = new Map(result.localOrder.map(l => [l.local.id, l.local.name]));
  const reboco = result.activities.find(a => serviceName.get(a.serviceId) === 'REB - Reboco' && localName.get(a.localId) === '2ºpavto')!;
  // 07 a 11/12 com a quarta parada: 4 dias úteis, como no Prevision (sem o calendário, seriam 5).
  assert.deepEqual([reboco.start, reboco.durationDays, activityFinish(reboco, calendar)], ['2026-12-07', 4, '2026-12-11']);
  for (const a of result.activities) {
    const original = schedule.blocks.find(b => b.serviceName === serviceName.get(a.serviceId) && b.localName === localName.get(a.localId))!;
    assert.deepEqual([a.start, activityFinish(a, calendar)], [original.start, original.finish]);
  }
  assert.deepEqual(cascade(result.activities, result.dependencies, calendar), []);
  // A linha de base da importação guarda o término de cada bloco.
  assert.equal(result.baseline.snapshot.find(e => e.activityId === reboco.id)!.finish, '2026-12-11');
});

// ─── Leitura pela API do Prevision (23/11/2026) ─────────────────────────────────

/** Obra no formato da API: três lotes (posição 1 = topo da tela do Prevision), dois serviços, um
 * feriado em 20/11/2026 (sexta) e as dependências reais. 02/11/2026 é segunda-feira. */
function apiProject(over: Partial<PrevisionApiProject> = {}): PrevisionApiProject {
  const activity = (
    id: string,
    serviceId: string,
    floorId: string,
    start: string,
    end: string,
    workDuration: number,
    percentageCompleted = 0,
    predecessors: PrevisionApiProject['activities'][number]['predecessors'] = [],
  ) => ({
    id,
    serviceId,
    floorId,
    startAt: `${start} 00:00:00 UTC`,
    endAt: `${end} 23:59:59 UTC`,
    workDuration,
    percentageCompleted,
    predecessors,
  });
  const after = (predecessorId: string, delay = 1) => ({
    predecessorId,
    baseAttribute: 'end_at',
    precedenceAttribute: 'start',
    timeOperation: 'after',
    delay,
  });
  return {
    id: '123',
    name: 'Obra API',
    scheduleType: 'lob',
    calendar: {
      startAt: '2026-01-01',
      endAt: '2027-12-31',
      holidays: ['2006-01-01', '2026-11-20', '2026-12-25', '2040-01-01'],
      weekWorkdays: { sunday: false, monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: false },
    },
    floors: [
      { id: 'f3', name: '3º pavto', position: 1 },
      { id: 'f2', name: '2º pavto', position: 2 },
      { id: 'f1', name: 'Térreo', position: 3 },
      { id: 'f0', name: 'Sem atividade', position: 4 },
    ],
    services: [
      { id: 's2', name: 'ALV - Alvenaria', position: 2, color: '#AA11CC' },
      { id: 's1', name: 'EST - Estrutura', position: 1, color: 'vermelho' },
    ],
    activities: [
      activity('a1', 's1', 'f1', '2026-11-02', '2026-11-06', 5, 100),
      activity('a2', 's1', 'f2', '2026-11-09', '2026-11-13', 5, 40, [after('a1')]),
      // Atravessa o feriado de 20/11: 5 dias úteis de 16/11 a 23/11.
      activity('a3', 's1', 'f3', '2026-11-16', '2026-11-23', 5, 0, [after('a2')]),
      // Cura de 10 dias corridos depois da estrutura do térreo (06/11 + 10 = 16/11).
      activity('b1', 's2', 'f1', '2026-11-16', '2026-11-19', 4, 0, [after('a1', 10)]),
      // Início → início com a alvenaria do térreo, 7 dias corridos depois, e folga real maior.
      activity('b2', 's2', 'f2', '2026-11-30', '2026-12-03', 4, 0, [
        { predecessorId: 'b1', baseAttribute: 'start_at', precedenceAttribute: 'start', timeOperation: 'after', delay: 7 },
        after('a2'),
      ]),
    ],
    ...over,
  };
}

test('API: calendário do Prevision só com os feriados da janela dele', () => {
  assert.deepEqual(previsionApiCalendar(apiProject()), { weekdays: [1, 2, 3, 4, 5], holidays: ['2026-11-20', '2026-12-25'] });
  // Sem os dias da semana marcados, vale segunda a sexta; sem janela, o período dos blocos.
  const bare = apiProject();
  bare.calendar = { holidays: ['2026-11-20', '2026-12-25'] };
  assert.deepEqual(previsionApiCalendar(bare), { weekdays: [1, 2, 3, 4, 5], holidays: ['2026-11-20'] });
});

test('API: blocos, ordem dos locais e dos serviços, cores e vínculos', () => {
  const project = apiProject();
  const schedule = readPrevisionApiSchedule(project, previsionApiCalendar(project));
  assert.deepEqual(
    schedule.locals.map(l => l.name),
    ['Térreo', '2º pavto', '3º pavto'],
  );
  assert.deepEqual(schedule.services, ['EST - Estrutura', 'ALV - Alvenaria']);
  assert.equal(schedule.blocks.length, 5);
  assert.deepEqual(schedule.blocks[2], {
    serviceName: 'EST - Estrutura',
    localName: '3º pavto',
    start: '2026-11-16',
    finish: '2026-11-23',
    workDays: 5,
    percent: 0,
  });
  assert.equal(schedule.links?.length, 5);
  assert.equal(schedule.colors?.get('ALV - Alvenaria'), '#AA11CC');
  assert.deepEqual(schedule.warnings, []);
});

test('API: recusa cronograma Gantt e avisa atividade sem lote, sem datas ou repetida', () => {
  assert.throws(() => readPrevisionApiSchedule(apiProject({ scheduleType: 'gantt' })), /não uma Linha de Balanço/);
  const project = apiProject();
  project.activities.push(
    { id: 'x1', serviceId: 's1', floorId: 'nao-existe', startAt: '2026-11-02', endAt: '2026-11-03', predecessors: [] },
    { id: 'x2', serviceId: 's2', floorId: 'f3', startAt: null, endAt: null, predecessors: [] },
    {
      id: 'x3',
      serviceId: 's1',
      floorId: 'f1',
      startAt: '2026-12-01',
      endAt: '2026-12-02',
      predecessors: [{ predecessorId: 'sumiu', baseAttribute: 'end_at', precedenceAttribute: 'start', timeOperation: 'after', delay: 1 }],
    },
  );
  const schedule = readPrevisionApiSchedule(project, previsionApiCalendar(project));
  assert.equal(schedule.blocks.length, 5);
  assert.equal(schedule.warnings.length, 4);
  assert.match(schedule.warnings.join('\n'), /sem lote ou serviço/);
  assert.match(schedule.warnings.join('\n'), /sem datas/);
  assert.match(schedule.warnings.join('\n'), /atividade em partes/);
  assert.match(schedule.warnings.join('\n'), /1 dependência/);
});

test('API: dependências reais, com a espera em dias úteis e sem mover nenhum bloco', () => {
  const project = apiProject();
  const calendar = previsionApiCalendar(project);
  const result = buildPrevisionImport(readPrevisionApiSchedule(project, calendar), options({ calendar, withFlows: false }));
  assert.deepEqual(result.flows, []);
  const name = (id: string) => {
    const a = result.activities.find(x => x.id === id)!;
    return `${result.services.find(s => s.id === a.serviceId)!.name.slice(0, 3)}/${result.localOrder.find(l => l.local.id === a.localId)!.local.name}`;
  };
  const deps = result.dependencies.map(d => `${name(d.predecessorId)} → ${name(d.successorId)} ${d.kind} ${d.lagDays}`).sort();
  assert.deepEqual(deps, [
    // Início → início + 7 dias corridos pede 23/11; a alvenaria do térreo libera em 23/11 (20/11 é feriado): espera 0.
    'ALV/Térreo → ALV/2º pavto crew 0',
    'EST/2º pavto → ALV/2º pavto fs 0',
    'EST/2º pavto → EST/3º pavto crew 0',
    // 10 dias corridos depois de 06/11 = 16/11: cinco dias úteis depois do fim da estrutura.
    'EST/Térreo → ALV/Térreo fs 5',
    'EST/Térreo → EST/2º pavto crew 0',
  ]);
  assert.deepEqual(result.stats.links, { total: 5, merged: 0, relaxed: 0 });
  assert.equal(cascade(result.activities, result.dependencies, calendar).length, 0);
  // A duração é a do Prevision (o feriado não conta) e o término fica na mesma data.
  const top = result.activities.find(a => name(a.id) === 'EST/3º pavto')!;
  assert.equal(top.durationDays, 5);
  assert.equal(activityFinish(top, calendar), '2026-11-23');
  assert.equal(result.stats.withHolidays, 0);
  // Cor do Prevision quando é #rrggbb; senão, a da paleta.
  assert.equal(result.services.find(s => s.name === 'ALV - Alvenaria')!.color, '#aa11cc');
  assert.match(result.services.find(s => s.name === 'EST - Estrutura')!.color, /^#[0-9a-f]{6}$/);
  assert.equal(result.items.length, 2);
});

test('API: espera maior que a folga real é reduzida, e par repetido fica com a mais exigente', () => {
  const project = apiProject();
  // A regra do Prevision pediria 30 dias corridos, mas as datas dele deixam só a sequência direta.
  project.activities[1].predecessors = [
    { predecessorId: 'a1', baseAttribute: 'end_at', precedenceAttribute: 'start', timeOperation: 'after', delay: 30 },
    { predecessorId: 'a1', baseAttribute: 'start_at', precedenceAttribute: 'start', timeOperation: 'after', delay: 0 },
  ];
  const calendar = previsionApiCalendar(project);
  const result = buildPrevisionImport(readPrevisionApiSchedule(project, calendar), options({ calendar, withFlows: false }));
  assert.deepEqual(result.stats.links, { total: 6, merged: 1, relaxed: 1 });
  const first = result.activities[0];
  const second = result.activities[1];
  const dep = result.dependencies.find(d => d.predecessorId === first.id && d.successorId === second.id)!;
  assert.equal(dep.lagDays, 0);
  assert.equal(cascade(result.activities, result.dependencies, calendar).length, 0);
});

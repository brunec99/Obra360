import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dailyPhotoPaths,
  type DailyCompanyLink,
  type DailyCrew,
  type DailyLocal,
  type DailyPhoto,
  type DailyReport,
  type SiengeOption,
} from '../src/domain/daily-report';
import {
  matchSiengeUsers,
  SIENGE_SHIFT,
  SIENGE_WEATHER,
  buildSiengeDailyReport,
  isDailyShiftTimeValid,
  isDailyTime,
  resolveCrewTypeId,
  siengePhotoQuery,
  type SiengeBuildInput,
} from '../src/domain/sienge-daily-report';

/** Diário de Obra (2.4), 24/11/2026: o corpo que vai ao Sienge, os bloqueios e os avisos da conferência. */

const W = 'obra-1';
const NOW = '2026-11-24T15:00:00.000Z';

const LOCALS: DailyLocal[] = [
  { id: 'loc-1', name: 'Torre A', siengeSiteId: 11 },
  { id: 'loc-2', name: 'Subsolo', siengeSiteId: null },
];
const CREW_TYPES: SiengeOption[] = [
  { id: 1, label: 'ATR' },
  { id: 2, label: 'Carpintaria' },
  { id: 3, label: 'HIDROTEC ' },
  { id: 4, label: 'Mista' },
];
const LINKS: DailyCompanyLink[] = [{ companyKey: 'awa', company: 'AWA', crewTypeId: 2 }];

const report = (over: Partial<DailyReport> = {}): DailyReport => ({
  id: 'r-1',
  workId: W,
  date: '2026-11-23',
  status: 'draft',
  shifts: [
    { key: 'morning', startTime: '08:00', finishTime: '12:00', weather: 'fine' },
    { key: 'afternoon', startTime: '13:00', finishTime: '17:00', weather: 'light_rain' },
  ],
  rainfall: 4.5,
  notes: ' Dia normal. ',
  tasks: [
    {
      id: 't-1',
      description: 'Alvenaria do 3º',
      quantity: 12.5,
      unit: 'm2',
      localId: 'loc-1',
      notes: 'bloco cerâmico',
      commitmentId: null,
    },
    { id: 't-2', description: 'Limpeza', quantity: null, unit: '', localId: null, notes: '', commitmentId: null },
  ],
  events: [{ id: 'e-1', typeId: 7, typeLabel: 'Visita', description: 'Visita do cliente' }],
  equipments: [{ id: 'q-1', typeId: 9, typeLabel: 'Betoneira', quantity: 2, status: 'out_of_order' }],
  siengeBuildingId: null,
  siengeId: null,
  sentAt: null,
  sentBy: null,
  lastError: '',
  version: 2,
  createdBy: 'u-1',
  createdAt: NOW,
  updatedBy: 'u-1',
  updatedAt: NOW,
  ...over,
});
const photo = (id: string, over: Partial<DailyPhoto> = {}): DailyPhoto => ({
  id,
  reportId: 'r-1',
  workId: W,
  ...dailyPhotoPaths(W, 'r-1', id),
  description: 'Concretagem',
  localId: 'loc-1',
  showInReports: true,
  siengeStatus: 'pending',
  siengeError: '',
  createdBy: 'u-1',
  createdAt: NOW,
  ...over,
});
const CREWS: DailyCrew[] = [
  { company: 'AWA', role: 'Carpinteiro', quantity: 5 },
  { company: 'AWA', role: 'Servente', quantity: 2 },
  { company: 'ATR', role: 'Engenheiro', quantity: 1 },
  { company: 'Hidrotec', role: 'Encanador', quantity: 4 },
];
const input = (
  over: Partial<Omit<SiengeBuildInput, 'support'>> = {},
  support: Partial<SiengeBuildInput['support']> = {},
): SiengeBuildInput => ({
  report: report(),
  crews: CREWS,
  photos: [photo('p-1')],
  ...over,
  support: { siengeBuildingId: 32, locals: LOCALS, companyLinks: LINKS, crewTypes: CREW_TYPES, siengeUserCode: 'BRUNO', ...support },
});

test('hora do turno: HH:mm e fim depois do início', () => {
  assert.ok(isDailyTime('00:00') && isDailyTime('23:59'));
  assert.ok(!isDailyTime('24:00') && !isDailyTime('8:00') && !isDailyTime('08:60') && !isDailyTime(800));
  assert.ok(isDailyShiftTimeValid({ startTime: '08:00', finishTime: '12:00' }));
  assert.ok(!isDailyShiftTimeValid({ startTime: '12:00', finishTime: '12:00' }));
});

test('tipo de equipe: a ligação manual vence; depois, o nome igual no Sienge', () => {
  assert.equal(resolveCrewTypeId(' awa ', LINKS, CREW_TYPES), 2, 'ligação manual');
  assert.equal(resolveCrewTypeId('hidrotec', LINKS, CREW_TYPES), 3, 'mesmo nome, sem caixa nem espaço');
  assert.equal(resolveCrewTypeId('ATR', [{ companyKey: 'atr', company: 'ATR', crewTypeId: 4 }], CREW_TYPES), 4, 'a ligação vence o nome');
  assert.equal(resolveCrewTypeId('Desconhecida', LINKS, CREW_TYPES), null);
  assert.equal(resolveCrewTypeId('  ', LINKS, [{ id: 9, label: '' }]), null);
});

test('corpo completo, no formato do Sienge', () => {
  const result = buildSiengeDailyReport(input());
  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.body, {
    buildingId: 32,
    date: '2026-11-23',
    notes: 'Dia normal.',
    responsibleId: 'BRUNO',
    rainfallIndex: 4.5,
    shifts: [
      { description: SIENGE_SHIFT.morning, startTime: '08:00', finishTime: '12:00', weatherCondition: SIENGE_WEATHER.fine },
      { description: SIENGE_SHIFT.afternoon, startTime: '13:00', finishTime: '17:00', weatherCondition: SIENGE_WEATHER.light_rain },
    ],
    detachedTasks: [
      { description: 'Alvenaria do 3º', notes: 'bloco cerâmico', quantity: 12.5, unitOfMeasure: 'm2', siteId: 11 },
      { description: 'Limpeza' },
    ],
    events: [{ description: 'Visita do cliente', eventTypeId: 7 }],
    crews: [
      { crewTypeId: 2, quantity: 7, assignment: 'THIRD_PARTY' },
      { crewTypeId: 1, quantity: 1, assignment: 'DIRECT_LABOR' },
      { crewTypeId: 3, quantity: 4, assignment: 'THIRD_PARTY' },
    ],
    equipments: [{ equipmentTypeId: 9, quantity: 2, status: 'OUT_OF_ORDER' }],
  });
});

test('opcionais vazios ficam fora do corpo', () => {
  const result = buildSiengeDailyReport(
    input(
      {
        report: report({
          shifts: [{ key: 'night', startTime: '18:00', finishTime: '22:00', weather: 'unworkable' }],
          rainfall: null,
          notes: '   ',
          tasks: [{ id: 't-1', description: 'Vigia', quantity: 0, unit: '', localId: null, notes: ' ', commitmentId: null }],
          events: [],
          equipments: [],
        }),
        crews: [],
        photos: [],
      },
      { siengeUserCode: ' MARIA.SILVA ' },
    ),
  );
  assert.deepEqual(result.body, {
    buildingId: 32,
    date: '2026-11-23',
    responsibleId: 'MARIA.SILVA',
    shifts: [{ description: SIENGE_SHIFT.night, startTime: '18:00', finishTime: '22:00', weatherCondition: SIENGE_WEATHER.unworkable }],
    detachedTasks: [{ description: 'Vigia' }],
  });
  assert.deepEqual(Object.keys(buildSiengeDailyReport(input({ report: report({ tasks: [], rainfall: 0 }) })).body!).sort(), [
    'buildingId',
    'crews',
    'date',
    'equipments',
    'events',
    'notes',
    'rainfallIndex',
    'responsibleId',
    'shifts',
  ]);
  assert.equal(buildSiengeDailyReport(input({ report: report({ rainfall: 0 }) })).body!.rainfallIndex, 0, 'zero é informado');
});

test('turnos saem na ordem manhã, tarde, noite', () => {
  const result = buildSiengeDailyReport(
    input({
      report: report({
        shifts: [
          { key: 'night', startTime: '18:00', finishTime: '22:00', weather: 'heavy_rain' },
          { key: 'morning', startTime: '08:00', finishTime: '12:00', weather: 'fine' },
        ],
      }),
    }),
  );
  assert.deepEqual(
    result.body!.shifts.map(s => [s.description, s.weatherCondition]),
    [
      [SIENGE_SHIFT.morning, SIENGE_WEATHER.fine],
      [SIENGE_SHIFT.night, SIENGE_WEATHER.heavy_rain],
    ],
  );
});

test('mão de obra: soma por tipo de equipe; própria com terceira no mesmo tipo vai como terceira', () => {
  const links: DailyCompanyLink[] = [
    { companyKey: 'atr', company: 'ATR', crewTypeId: 4 },
    { companyKey: 'takt', company: 'Takt', crewTypeId: 4 },
    { companyKey: 'awa', company: 'AWA', crewTypeId: 2 },
    { companyKey: 'trento', company: 'Trento', crewTypeId: 2 },
  ];
  const own = buildSiengeDailyReport(
    input(
      {
        crews: [
          { company: 'ATR', role: 'Engenheiro', quantity: 1 },
          { company: 'Takt', role: 'Mestre', quantity: 2 },
          { company: 'AWA', role: 'Carpinteiro', quantity: 5 },
          { company: 'Trento', role: 'Carpinteiro', quantity: 3 },
          { company: 'AWA', role: 'Fantasma', quantity: 0 },
        ],
      },
      { companyLinks: links },
    ),
  );
  assert.deepEqual(own.body!.crews, [
    { crewTypeId: 4, quantity: 3, assignment: 'DIRECT_LABOR' },
    { crewTypeId: 2, quantity: 8, assignment: 'THIRD_PARTY' },
  ]);
  const mixed = buildSiengeDailyReport(
    input(
      {
        crews: [
          { company: 'ATR', role: 'Engenheiro', quantity: 1 },
          { company: 'AWA', role: 'Carpinteiro', quantity: 5 },
        ],
      },
      { companyLinks: [links[0], { companyKey: 'awa', company: 'AWA', crewTypeId: 4 }] },
    ),
  );
  assert.deepEqual(mixed.body!.crews, [{ crewTypeId: 4, quantity: 6, assignment: 'THIRD_PARTY' }]);
});

test('bloqueios: sem empreendimento, sem turno, hora inválida, foto sem descrição', () => {
  const noBuilding = buildSiengeDailyReport(input({}, { siengeBuildingId: null }));
  assert.equal(noBuilding.body, null);
  assert.deepEqual(noBuilding.blocking, ['A obra não está ligada a um empreendimento do Sienge.']);

  const noShift = buildSiengeDailyReport(input({ report: report({ shifts: [] }) }));
  assert.equal(noShift.body, null);
  assert.match(noShift.blocking[0], /ao menos um turno/);

  const badTime = buildSiengeDailyReport(
    input({
      report: report({
        shifts: [
          { key: 'morning', startTime: '12:00', finishTime: '08:00', weather: 'fine' },
          { key: 'afternoon', startTime: '13h', finishTime: '17:00', weather: 'fine' },
        ],
      }),
    }),
  );
  assert.equal(badTime.body, null);
  assert.equal(badTime.blocking.length, 2);
  assert.match(badTime.blocking[0], /Turno Manhã: horário inválido/);
  assert.match(badTime.blocking[1], /Turno Tarde: horário inválido/);

  const noDescription = buildSiengeDailyReport(
    input({
      photos: [
        photo('p-1', { description: '  ' }),
        photo('p-2', { description: '' }),
        photo('p-3', { description: '', siengeStatus: 'sent' }),
      ],
    }),
  );
  assert.equal(noDescription.body, null);
  assert.match(noDescription.blocking[0], /^2 fotos sem descrição/, 'a que já está no Sienge não conta');
  assert.match(buildSiengeDailyReport(input({ photos: [photo('p-1', { description: '' })] })).blocking[0], /^1 foto sem descrição/);

  // Os bloqueios se somam e os avisos continuam aparecendo.
  const all = buildSiengeDailyReport(
    input({ report: report({ shifts: [] }), photos: [photo('p-1', { localId: null })] }, { siengeBuildingId: null, siengeUserCode: '' }),
  );
  assert.equal(all.blocking.length, 3);
  assert.equal(all.warnings.length, 1);

  // Sem o usuário do Sienge ligado o envio é impedido (decisão de 24/11/2026): o Sienge gravaria SIENGEAPI.
  const noUser = buildSiengeDailyReport(input({}, { siengeUserCode: '  ' }));
  assert.equal(noUser.body, null);
  assert.deepEqual(noUser.blocking, [
    'Ligue seu usuário do Sienge antes de enviar (em "Ligações com o Sienge"): ele vai como responsável do diário.',
  ]);
});

test('avisos: empresa sem tipo de equipe, atividade e foto sem local do Sienge', () => {
  const result = buildSiengeDailyReport(
    input({
      report: report({
        tasks: [
          { id: 't-1', description: 'Escavação', quantity: 3, unit: 'm3', localId: 'loc-2', notes: '', commitmentId: null },
          { id: 't-2', description: 'Forma', quantity: null, unit: '', localId: 'loc-apagado', notes: '', commitmentId: null },
          { id: 't-3', description: 'Alvenaria', quantity: null, unit: '', localId: 'loc-1', notes: '', commitmentId: null },
        ],
      }),
      crews: [
        ...CREWS,
        { company: 'Zeta Pinturas', role: 'Pintor', quantity: 2 },
        { company: 'Beta Gesso', role: 'Gesseiro', quantity: 3 },
        { company: 'beta gesso', role: 'Ajudante', quantity: 1 },
      ],
      photos: [
        photo('p-1'),
        photo('p-2', { localId: null, showInReports: false }),
        photo('p-3', { localId: 'loc-2' }),
        photo('p-4', { localId: null, siengeStatus: 'sent' }),
      ],
    }),
  );
  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.warnings, [
    '2 fotos sem local ligado ao Sienge: ficam fora do Relatório Fotográfico.',
    'Empresas sem tipo de equipe no Sienge (a mão de obra delas não segue): Beta Gesso, Zeta Pinturas.',
    '2 atividades com local sem código do Sienge: vão sem local.',
  ]);
  const body = result.body!;
  assert.equal(body.responsibleId, 'BRUNO');
  assert.deepEqual(body.detachedTasks, [
    { description: 'Escavação', quantity: 3, unitOfMeasure: 'm3' },
    { description: 'Forma' },
    { description: 'Alvenaria', siteId: 11 },
  ]);
  assert.equal(
    body.crews!.reduce((sum, crew) => sum + crew.quantity, 0),
    12,
    'as empresas sem tipo de equipe não seguem',
  );

  const single = buildSiengeDailyReport(
    input({
      report: report({
        tasks: [{ id: 't-1', description: 'Escavação', quantity: null, unit: '', localId: 'loc-2', notes: '', commitmentId: null }],
      }),
      crews: [{ company: 'Zeta Pinturas', role: 'Pintor', quantity: 2 }],
      photos: [photo('p-2', { localId: null })],
    }),
  );
  assert.deepEqual(single.warnings, [
    '1 foto sem local ligado ao Sienge: fica fora do Relatório Fotográfico.',
    'Empresa sem tipo de equipe no Sienge (a mão de obra dela não segue): Zeta Pinturas.',
    '1 atividade com local sem código do Sienge: vai sem local.',
  ]);
  assert.equal(single.body!.crews, undefined);
});

test('parâmetros do anexo: local e relatório só com o local ligado ao Sienge', () => {
  assert.deepEqual(siengePhotoQuery(photo('p-1', { description: ' Laje ' }), LOCALS), {
    description: 'Laje',
    localId: 11,
    showInReports: true,
  });
  assert.deepEqual(siengePhotoQuery(photo('p-1', { showInReports: false }), LOCALS), {
    description: 'Concretagem',
    localId: 11,
    showInReports: false,
  });
  assert.deepEqual(siengePhotoQuery(photo('p-1', { localId: 'loc-2' }), LOCALS), { description: 'Concretagem' });
  assert.deepEqual(siengePhotoQuery(photo('p-1', { localId: null }), LOCALS), { description: 'Concretagem' });
  assert.deepEqual(siengePhotoQuery(photo('p-1', { localId: 'loc-apagado' }), LOCALS), { description: 'Concretagem' });
});

test('usuário do Sienge: sugere o código pelo primeiro nome ou pelo e-mail, o mais parecido primeiro', () => {
  const codes = ['JENNEFER.SIATKOVSKI', 'JONATAN.SILVA', 'JORGE.PEREIRA', 'JORGE.SANTOS', 'ANA.SOUZA', 'ADMIN'];
  assert.deepEqual(matchSiengeUsers({ name: 'Jennefer Siatkovski', email: 'jennefer.engenharia@atrincorporadora.com.br' }, codes), [
    'JENNEFER.SIATKOVSKI',
  ]);
  // Nome cadastrado diferente ("Jonatam"), mas o e-mail acha.
  assert.deepEqual(matchSiengeUsers({ name: 'Jonatam', email: 'jonatan.engenharia@atrincorporadora.com.br' }, codes), ['JONATAN.SILVA']);
  // Dois Jorges: o que tem mais partes do nome vem antes.
  assert.deepEqual(matchSiengeUsers({ name: 'Jorge Lucas Pereira', email: 'jorge.engenharia@atrincorporadora.com.br' }, codes), [
    'JORGE.PEREIRA',
    'JORGE.SANTOS',
  ]);
  // Acento e caixa não atrapalham; nome curto demais e "engenharia" do e-mail não contam.
  assert.deepEqual(matchSiengeUsers({ name: 'Ána Micrute', email: 'ana.engenharia@x.com' }, codes), ['ANA.SOUZA']);
  assert.deepEqual(matchSiengeUsers({ name: 'Zé', email: 'engenharia@x.com' }, codes), []);
  assert.deepEqual(matchSiengeUsers({ name: 'Pedro', email: null }, codes), []);
});

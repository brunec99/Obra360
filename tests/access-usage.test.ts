import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCESS_SCREENS,
  deviceOfUserAgent,
  formatDuration,
  formatDurationLong,
  previousRange,
  relativeMoment,
  resolveAccessPeriod,
  screenOfPath,
  sessionRange,
  type AccessPayload,
  type AccessPerson,
  type AccessUsageRow,
} from '../src/domain/access-usage';
import { buildAccessView, filteredUsage, OUTSIDE_WORKS, personDetail } from '../src/domain/access-report';
import { parseAccessReport } from '../src/infrastructure/access/access-store';
import { accessPath, parseAccessParams } from '../src/modules/dashboard/acessos/params';
import { MODULES } from '../src/application/module-access';

/** Aba "Acessos" do Dashboard geral (15/11/2026, modelo aprovado): endereço → tela e obra, aparelho, período em dias
 * corridos, formatos de tempo, as contas da tela (cartões, frase, tabela, módulos, obras, uso por dia, detalhe),
 * a leitura compacta da 0051 e o endereço da aba. */

test('o endereço diz a tela e a obra; impressão e rotas desconhecidas não contam', () => {
  assert.deepEqual(screenOfPath('/obras'), { screen: 'obras', workId: null, field: false });
  assert.deepEqual(screenOfPath('/dashboard'), { screen: 'dashboard-geral', workId: null, field: false });
  assert.deepEqual(screenOfPath('/dashboard/acessos?periodo=30d'), { screen: 'dashboard-geral', workId: null, field: false });
  assert.deepEqual(screenOfPath('/configuracoes'), { screen: 'configuracoes-gerais', workId: null, field: false });
  assert.deepEqual(screenOfPath('/configuracoes/agente'), { screen: 'agente', workId: null, field: false });
  assert.deepEqual(screenOfPath('/obras/w-1/curto-prazo'), { screen: 'curto-prazo', workId: 'w-1', field: false });
  assert.deepEqual(screenOfPath('/obras/w-1/vagoes/abc/'), { screen: 'vagoes', workId: 'w-1', field: false });
  assert.deepEqual(screenOfPath('/obras/w-1/configuracoes'), { screen: 'configuracoes', workId: 'w-1', field: false });
  assert.deepEqual(screenOfPath('/campo/seguranca', 'w-2'), { screen: 'seguranca', workId: 'w-2', field: true });
  assert.deepEqual(screenOfPath('/campo/terminalidade'), { screen: 'terminalidade', workId: null, field: true });
  assert.deepEqual(screenOfPath('/campo/seguranca', 'x y'), { screen: 'seguranca', workId: null, field: true });
  for (const path of [
    '/',
    '/login',
    '/imprimir/dashboard-geral',
    '/obras/w-1',
    '/obras/w-1/nao-existe',
    '/campo/outra',
    '/obras/%E0/dashboard',
  ])
    assert.equal(screenOfPath(path), null, path);
});

test('toda tela da obra com liberação tem lugar no catálogo de acessos', () => {
  const keys = new Set(ACCESS_SCREENS.map(screen => screen.key));
  for (const item of MODULES.filter(m => !m.permission)) assert.ok(keys.has(item.section), item.section);
});

test('aparelho pelo navegador', () => {
  assert.equal(deviceOfUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148'), 'mobile');
  assert.equal(deviceOfUserAgent('Mozilla/5.0 (Linux; Android 15; SM-S921B) Chrome/131 Mobile Safari/537.36'), 'mobile');
  assert.equal(deviceOfUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131 Safari/537.36'), 'desktop');
  assert.equal(deviceOfUserAgent(null), 'desktop');
});

test('período em dias corridos, com o anterior do mesmo tamanho', () => {
  const week = resolveAccessPeriod({ kind: '7d' }, '2026-11-13');
  assert.deepEqual(
    [week.from, week.to, week.days.length, week.previousFrom, week.previousTo],
    ['2026-11-07', '2026-11-13', 7, '2026-10-31', '2026-11-06'],
  );
  assert.equal(week.label, 'sáb 07/11 a sex 13/11');
  assert.equal(week.phrase, 'nos últimos 7 dias');
  const today = resolveAccessPeriod({ kind: 'hoje' }, '2026-11-13');
  assert.deepEqual([today.from, today.to, today.previousFrom, today.label], ['2026-11-13', '2026-11-13', '2026-11-12', 'sex 13/11']);
  const month = resolveAccessPeriod({ kind: 'mes' }, '2026-11-13');
  assert.deepEqual([month.from, month.to, month.days.length], ['2026-11-01', '2026-11-13', 13]);
  const last = resolveAccessPeriod({ kind: 'mes-anterior' }, '2026-03-05');
  assert.deepEqual([last.from, last.to, last.phrase, last.previousFrom], ['2026-02-01', '2026-02-28', 'em fevereiro', '2026-01-04']);
  const range = resolveAccessPeriod({ kind: 'intervalo', from: '2026-11-20', to: '2026-11-02' }, '2026-11-13');
  assert.deepEqual([range.from, range.to, range.phrase], ['2026-11-02', '2026-11-13', 'de 02/11 a 13/11']);
  const broken = resolveAccessPeriod({ kind: 'intervalo', from: '2026-02-30', to: '2026-03-01' }, '2026-11-13');
  assert.equal(broken.kind, '7d');
  const long = resolveAccessPeriod({ kind: 'intervalo', from: '2020-01-01', to: '2026-11-13' }, '2026-11-13');
  assert.equal(long.days.length, 400);
  assert.deepEqual(previousRange('2026-11-01', '2026-11-30'), { previousFrom: '2026-10-02', previousTo: '2026-10-31' });
});

test('formatos de tempo', () => {
  assert.equal(formatDuration(0), '0 min');
  assert.equal(formatDuration(20), '< 1 min');
  assert.equal(formatDuration(46 * 60), '46 min');
  assert.equal(formatDuration(9 * 3600 + 40 * 60), '9 h 40');
  assert.equal(formatDuration(3600 + 5 * 60), '1 h 05');
  assert.equal(formatDuration(2 * 3600), '2 h');
  assert.equal(formatDurationLong(52 * 3600 + 10 * 60), '52 h 10 min');
  assert.equal(formatDurationLong(46 * 60), '46 min');
  const now = '2026-11-13T14:40:00Z'; // 11:40 em Brasília
  assert.equal(relativeMoment('2026-11-13T14:39:40Z', now), 'agora');
  assert.equal(relativeMoment('2026-11-13T14:37:00Z', now), 'há 3 min');
  assert.equal(relativeMoment('2026-11-13T13:02:00Z', now), 'hoje 10:02');
  assert.equal(relativeMoment('2026-11-12T20:52:00Z', now), 'ontem 17:52');
  assert.equal(relativeMoment('2026-11-10T11:55:00Z', now), 'ter 10/11 08:55');
  assert.equal(relativeMoment('2026-11-02T12:00:00Z', now), '02/11/2026');
  assert.equal(sessionRange('2026-11-13T13:55:00Z', '2026-11-13T14:38:00Z', now), 'sex 13/11 · 10:55 – agora');
  assert.equal(sessionRange('2026-11-12T11:02:00Z', '2026-11-12T12:48:00Z', now), 'qui 12/11 · 08:02 – 09:48');
});

// ---------------------------------------------------------------- contas da tela

const person = (id: string, name: string, extra: Partial<AccessPerson> = {}): AccessPerson => ({
  id,
  name,
  role: 'planner',
  tst: false,
  workIds: ['h'],
  createdAt: '2026-10-01T12:00:00Z',
  ...extra,
});
let seq = 0;
const usage = (profileId: string, day: string, screen: string, minutes: number, extra: Partial<AccessUsageRow> = {}): AccessUsageRow => ({
  sessionId: `${profileId}-${day}`,
  profileId,
  day,
  workId: 'h',
  screen,
  field: false,
  device: 'desktop',
  seconds: minutes * 60,
  lastAt: `${day}T12:${String(seq++ % 60).padStart(2, '0')}:00Z`,
  ...extra,
});

function payload(): AccessPayload {
  return {
    now: '2026-11-13T14:40:00Z',
    from: '2026-11-07',
    to: '2026-11-13',
    previousFrom: '2026-10-31',
    previousTo: '2026-11-06',
    migrated: true,
    since: '2026-10-20',
    people: [
      person('carla', 'Carla', { workIds: ['h', 'm'] }),
      person('renata', 'Renata', { role: 'viewer', tst: true }),
      person('marcos', 'Marcos', { role: 'admin', workIds: [] }),
      person('lucas', 'Lucas', { lastSignInAt: '2026-10-10T12:00:00Z' }),
      person('otavio', 'Otávio', { role: 'viewer' }),
      person('tania', 'Tânia', { role: 'viewer' }),
    ],
    works: [
      { id: 'h', name: 'Horizonte', code: 'HRZ' },
      { id: 'm', name: 'Mirante', code: 'MIR' },
    ],
    sessions: [
      { id: 'carla-2026-11-13', profileId: 'carla', startedAt: '2026-11-13T10:41:00Z', lastAt: '2026-11-13T14:39:00Z', seconds: 0 },
      { id: 'carla-2026-11-12', profileId: 'carla', startedAt: '2026-11-12T11:02:00Z', lastAt: '2026-11-12T12:48:00Z', seconds: 0 },
    ],
    usage: [
      usage('carla', '2026-11-13', 'curto-prazo', 40),
      usage('carla', '2026-11-13', 'restricoes', 20),
      usage('carla', '2026-11-12', 'curto-prazo', 30),
      usage('carla', '2026-11-12', 'histograma', 10, { workId: 'm' }),
      usage('renata', '2026-11-13', 'seguranca', 50, { field: true, device: 'mobile', workId: null }),
      usage('renata', '2026-11-09', 'checklist', 20, { device: 'mobile' }),
      usage('marcos', '2026-11-11', 'dashboard-geral', 30, { workId: null }),
      // Período anterior.
      usage('carla', '2026-11-03', 'curto-prazo', 60),
      usage('otavio', '2026-11-02', 'curto-prazo', 15),
    ],
    last: [
      { profileId: 'carla', at: '2026-11-13T14:39:30Z', workId: 'h', screen: 'curto-prazo', field: false, device: 'desktop' },
      { profileId: 'renata', at: '2026-11-13T14:37:00Z', workId: null, screen: 'seguranca', field: true, device: 'mobile' },
      { profileId: 'marcos', at: '2026-11-11T15:00:00Z', workId: null, screen: 'dashboard-geral', field: false, device: 'desktop' },
      { profileId: 'otavio', at: '2026-11-02T13:00:00Z', workId: 'h', screen: 'curto-prazo', field: false, device: 'desktop' },
    ],
  };
}
const week = resolveAccessPeriod({ kind: '7d' }, '2026-11-13');

test('cartões, frase e quem está no sistema agora', () => {
  const view = buildAccessView(payload(), week, {});
  const k = view.kpis;
  assert.deepEqual([k.entered, k.registered, k.enteredPrevious, k.absent, k.never], [3, 6, 2, 3, 1]);
  assert.equal(k.seconds, 200 * 60);
  assert.equal(k.secondsPrevious, 75 * 60);
  assert.equal(k.sessions, 5);
  assert.equal(Math.round(k.averageSeconds / 60), 67);
  assert.deepEqual(
    k.online.map(p => p.name),
    ['Carla', 'Renata'],
  );
  assert.equal(
    view.sentence.map(s => s.text).join(''),
    '3 de 6 pessoas entraram no Obra 360 nos últimos 7 dias e somaram 3 h 20 min de uso ativo. O módulo com mais tempo foi 1.3 Curto prazo (35%), seguido de 3.1 Vistoria de segurança (25%). 3 pessoas não entraram; 1 delas nunca entrou.',
  );
});

test('sem a 0051 a frase diz que a contagem não começou', () => {
  const view = buildAccessView({ ...payload(), migrated: false, usage: [], sessions: [], last: [] }, week, {});
  assert.equal(view.sentence[0].text, 'A contagem do tempo de uso ainda não começou.');
  assert.equal(view.people.find(row => row.person.id === 'lucas')?.last?.text, 'último login 10/10');
});

test('tabela por pessoa: quem entrou por tempo, depois quem não entrou e por fim quem nunca entrou', () => {
  const view = buildAccessView(payload(), week, {});
  assert.deepEqual(
    view.people.map(row => row.person.id),
    ['carla', 'renata', 'marcos', 'otavio', 'lucas', 'tania'],
  );
  const carla = view.people[0];
  assert.deepEqual([carla.seconds, carla.sessions, carla.daysWithUse, carla.perDaySeconds], [100 * 60, 2, 2, 50 * 60]);
  assert.equal(carla.dayFlags.length, 7);
  assert.deepEqual(carla.dayFlags, [false, false, false, false, false, true, true]);
  assert.deepEqual(
    carla.topScreens.map(s => [s.label, Math.round(s.share * 100)]),
    [
      ['1.3 Curto prazo', 70],
      ['1.4 Quadro de Restrições', 20],
      ['2.2 Histograma', 10],
    ],
  );
  assert.equal(carla.groups.find(g => g.group === 'prazo')?.seconds, 90 * 60);
  assert.equal(carla.worksLabel, 'Horizonte, Mirante');
  assert.deepEqual([carla.online, carla.last?.text, carla.last?.where], [true, 'agora', '1.3 Curto prazo · Horizonte']);
  const renata = view.people[1];
  assert.equal(renata.roleLabel, 'TST');
  assert.equal(renata.topScreens[0].fieldShare, 1);
  assert.deepEqual(renata.devices, { desktop: 0, mobile: 70 * 60 });
  assert.equal(renata.last?.where, '3.1 Vistoria de segurança (campo)');
  assert.equal(view.people[2].worksLabel, 'todas as obras');
  const otavio = view.people[3];
  assert.deepEqual([otavio.active, otavio.never, otavio.last?.source], [false, false, 'usage']);
  const lucas = view.people[4];
  assert.deepEqual([lucas.last?.text, lucas.last?.source, lucas.last?.beforeMeasurement], ['último login 10/10', 'login', true]);
  assert.equal(view.people[5].never, true);
});

test('tempo por módulo, por obra e uso por dia', () => {
  const view = buildAccessView(payload(), week, {});
  assert.deepEqual(
    view.screens.map(s => [s.key, s.seconds / 60, s.people]),
    [
      ['curto-prazo', 70, 1],
      ['seguranca', 50, 1],
      ['dashboard-geral', 30, 1],
      ['restricoes', 20, 1],
      ['checklist', 20, 1],
      ['histograma', 10, 1],
    ],
  );
  assert.equal(view.screens[1].fieldSeconds, 50 * 60);
  assert.ok(view.unusedScreens.includes('1.2 Médio prazo'));
  assert.deepEqual(
    view.works.map(w => [w.label, w.seconds / 60, w.people]),
    [
      ['Horizonte', 110, 2],
      ['Fora das obras', 80, 2],
      ['Mirante', 10, 1],
    ],
  );
  assert.equal(view.heat.grouping, 'day');
  assert.equal(view.heat.columns[0].label, 'sáb 07/11');
  assert.deepEqual(
    view.heat.rows[0].cells.map(c => c / 60),
    [0, 0, 0, 0, 0, 40, 60],
  );
  assert.deepEqual(view.heat.peoplePerColumn, [0, 0, 1, 0, 1, 1, 2]);
});

test('mais de 31 dias: uso por dia em semanas de segunda, cortadas no período', () => {
  const month = resolveAccessPeriod({ kind: 'intervalo', from: '2026-10-01', to: '2026-11-13' }, '2026-11-13');
  const view = buildAccessView({ ...payload(), from: month.from, to: month.to, ...previousRange(month.from, month.to) }, month, {});
  assert.equal(view.heat.grouping, 'week');
  assert.equal(view.heat.columns[0].key, '2026-10-01');
  assert.equal(view.heat.columns[1].key, '2026-10-05');
  assert.equal(view.people[0].dayFlags.length, 0);
});

test('filtros: pessoa e papel recortam quem aparece; obra, módulo e aparelho recortam o uso', () => {
  const tst = buildAccessView(payload(), week, { roles: new Set(['tst']) });
  assert.deepEqual([tst.kpis.registered, tst.kpis.entered], [1, 1]);
  const outside = buildAccessView(payload(), week, { works: new Set([OUTSIDE_WORKS]) });
  assert.deepEqual([outside.kpis.entered, outside.kpis.seconds / 60, outside.kpis.registered], [2, 80, 6]);
  assert.deepEqual(
    outside.kpis.online.map(p => p.name),
    ['Renata'],
  );
  assert.ok(
    outside.sentence
      .map(s => s.text)
      .join('')
      .includes('usaram o recorte escolhido'),
  );
  const mobile = buildAccessView(payload(), week, { devices: new Set(['mobile']), screens: new Set(['checklist']) });
  assert.deepEqual([mobile.kpis.entered, mobile.kpis.seconds / 60], [1, 20]);
  assert.deepEqual(mobile.unusedScreens, []);
  const { current, previous } = filteredUsage(payload(), { people: new Set(['carla']) });
  assert.deepEqual([current.length, previous.length], [4, 1]);
  const nobody = buildAccessView(payload(), week, { people: new Set(['ninguem']) });
  assert.equal(nobody.sentence[0].text, 'Nenhuma pessoa no recorte escolhido.');
});

test('detalhe da pessoa: sessões da mais recente para a mais antiga, com obras e módulos', () => {
  const detail = personDetail(payload(), {}, 'carla');
  assert.equal(detail.sessions.length, 2);
  const [today, yesterday] = detail.sessions;
  assert.equal(today.range, 'sex 13/11 · 07:41 – agora');
  assert.equal(today.open, true);
  assert.equal(today.seconds, 60 * 60);
  assert.deepEqual(
    today.works[0].screens.map(s => [s.label, s.seconds / 60]),
    [
      ['1.3 Curto prazo', 40],
      ['1.4 Quadro de Restrições', 20],
    ],
  );
  assert.equal(yesterday.open, false);
  assert.deepEqual(
    yesterday.works.map(w => w.label),
    ['Horizonte', 'Mirante'],
  );
  assert.deepEqual(
    detail.works.map(w => [w.label, Math.round(w.share * 100)]),
    [
      ['Horizonte', 90],
      ['Mirante', 10],
    ],
  );
  const field = personDetail(payload(), {}, 'renata');
  assert.equal(field.sessions[0].works[0].screens[0].label, '3.1 Vistoria de segurança (campo)');
  assert.deepEqual(field.sessions[0].devices, ['mobile']);
});

test('leitura compacta da 0051', () => {
  const parsed = parseAccessReport({
    usage: [['s1', 'p1', '2026-11-13', null, 'obras', false, 'desktop', 42, '2026-11-13T12:00:00+00:00']],
    sessions: [['s1', 'p1', '2026-11-13T11:59:00+00:00', '2026-11-13T12:00:00+00:00', 42]],
    last: [['p1', '2026-11-13T12:00:00+00:00', 'w', 'seguranca', true, 'mobile']],
    since: '2026-11-13',
  });
  assert.deepEqual(parsed.usage[0], {
    sessionId: 's1',
    profileId: 'p1',
    day: '2026-11-13',
    workId: null,
    screen: 'obras',
    field: false,
    device: 'desktop',
    seconds: 42,
    lastAt: '2026-11-13T12:00:00+00:00',
  });
  assert.equal(parsed.sessions[0].seconds, 42);
  assert.deepEqual([parsed.last[0].workId, parsed.last[0].field, parsed.last[0].device], ['w', true, 'mobile']);
  assert.equal(parsed.since, '2026-11-13');
  assert.deepEqual(parseAccessReport(null), { usage: [], sessions: [], last: [] });
});

test('endereço da aba: período e filtros vão e voltam pela URL', () => {
  assert.equal(accessPath({ period: { kind: '7d' }, filters: {} }), '/dashboard/acessos');
  const params = {
    period: { kind: 'intervalo' as const, from: '2026-11-01', to: '2026-11-13' },
    filters: { roles: new Set(['tst' as const]), works: new Set(['h', OUTSIDE_WORKS]), devices: new Set(['mobile' as const]) },
  };
  const path = accessPath(params);
  assert.equal(path, '/dashboard/acessos?periodo=intervalo&de=2026-11-01&ate=2026-11-13&papel=tst&obra=h&obra=fora&aparelho=celular');
  const raw: Record<string, string | string[]> = {};
  for (const [key, value] of new URLSearchParams(path.split('?')[1])) raw[key] = raw[key] ? [raw[key]].flat().concat(value) : value;
  const back = parseAccessParams(raw);
  assert.deepEqual(back.period, params.period);
  assert.deepEqual([...back.filters.works!], ['h', 'fora']);
  assert.deepEqual([...back.filters.devices!], ['mobile']);
  assert.equal(back.filters.people, undefined);
  assert.deepEqual(parseAccessParams({ periodo: 'nada', papel: 'chefe' }), {
    period: { kind: '7d' },
    filters: { people: undefined, roles: undefined, works: undefined, screens: undefined, devices: undefined },
  });
  assert.deepEqual(parseAccessParams({ periodo: 'intervalo', de: '2026-11-01' }).period, { kind: '7d' });
});

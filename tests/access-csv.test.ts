import test from 'node:test';
import assert from 'node:assert/strict';
import type { AccessPayload, AccessUsageRow } from '../src/domain/access-usage';
import { ACCESS_CSV_HEADER, accessCsv, accessCsvFileName, csvCell } from '../src/modules/dashboard/acessos/access-csv';

/** Planilha da aba "Acessos" do Dashboard geral (15/11/2026, modelo aprovado, regra 13). */

const usage = (row: Partial<AccessUsageRow> & Pick<AccessUsageRow, 'profileId' | 'day' | 'seconds'>): AccessUsageRow => ({
  sessionId: 's1',
  workId: 'w1',
  screen: 'curto-prazo',
  field: false,
  device: 'desktop',
  lastAt: `${row.day}T12:00:00.000Z`,
  ...row,
});

function payload(rows: AccessUsageRow[]): AccessPayload {
  return {
    now: '2026-11-15T14:00:00.000Z',
    from: '2026-11-09',
    to: '2026-11-15',
    previousFrom: '2026-11-02',
    previousTo: '2026-11-08',
    migrated: true,
    since: '2026-11-02',
    people: [
      {
        id: 'p-carla',
        name: 'Carla Menezes',
        role: 'planner',
        tst: false,
        workIds: ['w1', 'w2'],
        createdAt: '2026-01-01T00:00:00Z',
        email: 'carla@atrin.com.br',
      },
      {
        id: 'p-renata',
        name: 'Renata "Rê"; Lopes',
        role: 'viewer',
        tst: true,
        workIds: ['w2'],
        createdAt: '2026-01-01T00:00:00Z',
        email: 'renata@atrin.com.br',
      },
      { id: 'p-ana', name: 'Ana Souza', role: 'admin', tst: false, workIds: [], createdAt: '2026-01-01T00:00:00Z' },
    ],
    works: [
      { id: 'w1', name: 'Horizonte', code: 'HRZ' },
      { id: 'w2', name: 'Mirante', code: 'MIR' },
    ],
    sessions: [],
    usage: rows,
    last: [],
  };
}

const lines = (text: string) => text.slice(1).split('\r\n');

test('BOM, cabeçalho e separador', () => {
  const text = accessCsv(payload([]), {});
  assert.equal(text.charCodeAt(0), 0xfeff);
  assert.deepEqual(lines(text), [ACCESS_CSV_HEADER.join(';')]);
  assert.equal(lines(text)[0], 'Pessoa;E-mail;Papel;Dia;Obra;Módulo;Campo;Aparelho;Minutos ativos');
});

test('soma sessões diferentes com a mesma pessoa, dia, obra, tela, campo e aparelho', () => {
  const text = accessCsv(
    payload([
      usage({ profileId: 'p-carla', day: '2026-11-13', seconds: 600, sessionId: 's1' }),
      usage({ profileId: 'p-carla', day: '2026-11-13', seconds: 90, sessionId: 's2' }),
      // Mesmo dia e tela, outro aparelho: linha à parte.
      usage({ profileId: 'p-carla', day: '2026-11-13', seconds: 120, sessionId: 's3', device: 'mobile' }),
    ]),
    {},
  );
  assert.deepEqual(lines(text).slice(1), [
    'Carla Menezes;carla@atrin.com.br;Planejador;13/11/2026;Horizonte;1.3 Curto prazo;Não;Computador;11,5',
    'Carla Menezes;carla@atrin.com.br;Planejador;13/11/2026;Horizonte;1.3 Curto prazo;Não;Celular;2,0',
  ]);
});

test('ordena por pessoa, dia, obra (fora das obras no fim) e módulo na ordem do menu', () => {
  const text = accessCsv(
    payload([
      usage({ profileId: 'p-carla', day: '2026-11-14', seconds: 60, workId: 'w1', screen: 'curto-prazo' }),
      usage({ profileId: 'p-carla', day: '2026-11-13', seconds: 60, workId: null, screen: 'obras' }),
      usage({ profileId: 'p-carla', day: '2026-11-13', seconds: 60, workId: 'w2', screen: 'histograma' }),
      usage({ profileId: 'p-carla', day: '2026-11-13', seconds: 60, workId: 'w1', screen: 'restricoes' }),
      usage({ profileId: 'p-carla', day: '2026-11-13', seconds: 60, workId: 'w1', screen: 'dashboard' }),
      usage({ profileId: 'p-ana', day: '2026-11-15', seconds: 30, workId: null, screen: 'dashboard-geral' }),
    ]),
    {},
  );
  const cells = lines(text)
    .slice(1)
    .map(line => line.split(';'));
  assert.deepEqual(
    cells.map(cell => [cell[0], cell[3], cell[4], cell[5]]),
    [
      ['Ana Souza', '15/11/2026', 'Fora das obras', 'Dashboard geral'],
      ['Carla Menezes', '13/11/2026', 'Horizonte', '0 Dashboard da obra'],
      ['Carla Menezes', '13/11/2026', 'Horizonte', '1.4 Quadro de Restrições'],
      ['Carla Menezes', '13/11/2026', 'Mirante', '2.2 Histograma'],
      ['Carla Menezes', '13/11/2026', 'Fora das obras', 'Lista de obras'],
      ['Carla Menezes', '14/11/2026', 'Horizonte', '1.3 Curto prazo'],
    ],
  );
  // Sem e-mail, a coluna fica vazia; admin sai como "Admin".
  assert.equal(cells[0][1], '');
  assert.equal(cells[0][2], 'Admin');
});

test('aspas quando o campo tem ponto e vírgula ou aspas; TST e campo', () => {
  const text = accessCsv(
    payload([
      usage({ profileId: 'p-renata', day: '2026-11-12', seconds: 4_200, workId: 'w2', screen: 'seguranca', field: true, device: 'mobile' }),
    ]),
    {},
  );
  assert.equal(
    lines(text)[1],
    '"Renata ""Rê""; Lopes";renata@atrin.com.br;TST;12/11/2026;Mirante;3.1 Vistoria de segurança;Sim;Celular;70,0',
  );
  assert.equal(csvCell('linha\ncom quebra'), '"linha\ncom quebra"');
  assert.equal(csvCell('simples'), 'simples');
});

test('segue o recorte da tela e deixa o período anterior de fora', () => {
  const rows = [
    usage({ profileId: 'p-carla', day: '2026-11-13', seconds: 600 }),
    usage({ profileId: 'p-carla', day: '2026-11-13', seconds: 300, device: 'mobile' }),
    usage({ profileId: 'p-renata', day: '2026-11-13', seconds: 300, workId: 'w2', screen: 'seguranca' }),
    // Período anterior (seta dos cartões): não vai para a planilha.
    usage({ profileId: 'p-carla', day: '2026-11-05', seconds: 900 }),
  ];
  const all = lines(accessCsv(payload(rows), {})).slice(1);
  assert.equal(all.length, 3);
  assert.ok(all.every(line => !line.includes('05/11/2026')));

  const mobile = lines(accessCsv(payload(rows), { devices: new Set(['mobile'] as const) })).slice(1);
  assert.deepEqual(mobile, ['Carla Menezes;carla@atrin.com.br;Planejador;13/11/2026;Horizonte;1.3 Curto prazo;Não;Celular;5,0']);

  const tst = lines(accessCsv(payload(rows), { roles: new Set(['tst'] as const) })).slice(1);
  assert.equal(tst.length, 1);
  assert.ok(tst[0].includes('3.1 Vistoria de segurança'));

  const outside = lines(accessCsv(payload(rows), { works: new Set(['fora']) })).slice(1);
  assert.deepEqual(outside, []);
});

test('obra excluída e nomes repetidos de obra', () => {
  const data = payload([
    usage({ profileId: 'p-carla', day: '2026-11-13', seconds: 60, workId: 'w-velha' }),
    usage({ profileId: 'p-carla', day: '2026-11-13', seconds: 60, workId: 'w3' }),
  ]);
  data.works.push({ id: 'w3', name: 'Horizonte', code: 'HRZ2' });
  const obras = lines(accessCsv(data, {}))
    .slice(1)
    .map(line => line.split(';')[4]);
  assert.deepEqual(obras, ['Horizonte (HRZ2)', 'Obra excluída']);
});

test('nome do arquivo', () => {
  assert.equal(accessCsvFileName({ from: '2026-11-09', to: '2026-11-15' }), 'acessos-obra360-2026-11-09-a-2026-11-15.csv');
});

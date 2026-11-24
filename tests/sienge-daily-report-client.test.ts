import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { SiengeError, WRITE_UNCERTAIN } from '../src/infrastructure/integrations/sienge/client';
import {
  attachmentFileName,
  clearDailyReportCache,
  createDailyReport,
  deleteDailyReport,
  findDailyReportByDate,
  listDailyReportTypes,
  listSites,
  normalizeDailyTypes,
  latin1QueryValue,
  uploadDailyAttachment,
  withExifHeader,
} from '../src/infrastructure/integrations/sienge/daily-report';
import type { SiengeDailyReportBody } from '../src/domain/sienge-daily-report';

/** Cliente do Diário de Obra no Sienge com o `fetch` simulado: nenhuma chamada sai para a rede. Cada teste
 * diz o que o "Sienge" responde e confere o que o cliente pediu (endereço, método e corpo). */

type Call = { url: URL; method: string; headers: Record<string, string>; body: unknown };
type Reply = Response | Error | ((call: Call) => Response);
const BASE = 'https://api.sienge.com.br/empresa-teste/public/api/v1';
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const realFetch = globalThis.fetch;
const realEnv = { ...process.env };
let calls: Call[] = [];
let replies: Reply[] = [];

beforeEach(() => {
  calls = [];
  replies = [];
  clearDailyReportCache();
  process.env.SIENGE_SUBDOMAIN = 'empresa-teste';
  process.env.SIENGE_API_USER = 'usuario-de-teste';
  process.env.SIENGE_API_PASSWORD = 'senha-de-teste';
  // Sem o token do painel de consumo, a contagem só avisa no log e não chama o `fetch`.
  delete process.env.CONSUMO_RECEBER_TOKEN;
  globalThis.fetch = (async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    assert.ok(url.href.startsWith(`${BASE}/`), `chamada fora do Sienge simulado: ${url.origin}${url.pathname}`);
    const call: Call = { url, method: init.method ?? 'GET', headers: (init.headers ?? {}) as Record<string, string>, body: init.body };
    calls.push(call);
    const reply = replies.shift();
    if (!reply) throw new Error(`chamada inesperada: ${call.method} ${url.pathname}`);
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply(call) : reply;
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of ['SIENGE_SUBDOMAIN', 'SIENGE_API_USER', 'SIENGE_API_PASSWORD', 'CONSUMO_RECEBER_TOKEN'])
    if (realEnv[key] === undefined) delete process.env[key];
    else process.env[key] = realEnv[key];
});

const BODY: SiengeDailyReportBody = {
  buildingId: 32,
  date: '2026-11-24',
  notes: 'Concretagem da laje do 5º pavimento.',
  shifts: [{ description: 'Morning', startTime: '08:00', finishTime: '12:00', weatherCondition: 'Fine' }],
  crews: [{ crewTypeId: 7, quantity: 12, assignment: 'THIRD_PARTY' }],
};
const path = (call: Call) => call.url.pathname.slice(new URL(BASE).pathname.length);
const query = (call: Call) => Object.fromEntries(call.url.searchParams);

test('tipos: uma leitura, separada por tipo, sem os inativos, com o rótulo aparado e 10 minutos de cache', async () => {
  replies.push(
    json({
      results: [
        { id: 3, description: '  Visita técnica ', isActive: true, type: 'Event' },
        { id: 4, description: 'Acidente', isActive: false, type: 'Event' },
        { id: 7, description: 'GGP', isActive: true, type: 'Crew' },
        { id: 8, description: 'ATR', isActive: true, type: 'Crew' },
        { id: 9, description: 'Betoneira', isActive: true, type: 'Equipment' },
        { id: 10, description: 'Guincho', isActive: false, type: 'Equipment' },
        { id: 0, description: 'código inválido', isActive: true, type: 'Crew' },
        { id: 11, description: '   ', isActive: true, type: 'Crew' },
        { id: 12, description: 'tipo desconhecido', isActive: true, type: 'Other' },
        null,
      ],
    }),
  );
  const types = await listDailyReportTypes();
  assert.deepEqual(types, {
    eventTypes: [{ id: 3, label: 'Visita técnica' }],
    crewTypes: [
      { id: 8, label: 'ATR' },
      { id: 7, label: 'GGP' },
    ],
    equipmentTypes: [{ id: 9, label: 'Betoneira' }],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(path(calls[0]), '/construction-daily-report/types');
  assert.deepEqual(query(calls[0]), { limit: '200', offset: '0' });
  assert.match(calls[0].headers.Authorization, /^Basic /);
  assert.equal(calls[0].body, undefined);

  assert.deepEqual(await listDailyReportTypes(), types, 'a segunda leitura vem do cache');
  assert.equal(calls.length, 1, 'sem nova chamada ao Sienge');
});

test('tipos: o filtro de inativos é puro e não repete o mesmo código', () => {
  const types = normalizeDailyTypes([
    { id: 1, description: 'Chuva', isActive: true, type: 'Event' },
    { id: 1, description: 'Chuva (repetido)', isActive: true, type: 'Event' },
    { id: 1, description: 'ATR', type: 'Crew' },
    { id: '2', description: 'Elevador', isActive: false, type: 'Equipment' },
  ]);
  assert.deepEqual(types, { eventTypes: [{ id: 1, label: 'Chuva' }], crewTypes: [{ id: 1, label: 'ATR' }], equipmentTypes: [] });
});

test('locais: lista do empreendimento; 403 vira null (sem derrubar) e também fica no cache', async () => {
  replies.push(
    json({
      results: [
        { id: 20, description: 'Térreo' },
        { id: 21, description: ' 1º Pavimento ' },
      ],
    }),
  );
  assert.deepEqual(await listSites(32), [
    { id: 21, label: '1º Pavimento' },
    { id: 20, label: 'Térreo' },
  ]);
  assert.equal(path(calls[0]), '/sites');
  assert.deepEqual(query(calls[0]), { buildingId: '32', limit: '200', offset: '0' });

  replies.push(json({ status: 403, developerMessage: 'Permission denied', clientMessage: 'Sem permissão' }, 403));
  assert.equal(await listSites(110), null);
  assert.equal(await listSites(110), null);
  assert.equal(calls.length, 2, '403 não é repetido nem perguntado de novo dentro dos 10 minutos');

  replies.push(json({ status: 401 }, 401));
  await assert.rejects(listSites(111), (error: unknown) => error instanceof SiengeError && error.upstream === 401);
});

test('diário da data: pede a obra e o dia e devolve o número, ou null', async () => {
  replies.push(json({ results: [{ id: 555, buildingId: 32, date: '2026-11-24' }] }));
  assert.equal(await findDailyReportByDate(32, '2026-11-24'), 555);
  assert.equal(calls[0].method, 'GET');
  assert.equal(path(calls[0]), '/construction-daily-report');
  assert.deepEqual(query(calls[0]), { buildingId: '32', startDate: '2026-11-24', endDate: '2026-11-24', limit: '200', offset: '0' });

  replies.push(json({ results: [] }));
  assert.equal(await findDailyReportByDate(32, '2026-11-25'), null);
  // Um Sienge que ignorasse o filtro não pode virar "já existe": diário de outro dia ou de outra obra não conta.
  replies.push(
    json({
      results: [
        { id: 1, buildingId: 32, date: '2026-11-23' },
        { id: 2, buildingId: 99, date: '2026-11-24' },
      ],
    }),
  );
  assert.equal(await findDailyReportByDate(32, '2026-11-24'), null);
});

test('criar: POST com o corpo em JSON e o número da resposta (ou do Location)', async () => {
  replies.push(json({ id: 901 }, 201));
  assert.equal(await createDailyReport(BODY), 901);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(path(calls[0]), '/construction-daily-report');
  assert.equal(calls[0].url.search, '');
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(String(calls[0].body)), BODY);

  replies.push(new Response(null, { status: 201, headers: { location: `${BASE}/construction-daily-report/32/902` } }));
  assert.equal(await createDailyReport(BODY), 902);

  // 201 sem número: procura o diário da data (leitura) em vez de criar de novo.
  replies.push(new Response(null, { status: 201 }), json({ results: [{ id: 903, buildingId: 32, date: '2026-11-24' }] }));
  assert.equal(await createDailyReport(BODY), 903);
  assert.deepEqual(
    calls.slice(2).map(call => call.method),
    ['POST', 'GET'],
  );
});

test('gravação NUNCA é repetida: 500, erro de rede e 429 fazem uma chamada só', async () => {
  replies.push(json({ status: 500 }, 500));
  await assert.rejects(createDailyReport(BODY), (error: unknown) => {
    assert.ok(error instanceof SiengeError);
    assert.equal(error.message, WRITE_UNCERTAIN);
    assert.equal(error.status, 502);
    assert.equal(error.upstream, 500);
    return true;
  });
  assert.equal(calls.length, 1, '500 no POST: uma tentativa');

  replies.push(new TypeError('fetch failed'));
  await assert.rejects(createDailyReport(BODY), (error: unknown) => {
    assert.ok(error instanceof SiengeError);
    assert.equal(error.message, WRITE_UNCERTAIN);
    assert.equal(error.upstream, 0, 'sem resposta do Sienge');
    return true;
  });
  assert.equal(calls.length, 2, 'erro de rede no POST: uma tentativa');

  replies.push(json({ status: 429 }, 429));
  await assert.rejects(createDailyReport(BODY), (error: unknown) => error instanceof SiengeError && error.status === 429);
  assert.equal(calls.length, 3, '429 no POST: uma tentativa');

  replies.push(json({ status: 503 }, 503));
  await assert.rejects(deleteDailyReport(32, 901), (error: unknown) => error instanceof SiengeError && error.upstream === 503);
  assert.equal(calls.length, 4, '503 no DELETE: uma tentativa');

  replies.push(new TypeError('fetch failed'));
  await assert.rejects(uploadDailyAttachment(32, 901, { description: 'Foto' }, { name: 'a.jpg', bytes: Buffer.from('x') }));
  assert.equal(calls.length, 5, 'erro de rede no anexo: uma tentativa');
});

test('leitura continua com nova tentativa em 500', async () => {
  replies.push(json({ status: 500 }, 500), json({ results: [] }));
  assert.equal(await findDailyReportByDate(32, '2026-11-24'), null);
  assert.equal(calls.length, 2);
});

test('recusa do Sienge: o clientMessage vira a mensagem do erro, com status 422', async () => {
  const said = 'Não é possível salvar diário de obra em obras que não estão em andamento.';
  replies.push(json({ status: 422, developerMessage: 'Building not in progress', clientMessage: said }, 422));
  await assert.rejects(createDailyReport(BODY), (error: unknown) => {
    assert.ok(error instanceof SiengeError);
    assert.equal(error.message, said);
    assert.equal(error.status, 422);
    assert.equal(error.upstream, 422);
    return true;
  });
  assert.equal(calls.length, 1);

  replies.push(json({ status: 400, developerMessage: 'x', clientMessage: ' Data inválida. ' }, 400));
  await assert.rejects(
    createDailyReport(BODY),
    (error: unknown) => error instanceof SiengeError && error.message === 'Data inválida.' && error.status === 422,
  );

  // Sem clientMessage (ou corpo que não é JSON) fica o texto fixo; credencial e permissão nunca usam o do Sienge.
  replies.push(new Response('<html>erro</html>', { status: 400 }));
  await assert.rejects(
    createDailyReport(BODY),
    (error: unknown) => error instanceof SiengeError && error.message === 'O Sienge recusou a gravação.',
  );
  replies.push(json({ status: 403, clientMessage: 'Forbidden' }, 403));
  await assert.rejects(
    createDailyReport(BODY),
    (error: unknown) => error instanceof SiengeError && /não tem esta gravação liberada/.test(error.message) && error.status === 502,
  );
});

test('excluir: DELETE no endereço do diário; a recusa de integração sobe com o texto do Sienge', async () => {
  replies.push(new Response(null, { status: 204 }));
  await deleteDailyReport(32, 901);
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(path(calls[0]), '/construction-daily-report/32/901');
  assert.equal(calls[0].body, undefined);

  const said = 'Diário de obra já utilizado em integração e não pode ser excluído.';
  replies.push(json({ status: 422, clientMessage: said }, 422));
  await assert.rejects(deleteDailyReport(32, 901), (error: unknown) => error instanceof SiengeError && error.message === said);
  replies.push(json({ status: 404, clientMessage: 'Diário não encontrado.' }, 404));
  await assert.rejects(
    deleteDailyReport(32, 901),
    (error: unknown) => error instanceof SiengeError && error.upstream === 404 && error.status === 404,
  );
});

test('anexo: POST multipart com o campo file em JPEG e a descrição, o local e o "mostrar" na consulta', async () => {
  replies.push(json({ id: 1 }, 201), new Response(null, { status: 201 }));
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  await uploadDailyAttachment(
    32,
    901,
    { description: 'Laje do 5º pavimento', localId: 21, showInReports: true },
    { name: 'foto.jpg', bytes },
  );
  const [call] = calls;
  assert.equal(call.method, 'POST');
  assert.equal(path(call), '/construction-daily-report/32/901/attachments');
  // Consulta em percentual de Latin-1 ("º" = %BA), como o Sienge lê esta rota.
  assert.equal(call.url.search, '?description=Laje%20do%205%BA%20pavimento&locationId=21&showInReports=true');
  assert.equal(call.headers['Content-Type'], undefined, 'o fetch monta o cabeçalho multipart com o limite das partes');
  assert.ok(call.body instanceof FormData);
  const file = (call.body as FormData).get('file');
  assert.ok(file instanceof File);
  assert.equal(file.type, 'image/jpeg');
  assert.equal(file.name, 'foto.jpg');
  // O JPEG sem EXIF ganha o bloco EXIF mínimo logo depois do início (o Sienge recusa sem ele).
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), withExifHeader(bytes));
  assert.equal(
    Buffer.from(await file.arrayBuffer())
      .subarray(0, 4)
      .toString('hex'),
    'ffd8ffe1',
  );

  // Sem local ligado ao Sienge, `locationId` e `showInReports` não entram na consulta.
  await uploadDailyAttachment(32, 901, { description: 'Sem local' }, { name: `${'a'.repeat(300)}.jpeg`, bytes });
  assert.equal(calls[1].url.search, '?description=Sem%20local');
  const long = (calls[1].body as FormData).get('file') as File;
  assert.equal(long.name.length, 100);
  assert.ok(long.name.endsWith('.jpg'));
});

test('EXIF no JPEG: insere o bloco mínimo sem recomprimir; o que já tem EXIF ou não é JPEG segue igual', () => {
  const semExif = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 9, 9]);
  const comExif = withExifHeader(semExif);
  assert.equal(comExif.length, semExif.length + 24);
  assert.equal(comExif.subarray(0, 4).toString('hex'), 'ffd8ffe1');
  // Tamanho do segmento (22) e a marca "Exif\0\0", e o resto do arquivo intacto depois do bloco.
  assert.equal(comExif.readUInt16BE(4), 22);
  assert.equal(comExif.subarray(6, 12).toString('latin1'), 'Exif\0\0');
  assert.deepEqual(comExif.subarray(26), semExif.subarray(2));
  const jfif = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  assert.equal(withExifHeader(jfif).subarray(0, 4).toString('hex'), 'ffd8ffe1');
  const camera = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 1, 2]);
  assert.equal(withExifHeader(camera), camera);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  assert.equal(withExifHeader(png), png);
});

test('consulta do anexo em Latin-1: acentos em um byte, tipográficos simplificados, o resto sem acento', () => {
  assert.equal(latin1QueryValue('Concretagem da laje – 6º pavimento'), 'Concretagem%20da%20laje%20-%206%BA%20pavimento');
  assert.equal(latin1QueryValue('ação “nova”'), 'a%E7%E3o%20%22nova%22');
  assert.equal(latin1QueryValue('obra ✓ ok'), 'obra%20%20ok');
  assert.equal(latin1QueryValue('a&b=c'), 'a%26b%3Dc');
});

test('nome do arquivo do anexo: até 100 caracteres, sem barra, sempre .jpg', () => {
  assert.equal(attachmentFileName('compressão ação.jpg'), 'compressao acao.jpg');
  assert.equal(attachmentFileName('diario-2026-11-24-abcd1234.jpg'), 'diario-2026-11-24-abcd1234.jpg');
  assert.equal(attachmentFileName('pasta/sub\\foto.JPEG'), 'pasta-sub-foto.jpg');
  assert.equal(attachmentFileName(''), 'foto.jpg');
  assert.equal(attachmentFileName('x'.repeat(250)).length, 100);
});

test('sem as variáveis do Sienge nada é chamado', async () => {
  delete process.env.SIENGE_API_PASSWORD;
  await assert.rejects(createDailyReport(BODY), (error: unknown) => error instanceof SiengeError && error.status === 503);
  assert.equal(calls.length, 0);
});

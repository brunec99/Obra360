import {
  normalizeEnterprises,
  normalizeSheetItems,
  normalizeSheets,
  type SiengeBudget,
  type SiengeBudgetLine,
  type SiengeEnterprise,
  type SiengeSheetSummary,
} from '@/domain/sienge-budget';
import { enviarConsumo, novoContador, type ContadorSienge } from './consumo';

/** Cliente da API do Sienge (23/11/2026). Importado apenas por Route Handlers: a credencial nunca entra
 * em módulo do navegador.
 *
 * Autenticação Basic com o usuário de API do Painel de Integrações do Sienge (não é o login de uma
 * pessoa). As rotas usadas aqui são as REST (`/v1`), com teto de 200 requisições por minuto; as de
 * dados em massa (`/bulk-data`), que têm cota diária pequena, ficam de fora de propósito.
 *
 * Nasceu só de leitura (orçamento). Em 24/11/2026 ganhou gravação (`siengeRequest` com `method`), para o
 * Diário de Obra. A regra que separa as duas: leitura tem nova tentativa em falha passageira; GRAVAÇÃO
 * NUNCA É REPETIDA sozinha, porque um POST que o Sienge processou e cuja resposta se perdeu criaria o
 * diário em dobro na segunda tentativa. */

const MIN_INTERVAL_MS = 320; // cerca de 185 requisições por minuto, abaixo do teto de 200
const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 30_000;
const PAGE = 200;
/** Trava contra uma rota que ignore o `offset`: 250 páginas são 50 mil linhas numa unidade. */
const MAX_PAGES = 250;

export class SiengeError extends Error {
  constructor(
    message: string,
    /** Status com que a rota do Obra 360 responde. */
    public status: number,
    /** Status HTTP que o Sienge devolveu; 0 quando não houve resposta (rede fora, tempo esgotado). */
    public upstream = 0,
  ) {
    super(message);
  }
}

export interface SiengeConfig {
  subdomain: string;
  user: string;
  password: string;
}
/** Lê as três variáveis do servidor; nulo quando falta alguma ou o subdomínio tem formato estranho. */
export function siengeConfigFromEnv(env: Record<string, string | undefined> = process.env): SiengeConfig | null {
  const subdomain = (env.SIENGE_SUBDOMAIN ?? '').trim();
  const user = (env.SIENGE_API_USER ?? '').trim();
  const password = env.SIENGE_API_PASSWORD ?? '';
  if (!/^[a-z0-9-]{1,60}$/i.test(subdomain) || !user || !password) return null;
  return { subdomain, user, password };
}
export const SIENGE_NOT_CONFIGURED = 'Sienge não configurado: defina SIENGE_SUBDOMAIN, SIENGE_API_USER e SIENGE_API_PASSWORD no servidor.';

let nextSlot = 0;
/** Intervalo mínimo entre chamadas, mesmo com várias leituras ao mesmo tempo. */
async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_INTERVAL_MS;
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
}
const pause = (attempt: number) => new Promise(resolve => setTimeout(resolve, Math.min(4000, 2 ** attempt * 300)));

function messageFor(status: number) {
  if (status === 401) return 'O Sienge recusou a credencial de API (usuário ou senha).';
  if (status === 403) return 'O usuário de API do Sienge não tem esta consulta liberada. Libere no Painel de Integrações do Sienge.';
  if (status === 404) return 'O Sienge não encontrou o que foi pedido. Confira o código do empreendimento ligado à obra.';
  if (status === 429) return 'Limite de consultas ao Sienge atingido. Aguarde um minuto e tente de novo.';
  return 'O Sienge não conseguiu atender a consulta.';
}
/** Gravação sem resposta ou com erro interno do Sienge: não se sabe se ele gravou. */
export const WRITE_UNCERTAIN = 'O Sienge não confirmou a gravação. Confira no Sienge se ela foi feita antes de tentar de novo.';
function writeMessageFor(status: number) {
  if (status === 401) return messageFor(401);
  if (status === 403) return 'O usuário de API do Sienge não tem esta gravação liberada. Libere no Painel de Integrações do Sienge.';
  if (status === 404) return 'O Sienge não encontrou o registro. Confira o empreendimento ligado à obra.';
  if (status === 429) return 'Limite de chamadas ao Sienge atingido. Aguarde um minuto e tente de novo.';
  return 'O Sienge recusou a gravação.';
}

export interface SiengeRequestOptions {
  /** Padrão `GET`. `POST` e `DELETE` são gravação: uma tentativa só. */
  method?: 'GET' | 'POST' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined>;
  /** Corpo JSON (gravação). */
  json?: unknown;
  /** Corpo multipart (anexo); o `fetch` monta o cabeçalho com o limite das partes. */
  form?: FormData;
  /** Usa o `clientMessage` do Sienge como mensagem do erro nas recusas 4xx. Ligado por padrão na gravação;
   * desligado por padrão na leitura, para as consultas do orçamento seguirem com as mensagens de sempre. */
  detail?: boolean;
  timeoutMs?: number;
}
export interface SiengeResponse {
  status: number;
  /** O JSON da resposta; nulo quando o Sienge responde sem corpo (204, ou 201 só com `Location`). */
  body: unknown;
  /** Cabeçalho `Location` da resposta, quando houver (o endereço do recurso criado). */
  location: string | null;
}

/** As recusas que continuam com o texto fixo mesmo com `detail`: credencial, permissão e limite são
 * problemas da integração, e o texto do Sienge para elas não ajuda quem está na obra. */
const FIXED_MESSAGE = new Set([401, 403, 429]);

/** O texto que o Sienge manda para o usuário numa recusa (`{ status, developerMessage, clientMessage }`), ou
 * vazio. Ex.: "Não é possível salvar diário de obra em obras que não estão em andamento." */
async function clientMessageOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { clientMessage?: unknown } | null;
    const text = typeof body?.clientMessage === 'string' ? body.clientMessage.trim() : '';
    return text.slice(0, 600);
  } catch {
    return '';
  }
}

/** Uma chamada à API REST do Sienge, com o intervalo mínimo entre chamadas e a contagem de consumo.
 * Leitura (`GET`): até três tentativas em erro de rede, 429 e 5xx, como sempre. Gravação (`POST`,
 * `DELETE`): UMA tentativa — depois de erro de rede, tempo esgotado ou 5xx não dá para saber se o Sienge
 * gravou, e repetir poderia criar o diário em dobro; quem chama decide o que fazer (o envio do diário
 * confere por data antes de criar). */
export async function siengeRequest(contador: ContadorSienge, path: string, options: SiengeRequestOptions = {}): Promise<SiengeResponse> {
  const config = siengeConfigFromEnv();
  if (!config) throw new SiengeError(SIENGE_NOT_CONFIGURED, 503);
  const method = options.method ?? 'GET';
  const write = method !== 'GET';
  const detail = options.detail ?? write;
  const url = new URL(`https://api.sienge.com.br/${config.subdomain}/public/api/v1${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
  const authorization = `Basic ${Buffer.from(`${config.user}:${config.password}`).toString('base64')}`;
  const requestHeaders: Record<string, string> = { Authorization: authorization, Accept: 'application/json' };
  let body: BodyInit | undefined;
  if (options.form) body = options.form;
  else if (options.json !== undefined) {
    requestHeaders['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  }
  const attempts = write ? 1 : MAX_ATTEMPTS;
  let last: SiengeError | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await throttle();
    // Conta a tentativa antes do fetch (contrato consumo/1): nova tentativa também é chamada paga.
    contador.conta();
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: requestHeaders,
        body,
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
      });
    } catch {
      if (write) throw new SiengeError(WRITE_UNCERTAIN, 502);
      last = new SiengeError('Não foi possível conectar ao Sienge. Tente novamente.', 502);
      await pause(attempt);
      continue;
    }
    if (response.ok) {
      const location = response.headers.get('location');
      const text = response.status === 204 ? '' : await response.text().catch(() => '');
      if (!text.trim()) {
        // Leitura sem corpo não existe nesta API; gravação pode responder só com o status.
        if (!write) throw new SiengeError('O Sienge devolveu uma resposta que não foi possível ler.', 502, response.status);
        return { status: response.status, body: null, location };
      }
      try {
        return { status: response.status, body: JSON.parse(text), location };
      } catch {
        // Na gravação o Sienge já aceitou: um corpo ilegível não pode virar "falhou".
        if (write) return { status: response.status, body: null, location };
        throw new SiengeError('O Sienge devolveu uma resposta que não foi possível ler.', 502, response.status);
      }
    }
    const { status } = response;
    // 429 de rajada e 5xx passam com nova tentativa (só na leitura); os outros 4xx não melhoram repetindo.
    const transient = status === 429 || status >= 500;
    if (write && status >= 500) throw new SiengeError(WRITE_UNCERTAIN, 502, status);
    const said = detail && status < 500 && !FIXED_MESSAGE.has(status) ? await clientMessageOf(response) : '';
    // Com `detail`, a recusa de regra de negócio (400, 409, 422) sai como 422: a tela mostra o texto do Sienge.
    const outward = status === 429 ? 429 : status === 404 ? 404 : detail && [400, 409, 422].includes(status) ? 422 : 502;
    last = new SiengeError(said || (write ? writeMessageFor(status) : messageFor(status)), outward, status);
    if (!transient || write) throw last;
    const retryAfter = Number(response.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 20) throw last;
    if (Number.isFinite(retryAfter) && retryAfter > 0) await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
    else await pause(attempt);
  }
  throw last ?? new SiengeError(messageFor(502), 502);
}

/** Leitura simples, como o orçamento sempre usou: devolve só o JSON. */
async function request(contador: ContadorSienge, path: string, query: Record<string, string | number> = {}): Promise<unknown> {
  return (await siengeRequest(contador, path, { query })).body;
}

/** Percorre as páginas de uma rota REST do Sienge (`results` + `limit`/`offset`). */
async function collect(contador: ContadorSienge, path: string): Promise<unknown[]> {
  const all: unknown[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = (await request(contador, path, { limit: PAGE, offset: page * PAGE })) as { results?: unknown } | null;
    const results = Array.isArray(body?.results) ? body.results : [];
    all.push(...results);
    if (results.length < PAGE) break;
  }
  return all;
}

export async function listEnterprises(): Promise<SiengeEnterprise[]> {
  const contador = novoContador('empreendimentos');
  try {
    return normalizeEnterprises(await collect(contador, '/enterprises'));
  } finally {
    await enviarConsumo(contador);
  }
}

/** Orçamento inteiro de um empreendimento: as unidades construtivas e os itens com valor de cada uma.
 * As unidades são lidas três de cada vez; o intervalo entre chamadas continua valendo para todas. */
export async function fetchBudget(buildingId: number): Promise<SiengeBudget> {
  const contador = novoContador('orcamento');
  try {
    return await readBudget(contador, buildingId);
  } finally {
    await enviarConsumo(contador);
  }
}

async function readBudget(contador: ContadorSienge, buildingId: number): Promise<SiengeBudget> {
  const sheets = normalizeSheets(await collect(contador, `/building-cost-estimations/${buildingId}/sheets`));
  const summaries: SiengeSheetSummary[] = [];
  const linesBySheet = new Map<number, SiengeBudgetLine[]>();
  const queue = [...sheets];
  const worker = async () => {
    for (let sheet = queue.shift(); sheet; sheet = queue.shift()) {
      const read = normalizeSheetItems(sheet, await collect(contador, `/building-cost-estimations/${buildingId}/sheets/${sheet.id}/items`));
      summaries.push(read.summary);
      linesBySheet.set(sheet.id, read.lines);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  summaries.sort((a, b) => a.id - b.id);
  const lines = summaries.flatMap(summary => linesBySheet.get(summary.id) ?? []);
  const total = Math.round(summaries.reduce((sum, summary) => sum + summary.total, 0) * 100) / 100;
  return { buildingId, sheets: summaries, lines, total, readAt: new Date().toISOString() };
}

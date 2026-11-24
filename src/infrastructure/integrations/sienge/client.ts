import {
  normalizeEnterprises,
  normalizeSheetItems,
  normalizeSheets,
  type SiengeBudget,
  type SiengeBudgetLine,
  type SiengeEnterprise,
  type SiengeSheetSummary,
} from '@/domain/sienge-budget';

/** Cliente da API do Sienge (23/11/2026), só leitura. Importado apenas por Route Handlers: a credencial
 * nunca entra em módulo do navegador.
 *
 * Autenticação Basic com o usuário de API do Painel de Integrações do Sienge (não é o login de uma
 * pessoa). As rotas usadas aqui são as REST (`/v1`), com teto de 200 requisições por minuto; as de
 * dados em massa (`/bulk-data`), que têm cota diária pequena, ficam de fora de propósito. */

const MIN_INTERVAL_MS = 320; // cerca de 185 requisições por minuto, abaixo do teto de 200
const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 30_000;
const PAGE = 200;
/** Trava contra uma rota que ignore o `offset`: 250 páginas são 50 mil linhas numa unidade. */
const MAX_PAGES = 250;

export class SiengeError extends Error {
  constructor(
    message: string,
    public status: number,
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

async function request(path: string, query: Record<string, string | number> = {}): Promise<unknown> {
  const config = siengeConfigFromEnv();
  if (!config) throw new SiengeError(SIENGE_NOT_CONFIGURED, 503);
  const url = new URL(`https://api.sienge.com.br/${config.subdomain}/public/api/v1${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  const authorization = `Basic ${Buffer.from(`${config.user}:${config.password}`).toString('base64')}`;
  let last: SiengeError | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await throttle();
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: authorization, Accept: 'application/json' },
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      last = new SiengeError('Não foi possível conectar ao Sienge. Tente novamente.', 502);
      await pause(attempt);
      continue;
    }
    if (response.ok) {
      try {
        return await response.json();
      } catch {
        throw new SiengeError('O Sienge devolveu uma resposta que não foi possível ler.', 502);
      }
    }
    // 429 de rajada e 5xx passam com nova tentativa; os outros 4xx não melhoram repetindo.
    const transient = response.status === 429 || response.status >= 500;
    last = new SiengeError(messageFor(response.status), response.status === 429 ? 429 : response.status === 404 ? 404 : 502);
    if (!transient) throw last;
    const retryAfter = Number(response.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 20) throw last;
    if (Number.isFinite(retryAfter) && retryAfter > 0) await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
    else await pause(attempt);
  }
  throw last ?? new SiengeError(messageFor(502), 502);
}

/** Percorre as páginas de uma rota REST do Sienge (`results` + `limit`/`offset`). */
async function collect(path: string): Promise<unknown[]> {
  const all: unknown[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = (await request(path, { limit: PAGE, offset: page * PAGE })) as { results?: unknown } | null;
    const results = Array.isArray(body?.results) ? body.results : [];
    all.push(...results);
    if (results.length < PAGE) break;
  }
  return all;
}

export async function listEnterprises(): Promise<SiengeEnterprise[]> {
  return normalizeEnterprises(await collect('/enterprises'));
}

/** Orçamento inteiro de um empreendimento: as unidades construtivas e os itens com valor de cada uma.
 * As unidades são lidas três de cada vez; o intervalo entre chamadas continua valendo para todas. */
export async function fetchBudget(buildingId: number): Promise<SiengeBudget> {
  const sheets = normalizeSheets(await collect(`/building-cost-estimations/${buildingId}/sheets`));
  const summaries: SiengeSheetSummary[] = [];
  const linesBySheet = new Map<number, SiengeBudgetLine[]>();
  const queue = [...sheets];
  const worker = async () => {
    for (let sheet = queue.shift(); sheet; sheet = queue.shift()) {
      const read = normalizeSheetItems(sheet, await collect(`/building-cost-estimations/${buildingId}/sheets/${sheet.id}/items`));
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

import type { SiengeOption } from '@/domain/daily-report';
import type { SiengeDailyReportBody } from '@/domain/sienge-daily-report';
import { SiengeError, siengeRequest } from './client';
import { enviarConsumo, novoContador, type ContadorSienge } from './consumo';

/** Diário de Obra no Sienge (24/11/2026): as chamadas da API `construction-daily-report`. Importado apenas
 * por Route Handlers. As leituras de apoio (tipos e locais) ficam 10 minutos na memória do processo, para
 * abrir o diário não gastar a cota de 200 requisições por minuto; as gravações passam por `siengeRequest`
 * com `POST`/`DELETE`, que nunca repete a chamada sozinho. */

const BASE = '/construction-daily-report';
const PAGE = 200;
/** Trava contra uma rota que ignore o `offset`. */
const MAX_PAGES = 25;
const CACHE_MS = 10 * 60 * 1000;
const FILE_NAME_MAX = 100;
/** A foto tem até 2 MB; o envio do anexo ganha mais tempo que uma consulta. */
const UPLOAD_TIMEOUT_MS = 60_000;

export interface SiengeDailyTypes {
  eventTypes: SiengeOption[];
  crewTypes: SiengeOption[];
  equipmentTypes: SiengeOption[];
}

/* ---------- cache em memória ---------- */

const cache = new Map<string, { until: number; value: unknown }>();
function cached<T>(key: string): { value: T } | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.until <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return { value: hit.value as T };
}
const remember = <T>(key: string, value: T): T => {
  cache.set(key, { until: Date.now() + CACHE_MS, value });
  return value;
};
/** Esvazia o cache de tipos e locais (testes; e depois de ligar a obra a outro empreendimento). */
export function clearDailyReportCache() {
  cache.clear();
}

/* ---------- leituras ---------- */

/** Uma chamada com contagem de consumo própria, enviada ao fim mesmo quando falha. */
async function counted<T>(run: (contador: ContadorSienge) => Promise<T>): Promise<T> {
  const contador = novoContador('diario');
  try {
    return await run(contador);
  } finally {
    await enviarConsumo(contador);
  }
}

/** Percorre as páginas (`results` + `limit`/`offset`), com o texto do Sienge nas recusas. */
async function collect(contador: ContadorSienge, path: string, query: Record<string, string | number> = {}): Promise<unknown[]> {
  const all: unknown[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { body } = await siengeRequest(contador, path, { query: { ...query, limit: PAGE, offset: page * PAGE }, detail: true });
    const results = Array.isArray((body as { results?: unknown } | null)?.results) ? (body as { results: unknown[] }).results : [];
    all.push(...results);
    if (results.length < PAGE) break;
  }
  return all;
}

const positiveInt = (value: unknown): number | null => {
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
};
function option(raw: unknown): SiengeOption | null {
  if (!raw || typeof raw !== 'object') return null;
  const { id, description } = raw as { id?: unknown; description?: unknown };
  const code = positiveInt(id);
  const label = typeof description === 'string' ? description.trim() : '';
  return code !== null && label ? { id: code, label } : null;
}
const byLabel = (a: SiengeOption, b: SiengeOption) => a.label.localeCompare(b.label, 'pt-BR') || a.id - b.id;

/** Separa os tipos do Sienge (`type`: `Event`, `Crew`, `Equipment`) e deixa de fora os inativos. Puro. */
export function normalizeDailyTypes(results: readonly unknown[]): SiengeDailyTypes {
  const types: SiengeDailyTypes = { eventTypes: [], crewTypes: [], equipmentTypes: [] };
  const seen = new Set<string>();
  for (const raw of results) {
    const item = option(raw);
    if (!item) continue;
    const { isActive, type } = raw as { isActive?: unknown; type?: unknown };
    if (isActive === false) continue;
    const kind = typeof type === 'string' ? type.trim().toLowerCase() : '';
    const list =
      kind === 'event' ? types.eventTypes : kind === 'crew' ? types.crewTypes : kind === 'equipment' ? types.equipmentTypes : null;
    if (!list || seen.has(`${kind}:${item.id}`)) continue;
    seen.add(`${kind}:${item.id}`);
    list.push(item);
  }
  types.eventTypes.sort(byLabel);
  types.crewTypes.sort(byLabel);
  types.equipmentTypes.sort(byLabel);
  return types;
}

/** Tipos de ocorrência, de equipe e de equipamento cadastrados no Sienge (só os ativos). */
export async function listDailyReportTypes(): Promise<SiengeDailyTypes> {
  const hit = cached<SiengeDailyTypes>('types');
  if (hit) return hit.value;
  return remember('types', normalizeDailyTypes(await counted(contador => collect(contador, `${BASE}/types`))));
}

/** Locais do empreendimento no Sienge. Devolve `null` quando o usuário de API não tem a consulta liberada
 * (403, o caso de hoje): o diário segue sem a lista e o local é ligado digitando o código. */
export async function listSites(buildingId: number): Promise<SiengeOption[] | null> {
  const key = `sites:${buildingId}`;
  const hit = cached<SiengeOption[] | null>(key);
  if (hit) return hit.value;
  try {
    const results = await counted(contador => collect(contador, '/sites', { buildingId }));
    const sites = results.map(option).filter((item): item is SiengeOption => item !== null);
    return remember(key, sites.sort(byLabel));
  } catch (error) {
    // O 403 também fica no cache: perguntar de novo a cada abertura do diário só gastaria a cota.
    if (error instanceof SiengeError && error.upstream === 403) return remember(key, null);
    throw error;
  }
}

/** O número do diário que o Sienge já tem para o empreendimento na data, ou `null`. */
export async function findDailyReportByDate(buildingId: number, date: string): Promise<number | null> {
  const results = await counted(contador => collect(contador, BASE, { buildingId, startDate: date, endDate: date }));
  for (const raw of results) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as { id?: unknown; date?: unknown; buildingId?: unknown };
    // Confere a data e a obra quando o Sienge as devolve: um filtro ignorado não pode virar "já existe".
    if (typeof item.date === 'string' && item.date.slice(0, 10) !== date) continue;
    if (item.buildingId !== undefined && item.buildingId !== null && positiveInt(item.buildingId) !== buildingId) continue;
    const id = positiveInt(item.id);
    if (id !== null) return id;
  }
  return null;
}

/* ---------- gravações (uma tentativa só) ---------- */

/** O número no fim do `Location` (`…/construction-daily-report/32/123`). */
const idFromLocation = (location: string | null) => positiveInt(location?.match(/\/(\d+)\/?(?:\?.*)?$/)?.[1]);

/** Cria o diário no Sienge e devolve o número dele. Se o Sienge aceitar (201) sem dizer o número, procura
 * pelo diário da data (leitura, pode repetir); sem achar, lança — quem chama registra o caso. */
export async function createDailyReport(body: SiengeDailyReportBody): Promise<number> {
  const response = await counted(contador => siengeRequest(contador, BASE, { method: 'POST', json: body }));
  const id = positiveInt((response.body as { id?: unknown } | null)?.id) ?? idFromLocation(response.location);
  if (id !== null) return id;
  const found = await findDailyReportByDate(body.buildingId, body.date).catch(() => null);
  if (found !== null) return found;
  throw new SiengeError(
    'O Sienge criou o diário, mas não informou o número dele. Confira no Sienge antes de enviar de novo.',
    502,
    response.status,
  );
}

/** Exclui o diário do Sienge (204). O Sienge recusa o que já foi usado em integração; a mensagem dele sobe. */
export async function deleteDailyReport(buildingId: number, id: number): Promise<void> {
  await counted(contador => siengeRequest(contador, `${BASE}/${buildingId}/${id}`, { method: 'DELETE' }));
}

/** Nome de arquivo que o Sienge aceita: até 100 caracteres, sem barra, terminando em `.jpg`. Puro. */
export function attachmentFileName(name: string): string {
  const clean = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  const stem = clean.replace(/\.jpe?g$/i, '') || 'foto';
  return `${stem.slice(0, FILE_NAME_MAX - 4)}.jpg`;
}

/** Anexa uma foto (JPEG) ao diário: multipart com o campo `file`, e descrição, local e "mostrar nos
 * relatórios" na consulta. O Sienge aceita anexo também depois do envio do diário. */
export async function uploadDailyAttachment(
  buildingId: number,
  id: number,
  query: { description: string; localId?: number; showInReports?: boolean },
  file: { name: string; bytes: Buffer },
): Promise<void> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(file.bytes)], { type: 'image/jpeg' }), attachmentFileName(file.name));
  await counted(contador =>
    siengeRequest(contador, `${BASE}/${buildingId}/${id}/attachments`, {
      method: 'POST',
      query: { description: query.description, localId: query.localId, showInReports: query.showInReports },
      form,
      timeoutMs: UPLOAD_TIMEOUT_MS,
    }),
  );
}

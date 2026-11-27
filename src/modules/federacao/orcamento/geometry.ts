import { joinParts, type OrcamentoModel } from '@/domain/orcamento-models';

/**
 * Geometria (Fragments) de um modelo do Orçamento 4D: cache deste navegador, senão o servidor.
 *
 * No banco ela fica em partes de 2 MB; a tela pede as partes em paralelo, junta e guarda o arquivo inteiro na
 * Cache API por revisão. Uma obra tem de 27 a 68 MB de geometria: sem o cache, cada visita baixaria tudo de novo.
 * Sem Cache API (contexto inseguro, modo privado), o cache vira no-op e a tela só baixa sempre.
 */
const CACHE = 'obra360-federado-v1';
const ORIGIN = 'https://cache.obra360.local/';
/** Partes de um mesmo modelo baixadas ao mesmo tempo. */
const PARTS_IN_PARALLEL = 4;

/** `frag/modelo/` é o prefixo de todas as revisões do modelo; a chave completa muda a cada reenvio do IFC. */
const prefixOf = (modelId: string) => `${ORIGIN}frag/${modelId}/`;
const keyOf = (model: Pick<OrcamentoModel, 'id' | 'revision' | 'parts'>) => `${prefixOf(model.id)}r${model.revision}-p${model.parts}`;

async function open(): Promise<Cache | null> {
  try {
    return typeof caches === 'undefined' ? null : await caches.open(CACHE);
  } catch {
    return null;
  }
}

async function readCache(key: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const cache = await open();
  if (!cache) return null;
  try {
    const hit = await cache.match(key);
    return hit ? new Uint8Array(await hit.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

/** Grava e apaga as outras revisões do mesmo modelo. Falha (cota cheia) é ignorada: segue sem cache. */
async function writeCache(modelId: string, key: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  const cache = await open();
  if (!cache) return;
  try {
    for (const request of await cache.keys())
      if (request.url.startsWith(prefixOf(modelId)) && request.url !== key) await cache.delete(request);
    await cache.put(
      key,
      new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength) } }),
    );
  } catch {
    /* sem espaço ou sem permissão */
  }
}

/** Roda `task` em cada item, no máximo `limit` de cada vez, e devolve os resultados na ordem dos itens. */
export async function inParallel<T, R>(items: readonly T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export class MissingOrcamentoGeometry extends Error {}

/** Os bytes do .frag do modelo. `onProgress` recebe a fração baixada (0 a 1); não é chamado quando vem do cache. */
export async function downloadGeometry(
  workId: string,
  model: OrcamentoModel,
  signal: AbortSignal,
  onProgress?: (fraction: number) => void,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!model.parts) throw new MissingOrcamentoGeometry(`${model.file || model.discipline} ainda não tem geometria no Orçamento 4D.`);
  const key = keyOf(model);
  const cached = await readCache(key);
  if (cached) return cached;
  let done = 0;
  const parts = await inParallel(
    Array.from({ length: model.parts }, (_, index) => index),
    PARTS_IN_PARALLEL,
    async part => {
      signal.throwIfAborted();
      const query = new URLSearchParams({ workId, modeloId: model.id, revisao: String(model.revision), parte: String(part) });
      const response = await fetch(`/api/ifc/orcamento/geometria?${query}`, { cache: 'no-store', signal });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: unknown };
        throw new Error(typeof body.error === 'string' ? body.error : `Não foi possível baixar a geometria de ${model.discipline}.`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      onProgress?.(++done / model.parts);
      return bytes;
    },
  );
  const bytes = joinParts(parts);
  // o Fragments transfere o buffer para o worker (fica inutilizável aqui): grava antes de devolver
  await writeCache(model.id, key, bytes);
  return bytes;
}

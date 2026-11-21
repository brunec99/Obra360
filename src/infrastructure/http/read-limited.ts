/** Lê o corpo de uma requisição como texto, parando em `maxBytes`. Devolve `null` quando passa do limite.
 *
 * Por que não `request.text()`: sem `Content-Length` (envio em partes, `Transfer-Encoding: chunked`), ele
 * guarda o corpo inteiro na memória antes de qualquer conferência de tamanho. Numa rota aberta sem login
 * isso deixa qualquer um derrubar o processo com um envio enorme. Aqui a leitura é cancelada assim que
 * passa do limite. */
export async function readTextLimited(request: Request, maxBytes: number): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

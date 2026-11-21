import test from 'node:test';
import assert from 'node:assert/strict';
import { readTextLimited } from '../src/infrastructure/http/read-limited';

/** Requisição com corpo em partes, sem Content-Length (o caso que `request.text()` não freia). */
function chunked(parts: string[]) {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < parts.length) controller.enqueue(new TextEncoder().encode(parts[i++]));
      else controller.close();
    },
  });
  return { request: new Request('https://x.test/', { method: 'POST', body, duplex: 'half' } as RequestInit), lidas: () => i };
}

test('corpo dentro do limite volta inteiro, com acentos', async () => {
  const { request } = chunked(['{"nome":"Jo', 'ão"}']);
  assert.equal(await readTextLimited(request, 100), '{"nome":"João"}');
});

test('corpo acima do limite devolve null e para de ler', async () => {
  const { request, lidas } = chunked(Array.from({ length: 1000 }, () => 'x'.repeat(1024)));
  assert.equal(await readTextLimited(request, 10 * 1024), null);
  assert.ok(lidas() < 20, `leu ${lidas()} partes`);
});

test('o limite é em bytes, não em caracteres', async () => {
  const { request } = chunked(['ééééé']); // 10 bytes
  assert.equal(await readTextLimited(request, 9), null);
});

test('sem corpo, texto vazio', async () => {
  assert.equal(await readTextLimited(new Request('https://x.test/', { method: 'POST' }), 10), '');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { GET } from '../src/app/portal-login/route';

/** `GET /portal-login` (21/11/2026): a página que reenvia o token por POST não pode usar `no-referrer`.
 * Com ela o navegador manda `Origin: null` no POST e a conferência de origem recusa toda entrada real. */

test('página do portal-login: referrer same-origin (Origin preservado no POST), nunca no-referrer', async () => {
  const resposta = await GET(new NextRequest('https://obra360.exemplo.com.br/portal-login?token=abc'));
  assert.equal(resposta.status, 200);
  assert.equal(resposta.headers.get('referrer-policy'), 'same-origin');
  const html = await resposta.text();
  assert.match(html, /<meta name="referrer" content="same-origin">/);
  assert.doesNotMatch(html, /no-referrer/);
  assert.match(html, /history\.replaceState\(null,'','\/portal-login'\)/);
});

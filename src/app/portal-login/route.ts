import { NextResponse, type NextRequest } from 'next/server';
import { createServerSupabase } from '@/infrastructure/auth/supabase-server';
import { MENSAGENS_PORTAL, trocarTokenDoPortal } from '@/infrastructure/auth/portal-login';
import { publicOrigin } from '@/infrastructure/public-origin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Entrada pelo Portal Inteligência: `/portal-login?token=...` (ver `infrastructure/auth/portal-login.ts`).
 *
 * Em duas etapas, de propósito:
 * - GET devolve uma página mínima que tira o token da barra de endereço e o reenvia por POST. Um GET que
 *   queimasse o token seria disparado por qualquer pré-carregamento ou leitor de link e a pessoa cairia
 *   em "link já usado"; e o token sairia no histórico e no `Referer`.
 * - POST troca o token por sessão no servidor e leva para `/obras`.
 *
 * Fica fora do proxy (`src/proxy.ts`): quem chega aqui ainda não tem sessão. */

// Nunca dentro de moldura de outro site: a página se envia sozinha, e um site alheio a esconderia num iframe.
const SEM_CACHE = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
};

function origemPublica(request: NextRequest) {
  return publicOrigin(request.headers, request.nextUrl.origin, process.env.PUBLIC_SITE_URL);
}

function paraLogin(request: NextRequest, mensagem: string) {
  const url = new URL('/login', origemPublica(request));
  url.searchParams.set('error', mensagem);
  return NextResponse.redirect(url, { status: 303, headers: SEM_CACHE });
}

const escaparHtml = (texto: string) =>
  texto.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token');
  if (!token) return paraLogin(request, MENSAGENS_PORTAL.semToken);
  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Entrando no Obra 360…</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100dvh;margin:0;color:#0f172a}button{font:inherit;padding:.6rem 1.2rem;border-radius:.5rem;border:1px solid #cbd5e1;background:#fff}</style>
</head><body>
<form id="f" method="post" action="/portal-login">
<input type="hidden" name="token" value="${escaparHtml(token)}">
<p>Entrando no Obra 360 pelo Portal Inteligência…</p>
<noscript><button type="submit">Continuar</button></noscript>
</form>
<script>history.replaceState(null,'','/portal-login');document.getElementById('f').submit();</script>
</body></html>`;
  return new NextResponse(html, { status: 200, headers: { ...SEM_CACHE, 'Content-Type': 'text/html; charset=utf-8' } });
}

export async function POST(request: NextRequest) {
  const origem = origemPublica(request);
  // Só aceita o envio da própria página do GET: outro site não consegue logar alguém com um token alheio.
  if (request.headers.get('origin') !== origem) return paraLogin(request, MENSAGENS_PORTAL.tokenInvalido);
  let token: FormDataEntryValue | null = null;
  try {
    token = (await request.formData()).get('token');
  } catch {
    return paraLogin(request, MENSAGENS_PORTAL.semToken);
  }

  const supabase = await createServerSupabase();
  // Quem já está logado aqui não é trocado por outra pessoa: um link do Portal de terceiro (mandado por
  // mensagem, por exemplo) não pode pôr o navegador de alguém na conta de outro. A mesma pessoa segue.
  const {
    data: { user: atual },
  } = await supabase.auth.getUser();

  const troca = await trocarTokenDoPortal(token, { origem });
  if (!troca.ok) return paraLogin(request, troca.mensagem);
  if (atual) {
    if (atual.email?.toLowerCase() === troca.email) return NextResponse.redirect(new URL('/obras', origem), { status: 303, headers: SEM_CACHE });
    return paraLogin(request, MENSAGENS_PORTAL.outraSessao);
  }

  // Sessão criada aqui, nos cookies desta resposta (o mesmo caminho do link de convite em /auth/callback).
  const { data, error } = await supabase.auth.verifyOtp({ token_hash: troca.tokenHash, type: 'magiclink' });
  if (error || data.user?.email?.toLowerCase() !== troca.email) {
    if (!error) await supabase.auth.signOut({ scope: 'local' });
    return paraLogin(request, MENSAGENS_PORTAL.indisponivel);
  }
  return NextResponse.redirect(new URL('/obras', origem), { status: 303, headers: SEM_CACHE });
}

import { getRouteProfile } from '@/infrastructure/auth/supabase-server';
import { logRouteError } from '@/infrastructure/log';
import { recordAccess } from '@/infrastructure/access/access-store';
import { deviceOfUserAgent, MAX_RECORD_SECONDS, screenOfPath } from '@/domain/access-usage';

export const runtime = 'nodejs';
const ROUTE = '/api/acessos';

/** Tempo ativo vindo do navegador (15/11/2026, modelo aprovado "Aba Acessos no Dashboard geral"):
 * `{ path, seconds, workId? }`, a cada minuto, na troca de tela e quando a aba é escondida (`sendBeacon`).
 * A tela e a obra saem do `path` (no modo de campo, a obra vem em `workId`), o aparelho do User-Agent (o campo
 * conta sempre como celular, regra 8). Responde 204 em quase tudo: o registro nunca mostra erro nem trava a tela
 * (regra 17), e endereço que não conta (impressão, rota desconhecida) é ignorado. Sem a migração 0051, nada é
 * gravado e a resposta é a mesma. Só pede sessão: qualquer pessoa logada registra o próprio uso. */
const empty = (status = 204) => new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(request: Request) {
  const profile = await getRouteProfile().catch(() => null);
  if (!profile) return empty(401);
  let body: { path?: unknown; seconds?: unknown; workId?: unknown } | null = null;
  try {
    // `sendBeacon` pode chegar sem `Content-Type: application/json`; o corpo é lido como texto.
    body = JSON.parse(await request.text());
  } catch {
    return empty(400);
  }
  const seconds = typeof body?.seconds === 'number' && Number.isFinite(body.seconds) ? Math.floor(body.seconds) : 0;
  if (seconds < 1 || typeof body?.path !== 'string') return empty();
  const target = screenOfPath(body.path, typeof body.workId === 'string' ? body.workId : null);
  if (!target) return empty();
  try {
    await recordAccess({
      ...target,
      profileId: profile.id,
      device: target.field ? 'mobile' : deviceOfUserAgent(request.headers.get('user-agent')),
      seconds: Math.min(seconds, MAX_RECORD_SECONDS),
    });
  } catch (cause) {
    logRouteError(`POST ${ROUTE}`, cause, { actorId: profile.id, screen: target.screen });
  }
  return empty();
}

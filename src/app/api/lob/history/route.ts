import { NextResponse, type NextRequest } from 'next/server';
import { requireModuleAccess } from '@/infrastructure/auth/supabase-server';
import { listLobHistory, type LobHistoryItem } from '@/infrastructure/repositories/supabase/lob-history-repository';
import { logRouteError } from '@/infrastructure/log';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'no-store' };
const responseError = (error: string, status: number) => NextResponse.json({ error }, { status, headers });
const MAX_LIMIT = 200;

/** Histórico de alterações da Linha de Balanço de uma obra (25/11/2026): as últimas `limit` (100 por
 * padrão, no máximo 200), das mais recentes para as mais antigas, com autor e frase pronta. Só leitura:
 * o perfil Consulta também vê. */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const workId = params.get('workId') ?? '';
  if (!workId) return responseError('Obra não informada.', 400);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(params.get('limit') ?? 100) || 100));
  const gate = await requireModuleAccess('longo-prazo');
  if (gate.error) return gate.error;
  const { profile } = gate.access;
  if (!profile) return responseError('Perfil não provisionado. Contate o gestor.', 403);
  if (!profile.workIds.includes(workId)) return responseError('Você não tem acesso a esta obra.', 403);
  try {
    const items: LobHistoryItem[] = await listLobHistory(workId, limit);
    return NextResponse.json({ items }, { headers });
  } catch (error) {
    logRouteError('GET /api/lob/history', error, { actorId: profile.id, workId });
    return responseError('Não foi possível carregar o histórico da Linha de Balanço.', 502);
  }
}

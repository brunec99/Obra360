import { NextResponse } from 'next/server';
import { getRouteProfile } from '@/infrastructure/auth/supabase-server';
import { logRouteError } from '@/infrastructure/log';
import { loadAccessPayload } from '@/infrastructure/access/access-store';
import { daysBetween, isLocalDate, MAX_ACCESS_DAYS, previousRange } from '@/domain/access-usage';

export const runtime = 'nodejs';
const ROUTE = '/api/dashboard/acessos';
const headers = { 'Cache-Control': 'no-store' };
const responseError = (error: string, status: number) => NextResponse.json({ error }, { status, headers });

/** Dados da aba "Acessos" do Dashboard geral (15/11/2026, modelo aprovado): `?de=AAAA-MM-DD&ate=AAAA-MM-DD`, em dias
 * de Brasília. Só admin (regra 2). Devolve o uso do período e do período anterior do mesmo tamanho (setas dos
 * cartões), as pessoas cadastradas com o último login do Supabase Auth, as obras e o último acesso de cada pessoa;
 * os filtros e as contas ficam na tela (`buildAccessView`). Sem a migração 0051, `migrated: false` e listas vazias. */
export async function GET(request: Request) {
  const profile = await getRouteProfile().catch(() => null);
  if (!profile) return responseError('Perfil não provisionado. Contate o gestor.', 403);
  if (profile.role !== 'admin') return responseError('Só administradores veem os acessos.', 403);

  const params = new URL(request.url).searchParams;
  const from = params.get('de');
  const to = params.get('ate');
  if (!isLocalDate(from) || !isLocalDate(to) || from > to) return responseError('Período inválido.', 400);
  if (daysBetween(from, to) + 1 > MAX_ACCESS_DAYS) return responseError(`O período vai até ${MAX_ACCESS_DAYS} dias.`, 400);
  try {
    const payload = await loadAccessPayload({ from, to, ...previousRange(from, to), now: new Date().toISOString() });
    return NextResponse.json(payload, { headers });
  } catch (cause) {
    logRouteError(`GET ${ROUTE}`, cause, { actorId: profile.id, from, to });
    return responseError('Não foi possível carregar os acessos. Tente de novo em instantes.', 502);
  }
}

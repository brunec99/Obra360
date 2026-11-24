import { NextResponse } from 'next/server';
import { getRouteProfile } from '@/infrastructure/auth/supabase-server';
import { listEnterprises, SiengeError } from '@/infrastructure/integrations/sienge/client';
import { logRouteError } from '@/infrastructure/log';

export const runtime = 'nodejs';
export const maxDuration = 60;
const headers = { 'Cache-Control': 'no-store' };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers });

/** Empreendimentos do Sienge (23/11/2026), para o administrador escolher o da obra na seção
 * "Orçamento do Sienge" das Configurações da obra. Só código e nome; só o administrador lê. */
export async function GET() {
  const profile = await getRouteProfile();
  if (profile?.role !== 'admin') return fail('Só o administrador liga a obra ao Sienge.', 403);
  try {
    return NextResponse.json({ enterprises: await listEnterprises() }, { headers });
  } catch (cause) {
    if (cause instanceof SiengeError) return fail(cause.message, cause.status);
    logRouteError('GET /api/sienge/enterprises', cause, { actorId: profile.id });
    return fail('Não foi possível ler os empreendimentos do Sienge.', 502);
  }
}

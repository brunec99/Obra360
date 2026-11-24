import { NextResponse, type NextRequest } from 'next/server';
import { requireModuleAccess } from '@/infrastructure/auth/supabase-server';
import { getServiceClient } from '@/infrastructure/repositories/supabase/client';
import { fetchBudget, SIENGE_NOT_CONFIGURED, SiengeError, siengeConfigFromEnv } from '@/infrastructure/integrations/sienge/client';
import { logRouteError } from '@/infrastructure/log';
import type { SiengeBudget } from '@/domain/sienge-budget';

export const runtime = 'nodejs';
// Um orçamento grande (o do Atmos tem cerca de 11 mil linhas) são dezenas de páginas no Sienge.
export const maxDuration = 300;
const headers = { 'Cache-Control': 'no-store' };
const fail = (error: string, status: number, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error, ...extra }, { status, headers });
const missingColumn = (code?: string) => code === '42703' || code === 'PGRST204' || code === '42P01' || code === 'PGRST205';

/** A última leitura de cada empreendimento fica dez minutos na memória do servidor: reabrir o diálogo
 * não repete as dezenas de chamadas ao Sienge. `atualizar=1` força nova leitura. */
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<number, { at: number; budget: SiengeBudget }>();

/** Orçamento do Sienge da obra (23/11/2026), para o "Buscar do Sienge" da visão Custos da Linha de
 * Balanço: lê o empreendimento ligado à obra nas Configurações e devolve os itens com valor de cada
 * unidade construtiva. Não grava nada: a tela põe os itens no rascunho e o "Salvar" de sempre grava
 * com `save_costs`. Traz valores em reais, por isso só entra quem edita o longo prazo da obra. */
export async function GET(request: NextRequest) {
  const gate = await requireModuleAccess('longo-prazo');
  if (gate.error) return gate.error;
  const { profile } = gate.access;
  if (!profile) return fail('Perfil não provisionado. Contate o gestor.', 403);
  if (profile.role === 'viewer') return fail('Seu perfil permite apenas consulta.', 403);
  const workId = request.nextUrl.searchParams.get('workId') ?? '';
  if (!workId) return fail('Obra não informada.', 400);
  if (!profile.workIds.includes(workId)) return fail('Você não tem acesso a esta obra.', 403);
  if (!siengeConfigFromEnv()) return fail(SIENGE_NOT_CONFIGURED, 503, { reason: 'not-configured' });

  const settings = await getServiceClient().from('work_settings').select('sienge_building_id').eq('work_id', workId).maybeSingle();
  if (settings.error) {
    if (missingColumn(settings.error.code))
      return fail('Aplique a migração 0057_sienge_link.sql no Supabase para ligar a obra ao Sienge.', 503, { reason: 'migration' });
    logRouteError('GET /api/sienge/budget', settings.error, { actorId: profile.id, workId, step: 'settings' });
    return fail('Não foi possível ler as configurações da obra.', 502);
  }
  const buildingId = (settings.data as { sienge_building_id?: number | null } | null)?.sienge_building_id ?? null;
  if (!buildingId)
    return fail(
      'Esta obra ainda não está ligada a um empreendimento do Sienge. O administrador faz a ligação em Configurações da obra.',
      409,
      {
        reason: 'not-linked',
      },
    );

  const refresh = request.nextUrl.searchParams.get('atualizar') === '1';
  const cached = cache.get(buildingId);
  if (!refresh && cached && Date.now() - cached.at < CACHE_MS) return NextResponse.json(cached.budget, { headers });
  try {
    const budget = await fetchBudget(buildingId);
    cache.set(buildingId, { at: Date.now(), budget });
    return NextResponse.json(budget, { headers });
  } catch (cause) {
    if (cause instanceof SiengeError) return fail(cause.message, cause.status);
    logRouteError('GET /api/sienge/budget', cause, { actorId: profile.id, workId, buildingId });
    return fail('Não foi possível ler o orçamento no Sienge. Tente de novo em instantes.', 502);
  }
}

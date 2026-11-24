import { NextResponse, type NextRequest } from 'next/server';
import { requireModuleAccess } from '@/infrastructure/auth/supabase-server';
import { getServiceClient } from '@/infrastructure/repositories/supabase/client';
import { fetchBudget, SIENGE_NOT_CONFIGURED, SiengeError, siengeConfigFromEnv } from '@/infrastructure/integrations/sienge/client';
import { BudgetCache } from '@/infrastructure/integrations/sienge/budget-cache';
import { logRouteError } from '@/infrastructure/log';

export const runtime = 'nodejs';
// Um orçamento grande (o do Atmos tem cerca de 11 mil linhas) são dezenas de páginas no Sienge.
export const maxDuration = 300;
const headers = { 'Cache-Control': 'no-store' };
const fail = (error: string, status: number, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error, ...extra }, { status, headers });
const missingColumn = (code?: string) => code === '42703' || code === 'PGRST204' || code === '42P01' || code === 'PGRST205';

/** A última leitura de cada empreendimento fica 15 minutos na memória do servidor e vale para todos:
 * reabrir o diálogo ou "Ler de novo" dentro da janela não repete as dezenas de chamadas pagas ao
 * Sienge, e dois pedidos ao mesmo tempo viram uma leitura só (24/11/2026). */
const cache = new BudgetCache(fetchBudget);

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

  // `atualizar=1` (o "Ler de novo") segue aceito, mas só lê no Sienge depois do intervalo mínimo.
  try {
    return NextResponse.json(await cache.get(buildingId), { headers });
  } catch (cause) {
    if (cause instanceof SiengeError) return fail(cause.message, cause.status);
    logRouteError('GET /api/sienge/budget', cause, { actorId: profile.id, workId, buildingId });
    return fail('Não foi possível ler o orçamento no Sienge. Tente de novo em instantes.', 502);
  }
}

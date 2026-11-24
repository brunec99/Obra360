import { NextResponse } from 'next/server';
import { canAdminDailyReport, canWriteDailyReport } from '@/application/use-cases/daily-report-commands';
import { DAILY_READ_ONLY_MESSAGE, type DailySupport, type SiengeOption } from '@/domain/daily-report';
import type { User } from '@/domain/entities';
import type { HeadcountEntry } from '@/domain/headcount';
import { requireModuleAccess } from '@/infrastructure/auth/supabase-server';
import { siengeConfigFromEnv, SiengeError } from '@/infrastructure/integrations/sienge/client';
import { listDailyReportTypes, listSites } from '@/infrastructure/integrations/sienge/daily-report';
import { logRouteError } from '@/infrastructure/log';
import {
  loadCompanyLinks,
  loadDailyLocals,
  loadSiengeBuildingId,
  loadSiengeUserCode,
  loadWeekCommitments,
} from '@/infrastructure/repositories/supabase/daily-report-repository';

/** O que as rotas de `/api/diario` têm em comum (24/11/2026): o portão de acesso e a montagem do "apoio"
 * do diário (listas do Sienge, locais, ligações, sugestões). Só Route Handlers importam este arquivo. */

export const dailyHeaders = { 'Cache-Control': 'no-store' };
export const dailyError = (error: string, status: number, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error, ...extra }, { status, headers: dailyHeaders });
export const DAILY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Quem tem o módulo do diário liberado e um perfil. `write` recusa o papel consulta; `admin` só deixa o
 * administrador (excluir do Sienge e reabrir). A obra, cada rota confere com `profile.workIds`. */
export async function dailyGate(level: 'read' | 'write' | 'admin'): Promise<{ profile: User } | NextResponse> {
  const gate = await requireModuleAccess('diario');
  if (gate.error) return gate.error;
  const profile = gate.access.profile;
  if (!profile) return dailyError('Perfil não provisionado. Contate o gestor.', 403);
  if (level !== 'read' && !canWriteDailyReport(profile)) return dailyError(DAILY_READ_ONLY_MESSAGE, 403);
  if (level === 'admin' && !canAdminDailyReport(profile)) return dailyError('Só o administrador exclui o diário do Sienge e reabre.', 403);
  return { profile };
}

/** O corpo JSON como objeto, ou nulo se não for um. */
export async function dailyBody(request: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await request.json().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}
export const dailyText = (value: unknown) => (typeof value === 'string' ? value : '');

type SiengeLists = Pick<DailySupport, 'siengeConfigured' | 'eventTypes' | 'crewTypes' | 'equipmentTypes' | 'sites' | 'supportError'>;

/** As listas do Sienge para a tela. Tudo aqui é opcional: sem as variáveis, sem empreendimento ligado ou
 * com o Sienge fora, as listas vêm vazias (`sites: null`) e `supportError` diz o porquê em uma frase.
 * Nunca lança. A lista de locais responder 403 (o caso de hoje) não é erro: `sites` vem nulo e a tela
 * liga o local pelo código. */
export async function loadSiengeLists(buildingId: number | null, context: Record<string, unknown> = {}): Promise<SiengeLists> {
  const empty = { eventTypes: [] as SiengeOption[], crewTypes: [] as SiengeOption[], equipmentTypes: [] as SiengeOption[], sites: null };
  if (!siengeConfigFromEnv())
    return {
      ...empty,
      siengeConfigured: false,
      supportError: 'O Sienge não está configurado no servidor: as listas do Sienge não foram carregadas.',
    };
  const reason = (error: unknown, what: string) => {
    if (error instanceof SiengeError) return `Não foi possível ler ${what} do Sienge: ${error.message}`;
    logRouteError('diario loadSiengeLists', error, context);
    return `Não foi possível ler ${what} do Sienge.`;
  };
  const [types, sites] = await Promise.allSettled([
    listDailyReportTypes(),
    buildingId === null ? Promise.resolve(null) : listSites(buildingId),
  ]);
  const errors: string[] = [];
  if (types.status === 'rejected') errors.push(reason(types.reason, 'os tipos de ocorrência, equipe e equipamento'));
  if (sites.status === 'rejected') errors.push(reason(sites.reason, 'os locais'));
  if (buildingId === null) errors.push('A obra não está ligada a um empreendimento do Sienge (Configurações da obra).');
  return {
    ...(types.status === 'fulfilled' ? types.value : empty),
    sites: sites.status === 'fulfilled' ? sites.value : null,
    siengeConfigured: true,
    supportError: errors.join(' '),
  };
}

const distinct = (values: string[]) =>
  [...new Set(values.map(value => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));

/** O apoio inteiro do diário de uma obra num dia. As leituras do banco lançam (a rota trata); as do
 * Sienge, não. `headcount` é o histograma da obra, que a rota já leu. */
export async function loadDailySupport(
  workId: string,
  date: string,
  profileId: string,
  headcount: readonly HeadcountEntry[],
): Promise<DailySupport> {
  const siengeBuildingId = await loadSiengeBuildingId(workId);
  const [lists, locals, companyLinks, commitments, siengeUserCode] = await Promise.all([
    loadSiengeLists(siengeBuildingId, { actorId: profileId, workId }),
    loadDailyLocals(workId),
    loadCompanyLinks(),
    loadWeekCommitments(workId, date),
    loadSiengeUserCode(profileId),
  ]);
  return {
    siengeBuildingId,
    ...lists,
    locals,
    companyLinks,
    companies: distinct(headcount.map(entry => entry.company)),
    roles: distinct(headcount.map(entry => entry.role)),
    commitments,
    siengeUserCode,
  };
}

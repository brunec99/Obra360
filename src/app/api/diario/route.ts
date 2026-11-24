import { NextResponse, type NextRequest } from 'next/server';
import { canAdminDailyReport, canWriteDailyReport, crewsOfDay, lastCrewsBefore } from '@/application/use-cases/daily-report-commands';
import type { DailyReportResponse } from '@/domain/daily-report';
import { validateDate } from '@/domain/validation';
import { todayInSaoPaulo } from '@/infrastructure/clock';
import { dailyError, dailyGate, dailyHeaders, loadDailySupport } from '@/infrastructure/daily-report-support';
import { logRouteError } from '@/infrastructure/log';
import { SupabasePlanningRepository } from '@/infrastructure/repositories/supabase/planning-repository';
import {
  DailyReportUnavailableError,
  loadDailyDays,
  loadDailyReport,
  signDailyPhotos,
} from '@/infrastructure/repositories/supabase/daily-report-repository';
import { HeadcountUnavailableError, loadHeadcount } from '@/infrastructure/repositories/supabase/headcount-repository';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** O diário de uma obra num dia (`?workId=&date=`, a data padrão é hoje em São Paulo): o diário e as fotos
 * (nulo e vazio se o dia ainda não tem), a mão de obra do dia lida do histograma, os diários dos 60 dias
 * até a data e o apoio (listas do Sienge, locais, ligações, sugestões). Lê quem tem o módulo e a obra;
 * `canEdit` e `canAdmin` só escondem botões — quem barra são as rotas de gravação. O Sienge nunca derruba
 * esta rota: sem ele as listas vêm vazias e `support.supportError` explica. Sem a migração 0059 (ou sem o
 * histograma, 0045) responde "indisponível". */
export async function GET(request: NextRequest) {
  const gate = await dailyGate('read');
  if (gate instanceof NextResponse) return gate;
  const { profile } = gate;
  const workId = request.nextUrl.searchParams.get('workId') ?? '';
  // Sem obra: as obras da pessoa, para o modo de campo (`/campo/diario`) montar a lista e abrir sem sinal
  // depois. Mesmo recorte leve do snapshot que a terminalidade usa no campo.
  if (!workId) {
    try {
      const snapshot = await new SupabasePlanningRepository().getSnapshot({ workIds: profile.workIds, commitments: { ids: [] } });
      const works = snapshot.works
        .filter(work => profile.workIds.includes(work.id) && work.active !== false)
        .map(work => ({ id: work.id, name: work.name, code: work.code }))
        .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
      return NextResponse.json({ works }, { headers: dailyHeaders });
    } catch (error) {
      logRouteError('GET /api/diario', error, { actorId: profile.id });
      return dailyError('Não foi possível carregar as obras.', 502);
    }
  }
  if (!profile.workIds.includes(workId)) return dailyError('Você não tem acesso a esta obra.', 403);
  const today = todayInSaoPaulo();
  const date = request.nextUrl.searchParams.get('date') || today;
  try {
    validateDate(date);
  } catch {
    return dailyError('Data inválida.', 400);
  }
  try {
    const [current, headcount, days] = await Promise.all([
      loadDailyReport(workId, date),
      loadHeadcount(workId),
      loadDailyDays(workId, date),
    ]);
    const [photos, support] = await Promise.all([
      signDailyPhotos(current.photos),
      loadDailySupport(workId, date, profile.id, headcount.entries),
    ]);
    const body: DailyReportResponse = {
      available: true,
      canEdit: canWriteDailyReport(profile),
      canAdmin: canAdminDailyReport(profile),
      today,
      date,
      report: current.report,
      photos,
      crews: crewsOfDay(headcount.entries, date),
      lastCrews: lastCrewsBefore(headcount.entries, date),
      days,
      support,
    };
    return NextResponse.json(body, { headers: dailyHeaders });
  } catch (error) {
    if (error instanceof DailyReportUnavailableError || error instanceof HeadcountUnavailableError)
      return NextResponse.json({ available: false } satisfies DailyReportResponse, { headers: dailyHeaders });
    logRouteError('GET /api/diario', error, { actorId: profile.id, workId, date });
    return dailyError('Não foi possível carregar o diário da obra.', 502);
  }
}

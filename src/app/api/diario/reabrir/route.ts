import { NextResponse } from 'next/server';
import { reopenDailyReport } from '@/application/use-cases/daily-report-commands';
import { DAILY_UUID, dailyBody, dailyError, dailyGate, dailyHeaders, dailyText } from '@/infrastructure/daily-report-support';
import { SIENGE_NOT_CONFIGURED, siengeConfigFromEnv, SiengeError } from '@/infrastructure/integrations/sienge/client';
import { deleteDailyReport } from '@/infrastructure/integrations/sienge/daily-report';
import { logRouteError } from '@/infrastructure/log';
import {
  DailyReportConflictError,
  DailyReportUnavailableError,
  loadDailyReportById,
  resetPhotosToPending,
  saveDailyReportRow,
  signDailyPhotos,
} from '@/infrastructure/repositories/supabase/daily-report-repository';

export const runtime = 'nodejs';
export const maxDuration = 60;

const ROUTE = 'POST /api/diario/reabrir';

/** Só o administrador (`{ workId, reportId }`): exclui o diário do Sienge e, se der certo, devolve o
 * diário a rascunho e as fotos a "pendente" (os anexos saem do Sienge junto com o diário). É o único
 * caminho para corrigir um diário enviado, porque o Sienge não tem rota de edição. Se o Sienge recusar
 * (diário já usado em integração), a mensagem dele sobe e nada muda aqui. Diário que o Sienge já não
 * tem (404: foi excluído por lá) também reabre. Responde `{ report, photos }`. */
export async function POST(request: Request) {
  const gate = await dailyGate('admin');
  if (gate instanceof NextResponse) return gate;
  const { profile } = gate;
  const body = await dailyBody(request);
  if (!body) return dailyError('Corpo da requisição inválido.', 400);
  const workId = dailyText(body.workId);
  const reportId = dailyText(body.reportId);
  if (!workId) return dailyError('Obra não informada.', 400);
  if (!DAILY_UUID.test(reportId)) return dailyError('Diário não informado.', 400);
  if (!profile.workIds.includes(workId)) return dailyError('Você não tem acesso a esta obra.', 403);
  const context = { actorId: profile.id, workId, reportId };

  try {
    const current = await loadDailyReportById(reportId);
    if (!current || current.report.workId !== workId) return dailyError('Diário não encontrado. Recarregue a página.', 404);
    const { report } = current;
    if (report.status !== 'sent' || report.siengeId === null || report.siengeBuildingId === null)
      return dailyError('Este diário não foi enviado ao Sienge: não há o que reabrir.', 400);
    if (!siengeConfigFromEnv()) return dailyError(SIENGE_NOT_CONFIGURED, 503);

    try {
      await deleteDailyReport(report.siengeBuildingId, report.siengeId);
    } catch (error) {
      if (!(error instanceof SiengeError)) throw error;
      if (error.upstream !== 404) return dailyError(error.message, error.status);
    }

    // O Sienge já não tem o diário: daqui em diante, falha em gravar é diário "enviado" aqui e inexistente lá.
    try {
      let reopened = reopenDailyReport(report, { actorId: profile.id, now: new Date().toISOString() });
      try {
        await saveDailyReportRow(reopened, report.version);
      } catch (error) {
        if (!(error instanceof DailyReportConflictError)) throw error;
        // A versão andou no meio tempo (foto nova num diário enviado): relê e grava sobre a atual.
        const fresh = await loadDailyReportById(reportId);
        if (!fresh) throw error;
        reopened = reopenDailyReport(fresh.report, { actorId: profile.id, now: new Date().toISOString() });
        await saveDailyReportRow(reopened, fresh.report.version);
      }
      await resetPhotosToPending(reportId);
      const after = await loadDailyReportById(reportId);
      return NextResponse.json(
        { report: after?.report ?? reopened, photos: await signDailyPhotos(after?.photos ?? []) },
        { headers: dailyHeaders },
      );
    } catch (cause) {
      logRouteError(ROUTE, cause, { ...context, step: 'DIARIO EXCLUIDO DO SIENGE E NAO REABERTO', siengeId: report.siengeId });
      return dailyError('O diário foi excluído do Sienge, mas não foi possível reabri-lo aqui. Clique em reabrir de novo.', 502);
    }
  } catch (error) {
    if (error instanceof DailyReportUnavailableError) return dailyError(error.message, 503);
    logRouteError(ROUTE, error, context);
    return dailyError('Não foi possível reabrir o diário. Tente novamente.', 502);
  }
}

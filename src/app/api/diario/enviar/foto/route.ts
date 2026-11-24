import { NextResponse } from 'next/server';
import type { DailyPhoto, DailySendPhotoResult } from '@/domain/daily-report';
import { siengePhotoQuery } from '@/domain/sienge-daily-report';
import { DAILY_UUID, dailyBody, dailyError, dailyGate, dailyHeaders, dailyText } from '@/infrastructure/daily-report-support';
import { SIENGE_NOT_CONFIGURED, siengeConfigFromEnv, SiengeError } from '@/infrastructure/integrations/sienge/client';
import { uploadDailyAttachment } from '@/infrastructure/integrations/sienge/daily-report';
import { logRouteError } from '@/infrastructure/log';
import {
  DailyReportUnavailableError,
  downloadDailyPhoto,
  findPhoto,
  loadDailyLocals,
  loadDailyReportById,
  savePhotoSiengeStatus,
  signDailyPhotos,
} from '@/infrastructure/repositories/supabase/daily-report-repository';

export const runtime = 'nodejs';
export const maxDuration = 120;

const ROUTE = 'POST /api/diario/enviar/foto';
/** Fotos com envio em andamento neste processo: o segundo clique não manda o mesmo anexo duas vezes. */
const sending = new Set<string>();
const view = async (photo: DailyPhoto) => (await signDailyPhotos([photo]))[0];

/** Manda UMA foto de um diário já enviado ao Sienge (`{ workId, photoId }`), como anexo. A tela chama uma
 * vez por foto pendente, em fila. Foto que já foi (`sent`) volta como está, sem reenviar. Quando o Sienge
 * recusa, a foto fica `error` com a mensagem e a resposta de erro leva `photo` nesse estado. */
export async function POST(request: Request) {
  const gate = await dailyGate('write');
  if (gate instanceof NextResponse) return gate;
  const { profile } = gate;
  const body = await dailyBody(request);
  if (!body) return dailyError('Corpo da requisição inválido.', 400);
  const workId = dailyText(body.workId);
  const photoId = dailyText(body.photoId);
  if (!workId) return dailyError('Obra não informada.', 400);
  if (!DAILY_UUID.test(photoId)) return dailyError('Foto não informada.', 400);
  if (!profile.workIds.includes(workId)) return dailyError('Você não tem acesso a esta obra.', 403);
  const context = { actorId: profile.id, workId, photoId };

  if (sending.has(photoId)) return dailyError('Esta foto já está sendo enviada. Aguarde.', 409);
  sending.add(photoId);
  try {
    const found = await findPhoto(photoId);
    if (!found || found.workId !== workId) return dailyError('Foto não encontrada. Recarregue a página.', 404);
    const { photo } = found;
    if (photo.siengeStatus === 'sent')
      return NextResponse.json({ photo: await view(photo) } satisfies DailySendPhotoResult, { headers: dailyHeaders });

    const current = await loadDailyReportById(photo.reportId);
    const report = current?.report;
    if (!report || report.status !== 'sent' || report.siengeId === null || report.siengeBuildingId === null)
      return dailyError('Envie o diário ao Sienge antes das fotos.', 400);
    if (!photo.description.trim()) return dailyError('Foto sem descrição. O Sienge exige a descrição.', 400);
    if (!siengeConfigFromEnv()) return dailyError(SIENGE_NOT_CONFIGURED, 503);

    const [locals, bytes] = await Promise.all([loadDailyLocals(workId), downloadDailyPhoto(photo.storagePath)]);
    try {
      await uploadDailyAttachment(report.siengeBuildingId, report.siengeId, siengePhotoQuery(photo, locals), {
        name: `diario-${report.date}-${photo.id.slice(0, 8)}.jpg`,
        bytes,
      });
    } catch (error) {
      if (!(error instanceof SiengeError)) throw error;
      const failed: DailyPhoto = { ...photo, siengeStatus: 'error', siengeError: error.message };
      await savePhotoSiengeStatus(photo.id, 'error', error.message).catch(cause =>
        logRouteError(ROUTE, cause, { ...context, step: 'gravar a recusa do Sienge' }),
      );
      return dailyError(error.message, error.status, { photo: await view(failed) });
    }
    try {
      await savePhotoSiengeStatus(photo.id, 'sent');
    } catch (cause) {
      // O anexo está no Sienge e a foto segue "pendente" aqui: reenviar duplicaria o anexo lá.
      logRouteError(ROUTE, cause, { ...context, step: 'FOTO ANEXADA NO SIENGE E NAO MARCADA', siengeId: report.siengeId });
      return dailyError(
        'A foto foi anexada no Sienge, mas não foi possível registrar aqui. Recarregue a página antes de enviar de novo.',
        502,
      );
    }
    const sent: DailyPhoto = { ...photo, siengeStatus: 'sent', siengeError: '' };
    return NextResponse.json({ photo: await view(sent) } satisfies DailySendPhotoResult, { headers: dailyHeaders });
  } catch (error) {
    if (error instanceof DailyReportUnavailableError) return dailyError(error.message, 503);
    logRouteError(ROUTE, error, context);
    return dailyError('Não foi possível enviar a foto ao Sienge. Tente novamente.', 502);
  } finally {
    sending.delete(photoId);
  }
}

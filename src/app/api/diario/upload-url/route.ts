import { NextResponse } from 'next/server';
import { DAILY_LIMITS, dailyPhotoPaths } from '@/domain/daily-report';
import { DAILY_UUID, dailyBody, dailyError, dailyGate, dailyHeaders, dailyText } from '@/infrastructure/daily-report-support';
import { logRouteError } from '@/infrastructure/log';
import {
  createDailyUploadUrls,
  DailyReportUnavailableError,
  findPhoto,
  loadDailyReportById,
  removeDailyFiles,
} from '@/infrastructure/repositories/supabase/daily-report-repository';

export const runtime = 'nodejs';

type Upload = { workId: string; reportId: string; photoId: string };

/** Perfil que pode gravar e corpo `{ workId, reportId, photoId }` válido, com acesso à obra; o mesmo para
 * liberar e para descartar um envio. Devolve a resposta de erro quando algo falha. */
async function parseUpload(request: Request): Promise<{ profile: { id: string }; upload: Upload } | NextResponse> {
  const gate = await dailyGate('write');
  if (gate instanceof NextResponse) return gate;
  const { profile } = gate;
  const body = await dailyBody(request);
  if (!body) return dailyError('Corpo da requisição inválido.', 400);
  const workId = dailyText(body.workId);
  const reportId = dailyText(body.reportId);
  const photoId = dailyText(body.photoId);
  if (!workId) return dailyError('Obra não informada.', 400);
  // Os ids entram no caminho do arquivo: só UUID, para ninguém montar um caminho fora do diário.
  if (!DAILY_UUID.test(reportId)) return dailyError('Diário não informado.', 400);
  if (!DAILY_UUID.test(photoId)) return dailyError('Identificador da foto inválido.', 400);
  if (!profile.workIds.includes(workId)) return dailyError('Você não tem acesso a esta obra.', 403);
  return { profile, upload: { workId, reportId, photoId } };
}

/** Como na terminalidade, a foto vai do navegador direto ao Storage com as URLs assinadas devolvidas aqui;
 * o caminho é fixo (`dailyPhotoPaths`) e o `add_photo` só registra a foto desse mesmo caminho. O diário
 * precisa existir e ser da obra (salve o rascunho antes da primeira foto); vale também depois do envio. */
export async function POST(request: Request) {
  const parsed = await parseUpload(request);
  if (parsed instanceof NextResponse) return parsed;
  const { profile, upload } = parsed;
  const { workId, reportId, photoId } = upload;
  try {
    const current = await loadDailyReportById(reportId);
    if (!current || current.report.workId !== workId) return dailyError('Diário não encontrado. Salve o diário e tente de novo.', 404);
    // "Já registrada" antes do limite: a nova tentativa de um envio cuja resposta se perdeu usa o mesmo id.
    if (await findPhoto(photoId)) return dailyError('Esta foto já foi registrada.', 400);
    if (current.photos.length >= DAILY_LIMITS.photos)
      return dailyError(`O diário já tem ${DAILY_LIMITS.photos} fotos, o máximo permitido.`, 400);
    const tickets = await createDailyUploadUrls(workId, reportId, photoId);
    if (!tickets) return dailyError('Não foi possível liberar o envio da foto. Tente novamente.', 502);
    return NextResponse.json(tickets, { headers: dailyHeaders });
  } catch (error) {
    if (error instanceof DailyReportUnavailableError) return dailyError(error.message, 503);
    logRouteError('POST /api/diario/upload-url', error, { actorId: profile.id, workId });
    return dailyError('Não foi possível liberar o envio da foto. Tente novamente.', 502);
  }
}

/** Descarta os arquivos de um envio que falhou no meio (imagem subiu, miniatura não) e nunca virou
 * `add_photo`. Só apaga se não há linha para o id: foto registrada sai pelo `delete_photo`. */
export async function DELETE(request: Request) {
  const parsed = await parseUpload(request);
  if (parsed instanceof NextResponse) return parsed;
  const { profile, upload } = parsed;
  const { workId, reportId, photoId } = upload;
  try {
    if (await findPhoto(photoId)) return dailyError('Esta foto já foi registrada; apague-a pelo diário.', 409);
    const paths = dailyPhotoPaths(workId, reportId, photoId);
    await removeDailyFiles([paths.storagePath, paths.thumbPath]);
    return NextResponse.json({ removed: true }, { headers: dailyHeaders });
  } catch (error) {
    if (error instanceof DailyReportUnavailableError) return dailyError(error.message, 503);
    logRouteError('DELETE /api/diario/upload-url', error, { actorId: profile.id, workId });
    return dailyError('Não foi possível descartar o envio da foto.', 502);
  }
}

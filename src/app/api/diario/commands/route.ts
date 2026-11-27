import { NextResponse, type NextRequest } from 'next/server';
import {
  canAdminDailyReport,
  crewsOfDay,
  dailyReportCommandTarget,
  parseDailyReportCommand,
  planDailyReportCommand,
} from '@/application/use-cases/daily-report-commands';
import type { DailyCommandResult, DailyReportCommand, DailyReportMutation } from '@/domain/daily-report';
import { commandContext } from '@/infrastructure/clock';
import { checkSiengeUser, dailyError, dailyGate, dailyHeaders } from '@/infrastructure/daily-report-support';
import { logRouteError } from '@/infrastructure/log';
import {
  applyDailyMutation,
  DailyReportConflictError,
  DailyReportUnavailableError,
  findPhoto,
  findReportWorkId,
  loadCompanyLinks,
  loadDailyLocals,
  loadDailyPlanData,
  signDailyPhotos,
} from '@/infrastructure/repositories/supabase/daily-report-repository';
import { loadHeadcount } from '@/infrastructure/repositories/supabase/headcount-repository';

export const runtime = 'nodejs';

/** Um comando do diário por requisição. `?workId=` é a obra aberta na tela (vale também para os comandos
 * que não são de uma obra: a ligação de empresa e o código de usuário). Aplica as regras
 * (`planDailyReportCommand`) sobre os dados atuais, grava e devolve o estado novo só do que mudou. */
export async function POST(request: NextRequest) {
  const gate = await dailyGate('write');
  if (gate instanceof NextResponse) return gate;
  const { profile } = gate;

  const workId = request.nextUrl.searchParams.get('workId') ?? '';
  let command: DailyReportCommand;
  try {
    command = parseDailyReportCommand(await request.json().catch(() => null));
  } catch (error) {
    return dailyError(error instanceof Error ? error.message : 'Comando inválido.', 400);
  }
  if (!workId) return dailyError('Obra não informada.', 400);
  if (!profile.workIds.includes(workId)) return dailyError('Você não tem acesso a esta obra.', 403);
  const target = dailyReportCommandTarget(command);
  // O comando que traz a obra tem de ser da obra aberta: o acesso conferido é o dela.
  if ('workId' in target && target.workId !== workId) return dailyError('O comando é de outra obra. Recarregue a página.', 400);
  // A ligação de empresa vale para todas as obras: só o administrador mexe.
  if (command.type === 'link_company' && !canAdminDailyReport(profile))
    return dailyError('Só o administrador liga a empresa ao tipo de equipe do Sienge.', 403);

  // O login do Sienge só é gravado se existir e estiver ativo no Sienge (como no formulário de compras). A
  // tela já conferiu e a pessoa confirmou o nome; aqui confere de novo, porque o comando pode ter ficado na
  // fila do aparelho. Vazio é apagar a ligação e não precisa do Sienge.
  if (command.type === 'set_sienge_user' && command.code.trim()) {
    const check = await checkSiengeUser(command.code, { actorId: profile.id, workId });
    if (check instanceof NextResponse) return check;
    if (check.state !== 'found') return dailyError(check.message, 400, { siengeUser: check });
  }

  try {
    // Diário ou foto de outra obra conta como não encontrado: a tela só manda o que está nela.
    if ('reportId' in target && (await findReportWorkId(target.reportId)) !== workId)
      return dailyError('Diário não encontrado. Recarregue a página.', 404);
    if ('photoId' in target && (await findPhoto(target.photoId))?.workId !== workId)
      return dailyError('Foto não encontrada. Recarregue a página.', 404);

    const data = await loadDailyPlanData(workId, {
      date: command.type === 'save_report' ? command.date : undefined,
      reportId: 'reportId' in target ? target.reportId : undefined,
      photoId: 'photoId' in target ? target.photoId : undefined,
    });
    // Versão defasada é conflito (409), não regra (400): a tela trava o formulário e oferece recarregar.
    if (
      command.type === 'save_report' &&
      data.report &&
      data.report.id === command.id &&
      data.report.status === 'draft' &&
      command.baseVersion !== data.report.version
    )
      return dailyError('Outra pessoa gravou este diário antes de você. Recarregue para ver a versão atual.', 409);
    let mutation: DailyReportMutation;
    try {
      mutation = planDailyReportCommand(data, command, commandContext(profile.id), workId);
    } catch (error) {
      // O planejador é puro: tudo o que ele recusa é regra de negócio, com mensagem para o usuário.
      return dailyError(error instanceof Error ? error.message : 'Comando inválido.', 400);
    }
    // Defesa em profundidade: o planejador não troca de obra nem grava o código de outra pessoa.
    if (mutation.workId !== workId) return dailyError('Você não tem acesso a esta obra.', 403);
    if (mutation.siengeUser && mutation.siengeUser.userId !== profile.id) return dailyError('Comando inválido.', 400);

    await applyDailyMutation(mutation, profile.id);

    const result: DailyCommandResult = {};
    if (mutation.saveReport) result.report = mutation.saveReport;
    if (mutation.deleteReportId) {
      result.report = null;
      result.deletedReportId = mutation.deleteReportId;
    }
    const photo = mutation.insertPhoto ?? mutation.updatePhoto;
    if (photo) result.photo = (await signDailyPhotos([photo]))[0] ?? null;
    if (mutation.deletePhotoId) result.deletedPhotoId = mutation.deletePhotoId;
    if (mutation.headcount) {
      // Relê o histograma: é o que ficou no banco, na grafia que o planejador escolheu.
      const day = mutation.saveReport?.date ?? data.report?.date ?? (command.type === 'save_report' ? command.date : null);
      if (day) result.crews = crewsOfDay((await loadHeadcount(workId)).entries, day);
    }
    if (mutation.localLink) result.locals = await loadDailyLocals(workId);
    if (mutation.companyLink) result.companyLinks = await loadCompanyLinks();
    if (mutation.siengeUser) result.siengeUserCode = mutation.siengeUser.code;
    return NextResponse.json(result, { headers: dailyHeaders });
  } catch (error) {
    if (error instanceof DailyReportUnavailableError) return dailyError(error.message, 503);
    if (error instanceof DailyReportConflictError) return dailyError(error.message, 409);
    logRouteError('POST /api/diario/commands', error, { actorId: profile.id, workId, type: command.type });
    return dailyError('Não foi possível gravar a alteração. Tente novamente.', 502);
  }
}

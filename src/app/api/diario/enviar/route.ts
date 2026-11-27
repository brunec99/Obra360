import { NextResponse } from 'next/server';
import { crewsOfDay, markDailyReportError, markDailyReportSent } from '@/application/use-cases/daily-report-commands';
import type { DailyPhoto, DailyReport, DailySendResult } from '@/domain/daily-report';
import { buildSiengeDailyReport, describeSiengeUser } from '@/domain/sienge-daily-report';
import { DAILY_UUID, dailyBody, dailyError, dailyGate, dailyHeaders, dailyText } from '@/infrastructure/daily-report-support';
import { SIENGE_NOT_CONFIGURED, siengeConfigFromEnv, SiengeError } from '@/infrastructure/integrations/sienge/client';
import {
  createDailyReport,
  findDailyReportByDate,
  findSiengeUser,
  listDailyReportTypes,
} from '@/infrastructure/integrations/sienge/daily-report';
import { logRouteError } from '@/infrastructure/log';
import {
  DailyReportConflictError,
  DailyReportUnavailableError,
  forceDailyReportSent,
  loadCompanyLinks,
  loadDailyLocals,
  loadDailyReportById,
  loadSiengeBuildingId,
  loadSiengeUserCode,
  saveDailyReportRow,
} from '@/infrastructure/repositories/supabase/daily-report-repository';
import { HeadcountUnavailableError, loadHeadcountRange } from '@/infrastructure/repositories/supabase/headcount-repository';

export const runtime = 'nodejs';
export const maxDuration = 120;

const ROUTE = 'POST /api/diario/enviar';
const pendingIds = (photos: readonly DailyPhoto[]) => photos.filter(photo => photo.siengeStatus !== 'sent').map(photo => photo.id);
const SENDING = 'Este diário está sendo enviado ou foi alterado por outra pessoa. Recarregue a página e confira antes de enviar de novo.';

/** Envia o diário ao Sienge (`{ workId, reportId }`), só a pedido de quem clicou em "Enviar". As fotos
 * sobem depois, uma a uma, por `/api/diario/enviar/foto`: a resposta diz quais faltam.
 *
 * O cuidado todo é não criar diário em dobro nem deixar diário órfão no Sienge:
 * 1. diário já enviado só devolve as fotos pendentes (clicar de novo não cria outro);
 * 2. o corpo sai de `buildSiengeDailyReport`, o mesmo que a tela mostrou na conferência; bloqueio → 400;
 * 3. pergunta ao Sienge se a obra já tem diário na data → 409;
 * 4. "reserva" o envio subindo a versão do diário: dois cliques ao mesmo tempo, só um passa;
 * 5. cria no Sienge (uma tentativa só) e grava "enviado" IMEDIATAMENTE; se essa gravação falhar, tenta a
 *    marcação sem versão e, no pior caso, registra no log o número do diário criado;
 * 6. recusa do Sienge fica em `lastError` e a resposta de erro leva `report`, já na versão nova. */
export async function POST(request: Request) {
  const gate = await dailyGate('write');
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

  let claimed: DailyReport | null = null;
  try {
    const current = await loadDailyReportById(reportId);
    if (!current || current.report.workId !== workId) return dailyError('Diário não encontrado. Recarregue a página.', 404);
    const { report, photos } = current;
    if (report.status === 'sent')
      return NextResponse.json({ report, pendingPhotoIds: pendingIds(photos) } satisfies DailySendResult, { headers: dailyHeaders });
    if (!siengeConfigFromEnv()) return dailyError(SIENGE_NOT_CONFIGURED, 503);

    const [siengeBuildingId, headcount, locals, companyLinks, siengeUserCode, types] = await Promise.all([
      loadSiengeBuildingId(workId),
      loadHeadcountRange(workId, report.date, report.date),
      loadDailyLocals(workId),
      loadCompanyLinks(),
      loadSiengeUserCode(profile.id),
      // Sem os tipos de equipe a mão de obra iria sem as empresas que casam pelo nome: aqui o Sienge é obrigatório.
      listDailyReportTypes(),
    ]);
    const built = buildSiengeDailyReport({
      report,
      crews: crewsOfDay(headcount.entries, report.date),
      photos,
      support: { siengeBuildingId, locals, companyLinks, crewTypes: types.crewTypes, siengeUserCode },
    });
    if (built.blocking.length || !built.body || siengeBuildingId === null)
      return dailyError(built.blocking[0] ?? 'O diário não está pronto para o envio.', 400, { blocking: built.blocking });

    // O login ligado precisa continuar ativo no Sienge: desativado depois da ligação, o diário sairia assinado
    // por quem não tem mais acesso. Se a lista do Sienge não responder, segue (o login foi conferido ao ligar).
    const responsible = await findSiengeUser(siengeUserCode).catch(() => undefined);
    if (responsible !== undefined) {
      const check = describeSiengeUser(siengeUserCode, responsible);
      if (check.state !== 'found') {
        const message = `Seu usuário do Sienge (${check.code}) não pode assinar o diário. ${check.message} Corrija em "Ligações com o Sienge".`;
        return dailyError(message, 400, { blocking: [message] });
      }
    }

    const existing = await findDailyReportByDate(siengeBuildingId, report.date);
    if (existing !== null)
      return dailyError(
        `O Sienge já tem um diário desta obra nesta data (nº ${existing}). Abra-o no Sienge ou peça a um administrador.`,
        409,
        { siengeId: existing },
      );

    // A reserva: quem perde a corrida (segundo clique, outra aba) para aqui, antes de falar com o Sienge.
    claimed = { ...report, version: report.version + 1 };
    try {
      await saveDailyReportRow(claimed, report.version);
    } catch (error) {
      claimed = null;
      if (error instanceof DailyReportConflictError) return dailyError(SENDING, 409);
      throw error;
    }

    let siengeId: number;
    try {
      siengeId = await createDailyReport(built.body);
    } catch (error) {
      if (!(error instanceof SiengeError)) throw error;
      // Sem resposta ou erro interno do Sienge: não se sabe se ele gravou. A leitura pode repetir; como a
      // conferência de instantes atrás não achou diário na data e o envio está reservado, o que aparecer
      // agora é o que este envio criou.
      const uncertain = error.upstream === 0 || error.upstream >= 500;
      const created = uncertain ? await findDailyReportByDate(siengeBuildingId, report.date).catch(() => null) : null;
      if (created === null) {
        const refused = markDailyReportError(claimed, error.message, new Date().toISOString());
        const saved = await saveDailyReportRow(refused, claimed.version).then(
          () => true,
          cause => {
            logRouteError(ROUTE, cause, { ...context, step: 'gravar a recusa do Sienge' });
            return false;
          },
        );
        return dailyError(error.message, error.status, { report: saved ? refused : claimed });
      }
      siengeId = created;
    }

    // O Sienge criou: registrar aqui é a prioridade, antes de qualquer outra coisa.
    const sent = { siengeBuildingId, siengeId, actorId: profile.id, now: new Date().toISOString() };
    const done = markDailyReportSent(claimed, sent);
    try {
      await saveDailyReportRow(done, claimed.version);
    } catch (cause) {
      // Alguém salvou o rascunho no meio do envio: marca só as colunas do envio, sem conferir a versão.
      const forced = await forceDailyReportSent(report.id, { ...sent, version: done.version + 1 }).catch(() => false);
      if (!forced) {
        // O caso que deixa diário órfão no Sienge: fica no log com o número, para excluir lá à mão.
        logRouteError(ROUTE, cause, { ...context, step: 'DIARIO CRIADO NO SIENGE E NAO REGISTRADO', siengeBuildingId, siengeId });
        return dailyError(
          `O diário foi criado no Sienge (nº ${siengeId}), mas não foi possível registrar o envio aqui. Não envie de novo: avise o administrador.`,
          502,
          { siengeId },
        );
      }
      const reread = await loadDailyReportById(report.id);
      if (reread)
        return NextResponse.json({ report: reread.report, pendingPhotoIds: pendingIds(reread.photos) } satisfies DailySendResult, {
          headers: dailyHeaders,
        });
    }
    return NextResponse.json({ report: done, pendingPhotoIds: pendingIds(photos) } satisfies DailySendResult, { headers: dailyHeaders });
  } catch (error) {
    if (error instanceof DailyReportUnavailableError || error instanceof HeadcountUnavailableError) return dailyError(error.message, 503);
    if (error instanceof DailyReportConflictError) return dailyError(error.message, 409);
    // Falha do Sienge antes de criar (tipos, conferência por data): nada foi gravado lá.
    if (error instanceof SiengeError) return dailyError(error.message, error.status, claimed ? { report: claimed } : {});
    logRouteError(ROUTE, error, context);
    return dailyError('Não foi possível enviar o diário ao Sienge. Tente novamente.', 502, claimed ? { report: claimed } : {});
  }
}

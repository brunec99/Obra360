import {
  FREQUENCY_LABEL,
  formatChecklistDay,
  operatorLabel,
  type ChecklistEquipment,
  type ChecklistRun,
} from '../../domain/equipment-checklist';
import { logRouteError } from '../log';
import { getServiceClient } from '../repositories/supabase/client';
import { listInspectors } from '../repositories/supabase/safety-repository';

/** Aviso ao TST da obra quando uma inspeção do checklist de equipamentos é registrada com item não conforme
 * (17/11/2026, pedido da equipe de SST: "quando algum item não conforme é possível ele comunicar o TST da
 * obra?"). Vai pela fila do Takt Hub (`takt.email_enqueue`, mesmo banco), com o modelo
 * `obra360.checklist_nc`; quem envia é a Edge Function `email-dispatch`, a cada 5 minutos. Enquanto o modelo
 * não estiver publicado lá, a RPC recusa e o aviso se perde sem derrubar a gravação da inspeção. */

export const CHECKLIST_NC_KIND = 'obra360.checklist_nc';
const MAX_SUBJECT = 200;
const MAX_ITEMS = 10;
const MAX_ITEM_TEXT = 140;
const MAX_ITEM_NOTE = 200;
/** O payload da fila tem teto de 4096 bytes: os itens entram enquanto couberem com folga. */
const MAX_PAYLOAD_BYTES = 3400;

/** Contrato do modelo `obra360.checklist_nc` (Takt Hub, `email-templates.ts`). */
export interface ChecklistNcPayload {
  primeiroNome?: string;
  obra: string;
  equipamento: string;
  checklist: string;
  periodicidade: string;
  local?: string;
  operador?: string;
  origem: 'qr' | 'tela';
  data: string;
  total: number;
  itens: { texto: string; descricao: string }[];
  link: string;
}
export interface ChecklistNcEmail {
  subject: string;
  payload: ChecklistNcPayload;
}

export const checklistLink = (origin: string, workId: string) => `${origin}/obras/${encodeURIComponent(workId)}/checklist`;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** Assunto e payload do aviso, sem o nome de quem recebe. `null` quando a inspeção não tem não conformidade.
 * Puro: a obra, o equipamento e a origem do endereço vêm de fora. */
export function checklistNcEmail(
  run: ChecklistRun,
  ctx: { workName: string; equipment: Pick<ChecklistEquipment, 'name'>; origin: string },
): ChecklistNcEmail | null {
  const issues = run.answers.filter(a => a.answer === 'nc');
  if (!issues.length) return null;
  const payload: ChecklistNcPayload = {
    obra: ctx.workName,
    equipamento: ctx.equipment.name,
    checklist: run.modelName,
    periodicidade: FREQUENCY_LABEL[run.frequency],
    ...(run.location ? { local: run.location } : {}),
    // A empresa vai junto do nome ("José da Silva (Construtora X)"): o modelo do Takt Hub não muda.
    ...(operatorLabel(run) ? { operador: operatorLabel(run) } : {}),
    origem: run.source === 'link' ? 'qr' : 'tela',
    data: formatChecklistDay(run.doneOn),
    total: issues.length,
    itens: [],
    link: checklistLink(ctx.origin, run.workId),
  };
  for (const issue of issues.slice(0, MAX_ITEMS)) {
    const item = { texto: clip(issue.text, MAX_ITEM_TEXT), descricao: clip(issue.note, MAX_ITEM_NOTE) };
    if (payload.itens.length && bytes({ ...payload, itens: [...payload.itens, item] }) > MAX_PAYLOAD_BYTES) break;
    payload.itens.push(item);
  }
  const where = run.location ? ` (${run.location})` : '';
  const subject = `Não conformidade no checklist: ${ctx.equipment.name}${where} · ${run.modelName} (${ctx.workName})`;
  return {
    subject: subject
      .replace(/[\r\n]+/g, ' ')
      .trim()
      .slice(0, MAX_SUBJECT),
    payload,
  };
}

/** A chave identifica a inspeção e a pessoa: repetir o envio não duplica o e-mail. */
export const checklistNcKey = (runId: string, userId: string) => `${CHECKLIST_NC_KIND}:${runId}:${userId}`;

async function enqueue(email: ChecklistNcEmail, runId: string, recipient: { id: string; name: string }): Promise<void> {
  const client = getServiceClient();
  const user = await client.auth.admin.getUserById(recipient.id);
  const address = user.data?.user?.email;
  // Só o código: a mensagem do Auth ou do Postgres pode citar o endereço, e ele não vai a log.
  if (user.error || !address) throw new Error(`Destinatário sem e-mail no Supabase Auth (${user.error?.code ?? 'sem endereço'}).`);
  const firstName = recipient.name.trim().split(/\s+/)[0];
  const { error } = await client.schema('takt').rpc('email_enqueue', {
    p_kind: CHECKLIST_NC_KIND,
    p_to_email: address,
    p_subject: email.subject,
    p_idempotency_key: checklistNcKey(runId, recipient.id),
    p_payload: { ...(firstName ? { primeiroNome: firstName } : {}), ...email.payload },
    p_template: CHECKLIST_NC_KIND,
    p_to_user_id: recipient.id,
    p_available_at: null,
  });
  if (error) throw new Error(`Falha ao enfileirar e-mail (${error.code ?? 'sem código'}).`);
}

/** Avisa os TSTs que têm a obra (a mesma marcação e a mesma regra de acesso da aba de segurança), menos quem
 * registrou a inspeção. Nunca lança: cada falha vira uma linha de log, sem endereço nem texto da inspeção.
 * Devolve quantos avisos entraram na fila. */
export async function notifyChecklistNc(input: {
  run: ChecklistRun;
  equipment: Pick<ChecklistEquipment, 'name'>;
  workName: string;
  origin: string;
  route: string;
}): Promise<number> {
  const { run, route } = input;
  try {
    const email = checklistNcEmail(run, input);
    if (!email) return 0;
    const recipients = (await listInspectors(run.workId)).filter(person => person.id !== run.createdBy);
    const results = await Promise.allSettled(recipients.map(person => enqueue(email, run.id, person)));
    results.forEach((result, at) => {
      if (result.status === 'rejected')
        logRouteError(`${route} (e-mail)`, result.reason, { workId: run.workId, runId: run.id, toUserId: recipients[at].id });
    });
    return results.filter(result => result.status === 'fulfilled').length;
  } catch (error) {
    logRouteError(`${route} (e-mail)`, error, { workId: run.workId, runId: run.id });
    return 0;
  }
}

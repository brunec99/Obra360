import {
  DAILY_LIMITS,
  DAILY_SHIFT_KEYS,
  DAILY_SHIFT_LABEL,
  DAILY_WEATHER_LABEL,
  dailyContentOf,
  dailyPhotoPaths,
  emptyDailyContent,
  type DailyCommandResult,
  type DailyContent,
  type DailyCrew,
  type DailyDaySummary,
  type DailyPhotoView,
  type DailyReport,
  type DailyReportCommand,
  type DailyReportResponse,
  type DailySupport,
} from '@/domain/daily-report';
import { addDays, cleanHeadcountName, HEADCOUNT_LIMITS, headcountKey, isOwnCompany, weekdayName } from '@/domain/headcount';
import { buildSiengeDailyReport, isDailyShiftTimeValid, resolveCrewTypeId, type SiengeBuildResult } from '@/domain/sienge-daily-report';

/** Regras puras da tela do Diário de Obra (2.4), sem IndexedDB nem rede, testadas em
 * tests/daily-report-model.test.ts. O desenho é o do modo de campo da terminalidade: o dono do rascunho é
 * o aparelho. A tela mostra o que veio do servidor com a fila local aplicada por cima, e a fila sobe
 * quando há sinal. Diferenças para a terminalidade: o rascunho do dia é UMA operação que se reescreve a
 * cada alteração (`save`), e uma recusa de regra não trava as operações que não dependem dela. */

/* ---------- o dia, como veio do servidor ---------- */

/** A última leitura de um dia, guardada no aparelho para abrir sem sinal. */
export interface DiaryDay {
  workId: string;
  date: string;
  today: string;
  canEdit: boolean;
  canAdmin: boolean;
  report: DailyReport | null;
  photos: DailyPhotoView[];
  crews: DailyCrew[];
  lastCrews: { date: string; crews: DailyCrew[] } | null;
  days: DailyDaySummary[];
  support: DailySupport;
  savedAt: string;
  /** Montado do pacote de apoio, sem leitura do servidor para esta data (aberto sem sinal). */
  fromPackage?: boolean;
}

/** O que a obra precisa para as listas funcionarem sem sinal em qualquer data: guardado a cada leitura. */
export interface DiaryPackage {
  workId: string;
  canEdit: boolean;
  canAdmin: boolean;
  support: DailySupport;
  /** A mão de obra mais recente que o aparelho conhece, para "Repetir o último dia" sem sinal. */
  lastCrews: { date: string; crews: DailyCrew[] } | null;
  days: DailyDaySummary[];
  savedAt: string;
}

type AvailableResponse = Extract<DailyReportResponse, { available: true }>;

export function dayFromResponse(workId: string, response: AvailableResponse, now = new Date()): DiaryDay {
  const { canEdit, canAdmin, today, date, report, photos, crews, lastCrews, days, support } = response;
  return { workId, date, today, canEdit, canAdmin, report, photos, crews, lastCrews, days, support, savedAt: now.toISOString() };
}

/** Junta os resumos de dias: a leitura nova vale para os 60 dias que ela cobre; fora deles fica o que já havia. */
export function mergeDays(existing: readonly DailyDaySummary[], incoming: readonly DailyDaySummary[], date: string): DailyDaySummary[] {
  const from = addDays(date, -59);
  const kept = existing.filter(day => day.date < from || day.date > date);
  return [...kept, ...incoming].sort((a, b) => b.date.localeCompare(a.date));
}

export function packageFromDay(day: DiaryDay, previous: DiaryPackage | null): DiaryPackage {
  const candidates = [day.crews.length ? { date: day.date, crews: day.crews } : null, day.lastCrews, previous?.lastCrews ?? null].filter(
    (item): item is { date: string; crews: DailyCrew[] } => item !== null,
  );
  const lastCrews = candidates.sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
  return {
    workId: day.workId,
    canEdit: day.canEdit,
    canAdmin: day.canAdmin,
    support: day.support,
    lastCrews,
    days: mergeDays(previous?.days ?? [], day.days, day.date),
    savedAt: day.savedAt,
  };
}

/** Um dia que o aparelho nunca leu, aberto sem sinal: formulário vazio com as listas do pacote. As sugestões
 * do curto prazo são da semana da última leitura, então não entram. */
export function dayFromPackage(pkg: DiaryPackage, date: string, today: string): DiaryDay {
  return {
    workId: pkg.workId,
    date,
    today,
    canEdit: pkg.canEdit,
    canAdmin: pkg.canAdmin,
    report: null,
    photos: [],
    crews: [],
    lastCrews: pkg.lastCrews && pkg.lastCrews.date < date ? pkg.lastCrews : null,
    days: pkg.days.filter(day => day.date <= date),
    support: { ...pkg.support, commitments: [] },
    savedAt: pkg.savedAt,
    fromPackage: true,
  };
}

/* ---------- datas ---------- */

/** Data civil de hoje em São Paulo, a mesma que o servidor usa para "não pode estar no futuro". */
export function todayInSaoPaulo(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A data pedida, se for válida e não estiver no futuro; senão, hoje. */
export function clampDate(value: string | null | undefined, today: string): string {
  if (!value || !ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) return today;
  return value > today ? today : value;
}
export const shiftDate = (date: string, days: number, today: string) => clampDate(addDays(date, days), today);

export interface StripDay {
  date: string;
  weekday: string;
  state: 'none' | 'draft' | 'sent';
  photosPending: number;
  selected: boolean;
}
/** A faixa dos últimos dias: termina em hoje quando a data escolhida cabe nela; senão, alguns dias depois dela. */
export function dayStrip(days: readonly DailyDaySummary[], today: string, date: string, size = 14): StripDay[] {
  const byDate = new Map(days.map(day => [day.date, day]));
  const end = date >= addDays(today, -(size - 1)) ? today : clampDate(addDays(date, 3), today);
  return Array.from({ length: size }, (_, index) => {
    const current = addDays(end, index - (size - 1));
    const summary = byDate.get(current);
    return {
      date: current,
      weekday: weekdayName(current).slice(0, 3),
      state: summary ? summary.status : 'none',
      photosPending: summary?.photosPending ?? 0,
      selected: current === date,
    };
  });
}

/* ---------- rascunho → comando ---------- */

const clampText = (text: string, max: number) => text.trim().slice(0, max);
const roundTo = (value: number, decimals: number) => Math.round(value * 10 ** decimals) / 10 ** decimals;

/** O conteúdo como o servidor aceita: turnos na ordem do dia, linhas em branco de fora, textos aparados.
 * A tela guarda as linhas em branco (a pessoa ainda está digitando); o comando não as leva. */
export function cleanContent(content: DailyContent): DailyContent {
  const rainfall =
    content.rainfall === null || !Number.isFinite(content.rainfall)
      ? null
      : Math.min(Math.max(0, roundTo(content.rainfall, 2)), DAILY_LIMITS.rainfallMax - 0.01);
  return {
    shifts: DAILY_SHIFT_KEYS.flatMap(key => content.shifts.filter(shift => shift.key === key).slice(0, 1)),
    rainfall,
    notes: content.notes.trim().slice(0, DAILY_LIMITS.notes),
    tasks: content.tasks
      .filter(task => task.description.trim())
      .slice(0, DAILY_LIMITS.tasks)
      .map(task => ({
        ...task,
        description: clampText(task.description, DAILY_LIMITS.taskDescription),
        notes: clampText(task.notes, DAILY_LIMITS.taskNotes),
        quantity:
          task.quantity !== null && Number.isFinite(task.quantity) && task.quantity > 0
            ? roundTo(task.quantity, DAILY_LIMITS.quantityDecimals)
            : null,
      })),
    events: content.events
      .filter(event => event.description.trim() && event.typeId >= 1)
      .slice(0, DAILY_LIMITS.events)
      .map(event => ({ ...event, description: clampText(event.description, DAILY_LIMITS.eventDescription) })),
    equipments: content.equipments
      .filter(equipment => equipment.typeId >= 1 && Number.isFinite(equipment.quantity) && equipment.quantity >= 1)
      .slice(0, DAILY_LIMITS.equipments)
      .map(equipment => ({ ...equipment, quantity: Math.min(Math.trunc(equipment.quantity), DAILY_LIMITS.equipmentQuantity) })),
  };
}

/** O que o servidor recusaria no rascunho e a limpeza não resolve: turno com horário incompleto ou com o fim
 * antes do início. Enquanto houver, o rascunho espera no aparelho (a pessoa está no meio da digitação). */
export function draftProblems(content: DailyContent): string[] {
  return content.shifts
    .filter(shift => !isDailyShiftTimeValid(shift))
    .map(shift => `Turno ${DAILY_SHIFT_LABEL[shift.key]}: informe início e fim, com o fim depois do início.`);
}

/** A mão de obra como o histograma aceita: só linha completa, e empresa × função repetida vira uma linha. */
export function cleanCrews(crews: readonly DailyCrew[]): DailyCrew[] {
  const merged = new Map<string, DailyCrew>();
  for (const crew of crews) {
    const company = cleanHeadcountName(crew.company);
    const role = cleanHeadcountName(crew.role);
    const quantity = Number.isFinite(crew.quantity) ? Math.min(Math.trunc(crew.quantity), HEADCOUNT_LIMITS.quantity) : 0;
    if (!company || !role || quantity <= 0) continue;
    const key = `${headcountKey(company)}|${headcountKey(role)}`;
    const current = merged.get(key);
    if (current) current.quantity += quantity;
    else merged.set(key, { company, role, quantity });
  }
  return [...merged.values()].slice(0, DAILY_LIMITS.crews);
}

/* ---------- a fila do aparelho ---------- */

/** Comandos que vão como estão. O rascunho e a foto têm operação própria. */
export type DiarySideCommand = Extract<
  DailyReportCommand,
  { type: 'update_photo' | 'delete_photo' | 'link_local' | 'link_company' | 'set_sienge_user' }
>;
export type DiaryOperation =
  /** O rascunho inteiro do dia. Há no máximo uma por diário: cada alteração reescreve a que está na fila. */
  | {
      kind: 'save';
      reportId: string;
      date: string;
      baseVersion: number | null;
      content: DailyContent;
      /** Nulo quando a pessoa não mexeu na mão de obra. */
      crews: DailyCrew[] | null;
    }
  /** Uma foto: os arquivos ficam à parte no aparelho (por `photoId`) e o registro vira `add_photo` ao subir. */
  | { kind: 'photo'; reportId: string; date: string; photoId: string; description: string; localId: string | null; showInReports: boolean }
  | { kind: 'command'; date: string; command: DiarySideCommand };

export interface QueuedOperation {
  id: string;
  workId: string;
  createdAt: string;
  /** Sobe a cada reescrita: se mudou enquanto o envio estava no ar, a operação não sai da fila. */
  rev: number;
  operation: DiaryOperation;
  /** Recusa do servidor na última tentativa. Fica marcada até a pessoa corrigir, tentar de novo ou descartar. */
  error?: string;
  /** A recusa foi um 409: outra pessoa gravou o diário antes. */
  conflict?: boolean;
}

interface NewIds {
  id: string;
  now: string;
}

/** O comando que a operação representa, já limpo como o servidor exige. */
export function operationCommand(workId: string, operation: DiaryOperation): DailyReportCommand {
  if (operation.kind === 'command') return operation.command;
  if (operation.kind === 'photo')
    return {
      type: 'add_photo',
      id: operation.photoId,
      reportId: operation.reportId,
      description: clampText(operation.description, DAILY_LIMITS.photoDescription),
      localId: operation.localId,
      showInReports: operation.showInReports,
    };
  return {
    type: 'save_report',
    workId,
    id: operation.reportId,
    date: operation.date,
    baseVersion: operation.baseVersion,
    content: cleanContent(operation.content),
    crews: operation.crews === null ? null : cleanCrews(operation.crews),
  };
}

const isSaveOf = (queued: QueuedOperation, reportId: string) => queued.operation.kind === 'save' && queued.operation.reportId === reportId;
const isPhotoOf = (queued: QueuedOperation, photoId: string) => queued.operation.kind === 'photo' && queued.operation.photoId === photoId;

/** Grava o rascunho na fila: reescreve a operação do diário se já existe (e limpa a recusa anterior). */
export function putSave(
  queue: readonly QueuedOperation[],
  workId: string,
  operation: Extract<DiaryOperation, { kind: 'save' }>,
  ids: NewIds,
): QueuedOperation[] {
  if (queue.some(queued => isSaveOf(queued, operation.reportId)))
    return queue.map(queued =>
      isSaveOf(queued, operation.reportId)
        ? { id: queued.id, workId: queued.workId, createdAt: queued.createdAt, rev: queued.rev + 1, operation }
        : queued,
    );
  return [...queue, { id: ids.id, workId, createdAt: ids.now, rev: 0, operation }];
}

export function putPhoto(
  queue: readonly QueuedOperation[],
  workId: string,
  operation: Extract<DiaryOperation, { kind: 'photo' }>,
  ids: NewIds,
): QueuedOperation[] {
  return [...queue, { id: ids.id, workId, createdAt: ids.now, rev: 0, operation }];
}

const commandKey = (command: DiarySideCommand): string => {
  switch (command.type) {
    case 'update_photo':
    case 'delete_photo':
      return `${command.type}:${command.id}`;
    case 'link_local':
      return `link_local:${command.workId}:${command.localId}`;
    case 'link_company':
      return `link_company:${headcountKey(command.company)}`;
    case 'set_sienge_user':
      return 'set_sienge_user';
  }
};

/** Põe um comando na fila. Um comando igual ainda não enviado (mesma foto, mesmo local, mesma empresa) é reescrito. */
export function putCommand(
  queue: readonly QueuedOperation[],
  workId: string,
  date: string,
  command: DiarySideCommand,
  ids: NewIds,
): QueuedOperation[] {
  const key = commandKey(command);
  const same = (queued: QueuedOperation) =>
    queued.workId === workId && queued.operation.kind === 'command' && commandKey(queued.operation.command) === key;
  if (queue.some(same))
    return queue.map(queued =>
      same(queued)
        ? { id: queued.id, workId, createdAt: queued.createdAt, rev: queued.rev + 1, operation: { kind: 'command', date, command } }
        : queued,
    );
  return [...queue, { id: ids.id, workId, createdAt: ids.now, rev: 0, operation: { kind: 'command', date, command } }];
}

export interface PhotoFields {
  description: string;
  localId: string | null;
  showInReports: boolean;
}

/** Altera descrição, local ou a marca do relatório de uma foto: na própria operação se a foto ainda está no
 * aparelho; por `update_photo` se já subiu. */
export function editPhoto(
  queue: readonly QueuedOperation[],
  workId: string,
  date: string,
  photoId: string,
  fields: PhotoFields,
  ids: NewIds,
): QueuedOperation[] {
  if (queue.some(queued => isPhotoOf(queued, photoId)))
    return queue.map(queued =>
      isPhotoOf(queued, photoId)
        ? {
            id: queued.id,
            workId: queued.workId,
            createdAt: queued.createdAt,
            rev: queued.rev + 1,
            operation: { ...(queued.operation as Extract<DiaryOperation, { kind: 'photo' }>), ...fields },
          }
        : queued,
    );
  return putCommand(queue, workId, date, { type: 'update_photo', id: photoId, ...fields }, ids);
}

/** Tira uma foto: a que ainda não subiu só sai da fila; a que já subiu ganha um `delete_photo`. */
export function removePhoto(
  queue: readonly QueuedOperation[],
  workId: string,
  date: string,
  photoId: string,
  ids: NewIds,
): QueuedOperation[] {
  if (queue.some(queued => isPhotoOf(queued, photoId))) return queue.filter(queued => !isPhotoOf(queued, photoId));
  const withoutEdits = queue.filter(
    queued =>
      !(queued.operation.kind === 'command' && queued.operation.command.type === 'update_photo' && queued.operation.command.id === photoId),
  );
  return putCommand(withoutEdits, workId, date, { type: 'delete_photo', id: photoId }, ids);
}

/** Foto sem descrição espera no aparelho: o Sienge exige a descrição, e o servidor recusaria. */
export const isHeldPhoto = (operation: DiaryOperation) => operation.kind === 'photo' && !operation.description.trim();
/** Rascunho com turno incompleto também espera (ver `draftProblems`). */
export const isHeldSave = (operation: DiaryOperation) => operation.kind === 'save' && draftProblems(operation.content).length > 0;

/** O que dá para tentar enviar agora, na ordem da fila. Ficam de fora: o que tem recusa marcada, o rascunho com
 * turno incompleto, a foto sem descrição e a foto de um diário cujo rascunho foi recusado (ela depende dele). O resto segue. */
export function sendable(queue: readonly QueuedOperation[]): QueuedOperation[] {
  const blockedReports = new Set<string>();
  const out: QueuedOperation[] = [];
  for (const queued of queue) {
    const { operation } = queued;
    if (operation.kind === 'save') {
      // Diário que ainda não existe no servidor e não pode ir agora: as fotos dele esperam junto.
      if (queued.error || isHeldSave(operation)) {
        if (queued.error || operation.baseVersion === null) blockedReports.add(operation.reportId);
      } else out.push(queued);
    } else if (queued.error) continue;
    else if (operation.kind === 'photo') {
      if (!blockedReports.has(operation.reportId) && !isHeldPhoto(operation)) out.push(queued);
    } else out.push(queued);
  }
  return out;
}

/** Depois de um envio aceito. Se a operação não mudou no meio do caminho, sai da fila. Se mudou: o rascunho
 * fica, com a versão nova como base; a foto vira um `update_photo` com o que a pessoa digitou depois; o
 * comando fica para ir de novo. Foto tirada da fila enquanto subia ganha um `delete_photo`. */
export function settle(
  queue: readonly QueuedOperation[],
  sent: QueuedOperation,
  result: DailyCommandResult,
  ids: NewIds,
): QueuedOperation[] {
  const current = queue.find(queued => queued.id === sent.id);
  if (!current) {
    if (sent.operation.kind !== 'photo') return [...queue];
    return putCommand(queue, sent.workId, sent.operation.date, { type: 'delete_photo', id: sent.operation.photoId }, ids);
  }
  if (current.rev === sent.rev) return queue.filter(queued => queued.id !== sent.id);
  return queue.map(queued => {
    if (queued.id !== sent.id) return queued;
    const { operation } = queued;
    if (operation.kind === 'save')
      return { ...queued, operation: { ...operation, baseVersion: result.report?.version ?? operation.baseVersion } };
    if (operation.kind === 'photo') {
      const { photoId, description, localId, showInReports, date } = operation;
      return {
        ...queued,
        operation: { kind: 'command', date, command: { type: 'update_photo', id: photoId, description, localId, showInReports } },
      };
    }
    return queued;
  });
}

/** Marca a recusa do servidor. Se a pessoa já reescreveu a operação, a recusa era da versão antiga e não fica. */
export function markError(queue: readonly QueuedOperation[], sent: QueuedOperation, error: string, conflict = false): QueuedOperation[] {
  return queue.map(queued =>
    queued.id === sent.id && queued.rev === sent.rev ? { ...queued, error, ...(conflict ? { conflict } : {}) } : queued,
  );
}

/** "Tentar de novo" numa operação recusada. */
export function retryOperation(queue: readonly QueuedOperation[], id: string): QueuedOperation[] {
  return queue.map(queued =>
    queued.id === id
      ? { id: queued.id, workId: queued.workId, createdAt: queued.createdAt, rev: queued.rev + 1, operation: queued.operation }
      : queued,
  );
}

/** Descarta uma operação. Com o rascunho de um diário que ainda não existe no servidor saem as fotos dele. */
export function discardOperation(queue: readonly QueuedOperation[], id: string): QueuedOperation[] {
  const target = queue.find(queued => queued.id === id);
  if (!target) return [...queue];
  const { operation } = target;
  const orphans = operation.kind === 'save' && operation.baseVersion === null ? operation.reportId : null;
  return queue.filter(
    queued => queued.id !== id && !(orphans && queued.operation.kind === 'photo' && queued.operation.reportId === orphans),
  );
}

/** Conflito resolvido com "Recarregar": o rascunho local sai, e as fotos que esperavam por ele passam para o
 * diário que está no servidor (quando outra pessoa criou o do dia com outro id). */
export function resolveConflict(queue: readonly QueuedOperation[], reportId: string, serverReportId: string | null): QueuedOperation[] {
  return queue
    .filter(queued => !isSaveOf(queued, reportId))
    .map(queued =>
      serverReportId && queued.operation.kind === 'photo' && queued.operation.reportId === reportId
        ? { ...queued, rev: queued.rev + 1, operation: { ...queued.operation, reportId: serverReportId } }
        : queued,
    );
}

/** Recusa do rascunho que significa "outra pessoa gravou antes". A gravação responde 409 quando perde a corrida
 * no banco, mas a regra do servidor (`planDailyReportCommand`) recusa antes, com 400, a versão defasada e o dia
 * que já ganhou um diário de outra pessoa. As três pedem o mesmo da tela: travar o formulário e oferecer
 * "Recarregar". Sem isto a recusa ficava na fila para sempre ("Tentar de novo" repetia a mesma versão) e a
 * alteração seguinte gravava por cima do que a outra pessoa fez. */
export const isStaleDraftRefusal = (message: string) => /outra pessoa gravou este diário antes|este dia já tem um diário/i.test(message);

/** Recusa que significa "isso já foi gravado": a tentativa anterior subiu e a resposta se perdeu. */
export const alreadyApplied = (message: string) => /já foi (registrada|anexada)/i.test(message);

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
const crewLines = (crews: readonly DailyCrew[]) =>
  cleanCrews(crews)
    .map(crew => `${headcountKey(crew.company)}|${headcountKey(crew.role)}|${crew.quantity}`)
    .sort();

/** Diante de um 409: o que está no servidor já é o que este rascunho ia gravar? Então a gravação anterior
 * chegou e só a resposta se perdeu (sinal caiu no meio), e não há conflito a mostrar. */
export function sameAsServer(
  operation: Extract<DiaryOperation, { kind: 'save' }>,
  report: DailyReport | null,
  crews: readonly DailyCrew[],
): boolean {
  if (!report || report.id !== operation.reportId) return false;
  if (stable(cleanContent(operation.content)) !== stable(dailyContentOf(report))) return false;
  return operation.crews === null || stable(crewLines(operation.crews)) === stable(crewLines(crews));
}

/* ---------- o servidor com a fila por cima ---------- */

export interface DiaryPhoto extends DailyPhotoView {
  /** Ainda só no aparelho (não subiu). */
  local: boolean;
  /** No aparelho, esperando a descrição. */
  held: boolean;
  /** Recusa do servidor ao subir ou alterar esta foto, e a operação que a carrega. */
  queueError?: string;
  queueId?: string;
}

export interface DiaryView {
  reportId: string;
  /** O diário já existe no servidor. */
  exists: boolean;
  status: 'draft' | 'sent';
  siengeId: number | null;
  lastError: string;
  baseVersion: number | null;
  content: DailyContent;
  crews: DailyCrew[];
  /** A fila leva mão de obra alterada. */
  crewsTouched: boolean;
  photos: DiaryPhoto[];
  support: DailySupport;
  /** Operações deste dia ainda no aparelho. */
  pending: number;
  /** As que o servidor recusou (fora o conflito, que tem tratamento próprio). */
  failed: QueuedOperation[];
  conflict: QueuedOperation | null;
}

const summarize = (day: DiaryDay): DailyDaySummary | null =>
  day.report
    ? {
        date: day.date,
        status: day.report.status,
        siengeId: day.report.siengeId,
        photos: day.photos.length,
        photosPending: day.photos.filter(photo => photo.siengeStatus !== 'sent').length,
      }
    : null;

/** Aplica a resposta de um comando (ou de um envio) sobre o dia guardado, sem reler o servidor. */
export function applyResult(day: DiaryDay, result: DailyCommandResult & { photos?: DailyPhotoView[] }): DiaryDay {
  const next: DiaryDay = { ...day, fromPackage: undefined };
  if (result.report !== undefined) next.report = result.report;
  if (result.deletedReportId && day.report?.id === result.deletedReportId) {
    next.report = null;
    next.photos = [];
  }
  if (result.photos) next.photos = result.photos;
  const { photo } = result;
  if (photo)
    next.photos = next.photos.some(item => item.id === photo.id)
      ? next.photos.map(item => (item.id === photo.id ? photo : item))
      : [...next.photos, photo];
  if (result.deletedPhotoId) next.photos = next.photos.filter(item => item.id !== result.deletedPhotoId);
  if (result.crews) next.crews = result.crews;
  if (result.locals || result.companyLinks || result.siengeUserCode !== undefined)
    next.support = {
      ...day.support,
      locals: result.locals ?? day.support.locals,
      companyLinks: result.companyLinks ?? day.support.companyLinks,
      siengeUserCode: result.siengeUserCode ?? day.support.siengeUserCode,
    };
  const summary = summarize(next);
  next.days = [...day.days.filter(item => item.date !== day.date), ...(summary ? [summary] : [])].sort((a, b) =>
    b.date.localeCompare(a.date),
  );
  return next;
}

/** O dia do servidor com a fila deste aparelho aplicada por cima, na ordem em que foi lançada. `freshId` é o
 * id que o diário terá se ainda não existe nem no servidor nem na fila. */
export function localDay(day: DiaryDay, queue: readonly QueuedOperation[], freshId: string): DiaryView {
  const own = queue.filter(queued => queued.workId === day.workId);
  let content = day.report ? dailyContentOf(day.report) : emptyDailyContent();
  let crews = day.crews;
  let crewsTouched = false;
  let reportId = day.report?.id ?? freshId;
  let baseVersion = day.report?.version ?? null;
  let photos: DiaryPhoto[] = day.photos.map(photo => ({ ...photo, local: false, held: false }));
  let support = day.support;
  let pending = 0;
  const failed: QueuedOperation[] = [];
  let conflict: QueuedOperation | null = null;

  for (const queued of own) {
    const { operation } = queued;
    // As ligações com o Sienge valem para a obra, seja qual for o dia em que foram feitas.
    if (operation.kind === 'command' && operation.command.type !== 'update_photo' && operation.command.type !== 'delete_photo') {
      const { command } = operation;
      if (command.type === 'set_sienge_user') support = { ...support, siengeUserCode: command.code };
      else if (command.type === 'link_local')
        support = {
          ...support,
          locals: support.locals.map(local => (local.id === command.localId ? { ...local, siengeSiteId: command.siengeSiteId } : local)),
        };
      else {
        const companyKey = headcountKey(command.company);
        const others = support.companyLinks.filter(link => link.companyKey !== companyKey);
        support = {
          ...support,
          companyLinks:
            command.crewTypeId === null ? others : [...others, { companyKey, company: command.company, crewTypeId: command.crewTypeId }],
        };
      }
      pending++;
      if (queued.error) failed.push(queued);
      continue;
    }
    if (operation.date !== day.date) continue;
    pending++;
    if (queued.conflict) conflict = queued;
    else if (queued.error && operation.kind === 'save') failed.push(queued);
    if (operation.kind === 'save') {
      // Rascunho de outro diário do mesmo dia (o do servidor foi criado por outra pessoa): só o conflito aparece.
      if (day.report && day.report.id !== operation.reportId) continue;
      reportId = operation.reportId;
      baseVersion = operation.baseVersion;
      content = operation.content;
      if (operation.crews !== null) {
        crews = operation.crews;
        crewsTouched = true;
      }
    } else if (operation.kind === 'photo') {
      if (!day.report) reportId = operation.reportId;
      photos = [
        ...photos.filter(photo => photo.id !== operation.photoId),
        {
          id: operation.photoId,
          reportId: operation.reportId,
          workId: day.workId,
          ...dailyPhotoPaths(day.workId, operation.reportId, operation.photoId),
          description: operation.description,
          localId: operation.localId,
          showInReports: operation.showInReports,
          siengeStatus: 'pending',
          siengeError: '',
          createdBy: '',
          createdAt: queued.createdAt,
          url: null,
          thumbUrl: null,
          local: true,
          held: isHeldPhoto(operation),
          queueError: queued.error,
          queueId: queued.id,
        },
      ];
    } else if (operation.command.type === 'delete_photo') {
      const { id } = operation.command;
      // Exclusão recusada: a foto continua na tela, com a recusa.
      photos = queued.error
        ? photos.map(photo => (photo.id === id ? { ...photo, queueError: queued.error, queueId: queued.id } : photo))
        : photos.filter(photo => photo.id !== id);
    } else if (operation.command.type === 'update_photo') {
      const { id, description, localId, showInReports } = operation.command;
      photos = photos.map(photo =>
        photo.id === id ? { ...photo, description, localId, showInReports, queueError: queued.error, queueId: queued.id } : photo,
      );
    }
  }

  return {
    reportId,
    exists: day.report !== null,
    status: day.report?.status ?? 'draft',
    siengeId: day.report?.siengeId ?? null,
    lastError: day.report?.lastError ?? '',
    baseVersion,
    content,
    crews,
    crewsTouched,
    photos,
    support,
    pending,
    failed: failed.filter(queued => !queued.conflict),
    conflict,
  };
}

/* ---------- situação e conferência ---------- */

export interface DiarySituation {
  key: 'sent' | 'error' | 'device' | 'draft' | 'empty';
  label: string;
}
export function diarySituation(
  view: Pick<DiaryView, 'status' | 'siengeId' | 'lastError' | 'pending' | 'exists' | 'conflict' | 'failed'>,
): DiarySituation {
  if (view.status === 'sent') return { key: 'sent', label: view.siengeId === null ? 'Enviado' : `Enviado · nº ${view.siengeId}` };
  if (view.pending > 0 && !view.conflict && view.failed.length === 0) return { key: 'device', label: 'Guardado no aparelho' };
  if (view.lastError) return { key: 'error', label: 'Erro no envio' };
  if (view.pending > 0) return { key: 'device', label: 'Guardado no aparelho' };
  return view.exists ? { key: 'draft', label: 'Rascunho' } : { key: 'empty', label: 'Sem diário' };
}

export interface CrewTotals {
  people: number;
  own: number;
  contractors: number;
  companies: number;
}
export function crewTotals(crews: readonly DailyCrew[]): CrewTotals {
  const clean = cleanCrews(crews);
  const own = clean.filter(crew => isOwnCompany(crew.company)).reduce((sum, crew) => sum + crew.quantity, 0);
  const people = clean.reduce((sum, crew) => sum + crew.quantity, 0);
  return { people, own, contractors: people - own, companies: new Set(clean.map(crew => headcountKey(crew.company))).size };
}

export interface Conference {
  shifts: { label: string; hours: string; weather: string }[];
  rainfall: number | null;
  hasNotes: boolean;
  tasks: number;
  equipments: number;
  events: number;
  people: number;
  /** Uma linha por empresa, como vai ao Sienge. Sem tipo de equipe, a linha não segue. */
  companies: { company: string; quantity: number; own: boolean; linked: boolean }[];
  photos: { toSend: number; withLocal: number; withoutLocal: number; alreadySent: number };
  /** Bloqueios e avisos do mesmo montador que o servidor usa no envio. */
  build: SiengeBuildResult;
}

/** O resumo do que vai ao Sienge, para a conferência antes do envio. */
export function conference(day: DiaryDay, view: DiaryView): Conference {
  const content = cleanContent(view.content);
  const crews = cleanCrews(view.crews);
  const report: DailyReport = {
    id: view.reportId,
    workId: day.workId,
    date: day.date,
    status: view.status,
    siengeBuildingId: day.report?.siengeBuildingId ?? null,
    siengeId: view.siengeId,
    sentAt: day.report?.sentAt ?? null,
    sentBy: day.report?.sentBy ?? null,
    lastError: view.lastError,
    version: view.baseVersion ?? 0,
    createdBy: day.report?.createdBy ?? '',
    createdAt: day.report?.createdAt ?? '',
    updatedBy: day.report?.updatedBy ?? '',
    updatedAt: day.report?.updatedAt ?? '',
    ...content,
  };
  const build = buildSiengeDailyReport({ report, crews, photos: view.photos, support: view.support });
  const byCompany = new Map<string, { company: string; quantity: number; own: boolean; linked: boolean }>();
  for (const crew of crews) {
    const key = headcountKey(crew.company);
    const current = byCompany.get(key);
    if (current) current.quantity += crew.quantity;
    else
      byCompany.set(key, {
        company: crew.company,
        quantity: crew.quantity,
        own: isOwnCompany(crew.company),
        linked: resolveCrewTypeId(crew.company, view.support.companyLinks, view.support.crewTypes) !== null,
      });
  }
  const siteOf = new Map(view.support.locals.map(local => [local.id, local.siengeSiteId]));
  const toSend = view.photos.filter(photo => photo.siengeStatus !== 'sent');
  const withLocal = toSend.filter(photo => photo.localId !== null && (siteOf.get(photo.localId) ?? null) !== null).length;
  return {
    shifts: content.shifts.map(shift => ({
      label: DAILY_SHIFT_LABEL[shift.key],
      hours: `${shift.startTime} às ${shift.finishTime}`,
      weather: DAILY_WEATHER_LABEL[shift.weather],
    })),
    rainfall: content.rainfall,
    hasNotes: content.notes.length > 0,
    tasks: content.tasks.length,
    equipments: content.equipments.length,
    events: content.events.length,
    people: crews.reduce((sum, crew) => sum + crew.quantity, 0),
    companies: [...byCompany.values()].sort(
      (a, b) => Number(b.own) - Number(a.own) || b.quantity - a.quantity || a.company.localeCompare(b.company, 'pt-BR'),
    ),
    photos: { toSend: toSend.length, withLocal, withoutLocal: toSend.length - withLocal, alreadySent: view.photos.length - toSend.length },
    build,
  };
}

/** Empresas do dia cujo nome não bate com nenhum tipo de equipe do Sienge: são as que precisam de ligação
 * feita à mão (para o painel de ligações, que mostra a ligação atual de cada uma). */
export function companiesToLink(crews: readonly DailyCrew[], crewTypes: DailySupport['crewTypes']): string[] {
  const names = new Map<string, string>();
  for (const crew of cleanCrews(crews))
    if (resolveCrewTypeId(crew.company, [], crewTypes) === null) names.set(headcountKey(crew.company), crew.company);
  return [...names.values()].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

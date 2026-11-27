import {
  DAILY_EQUIPMENT_STATUS,
  DAILY_LIMITS,
  DAILY_SENT_MESSAGE,
  DAILY_SHIFT_KEYS,
  DAILY_SHIFT_LABEL,
  DAILY_UNITS,
  DAILY_WEATHER_KEYS,
  dailyPhotoPaths,
  type DailyContent,
  type DailyCrew,
  type DailyEquipment,
  type DailyEquipmentStatus,
  type DailyEvent,
  type DailyReport,
  type DailyReportCommand,
  type DailyReportMutation,
  type DailyReportPlanData,
  type DailyReportTarget,
  type DailyShift,
  type DailyShiftKey,
  type DailyTask,
  type DailyWeather,
} from '../../domain/daily-report';
import {
  cleanHeadcountName,
  existingSpelling,
  HEADCOUNT_LIMITS,
  headcountKey,
  isIsoDate,
  type HeadcountEntry,
} from '../../domain/headcount';
import { isDailyTime, isSiengeUserCodeFormat } from '../../domain/sienge-daily-report';

/** Regras do Diário de Obra (2.4), 24/11/2026. Mesmo desenho do histograma (`headcount-commands.ts`): o
 * comando chega como JSON, `parseDailyReportCommand` confere a forma, `planDailyReportCommand` aplica as
 * regras sobre o que a rota carregou e devolve só o que gravar. Puro, sem banco e sem Sienge: a rota
 * carrega, planeja e aplica. Toda recusa de regra sai como erro com mensagem pronta para o usuário. */

export interface DailyReportContext {
  actorId: string;
  /** Instante ISO da gravação. */
  now: string;
  /** Data civil de hoje no fuso da obra (a rota passa `todayInSaoPaulo()`). */
  today: string;
  newId: () => string;
}

/** Preenche e envia quem tem o módulo e não é do papel consulta (a rota confere o módulo; aqui, o papel). */
export const canWriteDailyReport = (profile: { role?: string } | null | undefined): boolean => !!profile && profile.role !== 'viewer';
/** Excluir do Sienge e reabrir é só do administrador. */
export const canAdminDailyReport = (profile: { role?: string } | null | undefined): boolean => profile?.role === 'admin';

function fail(message: string): never {
  throw new Error(message);
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, field: string): string => (typeof value === 'string' ? value : fail(`Campo inválido: ${field}.`));
const textOrNull = (value: unknown, field: string): string | null => (value === null ? null : text(value, field));
const number = (value: unknown, field: string): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fail(`Campo inválido: ${field}.`);
const numberOrNull = (value: unknown, field: string): number | null => (value === null ? null : number(value, field));
const boolean = (value: unknown, field: string): boolean => (typeof value === 'boolean' ? value : fail(`Campo inválido: ${field}.`));
const records = (value: unknown, field: string): Record<string, unknown>[] => {
  if (!Array.isArray(value)) fail(`Campo inválido: ${field}.`);
  return (value as unknown[]).map(item => (isRecord(item) ? item : fail(`Campo inválido: ${field}.`)));
};

/** Só a forma: os valores (turno que existe, hora válida, tetos) são conferidos no planejador, que é quem
 * tem as mensagens para o usuário. Por isso as chaves de turno, clima e situação passam aqui como texto. */
function parseContent(value: unknown): DailyContent {
  if (!isRecord(value)) return fail('Campo inválido: content.');
  return {
    shifts: records(value.shifts, 'content.shifts').map((shift): DailyShift => ({
      key: text(shift.key, 'content.shifts.key') as DailyShiftKey,
      startTime: text(shift.startTime, 'content.shifts.startTime'),
      finishTime: text(shift.finishTime, 'content.shifts.finishTime'),
      weather: text(shift.weather, 'content.shifts.weather') as DailyWeather,
    })),
    rainfall: numberOrNull(value.rainfall, 'content.rainfall'),
    notes: text(value.notes, 'content.notes'),
    tasks: records(value.tasks, 'content.tasks').map((task): DailyTask => ({
      id: text(task.id, 'content.tasks.id'),
      description: text(task.description, 'content.tasks.description'),
      quantity: numberOrNull(task.quantity, 'content.tasks.quantity'),
      unit: text(task.unit, 'content.tasks.unit'),
      localId: textOrNull(task.localId, 'content.tasks.localId'),
      notes: text(task.notes, 'content.tasks.notes'),
      commitmentId: textOrNull(task.commitmentId, 'content.tasks.commitmentId'),
    })),
    events: records(value.events, 'content.events').map((event): DailyEvent => ({
      id: text(event.id, 'content.events.id'),
      typeId: number(event.typeId, 'content.events.typeId'),
      typeLabel: text(event.typeLabel, 'content.events.typeLabel'),
      description: text(event.description, 'content.events.description'),
    })),
    equipments: records(value.equipments, 'content.equipments').map((equipment): DailyEquipment => ({
      id: text(equipment.id, 'content.equipments.id'),
      typeId: number(equipment.typeId, 'content.equipments.typeId'),
      typeLabel: text(equipment.typeLabel, 'content.equipments.typeLabel'),
      quantity: number(equipment.quantity, 'content.equipments.quantity'),
      status: text(equipment.status, 'content.equipments.status') as DailyEquipmentStatus,
    })),
  };
}

export function parseDailyReportCommand(body: unknown): DailyReportCommand {
  if (!isRecord(body)) return fail('Comando inválido.');
  switch (body.type) {
    case 'save_report':
      return {
        type: 'save_report',
        workId: text(body.workId, 'workId'),
        id: text(body.id, 'id'),
        date: text(body.date, 'date'),
        baseVersion: numberOrNull(body.baseVersion, 'baseVersion'),
        content: parseContent(body.content),
        crews:
          body.crews === null
            ? null
            : records(body.crews, 'crews').map((crew): DailyCrew => ({
                company: text(crew.company, 'crews.company'),
                role: text(crew.role, 'crews.role'),
                quantity: number(crew.quantity, 'crews.quantity'),
              })),
      };
    case 'delete_report':
      return { type: 'delete_report', id: text(body.id, 'id') };
    case 'add_photo':
      return {
        type: 'add_photo',
        id: text(body.id, 'id'),
        reportId: text(body.reportId, 'reportId'),
        description: text(body.description, 'description'),
        localId: textOrNull(body.localId, 'localId'),
        showInReports: boolean(body.showInReports, 'showInReports'),
      };
    case 'update_photo':
      return {
        type: 'update_photo',
        id: text(body.id, 'id'),
        description: text(body.description, 'description'),
        localId: textOrNull(body.localId, 'localId'),
        showInReports: boolean(body.showInReports, 'showInReports'),
      };
    case 'delete_photo':
      return { type: 'delete_photo', id: text(body.id, 'id') };
    case 'link_local':
      return {
        type: 'link_local',
        workId: text(body.workId, 'workId'),
        localId: text(body.localId, 'localId'),
        siengeSiteId: numberOrNull(body.siengeSiteId, 'siengeSiteId'),
      };
    case 'link_company':
      return { type: 'link_company', company: text(body.company, 'company'), crewTypeId: numberOrNull(body.crewTypeId, 'crewTypeId') };
    case 'set_sienge_user':
      return { type: 'set_sienge_user', code: text(body.code, 'code') };
    default:
      return fail('Comando desconhecido.');
  }
}

/** Onde o comando atua: a rota usa para achar a obra e conferir o acesso. As ligações de empresa e o
 * usuário do Sienge não são de uma obra. */
export function dailyReportCommandTarget(command: DailyReportCommand): DailyReportTarget {
  switch (command.type) {
    case 'save_report':
    case 'link_local':
      return { workId: command.workId };
    case 'delete_report':
      return { reportId: command.id };
    case 'add_photo':
      return { reportId: command.reportId };
    case 'update_photo':
    case 'delete_photo':
      return { photoId: command.id };
    case 'link_company':
    case 'set_sienge_user':
      return { global: true };
  }
}

export const emptyDailyMutation = (workId: string): DailyReportMutation => ({
  workId,
  saveReport: null,
  expectVersion: null,
  deleteReportId: null,
  insertPhoto: null,
  updatePhoto: null,
  deletePhotoId: null,
  removeFiles: [],
  headcount: null,
  localLink: null,
  companyLink: null,
  siengeUser: null,
});

// ----- Conteúdo -----

const isPositiveInteger = (value: number) => Number.isInteger(value) && value > 0;
const roundTo = (value: number, decimals: number) => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

function checkDay(day: string, ctx: DailyReportContext) {
  if (!isIsoDate(day)) fail('Data inválida.');
  if (day < '2020-01-01') fail('Data anterior a 2020: confira o ano.');
  if (day > ctx.today) fail('Data no futuro: o diário é preenchido no dia ou depois dele.');
}

function checkLocal(localId: string | null, data: DailyReportPlanData) {
  if (localId !== null && !data.localIds.includes(localId)) fail('Local não encontrado nesta obra.');
}

/** Ids dos itens vêm da tela (o rascunho sem sinal já os tem); o que não pode é faltar ou repetir. */
function checkItemId(id: string, seen: Set<string>, what: string) {
  if (!id.trim()) fail(`${what} sem identificador. Recarregue a página.`);
  if (seen.has(id)) fail(`${what} repetida no diário. Recarregue a página.`);
  seen.add(id);
}

function normalizeShifts(shifts: readonly DailyShift[]): DailyShift[] {
  const byKey = new Map<DailyShiftKey, DailyShift>();
  for (const shift of shifts) {
    if (!DAILY_SHIFT_KEYS.includes(shift.key)) fail('Turno inválido.');
    const label = DAILY_SHIFT_LABEL[shift.key];
    if (byKey.has(shift.key)) fail(`O turno ${label} aparece mais de uma vez.`);
    if (!isDailyTime(shift.startTime) || !isDailyTime(shift.finishTime)) fail(`Turno ${label}: informe os horários no formato HH:mm.`);
    if (shift.finishTime <= shift.startTime) fail(`Turno ${label}: o fim precisa ser depois do início.`);
    if (!DAILY_WEATHER_KEYS.includes(shift.weather)) fail(`Turno ${label}: clima inválido.`);
    byKey.set(shift.key, { key: shift.key, startTime: shift.startTime, finishTime: shift.finishTime, weather: shift.weather });
  }
  // Sempre manhã, tarde, noite: é a ordem em que o Sienge mostra e em que a tela desenha.
  return DAILY_SHIFT_KEYS.flatMap(key => byKey.get(key) ?? []);
}

function normalizeRainfall(rainfall: number | null): number | null {
  if (rainfall === null) return null;
  if (!Number.isFinite(rainfall) || rainfall < 0) fail('Índice pluviométrico: informe um número a partir de zero.');
  const rounded = roundTo(rainfall, 2);
  if (rounded >= DAILY_LIMITS.rainfallMax) fail('Índice pluviométrico: o Sienge aceita valores abaixo de 9.999,99 mm.');
  return rounded;
}

function normalizeTasks(tasks: readonly DailyTask[], data: DailyReportPlanData): DailyTask[] {
  if (tasks.length > DAILY_LIMITS.tasks) fail(`Atividades: até ${DAILY_LIMITS.tasks} por diário.`);
  const seen = new Set<string>();
  return tasks.map(task => {
    checkItemId(task.id, seen, 'Atividade');
    const description = task.description.trim();
    if (!description) fail('Descreva a atividade.');
    if (description.length > DAILY_LIMITS.taskDescription) fail(`Atividade: até ${DAILY_LIMITS.taskDescription} caracteres na descrição.`);
    if (task.quantity !== null && (!Number.isFinite(task.quantity) || task.quantity < 0))
      fail(`Atividade "${description}": a quantidade deve ser um número a partir de zero.`);
    if (!(DAILY_UNITS as readonly string[]).includes(task.unit)) fail(`Atividade "${description}": unidade inválida.`);
    checkLocal(task.localId, data);
    const notes = task.notes.trim();
    if (notes.length > DAILY_LIMITS.taskNotes) fail(`Atividade "${description}": até ${DAILY_LIMITS.taskNotes} caracteres na observação.`);
    return {
      id: task.id,
      description,
      quantity: task.quantity === null ? null : roundTo(task.quantity, DAILY_LIMITS.quantityDecimals),
      unit: task.unit,
      localId: task.localId,
      notes,
      commitmentId: task.commitmentId?.trim() || null,
    };
  });
}

function normalizeEvents(events: readonly DailyEvent[]): DailyEvent[] {
  if (events.length > DAILY_LIMITS.events) fail(`Ocorrências: até ${DAILY_LIMITS.events} por diário.`);
  const seen = new Set<string>();
  return events.map(event => {
    checkItemId(event.id, seen, 'Ocorrência');
    if (!isPositiveInteger(event.typeId)) fail('Escolha o tipo da ocorrência.');
    const description = event.description.trim();
    if (!description) fail('Descreva a ocorrência.');
    if (description.length > DAILY_LIMITS.eventDescription)
      fail(`Ocorrência: até ${DAILY_LIMITS.eventDescription} caracteres na descrição.`);
    return { id: event.id, typeId: event.typeId, typeLabel: event.typeLabel.trim(), description };
  });
}

function normalizeEquipments(equipments: readonly DailyEquipment[]): DailyEquipment[] {
  if (equipments.length > DAILY_LIMITS.equipments) fail(`Equipamentos: até ${DAILY_LIMITS.equipments} por diário.`);
  const seen = new Set<string>();
  return equipments.map(equipment => {
    checkItemId(equipment.id, seen, 'Linha de equipamento');
    if (!isPositiveInteger(equipment.typeId)) fail('Escolha o tipo do equipamento.');
    if (!Number.isInteger(equipment.quantity) || equipment.quantity < 1)
      fail('A quantidade de equipamentos deve ser um inteiro a partir de 1.');
    if (equipment.quantity > DAILY_LIMITS.equipmentQuantity)
      fail(`Mais de ${DAILY_LIMITS.equipmentQuantity} equipamentos numa linha: confira o número.`);
    if (!DAILY_EQUIPMENT_STATUS.includes(equipment.status)) fail('Situação do equipamento inválida.');
    return {
      id: equipment.id,
      typeId: equipment.typeId,
      typeLabel: equipment.typeLabel.trim(),
      quantity: equipment.quantity,
      status: equipment.status,
    };
  });
}

/** O rascunho pode ficar sem turno nenhum: exigir ao menos um é regra do envio (`buildSiengeDailyReport`),
 * não da gravação — senão a pessoa perderia o que digitou só por ainda não ter marcado o turno. */
function normalizeContent(content: DailyContent, data: DailyReportPlanData): DailyContent {
  const notes = content.notes.trim();
  if (notes.length > DAILY_LIMITS.notes) fail(`Observações: até ${DAILY_LIMITS.notes} caracteres.`);
  return {
    shifts: normalizeShifts(content.shifts),
    rainfall: normalizeRainfall(content.rainfall),
    notes,
    tasks: normalizeTasks(content.tasks, data),
    events: normalizeEvents(content.events),
    equipments: normalizeEquipments(content.equipments),
  };
}

// ----- Mão de obra: o diário grava o histograma do dia -----

const slotKey = (company: string, role: string) => `${headcountKey(company)}\n${headcountKey(role)}`;

/** A diferença entre a lista completa que a tela mandou e as linhas do histograma daquele dia. Mesmas
 * regras da aba 2.2: a grafia que a obra já usa vence, uma linha por empresa × função, inteiro de 1 a 500. */
function planHeadcount(
  crews: readonly DailyCrew[],
  date: string,
  data: DailyReportPlanData,
  ctx: DailyReportContext,
  workId: string,
): NonNullable<DailyReportMutation['headcount']> {
  if (crews.length > DAILY_LIMITS.crews) fail(`Mão de obra: até ${DAILY_LIMITS.crews} linhas por dia.`);
  // As linhas novas da própria lista também contam como grafia existente, para "Nova" e "nova" (em funções
  // diferentes, no mesmo envio) não nascerem como duas empresas.
  const companies = data.headcount.map(e => e.company);
  const roles = data.headcount.map(e => e.role);

  const ofDay = new Map<string, HeadcountEntry>();
  const extras: string[] = [];
  for (const entry of data.headcount) {
    if (entry.workedOn !== date) continue;
    const key = slotKey(entry.company, entry.role);
    // Linha dobrada que já estava no banco: fica a primeira e a outra sai, senão o dia somaria em dobro.
    if (ofDay.has(key)) extras.push(entry.id);
    else ofDay.set(key, entry);
  }

  const result: NonNullable<DailyReportMutation['headcount']> = { insert: [], update: [], delete: extras };
  const received = new Set<string>();
  for (const crew of crews) {
    const companyText = cleanHeadcountName(crew.company);
    const roleText = cleanHeadcountName(crew.role);
    if (!companyText) fail('Mão de obra: informe a empresa.');
    if (!roleText) fail('Mão de obra: informe a função.');
    if (companyText.length > HEADCOUNT_LIMITS.name || roleText.length > HEADCOUNT_LIMITS.name)
      fail(`Empresa e função: até ${HEADCOUNT_LIMITS.name} caracteres.`);
    const company = existingSpelling(companyText, companies);
    const role = existingSpelling(roleText, roles);
    if (!Number.isInteger(crew.quantity) || crew.quantity < 1)
      fail(`${role} da ${company}: o número de funcionários deve ser um inteiro a partir de 1.`);
    if (crew.quantity > HEADCOUNT_LIMITS.quantity)
      fail(`${role} da ${company}: mais de ${HEADCOUNT_LIMITS.quantity} pessoas numa linha. Confira o número.`);
    const key = slotKey(company, role);
    if (received.has(key)) fail(`${role} da ${company} aparece mais de uma vez na mão de obra. Junte as linhas em uma só.`);
    received.add(key);
    companies.push(company);
    roles.push(role);

    const current = ofDay.get(key);
    if (!current) {
      result.insert.push({
        id: ctx.newId(),
        workId,
        workedOn: date,
        company,
        role,
        quantity: crew.quantity,
        note: '',
        origin: 'app',
        createdBy: ctx.actorId,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      });
    } else if (current.quantity !== crew.quantity) {
      // Só a quantidade muda: observação, origem e grafia da linha continuam as do histograma.
      result.update.push({ ...current, quantity: crew.quantity, updatedAt: ctx.now });
    }
  }
  for (const [key, entry] of ofDay) if (!received.has(key)) result.delete.push(entry.id);
  return result;
}

// ----- Fotos -----

function photoFields(command: { description: string; localId: string | null; showInReports: boolean }, data: DailyReportPlanData) {
  const description = command.description.trim();
  if (!description) fail('Descreva a foto: o Sienge exige a descrição.');
  if (description.length > DAILY_LIMITS.photoDescription) fail(`Descrição da foto: até ${DAILY_LIMITS.photoDescription} caracteres.`);
  checkLocal(command.localId, data);
  // Sem local a foto não entra no Relatório Fotográfico do Sienge; guardar "mostrar" seria prometer o que não acontece.
  return { description, localId: command.localId, showInReports: command.localId === null ? false : command.showInReports };
}

/** Aplica as regras de um comando. `data` traz o diário e as fotos do alvo e o histograma inteiro da obra. */
export function planDailyReportCommand(
  data: DailyReportPlanData,
  command: DailyReportCommand,
  ctx: DailyReportContext,
  workId: string,
): DailyReportMutation {
  const mutation = emptyDailyMutation(workId);

  switch (command.type) {
    case 'save_report': {
      checkDay(command.date, ctx);
      if (!command.id.trim()) fail('Diário sem identificador. Recarregue a página.');
      const current = data.report;
      if (current) {
        if (current.id !== command.id) fail('Este dia já tem um diário. Recarregue a página.');
        if (current.date !== command.date) fail('A data de um diário não muda. Abra o diário do outro dia.');
        if (current.status === 'sent') fail(DAILY_SENT_MESSAGE);
        if (command.baseVersion !== current.version)
          fail('Outra pessoa gravou este diário antes de você. Recarregue a página para ver a versão atual e refaça a alteração.');
      }
      const content = normalizeContent(command.content, data);
      mutation.headcount = command.crews === null ? null : planHeadcount(command.crews, command.date, data, ctx, workId);
      if (current) {
        mutation.saveReport = { ...current, ...content, version: current.version + 1, updatedBy: ctx.actorId, updatedAt: ctx.now };
        mutation.expectVersion = command.baseVersion;
      } else {
        mutation.saveReport = {
          ...content,
          id: command.id,
          workId,
          date: command.date,
          status: 'draft',
          siengeBuildingId: null,
          siengeId: null,
          sentAt: null,
          sentBy: null,
          lastError: '',
          version: 1,
          createdBy: ctx.actorId,
          createdAt: ctx.now,
          updatedBy: ctx.actorId,
          updatedAt: ctx.now,
        };
        mutation.expectVersion = null;
      }
      return mutation;
    }

    case 'delete_report': {
      const current = data.report;
      if (!current || current.id !== command.id) return fail('Diário não encontrado. Recarregue a página.');
      if (current.status === 'sent') fail(DAILY_SENT_MESSAGE);
      mutation.deleteReportId = current.id;
      mutation.removeFiles = data.photos.flatMap(photo => [photo.storagePath, photo.thumbPath]);
      return mutation;
    }

    case 'add_photo': {
      const current = data.report;
      // Diário enviado também recebe foto: o Sienge aceita anexo a qualquer momento.
      if (!current || current.id !== command.reportId) return fail('Diário não encontrado. Grave o diário antes de anexar fotos.');
      if (!command.id.trim()) fail('Foto sem identificador. Tente anexar de novo.');
      if (data.photos.some(photo => photo.id === command.id)) fail('Esta foto já foi anexada. Recarregue a página.');
      if (data.photos.length >= DAILY_LIMITS.photos) fail(`O diário já tem ${DAILY_LIMITS.photos} fotos, que é o limite.`);
      mutation.insertPhoto = {
        id: command.id,
        reportId: current.id,
        workId,
        ...dailyPhotoPaths(workId, current.id, command.id),
        ...photoFields(command, data),
        siengeStatus: 'pending',
        siengeError: '',
        createdBy: ctx.actorId,
        createdAt: ctx.now,
      };
      return mutation;
    }

    case 'update_photo': {
      const photo = data.photos.find(item => item.id === command.id);
      if (!photo) return fail('Foto não encontrada. Recarregue a página.');
      if (photo.siengeStatus === 'sent') fail('Esta foto já está no Sienge e não pode ser alterada por aqui.');
      // Volta para a fila: se a tentativa anterior falhou pela descrição ou pelo local, agora pode passar.
      mutation.updatePhoto = { ...photo, ...photoFields(command, data), siengeStatus: 'pending', siengeError: '' };
      return mutation;
    }

    case 'delete_photo': {
      const photo = data.photos.find(item => item.id === command.id);
      if (!photo) return fail('Foto não encontrada. Recarregue a página.');
      if (photo.siengeStatus === 'sent') fail('Esta foto já está no Sienge e não pode ser excluída por aqui.');
      mutation.deletePhotoId = photo.id;
      mutation.removeFiles = [photo.storagePath, photo.thumbPath];
      return mutation;
    }

    case 'link_local': {
      if (!data.localIds.includes(command.localId)) fail('Local não encontrado nesta obra.');
      if (command.siengeSiteId !== null && !isPositiveInteger(command.siengeSiteId)) fail('Código do local no Sienge inválido.');
      mutation.localLink = { localId: command.localId, siengeSiteId: command.siengeSiteId };
      return mutation;
    }

    case 'link_company': {
      const company = cleanHeadcountName(command.company);
      if (!company) fail('Informe a empresa.');
      if (company.length > HEADCOUNT_LIMITS.name) fail(`Empresa: até ${HEADCOUNT_LIMITS.name} caracteres.`);
      if (command.crewTypeId !== null && !isPositiveInteger(command.crewTypeId)) fail('Tipo de equipe do Sienge inválido.');
      mutation.companyLink = { companyKey: headcountKey(company), company, crewTypeId: command.crewTypeId };
      return mutation;
    }

    case 'set_sienge_user': {
      const code = command.code.trim().toUpperCase();
      if (code.length > DAILY_LIMITS.siengeUserCode) fail(`Usuário do Sienge: até ${DAILY_LIMITS.siengeUserCode} caracteres.`);
      if (!/^[A-Z0-9._-]*$/.test(code)) fail('Usuário do Sienge: use só letras, números, ponto, hífen e sublinhado.');
      if (code && !isSiengeUserCodeFormat(code)) fail('Usuário do Sienge: comece por letra ou número e use de 2 a 50 caracteres.');
      mutation.siengeUser = { userId: ctx.actorId, code };
      return mutation;
    }
  }
}

// ----- Leituras do histograma para o diário -----

const compareCrews = (a: DailyCrew, b: DailyCrew) => a.company.localeCompare(b.company, 'pt-BR') || a.role.localeCompare(b.role, 'pt-BR');

/** A mão de obra de um dia, como o diário mostra: uma linha por empresa × função, em ordem alfabética. */
export function crewsOfDay(entries: readonly HeadcountEntry[], date: string): DailyCrew[] {
  return entries
    .filter(entry => entry.workedOn === date)
    .map(entry => ({ company: entry.company, role: entry.role, quantity: entry.quantity }))
    .sort(compareCrews);
}

/** O último dia com mão de obra lançada antes da data: alimenta o "Repetir o último dia". */
export function lastCrewsBefore(entries: readonly HeadcountEntry[], date: string): { date: string; crews: DailyCrew[] } | null {
  let last: string | null = null;
  for (const entry of entries) if (entry.workedOn < date && (last === null || entry.workedOn > last)) last = entry.workedOn;
  return last === null ? null : { date: last, crews: crewsOfDay(entries, last) };
}

// ----- Marcações do envio (a rota de envio grava o resultado destas) -----

export function markDailyReportSent(
  report: DailyReport,
  sent: { siengeBuildingId: number; siengeId: number; actorId: string; now: string },
): DailyReport {
  return {
    ...report,
    status: 'sent',
    siengeBuildingId: sent.siengeBuildingId,
    siengeId: sent.siengeId,
    sentAt: sent.now,
    sentBy: sent.actorId,
    lastError: '',
    version: report.version + 1,
  };
}

/** A recusa do Sienge fica no diário, que segue rascunho: a pessoa corrige e envia de novo. */
export function markDailyReportError(report: DailyReport, message: string, now: string): DailyReport {
  // `updatedBy` fica: quem editou o conteúdo continua sendo a mesma pessoa; só o instante da linha anda.
  return { ...report, status: 'draft', lastError: message, version: report.version + 1, updatedAt: now };
}

/** Depois que o administrador excluiu o diário do Sienge: volta a rascunho, pronto para corrigir e reenviar. */
export function reopenDailyReport(report: DailyReport, ctx: { actorId: string; now: string }): DailyReport {
  return {
    ...report,
    status: 'draft',
    siengeId: null,
    sentAt: null,
    sentBy: null,
    lastError: '',
    version: report.version + 1,
    updatedBy: ctx.actorId,
    updatedAt: ctx.now,
  };
}

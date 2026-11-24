import {
  DAILY_LIMITS,
  DAILY_SHIFT_KEYS,
  DAILY_SHIFT_LABEL,
  type DailyCompanyLink,
  type DailyCrew,
  type DailyEquipmentStatus,
  type DailyLocal,
  type DailyPhoto,
  type DailyReport,
  type DailyShiftKey,
  type DailySupport,
  type DailyWeather,
  type SiengeOption,
} from './daily-report';
import { headcountKey, isOwnCompany } from './headcount';

/** Diário de Obra (2.4), 24/11/2026: montagem pura do que vai ao Sienge. O servidor usa no envio e a tela
 * usa na conferência antes de enviar, para as duas mostrarem exatamente o mesmo corpo, os mesmos bloqueios
 * e os mesmos avisos. Formato da especificação oficial (Swagger `construction-daily-report-v1`):
 *
 *   POST /construction-daily-report
 *   POST /construction-daily-report/{buildingId}/{id}/attachments?description=&locationId=&showInReports=
 *        (multipart, campo `file`; a documentação diz `localId`, que o Sienge ignora — ver
 *        `uploadDailyAttachment`)
 *
 * Turno e clima vão em inglês, como na documentação do POST. Confirmado com gravação real no Atmos em
 * 24/11/2026: o Sienge aceitou "Morning/Afternoon/Night" e "Fine/Light rain/Heavy rain" e gravou
 * "Manhã/Tarde/Noite" e "Aberto/Chuva leve/Chuva Forte", que é o que a leitura devolve. "Unworkable"
 * (Impraticável) não foi testado. Nenhum outro ponto do sistema escreve esses textos. */
export const SIENGE_SHIFT: Record<DailyShiftKey, string> = {
  morning: 'Morning',
  afternoon: 'Afternoon',
  night: 'Night',
};
export const SIENGE_WEATHER: Record<DailyWeather, string> = {
  fine: 'Fine',
  light_rain: 'Light rain',
  heavy_rain: 'Heavy rain',
  unworkable: 'Unworkable',
};

export type SiengeCrewAssignment = 'DIRECT_LABOR' | 'INDIRECT_LABOR' | 'THIRD_PARTY';
export type SiengeEquipmentStatus = 'IN_USE' | 'IDLE' | 'OUT_OF_ORDER';
const SIENGE_EQUIPMENT_STATUS: Record<DailyEquipmentStatus, SiengeEquipmentStatus> = {
  in_use: 'IN_USE',
  idle: 'IDLE',
  out_of_order: 'OUT_OF_ORDER',
};

export interface SiengeDailyReportBody {
  buildingId: number;
  /** `yyyy-MM-dd`. */
  date: string;
  notes?: string;
  /** Código de usuário do Sienge de quem envia. */
  responsibleId?: string;
  rainfallIndex?: number;
  /** Obrigatório, ao menos um. `description` e `weatherCondition` saem de `SIENGE_SHIFT` e `SIENGE_WEATHER`. */
  shifts: { description: string; startTime: string; finishTime: string; weatherCondition: string }[];
  detachedTasks?: { description: string; notes?: string; quantity?: number; unitOfMeasure?: string; siteId?: number }[];
  events?: { description: string; eventTypeId: number }[];
  crews?: { crewTypeId: number; quantity: number; assignment: SiengeCrewAssignment }[];
  equipments?: { equipmentTypeId: number; quantity: number; status: SiengeEquipmentStatus }[];
}

export interface SiengeBuildInput {
  report: DailyReport;
  crews: DailyCrew[];
  photos: DailyPhoto[];
  support: Pick<DailySupport, 'siengeBuildingId' | 'locals' | 'companyLinks' | 'crewTypes' | 'siengeUserCode'>;
}

export interface SiengeBuildResult {
  /** Nulo quando há algum bloqueio. */
  body: SiengeDailyReportBody | null;
  /** Impedem o envio. */
  blocking: string[];
  /** Não impedem: dizem o que vai ficar de fora. */
  warnings: string[];
}

const DAILY_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
/** `HH:mm` de 00:00 a 23:59. */
export const isDailyTime = (value: unknown): value is string => typeof value === 'string' && DAILY_TIME.test(value);
/** Jornada que o Sienge aceita: as duas horas válidas e o fim depois do início. */
export const isDailyShiftTimeValid = (shift: { startTime: string; finishTime: string }) =>
  isDailyTime(shift.startTime) && isDailyTime(shift.finishTime) && shift.finishTime > shift.startTime;

const plural = (count: number, one: string, many: string) => (count === 1 ? `1 ${one}` : `${count} ${many}`);

/** O tipo de equipe do Sienge de uma empresa do histograma: 1º a ligação feita à mão; 2º o tipo de equipe
 * cujo nome no Sienge é o da empresa (sem acento, caixa nem espaço sobrando). Sem nenhum dos dois, nulo. */
export function resolveCrewTypeId(company: string, links: readonly DailyCompanyLink[], crewTypes: readonly SiengeOption[]): number | null {
  const key = headcountKey(company);
  if (!key) return null;
  const link = links.find(item => item.companyKey === key);
  if (link) return link.crewTypeId;
  return crewTypes.find(type => headcountKey(type.label) === key)?.id ?? null;
}

/** Monta o corpo do POST e diz o que impede o envio e o que vai ficar de fora. Campo opcional vazio não
 * entra no corpo: o Sienge trata ausência e vazio de formas diferentes, e ausência é o caminho seguro. */
export function buildSiengeDailyReport(input: SiengeBuildInput): SiengeBuildResult {
  const { report, crews, photos, support } = input;
  const blocking: string[] = [];
  const warnings: string[] = [];
  const localById = new Map(support.locals.map(local => [local.id, local]));

  if (support.siengeBuildingId === null) blocking.push('A obra não está ligada a um empreendimento do Sienge.');

  // Turnos: na ordem do dia, um por chave (o rascunho já garante; aqui é a última conferência).
  const shifts = DAILY_SHIFT_KEYS.flatMap(key => report.shifts.filter(shift => shift.key === key).slice(0, 1));
  if (!shifts.length) blocking.push('Informe ao menos um turno trabalhado.');
  for (const shift of shifts) {
    if (!isDailyShiftTimeValid(shift))
      blocking.push(`Turno ${DAILY_SHIFT_LABEL[shift.key]}: horário inválido. Use HH:mm, com o fim depois do início.`);
  }

  // Fotos: só as que ainda vão subir. As que já estão no Sienge não mudam mais.
  const pendingPhotos = photos.filter(photo => photo.siengeStatus !== 'sent');
  const undescribed = pendingPhotos.filter(photo => !photo.description.trim()).length;
  if (undescribed) blocking.push(`${plural(undescribed, 'foto', 'fotos')} sem descrição. O Sienge exige a descrição.`);
  const outOfPhotoReport = pendingPhotos.filter(photo => siengePhotoQuery(photo, support.locals).localId === undefined).length;
  if (outOfPhotoReport)
    warnings.push(
      `${plural(outOfPhotoReport, 'foto', 'fotos')} sem local ligado ao Sienge: ${outOfPhotoReport === 1 ? 'fica' : 'ficam'} fora do Relatório Fotográfico.`,
    );

  // Mão de obra: uma linha por tipo de equipe, somando as funções da empresa.
  const crewByType = new Map<number, { quantity: number; own: boolean }>();
  const unlinked = new Map<string, string>();
  for (const crew of crews) {
    if (!Number.isInteger(crew.quantity) || crew.quantity <= 0) continue;
    const crewTypeId = resolveCrewTypeId(crew.company, support.companyLinks, support.crewTypes);
    if (crewTypeId === null) {
      const key = headcountKey(crew.company);
      if (!unlinked.has(key)) unlinked.set(key, crew.company);
      continue;
    }
    const own = isOwnCompany(crew.company);
    const current = crewByType.get(crewTypeId);
    // Tipo que junta própria e terceira vai como terceira: é o que não subestima o empreiteiro.
    if (current) crewByType.set(crewTypeId, { quantity: current.quantity + crew.quantity, own: current.own && own });
    else crewByType.set(crewTypeId, { quantity: crew.quantity, own });
  }
  if (unlinked.size) {
    const names = [...unlinked.values()].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    warnings.push(
      `${names.length === 1 ? 'Empresa' : 'Empresas'} sem tipo de equipe no Sienge (a mão de obra ${names.length === 1 ? 'dela' : 'delas'} não segue): ${names.join(', ')}.`,
    );
  }

  // Atividades: o local só vai quando está ligado ao código do Sienge.
  let tasksWithoutSite = 0;
  const detachedTasks = report.tasks.map(task => {
    const item: NonNullable<SiengeDailyReportBody['detachedTasks']>[number] = {
      description: task.description.trim().slice(0, DAILY_LIMITS.taskDescription),
    };
    if (task.notes.trim()) item.notes = task.notes.trim();
    if (task.quantity !== null && task.quantity > 0) item.quantity = task.quantity;
    if (task.unit) item.unitOfMeasure = task.unit;
    if (task.localId !== null) {
      const siteId = localById.get(task.localId)?.siengeSiteId ?? null;
      if (siteId === null) tasksWithoutSite++;
      else item.siteId = siteId;
    }
    return item;
  });
  if (tasksWithoutSite)
    warnings.push(
      `${plural(tasksWithoutSite, 'atividade', 'atividades')} com local sem código do Sienge: ${tasksWithoutSite === 1 ? 'vai' : 'vão'} sem local.`,
    );

  const responsibleId = support.siengeUserCode.trim();
  if (!responsibleId)
    warnings.push('Seu usuário do Sienge não foi informado: o diário vai com o usuário da integração (SIENGEAPI) como responsável.');

  if (blocking.length || support.siengeBuildingId === null) return { body: null, blocking, warnings };

  const body: SiengeDailyReportBody = {
    buildingId: support.siengeBuildingId,
    date: report.date,
    shifts: shifts.map(shift => ({
      description: SIENGE_SHIFT[shift.key],
      startTime: shift.startTime,
      finishTime: shift.finishTime,
      weatherCondition: SIENGE_WEATHER[shift.weather],
    })),
  };
  if (report.notes.trim()) body.notes = report.notes.trim();
  if (responsibleId) body.responsibleId = responsibleId;
  if (report.rainfall !== null) body.rainfallIndex = report.rainfall;
  if (detachedTasks.length) body.detachedTasks = detachedTasks;
  if (report.events.length)
    body.events = report.events.map(event => ({ description: event.description.trim(), eventTypeId: event.typeId }));
  if (crewByType.size)
    body.crews = [...crewByType.entries()].map(([crewTypeId, crew]) => ({
      crewTypeId,
      quantity: crew.quantity,
      assignment: crew.own ? 'DIRECT_LABOR' : 'THIRD_PARTY',
    }));
  if (report.equipments.length)
    body.equipments = report.equipments.map(equipment => ({
      equipmentTypeId: equipment.typeId,
      quantity: equipment.quantity,
      status: SIENGE_EQUIPMENT_STATUS[equipment.status],
    }));
  return { body, blocking, warnings };
}

/** Parâmetros da rota de anexo. `localId` e `showInReports` só vão quando o local da foto está ligado ao
 * Sienge: sem local o Sienge guarda a foto como anexo comum, fora do Relatório Fotográfico. */
export function siengePhotoQuery(
  photo: DailyPhoto,
  locals: readonly DailyLocal[],
): { description: string; localId?: number; showInReports?: boolean } {
  const description = photo.description.trim();
  const siteId = photo.localId === null ? null : (locals.find(local => local.id === photo.localId)?.siengeSiteId ?? null);
  if (siteId === null) return { description };
  return { description, localId: siteId, showInReports: photo.showInReports };
}

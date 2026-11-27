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

  // Sem o usuário do Sienge ligado, o Sienge gravaria o usuário da integração (SIENGEAPI) como responsável
  // e todo diário pareceria feito pela mesma pessoa. Decisão do usuário (24/11/2026): ligar é obrigatório.
  const responsibleId = support.siengeUserCode.trim();
  if (!responsibleId)
    blocking.push('Ligue seu usuário do Sienge antes de enviar (em "Ligações com o Sienge"): ele vai como responsável do diário.');

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

/* ---------- usuário do Sienge de quem preenche ---------- */

/** Partes do e-mail que não são nome (engenharia@, obra@, sst@...). */
const NOT_NAME = new Set(['engenharia', 'obra', 'obras', 'sst', 'almoxarifado', 'contato', 'financeiro', 'adm', 'administrativo']);
const tokens = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3 && !NOT_NAME.has(token));

/** Um usuário do Sienge (`GET /users`). `id` é o login, em maiúsculas ("AMANDA.CAMARGO"). */
export interface SiengeUser {
  id: string;
  name: string;
  email: string;
  active: boolean;
}

/** Ids do Sienge são maiúsculos: o que a pessoa digita vira o id. Puro. */
export const normalizeSiengeUserCode = (text: unknown) =>
  String(text ?? '')
    .trim()
    .toUpperCase();

/** Formato plausível de id (o mesmo do formulário de compras). Não diz que existe: diz que vale procurar, e
 * impede que lixo vire chamada ao Sienge. Puro. */
export const isSiengeUserCodeFormat = (text: unknown) => /^[A-Z0-9][A-Z0-9._-]{1,49}$/.test(normalizeSiengeUserCode(text));

/** A lista de `GET /users` limpa: id em maiúsculas, sem repetidos e sem itens sem id. Puro. */
export function normalizeSiengeUsers(results: readonly unknown[]): SiengeUser[] {
  const byId = new Map<string, SiengeUser>();
  for (const raw of results) {
    if (!raw || typeof raw !== 'object') continue;
    const { id, name, email, active } = raw as { id?: unknown; name?: unknown; email?: unknown; active?: unknown };
    const code = typeof id === 'string' ? normalizeSiengeUserCode(id) : '';
    if (!code || byId.has(code)) continue;
    byId.set(code, {
      id: code,
      name: typeof name === 'string' ? name.trim() : '',
      email: typeof email === 'string' ? email.trim() : '',
      active: active === true,
    });
  }
  return [...byId.values()];
}

export type SiengeUserState = 'invalid' | 'not_found' | 'inactive' | 'found';
export interface SiengeUserCheck {
  code: string;
  state: SiengeUserState;
  message: string;
  /** Nome (ou e-mail) do dono do login, para a pessoa confirmar que é ela. Só quando `found`. */
  name?: string;
}

/** O que a tela diz depois de procurar o login, decidido num só lugar (como no formulário de compras, 05/09):
 * "não existe" e "desativado" nunca viram a mesma frase, porque um se resolve criando o acesso e o outro
 * reativando; e o encontrado mostra o NOME do dono, porque ligar o login de outra pessoa assinaria os diários
 * no nome dela sem erro em lugar nenhum. Sem nome no cadastro, mostra o e-mail. Puro. */
export function describeSiengeUser(typed: unknown, user: SiengeUser | null): SiengeUserCheck {
  const code = normalizeSiengeUserCode(typed);
  if (!isSiengeUserCodeFormat(code))
    return { code, state: 'invalid', message: 'Digite o seu usuário do Sienge, sem espaços. Por exemplo: MARIA.SILVA.' };
  if (!user)
    return {
      code,
      state: 'not_found',
      message:
        'Não encontramos esse usuário no Sienge. Confira se digitou certo. Se o seu acesso acabou de ser criado, use "Verificar de novo".',
    };
  if (!user.active)
    return {
      code,
      state: 'inactive',
      message: `O usuário ${user.id} existe no Sienge, mas está desativado. Fale com quem cuida do seu acesso e depois use "Verificar de novo".`,
    };
  const name = user.name || user.email || user.id;
  return { code, state: 'found', name, message: `Encontramos ${user.id} no Sienge. Confirme que é você: ${name}.` };
}

/** Os usuários ativos do Sienge que parecem ser da pessoa, o mais provável primeiro (no máximo 3), com o
 * nome do dono para o "Sou eu". O mesmo e-mail é certeza e vem antes de tudo. Sem ele, o login do Sienge
 * costuma ser NOME.SOBRENOME ("JENNEFER.SIATKOVSKI"): exige que a primeira parte seja o primeiro nome da
 * pessoa ou a primeira parte do e-mail ("jonatan.engenharia@" acha "JONATAN.SILVA", mesmo com o nome
 * cadastrado como "Jonatam"), e cada outra parte que também bate soma pontos. Puro. */
export function matchSiengeUsers(
  person: { name: string; email?: string | null },
  users: readonly SiengeUser[],
): { code: string; name: string }[] {
  const email = (person.email ?? '').trim().toLowerCase();
  const nameTokens = tokens(person.name);
  const emailTokens = tokens(email.split('@')[0] ?? '');
  const firsts = new Set([nameTokens[0], emailTokens[0]].filter(Boolean));
  const all = new Set([...nameTokens, ...emailTokens]);
  return users
    .filter(user => user.active)
    .map(user => {
      if (email && user.email.toLowerCase() === email) return { user, score: 100 };
      const parts = tokens(user.id);
      if (!parts.length || !firsts.has(parts[0])) return null;
      return { user, score: 2 + parts.slice(1).filter(part => all.has(part)).length };
    })
    .filter((item): item is { user: SiengeUser; score: number } => item !== null)
    .sort((a, b) => b.score - a.score || a.user.id.localeCompare(b.user.id))
    .slice(0, 3)
    .map(({ user }) => ({ code: user.id, name: user.name || user.email || user.id }));
}

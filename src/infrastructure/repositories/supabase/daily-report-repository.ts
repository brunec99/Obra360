import {
  DAILY_BUCKET,
  dailyPhotoPaths,
  type DailyCompanyLink,
  type DailyDaySummary,
  type DailyLocal,
  type DailyPhoto,
  type DailyPhotoSiengeStatus,
  type DailyPhotoView,
  type DailyReport,
  type DailyReportMutation,
  type DailyReportPlanData,
  type DailySupport,
} from '../../../domain/daily-report';
import { logRouteError } from '../../log';
import { getServiceClient } from './client';
import { applyHeadcountMutationToDb, HeadcountConflictError, HeadcountUnavailableError, loadHeadcount } from './headcount-repository';

/** Leitura e gravação do Diário de Obra (migração 0059). Mesmo desenho do histograma
 * (`headcount-repository.ts`): fora do snapshot do planejamento, cada comando grava só o que mudou. O diário
 * é uma linha com versão (`version`): toda atualização leva `where version = <lida>` e, sem linha afetada,
 * vira conflito — nunca upsert, para a gravação de quem leu uma versão antiga não passar por cima.
 * A mão de obra é o histograma (`headcount_entries`), gravado pelo repositório dele. */

const REPORTS = 'daily_reports';
const PHOTOS = 'daily_report_photos';
const LINKS = 'sienge_crew_links';
const SIGNED_URL_SECONDS = 60 * 60;
const SIGN_BATCH = 200;

/** Migração 0059 não aplicada: o módulo responde "indisponível" em vez de erro. */
export class DailyReportUnavailableError extends Error {
  constructor() {
    super('Aplique a migração 0059_daily_report.sql no Supabase para usar o Diário de Obra.');
    this.name = 'DailyReportUnavailableError';
  }
}
/** Outra gravação chegou antes (versão antiga, diário do dia já criado, linha apagada no meio tempo). */
export class DailyReportConflictError extends Error {
  constructor(message = 'O diário mudou enquanto você editava. Recarregue a página e tente de novo.') {
    super(message);
    this.name = 'DailyReportConflictError';
  }
}

const missingTable = (code?: string) => code === '42P01' || code === 'PGRST205';
/** 42703 = coluna inexistente no Postgres; PGRST204 = coluna fora do cache de esquema do PostgREST. */
const missingColumn = (code?: string) => code === '42703' || code === 'PGRST204';
type DbError = { code?: string; message: string } | null;
function check(error: DbError, action: string) {
  if (!error) return;
  if (missingTable(error.code) || missingColumn(error.code)) throw new DailyReportUnavailableError();
  // 23505: já existe diário da obra no dia (ou a foto já foi registrada); 23503: obra, diário ou local excluído.
  if (error.code === '23505' || error.code === '23503') throw new DailyReportConflictError();
  throw new Error(`Falha ao ${action}: ${error.message}`);
}
/** O histograma tem os seus próprios erros; para a tela do diário são os mesmos dois casos. */
async function withHeadcountErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof HeadcountUnavailableError) throw new DailyReportUnavailableError();
    if (error instanceof HeadcountConflictError) throw new DailyReportConflictError(error.message);
    throw error;
  }
}

/* ---------- linhas ---------- */

type ReportRow = {
  id: string;
  work_id: string;
  report_date: string;
  status: DailyReport['status'];
  shifts: DailyReport['shifts'] | null;
  rainfall: number | string | null;
  notes: string;
  tasks: DailyReport['tasks'] | null;
  events: DailyReport['events'] | null;
  equipments: DailyReport['equipments'] | null;
  sienge_building_id: number | null;
  sienge_id: number | null;
  sent_at: string | null;
  sent_by: string | null;
  last_error: string;
  version: number;
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
};
const REPORT_COLUMNS =
  'id,work_id,report_date,status,shifts,rainfall,notes,tasks,events,equipments,sienge_building_id,sienge_id,sent_at,sent_by,last_error,version,created_by,created_at,updated_by,updated_at';

export const dailyReportFromRow = (r: ReportRow): DailyReport => ({
  id: r.id,
  workId: r.work_id,
  date: r.report_date,
  status: r.status,
  shifts: Array.isArray(r.shifts) ? r.shifts : [],
  // `numeric` chega como texto pelo PostgREST em alguns casos.
  rainfall: r.rainfall === null || r.rainfall === '' ? null : Number(r.rainfall),
  notes: r.notes ?? '',
  tasks: Array.isArray(r.tasks) ? r.tasks : [],
  events: Array.isArray(r.events) ? r.events : [],
  equipments: Array.isArray(r.equipments) ? r.equipments : [],
  siengeBuildingId: r.sienge_building_id,
  siengeId: r.sienge_id,
  sentAt: r.sent_at,
  sentBy: r.sent_by,
  lastError: r.last_error ?? '',
  version: r.version,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedBy: r.updated_by,
  updatedAt: r.updated_at,
});
export const dailyReportToRow = (d: DailyReport): ReportRow => ({
  id: d.id,
  work_id: d.workId,
  report_date: d.date,
  status: d.status,
  shifts: d.shifts,
  rainfall: d.rainfall,
  notes: d.notes,
  tasks: d.tasks,
  events: d.events,
  equipments: d.equipments,
  sienge_building_id: d.siengeBuildingId,
  sienge_id: d.siengeId,
  sent_at: d.sentAt,
  sent_by: d.sentBy,
  last_error: d.lastError,
  version: d.version,
  created_by: d.createdBy,
  created_at: d.createdAt,
  updated_by: d.updatedBy,
  updated_at: d.updatedAt,
});

type PhotoRow = {
  id: string;
  report_id: string;
  work_id: string;
  storage_path: string;
  thumb_path: string;
  description: string;
  local_id: string | null;
  show_in_reports: boolean;
  sienge_status: DailyPhotoSiengeStatus;
  sienge_error: string;
  created_by: string;
  created_at: string;
};
const PHOTO_COLUMNS =
  'id,report_id,work_id,storage_path,thumb_path,description,local_id,show_in_reports,sienge_status,sienge_error,created_by,created_at';

export const dailyPhotoFromRow = (r: PhotoRow): DailyPhoto => ({
  id: r.id,
  reportId: r.report_id,
  workId: r.work_id,
  storagePath: r.storage_path,
  thumbPath: r.thumb_path,
  description: r.description ?? '',
  localId: r.local_id,
  showInReports: r.show_in_reports,
  siengeStatus: r.sienge_status,
  siengeError: r.sienge_error ?? '',
  createdBy: r.created_by,
  createdAt: r.created_at,
});
export const dailyPhotoToRow = (p: DailyPhoto): PhotoRow => ({
  id: p.id,
  report_id: p.reportId,
  work_id: p.workId,
  storage_path: p.storagePath,
  thumb_path: p.thumbPath,
  description: p.description,
  local_id: p.localId,
  show_in_reports: p.showInReports,
  sienge_status: p.siengeStatus,
  sienge_error: p.siengeError,
  created_by: p.createdBy,
  created_at: p.createdAt,
});

/* ---------- leituras ---------- */

/** As fotos de um diário, na ordem em que entraram. */
async function loadPhotos(reportId: string): Promise<DailyPhoto[]> {
  const { data, error } = await getServiceClient()
    .from(PHOTOS)
    .select(PHOTO_COLUMNS)
    .eq('report_id', reportId)
    .order('created_at')
    .order('id');
  check(error, 'ler as fotos do diário');
  return ((data ?? []) as PhotoRow[]).map(dailyPhotoFromRow);
}

/** O diário da obra no dia (nulo se ainda não existe) e as fotos dele. */
export async function loadDailyReport(workId: string, date: string): Promise<{ report: DailyReport | null; photos: DailyPhoto[] }> {
  const { data, error } = await getServiceClient()
    .from(REPORTS)
    .select(REPORT_COLUMNS)
    .eq('work_id', workId)
    .eq('report_date', date)
    .maybeSingle();
  check(error, 'ler o diário');
  if (!data) return { report: null, photos: [] };
  const report = dailyReportFromRow(data as ReportRow);
  return { report, photos: await loadPhotos(report.id) };
}

/** O diário pelo id, com as fotos; nulo se não existe. */
export async function loadDailyReportById(id: string): Promise<{ report: DailyReport; photos: DailyPhoto[] } | null> {
  const { data, error } = await getServiceClient().from(REPORTS).select(REPORT_COLUMNS).eq('id', id).maybeSingle();
  check(error, 'ler o diário');
  if (!data) return null;
  return { report: dailyReportFromRow(data as ReportRow), photos: await loadPhotos(id) };
}

/** A obra de um diário, ou null se ele não existe: a rota confere o acesso antes de gravar. */
export async function findReportWorkId(id: string): Promise<string | null> {
  const { data, error } = await getServiceClient().from(REPORTS).select('work_id').eq('id', id).maybeSingle();
  check(error, 'localizar o diário');
  return (data as { work_id: string } | null)?.work_id ?? null;
}

/** Uma foto e a obra dela, ou null se não existe. */
export async function findPhoto(photoId: string): Promise<{ photo: DailyPhoto; workId: string } | null> {
  const { data, error } = await getServiceClient().from(PHOTOS).select(PHOTO_COLUMNS).eq('id', photoId).maybeSingle();
  check(error, 'localizar a foto');
  if (!data) return null;
  const photo = dailyPhotoFromRow(data as PhotoRow);
  return { photo, workId: photo.workId };
}

/** Os locais da obra (cadastro da Linha de Balanço), na ordem do cadastro, com o código do Sienge.
 * Sem a migração 0038 (não há cadastro de locais) a lista vem vazia. */
export async function loadDailyLocals(workId: string): Promise<DailyLocal[]> {
  const { data, error } = await getServiceClient()
    .from('lob_locals')
    .select('id,name,sienge_site_id')
    .eq('work_id', workId)
    .order('order_index')
    .order('name');
  if (error && missingTable(error.code)) return [];
  check(error, 'ler os locais da obra');
  return ((data ?? []) as { id: string; name: string; sienge_site_id: number | null }[]).map(row => ({
    id: row.id,
    name: row.name,
    siengeSiteId: row.sienge_site_id,
  }));
}

/** O que o planejador de comandos precisa. O alvo é o diário do comando (`reportId`), o diário da foto
 * (`photoId`) ou o do dia (`date`); sem nenhum (ligações e código de usuário), só o histograma e os locais. */
export async function loadDailyPlanData(
  workId: string,
  target: { date?: string; reportId?: string; photoId?: string } = {},
): Promise<DailyReportPlanData> {
  const loadTarget = async (): Promise<{ report: DailyReport | null; photos: DailyPhoto[] }> => {
    const none = { report: null, photos: [] };
    if (target.photoId) {
      const found = await findPhoto(target.photoId);
      if (!found || found.workId !== workId) return none;
      return (await loadDailyReportById(found.photo.reportId)) ?? none;
    }
    if (target.reportId) {
      const found = await loadDailyReportById(target.reportId);
      return found && found.report.workId === workId ? found : none;
    }
    if (target.date) return loadDailyReport(workId, target.date);
    return none;
  };
  const [current, headcount, locals] = await Promise.all([
    loadTarget(),
    withHeadcountErrors(() => loadHeadcount(workId)),
    loadDailyLocals(workId),
  ]);
  return { report: current.report, photos: current.photos, headcount: headcount.entries, localIds: locals.map(local => local.id) };
}

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Datas dos diários já enviados ao Sienge, para o histograma (2.2) avisar que mexer no efetivo desses dias
 * não muda o que foi ao Sienge. Sem a migração 0059 devolve vazio: o histograma não depende do diário. */
export async function loadSentDailyDates(workId: string): Promise<string[]> {
  const { data, error } = await getServiceClient().from(REPORTS).select('report_date').eq('work_id', workId).eq('status', 'sent');
  if (error) return [];
  return ((data ?? []) as { report_date: string }[]).map(row => row.report_date);
}

/** Os diários da obra nos `days` dias até `untilDate` (inclusive), do mais novo para o mais antigo, com a
 * contagem de fotos e de fotos que ainda não foram ao Sienge. */
export async function loadDailyDays(workId: string, untilDate: string, days = 60): Promise<DailyDaySummary[]> {
  const db = getServiceClient();
  const { data, error } = await db
    .from(REPORTS)
    .select('id,report_date,status,sienge_id')
    .eq('work_id', workId)
    .lte('report_date', untilDate)
    .gte('report_date', addDays(untilDate, -(days - 1)))
    .order('report_date', { ascending: false });
  check(error, 'ler os diários da obra');
  const rows = (data ?? []) as { id: string; report_date: string; status: DailyReport['status']; sienge_id: number | null }[];
  if (!rows.length) return [];
  const photos = await db
    .from(PHOTOS)
    .select('report_id,sienge_status')
    .in(
      'report_id',
      rows.map(row => row.id),
    );
  check(photos.error, 'ler as fotos dos diários');
  const count = new Map<string, { photos: number; pending: number }>();
  for (const photo of (photos.data ?? []) as { report_id: string; sienge_status: DailyPhotoSiengeStatus }[]) {
    const entry = count.get(photo.report_id) ?? { photos: 0, pending: 0 };
    entry.photos += 1;
    if (photo.sienge_status !== 'sent') entry.pending += 1;
    count.set(photo.report_id, entry);
  }
  return rows.map(row => ({
    date: row.report_date,
    status: row.status,
    siengeId: row.sienge_id,
    photos: count.get(row.id)?.photos ?? 0,
    photosPending: count.get(row.id)?.pending ?? 0,
  }));
}

/** As ligações empresa → tipo de equipe do Sienge (valem para todas as obras). */
export async function loadCompanyLinks(): Promise<DailyCompanyLink[]> {
  const { data, error } = await getServiceClient().from(LINKS).select('company_key,company,crew_type_id').order('company');
  check(error, 'ler as ligações de empresa com o Sienge');
  return ((data ?? []) as { company_key: string; company: string; crew_type_id: number }[]).map(row => ({
    companyKey: row.company_key,
    company: row.company,
    crewTypeId: row.crew_type_id,
  }));
}

/** O código de usuário do Sienge de uma pessoa; vazio se ela ainda não informou. */
export async function loadSiengeUserCode(profileId: string): Promise<string> {
  const { data, error } = await getServiceClient().from('profiles').select('sienge_user_code').eq('id', profileId).maybeSingle();
  check(error, 'ler o código de usuário do Sienge');
  return (data as { sienge_user_code: string | null } | null)?.sienge_user_code ?? '';
}

/** Os compromissos do curto prazo da semana que contém a data, na ordem da planilha. O diário só os
 * sugere como atividade: falha aqui (coluna de uma migração antiga faltando) vira lista vazia. */
export async function loadWeekCommitments(workId: string, date: string): Promise<DailySupport['commitments']> {
  const { data, error } = await getServiceClient()
    .from('weekly_commitments')
    .select('id,name,supplier,local_id')
    .eq('work_id', workId)
    .lte('week_start', date)
    .gte('week_end', date)
    .order('order_index', { nullsFirst: false })
    .order('id');
  if (error) {
    if (!missingTable(error.code) && !missingColumn(error.code)) throw new Error(`Falha ao ler o curto prazo da semana: ${error.message}`);
    return [];
  }
  return ((data ?? []) as { id: string; name: string | null; supplier: string | null; local_id: string | null }[])
    .filter(row => (row.name ?? '').trim())
    .map(row => ({ id: row.id, name: (row.name ?? '').trim(), supplier: row.supplier ?? '', localId: row.local_id }));
}

/** O empreendimento do Sienge ligado à obra (`work_settings.sienge_building_id`, migração 0057), ou nulo.
 * `work-settings/route.ts` lê a mesma coluna dentro da rota, sem função exportada; sem a tabela ou a
 * coluna, a obra conta como não ligada. */
export async function loadSiengeBuildingId(workId: string): Promise<number | null> {
  const { data, error } = await getServiceClient().from('work_settings').select('sienge_building_id').eq('work_id', workId).maybeSingle();
  if (error) {
    if (missingTable(error.code) || missingColumn(error.code)) return null;
    throw new Error(`Falha ao ler a ligação da obra com o Sienge: ${error.message}`);
  }
  const id = (data as { sienge_building_id: number | null } | null)?.sienge_building_id ?? null;
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null;
}

/* ---------- arquivos ---------- */

type PhotoPaths = { storagePath: string; thumbPath: string };
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** A imagem e a miniatura estão entre os nomes listados na pasta do diário. Puro, para teste. */
export const hasDailyPhotoFiles = (names: readonly string[], paths: PhotoPaths) =>
  names.includes(baseName(paths.storagePath)) && names.includes(baseName(paths.thumbPath));

/** Confere no Storage se os dois arquivos já subiram: `add_photo` não registra foto sem arquivo (ela
 * falharia só na hora de ir ao Sienge). Uma listagem só, filtrada pelo id da foto. */
export async function dailyPhotoFilesExist(paths: PhotoPaths): Promise<boolean> {
  const dir = paths.storagePath.slice(0, paths.storagePath.lastIndexOf('/'));
  const search = baseName(paths.storagePath).replace(/\.jpg$/, '');
  const { data, error } = await getServiceClient().storage.from(DAILY_BUCKET).list(dir, { search, limit: 10 });
  if (error) throw new Error(`Falha ao conferir os arquivos da foto: ${error.message}`);
  return hasDailyPhotoFiles(
    (data ?? []).map(entry => entry.name),
    paths,
  );
}

/** URLs de envio direto ao Storage para a imagem e a miniatura de uma foto, no caminho fixo de
 * `dailyPhotoPaths`. Nulo quando o Storage não libera. */
export async function createDailyUploadUrls(workId: string, reportId: string, photoId: string) {
  const paths = dailyPhotoPaths(workId, reportId, photoId);
  const bucket = getServiceClient().storage.from(DAILY_BUCKET);
  const [image, thumb] = await Promise.all([
    bucket.createSignedUploadUrl(paths.storagePath),
    bucket.createSignedUploadUrl(paths.thumbPath),
  ]);
  if (image.error || !image.data || thumb.error || !thumb.data) return null;
  return {
    image: { path: image.data.path, signedUrl: image.data.signedUrl, token: image.data.token },
    thumb: { path: thumb.data.path, signedUrl: thumb.data.signedUrl, token: thumb.data.token },
  };
}

/** Preenche `url` e `thumbUrl` com URLs assinadas por uma hora (o bucket é privado). Foto cujo arquivo
 * falhou ao assinar segue com `null`: a tela mostra o espaço vazio em vez de quebrar a lista. */
export async function signDailyPhotos(photos: readonly DailyPhoto[]): Promise<DailyPhotoView[]> {
  const paths = [...new Set(photos.flatMap(p => [p.storagePath, p.thumbPath]))];
  const signed = new Map<string, string>();
  if (paths.length) {
    const bucket = getServiceClient().storage.from(DAILY_BUCKET);
    const batches: string[][] = [];
    for (let i = 0; i < paths.length; i += SIGN_BATCH) batches.push(paths.slice(i, i + SIGN_BATCH));
    const results = await Promise.all(batches.map(batch => bucket.createSignedUrls(batch, SIGNED_URL_SECONDS)));
    for (const { data: urls, error } of results) {
      if (error) throw new Error(`Falha ao assinar as fotos: ${error.message}`);
      for (const entry of urls ?? []) if (entry.path && entry.signedUrl && !entry.error) signed.set(entry.path, entry.signedUrl);
    }
  }
  return photos.map(p => ({ ...p, url: signed.get(p.storagePath) ?? null, thumbUrl: signed.get(p.thumbPath) ?? null }));
}

/** O arquivo da foto, para mandar ao Sienge. */
export async function downloadDailyPhoto(storagePath: string): Promise<Buffer> {
  const { data, error } = await getServiceClient().storage.from(DAILY_BUCKET).download(storagePath);
  if (error || !data) throw new Error(`Falha ao baixar a foto do diário: ${error?.message ?? 'arquivo vazio'}`);
  return Buffer.from(await data.arrayBuffer());
}

/** Apaga arquivos do bucket. Falha do Storage vira erro: quem chama decide se ela importa. */
export async function removeDailyFiles(paths: readonly string[]): Promise<void> {
  if (!paths.length) return;
  const { error } = await getServiceClient()
    .storage.from(DAILY_BUCKET)
    .remove([...paths]);
  if (error) throw new Error(`Falha ao apagar os arquivos do diário: ${error.message}`);
}

/* ---------- gravação ---------- */

/** Grava a linha do diário. `expectVersion` nulo = inserção (já existe diário no dia → conflito); senão
 * atualiza só se a linha ainda estiver na versão lida. Nunca upsert. */
export async function saveDailyReportRow(report: DailyReport, expectVersion: number | null): Promise<void> {
  const db = getServiceClient();
  const row = dailyReportToRow(report);
  if (expectVersion === null) {
    const { error } = await db.from(REPORTS).insert(row);
    check(error, 'criar o diário');
    return;
  }
  // Obra, data e autoria da criação não mudam numa atualização.
  const { id, work_id, report_date, created_by, created_at, ...changes } = row;
  void report_date;
  void created_by;
  void created_at;
  const { data, error } = await db
    .from(REPORTS)
    .update(changes)
    .eq('id', id)
    .eq('work_id', work_id)
    .eq('version', expectVersion)
    .select('id');
  check(error, 'gravar o diário');
  if (!data?.length) throw new DailyReportConflictError();
}

/** Último recurso do envio: o Sienge JÁ criou o diário e a gravação com versão falhou (alguém salvou o
 * rascunho no meio do envio). Marca só as colunas do envio, sem conferir a versão, para o diário não ficar
 * rascunho aqui e existir lá. Devolve se achou a linha. */
export async function forceDailyReportSent(
  reportId: string,
  sent: { siengeBuildingId: number; siengeId: number; actorId: string; now: string; version: number },
): Promise<boolean> {
  const { data, error } = await getServiceClient()
    .from(REPORTS)
    .update({
      status: 'sent',
      sienge_building_id: sent.siengeBuildingId,
      sienge_id: sent.siengeId,
      sent_at: sent.now,
      sent_by: sent.actorId,
      last_error: '',
      version: sent.version,
    })
    .eq('id', reportId)
    .select('id');
  check(error, 'marcar o diário como enviado');
  return !!data?.length;
}

/** O resultado do envio de uma foto ao Sienge. */
export async function savePhotoSiengeStatus(photoId: string, status: DailyPhotoSiengeStatus, error = ''): Promise<void> {
  const result = await getServiceClient()
    .from(PHOTOS)
    .update({ sienge_status: status, sienge_error: status === 'error' ? error.slice(0, 600) : '' })
    .eq('id', photoId);
  check(result.error, 'gravar o envio da foto');
}

/** Reabertura: o diário saiu do Sienge e os anexos foram com ele, então todas as fotos voltam a "pendente". */
export async function resetPhotosToPending(reportId: string): Promise<void> {
  const { error } = await getServiceClient().from(PHOTOS).update({ sienge_status: 'pending', sienge_error: '' }).eq('report_id', reportId);
  check(error, 'reabrir as fotos do diário');
}

/** Aplica o que o planejador decidiu, na ordem segura:
 * 1. o diário primeiro — a versão é o portão: se outra pessoa gravou antes, nada mais é tocado;
 * 2. o histograma do dia (apaga, insere, atualiza, pelo repositório do histograma);
 * 3. as fotos (a nova só depois de conferir que os dois arquivos estão no bucket);
 * 4. as exclusões, as ligações com o Sienge e o código de usuário;
 * 5. os arquivos por último, depois que nenhuma linha aponta para eles — e sem falhar o comando se o
 *    Storage recusar (sobra um arquivo órfão no bucket privado, sem efeito na tela).
 * `actorId` é quem mandou o comando: fica na ligação da empresa (`sienge_crew_links.updated_by`). */
export async function applyDailyMutation(mutation: DailyReportMutation, actorId: string): Promise<void> {
  const db = getServiceClient();
  const { workId } = mutation;

  if (mutation.saveReport) await saveDailyReportRow(mutation.saveReport, mutation.expectVersion);

  const headcount = mutation.headcount;
  if (headcount && (headcount.insert.length || headcount.update.length || headcount.delete.length))
    await withHeadcountErrors(() => applyHeadcountMutationToDb({ workId, ...headcount }));

  if (mutation.insertPhoto) {
    const photo = mutation.insertPhoto;
    if (!(await dailyPhotoFilesExist(photo)))
      throw new DailyReportConflictError('Os arquivos da foto não chegaram ao servidor. Envie a foto de novo.');
    const { error } = await db.from(PHOTOS).insert(dailyPhotoToRow(photo));
    check(error, 'registrar a foto');
  }
  if (mutation.updatePhoto) {
    const { id, work_id, report_id, storage_path, thumb_path, created_by, created_at, ...changes } = dailyPhotoToRow(mutation.updatePhoto);
    void [report_id, storage_path, thumb_path, created_by, created_at];
    // Nunca upsert: uma foto apagada por outra pessoa não pode renascer pela edição.
    const { data, error } = await db.from(PHOTOS).update(changes).eq('id', id).eq('work_id', work_id).select('id');
    check(error, 'atualizar a foto');
    if (!data?.length) throw new DailyReportConflictError();
  }
  if (mutation.deletePhotoId) {
    const { error } = await db.from(PHOTOS).delete().eq('id', mutation.deletePhotoId).eq('work_id', workId);
    check(error, 'excluir a foto');
  }
  if (mutation.deleteReportId) {
    // Só rascunho sai: se o diário foi enviado no meio tempo, a exclusão não acha a linha e vira conflito.
    const { data, error } = await db
      .from(REPORTS)
      .delete()
      .eq('id', mutation.deleteReportId)
      .eq('work_id', workId)
      .eq('status', 'draft')
      .select('id');
    check(error, 'excluir o diário');
    if (!data?.length) throw new DailyReportConflictError();
  }
  if (mutation.localLink) {
    const { data, error } = await db
      .from('lob_locals')
      .update({ sienge_site_id: mutation.localLink.siengeSiteId })
      .eq('id', mutation.localLink.localId)
      .eq('work_id', workId)
      .select('id');
    check(error, 'ligar o local ao Sienge');
    if (!data?.length) throw new DailyReportConflictError('Local não encontrado. Recarregue a página.');
  }
  if (mutation.companyLink) {
    const link = mutation.companyLink;
    if (link.crewTypeId === null) {
      const { error } = await db.from(LINKS).delete().eq('company_key', link.companyKey);
      check(error, 'desfazer a ligação da empresa com o Sienge');
    } else {
      // A ligação é uma linha por empresa, sem versão: a última escolha do administrador vale.
      const { error } = await db.from(LINKS).upsert({
        company_key: link.companyKey,
        company: link.company,
        crew_type_id: link.crewTypeId,
        updated_by: actorId,
        updated_at: new Date().toISOString(),
      });
      check(error, 'ligar a empresa ao Sienge');
    }
  }
  if (mutation.siengeUser) {
    const { data, error } = await db
      .from('profiles')
      .update({ sienge_user_code: mutation.siengeUser.code })
      .eq('id', mutation.siengeUser.userId)
      .select('id');
    check(error, 'gravar o código de usuário do Sienge');
    if (!data?.length) throw new DailyReportConflictError('Perfil não encontrado. Recarregue a página.');
  }
  if (mutation.removeFiles.length) {
    try {
      await removeDailyFiles(mutation.removeFiles);
    } catch (error) {
      logRouteError('daily-report applyDailyMutation', error, { workId, files: mutation.removeFiles.length });
    }
  }
}

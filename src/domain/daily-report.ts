import type { HeadcountEntry } from './headcount';

/** Diário de Obra (2.4), 24/11/2026. O diário do dia é preenchido no Obra 360 e enviado ao Sienge pela API
 * REST `construction-daily-report`, com o botão "Enviar" (decisão do usuário: nada sai sozinho).
 *
 * Decisões que este arquivo fixa:
 * - Um diário por obra e dia (`unique (work_id, report_date)`).
 * - A mão de obra do diário É o histograma do dia (`headcount_entries`): o diário não guarda equipes, lê e
 *   grava as mesmas linhas da aba 2.2. Ao Sienge ela vai por empresa (tipo de equipe), somando as funções.
 * - Depois de enviado, o diário fica travado. O Sienge não tem rota para corrigir clima, jornada,
 *   pluviométrico e observações; corrigir é excluir do Sienge e reabrir (só admin). Foto nova pode entrar
 *   depois do envio, porque o Sienge aceita anexo a qualquer momento.
 * - Fica fora do snapshot do planejamento, como o histograma e a terminalidade. */

export const DAILY_SHIFT_KEYS = ['morning', 'afternoon', 'night'] as const;
export type DailyShiftKey = (typeof DAILY_SHIFT_KEYS)[number];
export const DAILY_SHIFT_LABEL: Record<DailyShiftKey, string> = { morning: 'Manhã', afternoon: 'Tarde', night: 'Noite' };
/** Jornada sugerida ao ligar um turno (a que o Atmos lançava no Sienge). */
export const DAILY_SHIFT_DEFAULT: Record<DailyShiftKey, { startTime: string; finishTime: string }> = {
  morning: { startTime: '08:00', finishTime: '12:00' },
  afternoon: { startTime: '13:00', finishTime: '17:00' },
  night: { startTime: '18:00', finishTime: '22:00' },
};

export const DAILY_WEATHER_KEYS = ['fine', 'light_rain', 'heavy_rain', 'unworkable'] as const;
export type DailyWeather = (typeof DAILY_WEATHER_KEYS)[number];
export const DAILY_WEATHER_LABEL: Record<DailyWeather, string> = {
  fine: 'Aberto',
  light_rain: 'Chuva leve',
  heavy_rain: 'Chuva forte',
  unworkable: 'Impraticável',
};

export const DAILY_EQUIPMENT_STATUS = ['in_use', 'idle', 'out_of_order'] as const;
export type DailyEquipmentStatus = (typeof DAILY_EQUIPMENT_STATUS)[number];
export const DAILY_EQUIPMENT_STATUS_LABEL: Record<DailyEquipmentStatus, string> = {
  in_use: 'Em uso',
  idle: 'Parado',
  out_of_order: 'Quebrado',
};

export const DAILY_UNITS = ['', 'm2', 'm3', 'm', 'un', 'kg', 't', 'vb'] as const;

/** Limites: os do Sienge onde ele os declara, e tetos de bom senso no resto. */
export const DAILY_LIMITS = {
  notes: 4000,
  taskDescription: 200,
  taskNotes: 4000,
  eventDescription: 4000,
  photoDescription: 500,
  tasks: 60,
  events: 30,
  equipments: 40,
  crews: 80,
  photos: 30,
  /** Exclusivo: o Sienge aceita de 0 até menos que 9999,99. */
  rainfallMax: 9999.99,
  quantityDecimals: 4,
  equipmentQuantity: 999,
  siengeUserCode: 60,
} as const;

export interface DailyShift {
  key: DailyShiftKey;
  /** `HH:mm`. */
  startTime: string;
  finishTime: string;
  weather: DailyWeather;
}

export interface DailyTask {
  id: string;
  description: string;
  quantity: number | null;
  unit: string;
  /** Local da obra (`lob_locals.id`), ou nulo. */
  localId: string | null;
  notes: string;
  /** Compromisso do curto prazo de onde a atividade veio, ou nulo se foi digitada. */
  commitmentId: string | null;
}

export interface DailyEvent {
  id: string;
  /** Código do tipo de ocorrência no Sienge. */
  typeId: number;
  /** Descrição do tipo no momento do lançamento, para mostrar sem depender do Sienge. */
  typeLabel: string;
  description: string;
}

export interface DailyEquipment {
  id: string;
  /** Código do tipo de equipamento no Sienge. */
  typeId: number;
  typeLabel: string;
  quantity: number;
  status: DailyEquipmentStatus;
}

/** Uma linha de mão de obra do dia: é uma linha do histograma (empresa × função). */
export interface DailyCrew {
  company: string;
  role: string;
  quantity: number;
}

/** O que a pessoa edita no diário, fora mão de obra e fotos. */
export interface DailyContent {
  shifts: DailyShift[];
  /** Índice pluviométrico em mm, ou nulo se não informado. */
  rainfall: number | null;
  notes: string;
  tasks: DailyTask[];
  events: DailyEvent[];
  equipments: DailyEquipment[];
}

export type DailyReportStatus = 'draft' | 'sent';

export interface DailyReport extends DailyContent {
  id: string;
  workId: string;
  /** `yyyy-MM-dd`. */
  date: string;
  status: DailyReportStatus;
  /** Empreendimento e número do diário no Sienge, preenchidos no envio. */
  siengeBuildingId: number | null;
  siengeId: number | null;
  sentAt: string | null;
  sentBy: string | null;
  /** Última recusa do Sienge, com a mensagem pronta para a tela; vazio quando não houve. */
  lastError: string;
  /** Sobe a cada gravação: a tela manda a que leu e o servidor recusa se outra pessoa gravou antes. */
  version: number;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export type DailyPhotoSiengeStatus = 'pending' | 'sent' | 'error';

export interface DailyPhoto {
  id: string;
  reportId: string;
  workId: string;
  storagePath: string;
  thumbPath: string;
  description: string;
  /** Local da obra (`lob_locals.id`). Sem local a foto não entra no Relatório Fotográfico do Sienge. */
  localId: string | null;
  showInReports: boolean;
  siengeStatus: DailyPhotoSiengeStatus;
  siengeError: string;
  createdBy: string;
  createdAt: string;
}
/** Foto com os endereços assinados (1 h) para a tela. */
export type DailyPhotoView = DailyPhoto & { url: string | null; thumbUrl: string | null };

/** Caminhos no bucket privado `diario`. */
export const DAILY_BUCKET = 'diario';
export const dailyPhotoPaths = (workId: string, reportId: string, photoId: string) => ({
  storagePath: `${workId}/${reportId}/${photoId}.jpg`,
  thumbPath: `${workId}/${reportId}/${photoId}-thumb.jpg`,
});

/* ---------- comandos (POST /api/diario/commands?workId=) ---------- */

export type DailyReportCommand =
  /** Grava o rascunho inteiro do dia. Cria o diário se o dia ainda não tem (`id` é escolhido pela tela, para
   * o rascunho sem sinal já ter o id das fotos). `baseVersion` é a versão lida, ou nulo ao criar. `crews` é a
   * mão de obra completa do dia (o servidor acerta o histograma com ela); nulo deixa o histograma como está. */
  | {
      type: 'save_report';
      workId: string;
      id: string;
      date: string;
      baseVersion: number | null;
      content: DailyContent;
      crews: DailyCrew[] | null;
    }
  /** Só rascunho. Leva as fotos junto. */
  | { type: 'delete_report'; id: string }
  /** Os dois arquivos já estão no bucket (URL assinada de `/api/diario/upload-url`). Vale também depois do envio. */
  | { type: 'add_photo'; id: string; reportId: string; description: string; localId: string | null; showInReports: boolean }
  /** Só enquanto a foto não foi ao Sienge. */
  | { type: 'update_photo'; id: string; description: string; localId: string | null; showInReports: boolean }
  | { type: 'delete_photo'; id: string }
  /** Liga um local da obra ao código do local no Sienge (nulo desfaz). */
  | { type: 'link_local'; workId: string; localId: string; siengeSiteId: number | null }
  /** Liga uma empresa do histograma ao tipo de equipe do Sienge (nulo desfaz). Vale para todas as obras. */
  | { type: 'link_company'; company: string; crewTypeId: number | null }
  /** O código de usuário do Sienge de quem está logado (vai como responsável do diário). */
  | { type: 'set_sienge_user'; code: string };

export type DailyReportTarget = { workId: string } | { reportId: string } | { photoId: string } | { global: true };

/** O que um comando grava. Só os campos não nulos têm efeito. */
export interface DailyReportMutation {
  workId: string;
  /** Linha completa do diário a inserir (`version` 1) ou atualizar (`version` = lida + 1). */
  saveReport: DailyReport | null;
  /** Versão que a linha precisa ter no banco para `saveReport` valer; nulo = inserção. */
  expectVersion: number | null;
  deleteReportId: string | null;
  insertPhoto: DailyPhoto | null;
  updatePhoto: DailyPhoto | null;
  deletePhotoId: string | null;
  /** Arquivos do bucket a apagar depois da gravação. */
  removeFiles: string[];
  /** Acerto do histograma do dia, no formato dos comandos do histograma. */
  headcount: { insert: HeadcountEntry[]; update: HeadcountEntry[]; delete: string[] } | null;
  localLink: { localId: string; siengeSiteId: number | null } | null;
  companyLink: { companyKey: string; company: string; crewTypeId: number | null } | null;
  siengeUser: { userId: string; code: string } | null;
}

/** O que o planejador de comandos recebe: o diário e as fotos do alvo, e o histograma inteiro da obra
 * (a grafia de empresa e função que a obra já usa vence, como na aba 2.2). */
export interface DailyReportPlanData {
  /** O diário da data (ou o do comando), se existir. */
  report: DailyReport | null;
  photos: DailyPhoto[];
  headcount: HeadcountEntry[];
  /** Ids dos locais da obra, para recusar local de outra obra. */
  localIds: string[];
}

/* ---------- leituras de apoio e ligações com o Sienge ---------- */

export interface SiengeOption {
  id: number;
  label: string;
}
export interface DailyLocal {
  id: string;
  name: string;
  /** Código do local no Sienge, ou nulo se ainda não foi ligado. */
  siengeSiteId: number | null;
}
export interface DailyCompanyLink {
  /** `headcountKey` da empresa. */
  companyKey: string;
  company: string;
  crewTypeId: number;
}

export interface DailySupport {
  /** Empreendimento do Sienge ligado à obra (`work_settings.sienge_building_id`), ou nulo. */
  siengeBuildingId: number | null;
  /** As variáveis do Sienge estão no servidor. */
  siengeConfigured: boolean;
  eventTypes: SiengeOption[];
  crewTypes: SiengeOption[];
  equipmentTypes: SiengeOption[];
  /** Locais cadastrados no Sienge para a obra; nulo quando a consulta não está liberada (403) ou falhou. */
  sites: SiengeOption[] | null;
  /** Por que alguma lista do Sienge veio vazia, em texto para a tela; vazio quando deu tudo certo. */
  supportError: string;
  locals: DailyLocal[];
  companyLinks: DailyCompanyLink[];
  /** Empresas e funções já usadas no histograma da obra, para sugerir. */
  companies: string[];
  roles: string[];
  /** Compromissos do curto prazo da semana da data. */
  commitments: { id: string; name: string; supplier: string; localId: string | null }[];
  /** Código de usuário do Sienge de quem está logado; vazio se ainda não informou. */
  siengeUserCode: string;
}

export interface DailyDaySummary {
  date: string;
  status: DailyReportStatus;
  siengeId: number | null;
  photos: number;
  photosPending: number;
}

/** GET /api/diario?workId=&date= */
export type DailyReportResponse =
  | { available: false }
  | {
      available: true;
      /** Pode preencher e enviar (tem o módulo e não é do papel consulta). */
      canEdit: boolean;
      /** Pode excluir do Sienge e reabrir (admin). */
      canAdmin: boolean;
      today: string;
      date: string;
      report: DailyReport | null;
      photos: DailyPhotoView[];
      /** Mão de obra do dia, lida do histograma. */
      crews: DailyCrew[];
      /** Último dia com mão de obra lançada antes da data, para "Repetir o último dia". */
      lastCrews: { date: string; crews: DailyCrew[] } | null;
      /** Diários dos 60 dias até a data, do mais novo para o mais antigo. */
      days: DailyDaySummary[];
      support: DailySupport;
    };

/** Resposta de POST /api/diario/commands: o estado novo do que o comando tocou. */
export interface DailyCommandResult {
  report?: DailyReport | null;
  photo?: DailyPhotoView | null;
  deletedPhotoId?: string;
  deletedReportId?: string;
  crews?: DailyCrew[];
  locals?: DailyLocal[];
  companyLinks?: DailyCompanyLink[];
  siengeUserCode?: string;
}

/** POST /api/diario/enviar { workId, reportId }: cria o diário no Sienge (se ainda não criou) e devolve as
 * fotos que faltam. POST /api/diario/enviar/foto { workId, photoId }: manda uma foto. */
export interface DailySendResult {
  report: DailyReport;
  pendingPhotoIds: string[];
}
export interface DailySendPhotoResult {
  photo: DailyPhotoView;
}

export const DAILY_READ_ONLY_MESSAGE = 'Seu perfil é de consulta: você vê o diário, mas não preenche nem envia.';
export const DAILY_SENT_MESSAGE =
  'Este diário já foi enviado ao Sienge e está travado. Para corrigir, um administrador precisa excluí-lo do Sienge e reabrir.';

export const emptyDailyContent = (): DailyContent => ({
  shifts: [
    { key: 'morning', ...DAILY_SHIFT_DEFAULT.morning, weather: 'fine' },
    { key: 'afternoon', ...DAILY_SHIFT_DEFAULT.afternoon, weather: 'fine' },
  ],
  rainfall: null,
  notes: '',
  tasks: [],
  events: [],
  equipments: [],
});

export const dailyContentOf = (report: DailyContent): DailyContent => ({
  shifts: report.shifts,
  rainfall: report.rainfall,
  notes: report.notes,
  tasks: report.tasks,
  events: report.events,
  equipments: report.equipments,
});

import { getServiceClient } from '../repositories/supabase/client';
import type {
  AccessDevice,
  AccessLastSeen,
  AccessPayload,
  AccessPerson,
  AccessRole,
  AccessSessionRow,
  AccessTarget,
  AccessUsageRow,
  AccessWork,
} from '../../domain/access-usage';
import type { LocalDate } from '../../domain/entities';

/** Acessos ao Obra 360 (15/11/2026, migração 0051): a gravação do tempo ativo (`record_access`) e a leitura da aba
 * "Acessos" (`access_report` + perfis, obras e o último login do Supabase Auth). Só no servidor, com a chave de
 * serviço. Sem a 0051 a gravação vira nada e a leitura devolve `migrated: false`, sem derrubar ninguém. */

const missingFunction = (code?: string) => code === '42883' || code === 'PGRST202';

/** Grava segundos ativos de uma pessoa numa tela. `false` = a migração 0051 ainda não foi aplicada. */
export async function recordAccess(input: AccessTarget & { profileId: string; device: AccessDevice; seconds: number }): Promise<boolean> {
  const { error } = await getServiceClient().rpc('record_access', {
    p_profile: input.profileId,
    p_work: input.workId,
    p_screen: input.screen,
    p_field: input.field,
    p_device: input.device,
    p_seconds: input.seconds,
  });
  if (!error) return true;
  if (missingFunction(error.code)) return false;
  throw new Error(`record_access: ${error.message}`);
}

type Row = unknown[];
const text = (value: unknown) => (typeof value === 'string' ? value : value == null ? '' : String(value));
const nullable = (value: unknown) => (typeof value === 'string' && value ? value : null);
const device = (value: unknown): AccessDevice => (value === 'mobile' ? 'mobile' : 'desktop');
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.filter(Array.isArray) : []);

/** Converte a resposta compacta de `access_report` (listas, ver a 0051) nas linhas que a tela usa. */
export function parseAccessReport(raw: unknown): Pick<AccessPayload, 'usage' | 'sessions' | 'last' | 'since'> {
  const data = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const usage: AccessUsageRow[] = rows(data.usage).map(r => ({
    sessionId: text(r[0]),
    profileId: text(r[1]),
    day: text(r[2]).slice(0, 10),
    workId: nullable(r[3]),
    screen: text(r[4]),
    field: r[5] === true,
    device: device(r[6]),
    seconds: Number(r[7]) || 0,
    lastAt: text(r[8]),
  }));
  const sessions: AccessSessionRow[] = rows(data.sessions).map(r => ({
    id: text(r[0]),
    profileId: text(r[1]),
    startedAt: text(r[2]),
    lastAt: text(r[3]),
    seconds: Number(r[4]) || 0,
  }));
  const last: AccessLastSeen[] = rows(data.last).map(r => ({
    profileId: text(r[0]),
    at: text(r[1]),
    workId: nullable(r[2]),
    screen: text(r[3]),
    field: r[4] === true,
    device: device(r[5]),
  }));
  const since = typeof data.since === 'string' ? data.since.slice(0, 10) : undefined;
  return { usage, sessions, last, ...(since ? { since } : {}) };
}

const ROLES: readonly AccessRole[] = ['viewer', 'planner', 'manager', 'admin'];

/** Tudo o que a aba precisa para `from..to` e o período anterior (`previousFrom..previousTo`). */
export async function loadAccessPayload(range: {
  from: LocalDate;
  to: LocalDate;
  previousFrom: LocalDate;
  previousTo: LocalDate;
  now: string;
}): Promise<AccessPayload> {
  const service = getServiceClient();
  const [report, profiles, works] = await Promise.all([
    service.rpc('access_report', { p_from: range.previousFrom, p_to: range.to }),
    // `*` como no proxy: colunas de migrações posteriores (tst) podem faltar num banco atrasado.
    service.from('profiles').select('*'),
    service.from('works').select('id, name, code'),
  ]);
  if (profiles.error) throw new Error(`profiles: ${profiles.error.message}`);
  if (works.error) throw new Error(`works: ${works.error.message}`);
  const migrated = !report.error;
  if (report.error && !missingFunction(report.error.code)) throw new Error(`access_report: ${report.error.message}`);

  // E-mail e último login vivem só no Supabase Auth, que é dividido com o Takt Hub: só os de quem tem perfil aqui.
  const ours = new Set((profiles.data ?? []).map(p => p.id as string));
  const auth = new Map<string, { email?: string; lastSignInAt?: string }>();
  for (let page = 1; page < 50; page++) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`auth: ${error.message}`);
    for (const user of data.users)
      if (ours.has(user.id))
        auth.set(user.id, {
          ...(user.email ? { email: user.email } : {}),
          ...(user.last_sign_in_at ? { lastSignInAt: user.last_sign_in_at } : {}),
        });
    if (data.users.length < 200) break;
  }

  const people: AccessPerson[] = (profiles.data ?? []).map(p => ({
    id: p.id as string,
    name: (p.name as string) || 'Sem nome',
    role: ROLES.includes(p.role) ? (p.role as AccessRole) : 'viewer',
    tst: p.tst === true,
    workIds: Array.isArray(p.work_ids) ? (p.work_ids as string[]) : [],
    createdAt: text(p.created_at),
    ...auth.get(p.id as string),
  }));
  const workList: AccessWork[] = (works.data ?? []).map(w => ({ id: text(w.id), name: text(w.name), code: text(w.code) }));
  const parsed = migrated ? parseAccessReport(report.data) : { usage: [], sessions: [], last: [] };
  return { ...range, migrated, people, works: workList, ...parsed };
}

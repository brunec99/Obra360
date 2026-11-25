import {
  describeLobHistory,
  lobHistoryAuthor,
  type LobHistoryChanges,
  type LobHistoryItem,
  type LobHistoryNames,
  type LobHistoryRecord,
} from '../../../application/use-cases/lob-history';
import { getServiceClient } from './client';

export type { LobHistoryItem };

/** Histórico de alterações da Linha de Balanço (25/11/2026) na tabela `history_events`, a mesma do curto
 * prazo e do vagão: só de inclusão (um gatilho impede update e delete), `entity_type = 'lob'` e
 * `entity_id` = a obra. Sem migração: a tabela e as permissões do `service_role` (INSERT e SELECT) já
 * existem. A tabela não tem índice em `entity_id`; com ≈60 mil linhas a leitura da obra é aceitável. */

const TABLE = 'history_events';
const MAX_LIMIT = 200;
const PAGE = 1000;
/** Ids por `in (...)`: a lista vai na URL (ver `DELETE_BATCH` em `lob-repository.ts`). */
const ID_BATCH = 100;

const missingTable = (code?: string) => code === '42P01' || code === 'PGRST205';

/** Grava um registro. Lança erro se o banco recusar: a rota de comandos chama depois de gravar a
 * alteração e só registra a falha no log, sem derrubar o comando. */
export async function recordLobHistory(record: LobHistoryRecord): Promise<void> {
  const { error } = await getServiceClient().from(TABLE).insert({
    id: record.id,
    entity_id: record.entityId,
    entity_type: record.entityType,
    action: record.action,
    author_id: record.authorId,
    occurred_at: record.occurredAt,
    changes: record.changes,
  });
  if (error) throw new Error(`Falha ao gravar o histórico da Linha de Balanço: ${error.message}`);
}

type Row = Record<string, unknown>;

/** Todas as linhas da obra numa tabela da Linha de Balanço, só com as colunas pedidas. Sem a tabela
 * (migração 0038 ausente) devolve vazio: o histórico sai com "pacote excluído" em vez de falhar. */
async function workRows(table: string, columns: string, workId: string): Promise<Row[]> {
  const all: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await getServiceClient()
      .from(table)
      .select(columns)
      .eq('work_id', workId)
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) {
      if (missingTable(error.code)) return [];
      throw new Error(`Falha ao ler ${table}: ${error.message}`);
    }
    const rows = (data ?? []) as unknown as Row[];
    all.push(...rows);
    if (rows.length < PAGE) return all;
  }
}

/** Nome de cada autor, como as outras telas mostram (`profiles.name`): perfil sem nome vira "Sem nome",
 * como na aba Acessos; autor sem perfil fica fora do mapa e sai como "Usuário removido". */
async function authorNames(ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const { data, error } = await getServiceClient()
      .from('profiles')
      .select('id, name')
      .in('id', ids.slice(i, i + ID_BATCH));
    if (error) throw new Error(`Falha ao ler os autores do histórico: ${error.message}`);
    for (const p of (data ?? []) as { id: string; name: string | null }[]) names.set(p.id, p.name?.trim() || 'Sem nome');
  }
  return names;
}

/** As últimas alterações da Linha de Balanço da obra, das mais recentes para as mais antigas (no
 * máximo 200), cada uma com o nome do autor e a frase pronta, montada com os nomes de hoje dos pacotes,
 * locais e blocos. */
export async function listLobHistory(workId: string, limit = 100): Promise<LobHistoryItem[]> {
  const size = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit) || 100));
  const { data, error } = await getServiceClient()
    .from(TABLE)
    .select('id, action, author_id, occurred_at, changes')
    .eq('entity_type', 'lob')
    .eq('entity_id', workId)
    .order('occurred_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(size);
  if (error) throw new Error(`Falha ao ler o histórico da Linha de Balanço: ${error.message}`);
  const rows = (data ?? []) as { id: string; action: string; author_id: string; occurred_at: string; changes: unknown }[];
  if (!rows.length) return [];

  const [services, locals, activities, authors] = await Promise.all([
    workRows('lob_services', 'id, name', workId),
    workRows('lob_locals', 'id, name', workId),
    workRows('lob_activities', 'id, service_id, local_id', workId),
    authorNames([...new Set(rows.map(r => r.author_id))]),
  ]);
  const names: LobHistoryNames = {
    services: new Map(services.map(r => [String(r.id), String(r.name)])),
    locals: new Map(locals.map(r => [String(r.id), String(r.name)])),
    activities: new Map(activities.map(r => [String(r.id), { serviceId: String(r.service_id), localId: String(r.local_id) }])),
    authors,
  };

  return rows.map(r => {
    const record: LobHistoryRecord = {
      id: r.id,
      entityId: workId,
      entityType: 'lob',
      action: r.action as LobHistoryRecord['action'],
      authorId: r.author_id,
      occurredAt: r.occurred_at,
      changes: (r.changes && typeof r.changes === 'object' ? r.changes : {}) as LobHistoryChanges,
    };
    const { text, blocks } = describeLobHistory(record, names);
    return {
      id: r.id,
      occurredAt: r.occurred_at,
      authorId: r.author_id,
      authorName: lobHistoryAuthor(r.author_id, authors),
      action: r.action,
      text,
      blocks,
    };
  });
}

import { NextResponse } from 'next/server';
import { requireModuleAccess } from '@/infrastructure/auth/supabase-server';
import { getServiceClient } from '@/infrastructure/repositories/supabase/client';
import {
  matchOrcamentoObra,
  toOrcamentoElement,
  toOrcamentoModels,
  type OrcamentoElement,
  type OrcamentoModel,
  type OrcamentoModelRow,
  type OrcamentoObra,
} from '@/domain/orcamento-models';

/**
 * Leitura dos modelos IFC do Orçamento 4D (schema `orcamento` do mesmo banco) para o Modelo federado.
 * Só leitura, sempre no servidor e com a chave de serviço: as políticas do schema `orcamento` liberam por
 * usuário do Orçamento 4D, e quem usa o Obra 360 não precisa ter conta lá. A autorização daqui é a do
 * Obra 360 (módulo liberado + obra da pessoa), conferida em `orcamentoAccess` antes de qualquer consulta.
 */
const orcamento = () => getServiceClient().schema('orcamento');

const MODEL_COLUMNS = 'id, disciplina, arquivo, status, revisao, geometria_partes, fragments_tamanho, total_elementos';

/** A obra do Orçamento 4D de mesmo nome da obra do Obra 360, ou null quando não há (ou é privada). */
async function findObra(workId: string): Promise<OrcamentoObra | null> {
  const { data: work, error: workError } = await getServiceClient().from('works').select('name').eq('id', workId).maybeSingle();
  if (workError) throw new Error(workError.message);
  if (!work?.name) return null;
  const [obras, hidden] = await Promise.all([
    orcamento().from('empreendimentos').select('id, nome'),
    orcamento().from('obras_privadas').select('empreendimento_id'),
  ]);
  if (obras.error) throw new Error(obras.error.message);
  if (hidden.error) throw new Error(hidden.error.message);
  return matchOrcamentoObra(
    work.name,
    obras.data as { id: string; nome: string }[],
    (hidden.data as { empreendimento_id: string }[]).map(row => row.empreendimento_id),
  );
}

// A geometria de uma obra são dezenas de partes pedidas em sequência: a ligação obra → empreendimento
// é a mesma em todas, então vale por um minuto neste processo. Só guarda a ligação, nunca a autorização.
const OBRA_TTL = 60_000;
const obraCache = new Map<string, { at: number; obra: OrcamentoObra | null }>();
async function obraOf(workId: string): Promise<OrcamentoObra | null> {
  const hit = obraCache.get(workId);
  if (hit && Date.now() - hit.at < OBRA_TTL) return hit.obra;
  const obra = await findObra(workId);
  obraCache.set(workId, { at: Date.now(), obra });
  return obra;
}

const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });

/**
 * Quem pode ler os modelos do Orçamento 4D desta obra: módulo Modelo federado liberado e a obra entre as da
 * pessoa. Devolve a obra correspondente de lá (null se não existir).
 */
export async function orcamentoAccess(
  workId: string,
): Promise<{ obra: OrcamentoObra | null; error?: undefined } | { error: NextResponse }> {
  if (!workId) return { error: fail('Obra não informada.', 400) };
  const gate = await requireModuleAccess('federacao');
  if (gate.error) return { error: gate.error };
  const { profile } = gate.access;
  if (!profile) return { error: fail('Perfil não provisionado. Contate o gestor.', 403) };
  if (!profile.workIds.includes(workId)) return { error: fail('Você não tem acesso a esta obra.', 403) };
  try {
    return { obra: await obraOf(workId) };
  } catch (cause) {
    return { error: fail(`Falha ao consultar o Orçamento 4D: ${cause instanceof Error ? cause.message : 'erro desconhecido.'}`, 502) };
  }
}

export async function listModels(obraId: string): Promise<OrcamentoModel[]> {
  const { data, error } = await orcamento().from('modelos_ifc').select(MODEL_COLUMNS).eq('empreendimento_id', obraId);
  if (error) throw new Error(error.message);
  return toOrcamentoModels(data as OrcamentoModelRow[]);
}

/** O modelo, se for pronto e desta obra; null para id de outra obra (mesmo que exista). */
export async function findModel(obraId: string, modelId: string): Promise<OrcamentoModel | null> {
  const { data, error } = await orcamento()
    .from('modelos_ifc')
    .select(MODEL_COLUMNS)
    .eq('id', modelId)
    .eq('empreendimento_id', obraId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? (toOrcamentoModels([data as OrcamentoModelRow])[0] ?? null) : null;
}

/** Uma parte (até 2 MB) da geometria convertida, como bytes. O banco devolve em base64. */
export async function readGeometryPart(modelId: string, revision: number, part: number): Promise<Buffer | null> {
  const { data, error } = await orcamento().rpc('geometria_parte', { p_modelo: modelId, p_revisao: revision, p_parte: part });
  if (error) throw new Error(error.message);
  return typeof data === 'string' && data ? Buffer.from(data, 'base64') : null;
}

export async function readElement(modelId: string, expressId: number): Promise<OrcamentoElement | null> {
  const { data, error } = await orcamento()
    .from('elementos_ifc')
    .select(
      'express_id, global_id, ifc_classe, nome, tipo_nome, tipo_express_id, pavimento, materiais, classificacoes, props, qtd_ifc, qtd_geo',
    )
    .eq('modelo_id', modelId)
    .eq('express_id', expressId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const row = data as Record<string, unknown>;
  let typeProps: unknown;
  if (typeof row.tipo_express_id === 'number') {
    // as propriedades do tipo ficam em tipos_ifc; as da instância têm prioridade
    const type = await orcamento()
      .from('tipos_ifc')
      .select('props')
      .eq('modelo_id', modelId)
      .eq('express_id', row.tipo_express_id)
      .maybeSingle();
    if (type.error) throw new Error(type.error.message);
    typeProps = (type.data as { props?: unknown } | null)?.props;
  }
  return toOrcamentoElement(row, typeProps);
}

/** Pares [peça, conjunto] do modelo (guarda-corpo → barras, escada → degraus). Paginado: o banco corta em 1.000. */
export async function readAssemblies(modelId: string): Promise<[number, number][]> {
  const PAGE = 1000;
  const pairs: [number, number][] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await orcamento()
      .from('elementos_ifc')
      .select('express_id, conjunto_express_id')
      .eq('modelo_id', modelId)
      .not('conjunto_express_id', 'is', null)
      .order('express_id')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = data as { express_id: number; conjunto_express_id: number }[];
    for (const row of rows) pairs.push([row.express_id, row.conjunto_express_id]);
    if (rows.length < PAGE) return pairs;
  }
}

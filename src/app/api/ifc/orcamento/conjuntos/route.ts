import { NextResponse, type NextRequest } from 'next/server';
import { isUuid } from '@/domain/orcamento-models';
import { findModel, orcamentoAccess, readAssemblies } from '@/infrastructure/orcamento/ifc-models';

export const runtime = 'nodejs';

/** Pares [peça, conjunto] de um modelo: o clique numa barra de guarda-corpo seleciona o guarda-corpo inteiro.
 * O arquivo do 3D não guarda as relações do IFC; elas ficam em `orcamento.elementos_ifc`. */
export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams;
  const access = await orcamentoAccess(query.get('workId') ?? '');
  if (access.error) return access.error;
  const headers = { 'Cache-Control': 'no-store' };
  const modelId = query.get('modeloId') ?? '';
  if (!isUuid(modelId)) return NextResponse.json({ error: 'Modelo inválido.' }, { status: 400, headers });
  if (!access.obra) return NextResponse.json({ error: 'Esta obra não tem modelos no Orçamento 4D.' }, { status: 404, headers });
  try {
    const model = await findModel(access.obra.id, modelId);
    if (!model) return NextResponse.json({ error: 'Modelo não encontrado nesta obra.' }, { status: 404, headers });
    return NextResponse.json({ pairs: await readAssemblies(model.id) }, { headers });
  } catch (cause) {
    return NextResponse.json(
      { error: `Falha ao ler os conjuntos: ${cause instanceof Error ? cause.message : 'erro desconhecido.'}` },
      { status: 502, headers },
    );
  }
}

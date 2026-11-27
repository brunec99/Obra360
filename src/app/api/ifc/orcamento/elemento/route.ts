import { NextResponse, type NextRequest } from 'next/server';
import { isUuid, parseIndex } from '@/domain/orcamento-models';
import { findModel, orcamentoAccess, readElement } from '@/infrastructure/orcamento/ifc-models';

export const runtime = 'nodejs';

/** Dados do elemento clicado no 3D: identificação, quantidades e propriedades (as do tipo já somadas).
 * `element: null` é resposta válida: geometria auxiliar do arquivo não tem linha no banco. */
export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams;
  const access = await orcamentoAccess(query.get('workId') ?? '');
  if (access.error) return access.error;
  const headers = { 'Cache-Control': 'no-store' };
  const modelId = query.get('modeloId') ?? '';
  const expressId = parseIndex(query.get('expressId'));
  if (!isUuid(modelId) || expressId === null)
    return NextResponse.json({ error: 'Parâmetros do elemento inválidos.' }, { status: 400, headers });
  if (!access.obra) return NextResponse.json({ error: 'Esta obra não tem modelos no Orçamento 4D.' }, { status: 404, headers });
  try {
    const model = await findModel(access.obra.id, modelId);
    if (!model) return NextResponse.json({ error: 'Modelo não encontrado nesta obra.' }, { status: 404, headers });
    return NextResponse.json({ element: await readElement(model.id, expressId) }, { headers });
  } catch (cause) {
    return NextResponse.json(
      { error: `Falha ao ler o elemento: ${cause instanceof Error ? cause.message : 'erro desconhecido.'}` },
      { status: 502, headers },
    );
  }
}

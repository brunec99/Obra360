import { NextResponse, type NextRequest } from 'next/server';
import { listModels, orcamentoAccess } from '@/infrastructure/orcamento/ifc-models';

export const runtime = 'nodejs';

/** Os modelos IFC que o Orçamento 4D tem para esta obra (a de mesmo nome lá). Sem obra correspondente,
 * devolve `obra: null` e lista vazia: a tela mostra só os arquivos enviados no próprio Obra 360. */
export async function GET(request: NextRequest) {
  const access = await orcamentoAccess(request.nextUrl.searchParams.get('workId') ?? '');
  if (access.error) return access.error;
  const headers = { 'Cache-Control': 'no-store' };
  if (!access.obra) return NextResponse.json({ obra: null, models: [] }, { headers });
  try {
    return NextResponse.json({ obra: access.obra, models: await listModels(access.obra.id) }, { headers });
  } catch (cause) {
    return NextResponse.json(
      { error: `Falha ao listar os modelos do Orçamento 4D: ${cause instanceof Error ? cause.message : 'erro desconhecido.'}` },
      { status: 502, headers },
    );
  }
}

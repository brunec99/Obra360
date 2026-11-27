import { NextResponse, type NextRequest } from 'next/server';
import { isUuid, parseIndex, partRequestProblem } from '@/domain/orcamento-models';
import { findModel, orcamentoAccess, readGeometryPart } from '@/infrastructure/orcamento/ifc-models';

export const runtime = 'nodejs';

/** Uma parte da geometria convertida de um modelo do Orçamento 4D, em bytes. A tela pede as partes em
 * paralelo, junta e guarda no cache do navegador por revisão; por isso a resposta não é guardada em outro lugar. */
export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams;
  const access = await orcamentoAccess(query.get('workId') ?? '');
  if (access.error) return access.error;
  const headers = { 'Cache-Control': 'no-store' };
  const modelId = query.get('modeloId') ?? '';
  const revision = parseIndex(query.get('revisao'));
  const part = parseIndex(query.get('parte'));
  if (!isUuid(modelId) || revision === null || part === null)
    return NextResponse.json({ error: 'Parâmetros da geometria inválidos.' }, { status: 400, headers });
  if (!access.obra) return NextResponse.json({ error: 'Esta obra não tem modelos no Orçamento 4D.' }, { status: 404, headers });
  try {
    // O modelo tem de ser desta obra: um id de outra obra responde como inexistente.
    const model = await findModel(access.obra.id, modelId);
    if (!model) return NextResponse.json({ error: 'Modelo não encontrado nesta obra.' }, { status: 404, headers });
    const problem = partRequestProblem(model, revision, part);
    if (problem) return NextResponse.json({ error: problem }, { status: 409, headers });
    const bytes = await readGeometryPart(model.id, revision, part);
    if (!bytes) return NextResponse.json({ error: 'Parte da geometria não encontrada no Orçamento 4D.' }, { status: 404, headers });
    return new NextResponse(new Uint8Array(bytes), {
      headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.byteLength) },
    });
  } catch (cause) {
    return NextResponse.json(
      { error: `Falha ao ler a geometria: ${cause instanceof Error ? cause.message : 'erro desconhecido.'}` },
      { status: 502, headers },
    );
  }
}

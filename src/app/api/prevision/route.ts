import { type NextRequest, NextResponse } from 'next/server';
import { listActivities, listProjects, PrevisionError } from '@/infrastructure/integrations/prevision/client';
import { requireModuleAccess } from '@/infrastructure/auth/supabase-server';
import { getServiceClient } from '@/infrastructure/repositories/supabase/client';
import {
  canSeePrevisionProject,
  PREVISION_PROJECT_ID,
  PREVISION_PROJETO_DE_OUTRA_OBRA,
  visiblePrevisionProjects,
  type WorkLink,
} from '@/domain/prevision-access';
export const runtime = 'nodejs';
// A consulta ao Prevision é liberada por papel, não por endereço: até 01/10/2026 a rota só
// respondia no localhost, decisão anterior ao login real, e a tela Integrações ficava morta em
// produção. Perfil de consulta não dispara chamadas externas. O cache de um minuto e o intervalo
// mínimo entre chamadas continuam, para não sobrecarregar o provedor.
const cache = new Map<string, { expires: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
let lastRequest = 0;
export async function GET(request: NextRequest) {
  const gate = await requireModuleAccess('longo-prazo', 'importar');
  if (gate.error) return gate.error;
  const { profile } = gate.access;
  if (!profile) return NextResponse.json({ error: 'Perfil não provisionado. Contate o gestor.' }, { status: 403 });
  if (profile.role === 'viewer')
    return NextResponse.json(
      { error: 'Seu perfil permite apenas consulta; a integração com o Prevision é para planejadores e gestores.' },
      { status: 403 },
    );
  const projectId = request.nextUrl.searchParams.get('projectId');
  if (projectId !== null && !PREVISION_PROJECT_ID.test(projectId))
    return NextResponse.json({ error: 'Identificador de obra inválido.' }, { status: 400 });
  // Vínculo das obras com o Prevision, para mostrar a cada um só o que é da obra dele ou ainda está livre
  // (ver domain/prevision-access.ts). Conferido ANTES do cache, que é dividido entre todos.
  const { data: links, error: linksError } = await getServiceClient().from('works').select('id, prevision_project_id');
  if (linksError) return NextResponse.json({ error: 'Falha ao consultar as obras.' }, { status: 502 });
  const works: WorkLink[] = (links ?? []).map(w => ({ id: String(w.id), previsionProjectId: w.prevision_project_id ?? null }));
  const viewer = { role: profile.role, workIds: profile.workIds };
  if (projectId !== null && !canSeePrevisionProject(projectId, works, viewer))
    return NextResponse.json({ error: PREVISION_PROJETO_DE_OUTRA_OBRA }, { status: 403 });
  // A lista completa fica no cache; cada resposta leva só os projetos que a pessoa pode ver.
  const forViewer = (value: unknown) =>
    projectId === null && value && Array.isArray((value as { projects?: unknown }).projects)
      ? { projects: visiblePrevisionProjects((value as { projects: { id: string; name: string }[] }).projects, works, viewer) }
      : value;
  const key = projectId ?? 'projects';
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now())
    return NextResponse.json(forViewer(cached.value), { headers: { 'Cache-Control': 'no-store' } });
  try {
    let promise = inflight.get(key);
    if (!promise) {
      if (Date.now() - lastRequest < 11000)
        return NextResponse.json(
          { error: 'Aguarde 11 segundos entre consultas ao Prevision.' },
          { status: 429, headers: { 'Retry-After': '11' } },
        );
      lastRequest = Date.now();
      promise = projectId ? listActivities(projectId) : listProjects().then(projects => ({ projects }));
      inflight.set(key, promise);
    }
    const result = await promise;
    cache.set(key, { expires: Date.now() + 60000, value: result });
    return NextResponse.json(forViewer(result), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof PrevisionError ? error.message : 'A resposta do Prevision não corresponde ao formato esperado.' },
      { status: error instanceof PrevisionError ? error.status : 502 },
    );
  } finally {
    inflight.delete(key);
  }
}

/** Quem pode ver qual projeto do Prevision.
 *
 * O token do Prevision é um só, da ATR, e enxerga todos os projetos da empresa. Até 21/11/2026 qualquer
 * planejador com o módulo recebia a lista inteira e as atividades de qualquer projeto, inclusive dos já
 * ligados a obras de outras pessoas. A tela de Integrações precisa da lista para quem tem obra ainda sem
 * vínculo escolher o projeto (`import_activities` liga a obra a ele), então a regra é:
 *
 * - projeto ligado a uma obra da pessoa: liberado;
 * - projeto ainda livre (nenhuma obra ligada a ele): liberado, para poder ser escolhido;
 * - projeto ligado a obra de OUTRA pessoa: fechado (some da lista e as atividades são recusadas).
 * - admin vê tudo.
 *
 * Funções puras: quem chama passa as obras (`id`, `prevision_project_id`) e o perfil. */

export type WorkLink = { id: string; previsionProjectId: string | null };
export type PrevisionViewer = { role: string; workIds: string[] };

export type PrevisionProjectAccess = 'propria' | 'livre' | 'de-outra-obra';

export function previsionProjectAccess(projectId: string, works: WorkLink[], viewer: PrevisionViewer): PrevisionProjectAccess {
  const linked = works.filter(w => w.previsionProjectId === projectId);
  if (linked.length === 0) return 'livre';
  if (viewer.role === 'admin' || linked.some(w => viewer.workIds.includes(w.id))) return 'propria';
  return 'de-outra-obra';
}

export const canSeePrevisionProject = (projectId: string, works: WorkLink[], viewer: PrevisionViewer) =>
  previsionProjectAccess(projectId, works, viewer) !== 'de-outra-obra';

export function visiblePrevisionProjects<T extends { id: string }>(projects: T[], works: WorkLink[], viewer: PrevisionViewer): T[] {
  return projects.filter(p => canSeePrevisionProject(p.id, works, viewer));
}

export const PREVISION_PROJETO_DE_OUTRA_OBRA = 'Este projeto do Prevision está ligado a uma obra a que você não tem acesso.';

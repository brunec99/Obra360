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

/** Identificador canônico de projeto do Prevision: só dígitos, sem zero à esquerda. `0100` e `100` seriam o
 * mesmo projeto para o Prevision, mas textos diferentes na comparação de acesso; aceitar só a forma canônica
 * fecha esse desvio. */
export const PREVISION_PROJECT_ID = /^[1-9]\d{0,18}$/;

/** Forma canônica de um id vindo do banco (ex.: `0100` gravado antes da regra) ou `null` se não for id. */
export function canonicalPrevisionId(value: string | null | undefined): string | null {
  const text = value?.trim() ?? '';
  if (!/^\d{1,19}$/.test(text)) return null;
  const canon = text.replace(/^0+(?=\d)/, '');
  return canon === '0' ? null : canon;
}

export function previsionProjectAccess(projectId: string, works: WorkLink[], viewer: PrevisionViewer): PrevisionProjectAccess {
  const id = canonicalPrevisionId(projectId);
  // Id fora do formato nunca é liberado por engano: trata como de outra obra.
  if (id === null) return 'de-outra-obra';
  const linked = works.filter(w => canonicalPrevisionId(w.previsionProjectId) === id);
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

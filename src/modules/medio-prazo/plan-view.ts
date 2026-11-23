import type { LinkType, PlanTask } from '@/domain/entities';

export type PlanRowFilter = 'all' | 'incomplete' | 'conflicts';

interface PlanRowOptions {
  query: string;
  filter: PlanRowFilter;
  conflictTaskIds: ReadonlySet<string>;
  folded: ReadonlySet<string>;
}

const normalized = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR');

/** Recebe a ordem integral do plano. A busca muda somente a leitura: não renumera,
 * reordena nem altera tarefas. Os ancestrais contextualizam os resultados mesmo
 * quando estavam recolhidos; ao limpar a busca, a preferência volta a valer. */
export function filterPlanRows(tasks: PlanTask[], { query, filter, conflictTaskIds, folded }: PlanRowOptions): PlanTask[] {
  const tokens = normalized(query).trim().split(/\s+/).filter(Boolean);
  const filtering = tokens.length > 0 || filter !== 'all';
  const ancestors: number[] = [];
  const included = new Set<number>();

  tasks.forEach((task, index) => {
    while (ancestors.length && tasks[ancestors.at(-1)!].level >= task.level) ancestors.pop();

    if (!filtering) {
      if (!ancestors.some(parent => folded.has(tasks[parent].id))) included.add(index);
    } else {
      const summary = !!tasks[index + 1] && tasks[index + 1].level > task.level;
      const matchesFilter =
        filter === 'all' ||
        (filter === 'incomplete' && !summary && task.progress < 100) ||
        (filter === 'conflicts' && conflictTaskIds.has(task.id));
      const name = normalized(task.name);
      if (matchesFilter && tokens.every(token => name.includes(token))) {
        included.add(index);
        ancestors.forEach(parent => included.add(parent));
      }
    }

    ancestors.push(index);
  });

  return tasks.filter((_, index) => included.has(index));
}

/** A primeira letra é a ponta da predecessora; a segunda, a da sucessora. */
export function dependencyAnchors(type: LinkType): { from: 'start' | 'end'; to: 'start' | 'end' } {
  return { from: type[0] === 'I' ? 'start' : 'end', to: type[1] === 'I' ? 'start' : 'end' };
}

/** Linha do cronograma para o "Mostrar até o nível": o número EAP calculado ("2.1.3") e se é resumo. */
export interface OutlineRow {
  id: string;
  number: string;
  summary: boolean;
}
/** Profundidade da linha na estrutura: "2" é nível 1, "2.1.3" é nível 3. Vem do número EAP, não do
 * `level` gravado, que pode pular degraus em dado antigo ou importado. */
export const outlineDepth = (number: string) => number.split('.').length;
/** O nível mais fundo do cronograma (0 sem linhas): até onde vai a lista "Mostrar até". */
export const maxOutlineDepth = (rows: readonly OutlineRow[]) => rows.reduce((max, r) => Math.max(max, outlineDepth(r.number)), 0);
/** "Mostrar subtarefas → Nível N" do Project: os resumos a recolher para ficarem à vista as linhas até
 * a profundidade `level`. Recolhe os resumos de profundidade `level` ou maior e deixa abertos os de
 * cima; os de dentro também ficam recolhidos, para a seta de um resumo abrir só um degrau por vez. */
export function foldedForLevel(rows: readonly OutlineRow[], level: number): string[] {
  const limit = Math.max(1, Math.floor(level));
  return rows.filter(r => r.summary && outlineDepth(r.number) >= limit).map(r => r.id);
}
/** O nível que a tela mostra agora: 'all' com tudo aberto, o número quando os resumos recolhidos são
 * exatamente os de um nível, e nada quando a pessoa abriu ou fechou resumos à mão depois. Ids
 * guardados de linhas que já não existem (ou que deixaram de ser resumo) não contam. */
export function shownLevel(rows: readonly OutlineRow[], folded: readonly string[]): number | 'all' | undefined {
  const summaries = new Set(rows.filter(r => r.summary).map(r => r.id));
  const closed = new Set(folded.filter(id => summaries.has(id)));
  if (!closed.size) return 'all';
  const shallowest = Math.min(...rows.filter(r => closed.has(r.id)).map(r => outlineDepth(r.number)));
  const expected = foldedForLevel(rows, shallowest);
  return expected.length === closed.size && expected.every(id => closed.has(id)) ? shallowest : undefined;
}

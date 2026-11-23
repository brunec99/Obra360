import { nameKey } from './agent-briefing';
import type { PlanTask, Team, WeeklyCommitment } from './entities';
import { DEFAULT_CALENDAR, isWorking, type WorkCalendar } from './plan-schedule';
import { addDays, startOfWeek } from './validation';

/** Tarefa do cronograma do mês → linha da planilha da semana (23/11/2026). A assistente já fazia isso em
 * `propor_criar_linhas`; o botão "Levar para o curto prazo" do Gantt de controle usa a mesma regra, com o
 * recorte também nos dias úteis do calendário do cronograma. Não há vínculo permanente: a linha nasce com
 * o nome, a empresa, a equipe e os dias da tarefa e, dali em diante, o curto prazo se sustenta sozinho.
 * Funções puras. */

/** A data trazida para dentro da semana (segunda a domingo) que começa em `weekStart`. */
export function clampToWeek(date: string, weekStart: string): string {
  const weekEnd = addDays(weekStart, 6);
  return date < weekStart ? weekStart : date > weekEnd ? weekEnd : date;
}

/** O que a linha da semana herda da tarefa. */
export interface WeekLine {
  name: string;
  /** Empresa da equipe principal da tarefa; vazio quando a tarefa não tem equipe da obra. */
  supplier: string;
  teamId: string | null;
  startDate: string;
  endDate: string;
}

/** A regra da assistente: nome da tarefa, equipe principal (e a empresa dela) e o período previsto trazido
 * para dentro da semana. Quem chama decide o que fazer com tarefa que não toca a semana. */
export function weekLineFromTask(
  task: Pick<PlanTask, 'name' | 'teamId' | 'plannedStart' | 'plannedEnd'>,
  teams: Team[],
  weekStart: string,
): WeekLine & { team?: Team } {
  const team = teams.find(t => t.id === task.teamId);
  return {
    name: task.name,
    supplier: team?.company ?? '',
    teamId: team?.id ?? null,
    startDate: clampToWeek(task.plannedStart, weekStart),
    endDate: clampToWeek(task.plannedEnd, weekStart),
    team,
  };
}

/** Os dias da tarefa dentro da semana, do primeiro ao último dia útil do calendário; nada quando a
 * tarefa não toca a semana ou só toca dias sem trabalho (fim de semana, feriado). */
export function workingSpanInWeek(
  task: Pick<PlanTask, 'plannedStart' | 'plannedEnd'>,
  weekStart: string,
  calendar: WorkCalendar = DEFAULT_CALENDAR,
): { startDate: string; endDate: string } | undefined {
  const weekEnd = addDays(weekStart, 6);
  const from = task.plannedStart > weekStart ? task.plannedStart : weekStart;
  const to = task.plannedEnd < weekEnd ? task.plannedEnd : weekEnd;
  let startDate = '',
    endDate = '';
  for (let day = from; day <= to; day = addDays(day, 1))
    if (isWorking(day, calendar)) {
      startDate = startDate || day;
      endDate = day;
    }
  return startDate ? { startDate, endDate } : undefined;
}

/** As tarefas-folha de uma seleção de linhas: a folha selecionada vale por ela, o resumo selecionado vale
 * pelas folhas debaixo dele. `tasks` é o plano inteiro na ordem da tela; a ordem do plano é mantida e
 * ninguém entra duas vezes. `allowed` (as linhas que o filtro deixa passar) limita as folhas trazidas
 * por um resumo: com filtro ativo, o resumo aparece só como contexto das linhas que casam. */
export function leavesOfSelection<T extends Pick<PlanTask, 'id' | 'level'>>(
  tasks: T[],
  selectedIds: ReadonlySet<string>,
  allowed?: ReadonlySet<string>,
): T[] {
  const picked = new Set<string>();
  const summary = (at: number) => tasks[at + 1] !== undefined && tasks[at + 1].level > tasks[at].level;
  tasks.forEach((task, at) => {
    if (!selectedIds.has(task.id)) return;
    if (!summary(at)) return void picked.add(task.id);
    for (let below = at + 1; below < tasks.length && tasks[below].level > task.level; below++)
      if (!summary(below) && (!allowed || allowed.has(tasks[below].id))) picked.add(tasks[below].id);
  });
  return tasks.filter(t => picked.has(t.id));
}

/** Por que a tarefa não pode virar linha da semana. */
export type WeekCandidateBlock = 'fora_da_semana' | 'sem_dia_util';
export const WEEK_CANDIDATE_BLOCKS: Record<WeekCandidateBlock, string> = {
  fora_da_semana: 'Sem dia nesta semana',
  sem_dia_util: 'Só cai em dia sem trabalho nesta semana',
};

export interface WeekCandidate<T> {
  task: T;
  /** A linha a criar; ausente quando `block` diz por que não dá. */
  line?: WeekLine;
  block?: WeekCandidateBlock;
  /** Já existe linha de nome igual (sem acento nem caixa) na planilha da semana. */
  duplicate: boolean;
  /** Tarefa já concluída no cronograma. */
  done: boolean;
  /** Marcada ao abrir: tem dia útil na semana, não está na planilha e não foi concluída. */
  checked: boolean;
}

/** Cada tarefa-folha vista contra a semana de destino. */
export function weekCandidates<T extends Pick<PlanTask, 'name' | 'teamId' | 'plannedStart' | 'plannedEnd' | 'progress' | 'actualEnd'>>(
  leaves: T[],
  options: {
    weekStart: string;
    teams: Team[];
    calendar?: WorkCalendar;
    /** Linhas já gravadas na planilha da obra (de qualquer semana; só as da semana de destino contam). */
    commitments: Pick<WeeklyCommitment, 'name' | 'weekStart'>[];
  },
): WeekCandidate<T>[] {
  const weekStart = startOfWeek(options.weekStart);
  const weekEnd = addDays(weekStart, 6);
  const taken = new Set(options.commitments.filter(c => c.weekStart === weekStart).map(c => nameKey(c.name)));
  return leaves.map(task => {
    const duplicate = taken.has(nameKey(task.name));
    const done = task.progress >= 100 || !!task.actualEnd;
    if (task.plannedEnd < weekStart || task.plannedStart > weekEnd)
      return { task, block: 'fora_da_semana', duplicate, done, checked: false } as const;
    const span = workingSpanInWeek(task, weekStart, options.calendar);
    if (!span) return { task, block: 'sem_dia_util', duplicate, done, checked: false } as const;
    const { name, supplier, teamId } = weekLineFromTask(task, options.teams, weekStart);
    return { task, line: { name, supplier, teamId, ...span }, duplicate, done, checked: !duplicate && !done };
  });
}

/** As folhas previstas para a semana (têm algum dia entre a segunda e o domingo). */
export const leavesInWeek = <T extends Pick<PlanTask, 'plannedStart' | 'plannedEnd'>>(leaves: T[], weekStart: string): T[] =>
  leaves.filter(t => t.plannedStart <= addDays(startOfWeek(weekStart), 6) && t.plannedEnd >= startOfWeek(weekStart));

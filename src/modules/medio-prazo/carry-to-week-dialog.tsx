'use client';
import Link from 'next/link';
import { useId, useState } from 'react';
import { CircleCheckBig, LoaderCircle } from 'lucide-react';
import type { PlanTask, Team, User, WeeklyCommitment } from '@/domain/entities';
import type { WorkCalendar } from '@/domain/plan-schedule';
import { WEEK_CANDIDATE_BLOCKS, leavesInWeek, weekCandidates } from '@/domain/plan-to-week';
import { addDays, startOfWeek } from '@/domain/validation';
import { canEditWeek, weekLockLastDay } from '@/domain/week-lock';
import { weekNumberFrom } from '@/domain/week-numbering';
import type { Command } from '@/application/use-cases/commands';
import { useWorkSettings } from '@/modules/configuracoes/work-settings';
import { Modal } from '@/modules/pendencias/parts';
import { Callout } from '@/modules/planejamento/ui';
import { useToast } from '@/modules/layout/toast';

/** "Levar para o curto prazo" (23/11/2026, retorno do Jorge): as tarefas do Gantt de controle viram
 * linhas da planilha da semana, pelo mesmo `create_commitment` da planilha. A regra (recorte na semana e
 * nos dias úteis, linha repetida, tarefa sem dia na semana) é a de `src/domain/plan-to-week.ts`, a mesma
 * da assistente. Não fica vínculo entre a tarefa e a linha: depois de criada, a linha é da planilha. */

const dm = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
type Scope = 'selecao' | 'semana';

export function CarryToWeekDialog({
  workId,
  leaves,
  selected,
  preferSelection,
  teams,
  calendar,
  commitments,
  today,
  actor,
  execute,
  onClose,
}: {
  workId: string;
  /** Todas as tarefas-folha do cronograma, na ordem da tela. */
  leaves: PlanTask[];
  /** As folhas da seleção da grade (resumo selecionado já trocado pelas folhas dele). */
  selected: PlanTask[];
  /** Abre em "tarefas selecionadas": a pessoa marcou mais de uma linha ou um resumo. */
  preferSelection: boolean;
  teams: Team[];
  calendar: WorkCalendar;
  /** Linhas da planilha semanal desta obra. */
  commitments: WeeklyCommitment[];
  today: string;
  actor: Pick<User, 'id' | 'role'>;
  execute: (command: Command) => Promise<string>;
  onClose: () => void;
}) {
  const titleId = useId();
  const { toast } = useToast();
  const { weekOneStart } = useWorkSettings(workId);
  const currentWeek = startOfWeek(today);
  const weeks = [currentWeek, addDays(currentWeek, 7)];
  const [week, setWeek] = useState(currentWeek);
  const [scope, setScope] = useState<Scope>(preferSelection && selected.length ? 'selecao' : 'semana');
  // Só o que a pessoa mudou à mão; o resto segue o padrão da regra (e se acerta sozinho depois de criar).
  const [marks, setMarks] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<{ count: number; week: string } | null>(null);

  // A semana 1 vem das configurações da obra; sem ela, é a primeira semana com linha, como na planilha.
  const firstWeek = weekOneStart ?? startOfWeek(commitments.reduce((min, c) => (c.weekStart < min ? c.weekStart : min), today));
  const weekLabel = (start: string) => `Semana ${weekNumberFrom(firstWeek, start)} (${dm(start)} a ${dm(addDays(start, 6))})`;
  const locked = !canEditWeek(week, today, actor.role);

  const source = scope === 'selecao' ? selected : leavesInWeek(leaves, week);
  const candidates = weekCandidates(source, { weekStart: week, teams, calendar, commitments });
  const isChecked = (c: (typeof candidates)[number]) => !!c.line && (marks[c.task.id] ?? c.checked);
  const chosen = candidates.filter(isChecked);
  const available = candidates.filter(c => c.line);
  const teamLabel = (teamId: string | null) => {
    const team = teams.find(t => t.id === teamId);
    return team ? `${team.company} · ${team.name}` : 'Sem equipe';
  };
  const change = (next: { week?: string; scope?: Scope }) => {
    if (next.week) setWeek(next.week);
    if (next.scope) setScope(next.scope);
    setMarks({});
    setError('');
    setCreated(null);
  };

  async function create() {
    if (busy || locked || !chosen.length) return;
    setBusy(true);
    setError('');
    setCreated(null);
    let done = 0;
    try {
      // Uma linha por vez, na ordem do cronograma: é a ordem em que entram na planilha.
      for (const candidate of chosen) {
        const line = candidate.line!;
        try {
          await execute({
            type: 'create_commitment',
            workId,
            name: line.name,
            weekStart: week,
            responsibleId: actor.id,
            supplier: line.supplier,
            teamId: line.teamId,
            startDate: line.startDate,
            endDate: line.endDate,
          });
          done++;
        } catch (cause) {
          const message = cause instanceof Error && cause.message ? cause.message : 'Falha ao criar a linha.';
          setError(
            `${done ? `${count(done, 'linha criada', 'linhas criadas')}; parou` : 'Nada foi criado: parou'} em “${line.name}”. ${message}`,
          );
          break;
        }
      }
    } finally {
      setBusy(false);
      // As criadas passam a constar como "já está na planilha"; as que faltam continuam marcadas.
      setMarks({});
    }
    if (done) {
      setCreated({ count: done, week });
      toast({
        title: `${count(done, 'linha criada', 'linhas criadas')} no curto prazo`,
        description: `${weekLabel(week)}. As linhas entram sem apontamento, no fim da planilha.`,
        tone: 'success',
      });
    }
  }

  const option = (active: boolean) =>
    `rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
      active ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
    }`;

  return (
    <Modal onClose={onClose} labelledBy={titleId} busy={busy} width="xl">
      <div className="space-y-4 p-5" data-testid="levar-curto-prazo">
        <div>
          <h2 id={titleId} className="text-base font-bold text-slate-900">
            Levar para o curto prazo
          </h2>
          <p className="mt-1 text-xs leading-5 text-slate-600">
            Cada tarefa marcada vira uma linha da planilha da semana, com o nome, a empresa, a equipe e os dias úteis da tarefa que caem na
            semana. A linha não fica ligada à tarefa: depois de criada, ela é editada e apontada na planilha.
          </p>
        </div>
        <fieldset disabled={busy} className="space-y-4">
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            <div role="radiogroup" aria-label="Semana de destino" className="text-xs font-semibold text-slate-600">
              <span className="mb-1.5 block">Semana de destino</span>
              <div className="flex flex-wrap gap-1.5">
                {weeks.map((start, i) => (
                  <button
                    key={start}
                    type="button"
                    role="radio"
                    aria-checked={week === start}
                    className={option(week === start)}
                    onClick={() => week !== start && change({ week: start })}
                  >
                    {i === 0 ? 'Atual' : 'Próxima'} · {weekLabel(start)}
                  </button>
                ))}
              </div>
            </div>
            <div role="radiogroup" aria-label="Tarefas a levar" className="text-xs font-semibold text-slate-600">
              <span className="mb-1.5 block">Tarefas</span>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  role="radio"
                  aria-checked={scope === 'selecao'}
                  disabled={!selected.length}
                  title={selected.length ? undefined : 'Selecione tarefas na grade antes de abrir'}
                  className={`${option(scope === 'selecao')} disabled:cursor-not-allowed disabled:opacity-40`}
                  onClick={() => scope !== 'selecao' && change({ scope: 'selecao' })}
                >
                  {selected.length === 1 ? `Só a selecionada: ${selected[0].name}` : `As ${selected.length} selecionadas`}
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={scope === 'semana'}
                  className={option(scope === 'semana')}
                  onClick={() => scope !== 'semana' && change({ scope: 'semana' })}
                >
                  Todas as previstas na semana
                </button>
              </div>
            </div>
          </div>
          {locked && (
            <Callout tone="warning" role="status">
              A {weekLabel(week)} foi encerrada em {dm(weekLockLastDay(week))}: só administradores incluem linhas nela.
            </Callout>
          )}
          {candidates.length === 0 ? (
            <Callout tone="info" role="status">
              {scope === 'semana'
                ? 'Nenhuma tarefa do cronograma está prevista para esta semana.'
                : 'A seleção não tem tarefas: escolha linhas na grade ou use “Todas as previstas na semana”.'}
            </Callout>
          ) : (
            <div className="custom-scrollbar max-h-[46dvh] overflow-auto rounded-lg border border-slate-200">
              <table className="data-table min-w-[640px]">
                <thead>
                  <tr>
                    <th className="w-10">
                      <input
                        type="checkbox"
                        className="accent-primary"
                        aria-label="Marcar todas as tarefas disponíveis"
                        disabled={!available.length}
                        checked={available.length > 0 && chosen.length === available.length}
                        onChange={e => setMarks(Object.fromEntries(available.map(c => [c.task.id, e.target.checked])))}
                      />
                    </th>
                    <th>Tarefa</th>
                    <th>Empresa · equipe</th>
                    <th>No cronograma</th>
                    <th>Na semana</th>
                    <th>Situação</th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map(c => (
                    <tr key={c.task.id} className={c.line ? '' : 'text-slate-400'}>
                      <td>
                        <input
                          type="checkbox"
                          className="accent-primary"
                          aria-label={`Levar ${c.task.name}`}
                          disabled={!c.line}
                          checked={isChecked(c)}
                          onChange={e => setMarks({ ...marks, [c.task.id]: e.target.checked })}
                        />
                      </td>
                      <td className="font-medium">{c.task.name}</td>
                      <td>{c.line ? teamLabel(c.line.teamId) : teamLabel(c.task.teamId ?? null)}</td>
                      <td className="whitespace-nowrap tabular-nums">
                        {dm(c.task.plannedStart)} a {dm(c.task.plannedEnd)}
                      </td>
                      <td className="whitespace-nowrap tabular-nums">
                        {c.line
                          ? c.line.startDate === c.line.endDate
                            ? dm(c.line.startDate)
                            : `${dm(c.line.startDate)} a ${dm(c.line.endDate)}`
                          : '—'}
                      </td>
                      <td>
                        {c.block ? (
                          WEEK_CANDIDATE_BLOCKS[c.block]
                        ) : c.duplicate ? (
                          <span className="badge-muted">Já está na planilha</span>
                        ) : c.done ? (
                          <span className="badge-muted">Concluída no cronograma</span>
                        ) : (
                          'Linha nova'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </fieldset>
        {error && (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        )}
        {created && (
          <Callout tone="success" role="status">
            <CircleCheckBig size={15} aria-hidden className="mr-1.5 inline align-[-2px]" />
            {count(created.count, 'linha criada', 'linhas criadas')} na {weekLabel(created.week)}.{' '}
            <Link className="font-semibold underline" href={`/obras/${encodeURIComponent(workId)}/curto-prazo`}>
              Abrir a planilha da semana
            </Link>
            {created.week !== currentWeek && ' (ela abre na semana atual: troque para a próxima no seletor de semana).'}
          </Callout>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto text-xs text-slate-500">
            {count(chosen.length, 'tarefa marcada', 'tarefas marcadas')} de {candidates.length}
          </span>
          <button type="button" className="button-ghost" disabled={busy} onClick={onClose}>
            {created ? 'Fechar' : 'Cancelar'}
          </button>
          <button type="button" className="button" disabled={busy || locked || !chosen.length} onClick={() => void create()}>
            {busy && <LoaderCircle size={14} aria-hidden className="animate-spin" />}
            {busy ? 'Criando…' : `Criar ${count(chosen.length, 'linha', 'linhas')}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { DownloadCloud, RefreshCw } from 'lucide-react';
import { LOB_LIMITS } from '@/domain/lob';
import { formatMoney } from '@/domain/lob-performance';
import { siengeCostLines, type SiengeBudget, type SiengeCostLine, type SiengeDetail } from '@/domain/sienge-budget';
import { Callout } from '@/modules/planejamento/ui';
import type { DraftCost } from './costs-model';
import { mergeSiengeBudget } from './costs-sienge';

/** Diálogo "Buscar do Sienge" da tela Custos (23/11/2026): lê o orçamento do empreendimento ligado à
 * obra, mostra as unidades construtivas e o que muda na tela, e joga as linhas no rascunho. Nada é
 * gravado aqui: só o "Salvar" da tela grava. Uma nova busca reconhece os itens pelo código, atualiza
 * valor e descrição e mantém o pacote já apropriado. */

type Reason = 'not-linked' | 'not-configured' | 'migration';
type State = { status: 'loading' } | { status: 'error'; message: string; reason?: Reason } | { status: 'ready'; budget: SiengeBudget };

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('pt-BR')} ${n === 1 ? one : many}`;
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

export function CostsSiengeDialog({
  workId,
  draft,
  onImport,
  onClose,
}: {
  workId: string;
  /** O rascunho atual, para a prévia do que entra, do que muda e do que sai. */
  draft: readonly DraftCost[];
  onImport: (lines: SiengeCostLine[], sheetIds: number[]) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<State>({ status: 'loading' });
  const [detail, setDetail] = useState<SiengeDetail>('grupo');
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const pending = useRef<{ cancelled: boolean } | null>(null);

  // Cada leitura cancela a anterior: só a resposta da última chamada entra na tela.
  const read = useCallback(
    (refresh: boolean) => {
      if (pending.current) pending.current.cancelled = true;
      const token = { cancelled: false };
      pending.current = token;
      fetch(`/api/sienge/budget?workId=${encodeURIComponent(workId)}${refresh ? '&atualizar=1' : ''}`, { cache: 'no-store' })
        .then(async res => {
          const body = await res.json().catch(() => ({}));
          if (token.cancelled) return;
          if (!res.ok) {
            setState({ status: 'error', message: body.error ?? 'Não foi possível ler o orçamento no Sienge.', reason: body.reason });
            return;
          }
          const budget = body as SiengeBudget;
          setState({ status: 'ready', budget });
          setSelected(new Set(budget.sheets.filter(sheet => sheet.valued > 0).map(sheet => sheet.id)));
        })
        .catch(() => {
          if (!token.cancelled) setState({ status: 'error', message: 'Não foi possível conectar ao servidor. Tente de novo.' });
        });
      return token;
    },
    [workId],
  );
  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
    const token = read(false);
    return () => {
      token.cancelled = true;
    };
  }, [read]);
  const reload = () => {
    setState({ status: 'loading' });
    read(true);
  };
  const close = () => dialog.current?.close();

  const budget = state.status === 'ready' ? state.budget : null;
  // Dentro do intervalo mínimo o servidor devolve a mesma leitura: o botão espera o horário.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!budget?.nextReadAt) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [budget?.nextReadAt]);
  const waitUntil = budget?.nextReadAt && Date.parse(budget.nextReadAt) > now ? budget.nextReadAt : null;
  const lines = useMemo(() => (budget ? siengeCostLines(budget.lines, detail) : []), [budget, detail]);
  const chosen = useMemo(() => lines.filter(line => selected.has(line.sheetId)), [lines, selected]);
  const countBySheet = useMemo(() => {
    const map = new Map<number, number>();
    for (const line of lines) map.set(line.sheetId, (map.get(line.sheetId) ?? 0) + 1);
    return map;
  }, [lines]);
  // A prévia roda a mesma junção da importação, com identificadores de mentira.
  const preview = useMemo(() => {
    let n = 0;
    return mergeSiengeBudget(draft, chosen, selected, { workId, actorId: '', now: '', newId: () => `previa-${n++}` });
  }, [draft, chosen, selected, workId]);
  const { summary } = preview;
  const overLimit = preview.draft.length > LOB_LIMITS.costItems;
  const changes = summary.added + summary.updated + summary.removed;
  const canImport = !!budget && selected.size > 0 && changes > 0 && !overLimit;

  const toggle = (sheetId: number) =>
    setSelected(current => {
      const next = new Set(current);
      if (next.has(sheetId)) next.delete(sheetId);
      else next.add(sheetId);
      return next;
    });

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby="lob-costs-sienge-title"
      className="m-auto max-h-[92vh] w-[min(56rem,94vw)] overflow-hidden rounded-2xl border border-slate-200 bg-white p-0 shadow-xl backdrop:bg-slate-900/55"
    >
      <form
        className="flex max-h-[92vh] flex-col"
        onSubmit={event => {
          event.preventDefault();
          if (!canImport) return;
          onImport(chosen, [...selected]);
          close();
        }}
      >
        <header className="border-b border-slate-100 px-5 py-4">
          <p className="eyebrow">Custos</p>
          <h2 id="lob-costs-sienge-title" className="mt-1 text-base font-bold text-slate-900">
            Buscar do Sienge
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Traz o orçamento do empreendimento do Sienge ligado a esta obra. Os itens novos entram como não apropriados, para apontar ao
            pacote à mão ou com “Sugerir com a Claudia”. Numa nova busca, o item já apropriado mantém o pacote e só atualiza a descrição e o
            valor.
          </p>
        </header>

        <div className="custom-scrollbar flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {state.status === 'loading' && (
            <Callout tone="info" role="status">
              Lendo o orçamento no Sienge… Um orçamento grande pode levar cerca de um minuto.
            </Callout>
          )}

          {state.status === 'error' && (
            <Callout tone={state.reason === 'not-linked' ? 'warning' : 'danger'} role="alert">
              {state.message}{' '}
              {state.reason === 'not-linked' && (
                <Link className="font-semibold underline" href={`/obras/${encodeURIComponent(workId)}/configuracoes#sienge-title`}>
                  Abrir Configurações da obra
                </Link>
              )}
            </Callout>
          )}

          {budget && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-slate-700 tabular-nums">
                  Empreendimento <b>{budget.buildingId}</b> · orçamento de <b>{formatMoney(budget.total)}</b> · lido às{' '}
                  {timeOf(budget.readAt)}
                </p>
                <button
                  type="button"
                  className="button-ghost"
                  onClick={reload}
                  disabled={!!waitUntil}
                  title={waitUntil ? `Para poupar a cota do Sienge, nova leitura a partir das ${timeOf(waitUntil)}.` : undefined}
                >
                  <RefreshCw size={14} aria-hidden />
                  {waitUntil ? `Ler de novo às ${timeOf(waitUntil)}` : 'Ler de novo'}
                </button>
              </div>

              <fieldset>
                <legend className="text-sm font-semibold text-slate-700">Nível de detalhe</legend>
                <div className="mt-1 grid gap-2 sm:grid-cols-2">
                  {(
                    [
                      [
                        'grupo',
                        'Por grupo de serviço',
                        'Cada grupo do orçamento vira uma linha com a soma dos itens dele (ex.: “Alvenaria de vedação - Mão de obra”). Recomendado para apropriar.',
                      ],
                      ['item', 'Item a item', 'Cada insumo ou serviço do orçamento vira uma linha, com o grupo na frente da descrição.'],
                    ] as const
                  ).map(([value, title, text]) => (
                    <label
                      key={value}
                      className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    >
                      <input
                        type="radio"
                        name="lob-costs-sienge-detail"
                        className="mt-1 accent-primary"
                        checked={detail === value}
                        onChange={() => setDetail(value)}
                      />
                      <span>
                        <b className="text-slate-800">{title}</b>
                        <span className="block text-xs text-slate-500">{text}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="custom-scrollbar max-h-72 overflow-auto rounded-lg border border-slate-200">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">Unidades construtivas do orçamento no Sienge</caption>
                  <thead className="sticky top-0 bg-brand-50 text-[11px] font-bold tracking-wider text-brand-800 uppercase">
                    <tr>
                      <th scope="col" className="px-3 py-2">
                        Trazer
                      </th>
                      <th scope="col" className="px-3 py-2">
                        Unidade construtiva
                      </th>
                      <th scope="col" className="px-3 py-2 text-right">
                        Linhas
                      </th>
                      <th scope="col" className="px-3 py-2 text-right">
                        Valor
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {budget.sheets.map(sheet => {
                      const empty = sheet.valued === 0;
                      return (
                        <tr key={sheet.id} className="border-t border-slate-100">
                          <td className="px-3 py-1.5">
                            <input
                              type="checkbox"
                              className="accent-primary"
                              aria-label={`Trazer ${sheet.description}`}
                              disabled={empty}
                              checked={selected.has(sheet.id)}
                              onChange={() => toggle(sheet.id)}
                            />
                          </td>
                          <td className="min-w-48 px-3 py-1.5 text-slate-800">
                            <span className="text-xs text-slate-400 tabular-nums">UC{sheet.id}</span> {sheet.description}
                            {empty && <span className="ml-2 text-xs text-slate-400">sem itens com valor</span>}
                          </td>
                          <td className="px-3 py-1.5 text-right text-slate-600 tabular-nums">
                            {(countBySheet.get(sheet.id) ?? 0).toLocaleString('pt-BR')}
                          </td>
                          <td className="px-3 py-1.5 text-right whitespace-nowrap text-slate-800 tabular-nums">
                            {formatMoney(sheet.total)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-slate-500">
                Itens com valor zero no Sienge ficam de fora. Unidades de custo indireto (equipe, projetos, canteiro) podem vir e ficar como
                não apropriadas, ou ficar de fora: desmarque.
              </p>

              <p className="text-sm text-slate-700 tabular-nums" aria-live="polite">
                <b>{plural(chosen.length, 'linha', 'linhas')}</b> · total <b>{formatMoney(summary.total)}</b>
                {' · '}
                {plural(summary.added, 'nova', 'novas')}
                {summary.inherited > 0 && ` (${plural(summary.inherited, 'já com pacote', 'já com pacote')})`}
                {' · '}
                {plural(summary.updated, 'atualizada', 'atualizadas')}
                {' · '}
                {plural(summary.unchanged, 'igual', 'iguais')}
                {summary.removed > 0 && ` · ${plural(summary.removed, 'item sai', 'itens saem')} da tela`}
              </p>

              {summary.removed > 0 && (
                <Callout tone="warning" role="status">
                  {plural(summary.removed, 'item do Sienge sai', 'itens do Sienge saem')} da tela: não{' '}
                  {summary.removed === 1 ? 'está' : 'estão'} mais no orçamento com valor, ou {summary.removed === 1 ? 'estava' : 'estavam'}{' '}
                  em outro nível de detalhe. Ficar com {summary.removed === 1 ? 'ele' : 'eles'} contaria o mesmo custo duas vezes. Ao trocar
                  o nível de detalhe, a linha nova herda o pacote quando os itens do mesmo ramo estavam todos no mesmo pacote.
                </Callout>
              )}
              {selected.size > 0 && changes === 0 && (
                <Callout tone="info" role="status">
                  A tela já está igual ao orçamento do Sienge nas unidades marcadas: nada a trazer.
                </Callout>
              )}
              {overLimit && (
                <Callout tone="danger" role="alert">
                  A obra aceita até {LOB_LIMITS.costItems.toLocaleString('pt-BR')} itens de custo; com esta busca seriam{' '}
                  {preview.draft.length.toLocaleString('pt-BR')}. Traga por grupo de serviço ou desmarque unidades.
                </Callout>
              )}
            </>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-5 py-3">
          <p className="text-xs text-slate-500">Trazer só põe as linhas na tela: nada é gravado até você clicar em Salvar.</p>
          <div className="flex gap-2">
            <button type="button" className="button-ghost" onClick={close}>
              Cancelar
            </button>
            <button type="submit" className="button" disabled={!canImport}>
              <DownloadCloud size={15} aria-hidden />
              {chosen.length ? `Trazer ${plural(chosen.length, 'linha', 'linhas')}` : 'Trazer'}
            </button>
          </div>
        </footer>
      </form>
    </dialog>
  );
}

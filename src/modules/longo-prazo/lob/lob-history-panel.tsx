'use client';
import { useEffect, useState } from 'react';
import { History, LoaderCircle } from 'lucide-react';
import type { LobHistoryItem } from '@/application/use-cases/lob-history';
import { Drawer } from '@/modules/layout/drawer';
import { usePlanning } from '@/modules/planejamento/planning-provider';
import { Callout } from '@/modules/planejamento/ui';

/** Gaveta "Histórico" da Linha de Balanço (25/11/2026): as últimas 100 alterações do cronograma da obra,
 * com data e hora, autor, a frase do que mudou e quantos blocos mexeu. Os registros nascem em
 * POST /api/lob/commands (`buildLobHistoryEntry`) e saem prontos de GET /api/lob/history; medições
 * ficam de fora (têm autor próprio na visão Medições). */

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const STAMP = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
/** "25/11/2026 14:03", no fuso de Brasília. */
function stamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const part = Object.fromEntries(STAMP.formatToParts(date).map(p => [p.type, p.value]));
  return `${part.day}/${part.month}/${part.year} ${part.hour}:${part.minute}`;
}

type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; items: LobHistoryItem[]; key: string };

export function LobHistoryPanel({
  workId,
  open,
  onClose,
  refreshToken,
}: {
  workId: string;
  open: boolean;
  onClose: () => void;
  /** Muda depois de cada gravação: com a gaveta aberta, a lista é lida de novo. */
  refreshToken?: number;
}) {
  const context = usePlanning();
  const work = context.state === 'ready' ? context.planning.data.works.find(w => w.id === workId) : undefined;
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={work ? `Histórico · ${work.name}` : 'Histórico'}
      description="Linha de Balanço · últimas 100 alterações, da mais recente para a mais antiga"
    >
      {/* A gaveta só monta a lista aberta: cada abertura começa do "carregando" e lê de novo. */}
      <HistoryList key={workId} workId={workId} refreshToken={refreshToken ?? 0} />
    </Drawer>
  );
}

function HistoryList({ workId, refreshToken }: { workId: string; refreshToken: number }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const key = `${refreshToken}:${attempt}`;

  // Cada leitura cancela a anterior: só a resposta da última entra na tela. Numa releitura (gravação com
  // a gaveta aberta), a lista atual fica à vista até a nova chegar.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/lob/history?workId=${encodeURIComponent(workId)}`, { cache: 'no-store' })
      .then(async res => {
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok || !Array.isArray(body.items)) {
          setState({ status: 'error', message: body.error ?? 'Não foi possível carregar o histórico.' });
          return;
        }
        setState({ status: 'ready', items: body.items as LobHistoryItem[], key });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error', message: 'Não foi possível conectar ao servidor.' });
      });
    return () => {
      cancelled = true;
    };
  }, [workId, key]);

  if (state.status === 'loading')
    return (
      <p role="status" className="flex items-center gap-2 py-6 text-sm text-slate-500">
        <LoaderCircle size={15} aria-hidden className="animate-spin" />
        Carregando o histórico…
      </p>
    );
  if (state.status === 'error')
    return (
      <div className="space-y-3">
        <Callout tone="danger" role="alert">
          {state.message}
        </Callout>
        <button
          type="button"
          className="button-ghost"
          onClick={() => {
            setState({ status: 'loading' });
            setAttempt(n => n + 1);
          }}
        >
          Tentar de novo
        </button>
      </div>
    );
  if (!state.items.length)
    return (
      <div className="py-6 text-center text-sm text-slate-500">
        <History size={20} aria-hidden className="mx-auto mb-2 text-slate-400" />
        <p>Nenhuma alteração registrada ainda.</p>
        <p className="mt-1">O histórico começa a contar a partir de 25/11/2026; o que mudou antes não tem autor registrado.</p>
      </div>
    );
  const refreshing = state.key !== key;
  return (
    <>
      {refreshing && (
        <p role="status" className="mb-3 flex items-center gap-2 text-xs text-slate-500">
          <LoaderCircle size={13} aria-hidden className="animate-spin" />
          Atualizando…
        </p>
      )}
      <ol className="space-y-3">
        {state.items.map(item => (
          <li key={item.id} className="min-w-0 rounded-xl border border-slate-200 px-3 py-3">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
              <time dateTime={item.occurredAt} className="font-semibold tabular-nums text-slate-700">
                {stamp(item.occurredAt)}
              </time>
              <span aria-hidden>·</span>
              <span className="min-w-0 break-words">{item.authorName}</span>
              {item.blocks > 0 && <span className="badge-muted px-2 py-0 text-[10px]">{plural(item.blocks, 'bloco', 'blocos')}</span>}
            </p>
            <p className="mt-1 break-words text-sm text-slate-800">{item.text}</p>
          </li>
        ))}
      </ol>
      <p className="mt-4 text-xs text-slate-500">
        Medições ficam de fora: quem lançou cada uma aparece na visão Medições. O histórico conta a partir de 25/11/2026.
      </p>
    </>
  );
}

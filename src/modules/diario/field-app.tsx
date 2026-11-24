'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Check, ChevronRight, CloudDownload, CloudUpload, LogIn, RefreshCw, WifiOff } from 'lucide-react';
import { ConfirmProvider } from '@/modules/layout/confirm';
import { ToastProvider } from '@/modules/layout/toast';
import { HelpButton } from '@/modules/tour/help-button';
import { TourOverlay } from '@/modules/tour/tour-overlay';
import { TourProvider } from '@/modules/tour/tour-provider';
import { errorMessage, SessionExpiredError, useOnline, type DiaryWork } from './api';
import { DiaryEditor } from './diary-editor';
import {
  fetchWorks,
  hasPackage,
  initDiaryStore,
  readWorks,
  registerFieldServiceWorker,
  rememberWork,
  synchronize,
  useDiaryStore,
  type StoredWorks,
} from './offline-store';

/* Diário de Obra em campo: a mesma tela da aba 2.4 (`DiaryEditor`), para o celular e sem sinal, no desenho
 * da terminalidade em campo. A casca é estática e o service worker a guarda; abre-se a obra uma vez com
 * sinal (as listas do Sienge e os locais ficam no aparelho) e depois o diário abre em modo avião. O que é
 * preenchido vai para a fila do aparelho e sobe sozinho quando a conexão volta. */

const LOGIN_URL = '/login?redirect=%2Fcampo%2Fdiario';

export function FieldDiary() {
  return (
    <TourProvider>
      <ToastProvider>
        <ConfirmProvider>
          <FieldApp />
        </ConfirmProvider>
      </ToastProvider>
      <TourOverlay />
    </TourProvider>
  );
}

function FieldApp() {
  const online = useOnline();
  const store = useDiaryStore();
  const [works, setWorks] = useState<StoredWorks | null>(null);
  const [prepared, setPrepared] = useState<Record<string, boolean>>({});
  const [workId, setWorkId] = useState('');
  const [initialDate, setInitialDate] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const markPrepared = useCallback(async (list: DiaryWork[]) => {
    const found: Record<string, boolean> = {};
    for (const work of list) found[work.id] = await hasPackage(work.id);
    setPrepared(found);
  }, []);

  const loadWorks = useCallback(async () => {
    setBusy(true);
    try {
      const stored = await fetchWorks();
      setWorks(stored);
      setNotice('');
      await markPrepared(stored.works);
    } catch (error) {
      // A lista de obras é um extra: sem ela, valem as obras que este aparelho já abriu.
      if (!(error instanceof SessionExpiredError)) setNotice(errorMessage(error, 'Não foi possível carregar as obras.'));
    } finally {
      setBusy(false);
    }
  }, [markPrepared]);

  // Abre pelo que está no aparelho; a obra pedida em `?obra=` (link da tela logada) entra na lista e já abre.
  useEffect(() => {
    registerFieldServiceWorker();
    const query = new URLSearchParams(window.location.search);
    const requested = query.get('obra') ?? '';
    void (async () => {
      await initDiaryStore();
      let stored = await readWorks();
      const name = query.get('nome');
      if (requested && name && !stored?.works.some(work => work.id === requested))
        stored = await rememberWork({ id: requested, name, code: query.get('codigo') ?? '' });
      setWorks(stored);
      if (stored) await markPrepared(stored.works);
      setInitialDate(query.get('data') ?? undefined);
      if (requested) setWorkId(requested);
      setLoaded(true);
      if (navigator.onLine) {
        void synchronize();
        void loadWorks();
      }
    })();
  }, [loadWorks, markPrepared]);

  const work = works?.works.find(item => item.id === workId);
  const pending = store.queue.length;

  const open = (id: string) => {
    setWorkId(id);
    setInitialDate(undefined);
    window.history.replaceState(null, '', id ? `/campo/diario?obra=${encodeURIComponent(id)}` : '/campo/diario');
    if (!id && works) void markPrepared(works.works);
  };

  return (
    <div className="min-h-dvh bg-slate-100 font-sans text-slate-900">
      <header className="sticky top-0 z-30 bg-brand-950 px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] text-white shadow">
        <div className="flex h-11 items-center gap-2">
          {workId ? (
            <button
              type="button"
              onClick={() => open('')}
              aria-label="Voltar para as obras"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg hover:bg-white/10"
            >
              <ArrowLeft size={20} aria-hidden />
            </button>
          ) : (
            <Link
              href="/obras"
              aria-label="Voltar ao Obra 360"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg hover:bg-white/10"
            >
              <ArrowLeft size={20} aria-hidden />
            </Link>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold">{work?.name ?? 'Diário de Obra em campo'}</h1>
            <p className="truncate text-xs text-brand-200">
              {pending > 0
                ? `${pending} ${pending === 1 ? 'alteração guardada' : 'alterações guardadas'} no aparelho`
                : 'Diário do dia no celular, com ou sem sinal'}
            </p>
          </div>
          <span
            className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold ${online ? 'bg-white/15 text-brand-50' : 'bg-amber-400 text-amber-950'}`}
          >
            {online ? <CloudUpload size={13} aria-hidden /> : <WifiOff size={13} aria-hidden />}
            {online ? 'on-line' : 'sem sinal'}
          </span>
          <button
            type="button"
            onClick={() => void synchronize()}
            disabled={!online || store.syncing || pending === 0}
            aria-label="Enviar o que está no aparelho"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg hover:bg-white/10 disabled:opacity-40"
          >
            <RefreshCw size={18} className={store.syncing ? 'animate-spin' : ''} aria-hidden />
          </button>
          <span className="flex [&>button:hover]:bg-white/10 [&>button:hover]:text-white [&>button]:h-11 [&>button]:text-brand-100">
            <HelpButton variant="icon" />
          </span>
        </div>
      </header>

      {!loaded ? (
        <p className="p-6 text-center text-sm text-slate-500">Abrindo…</p>
      ) : workId ? (
        <main className="mx-auto w-full max-w-6xl p-3 sm:p-5">
          <DiaryEditor
            key={workId}
            workId={workId}
            workName={work?.name ?? 'Obra'}
            initialDate={initialDate}
            settingsHref={`/obras/${workId}/configuracoes`}
            navTop="top-[calc(3.25rem+max(0.5rem,env(safe-area-inset-top)))]"
            loginHref={LOGIN_URL}
          />
        </main>
      ) : (
        <main className="mx-auto grid w-full max-w-xl gap-3 p-3">
          {store.sessionExpired && (
            <p role="alert" className="rounded-xl bg-amber-100 px-4 py-3 text-sm text-amber-950">
              Sua sessão expirou. O que foi preenchido continua guardado neste aparelho.{' '}
              <a href={LOGIN_URL} className="inline-flex items-center gap-1 font-semibold underline">
                <LogIn size={14} aria-hidden /> Entrar de novo
              </a>
            </p>
          )}
          {!works || works.works.length === 0 ? (
            <div className="rounded-2xl bg-white p-6 text-center shadow-sm">
              <CloudDownload size={28} className="mx-auto text-brand-600" aria-hidden />
              <h2 className="mt-2 text-base font-semibold">Abra uma obra com sinal</h2>
              <p className="mt-1 text-sm text-slate-600">
                No Obra 360, entre no Diário de Obra (2.4) da obra e toque em “Abrir no modo de campo”. Depois disso a obra fica nesta lista
                e o diário abre no canteiro, sem sinal.
              </p>
              {online ? (
                <button type="button" onClick={() => void loadWorks()} disabled={busy} className="button mt-4 min-h-11">
                  Carregar minhas obras
                </button>
              ) : (
                <p className="mt-4 text-sm font-semibold text-amber-800">Sem sinal agora.</p>
              )}
              {notice && <p className="mt-3 text-xs text-slate-500">{notice}</p>}
            </div>
          ) : (
            <>
              <p className="px-1 text-xs text-slate-500">Abra a obra uma vez com sinal antes de ir para o canteiro.</p>
              {works.works.map(item => {
                const ready = prepared[item.id];
                const queued = store.queue.filter(q => q.workId === item.id).length;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => open(item.id)}
                    disabled={!ready && !online}
                    className="flex w-full items-center gap-3 rounded-2xl bg-white p-4 text-left shadow-sm active:bg-slate-50 disabled:opacity-60"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-base font-semibold">{item.name}</span>
                      <span className="mt-0.5 block text-xs text-slate-500">
                        {ready ? (
                          <>
                            <Check size={12} className="mr-0.5 inline text-success" aria-hidden />
                            Pronta sem sinal
                            {queued > 0 && ` · ${queued} para enviar`}
                          </>
                        ) : online ? (
                          'Toque para abrir e deixar pronta sem sinal'
                        ) : (
                          'Ainda não aberta neste aparelho: precisa de sinal'
                        )}
                      </span>
                    </span>
                    <ChevronRight size={20} className="shrink-0 text-slate-400" aria-hidden />
                  </button>
                );
              })}
            </>
          )}
        </main>
      )}
    </div>
  );
}

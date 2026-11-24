'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, CloudUpload, LoaderCircle, LockOpen, LogIn, RefreshCw, Send, WifiOff } from 'lucide-react';
import {
  DAILY_LIMITS,
  DAILY_READ_ONLY_MESSAGE,
  DAILY_SENT_MESSAGE,
  type DailyContent,
  type DailyCrew,
  type DailyPhotoView,
  type DailyReport,
} from '@/domain/daily-report';
import { formatDay, weekdayName } from '@/domain/headcount';
import type { TerminalityPhoto } from '@/domain/terminality';
import { useConfirm } from '@/modules/layout/confirm';
import { useToast } from '@/modules/layout/toast';
import { compressImage, PhotoError } from '@/modules/terminalidade/compress-image';
import { PhotoViewer } from '@/modules/terminalidade/photo-viewer';
import {
  DiaryApiError,
  errorMessage,
  NetworkError,
  reopenDiary,
  sendDiaryPhotoToSienge,
  sendDiaryToSienge,
  SessionExpiredError,
  useOnline,
} from './api';
import {
  clampDate,
  companiesToLink,
  conference,
  crewTotals,
  dayStrip,
  diarySituation,
  draftProblems,
  localDay,
  sendable,
  shiftDate,
  todayInSaoPaulo,
  type DiaryPhoto,
  type DiarySideCommand,
  type DiarySituation,
  type QueuedOperation,
} from './diary-model';
import {
  CrewsSection,
  EquipmentsSection,
  EventsSection,
  inputClass,
  NotesSection,
  PhotosSection,
  ShiftsSection,
  TasksSection,
} from './diary-sections';
import { ConferencePanel, LinksPanel, LOCK_TEXT, SendDialog, type SendStep } from './diary-send';
import {
  addPhoto,
  changePhoto,
  deletePhoto,
  diaryDayOf,
  discardQueued,
  freshReportId,
  initDiaryStore,
  patchDay,
  queueCommand,
  readImage,
  readLocalDay,
  refreshDay,
  reloadAfterConflict,
  retryQueued,
  saveDraft,
  synchronize,
  useDiaryStore,
} from './offline-store';

/* O editor do Diário de Obra (2.4), o mesmo na tela logada (`/obras/[obraId]/diario`) e no modo de campo
 * (`/campo/diario`). Uma tela por obra e dia. O que a pessoa preenche vai para o aparelho a cada alteração
 * (`offline-store.ts`) e sobe ao servidor 1,5 s depois da última, quando há sinal; sem sinal fica na fila e
 * sobe sozinho quando o sinal volta. Nada vai ao Sienge sem o botão "Enviar ao Sienge", que abre a
 * conferência antes. */

const SYNC_DELAY = 1500;
const RETRY_EVERY = 30_000;

interface Form {
  key: string;
  content: DailyContent;
  crews: DailyCrew[];
}

type Load = { key: string; status: 'ready' | 'unavailable' | 'error'; message?: string; stale?: string };

const SITUATION_CLASS: Record<DiarySituation['key'], string> = {
  sent: 'border-success-ring bg-success-soft text-success',
  error: 'border-danger-ring bg-danger-soft text-danger',
  device: 'border-warning-ring bg-warning-soft text-warning',
  draft: 'border-slate-300 bg-slate-100 text-slate-700',
  empty: 'border-slate-200 bg-white text-slate-500',
};

const describeOperation = (queued: QueuedOperation): string => {
  const { operation } = queued;
  if (operation.kind === 'save') return `Rascunho de ${formatDay(operation.date)}`;
  if (operation.kind === 'photo') return 'Foto';
  switch (operation.command.type) {
    case 'link_local':
      return 'Ligação de local com o Sienge';
    case 'link_company':
      return `Tipo de equipe de ${operation.command.company}`;
    case 'set_sienge_user':
      return 'Seu usuário no Sienge';
    default:
      return 'Alteração de foto';
  }
};

const asViewerPhoto = (photo: DailyPhotoView, url: string): TerminalityPhoto => ({
  id: photo.id,
  itemId: photo.reportId,
  workId: photo.workId,
  kind: 'issue',
  storagePath: photo.storagePath,
  thumbPath: photo.thumbPath,
  createdBy: photo.createdBy,
  createdAt: photo.createdAt || new Date().toISOString(),
  url,
  thumbUrl: photo.thumbUrl ?? undefined,
});

export function DiaryEditor({
  workId,
  workName,
  initialDate,
  settingsHref,
  navTop,
  loginHref,
}: {
  workId: string;
  workName: string;
  /** `yyyy-MM-dd` pedido no endereço (`?data=`); futuro ou inválido vira hoje. */
  initialDate?: string;
  /** Configurações da obra: onde se liga o empreendimento do Sienge e se cadastram os locais. */
  settingsHref: string;
  /** Classe de `top` da barra de atalhos, que fica presa abaixo do cabeçalho de quem hospeda o editor. */
  navTop: string;
  loginHref: string;
}) {
  const store = useDiaryStore();
  const online = useOnline();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [date, setDate] = useState(() => clampDate(initialDate, todayInSaoPaulo()));
  const key = `${workId}:${date}`;
  const [load, setLoad] = useState<Load | null>(null);
  const [reloads, setReloads] = useState(0);
  const [seed, setSeed] = useState(0);
  const [form, setForm] = useState<Form | null>(null);
  const [syncError, setSyncError] = useState('');
  const [preparing, setPreparing] = useState<{ current: number; total: number } | null>(null);
  const [send, setSend] = useState<SendStep | null>(null);
  const [busyPhotoId, setBusyPhotoId] = useState<string | null>(null);
  const [busy, setBusy] = useState<'' | 'reopen' | 'photos' | 'conflict'>('');
  const [viewer, setViewer] = useState<{ photos: TerminalityPhoto[]; index: number; release?: string } | null>(null);
  /** A pessoa já alterou este dia nesta sessão: daí em diante uma leitura do servidor não troca o formulário. */
  const touched = useRef(false);
  const touchedKey = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const day = diaryDayOf(store, workId, date);
  const freshId = freshReportId(workId, date);
  const view = useMemo(() => (day ? localDay(day, store.queue, freshId) : null), [day, store.queue, freshId]);
  const today = day?.today ?? todayInSaoPaulo();
  const status = load?.key === key ? load.status : day ? 'ready' : 'loading';

  // O formulário nasce do dia (servidor com a fila por cima) e depois é da pessoa: a volta de um salvamento
  // não o reescreve, para a linha que ela acabou de abrir em branco não sumir no meio da digitação.
  const formKey = `${key}:${seed}`;
  if (view && form?.key !== formKey) setForm({ key: formKey, content: view.content, crews: view.crews });

  const runSync = useCallback(async () => {
    clearTimeout(timer.current);
    if (!navigator.onLine) return;
    const result = await synchronize();
    setSyncError(result.sessionExpired ? '' : (result.error ?? ''));
  }, []);
  const scheduleSync = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void runSync(), SYNC_DELAY);
  }, [runSync]);

  // Abre pelo que está no aparelho e, com sinal, lê o servidor e envia o que ficou na fila.
  useEffect(() => {
    let active = true;
    if (touchedKey.current !== key) {
      touchedKey.current = key;
      touched.current = false;
    }
    void (async () => {
      await initDiaryStore();
      const local = await readLocalDay(workId, date, todayInSaoPaulo());
      if (!active) return;
      if (!navigator.onLine) {
        setLoad(
          local
            ? { key, status: 'ready' }
            : {
                key,
                status: 'error',
                message: 'Sem sinal, e este aparelho ainda não abriu esta obra. Abra o diário uma vez com sinal.',
              },
        );
        return;
      }
      try {
        const availableNow = await refreshDay(workId, date);
        if (!active) return;
        setLoad({ key, status: availableNow ? 'ready' : 'unavailable' });
        // Nada local por cima: o formulário passa a ser o que acabou de chegar.
        if (availableNow && !touched.current) setSeed(current => current + 1);
      } catch (error) {
        if (!active) return;
        const message = errorMessage(error, 'Não foi possível carregar o diário.');
        if (local) setLoad({ key, status: 'ready', stale: error instanceof SessionExpiredError ? '' : message });
        else setLoad({ key, status: 'error', message });
      }
      void runSync();
    })();
    return () => {
      active = false;
    };
  }, [workId, date, key, reloads, runSync]);

  // O sinal voltou: sobe a fila e relê o dia, sem a pessoa precisar lembrar.
  useEffect(() => {
    const back = () => {
      void runSync();
      setReloads(current => current + 1);
    };
    window.addEventListener('online', back);
    return () => window.removeEventListener('online', back);
  }, [runSync]);

  // Com sinal e algo na fila, tenta de novo de tempos em tempos (servidor fora, sinal fraco).
  const waiting = store.queue.length > 0;
  useEffect(() => {
    if (!waiting || !online) return;
    const interval = setInterval(() => void runSync(), RETRY_EVERY);
    return () => clearInterval(interval);
  }, [waiting, online, runSync]);

  // Ao sair da tela com alteração esperando o intervalo, envia já.
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (navigator.onLine) void synchronize();
    },
    [],
  );

  const goTo = (next: string) => {
    const target = clampDate(next, today);
    if (target === date) return;
    void runSync();
    setDate(target);
    const url = new URL(window.location.href);
    url.searchParams.set('data', target);
    window.history.replaceState(null, '', url);
  };

  if (status === 'loading' || (status === 'ready' && (!day || !view || !form)))
    return (
      <div role="status" aria-label="Carregando o diário" className="grid gap-4">
        <div className="skeleton h-28" />
        <div className="skeleton h-64" />
      </div>
    );
  if (status === 'unavailable') return <p className="callout callout-warning">Diário indisponível: falta aplicar a migração 0059.</p>;
  if (status === 'error' || !day || !view || !form)
    return (
      <div className="panel p-5">
        <p role="alert" className="text-sm font-semibold text-slate-800">
          Não foi possível abrir o diário.
        </p>
        <p className="mt-1 text-sm text-slate-500">{load?.message ?? 'Confira o sinal e tente de novo.'}</p>
        {store.sessionExpired ? (
          <a href={loginHref} className="button mt-4 min-h-11">
            <LogIn size={16} aria-hidden /> Entrar de novo
          </a>
        ) : (
          <button type="button" className="button-ghost mt-4 min-h-11" onClick={() => setReloads(current => current + 1)}>
            <RefreshCw size={15} aria-hidden /> Tentar de novo
          </button>
        )}
      </div>
    );

  const sent = view.status === 'sent';
  const conflict = view.conflict;
  /** O formulário aceita alteração: pode editar, o diário não foi enviado e não há conflito a resolver. */
  const editable = day.canEdit && !sent && !conflict;
  // Diário enviado: a mão de obra mostrada é a leitura do histograma de agora (ele segue editável na aba 2.2).
  const content = editable ? form.content : view.content;
  const crews = editable ? form.crews : view.crews;
  const { support } = view;
  const situation = diarySituation(view);
  const problems = draftProblems(content);
  const totals = crewTotals(crews);
  const pendingHere = view.pending;
  const pendingAll = store.queue.filter(queued => queued.workId === workId).length;
  const summary = conference(day, { ...view, content, crews });
  const sendBlocking = [
    ...(pendingHere > 0 ? ['Ainda há alterações deste dia guardadas só no aparelho. Espere a sincronização terminar.'] : []),
    ...(!view.exists && pendingHere === 0 ? ['O diário deste dia ainda está em branco. Preencha antes de enviar.'] : []),
  ];
  /** Alterações desta obra que não sobem sozinhas agora: recusadas, foto sem descrição, turno incompleto. */
  const stuck = pendingAll - sendable(store.queue).filter(queued => queued.workId === workId).length;
  // O aviso de pendências só aparece quando há o que a pessoa precise saber (sem sinal, servidor fora, algo
  // parado). Enquanto ela digita e a gravação segue normal, quem informa é a situação no alto e o rodapé: um
  // aviso que entra e sai a cada tecla empurra o formulário para baixo no meio da digitação.
  const showPending = !online || (pendingAll > 0 && (syncError !== '' || stuck > 0));
  const photosToSienge = sent ? view.photos.filter(photo => !photo.local && photo.siengeStatus !== 'sent') : [];
  const localPhotos = view.photos.filter(photo => photo.local).length;

  /* ----- alterações do formulário ----- */

  const update = (change: Partial<DailyContent>, nextCrews?: DailyCrew[]) => {
    if (!editable) return;
    const next: Form = { key: form.key, content: { ...form.content, ...change }, crews: nextCrews ?? form.crews };
    touched.current = true;
    setForm(next);
    // A mão de obra só vai no comando se a pessoa mexeu nela (agora ou numa alteração ainda na fila).
    saveDraft(workId, date, view.reportId, next.content, nextCrews || view.crewsTouched ? next.crews : null);
    scheduleSync();
  };
  const sideCommand = (command: DiarySideCommand) => {
    queueCommand(workId, date, command);
    scheduleSync();
  };

  const addFiles = async (files: File[]) => {
    const room = Math.max(0, DAILY_LIMITS.photos - view.photos.length);
    const accepted = files.slice(0, room);
    const errors: string[] = [];
    if (files.length > room) errors.push(`O diário aceita até ${DAILY_LIMITS.photos} fotos; ${files.length - room} ficaram de fora.`);
    for (const [index, file] of accepted.entries()) {
      setPreparing({ current: index + 1, total: accepted.length });
      try {
        const { image, thumb } = await compressImage(file);
        await addPhoto(
          workId,
          date,
          view.reportId,
          { content: form.content, crews: view.crewsTouched ? form.crews : null },
          crypto.randomUUID(),
          { image, thumb },
          { description: '', localId: null, showInReports: true },
        );
      } catch (cause) {
        errors.push(cause instanceof PhotoError || cause instanceof Error ? cause.message : `Não foi possível preparar “${file.name}”.`);
      }
    }
    setPreparing(null);
    if (errors.length) toast({ title: 'Nem todas as fotos entraram', description: errors.join(' '), tone: 'danger' });
    scheduleSync();
  };

  const removePhotoAsk = async (photo: DiaryPhoto) => {
    const ok = await confirm({
      title: 'Excluir a foto?',
      description: photo.local ? 'Ela ainda está só neste aparelho e será apagada.' : 'A foto sai do diário.',
      confirmLabel: 'Excluir',
      tone: 'danger',
    });
    if (!ok) return;
    deletePhoto(workId, date, photo.id);
    scheduleSync();
  };

  const openPhoto = async (photo: DiaryPhoto) => {
    if (photo.url) {
      const withUrl = view.photos.filter(item => item.url);
      setViewer({ photos: withUrl.map(item => asViewerPhoto(item, item.url!)), index: withUrl.findIndex(item => item.id === photo.id) });
      return;
    }
    const image = await readImage(photo.id);
    if (!image) return toast({ title: 'A foto só abre com sinal', tone: 'info' });
    const url = URL.createObjectURL(image);
    setViewer({ photos: [asViewerPhoto(photo, url)], index: 0, release: url });
  };

  /* ----- envio ao Sienge ----- */

  /** Manda as fotos ao Sienge, uma de cada vez. A que o Sienge recusa volta marcada com o erro (o servidor
   * devolve a foto no corpo do erro) e as outras seguem. Devolve quantas falharam. */
  const sendPhotos = async (ids: string[], onProgress?: (current: number, total: number) => void): Promise<number> => {
    let failed = 0;
    for (const [index, photoId] of ids.entries()) {
      onProgress?.(index + 1, ids.length);
      setBusyPhotoId(photoId);
      try {
        const { photo } = await sendDiaryPhotoToSienge(workId, photoId);
        await patchDay(workId, date, { photo });
      } catch (error) {
        failed++;
        if (error instanceof DiaryApiError && error.body.photo) await patchDay(workId, date, { photo: error.body.photo as DailyPhotoView });
        else if (error instanceof SessionExpiredError || error instanceof NetworkError) {
          // Sem sessão ou sem sinal não adianta insistir nas próximas: ficam pendentes para "Enviar fotos pendentes".
          failed += ids.length - index - 1;
          toast({ title: 'O envio das fotos parou', description: error.message, tone: 'danger' });
          break;
        } else toast({ title: 'Uma foto não foi enviada', description: errorMessage(error, 'O Sienge não respondeu.'), tone: 'danger' });
      }
    }
    setBusyPhotoId(null);
    return failed;
  };

  const confirmSend = async () => {
    setSend({ step: 'sending' });
    try {
      const result = await sendDiaryToSienge(workId, view.reportId);
      await patchDay(workId, date, { report: result.report });
      setSeed(current => current + 1);
      const failed = await sendPhotos(result.pendingPhotoIds, (current, total) => setSend({ step: 'photos', current, total }));
      setSend({ step: 'done', siengeId: result.report.siengeId, photos: result.pendingPhotoIds.length, failed });
    } catch (error) {
      // O Sienge recusou: o diário volta no erro com a versão nova (a rota sobe a versão antes de chamar o Sienge).
      if (error instanceof DiaryApiError && error.body.report) await patchDay(workId, date, { report: error.body.report as DailyReport });
      else if (error instanceof DiaryApiError) await refreshDay(workId, date).catch(() => undefined);
      const blocking = error instanceof DiaryApiError && Array.isArray(error.body.blocking) ? (error.body.blocking as string[]) : [];
      setSend({ step: 'error', message: errorMessage(error, 'O Sienge não respondeu. Tente de novo.'), blocking });
    }
  };

  const sendPendingPhotos = async (ids: string[]) => {
    setBusy('photos');
    const failed = await sendPhotos(ids);
    setBusy('');
    if (failed === 0) toast({ title: ids.length === 1 ? 'Foto enviada ao Sienge' : 'Fotos enviadas ao Sienge' });
  };

  const reopen = async () => {
    const ok = await confirm({
      title: 'Excluir do Sienge e reabrir?',
      description: (
        <>
          O diário nº {view.siengeId ?? '—'} é excluído do Sienge, com as fotos que estão lá. Aqui ele volta a ser rascunho, com tudo o que
          foi preenchido, e as fotos voltam a ficar pendentes. Depois de corrigir, é preciso enviar de novo, e o Sienge dará outro número.
        </>
      ),
      confirmLabel: 'Excluir do Sienge e reabrir',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy('reopen');
    try {
      const result = await reopenDiary(workId, view.reportId);
      await patchDay(workId, date, result);
      setSeed(current => current + 1);
      toast({ title: 'Diário reaberto', description: 'Corrija e envie de novo ao Sienge.' });
    } catch (error) {
      toast({ title: 'O diário não foi reaberto', description: errorMessage(error, 'Tente de novo.'), tone: 'danger' });
    } finally {
      setBusy('');
    }
  };

  const reloadConflict = async () => {
    if (!conflict || conflict.operation.kind !== 'save') return;
    setBusy('conflict');
    try {
      await reloadAfterConflict(workId, date, conflict.operation.reportId);
      touched.current = false;
      setSeed(current => current + 1);
    } catch (error) {
      toast({ title: 'Não foi possível recarregar', description: errorMessage(error, 'Confira o sinal e tente de novo.'), tone: 'danger' });
    } finally {
      setBusy('');
    }
  };

  /* ----- tela ----- */

  const sections: { id: string; label: string; count?: number; bad?: boolean }[] = [
    { id: 'diario-clima', label: 'Clima', count: content.shifts.length, bad: content.shifts.length === 0 || problems.length > 0 },
    { id: 'diario-atividades', label: 'Atividades', count: content.tasks.length },
    { id: 'diario-mao-de-obra', label: 'Mão de obra', count: totals.people },
    { id: 'diario-equipamentos', label: 'Equipamentos', count: content.equipments.length },
    { id: 'diario-ocorrencias', label: 'Ocorrências', count: content.events.length },
    { id: 'diario-observacoes', label: 'Observações' },
    {
      id: 'diario-fotos',
      label: 'Fotos',
      count: view.photos.length,
      bad: view.photos.some(photo => photo.siengeStatus !== 'sent' && !photo.description.trim()),
    },
  ];
  const canSend = day.canEdit && !sent && !conflict;
  const barTitle = sent
    ? `Diário nº ${view.siengeId ?? '—'} enviado`
    : conflict
      ? 'Outra pessoa gravou antes'
      : view.failed.length > 0
        ? 'Alteração recusada'
        : !online
          ? 'Sem sinal: guardado no aparelho'
          : pendingHere > 0
            ? store.syncing
              ? 'Salvando…'
              : 'Guardado no aparelho'
            : !view.exists
              ? 'Diário em branco'
              : !day.canEdit
                ? 'Rascunho, ainda não enviado'
                : summary.build.blocking.length > 0
                  ? `${summary.build.blocking.length} ${summary.build.blocking.length === 1 ? 'pendência' : 'pendências'} para enviar`
                  : 'Pronto para enviar';

  return (
    // `grid-cols-1` (coluna de largura mínima zero) é o que segura a tela no celular: com a coluna automática, a
    // barra de atalhos, que rola de lado, alargava a grade inteira para além da tela.
    <div className="grid min-w-0 grid-cols-1 gap-4">
      <section data-tour="diario-dia" className="panel grid min-w-0 grid-cols-1 gap-3 p-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1">
            <p className="eyebrow">Diário de Obra</p>
            <h2 className="truncate text-lg font-bold text-slate-900">{workName}</h2>
          </div>
          <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${SITUATION_CLASS[situation.key]}`}>{situation.label}</span>
        </div>
        <div className="flex items-end gap-2">
          <button
            type="button"
            className="button-ghost h-11 w-11 shrink-0 px-0"
            aria-label="Dia anterior"
            onClick={() => goTo(shiftDate(date, -1, today))}
          >
            <ChevronLeft size={18} aria-hidden />
          </button>
          <label className="grid min-w-0 flex-1 gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Data do diário · {weekdayName(date)}
            <input
              type="date"
              className={inputClass}
              value={date}
              max={today}
              onChange={event => event.target.value && goTo(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="button-ghost h-11 w-11 shrink-0 px-0"
            aria-label="Dia seguinte"
            disabled={date >= today}
            onClick={() => goTo(shiftDate(date, 1, today))}
          >
            <ChevronRight size={18} aria-hidden />
          </button>
        </div>
        <ul aria-label="Últimos dias" className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none]">
          {dayStrip(day.days, today, date).map(item => (
            <li key={item.date} className="shrink-0">
              <button
                type="button"
                aria-current={item.selected ? 'date' : undefined}
                aria-label={`${formatDay(item.date)}: ${item.state === 'sent' ? 'enviado' : item.state === 'draft' ? 'rascunho' : 'sem diário'}`}
                onClick={() => goTo(item.date)}
                className={`grid h-14 w-12 place-items-center rounded-lg border text-xs transition-colors ${
                  item.selected
                    ? 'border-primary bg-primary-soft text-primary-ink'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                <span className="text-[10px] uppercase text-slate-500">{item.weekday}</span>
                <span className="font-semibold tabular-nums">{item.date.slice(8, 10)}</span>
                <span
                  aria-hidden
                  className={`h-1.5 w-1.5 rounded-full ${item.state === 'sent' ? 'bg-success' : item.state === 'draft' ? 'bg-warning' : 'bg-slate-200'}`}
                />
              </button>
            </li>
          ))}
        </ul>
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
          <span>
            <span aria-hidden className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-success align-middle" />
            enviado
          </span>
          <span>
            <span aria-hidden className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-warning align-middle" />
            rascunho
          </span>
          <span>
            Responsável no Sienge: <b className="text-slate-700">{support.siengeUserCode || 'não informado'}</b>
          </span>
        </p>
        {showPending && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning-ring bg-warning-soft px-3 py-2 text-sm text-amber-900">
            {online ? <CloudUpload size={16} className="shrink-0" aria-hidden /> : <WifiOff size={16} className="shrink-0" aria-hidden />}
            <span className="min-w-0 flex-1">
              {pendingAll === 0
                ? 'Sem sinal. O que você preencher fica guardado neste aparelho.'
                : `${pendingAll} ${pendingAll === 1 ? 'alteração guardada' : 'alterações guardadas'} no aparelho${online ? '.' : '. Sobem sozinhas quando o sinal voltar.'}`}
              {localPhotos > 0 && view.photos.some(photo => photo.held) && ' Foto sem descrição espera a descrição.'}
            </span>
            {online && pendingAll > stuck && (
              <button type="button" className="button-ghost min-h-10" disabled={store.syncing} onClick={() => void runSync()}>
                {store.syncing ? <LoaderCircle size={15} className="animate-spin" aria-hidden /> : <RefreshCw size={15} aria-hidden />}
                Salvar agora
              </button>
            )}
          </div>
        )}
      </section>

      {store.sessionExpired && (
        <p role="alert" className="callout callout-warning">
          Sua sessão expirou. O que foi preenchido continua guardado neste aparelho.{' '}
          <a href={loginHref} className="text-link inline-flex items-center gap-1">
            <LogIn size={14} aria-hidden /> Entrar de novo
          </a>
        </p>
      )}
      {store.storageFailed && (
        <p role="alert" className="callout callout-danger">
          Este aparelho não está conseguindo guardar o rascunho (armazenamento cheio ou bloqueado). Não feche a tela antes de salvar com
          sinal.
        </p>
      )}
      {!day.canEdit && <p className="callout callout-info">{DAILY_READ_ONLY_MESSAGE}</p>}
      {sent && (
        <div className="callout callout-success grid gap-2">
          <p>
            Enviado ao Sienge{view.siengeId === null ? '' : ` com o número ${view.siengeId}`}. {DAILY_SENT_MESSAGE} Fotos novas ainda podem
            entrar.
          </p>
          {day.canAdmin && (
            <div>
              <button type="button" className="button-danger min-h-11" disabled={busy !== '' || !online} onClick={() => void reopen()}>
                {busy === 'reopen' ? <LoaderCircle size={16} className="animate-spin" aria-hidden /> : <LockOpen size={16} aria-hidden />}
                Excluir do Sienge e reabrir
              </button>
            </div>
          )}
        </div>
      )}
      {day.fromPackage && (
        <p className="callout callout-info">
          Este dia ainda não foi lido do servidor neste aparelho. Pode preencher: ao voltar o sinal, a tela confere se já existe diário na
          data.
        </p>
      )}
      {load?.key === key && load.stale && (
        <p className="callout callout-warning">
          Mostrando o que está guardado no aparelho ({formatDay(day.savedAt.slice(0, 10))}). {load.stale}
        </p>
      )}
      {support.siengeBuildingId === null && (
        <p className="callout callout-warning">
          Esta obra ainda não está ligada a um empreendimento do Sienge. Pode preencher e salvar; o envio fica bloqueado até ligar a obra em{' '}
          <Link href={settingsHref} className="text-link">
            Configurações da obra
          </Link>
          .
        </p>
      )}
      {support.supportError && <p className="text-xs leading-5 text-warning">{support.supportError}</p>}
      {!sent && view.lastError && (
        <p role="alert" className="callout callout-danger">
          O Sienge recusou o último envio: {view.lastError}
        </p>
      )}
      {conflict && (
        <div role="alert" className="callout callout-danger grid gap-2">
          <p>
            <b>Outra pessoa gravou este diário antes de você.</b> Suas alterações deste dia continuam no aparelho, mas não foram gravadas, e
            a tela está travada para não apagar o que a outra pessoa fez. Recarregue para ver a versão atual e refaça o que faltar.
          </p>
          <div>
            <button type="button" className="button min-h-11" disabled={busy !== '' || !online} onClick={() => void reloadConflict()}>
              <RefreshCw size={16} aria-hidden /> Recarregar e descartar as minhas alterações
            </button>
          </div>
        </div>
      )}
      {view.failed.length > 0 && (
        <div role="alert" className="callout callout-danger grid gap-2">
          <p className="font-semibold">
            O servidor recusou {view.failed.length === 1 ? 'uma alteração' : `${view.failed.length} alterações`}.
          </p>
          <ul className="grid gap-2">
            {view.failed.map(queued => (
              <li key={queued.id} className="grid gap-1.5 rounded-lg bg-white/70 p-2 text-xs">
                <span>
                  <b>{describeOperation(queued)}</b>: {queued.error}
                </span>
                <span className="flex flex-wrap gap-2">
                  <button type="button" className="button-ghost min-h-10" onClick={() => (retryQueued(queued.id), scheduleSync())}>
                    Tentar de novo
                  </button>
                  {queued.operation.kind !== 'save' && (
                    <button type="button" className="button-ghost min-h-10" onClick={() => discardQueued(queued.id)}>
                      Descartar
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs">No rascunho, corrija o que a mensagem aponta: a próxima alteração tenta salvar de novo.</p>
        </div>
      )}
      {syncError && online && pendingAll > 0 && (
        <p className="text-xs leading-5 text-warning">
          Ainda não foi possível salvar no servidor ({syncError}) A tela tenta de novo sozinha.
        </p>
      )}

      <nav
        aria-label="Seções do diário"
        className={`sticky ${navTop} z-20 -mx-1 border-b border-slate-200 bg-background/95 px-1 backdrop-blur`}
      >
        <ul className="flex gap-1.5 overflow-x-auto py-2 [scrollbar-width:none]">
          {sections.map(section => (
            <li key={section.id} className="shrink-0">
              <button
                type="button"
                onClick={() => document.getElementById(section.id)?.scrollIntoView({ block: 'start', behavior: 'smooth' })}
                className={`inline-flex min-h-10 items-center gap-1.5 rounded-full border bg-white px-3 text-xs font-semibold ${
                  section.bad ? 'border-danger-ring text-danger' : 'border-slate-200 text-slate-600'
                }`}
              >
                {section.label}
                {section.count !== undefined && <b className="tabular-nums text-primary">{section.count}</b>}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(0,36rem)_minmax(0,1fr)]">
        <div className="grid min-w-0 grid-cols-1 gap-4">
          <ShiftsSection
            shifts={content.shifts}
            rainfall={content.rainfall}
            problems={problems}
            disabled={!editable}
            onShifts={shifts => update({ shifts })}
            onRainfall={rainfall => update({ rainfall })}
          />
          <TasksSection
            tasks={content.tasks}
            commitments={support.commitments}
            locals={support.locals}
            disabled={!editable}
            onChange={tasks => update({ tasks })}
          />
          <CrewsSection
            crews={crews}
            lastCrews={day.lastCrews}
            companies={support.companies}
            roles={support.roles}
            disabled={!editable}
            onChange={next => update({}, next)}
          />
          <EquipmentsSection
            equipments={content.equipments}
            types={support.equipmentTypes}
            disabled={!editable}
            onChange={equipments => update({ equipments })}
          />
          <EventsSection events={content.events} types={support.eventTypes} disabled={!editable} onChange={events => update({ events })} />
          <NotesSection notes={content.notes} disabled={!editable} onChange={notes => update({ notes })} />
          <PhotosSection
            photos={view.photos}
            locals={support.locals}
            canAdd={day.canEdit && !conflict}
            canEdit={day.canEdit && !conflict}
            reportSent={sent}
            preparing={preparing}
            busyPhotoId={busyPhotoId}
            onAdd={files => void addFiles(files)}
            onChange={(photo, fields) => (changePhoto(workId, date, photo.id, fields), scheduleSync())}
            onDelete={photo => void removePhotoAsk(photo)}
            onRetry={photo => {
              if (photo.queueError && photo.queueId) {
                retryQueued(photo.queueId);
                void runSync();
              } else void sendPendingPhotos([photo.id]);
            }}
            onDiscard={photo => photo.queueId && discardQueued(photo.queueId)}
            onOpen={photo => void openPhoto(photo)}
          />
          {day.canEdit && (
            <LinksPanel
              workId={workId}
              support={support}
              companies={companiesToLink(crews, support.crewTypes)}
              canAdmin={day.canAdmin}
              settingsHref={settingsHref}
              onCommand={sideCommand}
            />
          )}
        </div>
        {!sent && (
          <aside aria-label="O que vai para o Sienge" className="panel hidden min-w-0 gap-3 p-4 lg:sticky lg:top-32 lg:grid">
            <h2 className="text-base font-bold text-slate-900">O que vai para o Sienge</h2>
            <ConferencePanel data={summary} />
            <p className="text-xs leading-5 text-slate-500">{LOCK_TEXT}</p>
          </aside>
        )}
      </div>

      <div className="sticky bottom-0 z-20 rounded-t-xl border-x border-t border-slate-200 bg-white px-3 pb-[env(safe-area-inset-bottom)] shadow-[0_-6px_18px_-10px_rgb(10_54_77/0.25)]">
        <div className="flex items-center gap-3 py-2.5">
          {/* Sem `truncate`: no celular o botão ocupa metade da barra, e o texto quebra em duas linhas em vez de ser cortado. */}
          <p className="min-w-0 flex-1 text-xs leading-4 text-slate-500">
            <b className="block text-sm leading-5 text-slate-900">{barTitle}</b>
            <span className="block">
              {content.tasks.length} {content.tasks.length === 1 ? 'atividade' : 'atividades'} · {totals.people}{' '}
              {totals.people === 1 ? 'pessoa' : 'pessoas'} · {view.photos.length} {view.photos.length === 1 ? 'foto' : 'fotos'}
            </span>
          </p>
          {canSend && (
            <button
              type="button"
              data-tour="diario-enviar"
              className="button min-h-11 shrink-0"
              disabled={!online || store.syncing || pendingHere > 0}
              title={
                !online
                  ? 'Sem sinal: o envio ao Sienge espera o sinal voltar.'
                  : pendingHere > 0
                    ? 'O envio libera quando tudo deste dia estiver salvo no servidor.'
                    : undefined
              }
              onClick={() => setSend({ step: 'review' })}
            >
              <Send size={16} aria-hidden /> Enviar ao Sienge
            </button>
          )}
          {sent && day.canEdit && photosToSienge.length > 0 && (
            <button
              type="button"
              className="button min-h-11 shrink-0"
              disabled={!online || busy !== '' || busyPhotoId !== null}
              onClick={() => void sendPendingPhotos(photosToSienge.map(photo => photo.id))}
            >
              {busy === 'photos' ? <LoaderCircle size={16} className="animate-spin" aria-hidden /> : <Send size={16} aria-hidden />}
              <span className="sm:hidden">Enviar fotos ({photosToSienge.length})</span>
              <span className="hidden sm:inline">Enviar fotos pendentes ({photosToSienge.length})</span>
            </button>
          )}
        </div>
      </div>

      {send && (
        <SendDialog
          state={send}
          data={summary}
          extraBlocking={[...(online ? [] : ['Sem sinal: o envio ao Sienge precisa de conexão.']), ...sendBlocking]}
          onConfirm={() => void confirmSend()}
          onClose={() => setSend(null)}
        />
      )}
      {viewer && (
        <PhotoViewer
          photos={viewer.photos}
          startIndex={viewer.index}
          issueLabel="Foto do diário"
          onClose={() => {
            if (viewer.release) URL.revokeObjectURL(viewer.release);
            setViewer(null);
          }}
        />
      )}
    </div>
  );
}

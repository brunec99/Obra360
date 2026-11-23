'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, CheckCheck, CircleCheck, RefreshCw, TriangleAlert } from 'lucide-react';
import {
  CHECKLIST_LIMITS,
  FREQUENCY_DONE,
  FREQUENCY_LABEL,
  FREQUENCY_PERIOD,
  awaitsRun,
  formatChecklistDay,
  type OperatorChecklistDue,
  type OperatorChecklistView,
} from '@/domain/equipment-checklist';
import { AnswerList, type AnswerDraft } from './answer-list';
import { PhotoPicker, SignaturePad, type PhotoDraft } from './run-fields';

/** A tela do operador (12/11/2026): `/checklist/<token>`, aberta pelo QR colado no equipamento, sem login.
 * Três momentos: a lista dos checklists do equipamento com a situação do período; o formulário (itens,
 * fotos, observação, nome, empresa e assinatura); e a confirmação. O operador registra a inspeção de hoje, e o
 * checklist já feito aceita outra ("Preencher de novo": o equipamento usado por mais de uma pessoa no dia,
 * 20/11/2026); corrigir e apagar ficam com TST e admin, na tela logada. O nome e a empresa ficam guardados no
 * aparelho para o dia seguinte. */

type Ready = Extract<OperatorChecklistView, { available: true }>;
type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'closed'; reason: 'not_found' | 'inactive' | 'unavailable' }
  | { status: 'ready'; view: Ready };
type Saved = {
  modelName: string;
  at: string;
  nonConformities: number;
  operatorName: string;
  operatorCompany: string;
  location?: string;
  notified?: boolean;
};

/** "Já feito hoje", "Já feito nesta semana", "Já feito" (a liberação). */
const doneLabel = (due: OperatorChecklistDue) => `Já feito ${FREQUENCY_DONE[due.frequency]}`.trim();

const NAME_KEY = 'obra360.checklist.operador';
const COMPANY_KEY = 'obra360.checklist.empresa';
const remembered = (key: string) => () => {
  try {
    return window.localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
};
const savedName = remembered(NAME_KEY);
const savedCompany = remembered(COMPANY_KEY);

const CLOSED = {
  not_found: { title: 'Link inválido', body: 'Este QR não vale mais. Peça ao técnico de segurança a etiqueta nova do equipamento.' },
  inactive: { title: 'Equipamento desativado', body: 'Este equipamento foi retirado do checklist. Procure o técnico de segurança.' },
  unavailable: { title: 'Indisponível', body: 'O checklist pelo QR ainda não está disponível. Avise o técnico de segurança.' },
} as const;

const toState = (view: OperatorChecklistView): State =>
  view.available ? { status: 'ready', view } : { status: 'closed', reason: view.reason };

function Shell({ eyebrow, title, children }: { eyebrow: string; title: string; children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-background">
      <header className="bg-primary-ink px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))] text-white">
        <div className="mx-auto max-w-lg">
          <p className="text-xs text-white/75">{eyebrow}</p>
          <h1 className="text-lg font-bold leading-tight">{title}</h1>
        </div>
      </header>
      <main className="mx-auto max-w-lg space-y-3 px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-4">{children}</main>
    </div>
  );
}

function DueCard({ due, onFill }: { due: OperatorChecklistDue; onFill: () => void }) {
  // "Não se aplica" (marcado pelo TST) também espera a inspeção: quem for usar o equipamento preenche.
  const pending = awaitsRun(due.status);
  const tone =
    due.status === 'pending'
      ? 'border-amber-300 bg-amber-50 text-amber-900'
      : due.status === 'skipped'
        ? 'border-slate-300 bg-slate-100 text-slate-700'
        : due.status === 'nonconforming'
          ? 'border-red-300 bg-red-50 text-red-900'
          : due.status === 'treated'
            ? 'border-sky-300 bg-sky-50 text-sky-900'
            : 'border-emerald-300 bg-emerald-50 text-emerald-900';
  return (
    <li className={`flex items-center justify-between gap-3 rounded-xl border p-3 ${tone}`}>
      <div className="min-w-0">
        <p className="text-sm font-bold">
          {FREQUENCY_LABEL[due.frequency]} · {due.name}
        </p>
        <p className="text-xs">
          {due.status === 'skipped'
            ? `marcado como não se aplica ${FREQUENCY_DONE[due.frequency]}. Se for usar o equipamento, preencha.`
            : pending
              ? `pendente ${FREQUENCY_PERIOD[due.frequency]}`
              : `feito em ${formatChecklistDay(due.doneOn!)}${due.doneBy ? ` por ${due.doneBy}` : ''}${due.doneCompany ? ` (${due.doneCompany})` : ''}${due.status === 'nonconforming' ? ' · com não conformidade' : due.status === 'treated' ? ' · não conformidade tratada pelo técnico de segurança' : ''}`}
        </p>
        {!pending && due.doneCount > 1 && (
          <p className="text-xs">
            {due.doneCount} inspeções {FREQUENCY_DONE[due.frequency]}
          </p>
        )}
        {due.asksLocation && (
          <p className="text-xs">
            {due.doneLocations.length
              ? `${doneLabel(due)}: ${due.doneLocations.join(', ')}`
              : 'Informe o nº do equipamento ou o pavimento ao preencher.'}
          </p>
        )}
      </div>
      {(pending || due.canRepeat) && (
        <button type="button" className={pending ? 'button shrink-0' : 'button-ghost shrink-0 bg-white'} onClick={onFill}>
          {pending ? 'Preencher' : 'Preencher de novo'}
        </button>
      )}
    </li>
  );
}

function FillForm({
  token,
  due,
  onBack,
  onSaved,
}: {
  token: string;
  due: OperatorChecklistDue;
  onBack: () => void;
  onSaved: (view: OperatorChecklistView, saved: Saved) => void;
}) {
  const [answers, setAnswers] = useState<AnswerDraft>({});
  const [photos, setPhotos] = useState<PhotoDraft[]>([]);
  const [note, setNote] = useState('');
  const [location, setLocation] = useState('');
  const [name, setName] = useState(savedName);
  const [company, setCompany] = useState(savedCompany);
  const [signature, setSignature] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const missing = due.items.filter(item => !answers[item.id]?.answer).length;
  const fullName = name.trim().split(/\s+/).length >= 2;
  const otherBlock =
    missing > 0
      ? missing === 1
        ? 'Falta responder 1 item.'
        : `Faltam responder ${missing} itens.`
      : !fullName
        ? 'Escreva seu nome completo.'
        : !company.trim()
          ? 'Informe a empresa em que você trabalha.'
          : !signature
            ? 'Falta assinar.'
            : '';
  const blocked = due.asksLocation && !location.trim() ? 'Informe o nº do equipamento ou o pavimento.' : otherBlock;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (blocked || busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/publico/checklist/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId: due.modelId,
          ...(due.asksLocation ? { location } : {}),
          answers: due.items.map(item => ({ itemId: item.id, answer: answers[item.id]!.answer!, note: answers[item.id]?.note ?? '' })),
          note,
          operatorName: name,
          operatorCompany: company,
          signature,
          photos: photos.map(photo => ({ id: photo.id, data: photo.data })),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        view?: OperatorChecklistView;
        saved?: Omit<Saved, 'operatorName' | 'operatorCompany'>;
      };
      if (!response.ok || !body.view || !body.saved) throw new Error(body.error ?? 'Não foi possível enviar. Tente de novo.');
      try {
        window.localStorage.setItem(NAME_KEY, name.trim());
        window.localStorage.setItem(COMPANY_KEY, company.trim());
      } catch {
        // sem armazenamento (aba anônima): só não lembra o nome e a empresa
      }
      onSaved(body.view, { ...body.saved, operatorName: name.trim(), operatorCompany: company.trim() });
    } catch (cause) {
      setError(
        cause instanceof TypeError
          ? 'Sem internet. Suas respostas continuam na tela: tente enviar de novo.'
          : cause instanceof Error
            ? cause.message
            : 'Não foi possível enviar.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <button type="button" className="text-link inline-flex items-center gap-1 text-sm" onClick={onBack} disabled={busy}>
        <ArrowLeft size={15} aria-hidden />
        Voltar
      </button>
      <fieldset disabled={busy} className="space-y-3">
        {due.asksLocation && (
          <label className="panel block p-3 text-xs font-semibold text-slate-600">
            Nº do equipamento ou pavimento
            <input
              className="field mt-1"
              value={location}
              maxLength={CHECKLIST_LIMITS.location}
              placeholder="Ex.: 3º pavimento, Betoneira 02"
              required
              onChange={e => setLocation(e.target.value)}
            />
            {due.doneLocations.length > 0 && (
              <span className="mt-1 block font-normal text-slate-500">
                {doneLabel(due)}: {due.doneLocations.join(', ')}
              </span>
            )}
          </label>
        )}
        <button
          type="button"
          className="button-ghost w-full justify-center"
          onClick={() =>
            setAnswers(current =>
              Object.fromEntries(due.items.map(item => [item.id, current[item.id]?.answer ? current[item.id] : { answer: 'c', note: '' }])),
            )
          }
        >
          <CheckCheck size={15} aria-hidden />
          Marcar os demais como conforme
        </button>
        <AnswerList items={due.items} answers={answers} onChange={setAnswers} large />
        <section className="panel p-3">
          <h2 className="mb-2 text-xs font-semibold text-slate-600">Fotos (opcional, até {CHECKLIST_LIMITS.photos})</h2>
          <PhotoPicker photos={photos} onChange={setPhotos} disabled={busy} />
        </section>
        <label className="panel block p-3 text-xs font-semibold text-slate-600">
          Observação (opcional)
          <textarea className="field mt-1 h-20" value={note} maxLength={CHECKLIST_LIMITS.note} onChange={e => setNote(e.target.value)} />
        </label>
        <section className="panel space-y-3 p-3">
          <label className="block text-xs font-semibold text-slate-600">
            Seu nome completo
            <input
              className="field mt-1"
              value={name}
              maxLength={CHECKLIST_LIMITS.operator}
              autoComplete="name"
              autoCapitalize="words"
              required
              onChange={e => setName(e.target.value)}
            />
          </label>
          <label className="block text-xs font-semibold text-slate-600">
            Empresa em que você trabalha
            <input
              className="field mt-1"
              value={company}
              maxLength={CHECKLIST_LIMITS.company}
              autoComplete="organization"
              autoCapitalize="words"
              placeholder="Ex.: nome da empreiteira"
              required
              onChange={e => setCompany(e.target.value)}
            />
          </label>
          <div>
            <p className="mb-1 text-xs font-semibold text-slate-600">Assinatura</p>
            <SignaturePad onChange={setSignature} disabled={busy} />
          </div>
        </section>
      </fieldset>
      {error && (
        <p role="alert" className="rounded-xl border border-danger-ring bg-danger-soft p-3 text-sm text-danger">
          {error}
        </p>
      )}
      <button type="submit" className="button min-h-12 w-full justify-center text-base" disabled={busy || !!blocked}>
        {busy ? 'Enviando…' : 'Enviar checklist'}
      </button>
      {blocked && <p className="text-center text-xs text-slate-500">{blocked}</p>}
    </form>
  );
}

export function OperatorChecklist({ token }: { token: string }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [modelId, setModelId] = useState<string>();
  const [saved, setSaved] = useState<Saved>();

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/publico/checklist/${encodeURIComponent(token)}`, { cache: 'no-store' });
      const body = (await response.json().catch(() => ({}))) as OperatorChecklistView & { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Não foi possível carregar o checklist.');
      setState(toState(body));
    } catch (cause) {
      setState({
        status: 'error',
        message:
          cause instanceof TypeError
            ? 'Sem internet. Confira o sinal e tente de novo.'
            : cause instanceof Error
              ? cause.message
              : 'Falha ao carregar.',
      });
    }
  }, [token]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- carga inicial: o estado só muda quando a resposta chega
    void load();
  }, [load]);

  if (state.status === 'loading')
    return (
      <Shell eyebrow="Checklist de equipamentos" title="Carregando…">
        <p className="text-sm text-slate-500">Buscando os checklists do equipamento.</p>
      </Shell>
    );
  if (state.status === 'error')
    return (
      <Shell eyebrow="Checklist de equipamentos" title="Não foi possível abrir">
        <p role="alert" className="text-sm text-slate-700">
          {state.message}
        </p>
        <button
          type="button"
          className="button"
          onClick={() => {
            setState({ status: 'loading' });
            void load();
          }}
        >
          <RefreshCw size={15} aria-hidden />
          Tentar de novo
        </button>
      </Shell>
    );
  if (state.status === 'closed')
    return (
      <Shell eyebrow="Checklist de equipamentos" title={CLOSED[state.reason].title}>
        <p className="text-sm text-slate-700">{CLOSED[state.reason].body}</p>
      </Shell>
    );

  const { view } = state;
  const eyebrow = `${view.work.name || 'Obra'} · Checklist de equipamentos`;
  const filling = modelId ? view.dues.find(due => due.modelId === modelId && (awaitsRun(due.status) || due.canRepeat)) : undefined;

  if (filling)
    return (
      <Shell eyebrow={`${view.equipment.name} · ${FREQUENCY_LABEL[filling.frequency]}`} title={filling.name}>
        <FillForm
          key={filling.modelId}
          token={token}
          due={filling}
          onBack={() => setModelId(undefined)}
          onSaved={(next, done) => {
            setState(toState(next));
            setSaved(done);
            setModelId(undefined);
            window.scrollTo({ top: 0 });
          }}
        />
      </Shell>
    );

  return (
    <Shell eyebrow={eyebrow} title={view.equipment.name}>
      <p className="text-xs text-slate-500">
        {view.equipment.equipmentType} · {formatChecklistDay(view.today)}
      </p>
      {saved && (
        <section role="status" className="panel p-5 text-center">
          <CircleCheck size={44} className="mx-auto mb-2 text-success" aria-hidden />
          <h2 className="text-base font-bold text-slate-900">Checklist enviado</h2>
          <p className="text-xs text-slate-500">
            {saved.modelName}
            {saved.location ? ` (${saved.location})` : ''} · {formatChecklistDay(view.today)} às{' '}
            {new Date(saved.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
            <br />
            {saved.operatorName}
            {saved.operatorCompany ? ` · ${saved.operatorCompany}` : ''}
          </p>
          {saved.nonConformities > 0 && (
            <p className="mt-3 flex items-start justify-center gap-1.5 text-sm font-semibold text-danger">
              <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
              {saved.nonConformities === 1 ? '1 item não conforme' : `${saved.nonConformities} itens não conformes`}:{' '}
              {saved.notified
                ? 'o técnico de segurança foi avisado por e-mail. Fale com ele antes de operar.'
                : 'avise o técnico de segurança antes de operar.'}
            </p>
          )}
        </section>
      )}
      {view.dues.length === 0 ? (
        <p className="panel p-4 text-sm text-slate-600">Este equipamento ainda não tem checklist. Avise o técnico de segurança.</p>
      ) : (
        <ul className="space-y-2">
          {view.dues.map(due => (
            <DueCard
              key={due.modelId}
              due={due}
              onFill={() => {
                setSaved(undefined);
                setModelId(due.modelId);
                window.scrollTo({ top: 0 });
              }}
            />
          ))}
        </ul>
      )}
      <p className="text-xs text-slate-500">Encontrou problema grave? Pare o equipamento e avise o técnico de segurança.</p>
    </Shell>
  );
}

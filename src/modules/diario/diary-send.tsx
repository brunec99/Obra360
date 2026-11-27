'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, LoaderCircle, Send, TriangleAlert, X } from 'lucide-react';
import { DAILY_LIMITS, type DailySupport } from '@/domain/daily-report';
import { normalizeSiengeUserCode, type SiengeUserCheck } from '@/domain/sienge-daily-report';
import { headcountKey } from '@/domain/headcount';
import { checkSiengeUserCode, errorMessage } from './api';
import type { Conference, DiarySideCommand } from './diary-model';
import { Hint, inputClass } from './diary-sections';

/* A conferência antes do envio (o que vai ao Sienge, os bloqueios e os avisos), o diálogo que conduz o envio
 * e o painel "Ligações com o Sienge". No protótipo este lugar mostrava o JSON de cada rota; na tela real, o
 * que a pessoa confere é o resumo. */

export const LOCK_TEXT =
  'Depois de enviado, o diário fica travado. Clima, jornada, pluviométrico e observações só mudam se um administrador excluir o diário do Sienge e reabrir.';

const count = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`;

export function ConferencePanel({ data, extraBlocking = [] }: { data: Conference; extraBlocking?: string[] }) {
  const blocking = [...extraBlocking, ...data.build.blocking];
  const { warnings } = data.build;
  const row = 'flex items-baseline justify-between gap-3 border-t border-slate-100 py-1.5 first:border-t-0';
  return (
    <div className="grid gap-3 text-sm">
      {(blocking.length > 0 || warnings.length > 0) && (
        <ul className="grid gap-1.5">
          {blocking.map(message => (
            <li key={message} className="rounded-lg border border-danger-ring bg-danger-soft px-3 py-2 text-rose-800">
              {message}
            </li>
          ))}
          {warnings.map(message => (
            <li key={message} className="rounded-lg border border-warning-ring bg-warning-soft px-3 py-2 text-amber-900">
              {message}
            </li>
          ))}
        </ul>
      )}
      {blocking.length === 0 && warnings.length === 0 && (
        <p className="rounded-lg border border-success-ring bg-success-soft px-3 py-2 text-emerald-800">Tudo certo para enviar.</p>
      )}
      <dl className="tabular-nums">
        <div className={row}>
          <dt className="text-slate-500">Turnos</dt>
          <dd className="text-right font-medium text-slate-800">
            {data.shifts.length === 0
              ? 'Nenhum'
              : data.shifts.map(shift => (
                  <span key={shift.label} className="block">
                    {shift.label} · {shift.hours} · {shift.weather}
                  </span>
                ))}
          </dd>
        </div>
        <div className={row}>
          <dt className="text-slate-500">Pluviométrico</dt>
          <dd className="font-medium text-slate-800">
            {data.rainfall === null ? 'Não informado' : `${String(data.rainfall).replace('.', ',')} mm`}
          </dd>
        </div>
        <div className={row}>
          <dt className="text-slate-500">Atividades</dt>
          <dd className="font-medium text-slate-800">{data.tasks}</dd>
        </div>
        <div className={row}>
          <dt className="text-slate-500">Mão de obra</dt>
          <dd className="text-right font-medium text-slate-800">
            {count(data.people, 'pessoa', 'pessoas')}
            {data.companies.map(company => (
              <span key={company.company} className={`block text-xs font-normal ${company.linked ? 'text-slate-500' : 'text-warning'}`}>
                {company.company}: {company.quantity}
                {company.linked ? '' : ' (não segue: sem tipo de equipe)'}
              </span>
            ))}
          </dd>
        </div>
        <div className={row}>
          <dt className="text-slate-500">Equipamentos</dt>
          <dd className="font-medium text-slate-800">{data.equipments}</dd>
        </div>
        <div className={row}>
          <dt className="text-slate-500">Ocorrências</dt>
          <dd className="font-medium text-slate-800">{data.events}</dd>
        </div>
        <div className={row}>
          <dt className="text-slate-500">Observações</dt>
          <dd className="font-medium text-slate-800">{data.hasNotes ? 'Sim' : 'Não'}</dd>
        </div>
        <div className={row}>
          <dt className="text-slate-500">Fotos a enviar</dt>
          <dd className="text-right font-medium text-slate-800">
            {data.photos.toSend}
            {data.photos.toSend > 0 && (
              <span className="block text-xs font-normal text-slate-500">
                {data.photos.withLocal} com local do Sienge · {data.photos.withoutLocal} sem (fora do Relatório Fotográfico)
              </span>
            )}
            {data.photos.alreadySent > 0 && (
              <span className="block text-xs font-normal text-slate-500">{data.photos.alreadySent} já no Sienge</span>
            )}
          </dd>
        </div>
      </dl>
    </div>
  );
}

export type SendStep =
  | { step: 'review' }
  | { step: 'sending' }
  | { step: 'photos'; current: number; total: number }
  | { step: 'done'; siengeId: number | null; photos: number; failed: number }
  | { step: 'error'; message: string; blocking: string[] };

/** O diálogo do envio: conferência, confirmação e progresso ("Foto 2 de 5"). É um `<dialog>` modal, como a
 * confirmação do sistema; durante o envio não fecha. */
export function SendDialog({
  state,
  data,
  extraBlocking,
  onConfirm,
  onClose,
}: {
  state: SendStep;
  data: Conference;
  extraBlocking: string[];
  onConfirm: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const working = state.step === 'sending' || state.step === 'photos';
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);
  const blocked = extraBlocking.length + data.build.blocking.length > 0;
  return (
    <dialog
      ref={dialog}
      aria-labelledby="diario-envio-titulo"
      onCancel={event => {
        event.preventDefault();
        if (!working) onClose();
      }}
      className="m-auto max-h-[92dvh] w-[min(32rem,94vw)] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-0 shadow-xl backdrop:bg-slate-900/55"
    >
      <div className="grid gap-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <h2 id="diario-envio-titulo" className="text-base font-bold text-slate-900">
            {state.step === 'done' ? 'Diário enviado' : 'Conferir e enviar ao Sienge'}
          </h2>
          {!working && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Fechar"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-slate-100"
            >
              <X size={18} aria-hidden />
            </button>
          )}
        </div>
        {state.step === 'review' && (
          <>
            <ConferencePanel data={data} extraBlocking={extraBlocking} />
            <p className="callout callout-warning">{LOCK_TEXT}</p>
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className="button-ghost min-h-11" onClick={onClose}>
                Voltar ao diário
              </button>
              <button type="button" className="button min-h-11" disabled={blocked} onClick={onConfirm}>
                <Send size={16} aria-hidden /> Enviar ao Sienge
              </button>
            </div>
          </>
        )}
        {working && (
          <p role="status" className="flex items-center gap-2 text-sm font-semibold text-primary-ink">
            <LoaderCircle size={18} className="animate-spin" aria-hidden />
            {state.step === 'sending' ? 'Criando o diário no Sienge…' : `Foto ${state.current} de ${state.total}…`}
          </p>
        )}
        {state.step === 'done' && (
          <>
            <p role="status" className="callout callout-success flex items-start gap-2">
              <Check size={18} className="mt-0.5 shrink-0" aria-hidden />
              <span>
                {state.siengeId === null ? 'O diário está no Sienge.' : `O diário está no Sienge com o número ${state.siengeId}.`}
                {state.photos > 0 && ` ${count(state.photos - state.failed, 'foto enviada', 'fotos enviadas')}.`}
              </span>
            </p>
            {state.failed > 0 && (
              <p role="alert" className="callout callout-danger">
                {count(state.failed, 'foto não foi', 'fotos não foram')} ao Sienge. Cada uma mostra o motivo e o botão “Tentar de novo” na
                seção Fotos. O diário não é enviado de novo.
              </p>
            )}
            <div className="flex justify-end">
              <button type="button" className="button min-h-11" onClick={onClose}>
                Fechar
              </button>
            </div>
          </>
        )}
        {state.step === 'error' && (
          <>
            <div role="alert" className="callout callout-danger">
              <p className="flex items-start gap-2 font-semibold">
                <TriangleAlert size={18} className="mt-0.5 shrink-0" aria-hidden /> O diário não foi enviado.
              </p>
              <p className="mt-1">{state.message}</p>
              {state.blocking.length > 0 && (
                <ul className="mt-1 list-disc pl-5">
                  {state.blocking.map(message => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
              )}
            </div>
            <div className="flex justify-end">
              <button type="button" className="button-ghost min-h-11" onClick={onClose}>
                Voltar ao diário
              </button>
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}

/* ---------- Ligações com o Sienge ---------- */

/** Ligar o login do Sienge como no formulário de compras: a pessoa digita, o servidor confere no Sienge e
 * mostra o NOME do dono, e só "Sim, sou eu" grava. A confirmação existe porque ligar o login de outra pessoa
 * assinaria os diários no nome dela sem erro em lugar nenhum. O "Sou eu" das sugestões já mostra o nome. */
function SiengeUserLink({
  matches = [],
  placeholder,
  onCommand,
}: {
  matches?: { code: string; name: string }[];
  placeholder: string;
  onCommand: (command: DiarySideCommand) => void;
}) {
  const [code, setCode] = useState('');
  const [check, setCheck] = useState<SiengeUserCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const clean = normalizeSiengeUserCode(code);
  const verify = async (live = false) => {
    setBusy(true);
    setError('');
    try {
      setCheck(await checkSiengeUserCode(clean, live));
    } catch (cause) {
      setCheck(null);
      setError(errorMessage(cause, 'Não foi possível conferir o usuário no Sienge agora.'));
    } finally {
      setBusy(false);
    }
  };
  const confirm = (value: string) => {
    onCommand({ type: 'set_sienge_user', code: value });
    setCode('');
    setCheck(null);
  };
  return (
    <div className="grid gap-2">
      {matches.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {matches.map(match => (
            <button key={match.code} type="button" className="button-secondary min-h-11" onClick={() => confirm(match.code)}>
              <Check size={16} aria-hidden />
              Sou eu: {match.name} ({match.code})
            </button>
          ))}
        </div>
      )}
      <form
        className="flex flex-wrap gap-2"
        onSubmit={event => {
          event.preventDefault();
          if (clean && !busy) void verify();
        }}
      >
        <input
          className={`${inputClass} min-w-0 flex-1 basis-48`}
          aria-label="Seu usuário no Sienge"
          placeholder={placeholder}
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          maxLength={DAILY_LIMITS.siengeUserCode}
          value={code}
          onChange={event => {
            setCode(event.target.value);
            setCheck(null);
            setError('');
          }}
        />
        <button type="submit" className="button min-h-11" disabled={!clean || busy}>
          {busy && <LoaderCircle size={16} className="animate-spin" aria-hidden />}
          Conferir
        </button>
      </form>
      {error && <Hint tone="warning">{error}</Hint>}
      {check && (
        <div role="status" className="grid gap-2">
          <p className="text-sm">{check.message}</p>
          {check.state === 'found' && (
            <button type="button" className="button min-h-11 justify-self-start" onClick={() => confirm(check.code)}>
              <Check size={16} aria-hidden />
              Sim, sou eu
            </button>
          )}
          {(check.state === 'not_found' || check.state === 'inactive') && (
            <button
              type="button"
              className="button-secondary min-h-11 justify-self-start"
              disabled={busy}
              onClick={() => void verify(true)}
            >
              Verificar de novo
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Aviso no alto do diário enquanto a pessoa não ligou o usuário dela do Sienge. Ligar é obrigatório para
 * enviar (24/11/2026): sem o código, o Sienge gravaria o usuário da integração (SIENGEAPI) como responsável
 * de todos os diários. Oferece "Sou eu" com os usuários do Sienge que parecem ser dela. */
export function SiengeUserPrompt({ support, onCommand }: { support: DailySupport; onCommand: (command: DiarySideCommand) => void }) {
  const matches = support.siengeUserMatches ?? [];
  return (
    <section className="callout callout-warning grid gap-3" aria-labelledby="diario-usuario-sienge">
      <div className="grid gap-1">
        <h2 id="diario-usuario-sienge" className="text-sm font-bold">
          Ligue seu usuário do Sienge
        </h2>
        <p className="text-sm">
          É o login com que você entra no Sienge. Ele vai como responsável de cada diário que você enviar, e sem ele o envio fica bloqueado.
          Você faz isso uma vez só.
        </p>
      </div>
      <SiengeUserLink matches={matches} placeholder={matches.length ? 'Ou digite o seu login' : 'Ex.: MARIA.SILVA'} onCommand={onCommand} />
    </section>
  );
}

/** Campo que só grava ao sair dele (ou no Enter): o código é digitado inteiro antes de virar comando. */
function CommitInput({
  value,
  onCommit,
  ...props
}: { value: string; onCommit: (value: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft.trim() !== value) onCommit(draft.trim());
    setDraft(null);
  };
  return (
    <input
      {...props}
      className={inputClass}
      value={draft ?? value}
      onChange={event => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={event => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
  );
}

export function LinksPanel({
  workId,
  support,
  companies,
  canAdmin,
  settingsHref,
  onCommand,
}: {
  workId: string;
  support: DailySupport;
  /** Empresas do dia cujo nome não bate com um tipo de equipe do Sienge. */
  companies: string[];
  canAdmin: boolean;
  settingsHref: string;
  onCommand: (command: DiarySideCommand) => void;
}) {
  const unlinkedLocals = support.locals.filter(local => local.siengeSiteId === null).length;
  const linkOf = (company: string) => support.companyLinks.find(link => link.companyKey === headcountKey(company))?.crewTypeId ?? null;
  const missing =
    (support.siengeUserCode ? 0 : 1) + unlinkedLocals + (canAdmin ? companies.filter(company => linkOf(company) === null).length : 0);
  return (
    <details className="panel group min-w-0">
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-bold text-slate-900 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">Ligações com o Sienge</span>
        {missing > 0 && (
          <span className="rounded-full border border-warning-ring bg-warning-soft px-2 py-0.5 text-[11px] font-semibold text-warning">
            {count(missing, 'pendente', 'pendentes')}
          </span>
        )}
        <ChevronDown size={18} className="shrink-0 text-slate-400 transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="grid gap-5 border-t border-slate-100 p-4">
        <div className="grid gap-2">
          <h3 className="text-sm font-semibold text-slate-800">Seu usuário no Sienge</h3>
          <p className="text-sm text-slate-700">
            {support.siengeUserCode ? (
              <>
                Ligado: <b>{support.siengeUserCode}</b>
              </>
            ) : (
              'Ainda não ligado.'
            )}
          </p>
          <SiengeUserLink placeholder={support.siengeUserCode ? 'Trocar por outro login' : 'Ex.: MARIA.SILVA'} onCommand={onCommand} />
          <Hint>
            É o login com que você entra no Sienge. Vai como responsável do diário e fica guardado no seu cadastro. Sem ele o envio fica
            bloqueado.
          </Hint>
        </div>

        <div className="grid gap-2">
          <h3 className="text-sm font-semibold text-slate-800">Locais</h3>
          {support.sites === null && (
            <Hint tone="warning">
              Não foi possível ler os locais do Sienge agora. Informe o código do local no Sienge à mão ou tente de novo mais tarde.
            </Hint>
          )}
          {support.locals.length === 0 ? (
            <Hint>
              Esta obra ainda não tem locais.{' '}
              <Link href={settingsHref} className="text-link">
                Cadastrar em Configurações da obra
              </Link>
            </Hint>
          ) : (
            support.locals.map(local => (
              <div key={local.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-2">
                <span className="min-w-0 truncate text-sm text-slate-700">{local.name}</span>
                {support.sites ? (
                  <select
                    className={inputClass}
                    aria-label={`Local do Sienge para ${local.name}`}
                    value={local.siengeSiteId ?? ''}
                    onChange={event =>
                      onCommand({
                        type: 'link_local',
                        workId,
                        localId: local.id,
                        siengeSiteId: event.target.value ? Number(event.target.value) : null,
                      })
                    }
                  >
                    <option value="">Sem ligação</option>
                    {local.siengeSiteId !== null && !support.sites.some(site => site.id === local.siengeSiteId) && (
                      <option value={local.siengeSiteId}>Código {local.siengeSiteId}</option>
                    )}
                    {support.sites.map(site => (
                      <option key={site.id} value={site.id}>
                        {site.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <CommitInput
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    placeholder="Código"
                    aria-label={`Código do local no Sienge para ${local.name}`}
                    value={local.siengeSiteId === null ? '' : String(local.siengeSiteId)}
                    onCommit={text => {
                      const code = Math.trunc(Number(text));
                      onCommand({ type: 'link_local', workId, localId: local.id, siengeSiteId: text && code >= 1 ? code : null });
                    }}
                  />
                )}
              </div>
            ))
          )}
          <Hint>Atividade e foto só levam o local ao Sienge quando ele está ligado aqui.</Hint>
        </div>

        {canAdmin && (
          <div className="grid gap-2">
            <h3 className="text-sm font-semibold text-slate-800">Empresas</h3>
            {companies.length === 0 ? (
              <Hint>Todas as empresas do dia já têm tipo de equipe no Sienge.</Hint>
            ) : support.crewTypes.length === 0 ? (
              <Hint tone="warning">Os tipos de equipe do Sienge não foram carregados. Abra o diário com sinal para ligar as empresas.</Hint>
            ) : (
              companies.map(company => (
                <div key={company} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-2">
                  <span className="min-w-0 truncate text-sm text-slate-700">{company}</span>
                  <select
                    className={inputClass}
                    aria-label={`Tipo de equipe do Sienge para ${company}`}
                    value={linkOf(company) ?? ''}
                    onChange={event =>
                      onCommand({ type: 'link_company', company, crewTypeId: event.target.value ? Number(event.target.value) : null })
                    }
                  >
                    <option value="">Sem tipo de equipe</option>
                    {support.crewTypes.map(type => (
                      <option key={type.id} value={type.id}>
                        {type.label}
                      </option>
                    ))}
                  </select>
                </div>
              ))
            )}
            <Hint>A ligação vale para todas as obras. Empresa sem tipo de equipe não segue na mão de obra do Sienge.</Hint>
          </div>
        )}
      </div>
    </details>
  );
}

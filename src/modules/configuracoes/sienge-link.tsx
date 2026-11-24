'use client';
import { useState } from 'react';
import { Link2 } from 'lucide-react';
import { usePlanning } from '@/modules/planejamento/planning-provider';
import { Callout } from '@/modules/planejamento/ui';
import { HelpNote } from '@/modules/layout/help-note';
import { useToast } from '@/modules/layout/toast';
import { suggestEnterprise, type SiengeEnterprise } from '@/domain/sienge-budget';
import { useWorkSettings } from './work-settings';

type Listing =
  { status: 'idle' } | { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; enterprises: SiengeEnterprise[] };

/** Ligação da obra com o empreendimento do Sienge (23/11/2026): é dele que a visão Custos da Linha de
 * Balanço busca o orçamento ("Buscar do Sienge"). Todos veem a ligação; só o administrador escolhe ou
 * desfaz, porque ela decide o orçamento de qual empreendimento a obra enxerga. */
export function SiengeLink({ workId }: { workId: string }) {
  const context = usePlanning();
  const { toast } = useToast();
  const { state, siengeBuildingId, siengeAvailable, saveSiengeBuilding } = useWorkSettings(workId);
  const [listing, setListing] = useState<Listing>({ status: 'idle' });
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (context.state !== 'ready' || state.status === 'loading') return null;
  const actor = context.planning.data.users.find(u => u.id === context.actorId);
  const work = context.planning.data.works.find(w => w.id === workId);
  const admin = actor?.role === 'admin';
  const enterprises = listing.status === 'ready' ? listing.enterprises : [];
  const linked = enterprises.find(e => e.id === siengeBuildingId);
  const suggestion = work && listing.status === 'ready' ? suggestEnterprise(work.name, enterprises) : null;

  const loadEnterprises = async () => {
    setListing({ status: 'loading' });
    try {
      const res = await fetch('/api/sienge/enterprises', { cache: 'no-store' });
      const body = (await res.json().catch(() => ({}))) as { enterprises?: SiengeEnterprise[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? 'Não foi possível ler os empreendimentos do Sienge.');
      const list = body.enterprises ?? [];
      setListing({ status: 'ready', enterprises: list });
      const preset = siengeBuildingId ?? (work ? suggestEnterprise(work.name, list)?.id : undefined);
      setChoice(preset ? String(preset) : '');
    } catch (cause) {
      setListing({
        status: 'error',
        message: cause instanceof Error ? cause.message : 'Não foi possível ler os empreendimentos do Sienge.',
      });
    }
  };
  const persist = async (value: number | null, success: string) => {
    setBusy(true);
    setError('');
    try {
      await saveSiengeBuilding(value);
      toast({ title: success, tone: 'success' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível salvar.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel p-5" aria-labelledby="sienge-title">
      <div className="flex items-start gap-3">
        <Link2 size={18} className="mt-0.5 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 id="sienge-title" className="text-base font-bold text-slate-900">
            Orçamento do Sienge
          </h2>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="text-sm text-slate-500">O empreendimento do Sienge de onde a Linha de Balanço busca o orçamento desta obra.</p>
            <HelpNote title="Como funciona: orçamento do Sienge" compact>
              <p>
                Liga esta obra a um <strong>empreendimento do Sienge</strong>. Com a ligação feita, a visão Custos do longo prazo ganha o
                caminho <strong>Buscar do Sienge</strong>, que traz o orçamento para apropriar em cada pacote de serviço.
              </p>
              <p>
                No Sienge cada obra costuma ter dois empreendimentos, “(ADM)” e “(ENG)”: o orçamento da obra fica no <strong>ENG</strong>.
              </p>
              <p>O sistema só lê o Sienge: nada é alterado lá. Só o administrador escolhe ou troca o empreendimento.</p>
            </HelpNote>
          </div>

          <p className="mt-3 text-sm text-slate-700">
            {siengeBuildingId ? (
              <>
                Ligada ao empreendimento <strong className="tabular-nums">{siengeBuildingId}</strong>
                {linked && (
                  <>
                    {' '}
                    · <strong>{linked.name}</strong>
                  </>
                )}
                .
              </>
            ) : (
              <>Esta obra ainda não está ligada ao Sienge: o orçamento entra só por “Colar do orçamento”.</>
            )}
          </p>

          {state.status === 'error' && (
            <div className="mt-3">
              <Callout tone="danger" role="alert">
                Não foi possível ler a configuração. Atualize a página para tentar de novo.
              </Callout>
            </div>
          )}
          {state.status === 'ready' && !siengeAvailable && (
            <div className="mt-3">
              <Callout tone="warning">
                Para ligar a obra ao Sienge, aplique a migração <code>0057_sienge_link.sql</code> no Supabase.
              </Callout>
            </div>
          )}
          {!admin && state.status === 'ready' && siengeAvailable && (
            <p className="mt-2 text-xs text-slate-500">Só o administrador escolhe ou troca o empreendimento.</p>
          )}

          {admin && siengeAvailable && (
            <div className="mt-4 space-y-3">
              {listing.status !== 'ready' && (
                <button type="button" className="button-ghost" disabled={listing.status === 'loading'} onClick={loadEnterprises}>
                  {listing.status === 'loading'
                    ? 'Lendo os empreendimentos do Sienge…'
                    : siengeBuildingId
                      ? 'Trocar o empreendimento'
                      : 'Escolher o empreendimento'}
                </button>
              )}
              {listing.status === 'error' && (
                <Callout tone="danger" role="alert">
                  {listing.message}
                </Callout>
              )}
              {listing.status === 'ready' && (
                <form
                  className="flex flex-wrap items-end gap-3"
                  onSubmit={event => {
                    event.preventDefault();
                    const picked = enterprises.find(e => String(e.id) === choice);
                    if (picked) persist(picked.id, `Obra ligada ao empreendimento ${picked.id} · ${picked.name}.`);
                  }}
                >
                  <label className="min-w-64 flex-1 text-xs font-semibold text-slate-600">
                    Empreendimento do Sienge
                    <select className="field mt-1 block w-full" value={choice} onChange={event => setChoice(event.target.value)}>
                      <option value="">Escolha…</option>
                      {enterprises.map(e => (
                        <option key={e.id} value={e.id}>
                          {e.name} (código {e.id})
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="submit" className="button" disabled={busy || !choice || choice === String(siengeBuildingId ?? '')}>
                    {busy ? 'Salvando…' : 'Salvar'}
                  </button>
                  {siengeBuildingId && (
                    <button
                      type="button"
                      className="button-ghost"
                      disabled={busy}
                      onClick={() => {
                        setChoice('');
                        persist(null, 'Ligação com o Sienge desfeita. Os itens de custo já gravados continuam na obra.');
                      }}
                    >
                      Desfazer a ligação
                    </button>
                  )}
                </form>
              )}
              {suggestion && suggestion.id !== siengeBuildingId && (
                <p className="text-xs text-slate-500">
                  Pelo nome da obra, o empreendimento parece ser <strong>{suggestion.name}</strong> (código {suggestion.id}). Confira antes
                  de salvar.
                </p>
              )}
              {error && (
                <Callout tone="danger" role="alert">
                  {error}
                </Callout>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

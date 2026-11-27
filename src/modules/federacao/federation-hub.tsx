'use client';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { ArrowUpRight, Boxes, FolderOpen } from 'lucide-react';
import { usePlanning } from '@/modules/planejamento/planning-provider';
import { Callout, LoadState, Missing } from '@/modules/planejamento/ui';
import { HelpNote } from '@/modules/layout/help-note';
import { workPath } from '@/shared/format';
import type { OrcamentoModel, OrcamentoObra } from '@/domain/orcamento-models';
import { FederationOverview } from './federation-overview';
import { OrcamentoScene } from './orcamento/scene';

/**
 * Modelo federado, com duas fontes de modelos:
 *
 * - **Orçamento 4D**: os modelos que a obra já tem no Orçamento 4D (o mesmo banco), todos na cena de uma vez,
 *   com o visualizador de lá (liga/desliga, cor e opacidade por modelo, caixa de corte, medição, seleção);
 * - **Arquivos IFC do Obra 360**: os enviados em Arquivos IFC, com a escolha de versões e as composições
 *   salvas, como a tela sempre foi.
 *
 * A primeira é a que abre quando a obra tem modelos no Orçamento 4D; sem eles, a tela é só a segunda.
 */
type Source = 'orcamento' | 'arquivos';
type Catalog =
  { state: 'loading' } | { state: 'ready'; obra: OrcamentoObra | null; models: OrcamentoModel[] } | { state: 'error'; error: string };

export function FederationHub({ workId }: { workId: string }) {
  const context = usePlanning();
  const [catalog, setCatalog] = useState<Catalog>({ state: 'loading' });
  const [source, setSource] = useState<Source>();
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/ifc/orcamento?workId=${encodeURIComponent(workId)}`, { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        const body = (await response.json().catch(() => ({}))) as {
          obra?: OrcamentoObra | null;
          models?: OrcamentoModel[];
          error?: unknown;
        };
        if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Não foi possível consultar o Orçamento 4D.');
        setCatalog({ state: 'ready', obra: body.obra ?? null, models: body.models ?? [] });
      })
      .catch(cause => {
        if (!controller.signal.aborted)
          setCatalog({ state: 'error', error: cause instanceof Error ? cause.message : 'Não foi possível consultar o Orçamento 4D.' });
      });
    return () => controller.abort();
  }, [workId, retry]);

  if (context.state !== 'ready') return <LoadState error={context.state === 'error'} />;
  const { data } = context.planning;
  const work = data.works.find(candidate => candidate.id === workId);
  const actor = data.users.find(user => user.id === context.actorId);
  if (!work || !actor?.workIds.includes(workId)) return <Missing label="Obra não encontrada" />;
  if (catalog.state === 'loading') return <LoadState />;

  const models = catalog.state === 'ready' ? catalog.models : [];
  // Sem modelo no Orçamento 4D, a tela é a de sempre e a troca de fonte nem aparece.
  const offered = catalog.state === 'error' || models.length > 0;
  const active: Source = offered ? (source ?? (models.length > 0 ? 'orcamento' : 'arquivos')) : 'arquivos';
  const switcher = offered ? (
    <div
      data-tour="federado-fonte"
      role="group"
      aria-label="De onde vêm os modelos"
      className="mb-5 inline-flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1"
    >
      {(
        [
          ['orcamento', 'Modelos do Orçamento 4D', Boxes],
          ['arquivos', 'Arquivos IFC do Obra 360', FolderOpen],
        ] as const
      ).map(([value, label, Icon]) => (
        <button
          key={value}
          type="button"
          aria-pressed={active === value}
          onClick={() => setSource(value)}
          className={`inline-flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm font-semibold ${
            active === value ? 'bg-primary-soft text-primary-ink' : 'text-slate-600 hover:bg-slate-50'
          }`}
        >
          <Icon size={16} aria-hidden />
          {label}
          {value === 'orcamento' && models.length > 0 && <span className="text-xs font-normal text-slate-500">{models.length}</span>}
        </button>
      ))}
    </div>
  ) : null;

  if (active === 'arquivos') return <FederationOverview workId={workId} sourceSwitch={switcher} />;

  const elements = models.reduce((sum, model) => sum + model.elements, 0);
  const megabytes = models.reduce((sum, model) => sum + model.byteSize, 0) / 1048576;
  return (
    <div className="federation-page">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="eyebrow">
            Apoio · {work.code} · {work.name}
          </p>
          <h1 className="page-title">Modelo federado</h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="text-sm text-slate-500">Os modelos IFC da obra numa mesma cena, para análise virtual dos projetos.</p>
            <span data-tour="federado-ajuda" className="inline-flex">
              <HelpNote compact title="Como funciona: modelos do Orçamento 4D">
                <p>
                  Aqui entram, de uma vez, todos os modelos que a obra tem no Orçamento 4D, sempre na revisão atual de lá. Nada é copiado:
                  quando um IFC é reenviado no Orçamento 4D, a revisão nova aparece aqui ao reabrir a tela.
                </p>
                <p>
                  Em Modelos, a caixa de cada disciplina liga e desliga, o quadrado troca a cor e a barra ajusta a opacidade. Caixa de corte
                  recorta o prédio pelas faces; Medir tira a distância entre dois pontos; o clique numa peça mostra os dados dela.
                </p>
                <p>
                  Cor, opacidade e disciplinas desligadas ficam guardadas neste navegador. São só de visualização: não mudam nada no
                  Orçamento 4D nem para outras pessoas.
                </p>
              </HelpNote>
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link className="button-ghost min-h-10" href={workPath(workId, 'ifc')}>
            Arquivos IFC <ArrowUpRight size={16} aria-hidden />
          </Link>
        </div>
      </header>
      {switcher}
      {catalog.state === 'error' ? (
        <div className="panel p-4">
          <Callout tone="warning" role="alert">
            {catalog.error}
          </Callout>
          <button
            type="button"
            className="button-ghost mt-3"
            onClick={() => {
              setCatalog({ state: 'loading' });
              setRetry(value => value + 1);
            }}
          >
            Tentar novamente
          </button>
        </div>
      ) : (
        <FederationSection>
          <p className="border-b border-slate-100 px-4 py-2 text-xs text-slate-500" role="status">
            {models.length} modelos · {elements.toLocaleString('pt-BR')} elementos
            {megabytes >= 1 &&
              ` · ${Math.round(megabytes).toLocaleString('pt-BR')} MB de geometria (fica guardada neste navegador depois da primeira vez)`}
          </p>
          <div className="h-[calc(100dvh-21rem)] min-h-[520px]">
            <OrcamentoScene key={workId} workId={workId} models={models} />
          </div>
        </FederationSection>
      )}
    </div>
  );
}

function FederationSection({ children }: { children: ReactNode }) {
  return (
    <section className="panel min-w-0 overflow-hidden" aria-label="Modelos do Orçamento 4D em 3D">
      {children}
    </section>
  );
}

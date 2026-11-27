'use client';
import './visualizador.css';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type * as ThreeNS from 'three';
import { BoxSelect, ChevronDown, ChevronRight, Crosshair, Focus, Maximize2, RotateCcw, Ruler, Trash2, X } from 'lucide-react';
import type { OrcamentoElement, OrcamentoModel } from '@/domain/orcamento-models';
import { downloadGeometry, inParallel } from './geometry';
import { CORES_ENCAIXE, formatarMetros, type EstadoMedicao } from './medicao-regras';
import type { EstiloModelo, ModoOcultos, Visualizador } from './visualizador';

/**
 * Todos os modelos do Orçamento 4D da obra na mesma cena, com o painel de modelos (liga/desliga, cor e
 * opacidade), a caixa de corte, a medição e a seleção de elementos. Veio do Orçamento 4D
 * (app/src/components/Viewer3D.tsx); a diferença é de onde saem os dados: lá o navegador fala com o banco,
 * aqui tudo passa pelas rotas `/api/ifc/orcamento`, que conferem o acesso do Obra 360.
 */

type Selection = { modeloId: string; expressId: number };

// Cor, opacidade e modo das desmarcadas ficam só no navegador de cada pessoa (preferência de visualização).
const styleKey = (modelId: string) => `obra360:federado:estilo:${modelId}`;
function readStyle(modelId: string): EstiloModelo | null {
  try {
    const value = localStorage.getItem(styleKey(modelId));
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<EstiloModelo>;
    const opacidade = Number(parsed.opacidade);
    return {
      cor: typeof parsed.cor === 'string' && /^#[0-9a-f]{6}$/i.test(parsed.cor) ? parsed.cor : null,
      opacidade: Number.isFinite(opacidade) ? Math.min(1, Math.max(0.1, opacidade)) : 1,
    };
  } catch {
    return null;
  }
}
function writeStyle(modelId: string, style: EstiloModelo | null) {
  try {
    if (style) localStorage.setItem(styleKey(modelId), JSON.stringify(style));
    else localStorage.removeItem(styleKey(modelId));
  } catch {
    /* sem armazenamento: vale só nesta sessão */
  }
}
const NO_STYLE: EstiloModelo = { cor: null, opacidade: 1 };

const HIDDEN_MODE_KEY = 'obra360:federado:ocultos';
function readHiddenMode(): ModoOcultos {
  try {
    return localStorage.getItem(HIDDEN_MODE_KEY) === 'oculto' ? 'oculto' : 'transparente';
  } catch {
    return 'transparente';
  }
}
const NO_MEASURES: EstadoMedicao = { medidas: [], emAndamento: false };

/** Modelos baixados e abertos ao mesmo tempo (cada um ocupa um worker do Fragments). */
const MODELS_IN_PARALLEL = 3;

interface Box {
  min: [number, number, number];
  max: [number, number, number];
}
const fromBox = (box: ThreeNS.Box3): Box => ({ min: box.min.toArray(), max: box.max.toArray() });
// Y é a altura no 3D (Fragments/three.js)
const AXES = [
  { i: 1, name: 'Altura', color: '#22c55e' },
  { i: 0, name: 'Comprimento', color: '#ef4444' },
  { i: 2, name: 'Largura', color: '#2563eb' },
] as const;
const meters = (value: number) => value.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function OrcamentoScene({ workId, models }: { workId: string; models: OrcamentoModel[] }) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<Visualizador | null>(null);
  const three = useRef<typeof ThreeNS | null>(null);
  const loadedRevision = useRef(new Map<string, string>());
  const [ready, setReady] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [loading, setLoading] = useState<{ done: number; total: number } | null>(null);
  const [downloading, setDownloading] = useState('');
  const [error, setError] = useState('');
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [styles, setStyles] = useState<Record<string, EstiloModelo>>({});
  // com muitas disciplinas o painel cobriria o modelo: começa recolhido
  const [panelOpen, setPanelOpen] = useState<boolean | null>(null);
  const open = panelOpen ?? models.length <= 4;
  // caixa de corte: limites dos modelos e caixa atual (referencial da caixa, em metros)
  const [limits, setLimits] = useState<Box | null>(null);
  const [cut, setCut] = useState<Box | null>(null);
  const [cutOpen, setCutOpen] = useState(false);
  const [noSelection, setNoSelection] = useState(false);
  // alinhando a caixa aos eixos do prédio (lê a geometria das paredes)
  const [preparingCut, setPreparingCut] = useState(false);
  const [hiddenMode, setHiddenMode] = useState<ModoOcultos>('transparente');
  const [measuring, setMeasuring] = useState(false);
  const [measures, setMeasures] = useState<EstadoMedicao>(NO_MEASURES);
  const [selected, setSelected] = useState<Selection | null>(null);

  const withGeometry = models.filter(model => model.parts > 0);
  const empty = withGeometry.length === 0;

  useEffect(() => {
    let stopped = false;
    let created: Visualizador | undefined;
    const revisions = loadedRevision.current;
    // three e o That Open só entram no navegador, e só quando a cena é aberta
    void Promise.all([import('./visualizador'), import('three')])
      .then(([module, threeModule]) => {
        if (stopped || !host.current) return;
        try {
          created = new module.Visualizador(host.current);
        } catch {
          setUnsupported(true);
          return;
        }
        created.onSelecionar = setSelected;
        created.onCorteAlterado = box => setCut(box ? fromBox(box) : null);
        created.onMedidas = setMeasures;
        const mode = readHiddenMode();
        setHiddenMode(mode);
        void created.setModoOcultos(mode).catch(cause => setError(message(cause)));
        three.current = threeModule;
        viewer.current = created;
        setReady(true);
      })
      .catch(() => {
        if (!stopped) setError('Não foi possível iniciar o visualizador. Recarregue a página.');
      });
    return () => {
      stopped = true;
      created?.dispose();
      viewer.current = null;
      revisions.clear();
      setReady(false);
    };
  }, []);

  // carrega/descarrega conforme a lista: a revisão e as partes na chave trazem a geometria nova sem recarregar a página
  const modelsKey = withGeometry.map(model => `${model.id}:${model.revision}:${model.parts}`).join('|');
  useEffect(() => {
    const view = viewer.current;
    if (!ready || !view) return;
    const controller = new AbortController();
    let stopped = false;
    void (async () => {
      const ids = new Set(withGeometry.map(model => model.id));
      for (const id of view.modelosCarregados()) if (!ids.has(id)) await view.remover(id);
      const first = view.modelosCarregados().length === 0;
      const pending: { model: OrcamentoModel; revision: string }[] = [];
      for (const model of withGeometry) {
        const revision = `${model.revision}:${model.parts}`;
        if (view.modelosCarregados().includes(model.id)) {
          if (loadedRevision.current.get(model.id) === revision) continue;
          await view.remover(model.id); // revisão nova do mesmo modelo
        }
        pending.push({ model, revision });
      }
      if (!pending.length || stopped) return;
      let done = 0;
      setLoading({ done, total: pending.length });
      // lê do cache do navegador e abre vários modelos de uma vez; o viewer aplica estilo e visibilidade a cada um assim que chega
      await inParallel(pending, MODELS_IN_PARALLEL, async ({ model, revision }) => {
        if (stopped) return;
        try {
          const bytes = await downloadGeometry(workId, model, controller.signal, fraction => {
            if (!stopped) setDownloading(`${model.discipline} ${Math.round(fraction * 100)}%`);
          });
          if (stopped) return;
          const saved = readStyle(model.id);
          if (saved) {
            setStyles(current => ({ ...current, [model.id]: saved }));
            await view.setEstiloModelo(model.id, saved);
          }
          await view.carregar(model.id, bytes);
          loadedRevision.current.set(model.id, revision);
          // guarda-corpos, escadas...: o clique numa peça seleciona o conjunto
          const query = new URLSearchParams({ workId, modeloId: model.id });
          void fetch(`/api/ifc/orcamento/conjuntos?${query}`, { cache: 'no-store', signal: controller.signal })
            .then(response => (response.ok ? (response.json() as Promise<{ pairs?: [number, number][] }>) : { pairs: [] }))
            .then(body => {
              if (!stopped && body.pairs?.length) return view.setConjuntos(model.id, body.pairs);
            })
            .catch(() => undefined); // sem os conjuntos, o clique seleciona a peça
        } catch (cause) {
          if (!stopped) setError(`${model.discipline}: ${message(cause)}`);
        } finally {
          done++;
          if (!stopped) setLoading({ done, total: pending.length });
        }
      });
      if (stopped) return;
      setLoading(null);
      setDownloading('');
      // modelos novos podem aumentar a área disponível para a caixa de corte (calculada só com ela ligada)
      if (view.caixaCorte()) {
        const next = await view.limitesDoCorte();
        if (!stopped && next) setLimits(fromBox(next));
      }
      if (first) await view.enquadrarTudo();
    })().catch(cause => {
      if (!stopped) setError(message(cause));
    });
    return () => {
      stopped = true;
      controller.abort();
    };
    // a lista é descrita por `modelsKey`: o mesmo conjunto em outro array não recarrega nada
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelsKey, ready, workId]);

  const report = (cause: unknown) => setError(message(cause));

  const changeStyle = (id: string, patch: Partial<EstiloModelo>) => {
    const next = { ...(styles[id] ?? NO_STYLE), ...patch };
    const plain = !next.cor && next.opacidade >= 1;
    setStyles(current => ({ ...current, [id]: next }));
    writeStyle(id, plain ? null : next);
    viewer.current?.setEstiloModelo(id, plain ? null : next).catch(report);
  };

  const reset = () => {
    for (const model of models) writeStyle(model.id, null);
    setStyles({});
    setVisible({});
    viewer.current?.resetarEstilos().catch(report);
  };

  const toggle = (id: string) => {
    const next = !(visible[id] ?? true);
    setVisible(current => ({ ...current, [id]: next }));
    viewer.current?.setVisivelModelo(id, next).catch(report);
  };

  const changeHiddenMode = (mode: ModoOcultos) => {
    setHiddenMode(mode);
    try {
      localStorage.setItem(HIDDEN_MODE_KEY, mode);
    } catch {
      /* vale só nesta sessão */
    }
    viewer.current?.setModoOcultos(mode).catch(report);
  };

  const applyCut = (box: Box | null) => {
    const api = three.current;
    setCut(box);
    if (!api) return;
    viewer.current?.setCaixaCorte(box ? new api.Box3(new api.Vector3(...box.min), new api.Vector3(...box.max)) : null);
  };
  /** Limites no referencial da caixa (girada com o prédio); na primeira vez lê a geometria, o que leva um instante. */
  const prepareLimits = async () => {
    const view = viewer.current;
    if (!view) return null;
    setPreparingCut(true);
    try {
      return await view.limitesDoCorte();
    } finally {
      if (viewer.current === view) setPreparingCut(false);
    }
  };
  const turnCutOn = async () => {
    const next = await prepareLimits().catch(cause => {
      report(cause);
      return null;
    });
    if (!next) return;
    setLimits(fromBox(next));
    // no celular o painel aberto cobriria o 3D: começa recolhido (as alças continuam no modelo)
    setCutOpen(window.innerWidth > 900);
    applyCut(fromBox(next));
  };
  const fitToSelection = async () => {
    const view = viewer.current;
    const next = await prepareLimits().catch(cause => {
      report(cause);
      return null;
    });
    const box = await view?.caixaDaSelecao().catch(() => null);
    setNoSelection(!box);
    if (!box || !next) return;
    setLimits(fromBox(next));
    applyCut(fromBox(box.intersect(next)));
  };
  const changeRange = (axis: number, from: number, to: number) => {
    if (!cut) return;
    const next: Box = { min: [...cut.min], max: [...cut.max] };
    next.min[axis] = from;
    next.max[axis] = to;
    applyCut(next);
  };

  const turnMeasuring = (on: boolean) => {
    setMeasuring(on);
    viewer.current?.setMedicao(on);
  };

  const clearSelection = () => {
    setSelected(null);
    viewer.current?.selecionar(null).catch(report);
  };

  const idle = !ready || empty;
  return (
    <div className="f3d h-full w-full" data-tour="federado-cena">
      <div
        ref={host}
        className="f3d-canvas"
        role="img"
        aria-label="Modelo federado em 3D. Arraste para orbitar, role para aproximar e clique numa peça para ver os dados dela."
      />
      {unsupported && <div className="f3d-vazio">WebGL não está disponível neste navegador: o modelo 3D não pode ser exibido.</div>}
      {!unsupported && ready && empty && (
        <div className="f3d-vazio">Os modelos desta obra ainda não têm geometria gravada no Orçamento 4D.</div>
      )}
      <div className="f3d-esquerda">
        <div className="f3d-painel f3d-modelos" data-tour="federado-modelos">
          <button type="button" className="f3d-titulo" aria-expanded={open} onClick={() => setPanelOpen(!open)}>
            {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
            <strong>Modelos</strong> <span className="f3d-meta">{models.length}</span>
          </button>
          {open &&
            models.map(model => {
              const style = styles[model.id] ?? NO_STYLE;
              const shown = visible[model.id] ?? true;
              const missing = model.parts === 0;
              const percent = Math.round(style.opacidade * 100);
              return (
                <div key={model.id} className={`f3d-camada ${missing ? 'sem-geometria' : ''}`}>
                  <label
                    title={`${model.discipline} — ${model.file}${
                      missing
                        ? ' (sem geometria no Orçamento 4D)'
                        : shown
                          ? ''
                          : hiddenMode === 'oculto'
                            ? ' (oculta, não clicável)'
                            : ' (transparente, não clicável)'
                    }`}
                  >
                    <input type="checkbox" checked={shown && !missing} disabled={missing} onChange={() => toggle(model.id)} />
                    <span className="f3d-camada-nome">{model.discipline}</span>
                  </label>
                  <input
                    type="color"
                    value={style.cor ?? '#cbd5e1'}
                    title="Cor do modelo"
                    aria-label={`Cor de ${model.discipline}`}
                    disabled={missing}
                    className={style.cor ? '' : 'sem-cor'}
                    onChange={event => changeStyle(model.id, { cor: event.target.value })}
                  />
                  <input
                    type="range"
                    min={0.1}
                    max={1}
                    step={0.05}
                    value={style.opacidade}
                    disabled={missing}
                    aria-label={`Opacidade de ${model.discipline}`}
                    title={`Opacidade ${percent}%${style.opacidade < 1 ? ' (o clique atravessa para o que está opaco atrás)' : ''}`}
                    onChange={event => changeStyle(model.id, { opacidade: Number(event.target.value) })}
                  />
                  <span className="f3d-meta f3d-pct">{percent}%</span>
                </div>
              );
            })}
          {models.length === 0 && <span className="f3d-meta">Nenhum modelo pronto</span>}
          {open && models.length > 0 && (
            <label
              className="f3d-opcao"
              title="Desmarcada, a disciplina não pega o clique: dá para selecionar o que está embutido nela (eletroduto na parede, por exemplo). Com a opacidade abaixo de 100%, o clique também a atravessa quando há algo opaco atrás."
            >
              <input
                type="checkbox"
                checked={hiddenMode === 'oculto'}
                onChange={event => changeHiddenMode(event.target.checked ? 'oculto' : 'transparente')}
              />
              <span>Desmarcadas somem em vez de ficar transparentes</span>
            </label>
          )}
          {open && (
            <div className="f3d-acoes">
              <button type="button" disabled={idle} onClick={() => void viewer.current?.recentralizar()}>
                Enquadrar tudo
              </button>
              <button type="button" disabled={idle} onClick={reset} title="Volta cores, opacidade e visibilidade ao original">
                <RotateCcw size={13} aria-hidden /> Resetar
              </button>
            </div>
          )}
        </div>

        <div className={`f3d-painel f3d-corte ${cut ? 'ativo' : ''}`} data-tour="federado-corte">
          <div className="f3d-linha-titulo">
            <button
              type="button"
              className="f3d-titulo"
              onClick={() => (cut ? setCutOpen(!cutOpen) : void turnCutOn())}
              disabled={!cut && (idle || preparingCut)}
              title="Recorta o modelo por uma caixa alinhada às paredes do prédio: arraste as bolinhas nas faces ou use as barras"
            >
              {cut ? (
                cutOpen ? (
                  <ChevronDown size={14} aria-hidden />
                ) : (
                  <ChevronRight size={14} aria-hidden />
                )
              ) : (
                <BoxSelect size={14} aria-hidden />
              )}
              <strong>Caixa de corte</strong>
            </button>
            <label className="f3d-chave" title={cut ? 'Desligar a caixa de corte' : 'Ligar a caixa de corte'}>
              <input
                type="checkbox"
                aria-label="Caixa de corte"
                checked={!!cut}
                disabled={idle || preparingCut}
                onChange={event => {
                  if (event.target.checked) void turnCutOn();
                  else {
                    applyCut(null);
                    setCutOpen(false);
                  }
                }}
              />
            </label>
          </div>
          {preparingCut && <span className="f3d-meta f3d-dica">Alinhando a caixa às paredes do prédio…</span>}
          {cut && cutOpen && limits && (
            <>
              {AXES.map(({ i, name, color }) => {
                const low = limits.min[i],
                  high = limits.max[i];
                const step = Math.max((high - low) / 400, 0.01);
                return (
                  <div key={i} className="f3d-eixo">
                    <div className="f3d-eixo-rotulo">
                      <span>
                        <i style={{ background: color }} />
                        {name}
                      </span>
                      <span className="f3d-meta">
                        {meters(cut.min[i] - low)} a {meters(cut.max[i] - low)} m
                      </span>
                    </div>
                    <div className="f3d-faixa" style={{ '--cor': color } as CSSProperties}>
                      <div
                        className="f3d-faixa-trilho"
                        style={{
                          left: `${((cut.min[i] - low) / (high - low || 1)) * 100}%`,
                          right: `${100 - ((cut.max[i] - low) / (high - low || 1)) * 100}%`,
                        }}
                      />
                      <input
                        type="range"
                        min={low}
                        max={high}
                        step={step}
                        value={cut.min[i]}
                        aria-label={`${name}: início`}
                        onChange={event => changeRange(i, Math.min(Number(event.target.value), cut.max[i] - step), cut.max[i])}
                      />
                      <input
                        type="range"
                        min={low}
                        max={high}
                        step={step}
                        value={cut.max[i]}
                        aria-label={`${name}: fim`}
                        onChange={event => changeRange(i, cut.min[i], Math.max(Number(event.target.value), cut.min[i] + step))}
                      />
                    </div>
                  </div>
                );
              })}
              <div className="f3d-acoes">
                <button type="button" onClick={() => void fitToSelection()} title="Caixa em volta do elemento selecionado no 3D">
                  <Crosshair size={13} aria-hidden /> Ajustar à seleção
                </button>
                <button type="button" onClick={() => applyCut(limits)} title="Volta a caixa ao tamanho do modelo">
                  <Maximize2 size={13} aria-hidden /> Modelo inteiro
                </button>
              </div>
              {noSelection && <span className="f3d-meta f3d-dica">Clique numa peça do 3D para ajustar a caixa a ela.</span>}
              <span className="f3d-meta f3d-dica so-largo">Arraste as bolinhas nas faces da caixa para cortar direto no 3D.</span>
            </>
          )}
        </div>

        <div className={`f3d-painel f3d-medicao ${measuring ? 'ativo' : ''}`} data-tour="federado-medir">
          <div className="f3d-linha-titulo">
            <button
              type="button"
              className="f3d-titulo"
              onClick={() => turnMeasuring(!measuring)}
              disabled={!measuring && idle}
              title="Mede a distância entre dois pontos do modelo, encaixando em vértices e arestas"
            >
              <Ruler size={14} aria-hidden />
              <strong>Medir</strong>
              {measures.medidas.length > 0 && <span className="f3d-meta">{measures.medidas.length}</span>}
            </button>
            <label className="f3d-chave" title={measuring ? 'Desligar a medição (apaga as medidas)' : 'Ligar a medição'}>
              <input
                type="checkbox"
                aria-label="Medir"
                checked={measuring}
                disabled={!measuring && idle}
                onChange={event => turnMeasuring(event.target.checked)}
              />
            </label>
          </div>
          {measuring && (
            <>
              <span className="f3d-meta f3d-dica">
                {measures.emAndamento ? 'Clique no segundo ponto. Esc cancela.' : 'Clique em dois pontos do modelo.'}
              </span>
              <span className="f3d-legenda">
                <span>
                  <i style={{ background: CORES_ENCAIXE.vertice }} />
                  vértice
                </span>
                <span>
                  <i style={{ background: CORES_ENCAIXE.aresta }} />
                  aresta
                </span>
                <span>
                  <i style={{ background: CORES_ENCAIXE.face }} />
                  superfície
                </span>
              </span>
              {measures.medidas.map((measure, index) => (
                <div key={measure.id} className="f3d-medida">
                  <span className="f3d-meta">{index + 1}</span>
                  <b>{formatarMetros(measure.distancia)}</b>
                  <span className="f3d-meta" title="Horizontal (no plano do piso) e vertical (diferença de altura)">
                    H {formatarMetros(measure.horizontal)} · V {formatarMetros(measure.vertical)}
                  </span>
                  <button
                    type="button"
                    onClick={() => viewer.current?.removerMedida(measure.id)}
                    title="Apagar esta medida"
                    aria-label={`Apagar a medida ${index + 1}`}
                  >
                    <X size={12} aria-hidden />
                  </button>
                </div>
              ))}
              {measures.medidas.length > 0 && (
                <div className="f3d-acoes">
                  <button type="button" onClick={() => viewer.current?.limparMedidas()}>
                    <Trash2 size={13} aria-hidden /> Limpar medidas
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {selected && <ElementPanel workId={workId} selection={selected} models={models} onClose={clearSelection} />}

      <button
        type="button"
        className="f3d-flutuante"
        data-tour="federado-recentralizar"
        onClick={() => void viewer.current?.recentralizar()}
        disabled={idle}
        title={cut ? 'Recentralizar na caixa de corte' : 'Recentralizar: enquadra todos os modelos visíveis'}
        aria-label="Recentralizar a vista"
      >
        <Focus size={18} aria-hidden />
      </button>
      <div className="f3d-avisos">
        {loading && (
          <div className="f3d-status" role="status">
            Carregando modelos {loading.done}/{loading.total}…{downloading && <span className="f3d-meta"> {downloading}</span>}
          </div>
        )}
        {error && (
          <div className="f3d-status erro" role="alert">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

const quantity = (value: number) => value.toLocaleString('pt-BR', { maximumFractionDigits: 3 });

/** Dados do elemento clicado no 3D: identificação, quantitativos e propriedades. */
function ElementPanel({
  workId,
  selection,
  models,
  onClose,
}: {
  workId: string;
  selection: Selection;
  models: OrcamentoModel[];
  onClose: () => void;
}) {
  const [state, setState] = useState<{ key: string; element?: OrcamentoElement | null; error?: string }>({ key: '' });
  const [tab, setTab] = useState<'qtd' | 'props'>('qtd');
  const key = `${selection.modeloId}:${selection.expressId}`;
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ workId, modeloId: selection.modeloId, expressId: String(selection.expressId) });
    fetch(`/api/ifc/orcamento/elemento?${query}`, { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        const body = (await response.json().catch(() => ({}))) as { element?: OrcamentoElement | null; error?: unknown };
        if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Não foi possível ler o elemento.');
        setState({ key, element: body.element ?? null });
      })
      .catch(cause => {
        if (!controller.signal.aborted) setState({ key, error: message(cause) });
      });
    return () => controller.abort();
  }, [workId, selection.modeloId, selection.expressId, key]);

  // a resposta de uma seleção anterior não aparece sob o elemento novo
  const current = state.key === key ? state : { key };
  const element = current.element;
  const model = models.find(candidate => candidate.id === selection.modeloId);
  const properties = element ? Object.entries(element.properties).sort(([a], [b]) => a.localeCompare(b, 'pt-BR')) : [];
  const ifcQuantities = element ? Object.entries(element.ifcQuantities) : [];
  const geometryQuantities = element ? Object.entries(element.geometryQuantities) : [];
  return (
    <aside className="f3d-elemento" data-tour="federado-elemento" aria-label="Dados do elemento selecionado">
      <div className="f3d-elemento-cabecalho">
        <strong>{element?.name || `#${selection.expressId}`}</strong>
        <button type="button" onClick={onClose} aria-label="Fechar e limpar a seleção" title="Fechar">
          <X size={16} aria-hidden />
        </button>
      </div>
      {model && (
        <p className="f3d-meta">
          {model.discipline} · {model.file}
        </p>
      )}
      {current.error && (
        <p className="f3d-meta" role="alert">
          {current.error}
        </p>
      )}
      {element === undefined && !current.error && <p className="f3d-meta">Lendo os dados…</p>}
      {element === null && <p className="f3d-meta">Elemento sem registro no banco (por exemplo, geometria auxiliar do arquivo).</p>}
      {element && (
        <>
          <p className="f3d-meta">{[element.ifcClass, element.typeName, element.storey || 'sem pavimento'].filter(Boolean).join(' · ')}</p>
          {element.materials.length > 0 && <p className="f3d-meta">Material: {element.materials.join(', ')}</p>}
          {element.classifications.length > 0 && <p className="f3d-meta">Classificação: {element.classifications.join(', ')}</p>}
          {element.globalId && (
            <p className="f3d-meta">
              GlobalId: <span className="f3d-guid">{element.globalId}</span>
            </p>
          )}
          <div className="f3d-abas">
            <button type="button" className={tab === 'qtd' ? 'ativa' : ''} aria-pressed={tab === 'qtd'} onClick={() => setTab('qtd')}>
              Quantitativos
            </button>
            <button type="button" className={tab === 'props' ? 'ativa' : ''} aria-pressed={tab === 'props'} onClick={() => setTab('props')}>
              Propriedades ({properties.length})
            </button>
          </div>
          <table className="f3d-tabela">
            <tbody>
              {tab === 'qtd' ? (
                <>
                  {ifcQuantities.map(([name, value]) => (
                    <tr key={`ifc-${name}`}>
                      <td>{name}</td>
                      <td className="num">{quantity(value)}</td>
                      <td>
                        <span className="f3d-selo">IFC</span>
                      </td>
                    </tr>
                  ))}
                  {geometryQuantities.map(([name, value]) => (
                    <tr key={`geo-${name}`}>
                      <td>{name}</td>
                      <td className="num">{quantity(value)}</td>
                      <td>
                        <span className="f3d-selo geometria">geometria</span>
                      </td>
                    </tr>
                  ))}
                  {ifcQuantities.length + geometryQuantities.length === 0 && (
                    <tr>
                      <td className="f3d-meta">Sem quantitativos neste elemento.</td>
                    </tr>
                  )}
                </>
              ) : (
                <>
                  {properties.map(([name, value]) => (
                    <tr key={name}>
                      <td>{name}</td>
                      <td>{String(value)}</td>
                    </tr>
                  ))}
                  {properties.length === 0 && (
                    <tr>
                      <td className="f3d-meta">Sem propriedades neste elemento.</td>
                    </tr>
                  )}
                </>
              )}
            </tbody>
          </table>
        </>
      )}
    </aside>
  );
}

import * as THREE from 'three';
import * as OBC from '@thatopen/components';
import * as FRAGS from '@thatopen/fragments';
import { materialSemCorte, Medicoes } from './medicao';
import { escolherEncaixe, type CandidatoEncaixe, type Encaixe, type EstadoMedicao } from './medicao-regras';
import { adicionarFaces, amostrar, giroDaCaixa, HistogramaDirecoes } from './orientacao';

const VERTICAL = new THREE.Vector3(0, 1, 0);
/** quantas peças (no total, entre os modelos) entram no cálculo do giro do prédio */
const AMOSTRA_GIRO = 600;

/** modeloId (uuid de orcamento.modelos_ifc) → express_ids */
export type MapaElementos = Record<string, Set<number>>;

export interface EstiloModelo {
  cor: string | null;
  opacidade: number;
}

/** Disciplina desmarcada no painel: só o vulto, para dar a referência de onde estão paredes e lajes. */
const VULTO: FRAGS.MaterialDefinition = {
  color: new THREE.Color('#b6c2d2'),
  renderedFaces: FRAGS.RenderedFaces.TWO,
  opacity: 0.08,
  transparent: true,
  _explicitProps: ['color', 'opacity', 'transparent'],
};

/**
 * O que acontece com a disciplina desmarcada: fica como vulto transparente (padrão) ou some por completo.
 * Nos dois casos ela não é clicável: o clique atravessa e pega o que está atrás (eletroduto dentro da parede).
 * Disciplina marcada mas com a opacidade reduzida também deixa o clique passar quando há algo opaco atrás.
 */
export type ModoOcultos = 'transparente' | 'oculto';

// _explicitProps: sem isso o Fragments mantém a cor/opacidade já aplicadas ao modelo
// (setColor/setOpacity) e a seleção não apareceria sobre um modelo colorido ou transparente.
const COR_SELECAO: FRAGS.MaterialDefinition = {
  color: new THREE.Color('#2563eb'),
  renderedFaces: FRAGS.RenderedFaces.TWO,
  opacity: 1,
  transparent: false,
  _explicitProps: ['color', 'opacity', 'transparent'],
};
const VAZIO: ReadonlySet<number> = new Set();

/**
 * Conjuntos de um modelo (IfcRelAggregates): guarda-corpo → barras e corrimão, escada → lances e degraus,
 * fachada-cortina → painéis. O conjunto muitas vezes não tem geometria própria; o 3D desenha as peças. Vem de
 * orcamento.elementos_ifc.conjunto_express_id (o arquivo do 3D não guarda as relações do IFC).
 */
export interface Conjuntos {
  /** conjunto → peças */
  pecas: Map<number, number[]>;
  /** peça → conjunto mais alto a que pertence */
  conjuntoDe: Map<number, number>;
}

/** Monta os conjuntos a partir dos pares [peça, conjunto]. */
export function conjuntosDePares(pares: Iterable<readonly [number, number]>): Conjuntos {
  const pecas = new Map<number, number[]>(),
    conjuntoDe = new Map<number, number>();
  for (const [peca, conjunto] of pares) {
    const l = pecas.get(conjunto);
    if (l) l.push(peca);
    else pecas.set(conjunto, [peca]);
    conjuntoDe.set(peca, conjunto);
  }
  return { pecas, conjuntoDe };
}

/**
 * Cena 3D com todos os modelos da obra (That Open Components + Fragments).
 * Todos os modelos compartilham o sistema de coordenadas do primeiro carregado,
 * preservando o posicionamento relativo entre disciplinas.
 *
 * Veio do Orçamento 4D (app/src/viewer/Visualizador.ts), sem o que é só de lá: linha do tempo 5D, cores da
 * Claudia e destaque do item da EAP. Os nomes ficaram em português, como no original, para as duas cópias
 * poderem ser comparadas.
 *
 * A tela descreve o estado desejado (estilo por modelo, seleção) e o viewer aplica só a diferença em relação
 * ao que já está pintado. Cor/opacidade do modelo e seleção usam o mesmo mecanismo de "highlight" do
 * Fragments: limpar um elemento apaga tudo nele, por isso quem perde a seleção recebe de volta o estilo do
 * modelo.
 */
export class Visualizador {
  private components = new OBC.Components();
  private world: OBC.SimpleWorld<OBC.SimpleScene, OBC.OrthoPerspectiveCamera, OBC.SimpleRenderer>;
  private fragments: OBC.FragmentsManager;
  // operações assíncronas podem terminar depois do dispose (troca de tela): viram no-op
  private descartado = false;
  onSelecionar?: (sel: { modeloId: string; expressId: number } | null) => void;

  // --- estado desejado (definido pelas telas)
  private estilos = new Map<string, EstiloModelo>();
  /** disciplinas desmarcadas no painel de modelos */
  private ocultos = new Set<string>();
  private modoOcultos: ModoOcultos = 'transparente';
  private selecaoAtual: MapaElementos = {};
  private materiaisParciais = new Map<string, FRAGS.MaterialDefinition | null>();
  /** conjuntos (guarda-corpo, escada...) de cada modelo carregado */
  private conjuntos = new Map<string, Conjuntos>();

  // --- estado aplicado, por modelo
  private pintadoSelecao = new Map<string, Set<number>>();
  /** modelos pintados como vulto na última repintura completa */
  private vultoPintado = new Set<string>();

  private container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
    const worlds = this.components.get(OBC.Worlds);
    this.world = worlds.create<OBC.SimpleScene, OBC.OrthoPerspectiveCamera, OBC.SimpleRenderer>();
    this.world.scene = new OBC.SimpleScene(this.components);
    this.world.scene.setup();
    this.world.scene.three.background = null;
    const renderer = new OBC.SimpleRenderer(this.components, container);
    this.world.renderer = renderer;
    this.world.camera = new OBC.OrthoPerspectiveCamera(this.components);
    this.components.init();
    this.components.get(OBC.Grids).create(this.world);

    this.fragments = this.components.get(OBC.FragmentsManager);
    // o worker é servido pelo próprio app (public/fragments/, copiado no pré-build): a versão casa com a do pacote
    this.fragments.init('/fragments/worker.mjs');

    this.world.camera.controls.addEventListener('update', () => this.fragments.core.update());
    this.fragments.list.onItemSet.add(({ value: model }) => {
      model.useCamera(this.world.camera.three);
      // o worker usa os planos para descartar o que está fora da caixa de corte (desenho e clique)
      model.getClippingPlanesEvent = () => (this.corte ? this.planosCorte : []);
      this.world.scene.three.add(model.object);
      this.fragments.core.update(true);
    });
    // evita z-fighting entre disciplinas sobrepostas
    this.fragments.core.models.materials.list.onItemSet.add(({ value: material }) => {
      if (!('isLodMaterial' in material && material.isLodMaterial)) {
        material.polygonOffset = true;
        material.polygonOffsetUnits = 1;
        material.polygonOffsetFactor = Math.random();
      }
    });

    container.addEventListener('pointerdown', this.aoPressionar);
    container.addEventListener('click', this.aoClicar);
    // captura: a alça da caixa de corte precisa receber o arrasto antes dos controles da câmera
    container.addEventListener('pointerdown', this.aoPressionarAlca, { capture: true });
    container.addEventListener('pointermove', this.aoPassarSobreAlca);
    this.world.camera.controls.addEventListener('update', this.ajustarTamanhoAlcas);
    this.grupoCorte.visible = false;
    this.world.scene.three.add(this.grupoCorte);
    this.montarGrupoCorte();

    this.medicoes = new Medicoes(this.world.scene.three, () => this.world.camera.three, container);
    renderer.onBeforeUpdate.add(() => this.medicoes.atualizar(container.clientWidth, container.clientHeight));
    renderer.onResize.add(s => this.medicoes.redimensionar(s.x, s.y));
    container.addEventListener('pointermove', this.aoMoverMedicao);
    container.addEventListener('pointerleave', this.aoSairMedicao);
    window.addEventListener('keydown', this.aoTeclar);
  }

  // ---------------------------------------------------------------------------
  // Caixa de corte: 6 planos de recorte (renderer) + contorno e alças arrastáveis nas faces.
  // A caixa gira em torno da vertical para seguir os eixos do prédio, que no IFC costuma vir girado em relação aos
  // eixos do mundo (ver orientacao.ts). `corte` fica no referencial da caixa (x = Comprimento, y = altura,
  // z = Largura); o grupo do contorno e das alças recebe o giro e os planos são montados com os eixos girados.
  // ---------------------------------------------------------------------------
  private corte: THREE.Box3 | null = null;
  /** giro da caixa (rad, como `rotation.y`) e os modelos com que foi calculado */
  private giroCorte = 0;
  private giroDe: string | null = null;
  /** limites dos modelos visíveis no referencial da caixa, com a chave (giro + modelos) em que valem */
  private limitesCorte: { chave: string; caixa: THREE.Box3 } | null = null;
  private planosCorte = [
    new THREE.Plane(new THREE.Vector3(1, 0, 0), 0),
    new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0),
    new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
    new THREE.Plane(new THREE.Vector3(0, -1, 0), 0),
    new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
    new THREE.Plane(new THREE.Vector3(0, 0, -1), 0),
  ];
  private grupoCorte = new THREE.Group();
  private contornoCorte!: THREE.LineSegments;
  private alcas: THREE.Mesh[] = [];
  private arrasto: { eixo: 0 | 1 | 2; lado: 'min' | 'max'; id: number } | null = null;
  private atualizacaoPendente = 0;
  /** a caixa mudou pelo arrasto das alças (a tela atualiza os controles) */
  onCorteAlterado?: (caixa: THREE.Box3 | null) => void;

  // contorno e alças com material sem recorte (ShaderMaterial sem `clipping`): não somem com os planos
  private montarGrupoCorte() {
    const arestas = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    this.contornoCorte = new THREE.LineSegments(arestas, materialSemCorte('#2563eb', 0.9));
    this.contornoCorte.renderOrder = 10;
    this.grupoCorte.add(this.contornoCorte);
    const esfera = new THREE.SphereGeometry(1, 16, 12);
    const cores = ['#ef4444', '#22c55e', '#2563eb']; // X, Y (altura), Z
    for (let eixo = 0; eixo < 3; eixo++)
      for (const lado of ['min', 'max'] as const) {
        const a = new THREE.Mesh(esfera, materialSemCorte(cores[eixo], 0.95));
        a.userData = { eixo, lado };
        a.renderOrder = 11;
        this.alcas.push(a);
        this.grupoCorte.add(a);
      }
  }

  /** Liga/ajusta (caixa) ou desliga (null) a caixa de corte. */
  setCaixaCorte(caixa: THREE.Box3 | null) {
    if (this.descartado) return;
    const r = this.world.renderer!;
    if (!caixa) {
      if (this.corte) for (const p of this.planosCorte) r.setPlane(false, p);
      this.corte = null;
      this.grupoCorte.visible = false;
    } else {
      if (!this.corte) for (const p of this.planosCorte) r.setPlane(true, p, false);
      this.corte = caixa.clone();
      this.grupoCorte.visible = true;
      this.atualizarCorte();
    }
    this.pedirAtualizacao();
  }

  /** Caixa de corte no referencial dela (girado; ver {@link limitesDoCorte}). */
  caixaCorte() {
    return this.corte?.clone() ?? null;
  }

  /** Eixos da caixa no mundo: x (Comprimento), y (vertical) e z (Largura). */
  private eixosCorte() {
    const c = Math.cos(this.giroCorte),
      s = Math.sin(this.giroCorte);
    return [new THREE.Vector3(c, 0, -s), VERTICAL.clone(), new THREE.Vector3(s, 0, c)] as const;
  }

  /**
   * Limites dos modelos visíveis no referencial da caixa de corte. Com a caixa desligada, antes refaz o giro se os
   * modelos mudaram; com ela ligada, mantém o giro em uso.
   */
  async limitesDoCorte(): Promise<THREE.Box3 | null> {
    if (this.descartado) return null;
    if (!this.corte) await this.calcularGiro();
    const visiveis = this.modelosVisiveis();
    const chave = `${this.giroCorte}|${visiveis
      .map(([id]) => id)
      .sort()
      .join(',')}`;
    if (this.limitesCorte?.chave !== chave) {
      const caixa = await this.caixaGirada(visiveis, null);
      if (!caixa) return null;
      this.limitesCorte = { chave, caixa };
    }
    return this.limitesCorte.caixa.clone();
  }

  /** Caixa do elemento selecionado no referencial da caixa de corte, com folga. */
  async caixaDaSelecao(folga = 0.5): Promise<THREE.Box3 | null> {
    const mapa = this.expandirMapa(this.filtrarCarregados(this.selecaoAtual));
    const modelos = Object.keys(mapa).map(id => [id, this.fragments.list.get(id)!] as [string, FRAGS.FragmentsModel]);
    if (!modelos.length) return null;
    if (!this.corte) await this.calcularGiro();
    const caixa = await this.caixaGirada(modelos, mapa);
    return caixa ? caixa.expandByScalar(folga) : null;
  }

  /**
   * Giro do prédio pelas faces das paredes de todos os modelos carregados (inclusive os desmarcados: o prédio é o
   * mesmo). Sem paredes (só instalações, por exemplo), usa estrutura e vedação; sem nada disso, fica nos eixos do mundo.
   */
  private async calcularGiro() {
    const modelos = [...this.fragments.list];
    const chave = modelos
      .map(([id]) => id)
      .sort()
      .join(',');
    if (this.giroDe === chave) return;
    const hist = new HistogramaDirecoes();
    const grupos = [[/^IFCWALL/i, /^IFCCURTAINWALL/i], [/^IFC(SLAB|COLUMN|BEAM|COVERING|PLATE|MEMBER|FOOTING|ROOF)/i]];
    for (const categorias of grupos) {
      const porModelo = await Promise.all(
        modelos.map(async ([, m]) =>
          Object.values(await m.getItemsOfCategories(categorias).catch(() => ({}) as Record<string, number[]>)).flat(),
        ),
      );
      const total = porModelo.reduce((s, l) => s + l.length, 0);
      if (!total) continue;
      await Promise.all(
        modelos.map(async ([, m], i) => {
          const ids = amostrar(porModelo[i], Math.ceil((AMOSTRA_GIRO * porModelo[i].length) / total));
          if (ids.length) for (const malha of await this.malhasNoMundo(m, ids)) adicionarFaces(hist, malha.pos, malha.idx);
        }),
      );
      if (hist.peso > 0) break;
    }
    if (this.descartado) return;
    this.giroCorte = giroDaCaixa(hist.angulo());
    this.giroDe = chave;
  }

  /** Malhas dos itens com os vértices já nas coordenadas do mundo. */
  private async malhasNoMundo(m: FRAGS.FragmentsModel, ids: number[]) {
    const geos = await m.getItemsGeometry(ids).catch(() => [] as FRAGS.MeshData[][]);
    const out: { pos: Float64Array; idx: ArrayLike<number> | undefined }[] = [];
    const t = new THREE.Matrix4(),
      v = new THREE.Vector3();
    for (const item of geos)
      for (const g of item) {
        if (!g.positions?.length) continue;
        // a matriz chega do worker como objeto simples ({ elements })
        t.fromArray((g.transform as unknown as { elements: number[] }).elements).premultiply(m.object.matrixWorld);
        const pos = new Float64Array(g.positions.length);
        for (let i = 0; i + 2 < pos.length; i += 3) {
          v.set(g.positions[i], g.positions[i + 1], g.positions[i + 2]).applyMatrix4(t);
          pos[i] = v.x;
          pos[i + 1] = v.y;
          pos[i + 2] = v.z;
        }
        out.push({ pos, idx: g.indices });
      }
    return out;
  }

  /**
   * Caixa, no referencial da caixa de corte, dos itens dos modelos (os de `mapa`, ou todos com geometria). As caixas
   * do Fragments são alinhadas ao mundo e, giradas, sairiam bem maiores que o prédio (uma laje a 30° quase dobra).
   * O centro de cada item dá o limite por baixo; os itens cuja caixa girada passa dele têm a geometria conferida, dos
   * mais salientes para dentro; os poucos que sobram entram pela caixa girada (pode sobrar folga, nunca cortar).
   */
  private async caixaGirada(modelos: [string, FRAGS.FragmentsModel][], mapa: MapaElementos | null): Promise<THREE.Box3 | null> {
    const [ex, , ez] = this.eixosCorte();
    interface Item {
      m: FRAGS.FragmentsModel;
      id: number;
      cx: number;
      cz: number;
      rx: number;
      rz: number;
    }
    const itens: Item[] = [];
    let yMin = Infinity,
      yMax = -Infinity;
    await Promise.all(
      modelos.map(async ([id, m]) => {
        const ids = mapa ? [...(mapa[id] ?? [])] : await m.getItemsIdsWithGeometry().catch(() => [] as number[]);
        if (!ids.length) return;
        const caixas = await m.getBoxes(ids).catch(() => [] as THREE.Box3[]);
        const c = new THREE.Vector3(),
          r = new THREE.Vector3();
        caixas.forEach((b, i) => {
          if (b.isEmpty() || ids[i] == null) return;
          b.getCenter(c);
          b.getSize(r).multiplyScalar(0.5);
          yMin = Math.min(yMin, b.min.y);
          yMax = Math.max(yMax, b.max.y);
          itens.push({
            m,
            id: ids[i],
            cx: ex.dot(c),
            cz: ez.dot(c),
            rx: Math.abs(ex.x) * r.x + Math.abs(ex.z) * r.z,
            rz: Math.abs(ez.x) * r.x + Math.abs(ez.z) * r.z,
          });
        });
      }),
    );
    if (!itens.length || this.descartado) return null;
    const lim = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (const it of itens) {
      lim.minX = Math.min(lim.minX, it.cx);
      lim.maxX = Math.max(lim.maxX, it.cx);
      lim.minZ = Math.min(lim.minZ, it.cz);
      lim.maxZ = Math.max(lim.maxZ, it.cz);
    }
    const passa = (it: Item) =>
      Math.max(it.cx + it.rx - lim.maxX, lim.minX - it.cx + it.rx, it.cz + it.rz - lim.maxZ, lim.minZ - it.cz + it.rz);
    let pendentes = itens;
    for (let rodada = 0; rodada < 4; rodada++) {
      pendentes = pendentes.filter(it => passa(it) > 0.02);
      if (!pendentes.length) break;
      pendentes.sort((a, b) => passa(b) - passa(a));
      const lote = pendentes.slice(0, 400);
      pendentes = pendentes.slice(400);
      const porModelo = new Map<FRAGS.FragmentsModel, number[]>();
      for (const it of lote) {
        const l = porModelo.get(it.m);
        if (l) l.push(it.id);
        else porModelo.set(it.m, [it.id]);
      }
      await Promise.all(
        [...porModelo].map(async ([m, ids]) => {
          for (const { pos } of await this.malhasNoMundo(m, ids)) {
            for (let i = 0; i + 2 < pos.length; i += 3) {
              const x = ex.x * pos[i] + ex.z * pos[i + 2],
                z = ez.x * pos[i] + ez.z * pos[i + 2];
              if (x < lim.minX) lim.minX = x;
              if (x > lim.maxX) lim.maxX = x;
              if (z < lim.minZ) lim.minZ = z;
              if (z > lim.maxZ) lim.maxZ = z;
            }
          }
        }),
      );
      if (this.descartado) return null;
    }
    // o que não deu tempo de conferir entra pela caixa girada
    for (const it of pendentes) {
      lim.minX = Math.min(lim.minX, it.cx - it.rx);
      lim.maxX = Math.max(lim.maxX, it.cx + it.rx);
      lim.minZ = Math.min(lim.minZ, it.cz - it.rz);
      lim.maxZ = Math.max(lim.maxZ, it.cz + it.rz);
    }
    return new THREE.Box3(new THREE.Vector3(lim.minX, yMin, lim.minZ), new THREE.Vector3(lim.maxX, yMax, lim.maxZ));
  }

  private atualizarCorte() {
    const c = this.corte;
    if (!c) return;
    // plano do mínimo: normal no sentido do eixo; do máximo: contra (o que fica do lado negativo é recortado)
    const eixos = this.eixosCorte();
    for (let e = 0; e < 3; e++) {
      const pMin = this.planosCorte[2 * e],
        pMax = this.planosCorte[2 * e + 1];
      pMin.normal.copy(eixos[e]);
      pMin.constant = -c.min.getComponent(e);
      pMax.normal.copy(eixos[e]).negate();
      pMax.constant = c.max.getComponent(e);
    }
    this.grupoCorte.rotation.y = this.giroCorte;
    const centro = c.getCenter(new THREE.Vector3()),
      tam = c.getSize(new THREE.Vector3());
    this.contornoCorte.position.copy(centro);
    this.contornoCorte.scale.set(Math.max(tam.x, 1e-3), Math.max(tam.y, 1e-3), Math.max(tam.z, 1e-3));
    for (const a of this.alcas) {
      const { eixo, lado } = a.userData as { eixo: 0 | 1 | 2; lado: 'min' | 'max' };
      a.position.copy(centro);
      a.position.setComponent(eixo, (lado === 'min' ? c.min : c.max).getComponent(eixo));
    }
    this.ajustarTamanhoAlcas();
  }

  /** Alças com tamanho constante na tela. */
  private ajustarTamanhoAlcas = () => {
    if (!this.corte) return;
    const cam = this.world.camera.three;
    const p = new THREE.Vector3();
    for (const a of this.alcas) {
      const escala =
        cam instanceof THREE.OrthographicCamera
          ? ((cam.top - cam.bottom) / cam.zoom) * 0.009
          : cam.position.distanceTo(a.getWorldPosition(p)) * 0.011;
      a.scale.setScalar(Math.max(escala, 1e-3));
    }
  };

  /** O worker recalcula o que desenhar a cada mudança da caixa; agrupa as mudanças de um mesmo quadro. */
  private pedirAtualizacao() {
    if (this.atualizacaoPendente) return;
    this.atualizacaoPendente = requestAnimationFrame(() => {
      this.atualizacaoPendente = 0;
      if (!this.descartado) void this.fragments.core.update(true);
    });
  }

  private raioDoPonteiro(ev: PointerEvent) {
    const r = this.world.renderer!.three.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.world.camera.three);
    return raycaster;
  }

  private alcaSob(ev: PointerEvent): THREE.Mesh | null {
    if (!this.corte) return null;
    return (this.raioDoPonteiro(ev).intersectObjects(this.alcas, false)[0]?.object as THREE.Mesh | undefined) ?? null;
  }

  private aoPassarSobreAlca = (ev: PointerEvent) => {
    if (this.arrasto || !this.corte) return;
    this.container.style.cursor = this.alcaSob(ev) ? 'grab' : this.cursorBase();
  };

  private cursorBase() {
    return this.medindo ? 'crosshair' : '';
  }

  private aoPressionarAlca = (ev: PointerEvent) => {
    if (this.descartado || ev.button !== 0) return;
    const alca = this.alcaSob(ev);
    if (!alca) return;
    ev.stopPropagation(); // a câmera não orbita enquanto a face é arrastada
    ev.preventDefault();
    this.arrasto = { ...(alca.userData as { eixo: 0 | 1 | 2; lado: 'min' | 'max' }), id: ev.pointerId };
    this.container.style.cursor = 'grabbing';
    window.addEventListener('pointermove', this.aoArrastarAlca);
    window.addEventListener('pointerup', this.aoSoltarAlca);
  };

  private aoArrastarAlca = (ev: PointerEvent) => {
    const a = this.arrasto,
      c = this.corte;
    if (!a || !c || ev.pointerId !== a.id) return;
    // ponto do eixo da face (girado com a caixa) mais próximo do raio do mouse
    const eixo = this.eixosCorte()[a.eixo];
    const centro = c.getCenter(new THREE.Vector3()).applyAxisAngle(VERTICAL, this.giroCorte);
    const limites = this.limitesCorte?.caixa ?? c;
    const longe = limites.getSize(new THREE.Vector3()).length() * 4 + 1;
    const ponto = new THREE.Vector3();
    this.raioDoPonteiro(ev).ray.distanceSqToSegment(
      centro.clone().addScaledVector(eixo, -longe),
      centro.clone().addScaledVector(eixo, longe),
      undefined,
      ponto,
    );
    const minimo = (limites.max.getComponent(a.eixo) - limites.min.getComponent(a.eixo)) * 0.01;
    // coordenada no referencial da caixa: projeção no eixo girado (a caixa gira em torno da origem)
    const v = eixo.dot(ponto);
    if (a.lado === 'min')
      c.min.setComponent(a.eixo, Math.min(Math.max(v, limites.min.getComponent(a.eixo)), c.max.getComponent(a.eixo) - minimo));
    else c.max.setComponent(a.eixo, Math.max(Math.min(v, limites.max.getComponent(a.eixo)), c.min.getComponent(a.eixo) + minimo));
    this.atualizarCorte();
    this.pedirAtualizacao();
  };

  private aoSoltarAlca = () => {
    this.arrasto = null;
    this.container.style.cursor = this.cursorBase();
    // o fim do arrasto não é clique de seleção
    this.inicioClique = { x: -1e6, y: -1e6 };
    window.removeEventListener('pointermove', this.aoArrastarAlca);
    window.removeEventListener('pointerup', this.aoSoltarAlca);
    this.onCorteAlterado?.(this.caixaCorte());
  };

  private inicioClique = { x: 0, y: 0 };
  private aoPressionar = (ev: PointerEvent) => {
    this.inicioClique = { x: ev.clientX, y: ev.clientY };
  };

  private aoClicar = async (ev: MouseEvent) => {
    if (this.descartado) return;
    // arrastar para orbitar não é seleção
    if (Math.hypot(ev.clientX - this.inicioClique.x, ev.clientY - this.inicioClique.y) > 4) return;
    if (this.medindo) {
      await this.cliqueMedicao(ev.clientX, ev.clientY);
      return;
    }
    const hit = await this.seguroValor(() => this.elementoSob(ev.clientX, ev.clientY));
    if (this.descartado || this.medindo) return;
    // peça de um conjunto (barra de guarda-corpo, degrau): seleciona o conjunto inteiro; com Alt, só a peça
    const alvo = hit && (ev.altKey ? hit.localId : (this.conjuntos.get(hit.fragments.modelId)?.conjuntoDe.get(hit.localId) ?? hit.localId));
    if (hit && alvo != null) await this.orbitarEm(hit.fragments, alvo);
    this.selecaoAtual = hit && alvo != null ? { [hit.fragments.modelId]: new Set([alvo]) } : {};
    await this.agendar('pintar', () => this.repintarDiferenca());
    this.onSelecionar?.(hit && alvo != null ? { modeloId: hit.fragments.modelId, expressId: alvo } : null);
  };

  /** A câmera passa a girar em torno do centro do elemento selecionado (sem sair do lugar). */
  private async orbitarEm(m: FRAGS.FragmentsModel, id: number) {
    const b = await m.getMergedBox([...this.expandir(m.modelId, [id])]).catch(() => null);
    if (!b || b.isEmpty() || this.descartado) return;
    const c = b.getCenter(new THREE.Vector3());
    this.world.camera.controls.setOrbitPoint(c.x, c.y, c.z);
  }

  /** Modelos visíveis: nem desmarcados no painel nem fora da cena. */
  private modelosVisiveis() {
    return [...this.fragments.list].filter(([id, m]) => m.object.visible && !this.ocultos.has(id));
  }

  /**
   * Modelos que o clique pode atingir. O raycast do Fragments (e o fragments.raycast do That Open) percorre todos os
   * modelos, inclusive os escondidos com `object.visible = false`: a parede da arquitetura oculta "pegava" o clique
   * no eletroduto embutido.
   */
  private modelosClicaveis() {
    return this.modelosVisiveis().map(([, m]) => m);
  }

  /** O raycast do Fragments recebe coordenadas de tela (clientX/Y). */
  private dadosRaio(x: number, y: number): FRAGS.RaycastData {
    return { camera: this.world.camera.three, mouse: new THREE.Vector2(x, y), dom: this.world.renderer!.three.domElement };
  }

  /**
   * Disciplina com a opacidade reduzida no painel: o clique atravessa e pega o que estiver opaco atrás dela; só quando
   * não há nada opaco sob o ponteiro é que ela é atingida.
   */
  private transparente(id: string) {
    return (this.estilos.get(id)?.opacidade ?? 1) < 1;
  }

  /** Elemento mais próximo sob o ponteiro, só entre os modelos clicáveis, preferindo os opacos. */
  private async elementoSob(x: number, y: number): Promise<FRAGS.RaycastResult | null> {
    const dados = this.dadosRaio(x, y);
    const hits = await Promise.all(this.modelosClicaveis().map(m => m.raycast(dados).catch(() => null)));
    let opaco: FRAGS.RaycastResult | null = null,
      transparente: FRAGS.RaycastResult | null = null;
    for (const h of hits) {
      if (!h) continue;
      if (!this.transparente(h.fragments.modelId)) {
        if (!opaco || h.distance < opaco.distance) opaco = h;
      } else if (!transparente || h.distance < transparente.distance) transparente = h;
    }
    return opaco ?? transparente;
  }

  // ---------------------------------------------------------------------------
  // Medição: distância entre dois pontos clicados, encaixando em vértices e arestas
  // ---------------------------------------------------------------------------
  private medindo = false;
  private medicoes: Medicoes;
  /** última posição do ponteiro ainda não consultada no worker (o encaixe sob o ponteiro roda um de cada vez) */
  private cursorPendente: { x: number; y: number } | null = null;
  private cursorRodando = false;
  private ponteiroDentro = false;
  /** medidas mudaram (a tela atualiza a lista) */
  onMedidas?: (estado: EstadoMedicao) => void;

  /** Liga/desliga a medição. Enquanto ligada, o clique marca pontos em vez de selecionar; ao desligar, as medidas somem. */
  setMedicao(ligar: boolean) {
    if (this.descartado || this.medindo === ligar) return;
    this.medindo = ligar;
    this.cursorPendente = null;
    if (!ligar) this.medicoes.limpar();
    this.container.style.cursor = this.cursorBase();
    this.avisarMedidas();
  }

  removerMedida(id: number) {
    this.medicoes.remover(id);
    this.avisarMedidas();
  }

  limparMedidas() {
    this.medicoes.limpar();
    this.avisarMedidas();
  }

  private avisarMedidas() {
    this.onMedidas?.({ medidas: this.medicoes.lista(), emAndamento: this.medicoes.emAndamento });
  }

  /** Ponto do modelo sob o ponteiro: vértice ou aresta perto dele, senão a superfície. */
  private async pontoSob(x: number, y: number): Promise<{ ponto: THREE.Vector3; encaixe: Encaixe } | null> {
    const modelos = this.modelosClicaveis();
    if (!modelos.length) return null;
    const S = FRAGS.SnappingClass;
    const dados: FRAGS.SnappingRaycastData = { ...this.dadosRaio(x, y), snappingClasses: [S.POINT, S.LINE, S.FACE] };
    const listas = await Promise.all(modelos.map(m => m.raycastWithSnapping(dados).catch(() => null)));
    const tela = this.world.renderer!.three.domElement.getBoundingClientRect();
    const cam = this.world.camera.three;
    // como no clique: as disciplinas transparentes pelo painel só valem quando não há nada opaco sob o ponteiro
    const candidatos: CandidatoEncaixe<THREE.Vector3>[] = [],
      deTransparentes: CandidatoEncaixe<THREE.Vector3>[] = [];
    for (const r of listas.flatMap(l => l ?? [])) {
      const v = r.point.clone().project(cam);
      (this.transparente(r.fragments.modelId) ? deTransparentes : candidatos).push({
        encaixe: r.snappingClass === S.POINT ? 'vertice' : r.snappingClass === S.LINE ? 'aresta' : 'face',
        distancia: r.distance,
        pixels: Math.hypot(tela.left + ((v.x + 1) / 2) * tela.width - x, tela.top + ((1 - v.y) / 2) * tela.height - y),
        modelo: r.fragments,
        valor: r.point,
      });
    }
    const c = escolherEncaixe(candidatos) ?? escolherEncaixe(deTransparentes);
    return c ? { ponto: c.valor.clone(), encaixe: c.encaixe } : null;
  }

  private async cliqueMedicao(x: number, y: number) {
    const alvo = await this.seguroValor(() => this.pontoSob(x, y));
    if (this.descartado || !this.medindo || !alvo) return;
    this.medicoes.marcar(alvo.ponto);
    this.medicoes.apontar(alvo.ponto, alvo.encaixe);
    this.avisarMedidas();
  }

  private aoMoverMedicao = (ev: PointerEvent) => {
    this.ponteiroDentro = true;
    if (!this.medindo || this.arrasto || ev.pointerType === 'touch') return;
    // orbitando ou arrastando: a marca some até soltar
    if (ev.buttons) {
      this.cursorPendente = null;
      this.medicoes.apontar(null);
      return;
    }
    this.cursorPendente = { x: ev.clientX, y: ev.clientY };
    if (!this.cursorRodando) void this.rodarCursor();
  };

  private aoSairMedicao = () => {
    this.ponteiroDentro = false;
    this.cursorPendente = null;
    if (this.medindo) this.medicoes.apontar(null);
  };

  /** Encaixe sob o ponteiro: uma consulta ao worker por vez, sempre com a posição mais recente. */
  private async rodarCursor() {
    this.cursorRodando = true;
    try {
      while (this.cursorPendente && this.medindo && !this.descartado) {
        const { x, y } = this.cursorPendente;
        this.cursorPendente = null;
        const alvo = await this.pontoSob(x, y).catch(() => null);
        // o ponteiro saiu do 3D ou a medição foi desligada enquanto o worker respondia
        if (!this.medindo || this.descartado || !this.ponteiroDentro) break;
        this.medicoes.apontar(alvo?.ponto ?? null, alvo?.encaixe);
      }
    } finally {
      this.cursorRodando = false;
    }
  }

  private aoTeclar = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape' || !this.medindo || !this.medicoes.emAndamento) return;
    this.medicoes.cancelar();
    this.avisarMedidas();
  };

  // ---------------------------------------------------------------------------
  // Fila: as pinturas rodam uma de cada vez e leem o estado desejado na hora de executar.
  // Pedidos repetidos com a mesma chave enquanto um ainda espera são absorvidos
  // (ex.: arrastar o controle de opacidade).
  // ---------------------------------------------------------------------------
  private fila: Promise<void> = Promise.resolve();
  private esperando = new Set<string>();

  private agendar(chave: string, fn: () => Promise<void>): Promise<void> {
    if (this.esperando.has(chave)) return this.fila;
    this.esperando.add(chave);
    const p = this.fila.then(async () => {
      this.esperando.delete(chave);
      if (this.descartado) return;
      await this.seguro(fn);
    });
    this.fila = p.catch(() => undefined);
    return p;
  }

  /** Erros de operações que terminam depois do dispose não interessam a ninguém. */
  private async seguro(fn: () => Promise<void>) {
    try {
      await fn();
    } catch (e) {
      if (!this.descartado) throw e;
    }
  }

  private async seguroValor<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (e) {
      if (!this.descartado) throw e;
      return undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Modelos
  // ---------------------------------------------------------------------------

  async carregar(modeloId: string, bytes: Uint8Array) {
    if (this.descartado || this.fragments.list.has(modeloId)) return;
    await this.seguro(async () => {
      await this.fragments.core.load(bytes, { modelId: modeloId });
    });
    this.limitesCorte = null;
    // o que a tela já pediu (estilo, visibilidade, seleção) vale para o recém-chegado
    await this.agendar(`modelo:${modeloId}`, () => this.aplicarEstadoNoModelo(modeloId));
  }

  /**
   * Conjuntos de um modelo (pares [peça, conjunto]). Podem chegar antes ou depois do modelo: se ele já está na
   * cena, é repintado para a seleção passar a valer para as peças.
   */
  async setConjuntos(modeloId: string, pares: Iterable<readonly [number, number]>) {
    if (this.descartado) return;
    this.conjuntos.set(modeloId, conjuntosDePares(pares));
    await this.agendar(`conjuntos:${modeloId}`, async () => {
      const m = this.fragments.list.get(modeloId);
      if (!m) return;
      await this.repintarModelo(modeloId, m);
      await this.fragments.core.update(true);
    });
  }

  /** Cada conjunto vale por ele e pelas suas peças: é o que existe no 3D para pintar. */
  private expandir(id: string, ids: Iterable<number> | undefined): Set<number> {
    const out = new Set<number>();
    if (!ids) return out;
    const c = this.conjuntos.get(id);
    for (const x of ids) {
      out.add(x); // alguns conjuntos (revestimento com partes, porta) também têm geometria própria
      const p = c?.pecas.get(x);
      if (p) for (const y of p) out.add(y);
    }
    return out;
  }

  private expandirMapa(mapa: MapaElementos): MapaElementos {
    const out: MapaElementos = {};
    for (const [id, ids] of Object.entries(mapa)) out[id] = this.expandir(id, ids);
    return out;
  }

  private async aplicarEstadoNoModelo(id: string) {
    const m = this.fragments.list.get(id);
    if (!m) return;
    m.object.visible = !this.someDeVez(id);
    await this.repintarModelo(id, m);
    await this.fragments.core.update(true);
  }

  async remover(modeloId: string) {
    if (!this.descartado && this.fragments.list.has(modeloId)) await this.fragments.core.disposeModel(modeloId);
    this.pintadoSelecao.delete(modeloId);
    this.vultoPintado.delete(modeloId);
    this.limitesCorte = null;
  }

  modelosCarregados() {
    return [...this.fragments.list.keys()];
  }

  /**
   * Marca/desmarca uma disciplina. Desmarcada, vira vulto transparente ou some (ver {@link setModoOcultos}) e deixa de
   * ser clicável. Vale também para o modelo que ainda vai carregar ou que for recarregado (revisão nova).
   */
  async setVisivelModelo(modeloId: string, visivel: boolean) {
    if (this.descartado) return;
    if (visivel) this.ocultos.delete(modeloId);
    else this.ocultos.add(modeloId);
    await this.agendar(`visivel:${modeloId}`, async () => {
      const m = this.fragments.list.get(modeloId);
      if (!m) return;
      await this.aplicarOcultoNoModelo(modeloId, m);
      await this.fragments.core.update(true);
    });
  }

  /** Desmarcadas como vulto transparente ('transparente') ou sumindo por completo ('oculto'). */
  async setModoOcultos(modo: ModoOcultos) {
    if (this.descartado || this.modoOcultos === modo) return;
    this.modoOcultos = modo;
    await this.agendar('modo-ocultos', async () => {
      await Promise.all(
        [...this.fragments.list].filter(([id]) => this.ocultos.has(id)).map(([id, m]) => this.aplicarOcultoNoModelo(id, m)),
      );
      await this.fragments.core.update(true);
    });
  }

  /** Desmarcada e no modo vulto: pintada transparente por cima do estilo do modelo. */
  private emVulto(id: string) {
    return this.modoOcultos === 'transparente' && this.ocultos.has(id);
  }
  /** Desmarcada e no modo 'oculto': o modelo inteiro sai da cena. */
  private someDeVez(id: string) {
    return this.modoOcultos === 'oculto' && this.ocultos.has(id);
  }

  private async aplicarOcultoNoModelo(id: string, m: FRAGS.FragmentsModel) {
    m.object.visible = !this.someDeVez(id);
    // o vulto faz parte do estilo do modelo: entrar ou sair dele pede a repintura completa
    if (this.vultoPintado.has(id) !== this.emVulto(id)) await this.repintarModelo(id, m);
  }

  /** Caixa (coordenadas do mundo) dos modelos visíveis — `model.box` já vem com a posição do modelo aplicada. */
  limitesDosModelos(): THREE.Box3 | null {
    const caixa = new THREE.Box3();
    for (const [id, m] of this.fragments.list) if (m.object.visible && !this.ocultos.has(id) && !m.box.isEmpty()) caixa.union(m.box);
    return caixa.isEmpty() ? null : caixa;
  }

  /** Recentraliza a vista: a caixa de corte, se ligada (é o que está à mostra), senão todos os modelos visíveis. */
  async recentralizar() {
    if (this.descartado) return;
    const c = this.corte;
    const esfera = c
      ? new THREE.Sphere(
          c.getCenter(new THREE.Vector3()).applyAxisAngle(VERTICAL, this.giroCorte),
          c.getSize(new THREE.Vector3()).length() / 2,
        )
      : this.limitesDosModelos()?.getBoundingSphere(new THREE.Sphere());
    if (!esfera) return;
    // depois da transição, pede ao worker a geometria da nova vista de uma vez (vindo de muito longe, os detalhes
    // tinham sido descartados e voltariam aos poucos)
    await this.seguro(async () => {
      await this.world.camera.controls.fitToSphere(esfera, true);
      await this.fragments.core.update(true);
    });
  }

  /** Enquadra os modelos visíveis pela caixa de cada um (sem percorrer os ~100 mil elementos). */
  async enquadrarTudo() {
    if (this.descartado) return;
    const caixa = this.limitesDosModelos();
    if (!caixa) return;
    const esfera = caixa.getBoundingSphere(new THREE.Sphere());
    await this.seguro(async () => {
      await this.world.camera.controls.fitToSphere(esfera, true);
    });
  }

  private filtrarCarregados(mapa: MapaElementos): MapaElementos {
    const out: MapaElementos = {};
    for (const [id, s] of Object.entries(mapa)) if (this.fragments.list.has(id) && s.size) out[id] = s;
    return out;
  }

  // ---------------------------------------------------------------------------
  // Pintura
  // ---------------------------------------------------------------------------

  /**
   * Material que muda só cor e/ou opacidade e mantém o resto do original. Não usa setColor/setOpacity do Fragments:
   * eles marcam "preservar o material original", o que impede o reaproveitamento, e cada chamada cria um material
   * por elemento. Com dezenas de milhares de elementos o limite de 65 mil materiais estoura ("Memory overflow!")
   * depois de duas ou três repinturas e as cores deixam de ser aplicadas. Estes são reaproveitados (mesma cor e
   * opacidade = mesmo material).
   */
  private materialParcial(cor: string | null, opacidade: number): FRAGS.MaterialDefinition | null {
    const chave = `${cor ?? ''}|${opacidade}`;
    let m = this.materiaisParciais.get(chave);
    if (m === undefined) {
      const def: Record<string, unknown> = {};
      const explicitas: string[] = [];
      if (cor) {
        def.color = new THREE.Color(cor);
        explicitas.push('color');
      }
      if (opacidade < 1) {
        def.opacity = opacidade;
        def.transparent = true;
        explicitas.push('opacity', 'transparent');
      }
      m = explicitas.length ? ({ ...def, _explicitProps: explicitas } as unknown as FRAGS.MaterialDefinition) : null;
      this.materiaisParciais.set(chave, m);
    }
    return m;
  }

  /** Cor/opacidade do modelo em `ids` (todos, se undefined). */
  private async pintarEstilo(m: FRAGS.FragmentsModel, id: string, ids: number[] | undefined) {
    if (this.emVulto(id)) {
      await m.highlight(ids, VULTO);
      return;
    }
    const e = this.estilos.get(id);
    if (!e) return;
    const mat = this.materialParcial(e.cor, e.opacidade);
    if (mat) await m.highlight(ids, mat);
  }

  /** Devolve `ids` ao estado base: o estilo do modelo. */
  private async pintarBase(m: FRAGS.FragmentsModel, id: string, ids: number[]) {
    await m.resetHighlight(ids);
    await this.pintarEstilo(m, id, ids);
  }

  /** Repintura completa de um modelo: estilo e seleção, do zero. */
  private async repintarModelo(id: string, m: FRAGS.FragmentsModel) {
    if (this.emVulto(id)) this.vultoPintado.add(id);
    else this.vultoPintado.delete(id);
    await m.resetHighlight();
    await this.pintarEstilo(m, id, undefined);
    const s = this.expandir(id, this.selecaoAtual[id]);
    if (s.size) await m.highlight([...s], COR_SELECAO);
    this.pintadoSelecao.set(id, new Set(s));
  }

  /** Aplica só o que mudou na seleção; modelos em paralelo (cada um vive no seu worker). */
  private async repintarDiferenca() {
    await Promise.all(
      [...this.fragments.list].map(async ([id, m]) => {
        const s = this.expandir(id, this.selecaoAtual[id]);
        const sAntes = this.pintadoSelecao.get(id) ?? VAZIO;
        const limpar: number[] = [];
        for (const x of sAntes) if (!s.has(x)) limpar.push(x);
        // registra o novo estado antes de pintar a base: quem sai não pode voltar como seleção
        this.pintadoSelecao.set(id, new Set(s));
        if (limpar.length) await this.pintarBase(m, id, limpar);
        const sNovo: number[] = [];
        for (const x of s) if (!sAntes.has(x)) sNovo.push(x);
        if (sNovo.length) await m.highlight(sNovo, COR_SELECAO);
      }),
    );
    await this.fragments.core.update(true);
  }

  /** Seleciona um elemento pela tela (null limpa), sem mexer na câmera. */
  async selecionar(sel: { modeloId: string; expressId: number } | null) {
    if (this.descartado) return;
    this.selecaoAtual = sel ? { [sel.modeloId]: new Set([sel.expressId]) } : {};
    await this.agendar('pintar', () => this.repintarDiferenca());
  }

  /** Cor (hex) e opacidade (0–1) de um modelo inteiro; null volta ao original. */
  async setEstiloModelo(modeloId: string, estilo: EstiloModelo | null) {
    if (this.descartado) return;
    if (!estilo || (!estilo.cor && estilo.opacidade >= 1)) this.estilos.delete(modeloId);
    else this.estilos.set(modeloId, estilo);
    await this.agendar(`estilo:${modeloId}`, async () => {
      const m = this.fragments.list.get(modeloId);
      if (!m) return;
      await this.repintarModelo(modeloId, m);
      await this.fragments.core.update(true);
    });
  }

  async resetarEstilos() {
    if (this.descartado) return;
    this.estilos.clear();
    this.ocultos.clear();
    for (const m of this.fragments.list.values()) m.object.visible = true;
    await this.agendar('estilo:*', async () => {
      await Promise.all([...this.fragments.list].map(([id, m]) => this.repintarModelo(id, m)));
      await this.fragments.core.update(true);
    });
  }

  dispose() {
    this.descartado = true;
    this.container.removeEventListener('pointerdown', this.aoPressionar);
    this.container.removeEventListener('click', this.aoClicar);
    this.container.removeEventListener('pointerdown', this.aoPressionarAlca, { capture: true });
    this.container.removeEventListener('pointermove', this.aoPassarSobreAlca);
    window.removeEventListener('pointermove', this.aoArrastarAlca);
    window.removeEventListener('pointerup', this.aoSoltarAlca);
    this.container.removeEventListener('pointermove', this.aoMoverMedicao);
    this.container.removeEventListener('pointerleave', this.aoSairMedicao);
    window.removeEventListener('keydown', this.aoTeclar);
    if (this.atualizacaoPendente) cancelAnimationFrame(this.atualizacaoPendente);
    this.medicoes.dispose();
    this.components.dispose();
  }
}

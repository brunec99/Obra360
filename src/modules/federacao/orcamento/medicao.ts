import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

import { COR_MEDIDA, CORES_ENCAIXE, decompor, formatarMetros, type Encaixe, type InfoMedida } from './medicao-regras';

/** Material sem recorte e sem profundidade: fica visível por cima do modelo e fora da caixa de corte. */
export function materialSemCorte(cor: string, opacidade: number) {
  return new THREE.ShaderMaterial({
    uniforms: { cor: { value: new THREE.Color(cor) }, opacidade: { value: opacidade } },
    vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 cor; uniform float opacidade; void main() { gl_FragColor = vec4(cor, opacidade); }',
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
}

interface Medida {
  id: number;
  a: THREE.Vector3;
  b: THREE.Vector3;
  linha: Line2;
  pontas: THREE.Mesh[];
  rotulo: HTMLDivElement;
}

/**
 * Desenho das medidas no 3D: linhas por cima do modelo, bolinhas nas pontas com tamanho constante na tela e o
 * comprimento num rótulo HTML no meio de cada linha. Quem escolhe os pontos (raycast com encaixe) é o Visualizador.
 */
export class Medicoes {
  private grupo = new THREE.Group();
  private camada = document.createElement('div');
  private esfera = new THREE.SphereGeometry(1, 16, 12);
  private matLinha = novoMaterialLinha(1);
  private matProvisoria = novoMaterialLinha(0.65);
  private matPonta = materialSemCorte(COR_MEDIDA, 1);
  private matEncaixe: Record<Encaixe, THREE.ShaderMaterial> = {
    vertice: materialSemCorte(CORES_ENCAIXE.vertice, 1),
    aresta: materialSemCorte(CORES_ENCAIXE.aresta, 1),
    face: materialSemCorte(CORES_ENCAIXE.face, 0.85),
  };
  private medidas: Medida[] = [];
  private proximoId = 1;
  private inicio: { ponto: THREE.Vector3; ponta: THREE.Mesh } | null = null;
  /** linha do primeiro ponto até o ponteiro, enquanto falta o segundo clique */
  private provisoria: Line2;
  private rotuloProvisorio: HTMLDivElement;
  /** bolinha sob o ponteiro, na cor do encaixe */
  private marca: THREE.Mesh;
  private cursor: THREE.Vector3 | null = null;
  private camera: () => THREE.Camera;

  constructor(cena: THREE.Object3D, camera: () => THREE.Camera, container: HTMLElement) {
    this.camera = camera;
    this.camada.className = 'medidas-rotulos';
    container.appendChild(this.camada);
    this.provisoria = this.novaLinha(this.matProvisoria, new THREE.Vector3(), new THREE.Vector3());
    this.provisoria.visible = false;
    this.rotuloProvisorio = this.novoRotulo('medida-rotulo provisoria');
    this.rotuloProvisorio.style.display = 'none';
    this.marca = new THREE.Mesh(this.esfera, this.matEncaixe.face);
    this.marca.renderOrder = 14;
    this.marca.visible = false;
    this.grupo.add(this.provisoria, this.marca);
    cena.add(this.grupo);
    this.redimensionar(container.clientWidth, container.clientHeight);
  }

  get emAndamento() {
    return !!this.inicio;
  }

  /** Ponto clicado: começa uma medida ou fecha a que está em andamento. */
  marcar(p: THREE.Vector3) {
    if (!this.inicio) {
      this.inicio = { ponto: p.clone(), ponta: this.novaPonta(p) };
      return;
    }
    const a = this.inicio.ponto,
      b = p.clone();
    if (a.distanceTo(b) < 1e-4) return; // segundo clique no mesmo ponto
    const rotulo = this.novoRotulo('medida-rotulo');
    rotulo.textContent = formatarMetros(a.distanceTo(b));
    this.medidas.push({
      id: this.proximoId++,
      a,
      b,
      linha: this.novaLinha(this.matLinha, a, b),
      pontas: [this.inicio.ponta, this.novaPonta(b)],
      rotulo,
    });
    this.inicio = null;
    this.atualizarProvisoria();
  }

  /** Ponto sob o ponteiro (null: fora do modelo): marca do encaixe e, com uma medida em andamento, a linha até ele. */
  apontar(p: THREE.Vector3 | null, encaixe: Encaixe = 'face') {
    this.cursor = p ? p.clone() : null;
    this.marca.visible = !!p;
    if (p) {
      this.marca.position.copy(p);
      this.marca.material = this.matEncaixe[encaixe];
    }
    this.atualizarProvisoria();
  }

  /** Desiste do primeiro ponto já clicado. */
  cancelar() {
    if (!this.inicio) return;
    this.grupo.remove(this.inicio.ponta);
    this.inicio = null;
    this.atualizarProvisoria();
  }

  remover(id: number) {
    const i = this.medidas.findIndex(m => m.id === id);
    if (i < 0) return;
    this.descartarMedida(this.medidas[i]);
    this.medidas.splice(i, 1);
  }

  limpar() {
    this.cancelar();
    for (const m of this.medidas) this.descartarMedida(m);
    this.medidas = [];
    this.apontar(null);
  }

  lista(): InfoMedida[] {
    return this.medidas.map(m => ({ id: m.id, ...decompor(m.a, m.b) }));
  }

  /** A cada quadro, antes de desenhar: pontas com tamanho constante na tela e rótulos no meio das linhas. */
  atualizar(largura: number, altura: number) {
    if (!this.medidas.length && !this.inicio && !this.marca.visible) return;
    const cam = this.camera();
    cam.updateMatrixWorld();
    const escalar = (o: THREE.Object3D, fator: number) => o.scale.setScalar(Math.max(this.unidadeTela(o.position, cam) * fator, 1e-4));
    for (const m of this.medidas) for (const p of m.pontas) escalar(p, 1);
    if (this.inicio) escalar(this.inicio.ponta, 1);
    if (this.marca.visible) escalar(this.marca, 1.25);
    const meio = new THREE.Vector3();
    for (const m of this.medidas) this.posicionar(m.rotulo, meio.lerpVectors(m.a, m.b, 0.5), cam, largura, altura);
    if (this.provisoria.visible && this.inicio && this.cursor) {
      this.posicionar(this.rotuloProvisorio, meio.lerpVectors(this.inicio.ponto, this.cursor, 0.5), cam, largura, altura);
    }
  }

  redimensionar(largura: number, altura: number) {
    this.matLinha.resolution.set(largura, altura);
    this.matProvisoria.resolution.set(largura, altura);
  }

  dispose() {
    this.limpar();
    this.provisoria.geometry.dispose();
    this.grupo.removeFromParent();
    this.camada.remove();
    this.esfera.dispose();
    for (const m of [this.matLinha, this.matProvisoria, this.matPonta, ...Object.values(this.matEncaixe)]) m.dispose();
  }

  // ---------------------------------------------------------------------------

  /** Tamanho no mundo que ocupa ~0,5% da altura da tela em `pos`. */
  private unidadeTela(pos: THREE.Vector3, cam: THREE.Camera) {
    return cam instanceof THREE.OrthographicCamera
      ? ((cam.top - cam.bottom) / cam.zoom) * 0.0045
      : cam.getWorldPosition(new THREE.Vector3()).distanceTo(pos) * 0.0055;
  }

  private posicionar(el: HTMLElement, p: THREE.Vector3, cam: THREE.Camera, largura: number, altura: number) {
    const v = p.clone().project(cam);
    // atrás da câmera
    if (v.z > 1 || v.z < -1) {
      el.style.visibility = 'hidden';
      return;
    }
    el.style.visibility = '';
    el.style.transform = `translate(${((v.x + 1) / 2) * largura}px, ${((1 - v.y) / 2) * altura}px) translate(-50%, -50%)`;
  }

  private atualizarProvisoria() {
    const ligar = !!(this.inicio && this.cursor);
    this.provisoria.visible = ligar;
    this.rotuloProvisorio.style.display = ligar ? '' : 'none';
    if (!ligar) return;
    moverLinha(this.provisoria, this.inicio!.ponto, this.cursor!);
    this.rotuloProvisorio.textContent = formatarMetros(this.inicio!.ponto.distanceTo(this.cursor!));
  }

  private novaLinha(mat: LineMaterial, a: THREE.Vector3, b: THREE.Vector3) {
    const geo = new LineGeometry();
    geo.setPositions([a.x, a.y, a.z, b.x, b.y, b.z]);
    const l = new Line2(geo, mat);
    l.renderOrder = 12;
    l.frustumCulled = false;
    this.grupo.add(l);
    return l;
  }

  private novaPonta(p: THREE.Vector3) {
    const m = new THREE.Mesh(this.esfera, this.matPonta);
    m.position.copy(p);
    m.renderOrder = 13;
    this.grupo.add(m);
    return m;
  }

  private novoRotulo(classe: string) {
    const el = document.createElement('div');
    el.className = classe;
    this.camada.appendChild(el);
    return el;
  }

  private descartarMedida(m: Medida) {
    this.grupo.remove(m.linha, ...m.pontas);
    m.linha.geometry.dispose();
    m.rotulo.remove();
  }
}

/** Linha grossa (em pixels) por cima de tudo e sem os planos da caixa de corte. */
function novoMaterialLinha(opacidade: number) {
  const m = new LineMaterial({
    color: new THREE.Color(COR_MEDIDA).getHex(),
    linewidth: 2.5,
    transparent: true,
    opacity: opacidade,
    depthTest: false,
    depthWrite: false,
  });
  m.clipping = false;
  return m;
}

/**
 * Move as pontas de uma linha sem recriar os buffers (a linha provisória muda a cada movimento do ponteiro e
 * `setPositions` deixaria um buffer novo na placa de vídeo a cada vez).
 */
function moverLinha(linha: Line2, a: THREE.Vector3, b: THREE.Vector3) {
  const attr = linha.geometry.getAttribute('instanceStart') as THREE.InterleavedBufferAttribute | undefined;
  if (!attr) {
    linha.geometry.setPositions([a.x, a.y, a.z, b.x, b.y, b.z]);
    return;
  }
  attr.data.array.set([a.x, a.y, a.z, b.x, b.y, b.z]);
  attr.data.needsUpdate = true;
}

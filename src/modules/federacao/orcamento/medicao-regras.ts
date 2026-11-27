/**
 * Regras da medição no 3D, sem depender do three.js: servem à tela (legenda, lista de medidas) e aos testes.
 * Vieram do Orçamento 4D (app/src/viewer/medicao.ts); o desenho das medidas fica em medicao.ts.
 */

/** Onde o ponto da medição encaixou: num vértice, numa aresta ou só na superfície sob o ponteiro. */
export type Encaixe = 'vertice' | 'aresta' | 'face';

export interface XYZ {
  x: number;
  y: number;
  z: number;
}

/** Uma medida pronta, como as telas a mostram. */
export interface InfoMedida {
  id: number;
  /** distância entre os dois pontos, em metros */
  distancia: number;
  /** projeção no plano do piso */
  horizontal: number;
  /** diferença de altura */
  vertical: number;
}

export interface EstadoMedicao {
  medidas: InfoMedida[];
  /** o primeiro ponto já foi clicado e falta o segundo */
  emAndamento: boolean;
}

export const COR_MEDIDA = '#c026d3';
export const CORES_ENCAIXE: Record<Encaixe, string> = { vertice: '#16a34a', aresta: '#f59e0b', face: COR_MEDIDA };

/** Até quantos pixels do ponteiro um vértice ou uma aresta "puxam" o ponto. */
export const RAIO_VERTICE_PX = 12;
export const RAIO_ARESTA_PX = 7;

/** Distância entre dois pontos do 3D e suas componentes horizontal e vertical (Y é a altura no three.js). */
export function decompor(a: XYZ, b: XYZ): Omit<InfoMedida, 'id'> {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    dz = b.z - a.z;
  return { distancia: Math.hypot(dx, dy, dz), horizontal: Math.hypot(dx, dz), vertical: Math.abs(dy) };
}

export const formatarMetros = (v: number) => `${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} m`;

export interface CandidatoEncaixe<T> {
  encaixe: Encaixe;
  /** da câmera até o ponto */
  distancia: number;
  /** na tela, do ponteiro até o ponto */
  pixels: number;
  /** modelo de onde veio (só a identidade importa) */
  modelo: unknown;
  valor: T;
}

/**
 * Escolhe o ponto da medição entre os encaixes devolvidos por cada modelo: um vértice perto do ponteiro, senão uma
 * aresta, senão a superfície mais próxima. Vértice ou aresta escondidos atrás dessa superfície não valem. Os do mesmo
 * modelo já chegam filtrados pelo Fragments (só os que ficam na frente do plano atingido). Os de outro modelo valem só
 * se estiverem mais perto da câmera que ela, com 2 cm de folga para o que encosta na superfície.
 */
export function escolherEncaixe<T>(candidatos: readonly CandidatoEncaixe<T>[]): CandidatoEncaixe<T> | null {
  let face: CandidatoEncaixe<T> | null = null;
  for (const c of candidatos) if (c.encaixe === 'face' && (!face || c.distancia < face.distancia)) face = c;
  const aVista = (c: CandidatoEncaixe<T>) => !face || c.modelo === face.modelo || c.distancia <= face.distancia + 0.02;
  for (const [encaixe, raio] of [
    ['vertice', RAIO_VERTICE_PX],
    ['aresta', RAIO_ARESTA_PX],
  ] as const) {
    let melhor: CandidatoEncaixe<T> | null = null;
    for (const c of candidatos) {
      if (c.encaixe === encaixe && c.pixels <= raio && aVista(c) && (!melhor || c.pixels < melhor.pixels)) melhor = c;
    }
    if (melhor) return melhor;
  }
  return face;
}

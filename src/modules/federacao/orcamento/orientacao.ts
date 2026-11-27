/**
 * Eixos do prédio no 3D. O IFC costuma vir com o prédio girado em relação aos eixos do mundo (norte verdadeiro,
 * coordenadas compartilhadas do Revit). A caixa de corte precisa seguir paredes e lajes, então o giro é tirado da
 * própria geometria: as faces verticais das paredes apontam, a menos de 90°, para os eixos do prédio.
 */

const QUARTO = Math.PI / 2;
/** 0,25° por faixa */
const FAIXAS = 360;

/** Histograma das direções horizontais das faces, módulo 90°, ponderado pela área. */
export class HistogramaDirecoes {
  private pesos = new Float64Array(FAIXAS);
  /** soma de área × ângulo em cada faixa: a média exata, sem o erro de meia faixa */
  private somas = new Float64Array(FAIXAS);
  peso = 0;

  /** Face de normal (nx, ny, nz), não necessariamente unitária, e área `area`. Só as quase verticais contam. */
  adicionar(nx: number, ny: number, nz: number, area: number) {
    const h = Math.hypot(nx, nz);
    if (!(area > 0) || h === 0 || Math.abs(ny) > 0.15 * Math.hypot(h, ny)) return;
    let a = Math.atan2(nz, nx) % QUARTO;
    if (a < 0) a += QUARTO;
    const i = Math.min(FAIXAS - 1, Math.floor((a / QUARTO) * FAIXAS));
    this.pesos[i] += area;
    this.somas[i] += area * a;
    this.peso += area;
  }

  /** Direção dominante, em radianos, no intervalo [0, π/2); null sem faces. */
  angulo(): number | null {
    if (!(this.peso > 0)) return null;
    // suaviza (o módulo 90° faz o histograma circular) e acha o pico
    const suave = (i: number) => {
      let s = 0;
      for (let d = -4; d <= 4; d++) s += this.pesos[(i + d + FAIXAS) % FAIXAS] * (5 - Math.abs(d));
      return s;
    };
    let pico = 0,
      melhor = -1;
    for (let i = 0; i < FAIXAS; i++) {
      const s = suave(i);
      if (s > melhor) {
        melhor = s;
        pico = i;
      }
    }
    // refina pela média ponderada dos ângulos em volta do pico (±1°), desdobrando a volta de 90°
    const centro = ((pico + 0.5) / FAIXAS) * QUARTO;
    let soma = 0,
      somaPesos = 0;
    for (let d = -4; d <= 4; d++) {
      const i = (pico + d + FAIXAS) % FAIXAS,
        p = this.pesos[i];
      if (!p) continue;
      let m = this.somas[i] / p;
      if (m - centro > QUARTO / 2) m -= QUARTO;
      else if (centro - m > QUARTO / 2) m += QUARTO;
      soma += p * m;
      somaPesos += p;
    }
    const a = (somaPesos > 0 ? soma / somaPesos : centro) % QUARTO;
    return a < 0 ? a + QUARTO : a;
  }
}

/**
 * Giro (rad, em torno do eixo vertical, no sentido de `Object3D.rotation.y`) que alinha os eixos locais da caixa à
 * direção dominante `angulo` (medida como atan2(z, x)). Fica entre -45° e 45° para "Comprimento" continuar perto do X.
 */
export function giroDaCaixa(angulo: number | null): number {
  if (angulo == null) return 0;
  let g = -angulo;
  if (g < -Math.PI / 4) g += QUARTO;
  return Math.abs(g) < 1e-6 ? 0 : g;
}

/** Até `n` itens espalhados pela lista (a ordem do IFC costuma agrupar por pavimento). */
export function amostrar<T>(lista: readonly T[], n: number): T[] {
  if (n >= lista.length) return [...lista];
  if (n <= 0) return [];
  const passo = lista.length / n;
  return Array.from({ length: n }, (_, i) => lista[Math.floor(i * passo)]);
}

/** Soma ao histograma as faces de uma malha (vértices xyz em sequência; sem índices, triângulos em sequência). */
export function adicionarFaces(hist: HistogramaDirecoes, pos: ArrayLike<number>, idx?: ArrayLike<number>) {
  const n = idx ? idx.length : pos.length / 3;
  for (let t = 0; t + 2 < n; t += 3) {
    const a = (idx ? idx[t] : t) * 3,
      b = (idx ? idx[t + 1] : t + 1) * 3,
      c = (idx ? idx[t + 2] : t + 2) * 3;
    const ux = pos[b] - pos[a],
      uy = pos[b + 1] - pos[a + 1],
      uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a],
      vy = pos[c + 1] - pos[a + 1],
      vz = pos[c + 2] - pos[a + 2];
    // produto vetorial: normal com módulo igual ao dobro da área
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    hist.adicionar(nx, ny, nz, Math.hypot(nx, ny, nz) / 2);
  }
}

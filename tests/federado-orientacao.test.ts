import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adicionarFaces, amostrar, giroDaCaixa, HistogramaDirecoes } from '../src/modules/federacao/orcamento/orientacao';

const GRAU = Math.PI / 180;

/** Caixa (parede) de comprimento c, altura h e espessura e, girada `giro` em torno de Y (como Object3D.rotation.y). */
function parede(c: number, h: number, e: number, giro: number, dx = 0, dz = 0) {
  const cs = Math.cos(giro),
    sn = Math.sin(giro);
  const pos: number[] = [];
  for (const x of [0, c]) for (const y of [0, h]) for (const z of [0, e]) pos.push(dx + x * cs + z * sn, y, dz - x * sn + z * cs);
  // índice = x*4 + y*2 + z
  const quad = (a: number, b: number, c2: number, d: number) => [a, b, c2, a, c2, d];
  const idx = [
    ...quad(0, 1, 3, 2),
    ...quad(4, 6, 7, 5), // x = 0 / x = c
    ...quad(0, 4, 5, 1),
    ...quad(2, 3, 7, 6), // y = 0 / y = h (horizontais: não contam)
    ...quad(0, 2, 6, 4),
    ...quad(1, 5, 7, 3), // z = 0 / z = e
  ];
  return { pos, idx };
}

function giroDe(paredes: { pos: number[]; idx: number[] }[]) {
  const h = new HistogramaDirecoes();
  for (const p of paredes) adicionarFaces(h, p.pos, p.idx);
  return giroDaCaixa(h.angulo());
}

test('giro: prédio nos eixos do mundo fica sem giro', () => {
  assert.equal(giroDe([parede(10, 3, 0.2, 0), parede(6, 3, 0.2, Math.PI / 2, 10, 0)]), 0);
});

test('giro: acompanha o prédio girado, entre -45° e 45°', () => {
  for (const graus of [30, -20, 12.5, 70, 135, -60]) {
    const g = giroDe([parede(12, 3, 0.15, graus * GRAU), parede(8, 3, 0.15, graus * GRAU + Math.PI / 2, 4, 2)]);
    // mesmos eixos a menos de 90° (±45° são os mesmos eixos trocados)
    const dif = ((((g / GRAU - graus) % 90) + 135) % 90) - 45;
    assert.ok(Math.abs(dif) < 0.15, `${graus}° → ${g / GRAU}°`);
    assert.ok(Math.abs(g) <= Math.PI / 4 + 1e-9);
  }
});

test('giro: a direção com mais área de parede vence', () => {
  // corpo principal a 25° e um anexo pequeno a 0°
  const g = giroDe([parede(30, 3, 0.2, 25 * GRAU), parede(20, 3, 0.2, 115 * GRAU), parede(3, 3, 0.2, 0, 50, 50)]);
  assert.ok(Math.abs(g / GRAU - 25) < 0.15, `${g / GRAU}`);
});

test('giro: sem faces verticais, eixos do mundo', () => {
  const h = new HistogramaDirecoes();
  adicionarFaces(h, [0, 0, 0, 1, 0, 0, 0, 0, 1]); // um triângulo no piso
  assert.equal(h.angulo(), null);
  assert.equal(giroDaCaixa(h.angulo()), 0);
});

test('amostrar: espalha pela lista e respeita o tamanho', () => {
  assert.deepEqual(amostrar([1, 2, 3], 5), [1, 2, 3]);
  assert.deepEqual(amostrar([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 5), [0, 2, 4, 6, 8]);
  assert.deepEqual(amostrar([1, 2], 0), []);
});

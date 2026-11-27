import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decompor, escolherEncaixe, formatarMetros, type CandidatoEncaixe } from '../src/modules/federacao/orcamento/medicao-regras';

const c = (
  encaixe: CandidatoEncaixe<string>['encaixe'],
  distancia: number,
  pixels: number,
  modelo: string,
  valor = `${encaixe}-${modelo}-${distancia}`,
): CandidatoEncaixe<string> => ({ encaixe, distancia, pixels, modelo, valor });

test('decompor: distância total, horizontal (XZ) e vertical (Y)', () => {
  const d = decompor({ x: 0, y: 0, z: 0 }, { x: 3, y: 2.5, z: 4 });
  assert.equal(d.horizontal, 5);
  assert.equal(d.vertical, 2.5);
  assert.ok(Math.abs(d.distancia - Math.hypot(5, 2.5)) < 1e-12);
  assert.equal(decompor({ x: 1, y: 5, z: 1 }, { x: 1, y: 2, z: 1 }).vertical, 3);
});

test('formatarMetros: duas casas, vírgula decimal', () => {
  assert.equal(formatarMetros(3.4167), '3,42 m');
  assert.equal(formatarMetros(0.5), '0,50 m');
});

test('escolherEncaixe: vértice perto do ponteiro vence aresta e superfície', () => {
  const r = escolherEncaixe([c('face', 10, 0, 'arq'), c('aresta', 10, 2, 'arq'), c('vertice', 10.1, 9, 'arq')]);
  assert.equal(r?.encaixe, 'vertice');
});

test('escolherEncaixe: vértice longe do ponteiro não puxa; fica a aresta, senão a superfície', () => {
  assert.equal(escolherEncaixe([c('face', 10, 0, 'arq'), c('aresta', 10, 5, 'arq'), c('vertice', 10, 30, 'arq')])?.encaixe, 'aresta');
  assert.equal(escolherEncaixe([c('face', 10, 0, 'arq'), c('aresta', 10, 20, 'arq')])?.encaixe, 'face');
});

test('escolherEncaixe: superfície mais próxima entre os modelos', () => {
  assert.equal(escolherEncaixe([c('face', 12, 0, 'ele'), c('face', 8, 0, 'arq')])?.modelo, 'arq');
});

test('escolherEncaixe: vértice de outro modelo atrás da superfície não vale', () => {
  // eletroduto atrás da parede visível: o vértice dele está a 15 m, a parede a 10 m
  const r = escolherEncaixe([c('face', 10, 0, 'arq'), c('vertice', 15, 1, 'ele')]);
  assert.equal(r?.encaixe, 'face');
  // na frente da parede (ou encostado nela), vale
  assert.equal(escolherEncaixe([c('face', 10, 0, 'arq'), c('vertice', 10.01, 1, 'ele')])?.encaixe, 'vertice');
});

test('escolherEncaixe: sem nada sob o ponteiro', () => {
  assert.equal(escolherEncaixe([]), null);
  // só arestas (nenhuma superfície atingida): vale a mais próxima do ponteiro
  assert.equal(escolherEncaixe([c('aresta', 10, 6, 'a', 'x'), c('aresta', 20, 3, 'b', 'y')])?.valor, 'y');
});

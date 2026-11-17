import test from 'node:test';
import assert from 'node:assert/strict';
import { lobCriticalPath } from '../src/domain/lob-critical';
import type { LobActivity, LobDependency, LobDependencyKind } from '../src/domain/lob';

/** 02/11/2026 é segunda-feira; 09/11, 16/11 e 23/11 também. */
const NOW = '2026-11-01T12:00:00.000Z';
const act = (id: string, start: string, durationDays: number): LobActivity => ({
  id,
  workId: 'w',
  serviceId: 's',
  localId: 'l',
  start,
  durationDays,
  createdAt: NOW,
  updatedAt: NOW,
});
const dep = (predecessorId: string, successorId: string, lagDays = 0, kind: LobDependencyKind = 'fs'): LobDependency => ({
  id: `${predecessorId}>${successorId}`,
  workId: 'w',
  predecessorId,
  successorId,
  lagDays,
  kind,
  createdAt: NOW,
});

test('obra vazia não tem caminho crítico', () => {
  const result = lobCriticalPath([], []);
  assert.equal(result.end, undefined);
  assert.equal(result.criticalIds.size, 0);
});

test('cadeia encostada é toda crítica; o ramo curto tem folga', () => {
  // a (5 d) → b (5 d) → c (5 d) encostados; x (2 d) também depende de a e termina bem antes do fim.
  const activities = [act('a', '2026-11-02', 5), act('b', '2026-11-09', 5), act('c', '2026-11-16', 5), act('x', '2026-11-09', 2)];
  const result = lobCriticalPath(activities, [dep('a', 'b'), dep('b', 'c'), dep('a', 'x')]);
  assert.equal(result.end, '2026-11-23');
  assert.deepEqual([...result.criticalIds].sort(), ['a', 'b', 'c']);
  assert.equal(result.floatDays.get('a'), 0);
  // x pode terminar até o fim da obra: 10 dias úteis de 09/11 a 23/11, menos os 2 de duração.
  assert.equal(result.floatDays.get('x'), 8);
});

test('folga dada à mão entre dois blocos tira a predecessora do caminho crítico', () => {
  // b começa uma semana depois do mínimo: a pode atrasar 5 dias úteis sem empurrar ninguém.
  const activities = [act('a', '2026-11-02', 5), act('b', '2026-11-16', 5)];
  const result = lobCriticalPath(activities, [dep('a', 'b')]);
  assert.equal(result.floatDays.get('a'), 5);
  assert.deepEqual([...result.criticalIds], ['b']);
});

test('a espera da dependência entra na conta, inclusive negativa', () => {
  // Espera de 5 dias úteis: a termina em 06/11, b só pode começar em 16/11 e está lá.
  const waited = lobCriticalPath([act('a', '2026-11-02', 5), act('b', '2026-11-16', 5)], [dep('a', 'b', 5)]);
  assert.deepEqual([...waited.criticalIds].sort(), ['a', 'b']);
  // Espera negativa (takt menor que a duração): b pode começar 2 dias antes do fim de a.
  const overlap = lobCriticalPath([act('a', '2026-11-02', 5), act('b', '2026-11-05', 5)], [dep('a', 'b', -2, 'crew')]);
  assert.deepEqual([...overlap.criticalIds].sort(), ['a', 'b']);
});

test('bloco sem dependências só é crítico se termina no fim da obra', () => {
  const result = lobCriticalPath([act('a', '2026-11-02', 5), act('b', '2026-11-02', 10)], []);
  assert.deepEqual([...result.criticalIds], ['b']);
  assert.equal(result.floatDays.get('a'), 5);
});

test('dependência violada dá folga negativa e conta como crítica', () => {
  // b deveria começar depois de a, mas está antes: a folga de a fica negativa.
  const result = lobCriticalPath([act('a', '2026-11-09', 5), act('b', '2026-11-09', 5)], [dep('a', 'b')]);
  assert.ok((result.floatDays.get('a') ?? 0) < 0);
  assert.ok(result.criticalIds.has('a'));
});

test('ciclo e dependência para bloco inexistente não travam o cálculo', () => {
  const activities = [act('a', '2026-11-02', 5), act('b', '2026-11-09', 5), act('c', '2026-11-02', 3)];
  const result = lobCriticalPath(activities, [dep('a', 'b'), dep('b', 'a'), dep('c', 'fantasma'), dep('c', 'c')]);
  // a e b estão presos no ciclo e ficam de fora; c é calculado normalmente.
  assert.equal(result.floatDays.has('a'), false);
  assert.equal(result.floatDays.has('b'), false);
  assert.equal(result.floatDays.get('c'), 7);
});

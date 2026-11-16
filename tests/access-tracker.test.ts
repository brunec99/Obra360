import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ActiveClock,
  FLUSH_MS,
  IDLE_MS,
  MAX_SEND_SECONDS,
  MAX_STEP_MS,
  TICK_MS,
  accessPayload,
  fieldWorkId,
} from '../src/modules/acessos/active-clock';

/** Tempo ativo no navegador (aba "Acessos" do Dashboard geral, 15/11/2026), com relógio falso em ms. */

const SCREEN = '/obras/abc/curto-prazo';
const S = 1_000;
const MIN = 60 * S;

/** Ticks do navegador a cada 5 s de `from` (exclusivo) até `to` (inclusivo); o último cai em `to`. */
function tickUntil(clock: ActiveClock, from: number, to: number, step = TICK_MS) {
  for (let now = from + step; now < to; now += step) clock.tick(now);
  clock.tick(to);
}

test('as constantes aprovadas', () => {
  assert.equal(IDLE_MS, 5 * MIN);
  assert.equal(FLUSH_MS, MIN);
  assert.equal(MAX_STEP_MS, 15 * S);
  assert.equal(MAX_SEND_SECONDS, 120);
  assert.equal(TICK_MS, 5 * S);
});

test('uso contínuo soma o tempo todo', () => {
  const clock = new ActiveClock(SCREEN, 0);
  // Clique a cada 20 s e tick a cada 5 s por 90 s.
  for (let now = TICK_MS; now <= 90 * S; now += TICK_MS) {
    if (now % (20 * S) === 0) clock.interact(now);
    else clock.tick(now);
  }
  assert.equal(clock.accumulatedMs, 90 * S);
  assert.equal(clock.take(90 * S), 90);
});

test('carregar a página conta como interação: sem mexer em nada, conta 5 min e para', () => {
  const clock = new ActiveClock(SCREEN, 0);
  tickUntil(clock, 0, 20 * MIN);
  assert.equal(clock.accumulatedMs, IDLE_MS);
});

test('parado mais de 5 min corta exatamente no limite, mesmo com o corte no meio do intervalo', () => {
  const clock = new ActiveClock(SCREEN, 0);
  clock.interact(2 * S);
  // Ticks de 7 s: 0 → 7 → … → 301 → 308. O limite é 302 s; o intervalo 301–308 conta só 1 s.
  tickUntil(clock, 0, 10 * MIN, 7 * S);
  assert.equal(clock.accumulatedMs, 2 * S + IDLE_MS);
});

test('interagir depois de parado não conta o tempo parado para trás', () => {
  const clock = new ActiveClock(SCREEN, 0);
  tickUntil(clock, 0, 10 * MIN);
  clock.interact(10 * MIN);
  assert.equal(clock.accumulatedMs, IDLE_MS);
  tickUntil(clock, 10 * MIN, 10 * MIN + 20 * S);
  assert.equal(clock.accumulatedMs, IDLE_MS + 20 * S);
});

test('aba escondida não conta', () => {
  const clock = new ActiveClock(SCREEN, 0);
  tickUntil(clock, 0, 30 * S);
  clock.setVisible(false, 32 * S);
  tickUntil(clock, 32 * S, 3 * MIN);
  clock.interact(3 * MIN); // evento perdido com a aba escondida não faz contar
  tickUntil(clock, 3 * MIN, 4 * MIN);
  assert.equal(clock.accumulatedMs, 32 * S);
  assert.equal(clock.isVisible, false);
});

test('a página aberta já escondida não conta até ficar visível', () => {
  const clock = new ActiveClock(SCREEN, 0, false);
  tickUntil(clock, 0, 2 * MIN);
  assert.equal(clock.accumulatedMs, 0);
  clock.setVisible(true, 2 * MIN);
  tickUntil(clock, 2 * MIN, 2 * MIN + 10 * S);
  assert.equal(clock.accumulatedMs, 10 * S);
});

test('voltar a ficar visível conta como interação e volta a contar', () => {
  const clock = new ActiveClock(SCREEN, 0);
  tickUntil(clock, 0, 10 * S);
  clock.setVisible(false, 10 * S);
  // Escondida por 20 min: bem além dos 5 min sem interação.
  tickUntil(clock, 10 * S, 20 * MIN);
  clock.setVisible(true, 20 * MIN);
  tickUntil(clock, 20 * MIN, 20 * MIN + 30 * S);
  assert.equal(clock.accumulatedMs, 40 * S);
  // Sem nova interação, conta 5 min desde a volta e para.
  tickUntil(clock, 20 * MIN + 30 * S, 40 * MIN);
  assert.equal(clock.accumulatedMs, 10 * S + IDLE_MS);
});

test('salto de timer (aba dormindo, computador suspenso) soma no máximo 15 s de uma vez', () => {
  const clock = new ActiveClock(SCREEN, 0);
  clock.tick(5 * S);
  clock.tick(4 * MIN); // dentro dos 5 min, mas 235 s de uma vez
  assert.equal(clock.accumulatedMs, 5 * S + MAX_STEP_MS);
  // A interação depois do salto também passa pelo teto.
  clock.interact(4 * MIN + 50 * S);
  assert.equal(clock.accumulatedMs, 5 * S + 2 * MAX_STEP_MS);
});

test('relógio que volta não desconta nem inventa tempo', () => {
  const clock = new ActiveClock(SCREEN, 100 * S);
  clock.tick(105 * S);
  clock.tick(50 * S);
  clock.tick(55 * S);
  assert.equal(clock.accumulatedMs, 10 * S);
});

test('take devolve segundos inteiros e guarda o resto para o próximo envio da mesma tela', () => {
  const clock = new ActiveClock(SCREEN, 0);
  clock.tick(900);
  assert.equal(clock.take(900), 0, 'abaixo de 1 s não envia');
  assert.equal(clock.accumulatedMs, 900);
  clock.tick(2_500);
  assert.equal(clock.take(2_500), 2);
  assert.equal(clock.accumulatedMs, 500);
  assert.equal(clock.take(3_700), 1); // 0,5 s guardado + 1,2 s novos
  assert.equal(clock.accumulatedMs, 700);
  assert.ok(Number.isInteger(clock.take(9_999)));
});

test('take já contabiliza até o instante do envio', () => {
  const clock = new ActiveClock(SCREEN, 0);
  clock.tick(5 * S);
  assert.equal(clock.take(8 * S), 8);
});

test('teto de 120 s por envio: o excesso é descartado', () => {
  const clock = new ActiveClock(SCREEN, 0);
  for (let now = TICK_MS; now <= 200 * S + 400; now += TICK_MS) clock.interact(now);
  clock.tick(200 * S + 400);
  assert.equal(clock.accumulatedMs, 200 * S + 400);
  assert.equal(clock.take(200 * S + 400), MAX_SEND_SECONDS);
  assert.equal(clock.accumulatedMs, 0);
});

test('o envio periódico vence a cada 60 s desde o último take', () => {
  const clock = new ActiveClock(SCREEN, 0);
  assert.equal(clock.flushDue(59 * S), false);
  assert.equal(clock.flushDue(60 * S), true);
  clock.take(60 * S);
  assert.equal(clock.flushDue(100 * S), false);
  assert.equal(clock.flushDue(120 * S), true);
});

test('troca de tela devolve o acumulado da anterior e a nova começa do zero', () => {
  const clock = new ActiveClock(SCREEN, 0);
  tickUntil(clock, 0, 42_300);
  const previous = clock.switchScreen('/dashboard', 42_300);
  assert.deepEqual(previous, { path: SCREEN, seconds: 42 });
  assert.equal(clock.path, '/dashboard');
  assert.equal(clock.accumulatedMs, 0, 'o resto abaixo de 1 s era da tela anterior');
  assert.equal(clock.flushDue(42_300 + 59 * S), false, 'o envio da troca reinicia o intervalo de 60 s');
  tickUntil(clock, 42_300, 42_300 + 15 * S);
  assert.equal(clock.take(42_300 + 15 * S), 15);
});

test('abrir a tela nova conta como interação', () => {
  const clock = new ActiveClock(SCREEN, 0);
  tickUntil(clock, 0, 6 * MIN); // parou aos 5 min
  clock.switchScreen('/dashboard', 6 * MIN);
  tickUntil(clock, 6 * MIN, 6 * MIN + 20 * S);
  assert.equal(clock.take(6 * MIN + 20 * S), 20);
});

test('trocar para a mesma tela não envia nem zera', () => {
  const clock = new ActiveClock(SCREEN, 0);
  tickUntil(clock, 0, 10 * S);
  assert.deepEqual(clock.switchScreen(SCREEN, 10 * S), { path: SCREEN, seconds: 0 });
  assert.equal(clock.accumulatedMs, 10 * S);
});

test('obra do modo de campo vem de ?obra= só nas telas /campo/', () => {
  assert.equal(fieldWorkId('/campo/seguranca', '?obra=abc'), 'abc');
  assert.equal(fieldWorkId('/campo/terminalidade', '?x=1&obra=w%201'), 'w 1');
  assert.equal(fieldWorkId('/campo/seguranca', ''), null);
  assert.equal(fieldWorkId('/campo/seguranca', '?obra='), null);
  assert.equal(fieldWorkId('/obras/abc/seguranca', '?obra=abc'), null);
});

test('corpo do envio: workId só quando existe', () => {
  assert.deepEqual(accessPayload('/dashboard', 60, null), { path: '/dashboard', seconds: 60 });
  assert.deepEqual(accessPayload('/campo/seguranca', 12, 'abc'), { path: '/campo/seguranca', seconds: 12, workId: 'abc' });
  assert.equal('workId' in accessPayload('/dashboard', 60, null), false);
});

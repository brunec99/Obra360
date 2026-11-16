import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthGrid, shiftMonth } from '../src/modules/medio-prazo/month-grid';

test('calendário do médio prazo: seis semanas de domingo a sábado em volta do mês', () => {
  // Novembro/2026 começa num domingo: a grade abre no próprio dia 1.
  const nov = monthGrid('2026-11');
  assert.equal(nov.length, 42);
  assert.equal(nov[0], '2026-11-01');
  assert.equal(nov[29], '2026-11-30');
  assert.equal(nov[41], '2026-12-12');
  // Agosto/2026 começa num sábado: a primeira semana traz 26 a 31 de julho.
  const aug = monthGrid('2026-08');
  assert.equal(aug[0], '2026-07-26');
  assert.equal(aug[6], '2026-08-01');
  assert.equal(new Date(`${aug[0]}T00:00:00Z`).getUTCDay(), 0);
  // Fevereiro de ano bissexto termina no dia 29.
  assert.ok(monthGrid('2028-02').includes('2028-02-29'));
  assert.ok(!monthGrid('2027-02').includes('2027-02-29'));
});

test('calendário do médio prazo: avançar e voltar meses atravessa a virada do ano', () => {
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2026-11', 0), '2026-11');
  assert.equal(shiftMonth('2026-11', -13), '2025-10');
});

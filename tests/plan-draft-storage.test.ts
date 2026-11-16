import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CALENDAR } from '../src/domain/plan-schedule';
import type { PlanTask } from '../src/domain/entities';
import {
  DRAFT_PREFIX,
  decideRecovery,
  draftKey,
  formatSavedAt,
  hashText,
  parseDraft,
  serializeDraft,
  type DraftContent,
} from '../src/modules/medio-prazo/draft-storage';

// Rascunho automático do cronograma do médio prazo (16/11/2026).
const task = (id: string, extra: Partial<PlanTask> = {}): PlanTask => ({
  id,
  createdAt: '2026-11-01T12:00:00Z',
  updatedAt: '2026-11-01T12:00:00Z',
  planId: 'plano-1',
  name: `Tarefa ${id}`,
  plannedStart: '2026-11-03',
  plannedEnd: '2026-11-04',
  progress: 0,
  order: 0,
  level: 0,
  ...extra,
});
const content = (name = 'Alvenaria'): DraftContent => ({
  tasks: [task('t1', { name }), task('t2', { order: 1 })],
  links: [{ id: 'l1', createdAt: '', updatedAt: '', predecessorId: 't1', successorId: 't2', type: 'TI', lagDays: 0, lagBusiness: true }],
  calendar: structuredClone(DEFAULT_CALENDAR),
});
const stored = (draft: DraftContent, baseHash = 'abc', extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    ...JSON.parse(serializeDraft({ actorId: 'user-2', planId: 'plano-1', savedAt: '2026-11-16T17:32:00.000Z', baseHash, draft })),
    ...extra,
  });
const ctx = (current: DraftContent, currentHash = 'abc') => ({ actorId: 'user-2', planId: 'plano-1', current, currentHash });

test('chave por pessoa e por cronograma, com versão do formato', () => {
  assert.equal(draftKey('user-2', 'plano-1'), 'obra360.medio-prazo.rascunho.v1.user-2.plano-1');
  assert.ok(draftKey('a', 'b').startsWith(DRAFT_PREFIX));
  assert.notEqual(draftKey('user-1', 'plano-1'), draftKey('user-2', 'plano-1'));
});

test('impressão digital: determinística e sensível a qualquer mudança', () => {
  const snapshot = JSON.stringify(content());
  assert.equal(hashText(snapshot), hashText(snapshot));
  assert.notEqual(hashText(snapshot), hashText(JSON.stringify(content('Reboco'))));
  assert.notEqual(hashText('a'), hashText('b'));
  assert.match(hashText(''), /^[0-9a-z]+$/);
});

test('ida e volta: o que foi guardado volta igual', () => {
  const draft = content('Alvenaria do 2º pavimento');
  const parsed = parseDraft(stored(draft), 'user-2', 'plano-1');
  assert.ok(parsed);
  assert.deepEqual(parsed.draft, draft);
  assert.equal(parsed.baseHash, 'abc');
  assert.equal(parsed.savedAt, '2026-11-16T17:32:00.000Z');
});

test('texto corrompido, outro formato, outra pessoa, outro cronograma ou tarefa estranha: ignorado', () => {
  const draft = content();
  const cases: [string, string | null][] = [
    ['vazio', null],
    ['corrompido', '{"v":1,"draft":'],
    ['não é objeto', '[1,2]'],
    ['outra versão', stored(draft, 'abc', { v: 2 })],
    ['outra pessoa', stored(draft, 'abc', { actorId: 'user-1' })],
    ['outro cronograma', stored(draft, 'abc', { planId: 'plano-2' })],
    ['data inválida', stored(draft, 'abc', { savedAt: 'ontem' })],
    ['sem impressão digital', stored(draft, '')],
    ['sem tarefas', stored({ ...draft, tasks: 'x' as unknown as PlanTask[] })],
    ['tarefa de outro plano', stored({ ...draft, tasks: [task('t1', { planId: 'plano-2' })] })],
    ['tarefa sem nome', stored({ ...draft, tasks: [{ ...task('t1'), name: undefined } as unknown as PlanTask] })],
    ['vínculo quebrado', stored({ ...draft, links: [{ predecessorId: 1 }] as never })],
    ['calendário sem dias', stored({ ...draft, calendar: {} as never })],
  ];
  for (const [label, raw] of cases) assert.equal(parseDraft(raw, 'user-2', 'plano-1'), undefined, label);
});

test('decideRecovery: sem chave, nada; inválido ou igual ao gravado, apagar; diferente, restaurar', () => {
  const current = content();
  assert.deepEqual(decideRecovery(null, ctx(current)), { kind: 'none' });
  assert.deepEqual(decideRecovery('{lixo', ctx(current)), { kind: 'discard' });
  assert.deepEqual(decideRecovery(stored(content()), ctx(current)), { kind: 'discard' });
  const edited = content('Alvenaria revisada');
  const result = decideRecovery(stored(edited), ctx(current));
  assert.equal(result.kind, 'restore');
  assert.ok(result.kind === 'restore');
  assert.deepEqual(result.stored.draft, edited);
  assert.equal(result.stale, false);
});

test('decideRecovery: cronograma gravado mudou depois do rascunho = desatualizado', () => {
  const result = decideRecovery(stored(content('Editado'), 'hash-antigo'), ctx(content(), 'hash-novo'));
  assert.ok(result.kind === 'restore');
  assert.equal(result.stale, true);
  assert.equal(result.stored.baseHash, 'hash-antigo');
});

test('formatSavedAt: dia/mês às hora:minuto, no fuso pedido', () => {
  assert.equal(formatSavedAt('2026-11-16T17:32:00.000Z', 'America/Sao_Paulo'), '16/11 às 14:32');
  assert.equal(formatSavedAt('2026-01-05T03:07:00.000Z', 'America/Sao_Paulo'), '05/01 às 00:07');
});

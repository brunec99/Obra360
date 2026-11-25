import test from 'node:test';
import assert from 'node:assert/strict';
import type { LobActivity, LobDependency } from '../src/domain/lob';
import { buildPrevisionImport, type PrevisionApiProject, type PrevisionSchedule } from '../src/domain/lob-prevision-import';
import {
  planDependencyReplacement,
  previsionLinkLag,
  reconstructDeducedDependencies,
  replacementBaseline,
  translatePrevisionLinks,
  type DeducedDependency,
  type DependencyReplacementInput,
  type RealLink,
} from '../src/domain/lob-dependency-replacement';

/** Novembro de 2026: 02/11 é segunda-feira. */
const IMPORTED_AT = '2026-11-11T03:01:43.399Z';
const MANUAL_AT = '2026-11-23T23:19:44.306Z';
const NOW = '2026-11-25T18:00:00.000Z';

const act = (id: string, serviceId: string, localId: string, start: string, durationDays: number): LobActivity => ({
  id,
  workId: 'w',
  serviceId,
  localId,
  start,
  durationDays,
  createdAt: IMPORTED_AT,
  updatedAt: IMPORTED_AT,
});
const dep = (
  id: string,
  p: string,
  s: string,
  lagDays: number,
  createdAt = IMPORTED_AT,
  kind: LobDependency['kind'] = 'fs',
): LobDependency => ({
  id,
  workId: 'w',
  predecessorId: p,
  successorId: s,
  lagDays,
  kind,
  createdAt,
});
const real = (p: string, s: string, delayDays: number, from: RealLink['from'] = 'finish', to: RealLink['to'] = 'start'): RealLink => ({
  predecessorId: p,
  successorId: s,
  from,
  to,
  delayDays,
});
const deduced = (p: string, s: string, lagDays: number, kind: DeducedDependency['kind'] = 'fs'): DeducedDependency => ({
  predecessorId: p,
  successorId: s,
  lagDays,
  kind,
});
const plan = (
  input: Partial<DependencyReplacementInput> & Pick<DependencyReplacementInput, 'activities' | 'dependencies' | 'realLinks'>,
) => {
  let n = 0;
  return planDependencyReplacement({ workId: 'w', importedAt: IMPORTED_AT, newId: () => `nova-${++n}`, now: NOW, ...input });
};
const pair = (d: { predecessorId: string; successorId: string }) => `${d.predecessorId}→${d.successorId}`;

// A (S1, L1) 02–06/11 → B (S2, L1) 09–13/11 → C (S3, L1) 16–20/11; D (S1, L2) 09–13/11; E (S2, L2) 16–20/11.
const A = act('A', 'S1', 'L1', '2026-11-02', 5);
const B = act('B', 'S2', 'L1', '2026-11-09', 5);
const C = act('C', 'S3', 'L1', '2026-11-16', 5);
const D = act('D', 'S1', 'L2', '2026-11-09', 5);
const E = act('E', 'S2', 'L2', '2026-11-16', 5);

test('defasagem do Prevision em dias úteis: término + 1 é espera zero; início → início e término → término viram espera negativa', () => {
  const p = { start: '2026-11-02', durationDays: 5 };
  const s = { start: '2026-11-09', durationDays: 3 };
  assert.equal(previsionLinkLag(real('p', 's', 1), p, s), 0);
  // Seis dias úteis depois da sexta 06/11: segunda 16/11, ou seja, cinco dias úteis de espera.
  assert.equal(previsionLinkLag(real('p', 's', 6), p, s), 5);
  assert.equal(previsionLinkLag(real('p', 's', -2), p, s), -3);
  assert.equal(previsionLinkLag(real('p', 's', 0, 'start', 'start'), p, s), -5);
  assert.equal(previsionLinkLag(real('p', 's', 2, 'start', 'start'), p, s), -3);
  // Término → término: a sucessora (3 dias) termina na sexta 06/11, então começa na quarta 04/11.
  assert.equal(previsionLinkLag(real('p', 's', 0, 'finish', 'finish'), p, s), -3);
  // Com um feriado no meio, a espera continua em dias úteis.
  const calendar = { weekdays: [1, 2, 3, 4, 5], holidays: ['2026-11-10'] };
  assert.equal(previsionLinkLag(real('p', 's', 6), p, s, calendar), 5);
});

test('remove as deduzidas, mantém as criadas à mão, troca a espera diferente e insere as reais que faltam', () => {
  const result = plan({
    activities: [A, B, C, D, E],
    dependencies: [
      dep('d1', 'A', 'B', 0), // deduzida igual ao Prevision
      dep('d2', 'B', 'C', 0), // deduzida que não está no Prevision
      dep('d3', 'A', 'D', 0, IMPORTED_AT, 'crew'), // deduzida com outra espera no Prevision
      dep('m1', 'B', 'E', 0, MANUAL_AT), // à mão, também no Prevision (com outra espera)
      dep('m2', 'D', 'E', 0, MANUAL_AT), // à mão, fora do Prevision
    ],
    realLinks: [real('A', 'B', 1), real('A', 'D', 2, 'start', 'start'), real('B', 'E', 3), real('D', 'C', 1)],
    deduced: [deduced('A', 'B', 0), deduced('B', 'C', 0), deduced('A', 'D', 0, 'crew')],
  });
  assert.equal(result.reconstruction.status, 'ok');
  assert.deepEqual(
    result.remove.map(r => [r.dependency.id, r.reason]),
    [
      ['d3', 'troca-de-espera'],
      ['d2', 'deduzida'],
    ],
  );
  assert.deepEqual(
    result.insert.map(i => [pair(i.dependency), i.dependency.lagDays, i.dependency.kind, i.replaces]),
    [
      ['A→D', -3, 'crew', 'd3'],
      ['D→C', 0, 'fs', undefined],
    ],
  );
  assert.deepEqual(
    result.kept.map(k => [k.dependency.id, k.reason]),
    [
      ['d1', 'deduzida-igual-ao-prevision'],
      ['m1', 'manual-tambem-no-prevision'],
      ['m2', 'manual'],
    ],
  );
  // A ligação à mão fica com a espera dela, mesmo o Prevision pedindo outra.
  assert.equal(result.kept.find(k => k.dependency.id === 'm1')!.dependency.lagDays, 0);
  assert.equal(result.kept.find(k => k.dependency.id === 'm1')!.link!.wantedLag, 2);
  assert.deepEqual(result.finalDependencies.map(pair).sort(), ['A→B', 'A→D', 'B→E', 'D→C', 'D→E']);
  assert.deepEqual(result.cycles, []);
  assert.deepEqual(result.moved, []);
});

test('não recria a deduzida apagada à mão, mesmo que ela esteja no Prevision', () => {
  const result = plan({
    activities: [A, B, C, E],
    dependencies: [dep('d1', 'A', 'B', 0), dep('d2', 'B', 'C', 0)],
    realLinks: [real('A', 'B', 1), real('B', 'C', 1), real('C', 'E', 1)],
    // A importação deduziu também C → E, que o engenheiro apagou.
    deduced: [deduced('A', 'B', 0), deduced('B', 'C', 0), deduced('C', 'E', -5)],
  });
  assert.equal(result.reconstruction.status, 'ok');
  assert.deepEqual(result.reconstruction.deleted.map(pair), ['C→E']);
  assert.deepEqual(
    result.ignored.map(i => [i.reason, pair(i.link!)]),
    [['apagada-a-mao', 'C→E']],
  );
  assert.deepEqual(result.insert, []);
  assert.deepEqual(result.remove, []);
  assert.deepEqual(result.conflicts, []);
});

test('conflito: o Prevision pede mais que a folga atual; a espera gravada fica na folga e nada se move', () => {
  const result = plan({
    activities: [A, C],
    dependencies: [],
    // Término + 8 dias úteis: a C teria de começar na quarta 18/11, mas começa na segunda 16/11.
    realLinks: [real('A', 'C', 8)],
    deduced: [],
  });
  assert.equal(result.insert.length, 1);
  const [conflict] = result.conflicts;
  assert.equal(conflict.status, 'nova');
  assert.equal(conflict.link.wantedLag, 7);
  assert.equal(conflict.link.gap, 5);
  assert.equal(conflict.link.lagDays, 5);
  assert.equal(conflict.link.conflictDays, 2);
  assert.equal(conflict.link.minimumStart, '2026-11-18');
  assert.deepEqual(result.moved, []);
});

test('conflito em deduzida mantida e conferência nas datas do próprio Prevision', () => {
  const result = plan({
    activities: [A, B],
    dependencies: [dep('d1', 'A', 'B', 0)],
    realLinks: [
      {
        ...real('A', 'B', 3),
        // No Prevision, a B começava na quarta 11/11: o vínculo era cumprido lá.
        prevision: { predecessor: { start: '2026-11-02', finish: '2026-11-06' }, successor: { start: '2026-11-11', finish: '2026-11-17' } },
      },
    ],
    deduced: [deduced('A', 'B', 0)],
  });
  assert.deepEqual(
    result.kept.map(k => k.reason),
    ['deduzida-igual-ao-prevision'],
  );
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].status, 'mantida');
  assert.equal(result.conflicts[0].link.conflictDays, 2);
  assert.equal(result.conflicts[0].link.previsionConflictDays, 0);
});

test('ciclo entre uma ligação à mão e uma real é apontado', () => {
  const result = plan({
    activities: [A, B],
    dependencies: [dep('m1', 'B', 'A', -10, MANUAL_AT)],
    realLinks: [real('A', 'B', 1)],
    deduced: [],
  });
  assert.equal(result.cycles.length, 1);
  assert.deepEqual(result.cycles[0].activityIds.sort(), ['A', 'B']);
  assert.deepEqual(result.cycles[0].dependencies.map(d => `${pair(d)} ${d.origin}`).sort(), ['A→B nova', 'B→A manual']);
  assert.deepEqual(result.moved, []);
});

test('sem a reconstrução validada, os pares que não dá para saber ficam a conferir', () => {
  const dependencies = [dep('d1', 'A', 'B', 0), dep('d2', 'D', 'E', 0)];
  const realLinks = [real('A', 'C', 1), real('B', 'E', 1), real('C', 'D', 1, 'start', 'start')];
  // A reconstrução não reproduz D → E: nos blocos D e E não dá para saber o que foi apagado.
  const failed = plan({ activities: [A, B, C, D, E], dependencies, realLinks, deduced: [deduced('A', 'B', 0)] });
  assert.equal(failed.reconstruction.status, 'falhou');
  assert.deepEqual(
    failed.reconstruction.unexplained.map(d => d.id),
    ['d2'],
  );
  assert.deepEqual(
    failed.insert.map(i => pair(i.dependency)),
    ['A→C'],
  );
  assert.deepEqual(
    failed.ignored.map(i => [i.reason, pair(i.link!)]),
    [
      ['a-conferir', 'B→E'],
      ['a-conferir', 'C→D'],
    ],
  );
  // Sem reconstrução nenhuma, nada novo entra.
  const absent = plan({ activities: [A, B, C, D, E], dependencies, realLinks });
  assert.equal(absent.reconstruction.status, 'ausente');
  assert.deepEqual(absent.insert, []);
  assert.equal(absent.ignored.filter(i => i.reason === 'a-conferir').length, 3);
  // As deduzidas continuam saindo: só o que entra depende da reconstrução.
  assert.deepEqual(absent.remove.map(r => r.dependency.id).sort(), ['d1', 'd2']);
});

test('vínculos do Prevision vão para os blocos da obra pelo nome do serviço e do local', () => {
  const project: PrevisionApiProject = {
    id: '1',
    name: 'Obra',
    scheduleType: 'lob',
    floors: [
      { id: 'f2', name: '2º Pavto', position: 2 },
      { id: 'f3', name: '3º  pavto', position: 1 },
    ],
    services: [
      { id: 's1', name: 'Alvenária' },
      { id: 's2', name: 'Reboco' },
      { id: 's3', name: 'Pintura' },
    ],
    activities: [
      { id: 'a1', serviceId: 's1', floorId: 'f2', startAt: '2026-11-02 00:00:00 UTC', endAt: '2026-11-06 23:59:59 UTC', predecessors: [] },
      {
        id: 'a2',
        serviceId: 's2',
        floorId: 'f2',
        startAt: '2026-11-09 00:00:00 UTC',
        endAt: '2026-11-13 23:59:59 UTC',
        predecessors: [{ predecessorId: 'a1', baseAttribute: 'end_at', precedenceAttribute: 'start', timeOperation: 'after', delay: 1 }],
      },
      {
        id: 'a3',
        serviceId: 's1',
        floorId: 'f3',
        startAt: '2026-11-09 00:00:00 UTC',
        endAt: '2026-11-13 23:59:59 UTC',
        predecessors: [{ predecessorId: 'a1', baseAttribute: 'start_at', precedenceAttribute: 'start', timeOperation: 'before', delay: 2 }],
      },
      {
        id: 'a4',
        serviceId: 's3',
        floorId: 'f2',
        startAt: '2026-11-16 00:00:00 UTC',
        endAt: '2026-11-20 23:59:59 UTC',
        predecessors: [{ predecessorId: 'a2', baseAttribute: 'end_at', precedenceAttribute: 'start', timeOperation: 'after', delay: 1 }],
      },
    ],
  };
  const stamp = { workId: 'w', createdAt: NOW, updatedAt: NOW };
  const work = {
    services: [
      { id: 'alv', name: 'ALVENARIA', color: '#000000', orderIndex: 0, ...stamp },
      { id: 'reb', name: 'Reboco', color: '#000000', orderIndex: 1, ...stamp },
    ],
    locals: [
      { id: 'p2', name: '2º pavto', orderIndex: 0, ...stamp },
      { id: 'p3', name: '3º Pavto', orderIndex: 1, ...stamp },
    ],
    activities: [act('x1', 'alv', 'p2', '2026-11-02', 5), act('x2', 'reb', 'p2', '2026-11-09', 5), act('x3', 'alv', 'p3', '2026-11-09', 5)],
  };
  const result = translatePrevisionLinks(project, work);
  assert.equal(result.total, 3);
  assert.deepEqual(
    result.links.map(l => [pair(l), l.from, l.to, l.delayDays]),
    [
      ['x1→x2', 'finish', 'start', 1],
      ['x1→x3', 'start', 'start', -2],
    ],
  );
  assert.deepEqual(result.links[0].prevision, {
    predecessor: { start: '2026-11-02', finish: '2026-11-06' },
    successor: { start: '2026-11-09', finish: '2026-11-13' },
  });
  assert.deepEqual(result.missingBlocks, ['Pintura › 2º Pavto']);
  assert.deepEqual(result.unmatched, [
    { predecessor: 'Reboco › 2º Pavto', successor: 'Pintura › 2º Pavto', reason: 'sucessora sem bloco na obra' },
  ]);
  assert.deepEqual(result.extraActivities, []);
});

test('reconstrução refaz as ligações deduzidas pela importação a partir da linha de base dela', () => {
  const block = (serviceName: string, localName: string, start: string, finish: string) => ({
    serviceName,
    localName,
    start,
    finish,
    workDays: 5,
    percent: 0,
  });
  const schedule: PrevisionSchedule = {
    services: ['Alvenaria', 'Reboco'],
    locals: [
      { name: '2º pavto', group: 'pavimento_tipo' },
      { name: '3º pavto', group: 'pavimento_tipo' },
      { name: '4º pavto', group: 'pavimento_tipo' },
    ],
    blocks: [
      block('Alvenaria', '2º pavto', '2026-11-02', '2026-11-06'),
      block('Alvenaria', '3º pavto', '2026-11-09', '2026-11-13'),
      block('Alvenaria', '4º pavto', '2026-11-16', '2026-11-20'),
      block('Reboco', '2º pavto', '2026-11-16', '2026-11-20'),
      block('Reboco', '3º pavto', '2026-11-23', '2026-11-27'),
      block('Reboco', '4º pavto', '2026-11-30', '2026-12-04'),
    ],
    warnings: [],
  };
  let n = 0;
  const imported = buildPrevisionImport(schedule, {
    workId: 'w',
    workName: 'Obra',
    actorId: 'ator',
    now: IMPORTED_AT,
    newId: () => `id-${++n}`,
    measurementDate: '2026-11-11',
    sourceName: 'Obra.xml',
  });
  // Depois da importação o engenheiro mexe nas datas: a reconstrução usa as da linha de base.
  const moved = imported.activities.map(a => ({ ...a, start: '2027-01-04' }));
  const rebuilt = reconstructDeducedDependencies({
    workId: 'w',
    workName: 'Obra',
    baseline: imported.baseline,
    services: imported.services,
    locals: imported.localOrder.map(l => l.local),
    activities: moved,
  });
  assert.equal(rebuilt.error, undefined);
  assert.equal(rebuilt.missingActivities, 0);
  const sorted = (list: DeducedDependency[]) => list.map(d => `${pair(d)} ${d.lagDays} ${d.kind}`).sort();
  assert.ok(imported.dependencies.length >= 7);
  assert.deepEqual(sorted(rebuilt.dependencies), sorted(imported.dependencies));
  // Bloco apagado depois: as ligações dele não entram.
  const fewer = reconstructDeducedDependencies({
    workId: 'w',
    workName: 'Obra',
    baseline: imported.baseline,
    services: imported.services,
    locals: imported.localOrder.map(l => l.local),
    activities: moved.slice(1),
  });
  assert.equal(fewer.missingActivities, 1);
  assert.ok(fewer.dependencies.every(d => d.predecessorId !== moved[0].id && d.successorId !== moved[0].id));
});

test('linha de base automática antes da troca, com o nome livre e o término gravado', () => {
  const baseline = replacementBaseline({
    workId: 'w',
    activities: [A, B],
    baselines: [{ name: 'Antes das ligações do Prevision 25/11/2026' }],
    calendar: { weekdays: [1, 2, 3, 4, 5], holidays: ['2026-11-04'] },
    date: '2026-11-25',
    actorId: 'ator',
    now: NOW,
    newId: () => 'lb',
  });
  assert.equal(baseline.name, 'Antes das ligações do Prevision 25/11/2026 (2)');
  assert.equal(baseline.automatic, true);
  assert.equal(baseline.createdBy, 'ator');
  assert.deepEqual(baseline.snapshot[0], {
    activityId: 'A',
    serviceId: 'S1',
    localId: 'L1',
    start: '2026-11-02',
    durationDays: 5,
    finish: '2026-11-09',
  });
});

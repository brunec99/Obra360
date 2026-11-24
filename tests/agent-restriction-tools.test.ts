import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isRestrictionTool,
  RESTRICTION_TOOL_SPECS,
  runRestrictionTool,
  SIMILARITY_THRESHOLD,
  titleSimilarity,
  type RestrictionLoad,
  type RestrictionSnapshot,
  type RestrictionToolContext,
} from '../src/application/use-cases/agent-restriction-tools';
import { AGENT_TOOL_SPECS, runAgentToolAsync, type ToolContext } from '../src/application/use-cases/agent-tools';
import { parsePendingCommand, planPendingCommand } from '../src/application/use-cases/pending-commands';
import type { PendingCard, PendingCommand } from '../src/domain/pending-board';
import { TODAY, WORK, fixture } from './fixtures/agent-planning';

/** Restrições pelo chat da Claudia (24/11/2026): listar o quadro, propor cards e não duplicar. */

const card = (id: string, title: string, over: Partial<PendingCard> = {}): PendingCard => ({
  id,
  workId: WORK,
  title,
  status: 'todo',
  origin: 'manual',
  dueDate: '2026-11-20',
  leadTimeDays: 0,
  responsibleId: 'u-planner',
  orderIndex: 1,
  createdBy: 'u-planner',
  createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-10-01T12:00:00.000Z',
  ...over,
});
const snapshot = (over: Partial<RestrictionSnapshot> = {}): RestrictionSnapshot => ({
  cards: [
    card('aaaa1111-0000', 'Aprovar projeto de fachada', { dueDate: '2026-12-10', leadTimeDays: 5 }),
    card('bbbb2222-0000', 'Comprar esquadrias de alumínio da torre 2', { status: 'doing', responsibleId: 'u-ana' }),
    card('cccc3333-0000', 'Contratar empreiteiro de gesso', { status: 'done', closedAt: '2026-10-20T12:00:00.000Z' }),
    card('dddd4444-0000', 'Liberar frente do 5º pavimento', {
      origin: 'medio_prazo',
      sourceId: 'task-alvenaria-5',
      sourceLabel: 'Alvenaria 5º pavimento',
    }),
  ],
  people: [
    { id: 'u-planner', name: 'Paula Planejadora' },
    { id: 'u-ana', name: 'Ana Souza' },
    { id: 'u-ana2', name: 'Ana Lima' },
    { id: 'u-joao', name: 'João Paulo Reis' },
  ],
  tasks: [
    { id: 'task-resumo-0001', label: 'Torre 1', start: '2026-11-02', level: 0, summary: true },
    { id: 'task-alvenaria-5', label: 'Alvenaria 5º pavimento', start: '2026-12-01', level: 1 },
    { id: 'tk9f8e7d-inst', label: 'Instalações elétricas 3º pavimento', start: '2026-12-07', level: 1 },
  ],
  services: [
    { id: 's-alv', label: 'Alvenaria', start: '2026-09-01' },
    { id: 's-fach', label: 'Fachada', start: '2027-01-11' },
    { id: 's-inst-e', label: 'Instalações elétricas', start: '2026-10-05' },
    { id: 's-inst-h', label: 'Instalações hidráulicas', start: '2026-10-05' },
  ],
  ...over,
});
let seq = 0;
const ctx = (
  load: RestrictionLoad = { ok: true, value: snapshot() },
  over: Partial<RestrictionToolContext> = {},
): RestrictionToolContext => ({
  workId: WORK,
  today: '2026-11-24',
  actor: { id: 'u-planner', role: 'planner' },
  newId: () => `prop-r-${++seq}`,
  load: async () => load,
  ...over,
});
const created = (commands: PendingCommand[] | undefined) =>
  (commands ?? []).filter((c): c is Extract<PendingCommand, { type: 'create_card' }> => c.type === 'create_card');

test('especificações: as duas ferramentas entram na Claudia da obra, antes do manual', () => {
  assert.deepEqual(
    RESTRICTION_TOOL_SPECS.map(s => s.name),
    ['listar_restricoes', 'propor_restricoes'],
  );
  const names = AGENT_TOOL_SPECS.map(s => s.name);
  assert.ok(names.indexOf('listar_restricoes') > 0 && names.indexOf('propor_restricoes') < names.indexOf('consultar_manual'));
  assert.ok(isRestrictionTool('propor_restricoes') && !isRestrictionTool('propor_levar'));
  assert.ok(RESTRICTION_TOOL_SPECS[1].description.includes('listar_restricoes'), 'a descrição manda consultar antes');
});

test('titleSimilarity: igual sem acento/caixa/artigos, parecido por radical, número diferente é outro lugar', () => {
  assert.equal(titleSimilarity('Aprovar projeto de fachada', 'aprovar o projeto da FACHADA'), 1);
  assert.ok(titleSimilarity('Aprovação do projeto de fachada', 'Aprovar projeto de fachada') >= SIMILARITY_THRESHOLD);
  assert.ok(titleSimilarity('Comprar esquadrias', 'Comprar esquadrias de alumínio da torre 2') >= SIMILARITY_THRESHOLD);
  assert.ok(titleSimilarity('Comprar esquadrias da torre 3', 'Comprar esquadrias de alumínio da torre 2') < SIMILARITY_THRESHOLD);
  assert.ok(titleSimilarity('Liberar frente do 6º pavimento', 'Liberar frente do 5º pavimento') < SIMILARITY_THRESHOLD);
  assert.ok(titleSimilarity('Contratar pintor', 'Aprovar projeto de fachada') < 0.2);
  assert.equal(titleSimilarity('', 'Aprovar projeto'), 0);
});

test('listar_restricoes: só os abertos por padrão, com apelido, coluna, origem, entrega, responsável e sinal', async () => {
  const out = await runRestrictionTool('listar_restricoes', {}, ctx());
  assert.ok(!out.error);
  assert.ok(out.result.startsWith('Quadro de Restrições: 4 cards, 3 em aberto.'));
  assert.ok(
    out.result.includes(
      'r:aaaa1111 | Aprovar projeto de fachada | A fazer | avulsa | 10/12/2026 | 03/12/2026 | Paula Planejadora | no prazo',
    ),
  );
  assert.ok(out.result.includes('r:bbbb2222 | Comprar esquadrias de alumínio da torre 2 | Fazendo | avulsa | 20/11/2026'));
  assert.ok(out.result.includes('Ana Souza | atrasada'));
  assert.ok(out.result.includes('Médio prazo: Alvenaria 5º pavimento'));
  assert.ok(!out.result.includes('gesso'), 'concluído fica de fora');
  const all = await runRestrictionTool('listar_restricoes', { situacao: 'todas' }, ctx());
  assert.ok(all.result.includes('Contratar empreiteiro de gesso | Concluído'));
});

test('listar_restricoes com busca: só os parecidos, do mais parecido ao menos; sem nada, diz que não há', async () => {
  const out = await runRestrictionTool('listar_restricoes', { busca: 'projeto da fachada' }, ctx());
  const rows = out.result.split('\n').filter(l => l.startsWith('r:'));
  assert.equal(rows.length, 1);
  assert.ok(rows[0].startsWith('r:aaaa1111'));
  const bySource = await runRestrictionTool('listar_restricoes', { busca: 'alvenaria' }, ctx());
  assert.ok(bySource.result.includes('r:dddd4444'), 'acha pelo nome da tarefa de origem');
  const none = await runRestrictionTool('listar_restricoes', { busca: 'elevador cremalheira' }, ctx());
  assert.ok(none.result.includes('Nenhum card em aberto parecido com "elevador cremalheira"'));
  assert.ok(!none.error);
});

test('sem o quadro liberado, sem a migração ou sem carregador: erro explicado, nenhuma proposta', async () => {
  const denied = await runRestrictionTool(
    'propor_restricoes',
    { itens: [{ titulo: 'X', entrega: '2026-12-01' }] },
    ctx({ ok: false, reason: 'sem_acesso' }),
  );
  assert.ok(denied.error && denied.result.includes('não está liberado') && !denied.proposal);
  const missing = await runRestrictionTool('listar_restricoes', {}, ctx({ ok: false, reason: 'indisponivel' }));
  assert.ok(missing.error && missing.result.includes('não está disponível'));
  const noLoader = await runRestrictionTool('listar_restricoes', {}, ctx(undefined, { load: undefined }));
  assert.ok(noLoader.error);
});

test('propor_restricoes: avulsa com entrega, responsável padrão = quem pediu, comando aceito pelo planejador do quadro', async () => {
  const out = await runRestrictionTool(
    'propor_restricoes',
    {
      itens: [
        { titulo: '  Contratar   pintor da fachada ', descricao: 'Sem proposta fechada.', entrega: '2026-12-15', tempo_execucao: 10 },
      ],
    },
    ctx(),
  );
  assert.ok(!out.error && out.proposal);
  const p = out.proposal!;
  assert.equal(p.kind, 'restricao');
  assert.equal(p.title, 'Criar 1 restrição no Quadro de Restrições');
  assert.deepEqual(p.commands, []);
  assert.equal(p.weekStart, '');
  assert.deepEqual(created(p.pendingCommands), [
    {
      type: 'create_card',
      workId: WORK,
      title: 'Contratar pintor da fachada',
      description: 'Sem proposta fechada.',
      origin: 'manual',
      dueDate: '2026-12-15',
      leadTimeDays: 10,
      responsibleId: 'u-planner',
    },
  ]);
  assert.equal(
    p.lines[0],
    'Contratar pintor da fachada: entrega 15/12/2026, 10 dias úteis de execução (começar até 01/12/2026), responsável Paula Planejadora',
  );
  assert.ok(out.result.includes('nada foi gravado ainda') && out.result.includes('Conferido com os 3 cards em aberto'));
  // O comando é o do quadro: passa pelo parser da rota e pelo planejador sem ajuste.
  const data = snapshot();
  const mutation = planPendingCommand(
    { cards: data.cards, checklists: [], items: [], messages: [] },
    parsePendingCommand(JSON.parse(JSON.stringify(p.pendingCommands![0]))),
    {
      actorId: 'u-planner',
      now: '2026-11-24T12:00:00.000Z',
      today: '2026-11-24',
      newId: () => `id-${++seq}`,
      admin: false,
      people: data.people,
    },
  );
  assert.equal(mutation.insert.cards[0].title, 'Contratar pintor da fachada');
  assert.equal(mutation.insert.cards[0].status, 'todo');
});

test('propor_restricoes: título igual a card em aberto nunca entra; parecido só com confirmação', async () => {
  const same = await runRestrictionTool(
    'propor_restricoes',
    { itens: [{ titulo: 'aprovar o projeto da fachada', entrega: '2026-12-15', criar_mesmo_parecida: true }] },
    ctx(),
  );
  assert.ok(same.error && !same.proposal);
  assert.ok(
    same.result.includes(
      'já existe no quadro — r:aaaa1111 "Aprovar projeto de fachada" (A fazer, entrega 10/12/2026, responsável Paula Planejadora)',
    ),
  );

  const similar = { titulo: 'Compra das esquadrias de alumínio', entrega: '2026-12-15' };
  const blocked = await runRestrictionTool('propor_restricoes', { itens: [similar] }, ctx());
  assert.ok(blocked.error && !blocked.proposal);
  assert.ok(blocked.result.includes('parece a mesma restrição de r:bbbb2222') && blocked.result.includes('criar_mesmo_parecida'));
  const confirmed = await runRestrictionTool('propor_restricoes', { itens: [{ ...similar, criar_mesmo_parecida: true }] }, ctx());
  assert.equal(created(confirmed.proposal?.pendingCommands).length, 1);

  // Card concluído não bloqueia: a restrição pode ter voltado.
  const reopened = await runRestrictionTool(
    'propor_restricoes',
    { itens: [{ titulo: 'Contratar empreiteiro de gesso', entrega: '2026-12-15' }] },
    ctx(),
  );
  assert.equal(created(reopened.proposal?.pendingCommands).length, 1);
});

test('propor_restricoes: itens repetidos na mesma proposta e mistura de aceitos com recusados', async () => {
  const out = await runRestrictionTool(
    'propor_restricoes',
    {
      itens: [
        { titulo: 'Definir cor do porcelanato com o cliente', entrega: '2026-12-01' },
        { titulo: 'Definir a cor do porcelanato com cliente', entrega: '2026-12-02' },
        { titulo: 'Aprovar projeto de fachada', entrega: '2026-12-01' },
        { titulo: 'Locar guindaste', entrega: '31/12/2026' },
        { titulo: 'Sem data' },
        { titulo: '' },
      ],
    },
    ctx(),
  );
  const p = out.proposal!;
  assert.deepEqual(
    created(p.pendingCommands).map(c => c.title),
    ['Definir cor do porcelanato com o cliente'],
  );
  assert.equal(p.skipped.length, 5);
  assert.ok(p.skipped[0].includes('repetida nesta mesma proposta'));
  assert.ok(p.skipped[1].includes('já existe no quadro'));
  assert.ok(p.skipped[2].includes('inválida'));
  assert.ok(p.skipped[3].includes('falta a data de entrega'));
  assert.equal(p.skipped[4], 'item sem título');
});

test('propor_restricoes ligada: tarefa pelo apelido e serviço pelo nome; entrega = véspera útil do início', async () => {
  const out = await runRestrictionTool(
    'propor_restricoes',
    {
      itens: [
        { titulo: 'Receber projeto elétrico revisado', tarefa: 't:tk9f8e7d', entrega: '2030-01-01', responsavel: 'joão paulo' },
        { titulo: 'Fechar contrato de ACM', servico: 'fachada', tempo_execucao: 15 },
      ],
    },
    ctx(),
  );
  const [task, service] = created(out.proposal?.pendingCommands);
  // Início 07/12/2026 (segunda) → entrega 04/12 (sexta); a data digitada é ignorada.
  assert.deepEqual(
    {
      origin: task.origin,
      sourceId: task.sourceId,
      sourceLabel: task.sourceLabel,
      dueDate: task.dueDate,
      responsibleId: task.responsibleId,
    },
    {
      origin: 'medio_prazo',
      sourceId: 'tk9f8e7d-inst',
      sourceLabel: 'Instalações elétricas 3º pavimento',
      dueDate: '2026-12-04',
      responsibleId: 'u-joao',
    },
  );
  assert.deepEqual(
    { origin: service.origin, sourceId: service.sourceId, dueDate: service.dueDate, leadTimeDays: service.leadTimeDays },
    { origin: 'longo_prazo', sourceId: 's-fach', dueDate: '2027-01-08', leadTimeDays: 15 },
  );
  assert.ok(out.proposal!.lines[0].includes('trava a tarefa "Instalações elétricas 3º pavimento"'));
  assert.ok(out.proposal!.lines[1].includes('trava o serviço "Fachada"'));
});

test('propor_restricoes ligada: tarefa-resumo, tarefa desconhecida, serviço ambíguo, mesma origem com título próximo', async () => {
  const out = await runRestrictionTool(
    'propor_restricoes',
    {
      itens: [
        { titulo: 'Restrição no resumo', tarefa: 't:task-res' },
        { titulo: 'Restrição sem tarefa', tarefa: 't:zzzzzzzz' },
        { titulo: 'Passagem de eletrodutos', servico: 'instalações' },
        { titulo: 'Serviço que não existe', servico: 'Pintura' },
        { titulo: 'Tarefa e serviço', tarefa: 't:tk9f8e7d', servico: 'Fachada' },
        { titulo: 'Liberar a frente de trabalho do 5º', tarefa: 't:task-alv' },
      ],
    },
    ctx(),
  );
  assert.ok(out.error && !out.proposal);
  assert.ok(out.result.includes('é tarefa-resumo'));
  assert.ok(out.result.includes('não está no plano do mês vivo mais recente'));
  assert.ok(out.result.includes('bate com mais de um na Linha de Balanço') && out.result.includes('Instalações hidráulicas'));
  assert.ok(out.result.includes('"Pintura" não encontrado') && out.result.includes('Alvenaria; Fachada'));
  assert.ok(out.result.includes('a tarefa OU o serviço'));
  assert.ok(out.result.includes('parece a mesma restrição de r:dddd4444'), 'mesma tarefa de origem com título próximo');
});

test('propor_restricoes: responsável ambíguo ou sem acesso, tempo de execução inválido, limite de itens', async () => {
  const out = await runRestrictionTool(
    'propor_restricoes',
    {
      itens: [
        { titulo: 'Item A do responsável', entrega: '2026-12-01', responsavel: 'Ana' },
        { titulo: 'Item B do responsável', entrega: '2026-12-01', responsavel: 'Fulano' },
        { titulo: 'Item C do prazo', entrega: '2026-12-01', tempo_execucao: 1.5 },
        { titulo: 'Item D certo', entrega: '2026-12-01', responsavel: 'Ana Lima' },
      ],
    },
    ctx(),
  );
  const p = out.proposal!;
  assert.deepEqual(
    created(p.pendingCommands).map(c => [c.title, c.responsibleId, c.leadTimeDays]),
    [['Item D certo', 'u-ana2', 0]],
  );
  assert.ok(p.skipped[0].includes('bate com mais de uma pessoa (Ana Souza; Ana Lima)'));
  assert.ok(p.skipped[1].includes('não tem acesso a esta obra'));
  assert.ok(p.skipped[2].includes('tempo de execução'));
  const many = await runRestrictionTool(
    'propor_restricoes',
    { itens: Array.from({ length: 21 }, (_, i) => ({ titulo: `Restrição número ${i}`, entrega: '2026-12-01' })) },
    ctx(),
  );
  assert.ok(many.error && many.result.includes('até 20'));
  assert.ok((await runRestrictionTool('propor_restricoes', { itens: [] }, ctx())).error);
  assert.ok((await runRestrictionTool('propor_restricoes', null, ctx())).error);
});

test('runAgentToolAsync: despacha as de restrição pelo carregador do contexto e as demais como antes', async () => {
  let loads = 0;
  const toolCtx: ToolContext = {
    data: fixture(),
    workId: WORK,
    today: TODAY,
    actor: { id: 'u-planner', role: 'viewer' },
    levels: ['curto'],
    newId: () => `prop-${++seq}`,
    restrictions: async () => {
      loads += 1;
      return { ok: true, value: snapshot() };
    },
  };
  const listed = await runAgentToolAsync('listar_restricoes', { busca: 'fachada' }, toolCtx);
  assert.ok(listed.result.includes('r:aaaa1111'));
  // O quadro aceita cards de qualquer papel com o módulo liberado: consulta também propõe.
  const proposed = await runAgentToolAsync('propor_restricoes', { itens: [{ titulo: 'Locar guindaste', entrega: '2026-12-20' }] }, toolCtx);
  assert.equal(proposed.proposal?.kind, 'restricao');
  assert.equal(loads, 2);
  const week = await runAgentToolAsync('listar_semana', { semana: 'atual' }, toolCtx);
  assert.ok(week.result.startsWith('Semana'));
  const noLoader = await runAgentToolAsync('listar_restricoes', {}, { ...toolCtx, restrictions: undefined });
  assert.ok(noLoader.error);
});

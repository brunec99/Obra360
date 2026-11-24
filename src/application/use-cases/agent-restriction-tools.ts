import {
  dueDateFromStart,
  isClosed,
  PENDING_LIMITS,
  PENDING_ORIGIN_LABELS,
  PENDING_STATUS_LABELS,
  pendingSignal,
  startBy,
  type PendingCard,
  type PendingCommand,
  type PendingPerson,
  type PendingSourceOption,
} from '../../domain/pending-board';
import type { User } from '../../domain/entities';

/** Restrições pelo chat da Claudia (24/11/2026, pedido do usuário): da conversa aberta no curto, no médio ou
 * no longo prazo, ela cadastra cards no Quadro de Restrições (aba 1.4). Duas ferramentas:
 * `listar_restricoes` (o que já existe no quadro) e `propor_restricoes` (a proposta de cards novos).
 *
 * Decisões:
 * - Ela continua sem gravar: `propor_restricoes` devolve comandos `create_card` do próprio quadro, que a
 *   tela manda a `POST /api/pendencias/commands` quando a pessoa clica em "Aplicar". Valem ali as mesmas
 *   regras de quem cria pela tela (módulo liberado, responsável com acesso à obra, origem existente,
 *   entrega recalculada da tarefa ou do serviço, e-mail ao responsável).
 * - Duplicada não passa: a conferência com o que já existe é feita AQUI, a cada proposta, e não depende de
 *   o modelo ter consultado antes. Título igual a um card em aberto fica sempre de fora; título parecido
 *   fica de fora até a pessoa confirmar (`criar_mesmo_parecida`); os itens da mesma proposta também são
 *   comparados entre si. O prompt manda consultar `listar_restricoes` antes, para ela já responder "isso
 *   já está no quadro" sem montar proposta.
 * - Ligação: tarefa do plano do mês (apelido "t:…" de `listar_tarefas_mes`), serviço da Linha de Balanço
 *   (pelo nome) ou avulsa. São as mesmas opções do botão "Nova restrição" do quadro; na ligada, a entrega
 *   é a véspera útil do início da tarefa ou do serviço e não é digitada.
 * - Funções puras: quem lê o banco é o carregador (`RestrictionLoader`), passado pela rota. Este arquivo
 *   não importa `agent-tools.ts` (que importa este), por isso repete os dois ajudantes de apelido. */

export interface RestrictionSnapshot {
  cards: PendingCard[];
  /** Perfis com a obra liberada: quem pode ser responsável. */
  people: PendingPerson[];
  /** Tarefas do plano do mês vivo mais recente (as mesmas que o formulário do quadro oferece). */
  tasks: PendingSourceOption[];
  /** Serviços da Linha de Balanço que já têm bloco lançado. */
  services: PendingSourceOption[];
}
/** `sem_acesso`: o Quadro de Restrições não está liberado para a pessoa. `indisponivel`: a tabela do
 * quadro ainda não existe (migração 0043 não aplicada). */
export type RestrictionLoad = { ok: true; value: RestrictionSnapshot } | { ok: false; reason: 'sem_acesso' | 'indisponivel' };
export type RestrictionLoader = () => Promise<RestrictionLoad>;

export interface RestrictionToolContext {
  workId: string;
  today: string;
  actor: { id: string; role: User['role'] };
  newId: () => string;
  /** Ausente = a rota não oferece o quadro (tratado como indisponível). */
  load?: RestrictionLoader;
}
export interface RestrictionProposal {
  id: string;
  kind: 'restricao';
  title: string;
  lines: string[];
  /** Sempre vazio: os comandos desta proposta são os do quadro, em `pendingCommands`. */
  commands: never[];
  pendingCommands: PendingCommand[];
  /** Sempre vazio: restrição não é de uma semana. */
  weekStart: '';
  skipped: string[];
}
export interface RestrictionOutcome {
  result: string;
  proposal?: RestrictionProposal;
  error?: boolean;
}

export const RESTRICTION_TOOL_NAMES = ['listar_restricoes', 'propor_restricoes'] as const;
export const isRestrictionTool = (name: string) => (RESTRICTION_TOOL_NAMES as readonly string[]).includes(name);

export const MAX_RESTRICTION_LIST = 150;
export const MAX_RESTRICTION_ITEMS = 20;
/** A partir daqui dois títulos são "parecidos" (ver `titleSimilarity`). */
export const SIMILARITY_THRESHOLD = 0.6;

export const RESTRICTION_TOOL_SPECS = [
  {
    name: 'listar_restricoes',
    description:
      'Lista os cards do Quadro de Restrições da obra (aba 1.4): apelido "r:…", título, coluna (A fazer, Fazendo, Pausado, Concluído, Cancelado), origem (avulsa, tarefa do médio prazo ou serviço do longo prazo), data de entrega, até quando precisa começar, responsável e sinal (atrasada, começa em breve). Sem "busca", vêm os cards em aberto; com "busca", só os de título, descrição ou origem parecidos com o texto, dos mais parecidos para os menos. Use SEMPRE antes de propor_restricoes, com o assunto da restrição em "busca", para não cadastrar o que já está no quadro.',
    input_schema: {
      type: 'object',
      properties: {
        busca: { type: 'string', description: 'Assunto a procurar (ex.: "projeto de fachada", "compra de esquadrias"). Opcional.' },
        situacao: {
          type: 'string',
          enum: ['abertas', 'todas'],
          description: 'abertas (padrão: A fazer, Fazendo e Pausado) ou todas (inclui Concluído e Cancelado).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'propor_restricoes',
    description: `Propõe cards novos no Quadro de Restrições da obra (aba 1.4), a partir do que a pessoa relatou na conversa do curto, do médio ou do longo prazo. Cada item nasce em "A fazer" e pode ser ligado a uma tarefa do plano do mês (apelido "t:…" de listar_tarefas_mes) ou a um serviço da Linha de Balanço (nome do serviço); sem ligação, é avulso e precisa da data de entrega. Na restrição ligada a entrega não é informada: é o dia útil anterior ao início da tarefa ou do serviço. Antes de chamar, consulte listar_restricoes com o assunto. A própria ferramenta confere de novo: título igual ao de um card em aberto fica de fora, e título parecido só entra com "criar_mesmo_parecida" verdadeiro, que você só usa depois de mostrar o card parecido e a pessoa confirmar que é outra restrição. Até ${MAX_RESTRICTION_ITEMS} itens por proposta. A proposta só é gravada se a pessoa clicar em Aplicar.`,
    input_schema: {
      type: 'object',
      properties: {
        itens: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              titulo: {
                type: 'string',
                description: `O que precisa ser resolvido, em uma linha (até ${PENDING_LIMITS.title} caracteres). Ex.: "Aprovar projeto de fachada".`,
              },
              descricao: { type: 'string', description: 'Detalhe opcional: contexto, o que trava, quem foi acionado.' },
              tarefa: { type: 'string', description: 'Apelido da tarefa do plano do mês que a restrição trava (ex.: "t:9f8e7d6c").' },
              servico: { type: 'string', description: 'Nome do serviço da Linha de Balanço que a restrição trava.' },
              entrega: {
                type: 'string',
                description: 'Data de entrega YYYY-MM-DD. Obrigatória na avulsa; ignorada quando há tarefa ou serviço.',
              },
              tempo_execucao: {
                type: 'integer',
                description:
                  'Dias úteis que a solução leva (lead time), de 0 a 999. Sem ele, 0. O card avisa quando chega a hora de começar.',
              },
              responsavel: {
                type: 'string',
                description: 'Nome de quem resolve; precisa ter acesso à obra. Sem ele, a própria pessoa da conversa.',
              },
              criar_mesmo_parecida: {
                type: 'boolean',
                description: 'Verdadeiro só depois de a pessoa confirmar que é uma restrição diferente do card parecido que já existe.',
              },
            },
            required: ['titulo'],
            additionalProperties: false,
          },
        },
      },
      required: ['itens'],
      additionalProperties: false,
    },
  },
];

// ─── Ajudantes ──────────────────────────────────────────────────────────────────

const nameKey = (name: string) => name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const handleOf = (id: string) => id.slice(0, 8);
function resolveHandle<T extends { id: string }>(rows: readonly T[], handle: string): T | undefined {
  const key = handle
    .trim()
    .replace(/^[a-z]:/i, '')
    .toLowerCase();
  if (!key) return undefined;
  const exact = rows.find(r => r.id === key);
  if (exact) return exact;
  const matches = rows.filter(r => r.id.toLowerCase().startsWith(key));
  return matches.length === 1 ? matches[0] : undefined;
}
const dmy = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim();
const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

/** Palavras que não distinguem uma restrição da outra. */
const STOPWORDS = new Set(
  'a o as os um uma de da do das dos e em no na nos nas para pra por com sem ao aos que se ou ate sobre entre pelo pela junto'.split(' '),
);
/** Radicais do título: sem acento, sem pontuação, sem palavras vazias; palavras longas cortadas em seis
 * letras, para "aprovar/aprovação" e "esquadria/esquadrias" contarem como a mesma. Números ficam inteiros
 * ("torre 2" não é "torre 3"). */
export function titleTokens(title: string): Set<string> {
  const words = nameKey(title)
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(word => word && !STOPWORDS.has(word) && (word.length >= 3 || /\d/.test(word)));
  return new Set(words.map(word => (/\d/.test(word) ? word : word.slice(0, 6))));
}
/** De 0 a 1: quanto dois títulos se parecem. 1 = iguais sem acento, caixa e palavras vazias. No mais, a
 * maior entre a fração em comum sobre a união e, com dois radicais ou mais em cada um, 90% da fração do
 * título menor que está no maior (um título que só detalha o outro é o mesmo assunto). Número diferente
 * ("torre 2" × "torre 3", "5º pavimento" × "6º pavimento") derruba a nota: é outro lugar. */
export function titleSimilarity(a: string, b: string): number {
  const x = titleTokens(a),
    y = titleTokens(b);
  if (!x.size || !y.size) return nameKey(a) === nameKey(b) && !!nameKey(a) ? 1 : 0;
  let common = 0;
  for (const token of x) if (y.has(token)) common += 1;
  if (common === x.size && common === y.size) return 1;
  const numbers = (set: Set<string>) => [...set].filter(token => /\d/.test(token));
  const nx = numbers(x),
    ny = numbers(y);
  const numbersDiffer = nx.length > 0 && ny.length > 0 && (nx.some(n => !y.has(n)) || ny.some(n => !x.has(n)));
  const jaccard = common / (x.size + y.size - common);
  const small = Math.min(x.size, y.size);
  const contained = small >= 2 ? (common / small) * 0.9 : 0;
  const score = Math.max(jaccard, contained);
  return numbersDiffer ? Math.min(score, 0.4) : score;
}

const personName = (people: readonly PendingPerson[], id: string) => people.find(p => p.id === id)?.name ?? 'sem responsável';
const originText = (card: PendingCard) =>
  card.origin === 'manual'
    ? 'avulsa'
    : `${card.sourceLegalization ? 'Gantt de legalização' : PENDING_ORIGIN_LABELS[card.origin]}${card.sourceLabel ? `: ${oneLine(card.sourceLabel)}` : ''}`;
const cardSummary = (card: PendingCard, people: readonly PendingPerson[]) =>
  `r:${handleOf(card.id)} "${oneLine(card.title)}" (${PENDING_STATUS_LABELS[card.status]}, entrega ${dmy(card.dueDate)}, responsável ${personName(people, card.responsibleId)})`;

async function loaded(ctx: RestrictionToolContext): Promise<{ value: RestrictionSnapshot } | { error: string }> {
  const load = ctx.load ? await ctx.load() : ({ ok: false, reason: 'indisponivel' } as const);
  if (load.ok) return { value: load.value };
  return {
    error:
      load.reason === 'sem_acesso'
        ? 'O Quadro de Restrições (aba 1.4) não está liberado para esta pessoa: um administrador libera em Configurações, na grade de usuários.'
        : 'O Quadro de Restrições não está disponível nesta instalação.',
  };
}

// ─── listar_restricoes ──────────────────────────────────────────────────────────

/** Quanto o card tem a ver com a busca: a nota do título, ou 0,5 quando o texto aparece inteiro no título,
 * na descrição ou na origem. */
function searchScore(card: PendingCard, query: string): number {
  const key = nameKey(query);
  const haystack = nameKey(`${card.title} ${card.description ?? ''} ${card.sourceLabel ?? ''}`);
  const tokens = [...titleTokens(query)];
  const inText = tokens.length ? tokens.filter(token => haystack.includes(token)).length / tokens.length : 0;
  return Math.max(titleSimilarity(card.title, query), haystack.includes(key) ? 0.5 : 0, inText >= 0.5 ? inText * 0.5 : 0);
}

async function listRestrictions(input: Record<string, unknown>, ctx: RestrictionToolContext): Promise<RestrictionOutcome> {
  const data = await loaded(ctx);
  if ('error' in data) return { result: data.error, error: true };
  const { cards, people } = data.value;
  const query = text(input.busca);
  const all = text(input.situacao) === 'todas';
  const open = cards.filter(card => !isClosed(card.status));
  let selected = all ? cards : open;
  if (query) {
    selected = selected
      .map(card => ({ card, score: searchScore(card, query) }))
      .filter(entry => entry.score >= 0.25)
      .sort((a, b) => b.score - a.score || a.card.dueDate.localeCompare(b.card.dueDate))
      .map(entry => entry.card);
  } else selected = selected.slice().sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title, 'pt-BR'));
  const head = `Quadro de Restrições: ${cards.length} cards, ${open.length} em aberto.`;
  if (!selected.length)
    return {
      result:
        `${head} ${query ? `Nenhum card ${all ? '' : 'em aberto '}parecido com "${query}".` : `Nenhum card ${all ? '' : 'em aberto'}.`}`.trim(),
    };
  const signal = (card: PendingCard) => {
    const s = pendingSignal(card, ctx.today);
    return s === 'late' ? 'atrasada' : s === 'soon' ? 'começa em breve' : s === 'closed' ? '-' : 'no prazo';
  };
  const lines = selected
    .slice(0, MAX_RESTRICTION_LIST)
    .map(
      card =>
        `r:${handleOf(card.id)} | ${oneLine(card.title)} | ${PENDING_STATUS_LABELS[card.status]} | ${originText(card)} | ${dmy(card.dueDate)} | ${dmy(startBy(card))} | ${personName(people, card.responsibleId)} | ${signal(card)}`,
    );
  const cut = selected.length > MAX_RESTRICTION_LIST ? `\n(Mostrando ${MAX_RESTRICTION_LIST} de ${selected.length} cards.)` : '';
  const scope = query ? `${selected.length} parecidos com "${query}"${all ? '' : ' em aberto'}` : all ? 'todos' : 'os em aberto';
  return {
    result: `${head} Abaixo, ${scope}.\napelido | título | coluna | origem | entrega | começar até | responsável | sinal\n${lines.join('\n')}${cut}`,
  };
}

// ─── propor_restricoes ──────────────────────────────────────────────────────────

function findPerson(people: readonly PendingPerson[], name: string): PendingPerson | { candidates: PendingPerson[] } {
  const key = nameKey(name);
  const exact = people.filter(p => nameKey(p.name) === key);
  if (exact.length === 1) return exact[0];
  const words = key.split(' ').filter(Boolean);
  const partial = people.filter(p => {
    const full = nameKey(p.name);
    return words.every(word => full.split(' ').some(part => part.startsWith(word)));
  });
  return partial.length === 1 ? partial[0] : { candidates: exact.length ? exact : partial };
}
function findService(services: readonly PendingSourceOption[], name: string): PendingSourceOption | { candidates: PendingSourceOption[] } {
  const key = nameKey(name);
  const exact = services.filter(s => nameKey(s.label) === key);
  if (exact.length === 1) return exact[0];
  const partial = key.length >= 4 ? services.filter(s => nameKey(s.label).includes(key) || key.includes(nameKey(s.label))) : [];
  return partial.length === 1 ? partial[0] : { candidates: exact.length ? exact : partial };
}
const namesList = (values: string[], max: number) =>
  values.length > max ? `${values.slice(0, max).join('; ')}; e mais ${values.length - max}` : values.join('; ');

async function proposeRestrictions(input: Record<string, unknown>, ctx: RestrictionToolContext): Promise<RestrictionOutcome> {
  const items = (Array.isArray(input.itens) ? input.itens : []).filter(
    (item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item),
  );
  if (!items.length) return { result: 'Informe ao menos uma restrição.', error: true };
  if (items.length > MAX_RESTRICTION_ITEMS) return { result: `Proponha até ${MAX_RESTRICTION_ITEMS} restrições por vez.`, error: true };
  const data = await loaded(ctx);
  if ('error' in data) return { result: data.error, error: true };
  const { cards, people, tasks, services } = data.value;
  const open = cards.filter(card => !isClosed(card.status));
  const actor = people.find(p => p.id === ctx.actor.id);

  const commands: PendingCommand[] = [];
  const lines: string[] = [];
  const skipped: string[] = [];
  for (const item of items) {
    const title = oneLine(text(item.titulo));
    if (!title) {
      skipped.push('item sem título');
      continue;
    }
    if (title.length > PENDING_LIMITS.title) {
      skipped.push(`"${title.slice(0, 40)}…": o título passa de ${PENDING_LIMITS.title} caracteres`);
      continue;
    }
    const description = text(item.descricao).slice(0, PENDING_LIMITS.description);

    // Ligação: tarefa do plano do mês, serviço da Linha de Balanço ou avulsa.
    const taskHandle = text(item.tarefa),
      serviceName = text(item.servico);
    if (taskHandle && serviceName) {
      skipped.push(`"${title}": escolha a tarefa OU o serviço, não os dois`);
      continue;
    }
    let origin: 'manual' | 'medio_prazo' | 'longo_prazo' = 'manual';
    let source: PendingSourceOption | undefined;
    if (taskHandle) {
      const task = resolveHandle(tasks, taskHandle);
      if (!task) {
        skipped.push(`"${title}": a tarefa ${taskHandle} não está no plano do mês vivo mais recente (confira em listar_tarefas_mes)`);
        continue;
      }
      if (task.summary) {
        skipped.push(`"${title}": "${task.label}" é tarefa-resumo; ligue a uma tarefa dentro dela`);
        continue;
      }
      origin = 'medio_prazo';
      source = task;
    } else if (serviceName) {
      const service = findService(services, serviceName);
      if ('candidates' in service) {
        const options = (service.candidates.length ? service.candidates : services).map(s => s.label);
        skipped.push(
          options.length
            ? `"${title}": serviço "${serviceName}" ${service.candidates.length ? 'bate com mais de um' : 'não encontrado'} na Linha de Balanço; serviços com bloco lançado: ${namesList(options, 40)}`
            : `"${title}": a obra não tem serviço com bloco lançado na Linha de Balanço`,
        );
        continue;
      }
      origin = 'longo_prazo';
      source = service;
    }

    let dueDate: string;
    if (source) dueDate = dueDateFromStart(source.start);
    else {
      const due = text(item.entrega);
      if (!due) {
        skipped.push(`"${title}": falta a data de entrega (pergunte até quando precisa estar resolvida)`);
        continue;
      }
      if (!isDate(due)) {
        skipped.push(`"${title}": data de entrega "${due}" inválida (use YYYY-MM-DD)`);
        continue;
      }
      dueDate = due;
    }

    const rawLead = item.tempo_execucao;
    const leadTimeDays = rawLead === undefined || rawLead === null || rawLead === '' ? 0 : Number(rawLead);
    if (!Number.isInteger(leadTimeDays) || leadTimeDays < 0 || leadTimeDays > PENDING_LIMITS.leadTime) {
      skipped.push(`"${title}": o tempo de execução vai de 0 a ${PENDING_LIMITS.leadTime} dias úteis`);
      continue;
    }

    const responsibleName = text(item.responsavel);
    let responsible = actor;
    if (responsibleName) {
      const found = findPerson(people, responsibleName);
      if ('candidates' in found) {
        skipped.push(
          found.candidates.length
            ? `"${title}": responsável "${responsibleName}" bate com mais de uma pessoa (${found.candidates.map(p => p.name).join('; ')}); pergunte qual`
            : `"${title}": responsável "${responsibleName}" não tem acesso a esta obra; pessoas da obra: ${namesList(
                people.map(p => p.name),
                40,
              )}`,
        );
        continue;
      }
      responsible = found;
    }
    if (!responsible) {
      skipped.push(`"${title}": informe o responsável (quem pediu não está entre as pessoas da obra)`);
      continue;
    }

    // Duplicadas: contra os cards em aberto e contra os itens já aceitos nesta proposta.
    const confirmed = item.criar_mesmo_parecida === true;
    const existing = open
      .map(card => ({
        card,
        score: Math.max(
          titleSimilarity(card.title, title),
          // Mesma tarefa ou serviço de origem com título próximo: quase certamente a mesma restrição.
          source && card.sourceId === source.id && titleSimilarity(card.title, title) >= 0.4 ? SIMILARITY_THRESHOLD : 0,
        ),
      }))
      .filter(entry => entry.score >= SIMILARITY_THRESHOLD)
      .sort((a, b) => b.score - a.score);
    const same = existing.find(entry => entry.score >= 1);
    if (same) {
      skipped.push(`"${title}": já existe no quadro — ${cardSummary(same.card, people)}`);
      continue;
    }
    if (existing.length && !confirmed) {
      skipped.push(
        `"${title}": parece a mesma restrição de ${existing
          .slice(0, 3)
          .map(entry => cardSummary(entry.card, people))
          .join(' e de ')}; mostre à pessoa e só proponha de novo, com criar_mesmo_parecida verdadeiro, se ela confirmar que é outra`,
      );
      continue;
    }
    const twin = commands.find(c => c.type === 'create_card' && titleSimilarity(c.title, title) >= (confirmed ? 1 : SIMILARITY_THRESHOLD));
    if (twin && twin.type === 'create_card') {
      skipped.push(`"${title}": repetida nesta mesma proposta ("${twin.title}")`);
      continue;
    }

    commands.push({
      type: 'create_card',
      workId: ctx.workId,
      title,
      ...(description ? { description } : {}),
      origin,
      ...(source ? { sourceId: source.id, sourceLabel: source.label.slice(0, PENDING_LIMITS.title) } : {}),
      dueDate,
      leadTimeDays,
      responsibleId: responsible.id,
    });
    const link = source ? ` — trava ${origin === 'medio_prazo' ? 'a tarefa' : 'o serviço'} "${oneLine(source.label)}"` : '';
    const lead =
      leadTimeDays > 0
        ? `, ${leadTimeDays} ${leadTimeDays === 1 ? 'dia útil' : 'dias úteis'} de execução (começar até ${dmy(startBy({ dueDate, leadTimeDays }))})`
        : '';
    lines.push(`${title}${link}: entrega ${dmy(dueDate)}${lead}, responsável ${responsible.name}`);
  }

  const checked = `Conferido com os ${open.length} cards em aberto do quadro.`;
  if (!commands.length)
    return {
      result: `Nenhuma restrição a criar. ${checked}${skipped.length ? ` Ficaram de fora: ${skipped.join('; ')}.` : ''}`,
      error: true,
    };
  const proposal: RestrictionProposal = {
    id: ctx.newId(),
    kind: 'restricao',
    title: `Criar ${commands.length === 1 ? '1 restrição' : `${commands.length} restrições`} no Quadro de Restrições`,
    lines,
    commands: [],
    pendingCommands: commands,
    weekStart: '',
    skipped,
  };
  return {
    result: `Proposta ${proposal.id} criada: ${proposal.title}. Ela aparece na tela com o botão Aplicar; nada foi gravado ainda. ${checked}\n${lines
      .map(line => `- ${line}`)
      .join('\n')}${skipped.length ? `\nFicaram de fora: ${skipped.join('; ')}.` : ''}`,
    proposal,
  };
}

/** Executa uma das duas ferramentas de restrição. Entrada inválida vira texto de erro para o modelo. */
export async function runRestrictionTool(name: string, input: unknown, ctx: RestrictionToolContext): Promise<RestrictionOutcome> {
  const args = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  if (name === 'listar_restricoes') return listRestrictions(args, ctx);
  if (name === 'propor_restricoes') return proposeRestrictions(args, ctx);
  return { result: `Ferramenta "${name}" não existe.`, error: true };
}

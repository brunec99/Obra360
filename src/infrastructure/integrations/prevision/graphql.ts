/** Leitura do cronograma de uma obra pela API GraphQL do Prevision (23/11/2026), para transcrever a
 * Linha de Balanço (`scripts/import-lob-prevision.ts --prevision`). Só consulta: nada é escrito lá.
 *
 * A credencial é a "API da Prevision" de Configurações → Integrações (24 caracteres), lida de
 * `PREVISION_GRAPHQL_TOKEN` só no servidor ou no script. NÃO é a `PREVISION_API_TOKEN` da API REST
 * (um JWT), usada pela tela Integrações: a REST recusa a chave de 24 caracteres. O Prevision avisa
 * que o GraphQL funciona até 17/01/2028; depois disso a leitura precisa migrar para a REST
 * (`/activities`, `/activities/dependencies` e `/floors`). */
import type { PrevisionApiProject } from '../../../domain/lob-prevision-import';

const ENDPOINT = 'https://api.prevision.com.br/graphql';
/** Pausa entre consultas: o Prevision pede moderação e cargas grandes fora do horário comercial. */
const PAUSE_MS = 1500;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const token = process.env.PREVISION_GRAPHQL_TOKEN;
  if (!token) throw new Error('Defina PREVISION_GRAPHQL_TOKEN (a chave "API da Prevision" de Configurações → Integrações).');
  for (let attempt = 0; ; attempt++) {
    let detail: string;
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { UserAuthorization: `token ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        redirect: 'error',
        signal: AbortSignal.timeout(120000),
      });
      if (response.status === 401 || response.status === 403) throw new PrevisionGraphqlDenied();
      const body = (await response.json().catch(() => undefined)) as { data?: T; errors?: { message?: string }[] } | undefined;
      if (response.ok && body?.data && !body.errors?.length) {
        await sleep(PAUSE_MS);
        return body.data;
      }
      detail = body?.errors?.[0]?.message ?? `HTTP ${response.status}`;
    } catch (error) {
      if (error instanceof PrevisionGraphqlDenied) throw error;
      detail = error instanceof Error ? error.message : String(error);
    }
    if (attempt >= 3) throw new Error(`O Prevision não atendeu a consulta: ${detail}`);
    await sleep(5000 * (attempt + 1));
  }
}
class PrevisionGraphqlDenied extends Error {
  constructor() {
    super('O Prevision recusou a chave de PREVISION_GRAPHQL_TOKEN.');
  }
}

/** As obras da empresa no Prevision. */
export async function listPrevisionGraphqlProjects(): Promise<{ id: string; name: string; phase?: string | null }[]> {
  const projects: { id: string; name: string; phase?: string | null }[] = [];
  for (let after = ''; ;) {
    const data = await graphql<{
      me: {
        projectsPage: {
          pageInfo: { hasNextPage: boolean; endCursor: string };
          nodes: { id: string; name: string; phase?: string | null }[];
        };
      };
    }>(
      `
        query Projects($after: String) {
          me {
            projectsPage(first: 100, after: $after) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                id
                name
                phase
              }
            }
          }
        }
      `,
      { after },
    );
    projects.push(...data.me.projectsPage.nodes);
    if (!data.me.projectsPage.pageInfo.hasNextPage) return projects;
    after = data.me.projectsPage.pageInfo.endCursor;
  }
}

// O Prevision entrega no máximo 50 itens por página, qualquer que seja o `first`: toda lista é
// percorrida até o fim e conferida com o `totalCount`.
const HEAD = `query Head($id: ID!) { me { project(id: $id) { id name scheduleType
  calendar { startAt endAt holidays weekWorkdays { sunday monday tuesday wednesday thursday friday saturday } }
} } }`;
const FLOORS = `query Floors($id: ID!, $after: String) { me { project(id: $id) {
  page: floorsPage(first: 50, after: $after) { totalCount pageInfo { hasNextPage endCursor } nodes { id name position } } } } }`;
const SERVICES = `query Services($id: ID!, $after: String) { me { project(id: $id) {
  page: servicesPage(first: 50, after: $after) { totalCount pageInfo { hasNextPage endCursor } nodes { id name position color } } } } }`;
const ACTIVITIES = `query Activities($id: ID!, $after: String) { me { project(id: $id) {
  page: activitiesPage(first: 50, after: $after) { totalCount pageInfo { hasNextPage endCursor }
    nodes { id startAt endAt workDuration percentageCompleted service { id } floor { id }
      predecessorsPage(first: 50, after: "") { totalCount nodes { baseAttribute precedenceAttribute timeOperation delay predecessor { id } } }
    } } } } }`;

interface Page<T> {
  totalCount: number;
  pageInfo?: { hasNextPage: boolean; endCursor: string };
  nodes: T[];
}
interface RawActivity {
  id: string;
  startAt?: string | null;
  endAt?: string | null;
  workDuration?: number | null;
  percentageCompleted?: number | null;
  service?: { id: string } | null;
  floor?: { id: string } | null;
  predecessorsPage: Page<{
    baseAttribute: string;
    precedenceAttribute: string;
    timeOperation: string;
    delay: number;
    predecessor: { id: string };
  }>;
}

/** Uma lista paginada inteira; falha se o total não fechar. */
async function allPages<T>(query: string, projectId: string, what: string): Promise<T[]> {
  const items: T[] = [];
  for (let after = ''; ;) {
    const page = (await graphql<{ me: { project: { page: Page<T> } | null } }>(query, { id: projectId, after })).me.project?.page;
    if (!page) throw new Error(`O Prevision não devolveu a lista de ${what}.`);
    items.push(...page.nodes);
    if (!page.pageInfo?.hasNextPage || !page.nodes.length) {
      if (items.length !== page.totalCount) throw new Error(`O Prevision devolveu ${items.length} de ${page.totalCount} ${what}.`);
      return items;
    }
    after = page.pageInfo.endCursor;
  }
}

/** O cronograma inteiro de uma obra: calendário, lotes, serviços, atividades e dependências. Falha se
 * alguma lista vier cortada, para nunca transcrever uma Linha de Balanço pela metade. */
export async function fetchPrevisionGraphqlProject(projectId: string): Promise<PrevisionApiProject> {
  if (!/^\d+$/.test(projectId)) throw new Error('Identificador de obra do Prevision inválido.');
  const head = (
    await graphql<{
      me: {
        project: {
          id: string;
          name: string;
          scheduleType?: string | null;
          calendar?: PrevisionApiProject['calendar'];
        } | null;
      };
    }>(HEAD, { id: projectId })
  ).me.project;
  if (!head) throw new Error(`Obra ${projectId} não encontrada no Prevision.`);
  const floors = await allPages<PrevisionApiProject['floors'][number]>(FLOORS, projectId, 'lotes');
  const services = await allPages<PrevisionApiProject['services'][number]>(SERVICES, projectId, 'serviços');
  const raw = await allPages<RawActivity>(ACTIVITIES, projectId, 'atividades');
  if (raw.some(a => a.predecessorsPage.nodes.length < a.predecessorsPage.totalCount))
    throw new Error('Uma atividade tem mais de 50 predecessoras no Prevision: a leitura das dependências precisa ser paginada.');
  return {
    id: head.id,
    name: head.name,
    scheduleType: head.scheduleType,
    calendar: head.calendar,
    floors,
    services,
    activities: raw.map(a => ({
      id: a.id,
      serviceId: a.service?.id ?? '',
      floorId: a.floor?.id ?? '',
      startAt: a.startAt,
      endAt: a.endAt,
      workDuration: a.workDuration,
      percentageCompleted: a.percentageCompleted,
      predecessors: a.predecessorsPage.nodes.map(p => ({
        predecessorId: p.predecessor.id,
        baseAttribute: p.baseAttribute,
        precedenceAttribute: p.precedenceAttribute,
        timeOperation: p.timeOperation,
        delay: p.delay,
      })),
    })),
  };
}

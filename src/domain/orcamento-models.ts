/**
 * Modelos IFC que vivem no Orçamento 4D e aparecem no Modelo federado do Obra 360.
 *
 * O Orçamento 4D guarda os modelos no schema `orcamento` do mesmo banco (takt-hub): uma linha por modelo
 * em `modelos_ifc`, os elementos em `elementos_ifc` e a geometria convertida (Fragments) em partes de 2 MB em
 * `geometrias`. O Obra 360 só lê: nada é copiado nem gravado lá. Aqui ficam as regras puras dessa leitura
 * (qual obra de lá corresponde à obra daqui, o que conta como modelo pronto, conferência dos parâmetros);
 * quem fala com o banco é `src/infrastructure/orcamento/ifc-models.ts`.
 */

export interface OrcamentoObra {
  id: string;
  name: string;
}

/** Um modelo do Orçamento 4D como a tela precisa: uma disciplina, uma revisão, a geometria em partes. */
export interface OrcamentoModel {
  id: string;
  discipline: string;
  file: string;
  /** Sobe a cada reenvio do IFC no Orçamento 4D; a geometria em cache no navegador vale por revisão. */
  revision: number;
  /** Partes da geometria no banco; 0 quando o modelo ainda não tem geometria gravada. */
  parts: number;
  /** Tamanho da geometria convertida, em bytes (0 se desconhecido). */
  byteSize: number;
  elements: number;
}

/** O elemento clicado no 3D, com as propriedades do tipo já somadas às dele. */
export interface OrcamentoElement {
  expressId: number;
  globalId: string | null;
  ifcClass: string;
  name: string | null;
  typeName: string | null;
  storey: string | null;
  materials: string[];
  classifications: string[];
  /** Quantidades que vieram no IFC (Qto_*). */
  ifcQuantities: Record<string, number>;
  /** Quantidades calculadas pela geometria na leitura do arquivo. */
  geometryQuantities: Record<string, number>;
  properties: Record<string, string | number | boolean>;
}

/** Nome sem acento, caixa nem espaços sobrando: "Tauá " e "taua" são a mesma obra. */
export function normalizeObraName(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * A obra do Orçamento 4D que corresponde à obra do Obra 360: mesmo nome (sem acento nem caixa).
 * Obra privada de lá (`orcamento.obras_privadas`) nunca casa: é de quem a criou, não da equipe da obra.
 * Dois empreendimentos com o mesmo nome também não casam: não há como saber qual é o certo.
 */
export function matchOrcamentoObra(
  workName: string,
  obras: readonly { id: string; nome: string }[],
  privateIds: Iterable<string>,
): OrcamentoObra | null {
  const target = normalizeObraName(workName);
  if (!target) return null;
  const hidden = new Set(privateIds);
  const found = obras.filter(obra => !hidden.has(obra.id) && normalizeObraName(obra.nome) === target);
  return found.length === 1 ? { id: found[0].id, name: found[0].nome } : null;
}

export interface OrcamentoModelRow {
  id: string;
  disciplina: string | null;
  arquivo: string | null;
  status: string | null;
  revisao: number | null;
  geometria_partes: number | null;
  fragments_tamanho: number | null;
  total_elementos: number | null;
}

/** Só modelo pronto entra na lista; em processamento ou com erro de leitura fica de fora. */
export function toOrcamentoModels(rows: readonly OrcamentoModelRow[]): OrcamentoModel[] {
  return rows
    .filter(row => row.status === 'pronto')
    .map(row => ({
      id: row.id,
      discipline: row.disciplina?.trim() || row.arquivo?.trim() || 'Modelo',
      file: row.arquivo?.trim() || '',
      revision: Number(row.revisao) || 1,
      parts: Math.max(0, Number(row.geometria_partes) || 0),
      byteSize: Math.max(0, Number(row.fragments_tamanho) || 0),
      elements: Math.max(0, Number(row.total_elementos) || 0),
    }))
    .sort((a, b) => a.discipline.localeCompare(b.discipline, 'pt-BR', { numeric: true }) || a.file.localeCompare(b.file, 'pt-BR'));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string) => UUID.test(value);

/** Inteiro não negativo vindo da URL; null para qualquer outra coisa ("", "1.5", "-1", "abc"). */
export function parseIndex(value: string | null): number | null {
  if (!value || !/^\d{1,9}$/.test(value)) return null;
  return Number(value);
}

/**
 * A parte pedida existe na revisão atual do modelo? A tela pede sempre a revisão que acabou de listar; se o
 * modelo foi reenviado nesse meio-tempo, as partes antigas já foram apagadas e a tela precisa recarregar a lista.
 */
export function partRequestProblem(model: { revision: number; parts: number }, revision: number, part: number): string | null {
  if (!model.parts) return 'Este modelo ainda não tem geometria no Orçamento 4D.';
  if (revision !== model.revision) return 'O modelo recebeu uma revisão nova no Orçamento 4D. Recarregue a página.';
  if (part >= model.parts) return 'Parte da geometria fora do intervalo.';
  return null;
}

/** Junta as partes da geometria, na ordem, num único arquivo. */
export function joinParts(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
const record = (value: unknown): Record<string, Json> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, Json>) : {};
const numbers = (value: unknown): Record<string, number> =>
  Object.fromEntries(Object.entries(record(value)).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
const texts = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
const scalars = (value: unknown): Record<string, string | number | boolean> =>
  Object.fromEntries(
    Object.entries(record(value)).filter((entry): entry is [string, string | number | boolean] =>
      ['string', 'number', 'boolean'].includes(typeof entry[1]),
    ),
  );

/** Linha de `orcamento.elementos_ifc` (e as propriedades do tipo, se houver) no formato da tela. */
export function toOrcamentoElement(row: Record<string, unknown>, typeProps?: unknown): OrcamentoElement {
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);
  return {
    expressId: Number(row.express_id),
    globalId: text(row.global_id),
    ifcClass: text(row.ifc_classe) ?? '',
    name: text(row.nome),
    typeName: text(row.tipo_nome),
    storey: text(row.pavimento),
    materials: texts(row.materiais),
    classifications: texts(row.classificacoes),
    ifcQuantities: numbers(row.qtd_ifc),
    geometryQuantities: numbers(row.qtd_geo),
    // as propriedades da instância têm prioridade sobre as do tipo
    properties: { ...scalars(typeProps), ...scalars(row.props) },
  };
}

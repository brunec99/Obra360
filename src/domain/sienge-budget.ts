/** Orçamento do Sienge para a visão Custos da Linha de Balanço (23/11/2026).
 *
 * Funções puras: leem a resposta das rotas de planilha do orçamento do Sienge
 * (`/building-cost-estimations/{obra}/sheets` e `.../sheets/{unidade}/items`) e devolvem os itens que
 * a tela Custos usa. No Sienge o orçamento de uma obra se divide em unidades construtivas
 * ("PROJETOS", "EDIFICAÇÃO"…), e cada unidade é uma árvore: as linhas agrupadoras (sem serviço) somam
 * os filhos, e só as folhas têm quantidade, preço e total. Entram na tela as folhas com valor.
 *
 * O código da EAP (`wbsCode`) se repete entre as unidades (toda unidade começa em "01"), por isso o
 * código gravado no Obra 360 leva a unidade na frente: "UC7 01.002.003.004". É por ele que uma nova
 * busca reconhece o item já apropriado. */

export interface SiengeEnterprise {
  id: number;
  name: string;
}
export interface SiengeSheet {
  id: number;
  description: string;
}
/** Um item do orçamento (folha da árvore) como a tela Custos recebe. */
export interface SiengeBudgetLine {
  sheetId: number;
  /** Código gravado no item de custo: unidade construtiva + código da EAP. */
  code: string;
  wbsCode: string;
  description: string;
  /** Descrição dos agrupadores acima do item, do mais alto ao mais próximo. */
  path: string[];
  /** O agrupador imediato do item (o "grupo de serviço"), quando existe. */
  group?: { wbsCode: string; description: string };
  unit?: string;
  quantity?: number;
  amount: number;
}
/** Resumo de uma unidade construtiva depois da leitura. */
export interface SiengeSheetSummary extends SiengeSheet {
  /** Folhas da unidade no Sienge, com e sem valor. */
  items: number;
  /** Folhas com valor acima de zero: as que entram na tela. */
  valued: number;
  total: number;
}
export interface SiengeBudget {
  buildingId: number;
  sheets: SiengeSheetSummary[];
  lines: SiengeBudgetLine[];
  total: number;
  /** Carimbo ISO da leitura no Sienge. */
  readAt: string;
}

/** Código de empreendimento do Sienge: inteiro positivo de até 9 dígitos. */
export const SIENGE_BUILDING_ID = /^[1-9]\d{0,8}$/;
export function parseSiengeBuildingId(value: unknown): number | null {
  const text = typeof value === 'number' && Number.isInteger(value) ? String(value) : typeof value === 'string' ? value.trim() : '';
  return SIENGE_BUILDING_ID.test(text) ? Number(text) : null;
}

const SIENGE_CODE = /^UC(\d+) (\S+)$/;
export const siengeCode = (sheetId: number, wbsCode: string) => `UC${sheetId} ${wbsCode}`;
/** A unidade construtiva de um código vindo do Sienge, ou nulo quando o código não é do Sienge. */
export function siengeSheetOfCode(code: string | undefined | null): number | null {
  const match = code ? SIENGE_CODE.exec(code.trim()) : null;
  return match ? Number(match[1]) : null;
}

const clean = (value: unknown) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
const numberOf = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const cents = (value: number) => Math.round(value * 100) / 100;
const rows = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object') : [];

export function normalizeEnterprises(raw: unknown): SiengeEnterprise[] {
  const out: SiengeEnterprise[] = [];
  for (const row of rows(raw)) {
    const id = parseSiengeBuildingId(row.id);
    const name = clean(row.name);
    if (id !== null && name) out.push({ id, name });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR') || a.id - b.id);
}

export function normalizeSheets(raw: unknown): SiengeSheet[] {
  const out: SiengeSheet[] = [];
  for (const row of rows(raw)) {
    const id = parseSiengeBuildingId(row.id);
    if (id !== null) out.push({ id, description: clean(row.description) || `Unidade construtiva ${id}` });
  }
  return out.sort((a, b) => a.id - b.id);
}

/** Compara códigos da EAP parte a parte ("01.002" antes de "01.010", "2" antes de "10"). */
export function compareWbs(a: string, b: string): number {
  const left = a.split('.');
  const right = b.split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] === undefined) return -1;
    if (right[i] === undefined) return 1;
    const diff = Number(left[i]) - Number(right[i]);
    if (Number.isFinite(diff) && diff !== 0) return diff;
    if (!Number.isFinite(diff) && left[i] !== right[i]) return left[i].localeCompare(right[i]);
  }
  return 0;
}

/** Lê os itens de uma unidade construtiva. Folha = linha com serviço (`workItemId`) ou com total
 * próprio; o agrupador vem com os dois nulos e serve só para o caminho. Linha sem código ou sem
 * descrição é descartada; código repetido dentro da unidade fica com a primeira ocorrência. */
export function normalizeSheetItems(sheet: SiengeSheet, raw: unknown): { summary: SiengeSheetSummary; lines: SiengeBudgetLine[] } {
  const groups = new Map<string, string>();
  const leaves: { wbsCode: string; description: string; unit: string; quantity: number | null; amount: number }[] = [];
  const seen = new Set<string>();
  for (const row of rows(raw)) {
    const wbsCode = clean(row.wbsCode);
    const description = clean(row.description);
    if (!wbsCode || !description) continue;
    const total = numberOf(row.totalPrice);
    const isLeaf = (row.workItemId !== null && row.workItemId !== undefined) || total !== null;
    if (!isLeaf) {
      if (!groups.has(wbsCode)) groups.set(wbsCode, description);
      continue;
    }
    if (seen.has(wbsCode)) continue;
    seen.add(wbsCode);
    leaves.push({
      wbsCode,
      description,
      unit: clean(row.unitOfMeasure),
      quantity: numberOf(row.quantity),
      amount: cents(Math.max(0, total ?? 0)),
    });
  }
  leaves.sort((a, b) => compareWbs(a.wbsCode, b.wbsCode));
  const lines: SiengeBudgetLine[] = [];
  for (const leaf of leaves) {
    if (leaf.amount <= 0) continue;
    const parts = leaf.wbsCode.split('.');
    const path: string[] = [];
    for (let depth = 1; depth < parts.length; depth++) {
      const group = groups.get(parts.slice(0, depth).join('.'));
      if (group) path.push(group);
    }
    const groupWbs = parts.slice(0, -1).join('.');
    const groupDescription = groupWbs ? groups.get(groupWbs) : undefined;
    lines.push({
      sheetId: sheet.id,
      code: siengeCode(sheet.id, leaf.wbsCode),
      wbsCode: leaf.wbsCode,
      description: leaf.description,
      path,
      ...(groupDescription ? { group: { wbsCode: groupWbs, description: groupDescription } } : {}),
      ...(leaf.unit ? { unit: leaf.unit } : {}),
      ...(leaf.quantity !== null ? { quantity: leaf.quantity } : {}),
      amount: leaf.amount,
    });
  }
  const total = cents(lines.reduce((sum, line) => sum + line.amount, 0));
  return { summary: { ...sheet, items: leaves.length, valued: lines.length, total }, lines };
}

const plainName = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Empreendimento sugerido para uma obra, pelo nome. Na ATR cada obra tem dois empreendimentos no
 * Sienge, "Nome (ADM)" e "Nome (ENG)", e o orçamento da obra fica no ENG; quando há mais de um ENG
 * com o mesmo nome, vale o de código maior (o mais novo). É só sugestão: quem grava é a pessoa. */
export function suggestEnterprise(workName: string, enterprises: readonly SiengeEnterprise[]): SiengeEnterprise | null {
  const target = plainName(workName);
  if (!target) return null;
  const candidates = enterprises
    .map(enterprise => ({ enterprise, name: plainName(enterprise.name) }))
    .filter(({ name }) => name === `${target} eng` || (name.startsWith(`${target} `) && name.endsWith(' eng')))
    .sort((a, b) => Number(b.name === `${target} eng`) - Number(a.name === `${target} eng`) || b.enterprise.id - a.enterprise.id);
  return candidates[0]?.enterprise ?? null;
}

// ─── Linhas para a tela Custos ──────────────────────────────────────────────────

/** Nível de detalhe com que o orçamento entra na tela Custos: por grupo de serviço (o agrupador
 * imediato dos itens, como "ALVENARIA DE VEDAÇÃO - Mão de Obra / Serviços", somando os itens dele) ou
 * item a item (cada insumo ou serviço do orçamento). */
export type SiengeDetail = 'grupo' | 'item';
export interface SiengeCostLine {
  sheetId: number;
  code: string;
  description: string;
  amount: number;
}
/** Limite da descrição de um item de custo (o mesmo de `LOB_LIMITS.costDescription`). */
const DESCRIPTION_LIMIT = 200;

/** As linhas que entram na tela, no nível pedido. Por grupo, os itens de um mesmo agrupador viram uma
 * linha com a soma (item solto, sem agrupador, entra como ele mesmo); item a item, a descrição leva o
 * grupo na frente ("grupo › item"), porque "Areia Média" sozinha não diz a que serviço pertence. */
export function siengeCostLines(lines: readonly SiengeBudgetLine[], detail: SiengeDetail): SiengeCostLine[] {
  if (detail === 'item')
    return lines.map(line => ({
      sheetId: line.sheetId,
      code: line.code,
      description: (line.group ? `${line.group.description} › ${line.description}` : line.description).slice(0, DESCRIPTION_LIMIT),
      amount: line.amount,
    }));
  const byCode = new Map<string, SiengeCostLine>();
  for (const line of lines) {
    const code = line.group ? siengeCode(line.sheetId, line.group.wbsCode) : line.code;
    const current = byCode.get(code);
    if (current) current.amount = cents(current.amount + line.amount);
    else
      byCode.set(code, {
        sheetId: line.sheetId,
        code,
        description: (line.group?.description ?? line.description).slice(0, DESCRIPTION_LIMIT),
        amount: line.amount,
      });
  }
  return [...byCode.values()];
}

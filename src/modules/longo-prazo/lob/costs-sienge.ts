/** Funções puras do "Buscar do Sienge" da tela Custos (23/11/2026): juntam as linhas vindas do
 * orçamento do Sienge ao rascunho dos itens de custo. O item é reconhecido pelo código ("UC7
 * 03.001.004"): quem já está na tela tem descrição e valor atualizados e mantém o pacote; quem é novo
 * entra como não apropriado. Nada é gravado aqui: só o "Salvar" da tela grava. */
import type { LobId } from '@/domain/lob';
import { siengeSheetOfCode, type SiengeCostLine } from '@/domain/sienge-budget';
import { addItems, removeItems, updateItem, type DraftContext, type DraftCost } from './costs-model';

export interface SiengeMergeSummary {
  /** Linhas novas, que entram como não apropriadas. */
  added: number;
  /** Linhas novas que herdaram o pacote de itens do mesmo ramo já apropriados noutro nível de detalhe. */
  inherited: number;
  /** Itens que já estavam na tela e mudaram de valor ou descrição. */
  updated: number;
  /** Itens que já estavam na tela e continuam iguais. */
  unchanged: number;
  /** Itens do Sienge que saem da tela: não estão mais no orçamento ou estavam noutro nível de detalhe. */
  removed: number;
  /** Soma das linhas trazidas. */
  total: number;
}

const cents = (value: number) => Math.round(value * 100) / 100;

/** Pacote que uma linha nova herda dos itens do Sienge já na tela, quando o nível de detalhe mudou:
 * de um item acima dela (o grupo já apropriado) ou dos itens abaixo dela, se todos estão no mesmo
 * pacote. Sem isso, trocar o nível jogaria fora a apropriação feita. */
function inheritedService(code: string, sienge: readonly DraftCost[]): LobId | undefined {
  const above = sienge.find(item => item.serviceId && code.startsWith(`${item.code}.`));
  if (above) return above.serviceId;
  const below = sienge.filter(item => item.code!.startsWith(`${code}.`));
  if (!below.length || below.some(item => !item.serviceId)) return undefined;
  const services = new Set(below.map(item => item.serviceId));
  return services.size === 1 ? below[0].serviceId : undefined;
}

/** Junta as linhas do Sienge ao rascunho. `sheetIds` são as unidades construtivas trazidas: os itens
 * do Sienge dessas unidades que não vieram agora saem do rascunho (ficar com eles contaria o mesmo
 * custo duas vezes); os das outras unidades e os itens digitados ou colados não mudam. */
export function mergeSiengeBudget(
  draft: readonly DraftCost[],
  lines: readonly SiengeCostLine[],
  sheetIds: Iterable<number>,
  context: DraftContext,
): { draft: DraftCost[]; summary: SiengeMergeSummary } {
  const sheets = new Set(sheetIds);
  const sienge = draft.filter(item => {
    const sheet = siengeSheetOfCode(item.code);
    return sheet !== null && sheets.has(sheet);
  });
  const byCode = new Map<string, DraftCost>();
  for (const item of sienge) if (!byCode.has(item.code!)) byCode.set(item.code!, item);

  const summary: SiengeMergeSummary = { added: 0, inherited: 0, updated: 0, unchanged: 0, removed: 0, total: 0 };
  const kept = new Set<LobId>();
  const fresh: { serviceId?: LobId; code: string; description: string; amount: number }[] = [];
  let next = [...draft];
  for (const line of lines) {
    if (!sheets.has(line.sheetId)) continue;
    summary.total = cents(summary.total + line.amount);
    const current = byCode.get(line.code);
    if (!current) {
      const serviceId = inheritedService(line.code, sienge);
      if (serviceId) summary.inherited++;
      summary.added++;
      fresh.push({ serviceId, code: line.code, description: line.description, amount: line.amount });
      continue;
    }
    kept.add(current.id);
    if (current.description === line.description && current.amount === cents(line.amount)) summary.unchanged++;
    else {
      summary.updated++;
      next = updateItem(next, current.id, { description: line.description, amount: line.amount });
    }
  }
  const stale = sienge.filter(item => !kept.has(item.id)).map(item => item.id);
  summary.removed = stale.length;
  next = addItems(removeItems(next, stale), fresh, context);
  return { draft: next, summary };
}

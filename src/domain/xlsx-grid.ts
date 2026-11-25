/** Grade de uma planilha lida de um .xlsx (25/11/2026): o que as importações precisam de uma folha,
 * sem depender de como o arquivo foi aberto. Linhas e colunas começam em 1, como no Excel. A leitura do
 * arquivo fica em `src/infrastructure/files/xlsx.ts`. */
export interface XlsxCell {
  /** Texto (já com as entidades XML resolvidas) ou número. Célula sem valor não entra na grade. */
  value?: string | number;
  /** Cor de preenchimento sólido, "#rrggbb" em minúsculas. */
  fill?: string;
}
export interface XlsxRange {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}
export interface XlsxGrid {
  name: string;
  cells: Map<string, XlsxCell>;
  merges: XlsxRange[];
}

export const cellKey = (row: number, col: number) => `${row}:${col}`;

/** "A1" → linha 1, coluna 1; "DEU193" → linha 193, coluna 2855. */
export function parseCellRef(ref: string): { row: number; col: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(ref.trim().toUpperCase());
  if (!m) throw new Error(`Referência de célula inválida: ${ref}`);
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(m[2]), col };
}

/** "A1:B2" → intervalo; "A1" → a própria célula. */
export function parseRangeRef(ref: string): XlsxRange {
  const [a, b = a] = ref.split(':');
  const start = parseCellRef(a);
  const end = parseCellRef(b);
  return {
    r0: Math.min(start.row, end.row),
    c0: Math.min(start.col, end.col),
    r1: Math.max(start.row, end.row),
    c1: Math.max(start.col, end.col),
  };
}

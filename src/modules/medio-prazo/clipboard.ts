/** TSV com aspas compatível com células multilinha de planilhas. */
export function encodeGrid(values: string[][]): string {
  return values.map(row => row.map(cell => (/[\t\n\r"]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join('\t')).join('\n');
}
export function decodeGrid(text: string, limit = 1000): string[][] {
  if (text.length > 1_000_000) throw new Error('Colagem excede o limite de texto.');
  const rows: string[][] = [[]];
  let value = '',
    quoted = false,
    closed = false,
    count = 0;
  const cell = () => {
    rows.at(-1)!.push(value);
    value = '';
    closed = false;
    if (++count > limit) throw new Error(`Limite de ${limit} células por operação.`);
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else value += c;
      continue;
    }
    if (c === '"' && !value && !closed) {
      quoted = true;
      continue;
    }
    if (c === '\t') {
      cell();
      continue;
    }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      cell();
      if (i < text.length - 1) rows.push([]);
      continue;
    }
    if (closed) throw new Error('Texto inválido após fechamento de aspas.');
    value += c;
  }
  if (quoted) throw new Error('Colagem contém aspas não fechadas.');
  if (value || closed || !/[\r\n]$/.test(text)) cell();
  if (rows.some(row => row.length !== rows[0].length)) throw new Error('Selecione um intervalo retangular.');
  return rows;
}
/** Intervalo selecionado na grade, em posições de linha e coluna visíveis. */
export interface GridRange {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}
/** Onde cada valor colado cai, como no Excel: com mais de uma célula selecionada e a seleção múltipla
 * exata do bloco copiado (uma célula copiada serve para qualquer seleção), o bloco se repete até cobrir
 * a seleção; senão, ele entra inteiro a partir do canto de cima à esquerda da seleção, ainda que passe
 * dela — quem chama decide o que fazer com o que sobrar da grade. */
export function pasteTargets(matrix: string[][], range: GridRange): { row: number; col: number; text: string }[] {
  const height = matrix.length,
    width = matrix[0]?.length ?? 0;
  if (!height || !width) return [];
  const rows = range.r1 - range.r0 + 1,
    cols = range.c1 - range.c0 + 1;
  const tile = (rows > 1 || cols > 1) && rows % height === 0 && cols % width === 0;
  const out: { row: number; col: number; text: string }[] = [];
  for (let r = 0; r < (tile ? rows : height); r++)
    for (let c = 0; c < (tile ? cols : width); c++) out.push({ row: range.r0 + r, col: range.c0 + c, text: matrix[r % height][c % width] });
  return out;
}

/** Leitura de uma folha de um arquivo .xlsx (25/11/2026), sem biblioteca: o .xlsx é um zip de XMLs, e
 * aqui só se lê o necessário para as importações (valores, cor de preenchimento e células mescladas).
 * Fórmulas valem pelo último valor gravado no arquivo; datas chegam como o número de série do Excel.
 * Usado pela atualização da Linha de Balanço a partir da exportação do Agilean. */
import { inflateRawSync } from 'node:zlib';
import { cellKey, parseCellRef, parseRangeRef, type XlsxCell, type XlsxGrid } from '../../domain/xlsx-grid';

/** Arquivos do zip pelo nome. Só os métodos "sem compressão" (0) e "deflate" (8), os do Excel. */
export function unzipEntries(bytes: Uint8Array): Map<string, Buffer> {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Fim do diretório central: assinatura 0x06054b50, nos últimos 64 KB + 22 bytes.
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--)
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw new Error('O arquivo não é um .xlsx (zip) válido.');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Diretório do .xlsx corrompido.');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`Entrada ${name} do .xlsx corrompida.`);
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) entries.set(name, Buffer.from(data));
    else if (method === 8) entries.set(name, inflateRawSync(data));
    else throw new Error(`Compressão ${method} não suportada em ${name}.`);
  }
  return entries;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const decodeXml = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, code: string) =>
    code[0] === '#'
      ? String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1)))
      : ENTITIES[code.toLowerCase()],
  );
const attr = (attrs: string, name: string) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1];
/** Texto de um <si> ou <is>: os <t> em sequência (texto rico vem em vários <r><t>). */
const textOf = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => decodeXml(m[1])).join('');

function sheetPath(entries: Map<string, Buffer>, index: number): { name: string; path: string } {
  const workbook = entries.get('xl/workbook.xml')?.toString('utf8');
  if (!workbook) throw new Error('O arquivo não tem xl/workbook.xml: não é uma planilha do Excel.');
  const sheets = [...workbook.matchAll(/<sheet\b([^>]*)\/?>/g)].map(m => ({
    name: decodeXml(attr(m[1], 'name') ?? ''),
    rid: attr(m[1], 'r:id'),
  }));
  const sheet = sheets[index];
  if (!sheet) throw new Error(`A planilha não tem a folha ${index + 1}.`);
  const rels = entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const rel = [...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)].find(m => attr(m[1], 'Id') === sheet.rid);
  const target = rel ? attr(rel[1], 'Target') : undefined;
  const path = target
    ? target.startsWith('/')
      ? target.slice(1)
      : `xl/${target.replace(/^\.\//, '')}`
    : `xl/worksheets/sheet${index + 1}.xml`;
  return { name: sheet.name, path };
}

/** Cor de preenchimento de cada estilo de célula (o atributo `s` aponta para `cellXfs`). Cores por tema
 * ou índice ficam sem cor: o Excel só grava "rgb" quando a cor é escolhida pelo valor. */
function fillsByStyle(styles: string | undefined): (string | undefined)[] {
  if (!styles) return [];
  const fillsXml = /<fills\b[^>]*>([\s\S]*?)<\/fills>/.exec(styles)?.[1] ?? '';
  const fills = [...fillsXml.matchAll(/<fill>([\s\S]*?)<\/fill>|<fill\/>/g)].map(m => {
    const body = m[1] ?? '';
    if (!/patternType="solid"/.test(body)) return undefined;
    const rgb = /<fgColor\b[^>]*\brgb="([0-9A-Fa-f]{6,8})"/.exec(body)?.[1];
    return rgb ? `#${rgb.slice(-6).toLowerCase()}` : undefined;
  });
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '';
  return [...xfs.matchAll(/<xf\b([^>]*?)(?:\/>|>)/g)].map(m => fills[Number(attr(m[1], 'fillId') ?? 0)]);
}

/** Lê a folha `index` (0 = a primeira) do .xlsx. */
export function readXlsxSheet(bytes: Uint8Array, index = 0): XlsxGrid {
  const entries = unzipEntries(bytes);
  const { name, path } = sheetPath(entries, index);
  const sheet = entries.get(path)?.toString('utf8');
  if (!sheet) throw new Error(`A folha "${name}" não foi encontrada no arquivo (${path}).`);
  const shared = [...(entries.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m =>
    textOf(m[1]),
  );
  const styleFill = fillsByStyle(entries.get('xl/styles.xml')?.toString('utf8'));
  const cells = new Map<string, XlsxCell>();
  for (const m of sheet.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const ref = attr(m[1], 'r');
    if (!ref) continue;
    const { row, col } = parseCellRef(ref);
    const type = attr(m[1], 't');
    const body = m[2] ?? '';
    const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
    let value: string | number | undefined;
    if (type === 's') value = raw === undefined ? undefined : shared[Number(raw)];
    else if (type === 'inlineStr') value = textOf(body);
    else if (type === 'str' || type === 'e') value = raw === undefined ? undefined : decodeXml(raw);
    else if (type === 'b') value = raw === undefined ? undefined : Number(raw);
    else if (raw !== undefined) value = Number(raw);
    const fill = styleFill[Number(attr(m[1], 's') ?? 0)];
    if (value === undefined || value === '') {
      if (fill) cells.set(cellKey(row, col), { fill });
      continue;
    }
    cells.set(cellKey(row, col), fill ? { value, fill } : { value });
  }
  const merges = [...sheet.matchAll(/<mergeCell\b[^>]*\bref="([^"]+)"/g)].map(m => parseRangeRef(m[1]));
  return { name, cells, merges };
}

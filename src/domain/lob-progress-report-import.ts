/** Leitura do relatório "Avanço Físico-Financeiro" (CSV) do sistema de planejamento do Blentt e da
 * Mozine, para transcrever a Linha de Balanço (24/11/2026). O relatório tem uma linha por atividade
 * E por mês, com as colunas Código, Unidade, Local, Macro Etapa, Etapa, Data (mês), Início/Término
 * Planejado Base, Início/Término Planejado, Início/Término Real, Caminho Crítico e os avanços do mês
 * (Real, Reprog e Base, em contribuição, em R$ e em %). Não traz predecessoras.
 *
 * Daqui sai um `PrevisionSchedule`, que `buildPrevisionImport` grava como as outras importações:
 * - cada código de atividade é um bloco (Etapa × Local), nas datas de "Início/Término Planejado";
 * - a linha de base guarda "Início/Término Planejado Base"; atividade sem essas datas fica fora dela;
 * - "Início/Término Real" viram as datas reais do bloco;
 * - o avanço é 100% com término real e, sem ele, a soma do "Real (%)" dos meses (é o avanço
 *   financeiro da atividade: atividade sem custo fica em 0% até terminar);
 * - os locais ficam na ordem do código (o 2º número é o local dentro da unidade), de baixo para cima;
 * - a mesma etapa com dois códigos no mesmo local (duas passadas, como "Forro de gesso") vira dois
 *   serviços: a que começa depois ganha "(2)", porque aqui o bloco é único por serviço × local;
 * - linhas sem código ("Despesas Indiretas") e atividades sem datas planejadas ficam de fora.
 * As dependências são deduzidas por `buildPrevisionImport` (equipe que segue + sequência no local). */
import { addDays, isLocalDate, type LocalDate } from './long-term-plan';
import { LOB_LIMITS, LobError, nextWorkday, normalizeName, previousWorkday, workdaysBetween, type LobCalendar } from './lob';
import { localGroup, type PrevisionBlock, type PrevisionLocalGroup, type PrevisionSchedule } from './lob-prevision-import';

/** CSV com campos entre aspas (aspas dobradas dentro do campo) e separador vírgula ou ponto e vírgula. */
export function parseCsv(text: string): string[][] {
  const source = text.replace(/^﻿/, '');
  const firstLine = source.slice(0, source.search(/\r?\n/) >>> 0);
  const separator = firstLine.split(';').length > firstLine.split(',').length ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === separator) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter(r => r.some(cell => cell.trim()));
}

const clean = (value: string | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
const brDate = (value: string | undefined): LocalDate | undefined => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(clean(value));
  const date = m ? `${m[3]}-${m[2]}-${m[1]}` : undefined;
  return date && isLocalDate(date) ? date : undefined;
};
const percentOf = (value: string | undefined) => {
  const n = Number(clean(value).replace('%', '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};
/** "2º pavto.", "4ºpavto" e "2 PAV" são o mesmo pavimento: a chave serve para reaproveitar o local
 * já cadastrado na obra com outra grafia. */
export function localKey(name: string): string {
  const n = normalizeName(name);
  const floor = /^(\d+)\s*[º°oª]?\s*\.?\s*(pav|andar)/.exec(n) ?? /^(?:pav(?:imento|to)?\.?|andar)\s*(\d+)/.exec(n);
  return floor ? `pavimento ${Number(floor[1])}` : n.replace(/[.\s]+$/, '');
}

const COLUMNS = {
  code: 'codigo',
  unit: 'unidade',
  local: 'local',
  stage: 'etapa',
  start: 'inicio planejado',
  finish: 'termino planejado',
  baseStart: 'inicio planejado base',
  baseFinish: 'termino planejado base',
  actualStart: 'inicio real',
  actualFinish: 'termino real',
  realPercent: 'real (%)',
} as const;

interface ReportActivity {
  code: string;
  unit: string;
  local: string;
  stage: string;
  start?: LocalDate;
  finish?: LocalDate;
  baseStart?: LocalDate;
  baseFinish?: LocalDate;
  actualStart?: LocalDate;
  actualFinish?: LocalDate;
  realPercent: number;
}

/** `existingLocals`: nomes dos locais já cadastrados na obra, para o bloco cair no local existente
 * quando só a grafia muda. `calendar`: o calendário em que os dias úteis serão contados. */
export function readProgressReportSchedule(text: string, calendar?: LobCalendar, existingLocals: string[] = []): PrevisionSchedule {
  const rows = parseCsv(text);
  const headerIndex = rows.findIndex(r => {
    const names = r.map(normalizeName);
    return names.includes(COLUMNS.code) && names.includes(COLUMNS.stage) && names.includes(COLUMNS.start);
  });
  if (headerIndex < 0)
    throw new LobError(
      'O arquivo não é o relatório "Avanço Físico-Financeiro" com as datas: faltam as colunas Código, Etapa e Início Planejado.',
    );
  const header = rows[headerIndex].map(normalizeName);
  const column = Object.fromEntries(Object.entries(COLUMNS).map(([key, name]) => [key, header.indexOf(name)])) as Record<
    keyof typeof COLUMNS,
    number
  >;
  const missing = Object.entries(column)
    .filter(([, index]) => index < 0)
    .map(([key]) => COLUMNS[key as keyof typeof COLUMNS]);
  if (missing.length) throw new LobError(`Faltam colunas no relatório: ${missing.join(', ')}.`);

  // Uma atividade por código: as linhas dos meses repetem as datas e somam o avanço.
  const byCode = new Map<string, ReportActivity>();
  const warnings: string[] = [];
  let withoutCode = 0;
  for (const r of rows.slice(headerIndex + 1)) {
    const code = clean(r[column.code]);
    if (!code) {
      withoutCode++;
      continue;
    }
    const activity = byCode.get(code);
    if (activity) {
      activity.realPercent += percentOf(r[column.realPercent]);
      continue;
    }
    byCode.set(code, {
      code,
      unit: clean(r[column.unit]),
      local: clean(r[column.local]),
      stage: clean(r[column.stage]),
      start: brDate(r[column.start]),
      finish: brDate(r[column.finish]),
      baseStart: brDate(r[column.baseStart]),
      baseFinish: brDate(r[column.baseFinish]),
      actualStart: brDate(r[column.actualStart]),
      actualFinish: brDate(r[column.actualFinish]),
      realPercent: percentOf(r[column.realPercent]),
    });
  }
  if (withoutCode) warnings.push(`${withoutCode} linha(s) sem código de atividade (despesas indiretas): ficaram de fora.`);

  const undated = new Map<string, number>();
  const activities = [...byCode.values()].filter(a => {
    if (a.stage && a.local && a.start && a.finish) return true;
    undated.set(a.stage, (undated.get(a.stage) ?? 0) + 1);
    return false;
  });
  for (const [stage, count] of undated)
    warnings.push(`"${stage}": ${count} atividade(s) sem datas planejadas no relatório: ficaram de fora.`);

  // Ordem dos locais: unidade e local pelo código ("1.4.3.9" = unidade 1, local 4), de baixo para cima.
  const codeNumbers = (code: string) => code.split('.').map(part => Number(part) || 0);
  const localRank = new Map<string, [number, number]>();
  const unitOfLocal = new Map<string, string>();
  for (const a of activities) {
    const [unit, local] = codeNumbers(a.code);
    const current = localRank.get(a.local);
    if (!current || unit < current[0] || (unit === current[0] && local < current[1])) localRank.set(a.local, [unit, local]);
    if (!unitOfLocal.has(a.local)) unitOfLocal.set(a.local, a.unit);
  }
  const existingByKey = new Map(existingLocals.map(name => [localKey(name), name]));
  const localName = new Map<string, string>();
  for (const name of localRank.keys()) localName.set(name, existingByKey.get(localKey(name)) ?? name.slice(0, LOB_LIMITS.name));
  const groupOf = (name: string): PrevisionLocalGroup => {
    const unit = normalizeName(unitOfLocal.get(name) ?? '');
    return unit.startsWith('fachada') ? 'fachada' : unit.startsWith('equipamento') ? 'equipamentos' : localGroup(name);
  };
  const locals = [...localRank.entries()]
    .sort((a, b) => a[1][0] - b[1][0] || a[1][1] - b[1][1])
    .map(([name]) => ({ name: localName.get(name)!, group: groupOf(name) }));

  // A mesma etapa duas vezes no mesmo local: o código sem o local ("3.9", "3.36") diz qual passada é.
  // A passada que começa primeiro fica com o nome da etapa; as outras ganham "(2)", "(3)".
  const passKey = (a: ReportActivity) => a.code.split('.').slice(2).join('.');
  const passes = new Map<string, Map<string, LocalDate>>();
  const perStageLocal = new Map<string, ReportActivity[]>();
  for (const a of activities) {
    const key = `${normalizeName(a.stage)}|${localName.get(a.local)}`;
    perStageLocal.set(key, [...(perStageLocal.get(key) ?? []), a]);
  }
  for (const list of perStageLocal.values()) {
    if (list.length < 2) continue;
    const stage = normalizeName(list[0].stage);
    const known = passes.get(stage) ?? new Map<string, LocalDate>();
    for (const a of list) if (!known.has(passKey(a)) || a.start! < known.get(passKey(a))!) known.set(passKey(a), a.start!);
    passes.set(stage, known);
  }
  const serviceOf = (a: ReportActivity) => {
    const known = passes.get(normalizeName(a.stage));
    const order = known
      ? [...known.entries()].sort((x, y) => x[1].localeCompare(y[1]) || x[0].localeCompare(y[0])).map(([key]) => key)
      : [];
    const index = order.indexOf(passKey(a));
    return index > 0 ? `${a.stage} (${index + 1})` : a.stage;
  };
  for (const [stage, known] of passes)
    if (known.size > 1) {
      const sample = activities.find(a => normalizeName(a.stage) === stage)!.stage;
      warnings.push(
        `"${sample}" acontece ${known.size} vezes no mesmo local: virou ${known.size} serviços ("${sample}", "${sample} (2)"…).`,
      );
    }

  const services: string[] = [];
  const blocks: PrevisionBlock[] = [];
  const seen = new Set<string>();
  let overHundred = 0;
  for (const a of activities) {
    const serviceName = serviceOf(a).slice(0, LOB_LIMITS.name);
    const local = localName.get(a.local)!;
    const key = `${normalizeName(serviceName)}|${normalizeName(local)}`;
    if (seen.has(key)) {
      warnings.push(`"${serviceName} › ${local}" aparece mais de uma vez no relatório (código ${a.code}): valeu a primeira.`);
      continue;
    }
    seen.add(key);
    if (!services.includes(serviceName)) services.push(serviceName);
    const start = nextWorkday(a.start!, calendar);
    const last = previousWorkday(a.finish!, calendar);
    const finish = last < start ? start : last;
    // Com término real o bloco está concluído; sem ele, o avanço financeiro não fecha em 100%.
    let percent = Math.max(0, Math.round(a.realPercent * 10) / 10);
    if (a.actualStart && a.actualFinish) percent = 100;
    else if (percent >= 100) {
      percent = 99;
      overHundred++;
    }
    if (!a.actualStart) percent = 0;
    blocks.push({
      serviceName,
      localName: local,
      start,
      finish,
      workDays: Math.max(1, workdaysBetween(start, addDays(finish, 1), calendar)),
      percent,
      actualStart: a.actualStart,
      actualFinish: a.actualStart ? a.actualFinish : undefined,
      baseStart: a.baseStart,
      baseFinish: a.baseFinish,
    });
  }
  if (overHundred)
    warnings.push(`${overHundred} atividade(s) com 100% de avanço financeiro e sem término real: ficaram com 99%, em andamento.`);
  return { services, locals, blocks, warnings, actualDates: true, baseDates: true };
}

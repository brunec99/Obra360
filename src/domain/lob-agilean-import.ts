/** Atualização da Linha de Balanço pela exportação em Excel do Agilean (25/11/2026, pedido do Daniel
 * para o Blentt: "pode atualizar nossa LOB atualizada do Agilean? Seguiremos fazendo medições e
 * replan pelo Obra 360 após a atualização").
 *
 * A exportação é o desenho da Linha de Balanço numa folha só:
 * - linha do mês ("setembro de 2024", mesclada sobre os dias do mês), linha da letra do dia da semana
 *   e linha do número do dia; cada dia ocupa 4 colunas (quartos de dia) e só aparecem os dias de
 *   trabalho do calendário do Agilean: fim de semana, feriado e recesso não têm coluna;
 * - à esquerda, o grupo (coluna A: "Edificação Fluxo geral") e o local (o rótulo mais à direita antes
 *   dos dias: "12º pavto."), e cada local ocupa as linhas até o rótulo seguinte (4 ou mais: serviços
 *   simultâneos ficam em faixas de uma linha);
 * - cada bloco é uma célula mesclada com o texto "Serviço - N d" e a cor do serviço. O nome vem
 *   abreviado quando o Agilean tem sigla para ele ("Med. hid.", "DW1"), sempre igual para a mesma
 *   cor; o par cor + rótulo identifica o serviço (a mesma cor pode ter dois rótulos).
 * A exportação NÃO traz avanço, datas reais, linha de base nem dependências.
 *
 * Por isso é uma ATUALIZAÇÃO da Linha de Balanço já carregada, não uma importação do zero:
 * - cada serviço do Agilean é ligado a um serviço da obra: nome igual, depois abreviação compatível
 *   (cada pedaço da sigla é o começo de uma palavra do nome, na ordem: "Esq Alum" → "Esquadrias de
 *   alumínio", "ELE-DW" → "Infra elétrica no DW") e, por último, por eliminação pelos locais; em
 *   cada etapa vence o par com as datas mais próximas (assim "Forro de gesso" das áreas comuns e o do
 *   fluxo geral caem em "Forro de gesso" e "Forro de gesso (2)" pela ordem real);
 * - os blocos mantêm o id e mudam só início e duração: medições, datas reais, fotos, restrições e as
 *   linhas de base continuam valendo; antes, uma linha de base automática guarda as datas de agora;
 * - as dependências deduzidas são refeitas para as datas novas (equipe que segue + sequência no
 *   local, como na importação), e nada se move com elas;
 * - o calendário do Agilean (segunda a sexta menos os dias sem coluna) vai para a obra que ainda não
 *   tem calendário próprio, e as durações batem com os "N d" da planilha;
 * - as cores dos serviços passam a ser as do Agilean.
 * Bloco do Agilean sem par na obra, ou bloco da obra sem par no Agilean, impede a atualização: o
 * relatório mostra quais são. */
import { addDays, isLocalDate, type LocalDate } from './long-term-plan';
import {
  activityFinish,
  cascade,
  LOB_LIMITS,
  LobError,
  normalizeName,
  workdaysBetween,
  type LobActivity,
  type LobBaseline,
  type LobCalendar,
  type LobDependency,
  type LobLocal,
  type LobService,
} from './lob';
import { buildPrevisionImport, localGroup, type PrevisionLocalGroup } from './lob-prevision-import';
import { localKey } from './lob-progress-report-import';
import { cellKey, type XlsxGrid, type XlsxRange } from './xlsx-grid';

const MONTHS = [
  'janeiro',
  'fevereiro',
  'marco',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];
const MONTH_LABEL = /^([a-z]+) de (\d{4})$/;
const BLOCK_LABEL = /^(.+?)\s*-\s*(\d+(?:[.,]\d+)?)\s*d$/;

export interface AgileanBlock {
  /** Rótulo da célula, sem a duração: "Alvenaria", "Med. hid.". */
  label: string;
  /** Cor do serviço no Agilean ("#rrggbb"); vazia se a célula não tiver preenchimento sólido. */
  color: string;
  /** Duração escrita na célula, em dias de trabalho do Agilean (pode ter fração: "2.5 d"). */
  labelDays: number;
  group: string;
  localName: string;
  start: LocalDate;
  finish: LocalDate;
  /** Linha do Excel, para o relatório apontar o bloco. */
  row: number;
}
export interface AgileanLob {
  sheet: string;
  /** Dias com coluna na planilha, em ordem: os dias de trabalho do Agilean. */
  days: LocalDate[];
  calendar: LobCalendar;
  /** Locais na ordem da planilha (de cima para baixo), com o grupo da coluna A. */
  locals: { name: string; group: string }[];
  blocks: AgileanBlock[];
  warnings: string[];
}

const clean = (value: unknown) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
const pad = (n: number) => String(n).padStart(2, '0');
const weekdayOf = (date: LocalDate) => new Date(`${date}T12:00:00Z`).getUTCDay();

/** Lê a exportação do Agilean. Erro (`LobError`) quando a folha não tem o cabeçalho de meses e dias. */
export function readAgileanLob(grid: XlsxGrid): AgileanLob {
  const textAt = (row: number, col: number) => clean(grid.cells.get(cellKey(row, col))?.value);
  const mergeAt = new Map<string, XlsxRange>();
  for (const m of grid.merges) mergeAt.set(cellKey(m.r0, m.c0), m);
  const rangeAt = (row: number, col: number): XlsxRange => mergeAt.get(cellKey(row, col)) ?? { r0: row, c0: col, r1: row, c1: col };

  // Cabeçalho: a primeira linha com nomes de mês; o número do dia fica numa das três linhas seguintes.
  const monthCells: { range: XlsxRange; year: number; month: number }[] = [];
  let monthRow = 0;
  for (const [key, cell] of grid.cells) {
    const m = MONTH_LABEL.exec(normalizeName(clean(cell.value)));
    if (!m || !MONTHS.includes(m[1])) continue;
    const [row, col] = key.split(':').map(Number);
    if (monthRow && row > monthRow) continue;
    if (row < monthRow || !monthRow) monthCells.length = 0;
    monthRow = row;
    monthCells.push({ range: rangeAt(row, col), year: Number(m[2]), month: MONTHS.indexOf(m[1]) + 1 });
  }
  if (!monthRow)
    throw new LobError('A planilha não é a exportação da Linha de Balanço do Agilean: falta a linha dos meses ("setembro de 2024").');
  const monthOf = (col: number) => monthCells.find(m => m.range.c0 <= col && col <= m.range.c1);
  let dayRow = 0;
  let dayCells: XlsxRange[] = [];
  for (let row = monthRow + 1; row <= monthRow + 3; row++) {
    const found = grid.merges
      .filter(m => m.r0 === row && monthOf(m.c0))
      .concat(
        [...grid.cells.keys()]
          .map(key => key.split(':').map(Number))
          .filter(([r, c]) => r === row && !mergeAt.has(cellKey(r, c)) && monthOf(c))
          .map(([r, c]) => ({ r0: r, c0: c, r1: r, c1: c })),
      )
      .filter(m => {
        const v = grid.cells.get(cellKey(m.r0, m.c0))?.value;
        return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 31;
      });
    if (found.length > dayCells.length) {
      dayRow = row;
      dayCells = found;
    }
  }
  if (!dayCells.length) throw new LobError('A planilha do Agilean não tem a linha com o número dos dias abaixo dos meses.');
  dayCells.sort((a, b) => a.c0 - b.c0);
  const dayOfCol = new Map<number, LocalDate>();
  const days: LocalDate[] = [];
  for (const cell of dayCells) {
    const { year, month } = monthOf(cell.c0)!;
    const date = `${year}-${pad(month)}-${pad(Number(grid.cells.get(cellKey(cell.r0, cell.c0))!.value))}`;
    if (!isLocalDate(date)) throw new LobError(`Dia inválido no cabeçalho da planilha: ${date}.`);
    if (days.length && date <= days[days.length - 1]) throw new LobError(`Os dias do cabeçalho não estão em ordem (${date}).`);
    days.push(date);
    for (let col = cell.c0; col <= cell.c1; col++) dayOfCol.set(col, date);
  }
  const firstDayCol = dayCells[0].c0;

  // Calendário: os dias da semana que aparecem; feriado é o dia desses que não tem coluna.
  const weekdays = [...new Set(days.map(weekdayOf))].sort((a, b) => a - b);
  const shown = new Set(days);
  const holidays: LocalDate[] = [];
  for (let d = days[0]; d <= days[days.length - 1]; d = addDays(d, 1))
    if (weekdays.includes(weekdayOf(d)) && !shown.has(d)) holidays.push(d);

  // Locais: a coluna de rótulos antes dos dias com mais textos; o grupo é a primeira coluna, levada
  // para baixo até o próximo grupo.
  const labelCount = new Map<number, number>();
  let lastRow = 0;
  for (const key of grid.cells.keys()) {
    const [row, col] = key.split(':').map(Number);
    lastRow = Math.max(lastRow, row);
    if (row > dayRow && col < firstDayCol && textAt(row, col)) labelCount.set(col, (labelCount.get(col) ?? 0) + 1);
  }
  const localCol = [...labelCount.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0];
  if (!localCol) throw new LobError('A planilha do Agilean não tem a coluna dos locais.');
  const groupCol = Math.min(...labelCount.keys());
  const localRows: { row: number; name: string; group: string }[] = [];
  let group = '';
  for (let row = dayRow + 1; row <= lastRow; row++) {
    if (groupCol !== localCol && textAt(row, groupCol)) group = textAt(row, groupCol);
    const name = textAt(row, localCol);
    if (name) localRows.push({ row, name, group });
  }
  if (!localRows.length) throw new LobError('A planilha do Agilean não tem nenhum local.');
  const localOfRow = (row: number) => [...localRows].reverse().find(l => l.row <= row);

  // Blocos: células (mescladas ou não) com "Serviço - N d" na área dos dias.
  const warnings: string[] = [];
  const blocks: AgileanBlock[] = [];
  for (const [key, cell] of grid.cells) {
    const [row, col] = key.split(':').map(Number);
    if (row <= dayRow || col < firstDayCol || typeof cell.value !== 'string') continue;
    const text = clean(cell.value);
    const m = BLOCK_LABEL.exec(text);
    const local = localOfRow(row);
    const range = rangeAt(row, col);
    const start = dayOfCol.get(range.c0);
    const finish = dayOfCol.get(range.c1);
    if (!m || !local || !start || !finish) {
      warnings.push(
        `Linha ${row}, coluna ${col} ("${text}"): não é um bloco "Serviço - N d" num local e em dias do cabeçalho; ficou de fora.`,
      );
      continue;
    }
    blocks.push({
      label: m[1].trim(),
      color: cell.fill ?? '',
      labelDays: Number(m[2].replace(',', '.')),
      group: local.group,
      localName: local.name,
      start,
      finish,
      row,
    });
  }
  if (!blocks.length) throw new LobError('A planilha do Agilean não tem nenhum bloco "Serviço - N d".');
  blocks.sort((a, b) => a.row - b.row || a.start.localeCompare(b.start));
  const locals = localRows.map(({ name, group: g }) => ({ name, group: g }));
  return { sheet: grid.name, days, calendar: { weekdays, holidays }, locals, blocks, warnings };
}

// ─── Ligação com a Linha de Balanço da obra ─────────────────────────────────────

const words = (text: string) =>
  normalizeName(text)
    .split(/[\s.\-+/()]+/)
    .filter(Boolean);
const baseName = (name: string) => normalizeName(name.replace(/\s*\(\d+\)\s*$/, ''));
/** A sigla do Agilean cabe no nome: cada pedaço é o começo de uma palavra, na ordem, podendo pular
 * palavras ("Esq Alum" → "Esquadrias de alumínio", "Balancins" → "Montagem de balancins"). */
export function abbreviationFits(label: string, name: string): boolean {
  const parts = words(label);
  const target = words(name);
  if (!parts.length) return false;
  let at = 0;
  for (const part of parts) {
    while (at < target.length && !target[at].startsWith(part)) at++;
    if (at === target.length) return false;
    at++;
  }
  return true;
}

export interface AgileanServiceMatch {
  label: string;
  color: string;
  serviceId: string;
  serviceName: string;
  blocks: number;
  /** Como a ligação foi feita: nome igual, sigla compatível ou por eliminação (sobrou só este serviço
   * da obra com blocos em todos os locais dele). */
  how: 'nome' | 'sigla' | 'eliminacao';
  /** Soma das diferenças de início, em dias corridos, entre o Agilean e a obra. */
  distanceDays: number;
}
export interface AgileanUpdateOptions {
  workId: string;
  workName: string;
  actorId: string;
  now: string;
  newId: () => string;
  /** Data (hoje) que vai no nome da linha de base automática. */
  date: LocalDate;
}
export interface AgileanUpdate {
  matches: AgileanServiceMatch[];
  /** Locais da planilha que não existem na obra. */
  missingLocals: string[];
  /** Blocos do Agilean sem par na obra e blocos da obra sem par no Agilean: com qualquer um, não grava. */
  unmatchedBlocks: AgileanBlock[];
  leftoverActivities: LobActivity[];
  /** Todos os blocos da obra com as datas novas (mesmo id). */
  activities: LobActivity[];
  changed: { activity: LobActivity; before: LobActivity }[];
  services: LobService[];
  deleteDependencies: LobDependency[];
  insertDependencies: LobDependency[];
  baseline: LobBaseline;
  /** Calendário a gravar (só quando a obra não tem calendário próprio). */
  newCalendar?: LobCalendar;
  /** Calendário em que as durações foram contadas. */
  calendar: LobCalendar;
  warnings: string[];
}

const dayDiff = (a: LocalDate, b: LocalDate) =>
  Math.abs(Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000));
const formatBr = (date: LocalDate) => `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;

/** Planeja a atualização: não grava nada. `current` é a Linha de Balanço da obra como está. */
export function planAgileanUpdate(
  current: {
    locals: LobLocal[];
    services: LobService[];
    activities: LobActivity[];
    dependencies: LobDependency[];
    calendar?: LobCalendar;
  },
  agilean: AgileanLob,
  options: AgileanUpdateOptions,
): AgileanUpdate {
  const { workId, now, newId } = options;
  const warnings = [...agilean.warnings];
  if (!current.activities.length) throw new LobError(`${options.workName} não tem Linha de Balanço para atualizar: use a importação.`);
  const calendar = current.calendar ?? agilean.calendar;
  const newCalendar = current.calendar ? undefined : agilean.calendar;
  if (current.calendar)
    warnings.push('A obra já tem calendário próprio: ele foi mantido, e as durações são contadas por ele, não pelo do Agilean.');

  // Locais pelo nome, com a mesma chave da importação ("12º pavto." = "12 PAV").
  const localByKey = new Map(current.locals.map(l => [localKey(l.name), l]));
  const localOf = new Map<string, LobLocal>();
  const missingLocals: string[] = [];
  for (const { name } of agilean.locals) {
    const local = localByKey.get(localKey(name));
    if (local) localOf.set(name, local);
    else if (!missingLocals.includes(name)) missingLocals.push(name);
  }

  // Serviços do Agilean (cor + rótulo) e os blocos de cada um.
  const keys = new Map<string, AgileanBlock[]>();
  for (const b of agilean.blocks) {
    const key = `${b.color}|${b.label}`;
    keys.set(key, [...(keys.get(key) ?? []), b]);
  }
  const serviceById = new Map(current.services.map(s => [s.id, s]));
  const free = new Map<string, LobActivity>(); // serviço|local → bloco da obra ainda sem par
  for (const a of current.activities) free.set(`${a.serviceId}|${a.localId}`, a);

  /** Pontuação do par: 3 nome igual, 2 sigla, 1 eliminação; null quando falta bloco do serviço em algum local. */
  const score = (blocks: AgileanBlock[], service: LobService) => {
    let distance = 0;
    for (const b of blocks) {
      const local = localOf.get(b.localName);
      const activity = local && free.get(`${service.id}|${local.id}`);
      if (!activity) return null;
      distance += dayDiff(activity.start, b.start);
    }
    const label = normalizeName(blocks[0].label);
    const rank = baseName(service.name) === label ? 3 : abbreviationFits(blocks[0].label, service.name) ? 2 : 1;
    return { rank, distance };
  };
  const matches: AgileanServiceMatch[] = [];
  const pairs = new Map<LobActivity, AgileanBlock>();
  const pending = new Map(keys);
  // Guloso: a cada rodada, o melhor par (maior pontuação; empate, datas mais próximas) entre todos os
  // serviços do Agilean ainda sem par. Ligado, os blocos da obra dele saem da disputa.
  for (;;) {
    let best: { key: string; service: LobService; rank: number; distance: number } | undefined;
    for (const [key, blocks] of pending)
      for (const service of current.services) {
        const s = score(blocks, service);
        if (!s) continue;
        if (!best || s.rank > best.rank || (s.rank === best.rank && s.distance < best.distance)) best = { key, service, ...s };
      }
    if (!best) break;
    const blocks = pending.get(best.key)!;
    pending.delete(best.key);
    for (const b of blocks) {
      const activity = free.get(`${best.service.id}|${localOf.get(b.localName)!.id}`)!;
      free.delete(`${activity.serviceId}|${activity.localId}`);
      pairs.set(activity, b);
    }
    matches.push({
      label: blocks[0].label,
      color: blocks[0].color,
      serviceId: best.service.id,
      serviceName: best.service.name,
      blocks: blocks.length,
      how: best.rank === 3 ? 'nome' : best.rank === 2 ? 'sigla' : 'eliminacao',
      distanceDays: best.distance,
    });
  }
  const unmatchedBlocks = [...pending.values()].flat();
  const leftoverActivities = [...free.values()];

  // Datas novas, no mesmo bloco.
  const activities = current.activities.map(a => {
    const b = pairs.get(a);
    if (!b) return a;
    const durationDays = Math.min(LOB_LIMITS.durationDays, Math.max(1, workdaysBetween(b.start, addDays(b.finish, 1), calendar)));
    return a.start === b.start && a.durationDays === durationDays ? a : { ...a, start: b.start, durationDays, updatedAt: now };
  });
  const changed = activities.flatMap((activity, index) => {
    const before = current.activities[index];
    return activity !== before &&
      (activity.start !== before.start || activityFinish(activity, calendar) !== activityFinish(before, current.calendar))
      ? [{ activity, before }]
      : [];
  });

  // Cores do Agilean: a do serviço do Agilean com mais blocos ligados ao serviço da obra.
  const colorFor = new Map<string, { color: string; blocks: number }>();
  for (const m of matches) {
    const known = colorFor.get(m.serviceId);
    if (/^#[0-9a-f]{6}$/.test(m.color) && (!known || m.blocks > known.blocks))
      colorFor.set(m.serviceId, { color: m.color, blocks: m.blocks });
  }
  const services = current.services.flatMap(s => {
    const color = colorFor.get(s.id)?.color;
    return color && color !== s.color.toLowerCase() ? [{ ...s, color, updatedAt: now }] : [];
  });

  // Dependências deduzidas para as datas novas, pela mesma regra da importação: monta-se a importação
  // com os nomes da obra e os ids dos blocos dela são trocados pelos dos blocos existentes.
  let insertDependencies: LobDependency[] = [];
  if (!unmatchedBlocks.length && !leftoverActivities.length && !missingLocals.length) {
    const groupOf = (name: string, agileanGroup: string): PrevisionLocalGroup => {
      const g = normalizeName(agileanGroup);
      return g.startsWith('fachada') ? 'fachada' : g.startsWith('equipamento') ? 'equipamentos' : localGroup(name);
    };
    const localGroups = new Map<string, PrevisionLocalGroup>();
    for (const [activity, b] of pairs) {
      const local = current.locals.find(l => l.id === activity.localId)!;
      if (!localGroups.has(local.name)) localGroups.set(local.name, groupOf(local.name, b.group));
    }
    const ordered = [...pairs.keys()];
    const updated = new Map(activities.map(a => [a.id, a]));
    const schedule = {
      services: [...new Set(ordered.map(a => serviceById.get(a.serviceId)!.name))],
      locals: [...current.locals]
        .sort((a, b) => a.orderIndex - b.orderIndex)
        .filter(l => localGroups.has(l.name))
        .map(l => ({ name: l.name, group: localGroups.get(l.name)! })),
      blocks: ordered.map(a => {
        const next = updated.get(a.id)!;
        return {
          serviceName: serviceById.get(a.serviceId)!.name,
          localName: current.locals.find(l => l.id === a.localId)!.name,
          start: next.start,
          finish: activityFinish(next, calendar),
          workDays: next.durationDays,
          percent: 0,
        };
      }),
      warnings: [],
    };
    const built = buildPrevisionImport(schedule, {
      workId,
      workName: options.workName,
      actorId: options.actorId,
      now,
      newId,
      measurementDate: options.date,
      sourceName: 'Agilean',
      existingLocals: current.locals,
      calendar,
    });
    const realId = new Map(built.activities.map((a, index) => [a.id, ordered[index].id]));
    insertDependencies = built.dependencies.map(d => ({
      ...d,
      predecessorId: realId.get(d.predecessorId)!,
      successorId: realId.get(d.successorId)!,
    }));
    const moved = cascade(activities, insertDependencies, calendar);
    if (moved.length) throw new LobError(`As dependências refeitas moveriam ${moved.length} blocos. Nada foi gravado.`);
  }

  const baseline: LobBaseline = {
    id: newId(),
    workId,
    name: `Antes da atualização pelo Agilean (${formatBr(options.date)})`.slice(0, LOB_LIMITS.name),
    automatic: true,
    createdBy: options.actorId,
    createdAt: now,
    snapshot: current.activities.map(a => ({
      activityId: a.id,
      serviceId: a.serviceId,
      localId: a.localId,
      start: a.start,
      durationDays: a.durationDays,
      finish: activityFinish(a, current.calendar),
    })),
  };

  return {
    matches,
    missingLocals,
    unmatchedBlocks,
    leftoverActivities,
    activities,
    changed,
    services,
    deleteDependencies: current.dependencies,
    insertDependencies,
    baseline,
    newCalendar,
    calendar,
    warnings,
  };
}

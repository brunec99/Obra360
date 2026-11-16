import { filteredUsage, workLabeler, type AccessFilters } from '@/domain/access-report';
import {
  ACCESS_ROLE_LABEL,
  DEVICE_LABEL,
  roleKeyOf,
  screenLabel,
  screenOrder,
  type AccessDevice,
  type AccessPayload,
} from '@/domain/access-usage';
import type { LocalDate } from '@/domain/entities';
import { formatDate } from '@/shared/format';

/** Planilha da aba "Acessos" (15/11/2026, modelo aprovado "Aba Acessos no Dashboard geral", regra 13: planilha em
 * vez de PDF). Uma linha por pessoa × dia × obra × módulo, com o mesmo recorte da tela (`filteredUsage`): as linhas
 * de uso de sessões diferentes com a mesma pessoa, dia, obra, tela, campo e aparelho somam numa só. O destino é o
 * Excel em pt-BR, como nas outras planilhas do sistema (Linha de Balanço, quantitativos do IFC): `;` separa as
 * colunas, vírgula é o decimal e o BOM no início evita os acentos quebrados. Função pura: a tela só baixa o texto. */

export const ACCESS_CSV_HEADER = ['Pessoa', 'E-mail', 'Papel', 'Dia', 'Obra', 'Módulo', 'Campo', 'Aparelho', 'Minutos ativos'] as const;

const BOM = '﻿';
const DEVICE_ORDER: Record<AccessDevice, number> = { desktop: 0, mobile: 1 };

/** Aspas só quando o campo traz `;`, aspas ou quebra de linha; as aspas de dentro dobram. */
export const csvCell = (value: string): string => (/[;"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
/** "46,0": minutos com uma casa e vírgula. */
const minutesText = (seconds: number) => (seconds / 60).toFixed(1).replace('.', ',');

/** `acessos-obra360-2026-11-09-a-2026-11-15.csv`. */
export const accessCsvFileName = (payload: Pick<AccessPayload, 'from' | 'to'>) => `acessos-obra360-${payload.from}-a-${payload.to}.csv`;

interface CsvEntry {
  profileId: string;
  day: LocalDate;
  workId: string | null;
  screen: string;
  field: boolean;
  device: AccessDevice;
  seconds: number;
}

export function accessCsv(payload: AccessPayload, filters: AccessFilters): string {
  const { people, current } = filteredUsage(payload, filters);
  const personOf = new Map(people.map(person => [person.id, person]));
  const workLabel = workLabeler(payload);

  const grouped = new Map<string, CsvEntry>();
  for (const row of current) {
    const key = [row.profileId, row.day, row.workId ?? '', row.screen, row.field ? 1 : 0, row.device].join('\u0000');
    const entry = grouped.get(key);
    if (entry) entry.seconds += row.seconds;
    else
      grouped.set(key, {
        profileId: row.profileId,
        day: row.day,
        workId: row.workId,
        screen: row.screen,
        field: row.field,
        device: row.device,
        seconds: row.seconds,
      });
  }

  const lines = [...grouped.values()].flatMap(entry => {
    const person = personOf.get(entry.profileId);
    return person ? [{ ...entry, person, work: workLabel(entry.workId) }] : [];
  });
  // Pessoa, dia, obra e módulo. Obra pelo nome, com "Fora das obras" no fim do dia; módulo na ordem do menu; o
  // campo e o aparelho só desempatam.
  lines.sort(
    (a, b) =>
      a.person.name.localeCompare(b.person.name, 'pt-BR') ||
      (a.person.email ?? '').localeCompare(b.person.email ?? '') ||
      a.profileId.localeCompare(b.profileId) ||
      a.day.localeCompare(b.day) ||
      Number(a.workId === null) - Number(b.workId === null) ||
      a.work.localeCompare(b.work, 'pt-BR') ||
      screenOrder(a.screen) - screenOrder(b.screen) ||
      screenLabel(a.screen).localeCompare(screenLabel(b.screen), 'pt-BR') ||
      Number(a.field) - Number(b.field) ||
      DEVICE_ORDER[a.device] - DEVICE_ORDER[b.device],
  );

  const rows = lines.map(line =>
    [
      line.person.name,
      line.person.email ?? '',
      ACCESS_ROLE_LABEL[roleKeyOf(line.person)],
      formatDate(line.day),
      line.work,
      screenLabel(line.screen),
      line.field ? 'Sim' : 'Não',
      DEVICE_LABEL[line.device],
      minutesText(line.seconds),
    ]
      .map(csvCell)
      .join(';'),
  );
  return BOM + [ACCESS_CSV_HEADER.join(';'), ...rows].join('\r\n');
}

import type { AccessFilters } from '@/domain/access-report';
import {
  ACCESS_ROLE_ORDER,
  DEFAULT_ACCESS_PERIOD,
  isAccessPeriodKind,
  isLocalDate,
  type AccessDevice,
  type AccessPeriodChoice,
  type AccessRoleKey,
} from '@/domain/access-usage';

/** O endereço da aba "Acessos" (15/11/2026): período e filtros vão para a URL, como na aba Obras, para o link copiado
 * reproduzir a mesma visão. `periodo` = hoje | 7d | 30d | mes | mes-anterior | intervalo (com `de` e `ate`); os
 * filtros se repetem (`pessoa`, `papel`, `obra`, `modulo`, `aparelho`). Sem nada, abre nos 7 dias e sem filtro. */
export interface AccessParams {
  period: AccessPeriodChoice;
  filters: AccessFilters;
}

export const ACCESS_PATH = '/dashboard/acessos';
const DEVICE_PARAM: Record<AccessDevice, string> = { desktop: 'computador', mobile: 'celular' };
const DEVICE_OF: Record<string, AccessDevice> = { computador: 'desktop', celular: 'mobile' };

const list = (value: string | string[] | undefined): string[] =>
  (Array.isArray(value) ? value : value === undefined ? [] : [value])
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, 200);
const setOf = <T extends string>(values: T[]): Set<T> | undefined => (values.length ? new Set(values) : undefined);
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export function parseAccessParams(raw: Record<string, string | string[] | undefined>): AccessParams {
  const kind = first(raw.periodo);
  const from = first(raw.de);
  const to = first(raw.ate);
  const period: AccessPeriodChoice =
    kind === 'intervalo' && isLocalDate(from) && isLocalDate(to)
      ? { kind, from, to }
      : { kind: isAccessPeriodKind(kind) && kind !== 'intervalo' ? kind : DEFAULT_ACCESS_PERIOD };
  return {
    period,
    filters: {
      people: setOf(list(raw.pessoa)),
      roles: setOf(list(raw.papel).filter((role): role is AccessRoleKey => (ACCESS_ROLE_ORDER as readonly string[]).includes(role))),
      works: setOf(list(raw.obra)),
      screens: setOf(list(raw.modulo)),
      devices: setOf(list(raw.aparelho).flatMap(device => (DEVICE_OF[device] ? [DEVICE_OF[device]] : []))),
    },
  };
}

export function accessSearch(params: AccessParams): string {
  const query = new URLSearchParams();
  if (params.period.kind !== DEFAULT_ACCESS_PERIOD) query.set('periodo', params.period.kind);
  if (params.period.kind === 'intervalo' && params.period.from && params.period.to) {
    query.set('de', params.period.from);
    query.set('ate', params.period.to);
  }
  const { people, roles, works, screens, devices } = params.filters;
  for (const id of people ?? []) query.append('pessoa', id);
  for (const role of roles ?? []) query.append('papel', role);
  for (const id of works ?? []) query.append('obra', id);
  for (const screen of screens ?? []) query.append('modulo', screen);
  for (const device of devices ?? []) query.append('aparelho', DEVICE_PARAM[device]);
  return query.toString();
}

export const accessPath = (params: AccessParams) => {
  const search = accessSearch(params);
  return search ? `${ACCESS_PATH}?${search}` : ACCESS_PATH;
};

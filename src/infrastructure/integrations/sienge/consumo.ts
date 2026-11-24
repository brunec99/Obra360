/** Contagem das chamadas ao Sienge para o painel de consumo do Portal Inteligência (contrato
 * `consumo/1`, canal push, receptor `api-consumo-receber`).
 *
 * Regras do contrato:
 * - conta TENTATIVA HTTP: incrementa antes do `fetch`, então nova tentativa também conta;
 * - só agregados (sistema × api × origem × janela), nenhum dado da obra;
 * - contar nunca derruba quem conta: sem configuração, rede fora ou recusa, a leitura do Sienge
 *   segue e o número se perde, com um aviso no log.
 *
 * Cada leitura (um "Buscar do Sienge", uma lista de empreendimentos) vira um item com chave própria
 * (`obra360:sienge:<origem>:<hora>.<id>`): o receptor substitui por chave e o Portal soma por dia. */

// shortcut: sinal de vida só vai junto com uma leitura, então dia sem "Buscar do Sienge" fica "não medido"
// no painel (não zero); evoluir para um sinal diário se o Obra 360 ganhar rotina agendada no servidor.
const SISTEMA = 'obra360';
const RECEPTOR_PADRAO = 'https://srkbewdqjdpndhqnpspm.supabase.co/functions/v1/api-consumo-receber';
const TIMEOUT_MS = 10_000;

/** `diario` (24/11/2026): as chamadas do Diário de Obra, leituras de apoio e gravações. */
export type OrigemSienge = 'orcamento' | 'empreendimentos' | 'diario';

export interface ContadorSienge {
  readonly origem: OrigemSienge;
  /** Chamado imediatamente antes de cada tentativa HTTP ao Sienge. */
  conta(): void;
  readonly total: number;
}

export function novoContador(origem: OrigemSienge): ContadorSienge {
  let total = 0;
  return {
    origem,
    conta() {
      total += 1;
    },
    get total() {
      return total;
    },
  };
}

/** Hora cheia em Brasília no formato do sufixo da chave (`2026-11-24T09`). */
function horaBrasilia(d: Date): string {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const v = (t: string) => partes.find(p => p.type === t)?.value ?? '00';
  return `${v('year')}-${v('month')}-${v('day')}T${v('hour')}`;
}

export function itemDeConsumo(contador: ContadorSienge, agora: Date, id: string) {
  return {
    sistema: SISTEMA,
    api: 'sienge',
    origem: contador.origem,
    requisicoes: contador.total,
    ocorrido_em: agora.toISOString(),
    chave: `${SISTEMA}:sienge:${contador.origem}:${horaBrasilia(agora)}.${id}`,
  };
}

/** Envia a contagem de uma leitura. Nunca lança; sem chamada a contar, não envia nada. */
export async function enviarConsumo(
  contador: ContadorSienge,
  env: Record<string, string | undefined> = process.env,
  enviar: typeof fetch = fetch,
): Promise<void> {
  if (contador.total < 1) return;
  const token = (env.CONSUMO_RECEBER_TOKEN ?? '').trim();
  if (!token) {
    console.warn('[consumo-sienge] CONSUMO_RECEBER_TOKEN ausente: contagem não enviada', {
      origem: contador.origem,
      requisicoes: contador.total,
    });
    return;
  }
  const url = (env.CONSUMO_RECEBER_URL ?? '').trim() || RECEPTOR_PADRAO;
  const item = itemDeConsumo(contador, new Date(), crypto.randomUUID().slice(0, 8));
  try {
    const res = await enviar(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ itens: [item] }),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const corpo = (await res.json().catch(() => ({}))) as { code?: unknown };
      console.warn('[consumo-sienge] receptor recusou a contagem', { status: res.status, code: corpo.code, origem: contador.origem });
    }
  } catch (e) {
    console.warn('[consumo-sienge] falha ao enviar a contagem', { tipo: e instanceof Error ? e.name : typeof e, origem: contador.origem });
  }
}

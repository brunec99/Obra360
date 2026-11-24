import type { SiengeBudget } from '@/domain/sienge-budget';

/** Intervalo mínimo entre duas leituras do orçamento de um mesmo empreendimento no Sienge (24/11/2026).
 * Um orçamento grande são dezenas de chamadas pagas e a cota diária da ATR já passa do contratado:
 * dentro da janela, qualquer pedido (inclusive "Ler de novo") recebe a última leitura. */
export const BUDGET_MIN_INTERVAL_MS = 15 * 60 * 1000;

export type BudgetWithNext = SiengeBudget & { nextReadAt: string };

/** Guarda a última leitura de cada empreendimento e junta pedidos simultâneos numa leitura só. */
// shortcut: janela na memória de um processo (o container de produção é um só); evoluir para Redis ou
// banco se o Obra 360 passar a rodar com mais de uma réplica, senão cada uma lê o Sienge por conta própria.
export class BudgetCache {
  private readonly last = new Map<number, { at: number; budget: SiengeBudget }>();
  private readonly pending = new Map<number, Promise<SiengeBudget>>();

  constructor(
    private readonly read: (buildingId: number) => Promise<SiengeBudget>,
    private readonly now: () => number = Date.now,
    private readonly minIntervalMs = BUDGET_MIN_INTERVAL_MS,
  ) {}

  private withNext(at: number, budget: SiengeBudget): BudgetWithNext {
    return { ...budget, nextReadAt: new Date(at + this.minIntervalMs).toISOString() };
  }

  /** Última leitura se ainda está na janela; senão lê de novo. Erro não fica guardado. */
  async get(buildingId: number): Promise<BudgetWithNext> {
    const cached = this.last.get(buildingId);
    if (cached && this.now() - cached.at < this.minIntervalMs) return this.withNext(cached.at, cached.budget);

    let reading = this.pending.get(buildingId);
    if (!reading) {
      reading = this.read(buildingId).then(
        budget => {
          this.last.set(buildingId, { at: this.now(), budget });
          this.pending.delete(buildingId);
          return budget;
        },
        cause => {
          this.pending.delete(buildingId);
          throw cause;
        },
      );
      this.pending.set(buildingId, reading);
    }
    const budget = await reading;
    const at = this.last.get(buildingId)?.at ?? this.now();
    return this.withNext(at, budget);
  }
}

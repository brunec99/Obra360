/** As 42 datas (seis semanas, de domingo a sábado) que o calendário mostra para o mês `AAAA-MM`:
 * começa no domingo da semana do dia 1 e completa com os dias dos meses vizinhos, para a altura do
 * calendário não mudar de um mês para outro. */
export function monthGrid(month: string): string[] {
  const [y, m] = month.split('-').map(Number);
  const start = Date.UTC(y, m - 1, 1 - new Date(Date.UTC(y, m - 1, 1)).getUTCDay());
  return Array.from({ length: 42 }, (_, i) => new Date(start + i * 86_400_000).toISOString().slice(0, 10));
}

/** O mês `AAAA-MM` deslocado `delta` meses (negativo volta), atravessando a virada do ano. */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

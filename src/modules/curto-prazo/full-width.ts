/** Telas que ocupam a largura inteira da janela, sem o teto de 1600 px do restante do sistema (23/11/2026).
 * O curto prazo é uma planilha larga, aberta na TV da sala de reunião e no monitor da obra: com o teto, a
 * tela maior só ganhava margem. Vale para a aba toda (planilha e fechamento), para o cabeçalho não mudar
 * de lugar na troca entre as duas. Quem decide é o endereço, lido pelo quadro da página e pela barra de cima. */
export function isFullWidthPath(pathname: string | null | undefined): boolean {
  return /^\/obras\/[^/]+\/curto-prazo(?:\/|$)/.test(pathname ?? '');
}

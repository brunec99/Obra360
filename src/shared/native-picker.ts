import type { SyntheticEvent } from 'react';

/** Clique em qualquer ponto de um campo nativo de data (ou de mês) abre o calendário do navegador,
 * não só o ícone no canto (16/11/2026, médio prazo). Navegador sem `showPicker`, ou que recusa a
 * chamada, mantém o campo como era: digitável e com o ícone. */
export function openNativePicker(event: SyntheticEvent<HTMLInputElement>) {
  const input = event.currentTarget;
  if (input.disabled || input.readOnly) return;
  try {
    input.showPicker();
  } catch {
    // Sem suporte ou sem gesto do usuário: nada a fazer, o campo continua funcionando.
  }
}

import type { TourStep } from '../tours';

/** Tour da aba 9, Checklist de equipamentos (11/11/2026; QR do operador, assinatura e fotos em 12/11/2026). Os alvos ficam em
 * `checklist/checklist-overview.tsx`; o formulário de inspeção só existe depois de clicar num checklist do
 * quadro, e o passo dele é pulado quando o alvo não está na tela. */
export const steps: TourStep[] = [
  {
    title: 'Aba 3.2 · Checklist de equipamentos',
    body: 'A inspeção diária, semanal e mensal dos equipamentos da obra. O operador preenche pelo QR colado na máquina, sem login. Técnicos de segurança (TST) e administradores registram e corrigem inspeções; o cadastro de modelos e equipamentos é dos administradores. Os demais consultam.',
  },
  {
    target: 'checklist-cards',
    title: 'Indicadores',
    body: 'Quantos checklists faltam hoje, nesta semana (segunda a domingo) e neste mês, e quantos do período corrente têm não conformidade ainda sem a tratativa do TST. O checklist marcado como "não se aplica" fica fora da conta.',
  },
  {
    target: 'checklist-board',
    title: 'Equipamentos da obra',
    body: 'Cada equipamento com os checklists ligados ao QR dele (os do tipo, mais o que o administrador incluiu em "Checklists do QR"). Âmbar é pendente no período, verde é feito, vermelho é feito com não conformidade sem tratativa, azul é não conformidade já tratada pelo TST e cinza é "não se aplica". Clique num checklist para preencher ou abrir a inspeção. Em dia sem uso do equipamento, "Não se aplica hoje" tira o checklist dos pendentes (e "Desfazer" devolve). "QR do operador" mostra o link do equipamento, e "Imprimir etiquetas com QR" gera a folha para colar nas máquinas. Abaixo, o administrador cadastra os equipamentos da obra.',
  },
  {
    target: 'checklist-form',
    title: 'Inspeção',
    body: 'Cada item recebe C (conforme), NC (não conforme) ou N/A (não se aplica). A não conformidade exige a descrição. "Marcar os demais como conforme" preenche o que ficou em branco. Dá para anexar até 4 fotos (no celular, "Câmera" tira a foto na hora e "Galeria" escolhe uma pronta), escrever o nome e a empresa do operador e colher a assinatura dele no quadro. Num checklist já feito, "Registrar outra inspeção" lança mais uma (o equipamento usado por outra pessoa no dia). Numa inspeção com não conformidade, o quadro "Tratativa do TST" fica acima do formulário.',
  },
  {
    target: 'checklist-history',
    title: 'Últimas inspeções',
    body: 'A seção abre recolhida: clique no título para ver. As 30 inspeções mais recentes, com o operador (e a empresa dele) ou quem registrou; as que vieram do QR trazem a marca "pelo QR". "Ver respostas" abre os itens, a assinatura e as fotos; nas que têm não conformidade, o TST escreve ali a tratativa de cada item (o que foi feito ou combinado). O TST edita ou exclui uma inspeção lançada errada.',
  },
  {
    target: 'checklist-models',
    title: 'Modelos de checklist',
    body: 'A seção abre recolhida: clique no título para ver. A ficha de cada tipo de equipamento e periodicidade (diário, semanal, mensal ou liberação, feita uma única vez), com os itens a conferir. O modelo pode pedir o nº do equipamento ou o pavimento a quem preenche. A lista é a mesma para todas as obras, e só administradores criam e editam. Editar um modelo vale daqui em diante: as inspeções já feitas guardam os itens como estavam.',
  },
];

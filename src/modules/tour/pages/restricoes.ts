import type { TourStep } from '../tours';

/** Tour da aba 1.4, Quadro de Restrições (12/11/2026). Até então os passos do quadro fechavam o tour da
 * antiga aba 2 (`vagoes.ts`), de que o Kanban era a segunda visão. */
export const steps: TourStep[] = [
  {
    title: 'Aba 1.4 · Quadro de Restrições',
    body: 'O quadro de cards do que precisa ser resolvido na obra antes de cada frente começar: prazo em dias úteis, responsável, conversa com @ e checklists. O card não trava vagão; o que bloqueia um vagão continua sendo a restrição registrada no detalhe dele, no Planejamento de vagão.',
  },
  {
    target: 'pendencias-nova',
    title: 'Nova pendência',
    body: 'Cria um card. "Ligar a" já abre em "Tarefa do médio prazo": escolha a tarefa (ou um serviço do longo prazo) numa lista e informe o título, o tempo de execução em dias úteis e o responsável. A entrega é o dia útil anterior ao início da tarefa ou do serviço e acompanha a reprogramação. Sem descrição, o card da tarefa do médio prazo recebe as anotações dela. "Sem ligação" cria um card avulso, com a data de término digitada. Os cards também nascem direto de uma tarefa do médio prazo ("Criar pendência" no cronograma) e de um serviço da Linha de Balanço.',
  },
  {
    target: 'pendencias-filtros',
    title: 'Filtros do quadro',
    body: 'Mostra só os cards de um responsável ou de uma origem: Médio prazo, Longo prazo ou Avulsa (sem ligação). "Restrição de vagão (antiga)" só aparece quando a obra tem cards copiados do antigo quadro de restrições do longo prazo. "Limpar filtros" volta a mostrar tudo.',
  },
  {
    target: 'pendencias-quadro',
    title: 'O quadro',
    body: 'Cinco colunas: A fazer, Fazendo, Pausado, Concluído e Cancelado. Pausar e cancelar pedem o motivo. Cada coluna rola os próprios cards; o cabeçalho e os filtros ficam parados. O sinal do card é vermelho quando a entrega passou ou quando o "começar até" (a entrega menos o tempo de execução, em dias úteis) passou com o card ainda em A fazer; amarelo quando precisa começar nos próximos 5 dias úteis; verde dentro do prazo. Abra um card para a conversa (marque alguém com @: a pessoa recebe e-mail), as checklists e o histórico de mudanças. Trocar o responsável pede confirmação antes de gravar.',
  },
];

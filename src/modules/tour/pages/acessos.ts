import type { TourStep } from '../tours';

/** Tour da aba "Acessos" do Dashboard geral (15/11/2026, modelo aprovado "Acessos"), em /dashboard/acessos: quem
 * entrou no Obra 360, em quais módulos e por quanto tempo. Só o admin abre a aba; para os demais o endereço volta
 * para /dashboard, então este tour só roda para admin. O alvo `acessos-abas` é o mesmo do tour da aba Obras.
 * A aba só lê: nenhum passo descreve edição. Passo cujo alvo não está na tela (celular, aviso de migração
 * faltando no lugar dos quadros) é pulado sozinho. */
export const steps: TourStep[] = [
  {
    title: 'Acessos',
    body: 'Quem entrou no Obra 360, em quais módulos e por quanto tempo, no período escolhido. Só administradores veem esta aba. Aqui nada se edita. A contagem começou no dia da publicação da aba: o uso de antes não foi medido.',
  },
  {
    target: 'acessos-cabecalho',
    title: 'Cabeçalho',
    body: 'O título e uma linha do que a aba responde. Ela fica no Dashboard geral, no menu em Empreendimentos, ao lado da aba Obras.',
  },
  {
    target: 'acessos-ajuda',
    title: 'Como funciona',
    body: 'Abre a explicação da aba: o que é tempo ativo, quando uma sessão começa e termina, como a tela vira módulo, como o aparelho é reconhecido, o que não é gravado e desde quando há dados.',
  },
  {
    target: 'acessos-abas',
    title: 'Obras e Acessos',
    body: '“Obras” volta para a comparação das obras, sem mudança. “Acessos”, com o selo “admin”, é esta aba. As duas abas só aparecem para administradores.',
  },
  {
    target: 'acessos-filtros',
    title: 'Filtros',
    body: '“Pessoas”, “Papel”, “Obras”, “Módulos” e “Aparelho”. Eles recortam tudo: a frase, os cartões, as tabelas e a planilha. Todas as pessoas cadastradas entram, inclusive os admins; use “Papel” para tirá-los da conta.',
  },
  {
    target: 'acessos-periodo',
    title: 'Período',
    body: '“Hoje”, “7 dias” (a aba abre aqui), “30 dias”, “Este mês”, “Mês anterior” e “Intervalo”. São dias corridos, no horário de Brasília, contando sábado e domingo. Não usa as semanas inteiras da aba Obras.',
  },
  {
    target: 'acessos-escopo',
    title: 'O que entra na conta',
    body: 'Os dias que o período cobre e o recorte dos filtros. O tempo é sempre tempo ativo: a aba do Obra 360 na frente e algum clique, tecla, rolagem ou toque nos últimos 5 minutos. Aba escondida, computador parado ou tela bloqueada não contam.',
  },
  {
    target: 'acessos-resumo',
    title: 'Resumo em uma frase',
    body: 'O essencial do período numa frase, escrita com os mesmos números dos cartões.',
  },
  {
    target: 'acessos-cartoes',
    title: 'Cartões',
    body: 'Seis números: pessoas que entraram (de quantas cadastradas), tempo ativo, média por pessoa (só de quem entrou), sessões (com a duração média), no sistema agora (uso ativo nos últimos 5 minutos; atualiza sozinho a cada minuto) e sem acesso no período (com quantas nunca entraram). As setas comparam com o período anterior do mesmo tamanho.',
  },
  {
    target: 'acessos-pessoas',
    title: 'Por pessoa',
    body: 'Uma linha por pessoa, maior tempo ativo primeiro; clique no título de uma coluna para ordenar. “Onde passa o tempo” mostra uma barra por grupo do menu e os 3 módulos com mais tempo. Quem não entrou no período fica no fim, apagado, com o último acesso ou “Nunca entrou”. Clique na linha para ver as sessões, o tempo por módulo e o tempo por obra da pessoa.',
  },
  {
    target: 'acessos-modulos',
    title: 'Tempo por módulo',
    body: 'Os módulos com o número do menu (0 a 3.2, Apoio e as telas fora das obras), maior tempo primeiro, com quantas pessoas usaram cada um. O modo de campo conta no módulo, marcado “campo”, e a janela da Claudia conta para a tela de baixo. Módulo sem uso no período é citado embaixo.',
  },
  {
    target: 'acessos-obras',
    title: 'Tempo por obra',
    body: 'O tempo nas telas de cada obra, maior primeiro, com quantas pessoas entraram nela. As telas fora das obras (lista de obras, Dashboard geral, Configurações, Agente de IA) somam em “Fora das obras”.',
  },
  {
    target: 'acessos-dias',
    title: 'Uso por dia',
    body: 'Uma linha por pessoa, com os minutos ativos de cada dia. Até 31 dias, uma coluna por dia; período maior, uma coluna por semana. A última linha diz quantas pessoas entraram em cada dia.',
  },
  {
    target: 'acessos-planilha',
    title: 'Baixar planilha (.csv)',
    body: 'Baixa uma linha por pessoa, dia, obra e módulo, com o período e os filtros de agora. Esta aba não tem PDF.',
  },
];

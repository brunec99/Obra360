import type { ManualSection } from './types';

/** Manual da aba "Acessos" do Dashboard geral (15/11/2026, modelo aprovado "Acessos"): quem entrou no Obra 360, em
 * quais módulos e por quanto tempo. Só o admin vê a aba, então estas seções respondem sobretudo à Claudia geral; a
 * quem não é admin, explicam que a aba existe e por que ela não aparece. A aba fica no Dashboard geral, por isso
 * usa a tela "dashboard-geral". Os resumos são curtos de propósito: o índice do manual vai em todo prompt e tem teto. */
export const sections: ManualSection[] = [
  {
    id: 'dashboard-geral-acessos-aba',
    title: 'Aba Acessos do Dashboard geral: o que é, onde fica e quem vê',
    summary: 'Quem entrou e quanto tempo; só admin.',
    keywords: [
      'aba acessos',
      'quem acessou',
      'quem entrou no sistema',
      'uso do sistema',
      'quem usa o sistema',
      'relatório de acessos',
      'acessos dos usuários',
      'último login',
      'antes da medição',
      'desde quando conta o uso',
      'guardado por 13 meses',
    ],
    screen: 'dashboard-geral',
    body: `## O que é a aba Acessos

É a segunda aba do **Dashboard geral**, só para administradores. Mostra **quem entrou no Obra 360, em quais módulos e por quanto tempo**, no período escolhido. Responde a perguntas como "quem não entrou nesta semana?", "quanto tempo a equipe passa no curto prazo?" e "que módulo ninguém usou no mês?". Nada aqui se edita.

## Onde fica

- No menu lateral, em **Empreendimentos**, item **Dashboard geral**. Para administradores, a página tem duas abas no topo: **"Obras"**, a comparação das obras de sempre (sem mudança), e **"Acessos"**, com o selo "admin".
- O endereço da aba é /dashboard/acessos.

## Quem vê

- Só **administradores** veem as abas e os números.
- Para os demais, o Dashboard geral continua sem abas, só com a comparação das obras, e o endereço /dashboard/acessos volta para o Dashboard geral. Quem não é admin não vê o próprio uso nem o dos outros.
- Na tabela aparecem **todas as pessoas cadastradas**, inclusive os admins. Para tirar os admins da conta, use o filtro **"Papel"**.

## Desde quando há dados

- A contagem começou no **dia da publicação** da aba. O uso de antes não foi medido e não há como recuperar.
- Para quem ainda não tem uso medido, a tabela mostra a data do último login, por exemplo "último login 28/10, antes da medição". O login é o mesmo do Takt Hub, então essa data pode ser de uma entrada no Takt Hub, e não no Obra 360. Quem nunca entrou aparece como **"Nunca entrou"**.
- O uso fica guardado por **13 meses**; o mais antigo é apagado sozinho.
- Enquanto a migração 0051 não estiver aplicada, o resto do sistema segue normal e a aba avisa que falta a migração.

## Privacidade

O sistema grava só quem usou, o dia, a obra, a tela, os segundos de uso ativo, o início e o fim de cada sessão e se foi computador ou celular. **Não grava** IP, localização, nem o que foi digitado ou visto na tela. A página de política de privacidade (/privacidade) diz o mesmo.

## A assistente nesta aba

A Claudia geral abre também aqui e explica as regras da aba pelo manual. Ela **não lê** os números de uso: para saber quem entrou e por quanto tempo, consulte a própria aba. Como contar o tempo e como ler a tela estão nas seções "Como o uso é contado" e "Como ler a aba Acessos".`,
  },
  {
    id: 'dashboard-geral-acessos-regras',
    title: 'Como o uso é contado: tempo ativo, sessão, módulo e aparelho',
    summary: 'Tempo ativo, sessão, módulo e aparelho.',
    keywords: [
      'tempo ativo',
      'tempo de uso',
      'como o tempo é contado',
      'sessão',
      'sessões',
      'aba escondida',
      'tela bloqueada',
      'computador parado',
      'duas abas abertas',
      'celular ou computador',
      'aparelho',
      'o que é gravado',
      'endereço ip',
      'localização',
      'o que não é gravado',
      'privacidade',
      'fora das obras',
    ],
    screen: 'dashboard-geral',
    body: `## Tempo ativo

O tempo da aba Acessos é o **tempo ativo**: a aba do Obra 360 está na frente e houve clique, tecla, rolagem ou toque nos últimos **5 minutos**.

- Cada toque mantém o relógio andando por até 5 minutos. Sem toque novo, ele para.
- **Não contam**: aba escondida atrás de outra, janela minimizada, computador parado e tela bloqueada.
- Deixar o sistema aberto o dia inteiro não soma o dia inteiro: soma só os trechos com uso.
- No modo de campo (celular), o minuto sem sinal de internet não conta.

## Sessão

- Uma **sessão** é uma entrada no sistema. Voltar depois de **30 minutos sem uso** abre uma sessão nova.
- Duas abas abertas ao mesmo tempo nunca somam mais que o relógio: meia hora com duas abas conta meia hora.
- Cada sessão guarda o início, o fim, o tempo ativo, o aparelho e as obras e os módulos por onde passou.

## Módulo

O módulo vem da tela aberta, com o número do menu:

- **0** Dashboard da obra.
- **1.1** Longo prazo e **1.1** Vagões; **1.2** Médio prazo; **1.3** Curto prazo; **1.4** Quadro de Restrições.
- **2.1** Terminalidade; **2.2** Histograma; **2.3** Produtividade.
- **3.1** Vistoria de segurança; **3.2** Checklist de equipamentos.
- **Apoio**: Modelo federado, Arquivos IFC, Dívidas, Integrações e Configurações da obra.
- **Fora das obras**: Lista de obras, Dashboard geral, Configurações e Agente de IA.

Regras:

- O tempo nas telas de uma obra vai para aquela obra. O das telas fora das obras fica em **"Fora das obras"**.
- O modo de campo (celular) da terminalidade e da segurança conta no módulo dele, marcado **"campo"**.
- A janela da Claudia não é módulo: o tempo com ela aberta conta para a tela que está embaixo.

## Aparelho

- **Computador** ou **Celular**, reconhecido pelo navegador. Tablet conta como celular.
- O modo de campo conta sempre como celular.

## O que é gravado e o que não é

- Grava: quem usou, o dia, a obra, a tela, os segundos de uso ativo, o início e o fim de cada sessão e o aparelho.
- **Não grava**: IP, localização, o que foi digitado e o que foi visto na tela.
- Fica guardado por **13 meses**; o mais antigo é apagado sozinho.
- A contagem começou no dia da publicação da aba. Não há uso medido de antes.

## Dúvidas comuns

- **Fiquei com o sistema aberto a tarde toda e aparece pouco tempo.** Só conta o tempo com a aba na frente e algum toque nos últimos 5 minutos. Ler a tela parado por mais de 5 minutos para de contar.
- **Usei duas abas ao mesmo tempo e o tempo não dobrou.** Está certo: o tempo é o do relógio, não o de cada aba.
- **A pessoa tem "último login" mas nenhum tempo.** Ela não usou o Obra 360 desde o começo da medição. A data vem do login comum com o Takt Hub e pode ser de lá.
- **O tempo com a Claudia aberta foi para outro módulo.** A janela dela conta para a tela que está embaixo.`,
  },
  {
    id: 'dashboard-geral-acessos-tela',
    title: 'Como ler a aba Acessos: período, filtros, cartões, tabelas e planilha',
    summary: 'Filtros, cartões, tabelas e .csv.',
    keywords: [
      'no sistema agora',
      'sem acesso no período',
      'nunca entrou',
      'último acesso',
      'tabela por pessoa',
      'onde passa o tempo',
      'tempo por módulo',
      'tempo por obra',
      'uso por dia',
      'baixar planilha de acessos',
      'planilha csv',
      'média por pessoa',
      'dias com uso',
      'sessões de uma pessoa',
    ],
    screen: 'dashboard-geral',
    body: `## A aba, de cima para baixo

1. O cabeçalho, com "Como funciona" e as abas **"Obras"** e **"Acessos"**.
2. Os filtros e o **período**.
3. A linha com o que entra na conta, a frase de resumo e os **seis cartões**.
4. A tabela **"Por pessoa"**.
5. **"Tempo por módulo"** e **"Tempo por obra"**.
6. **"Uso por dia"**.
7. O botão **"Baixar planilha (.csv)"**. Esta aba não tem PDF.

## Período

**"Hoje"**, **"7 dias"** (a aba abre aqui), **"30 dias"**, **"Este mês"**, **"Mês anterior"** e **"Intervalo"**. São dias corridos, no horário de Brasília, contando sábado e domingo. Não usa as semanas inteiras da aba Obras. As setas dos cartões comparam com o período anterior do mesmo tamanho: "7 dias" com os 7 dias antes.

## Filtros

**"Pessoas"**, **"Papel"**, **"Obras"**, **"Módulos"** e **"Aparelho"**. Eles recortam tudo: a frase, os cartões, as tabelas e a planilha. O filtro "Papel" serve, por exemplo, para tirar os admins da conta.

## Os seis cartões

- **Pessoas que entraram**, de quantas cadastradas.
- **Tempo ativo** somado no período.
- **Média por pessoa**, só de quem entrou.
- **Sessões**, com a duração média.
- **No sistema agora**: quem teve uso ativo nos últimos 5 minutos. Atualiza sozinho a cada minuto.
- **Sem acesso no período**, com quantas pessoas nunca entraram.

## Tabela "Por pessoa"

Abre ordenada por tempo ativo, maior primeiro. Clique no título de qualquer coluna para ordenar por ela.

- **Pessoa**, com o papel e as obras.
- **Último acesso**.
- **Dias com uso**.
- **Sessões**.
- **Tempo ativo**.
- **Por dia de uso**: o tempo médio nos dias em que a pessoa entrou.
- **Onde passa o tempo**: uma barra dividida pelos grupos do menu (Dashboards e lista de obras, 1 Prazo, 2 Controles de obra, 3 SST, Apoio e administração) e os 3 módulos com mais tempo.
- **Aparelho**.

Quem não entrou no período fica no fim da tabela, apagado, com a data do último acesso ou "Nunca entrou".

**Clique na linha** para abrir o detalhe da pessoa: as sessões (início, fim, tempo ativo, aparelho, obras e módulos de cada uma), o tempo por módulo e o tempo por obra dela.

## Tempo por módulo e Tempo por obra

Maior primeiro, com o número de pessoas que usaram. O módulo sem uso no período é citado embaixo. As telas fora das obras somam em "Fora das obras".

## Uso por dia

Uma linha por pessoa, com os minutos ativos de cada dia. Até 31 dias, uma coluna por dia; período maior, uma coluna por semana. A última linha diz quantas pessoas entraram em cada dia.

## Baixar planilha (.csv)

O botão **"Baixar planilha (.csv)"** baixa uma linha por pessoa, dia, obra e módulo, com o recorte de agora: o período e os filtros escolhidos.

## Dúvidas comuns

- **"7 dias" não bate com a semana da aba Obras.** Aqui são dias corridos, com sábado e domingo; a aba Obras usa semanas inteiras.
- **Alguém sumiu de "No sistema agora".** O cartão mostra só quem teve uso ativo nos últimos 5 minutos.
- **Uma pessoa aparece apagada no fim da tabela.** Ela não entrou no período escolhido. Amplie o período para ver o último uso dela.`,
  },
];

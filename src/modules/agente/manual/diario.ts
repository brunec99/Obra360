import type { ManualSection } from './types';

/** Manual da aba 2.4, Diário de Obra (24/11/2026): o diário do dia, preenchido no Obra 360 e enviado ao
 * Sienge por botão. Escrito a partir do contrato do módulo (`domain/daily-report.ts`) e do modelo aprovado
 * pelo usuário, no mesmo dia em que a tela foi escrita: os nomes dos botões precisam ser conferidos com a
 * tela publicada. A última seção diz o que ainda não está liberado; atualize-a quando a situação mudar. */
export const sections: ManualSection[] = [
  {
    id: 'diario-visao-geral',
    title: 'Diário de Obra: para que serve, onde fica e quem pode o quê',
    summary: 'Aba 2.4: o diário do dia, enviado ao Sienge por botão; quem preenche, lê e reabre.',
    keywords: [
      'diário de obra',
      'diario de obra',
      'aba 2.4',
      '2.4',
      'módulo diário',
      'relatório diário de obra',
      'diário do sienge',
      'onde fica o diário',
      'quem preenche o diário',
      'quem pode enviar o diário',
      'não vejo o diário',
      'um diário por dia',
      'diário indisponível',
    ],
    screen: 'diario',
    body: `## O que é a aba 2.4, Diário de Obra

É o diário de obra do dia, preenchido no Obra 360 e **enviado ao Sienge por um botão**. Fica no grupo **2 · Controles de obra** do menu, como aba 2.4, no endereço /obras/{obraId}/diario. Tem também um **modo de campo** para o celular, em /campo/diario, que funciona sem sinal.

Existe **um diário por obra e por dia**. Ele nasce como **rascunho** e, depois do envio, fica **enviado** e travado, com o número que recebeu no Sienge.

### O que se preenche

- **Clima e jornada** por turno (manhã, tarde, noite) e o **índice pluviométrico**.
- **Atividades** do dia, trazidas do curto prazo da semana ou digitadas.
- **Mão de obra**, que é o histograma do dia (aba 2.2).
- **Equipamentos**, **ocorrências**, **observações** e **fotos** com local.

### Quem pode o quê

- O módulo é **liberado por pessoa**, por um administrador (Configurações → Usuários → Módulos, coluna "Diário de Obra"). Sem o módulo, a aba não aparece no menu e o endereço leva ao Dashboard da obra.
- Quem tem o módulo e a obra **preenche e envia** ao Sienge.
- O papel **consulta** só lê: vê o diário, mas não preenche nem envia.
- Só o **administrador** exclui o diário do Sienge e o **reabre** para correção.
- A ligação entre a empresa do histograma e o tipo de equipe do Sienge também é só do administrador.

### Nada sai sozinho

O sistema nunca manda o diário ao Sienge por conta própria. O que se preenche fica gravado no Obra 360 como rascunho; ao Sienge ele só vai quando alguém clica em **"Enviar ao Sienge"**.

### Se a tela disser que está indisponível

O módulo foi criado em 24/11/2026. Enquanto o banco de dados não estiver preparado para ele, a tela avisa que o diário está indisponível e as outras abas seguem normais. Quem resolve é o administrador do sistema.

A assistente ainda não lê nem preenche o diário: ela explica a tela por este manual.`,
  },
  {
    id: 'diario-preencher',
    title: 'Diário de Obra: preencher clima, jornada, atividades, mão de obra, equipamentos e ocorrências',
    summary: 'Turnos e clima, pluviométrico, atividades, mão de obra (o histograma do dia), equipamentos, ocorrências.',
    keywords: [
      'preencher o diário',
      'clima do dia',
      'jornada',
      'turno',
      'manhã tarde noite',
      'índice pluviométrico',
      'pluviométrico',
      'chuva',
      'atividade avulsa',
      'atividades do diário',
      'mão de obra do diário',
      'equipamentos do diário',
      'ocorrência',
      'ocorrências',
      'observações do diário',
      'impraticável',
    ],
    screen: 'diario',
    body: `## Preencher o diário do dia

Escolha a **data** no topo da tela (abre em hoje). A tela mostra também os diários dos últimos 60 dias, com a situação de cada um, para voltar a um dia anterior.

### Clima e jornada

- Ligue os **turnos** trabalhados: **Manhã**, **Tarde** e **Noite**. Um diário novo já vem com manhã (08:00 às 12:00) e tarde (13:00 às 17:00); a noite sugere 18:00 às 22:00.
- Em cada turno, informe **início**, **fim** e o **clima**: Aberto, Chuva leve, Chuva forte ou Impraticável.
- **Pelo menos um turno** é obrigatório: é o que o Sienge exige, junto com a obra e a data.
- O **índice pluviométrico** é em milímetros e é opcional.

### Atividades

- As tarefas do **curto prazo da semana** (aba 1.3) aparecem para serem trazidas com um toque; a atividade também pode ser **avulsa**, digitada.
- Cada atividade tem **descrição** (até 200 letras), **local** (da lista de Locais da obra), **quantidade** (até 4 casas decimais), **unidade** (m2, m3, m, un, kg, t ou vb) e uma observação.
- No Sienge todas entram como tarefa avulsa, com descrição, quantidade e local. Ligar a atividade à tarefa do planejamento do Sienge não faz parte desta etapa.

### Mão de obra é o histograma do dia

A mão de obra do diário **é** o histograma (aba 2.2): o diário lê e grava as mesmas linhas, por **empresa** e **função**. É um lançamento só.

- O que já foi lançado no histograma do dia aparece pronto no diário; o que se lança no diário aparece no histograma.
- **"Repetir o último dia"** copia as equipes do último dia lançado, para ajustar só as quantidades.
- A grafia que a obra já usa para empresa e função vence, como no histograma.
- Ao Sienge a mão de obra vai **por empresa**, somando as funções: o Sienge recebe o tipo de equipe ligado à empresa e a quantidade total. A função fica só no Obra 360. ATR e Takt vão como mão de obra direta; as demais empresas, como terceiros.

### Equipamentos

Tipo de equipamento (lista do Sienge), **quantidade** inteira maior que zero e a situação: Em uso, Parado ou Quebrado.

### Ocorrências

Cada ocorrência tem um **tipo** (lista do Sienge, com 11 tipos) e uma **descrição**; os dois são obrigatórios.

### Observações

Texto livre do dia, com até 4.000 letras.

### Gravação

O que se preenche fica gravado como rascunho no Obra 360. Se outra pessoa gravou o mesmo diário antes de você, o sistema recusa a gravação feita em cima da versão antiga, para ninguém apagar o trabalho do outro.`,
  },
  {
    id: 'diario-fotos-e-campo',
    title: 'Diário de Obra: fotos com local e uso no celular sem sinal',
    summary: 'Fotos com local (Relatório Fotográfico do Sienge) e o modo de campo sem sinal.',
    keywords: [
      'fotos do diário',
      'foto do diário',
      'foto sem local',
      'relatório fotográfico',
      'local da foto',
      'diário no celular',
      'diário sem sinal',
      'sem internet no diário',
      'modo de campo do diário',
      'rascunho no aparelho',
      'foto depois do envio',
      'campo diario',
    ],
    screen: 'diario',
    body: `## Fotos do diário

- Cada foto leva uma **descrição** (até 500 letras; sem ela o diário não é enviado) e um **local**, escolhido na lista de Locais da obra. O diário aceita até 30 fotos.
- A foto é reduzida no próprio aparelho antes de subir.
- Dá para marcar se a foto aparece ou não nos relatórios do Sienge.

### Por que o local importa

O Relatório Fotográfico do Sienge organiza as fotos por local. Por isso a foto **sem local**, ou com um local da obra que **ainda não foi ligado ao local do Sienge**, sobe para o diário, mas **não entra no Relatório Fotográfico**. Para ela entrar, escolha o local na foto e ligue esse local ao do Sienge (veja a seção das ligações com o Sienge).

### Foto depois do envio

O diário enviado fica travado, mas **foto nova pode entrar depois**: o Sienge aceita anexo a qualquer momento. Já a foto que foi ao Sienge não se edita mais; descrição e local só mudam enquanto ela ainda não foi enviada.

## No celular, sem sinal

O modo de campo fica em /campo/diario e é para preencher andando pela obra.

- **Sem sinal**, o rascunho e as fotos ficam **guardados no aparelho**. Quando o sinal volta, eles sobem para o Obra 360.
- Subir para o Obra 360 não é enviar ao Sienge: o envio continua sendo pelo botão **"Enviar ao Sienge"**, com sinal, no fim do dia.
- Abra a tela uma vez com sinal antes de ir ao canteiro, para o aparelho guardá-la.
- Enquanto houver algo só no aparelho, não limpe os dados do navegador nem troque de celular: o que ainda não subiu está só ali.

O modo de campo segue a mesma liberação: precisa do módulo "Diário de Obra" e da obra.`,
  },
  {
    id: 'diario-enviar-ao-sienge',
    title: 'Diário de Obra: enviar ao Sienge, diário travado, excluir e reabrir',
    summary: '"Enviar ao Sienge", diário travado depois do envio, admin exclui e reabre.',
    keywords: [
      'enviar ao sienge',
      'enviar o diário',
      'envio do diário',
      'diário travado',
      'diário enviado',
      'corrigir diário enviado',
      'reabrir o diário',
      'reabrir diário',
      'excluir do sienge',
      'excluir o diário',
      'sienge recusou',
      'erro no envio',
      'foto na fila',
    ],
    screen: 'diario',
    body: `## Enviar ao Sienge

No fim do dia, com o diário conferido, clique em **"Enviar ao Sienge"**. Nada é enviado antes desse clique.

### O que acontece no envio

1. O sistema cria o diário no Sienge, numa chamada só, com a data, o responsável, os turnos com clima e jornada, o índice pluviométrico, as observações, as atividades, a mão de obra por empresa, os equipamentos e as ocorrências.
2. Depois manda as **fotos, uma de cada vez**. A foto que falhar fica marcada com o erro e pode ser reenviada sozinha, sem repetir o diário.
3. O diário passa para **enviado**, com o número que recebeu no Sienge.

### O que impede o envio

Antes de enviar, a tela confere o diário e mostra o que impede e o que vai ficar de fora. Impedem o envio:

- A obra **não estar ligada ao empreendimento do Sienge** (Configurações da obra, seção "Orçamento do Sienge").
- **Nenhum turno** informado, ou turno com horário inválido (o fim precisa ser depois do início).
- **Foto sem descrição**: o Sienge exige a descrição.

### O que não impede, mas fica de fora

- Sem o seu **usuário do Sienge** informado, o diário vai com o usuário da integração (SIENGEAPI) como responsável.
- Empresa **sem tipo de equipe do Sienge**: a mão de obra dela não segue (continua no histograma).
- Atividade com local **sem código do Sienge**: vai sem local.
- Foto sem local ligado ao Sienge: fica fora do Relatório Fotográfico.

### Se o Sienge recusar

A tela mostra a mensagem da recusa e o diário continua em rascunho, para corrigir e enviar de novo. Um motivo já visto: o Sienge só aceita diário em obra que está "em andamento" no cadastro dele.

### Depois de enviado, o diário fica travado

O diário enviado não se edita. O Sienge não tem como corrigir clima, jornada, índice pluviométrico e observações de um diário já lançado, então o sistema não deixa o Obra 360 ficar diferente do que está lá.

Para corrigir um diário enviado:

1. Peça a um **administrador**.
2. Ele **exclui o diário do Sienge** e o **reabre** no Obra 360: o diário volta a rascunho, com tudo o que tinha.
3. Corrija e clique em "Enviar ao Sienge" de novo. O diário entra no Sienge com um número novo.

Só o administrador exclui e reabre. A única coisa que entra num diário enviado sem reabrir é **foto nova**.

### Excluir um rascunho

Um diário que ainda é rascunho pode ser excluído por quem preenche; as fotos dele vão junto. A mão de obra do dia pertence ao histograma (aba 2.2) e é lá que se corrige ou exclui.`,
  },
  {
    id: 'diario-ligacoes-sienge',
    title: 'Diário de Obra: ligações com o Sienge e o que ainda falta',
    summary: 'Usuário, local e tipo de equipe do Sienge; o que ainda falta.',
    keywords: [
      'ligações com o sienge',
      'usuário do sienge',
      'código de usuário do sienge',
      'responsável no sienge',
      'local do sienge',
      'ligar local ao sienge',
      'tipo de equipe',
      'tipo de equipe do sienge',
      'ligar empresa ao sienge',
      'empreendimento do sienge no diário',
      'o que falta no diário',
      'diário piloto',
    ],
    screen: 'diario',
    body: `## Ligações com o Sienge

O diário usa quatro ligações. Três são feitas na própria tela do diário; a da obra fica em Configurações da obra.

### 1. Obra × empreendimento do Sienge

Em **Configurações da obra**, seção **"Orçamento do Sienge"**, o administrador liga a obra ao empreendimento. É a mesma ligação usada pelo "Buscar do Sienge" da visão Custos (aba 1.1). Sem ela não há envio.

### 2. Seu usuário do Sienge

Cada pessoa informa, uma vez, o próprio **código de usuário do Sienge**. Ele fica guardado no cadastro dela e vai como **responsável** de todo diário que ela enviar.

### 3. Local da obra × local do Sienge

Cada local da obra (a lista de "Locais da obra", a mesma da Linha de Balanço e do curto prazo) é ligado ao **local do Sienge** correspondente. Vale para as atividades e, principalmente, para as fotos: foto de local não ligado não entra no Relatório Fotográfico do Sienge.

O local do Sienge é escolhido numa **lista com os locais cadastrados no Sienge** para o empreendimento (liberada em 24/11/2026). No **Atmos**, os 19 locais com correspondente claro já foram ligados (subsolo, térreo, mezanino, 2º ao 15º pavimento, caixa d'água e cobertura); halls, fachadas e equipamentos ficam para quem conhece a obra escolher, porque o Sienge não tem um local igual.

### 4. Empresa do histograma × tipo de equipe do Sienge

O Sienge recebe a mão de obra por **tipo de equipe** (são 57 tipos cadastrados lá). Cada empresa do histograma é ligada a um tipo. **Só o administrador** faz essa ligação, e ela vale para todas as obras. Quando o nome da empresa é igual ao de um tipo de equipe, a ligação é automática.

## O que ainda falta (situação em 24/11/2026)

- O envio ao Sienge foi testado com diários de teste no **Atmos** (obra piloto), excluídos em seguida. O primeiro diário de verdade pela tela ainda não foi feito.
- As atividades entram no Sienge como **avulsas**. A consulta às tarefas do planejamento do Sienge já está liberada, mas ligar a atividade a essas tarefas fica para uma próxima etapa.
- **Fora desta etapa:** corrigir só uma parte de um diário já enviado (hoje é excluir e reabrir), sugestão automática do clima e a assistente ler ou preencher o diário.

Se algo disso já estiver diferente na tela, vale a tela: esta lista é a situação do dia em que o módulo foi criado.`,
  },
];

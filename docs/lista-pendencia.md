# Lista de pendência (aba 2)

> **12/11/2026:** o quadro passou a se chamar **Quadro de Restrições**, é a **aba 1.4** (`/obras/{obraId}/restricoes`, módulo próprio `restricoes`) e não é mais uma visão da aba 2; o texto abaixo descreve a entrega de 10/11 com os nomes da época. Ver [Menu numerado e liberações](menu-e-liberacoes-2026-11-12.md).

Entregue em 10/11/2026. A aba 2 passou a se chamar **Planejamento de vagão e lista de pendência** e tem duas visões: **Vagões** (a tela de sempre, sem mudança) e **Lista de pendência** (`/obras/{obraId}/vagoes?visao=pendencias`).

## Estado

| Item | Situação em 10/11/2026 |
| --- | --- |
| Código do Obra 360 (quadro, API, botões do médio e do longo prazo) | Commit `3382814`, enviado ao `main` em 10/11/2026; CI e a imagem Docker (`imagem.yml`, ghcr.io) verdes. O sistema não está mais na Vercel: o servidor da ATR busca a imagem nova sozinho (o status "Deployment was blocked" da Vercel nesses commits não significa nada) |
| Migração `0043_pending_board.sql` (este repositório) | **Aplicada no takt-hub em 10/11/2026** (4 tabelas, RLS e grants conferidos; leitura REST com a chave de serviço respondeu 200) |
| Migração `20261110090000_obra360_pendencia_email.sql` (repositório do Takt Hub) | **Aplicada no takt-hub em 10/11/2026** (`obra360.pendencia` nos dois CHECKs da fila) |
| Modelo de e-mail `obra360.pendencia` na Edge Function `email-dispatch` (Takt Hub) | Commit `137ce34` no takt-hub. **Edge Function publicada em 10/11/2026** (`npx supabase functions deploy email-dispatch --no-verify-jwt`, com o login do dono da conta). Falta um e-mail real de ponta a ponta |
| Uso real logado | Não feito |

Sem a 0043 a visão mostra "indisponível" e o resto do sistema segue normal. Sem a parte do Takt Hub o quadro funciona inteiro e só o e-mail não sai (a falha fica no log do servidor, o comando não é recusado).

## O que é

Quadro Kanban no estilo Trello/Pipefy com as pendências que precisam estar resolvidas antes de cada frente começar. O modelo de UX foi publicado e aprovado pelo usuário antes do código, com 11 regras numeradas; as respostas dele estão em "Decisões".

- Colunas: **A fazer, Fazendo, Pausado, Concluído, Cancelado**. Arrasta-se o card entre colunas e dentro da coluna; no celular e no teclado, a coluna muda pelo menu do card ou pelo seletor do card aberto.
- Pausar e cancelar pedem **motivo**, que aparece no card.
- Card: título, descrição, entrega, tempo de execução (dias úteis), responsável, checklists, conversa.
- Sinal do card (texto, nunca só cor): vermelho quando passou da entrega sem concluir ou passou do "começar até" ainda em A fazer; amarelo quando precisa começar em até 5 dias úteis; verde no prazo; cinza quando fechado. Pausado conta como aberto: o prazo não para.
- Filtros por responsável e por origem; os contadores do topo seguem os filtros.
- Conversa: mensagens e linhas de histórico (criação, mudança de coluna, de entrega e de responsável). `@` abre a lista de quem tem a obra liberada.
- Checklists: várias por card, com barra de progresso; concluir com item aberto pede confirmação e deixa.
- Excluir card: só quem criou ou um admin.

## As três formas de criar

1. **Na aba 2**, "+ Nova pendência": digita-se a data de término e o tempo de execução. Desde 10/11/2026 (pedido do usuário no mesmo dia), o campo **"Ligar a"** permite, em vez da data manual, prender o card a uma **tarefa do médio prazo** ou a um **serviço do longo prazo**, escolhidos numa lista com o início de cada um (busca pelo nome acima de 8 itens). O card nasce igual ao das formas 2 e 3 (mesma origem, mesma entrega viva). Tarefas oferecidas: as do plano vivo mais recente do médio prazo (o mensal de maior mês, sem linha de base nem legalização), na ordem do cronograma; tarefa-resumo aparece desabilitada, para manter a regra do botão do médio prazo. Serviços oferecidos: os que têm bloco lançado na Linha de Balanço, por início. A lista vem de `GET /api/pendencias/origens` (`pendingSourceOptions`), só leitura, mesma porta do quadro; a ligação é conferida de novo no `create_card`.
2. **No médio prazo**, botão "Criar pendência" na barra do cronograma (age na linha selecionada) e no rodapé de "Informações da tarefa". Desabilitado, com o motivo na dica, em tarefa-resumo, em linha de base, em tarefa ainda não salva e com edição em andamento. Desde 19/11/2026 o mesmo botão aparece no **Gantt de legalização** da aba 1.1 (ver "Gantt de legalização como origem", no fim).
3. **No longo prazo**, botão "Criar pendência do serviço" no painel do bloco selecionado da Linha de Balanço. A origem é o **serviço** do bloco, e o início é o menor início entre os blocos do serviço.

Em 2 e 3 só se digita o título, o lead time e o responsável. A entrega é o **dia útil anterior ao início** e acompanha a reprogramação: a API recalcula a cada leitura. Se a tarefa ou o serviço deixar de existir, o card fica com a última data gravada e avisa.

Os dois botões só aparecem para quem pode abrir a aba 2.

## Decisões do usuário (10/11/2026)

- **E-mail:** "pegue do sistema de takt". O Obra 360 usa o mesmo banco do Takt Hub, então enfileira na `takt.email_outbox` pela RPC `takt.email_enqueue`; quem envia é a Edge Function `email-dispatch` do Takt Hub, pelo SMTP do Google Workspace, a cada 5 minutos.
- **Quadro de restrições do longo prazo:** "tire do longo prazo e coloque ali". O quadro de três colunas saiu da aba 1 e a visão "Vagões e restrições" virou "Vagões".
- **Acesso:** "vou liberar depois". O quadro segue a liberação da seção `vagoes` (desenvolvedor, admin e quem tem o módulo liberado). Dentro do módulo, qualquer papel cria, move, comenta e marca.
- **Prazo em dias úteis** (segunda a sexta, sem feriados).
- **Entrega na véspera do início**, acompanhando a tarefa; **longo prazo usa o início do serviço** no primeiro bloco.
- Demais regras do modelo aceitas como propostas: motivo ao pausar e cancelar, e-mail só a quem é marcado e ao novo responsável, confirmação ao concluir com item aberto, histórico na conversa.

## Decisões de desenho

- **Fora do snapshot**, como a terminalidade (0028) e a segurança (0040): tabelas próprias, API própria, um comando por requisição, resposta com a obra atualizada. A 0043 não reescreve `commit_planning`.
- **O card não trava vagão.** As restrições impeditivas do vagão (`restrictions`, comandos `create_restriction`/`resolve_restriction`) continuam no detalhe do vagão, sem mudança. A 0043 **copia** as restrições existentes como cards de origem "Restrição" (id `restricao-<id>`, rodar de novo não duplica); as linhas originais ficam.
- **Tarefa do médio prazo muda de id a cada mês.** A cópia mensal (`copyPlanForward`) passou a gravar `sourceTaskId` com a tarefa do mês anterior, e o card segue esse elo até o plano mais recente. Para planos copiados antes de 10/11/2026 e para planos importados do Project, que não têm o elo, o par é procurado no mês seguinte pelo caminho de nomes (resumos acima + nome); tarefa renomeada ou movida de resumo nesses casos perde o par e o card fica na data do mês antigo.
- **E-mail nunca derruba o comando**: é enfileirado depois da gravação, e a falha vai para o log só com ids e código do erro. Chave de idempotência por mensagem e pessoa.
- **Lead time das restrições copiadas**: o número antigo (dias corridos) passa a ser lido em dias úteis.

## Arquitetura

| Camada | Arquivo |
| --- | --- |
| Contrato e regras de prazo | `src/domain/pending-board.ts` |
| Regras dos comandos e resolução da origem (puro) | `src/application/use-cases/pending-commands.ts` |
| Banco | `src/infrastructure/repositories/supabase/pending-repository.ts` |
| E-mail | `src/infrastructure/email/takt-outbox.ts` |
| API | `GET /api/pendencias?workId=`, `POST /api/pendencias/commands?workId=` |
| Tela | `src/modules/pendencias/` (`pending-board.tsx`, `card-dialog.tsx`, `create-pending-dialog.tsx`, `mention-input.tsx`, `pending-view.ts`) |
| Botões | `src/modules/medio-prazo/schedule-sheet.tsx`, `task-info-dialog.tsx`; `src/modules/longo-prazo/lob/lob-activity-panel.tsx` |
| Acesso | `src/application/module-access.ts` (`/api/pendencias` na seção `vagoes`) |

Tabelas da 0043: `pending_cards`, `pending_checklists`, `pending_checklist_items`, `pending_messages`, todas com `work_id ... on delete cascade` (excluir a obra leva tudo), RLS ligada sem política e grant para `service_role`.

No Takt Hub (`~/Applications/App-Takt`): `supabase/migrations/20261110090000_obra360_pendencia_email.sql` soma `obra360.pendencia` ao catálogo de `kind`/`template` da fila; `supabase/functions/_shared/email-templates.ts` ganhou o modelo (moldura própria "Obra 360", sem o logo do Takt Hub; link só `https`); teste em `tests/unit/obra360-pendencia.test.ts`.

## Para colocar no ar, nesta ordem

1. ~~Aplicar a `0043_pending_board.sql` no takt-hub.~~ Feito em 10/11/2026.
2. ~~Aplicar a `20261110090000_obra360_pendencia_email.sql` no takt-hub.~~ Feito em 10/11/2026.
3. ~~Publicar a Edge Function `email-dispatch` do Takt Hub (sem isso a linha da fila falha com `modelo_desconhecido`).~~ Feito em 10/11/2026.
4. ~~Publicar o Obra 360.~~ Feito em 10/11/2026 pelo `main` (imagem do servidor da ATR).

O código novo sem a 0043 não quebra nada (a visão fica indisponível). A cópia mensal que grava o elo não depende de migração.

## Validação (10/11/2026)

- `npm run typecheck`, `lint` (0 erros), `format:check`, `npm test` (1.250 testes), `validate:migrations`, `build` e `test:e2e`: todos passaram.
- Testes novos: `tests/pending-board.test.ts`, `tests/pending-commands.test.ts`, `tests/pending-view.test.ts`; ajustados `tests/delete-work.test.ts` (as tabelas novas caem com a obra), `tests/module-access.test.ts`, `tests/plan-monthly.test.ts` (o elo da cópia).
- Tela aberta no navegador com `next dev`, Supabase falso e API simulada pelas regras reais (`planPendingCommand`), em 1500 px e 400 px: quadro, arrastar entre colunas, motivo ao pausar, card aberto, menção com `@`, envio de mensagem e "Nova pendência", sem erro de página.
- No Takt Hub: `tsc` e os testes do modelo de e-mail passaram.

- **Ligar a tarefa ou serviço na aba 2 (10/11/2026):** a sequência do CI passou de novo (1.251 testes; teste novo de `pendingSourceOptions` em `tests/pending-commands.test.ts`). Formulário percorrido no navegador com API simulada pelas regras reais, em 1300 px e 400 px: alternar "Ligar a", buscar, escolher tarefa, erro ao enviar sem escolher, criar e ver o card com a origem "Médio prazo" e a entrega na véspera útil. A rota `/api/pendencias/origens` não rodou contra o banco real.

## Não verificado

- Nada rodou contra o banco real: rotas, repositório, a cópia das restrições e o enfileiramento do e-mail.
- O envio de um e-mail de ponta a ponta. O schema `takt` responde pela API com a chave de serviço (leitura de `takt.email_outbox` conferida em 10/11/2026), mas nenhuma linha foi enfileirada.
- Os botões do médio e do longo prazo abrindo o formulário em tela real.
- (Conferido em 10/11/2026: a tabela `restrictions` de produção estava vazia, então a 0043 não copiou nenhum card.)

## Pendências

- Conferir um e-mail real de menção de ponta a ponta (marcar alguém com @ num card e ver a mensagem chegar): a função e as migrações estão no ar, mas o envio real não foi testado.
- Liberar o módulo para as pessoas (decisão do usuário: depois).
- O Dashboard da obra ainda mostra "Restrições por coluna" com as três colunas antigas, e o comando `move_restriction` ficou sem tela.
- O botão "Gerar restrição" do curto prazo (só desenvolvedor) continua criando restrição de vagão, não card.
- Sem feriados no calendário de dias úteis; sem anexos no card; sem aviso por e-mail de prazo vencendo.
- Passeio guiado do quadro tem só três passos.

## Retorno do Atmos (16/11/2026)

O coordenador de obras do Atmos testou o Quadro de Restrições (aba 1.4) e pediu quatro coisas; a quinta (anotações) veio junto. **No mesmo dia o gerente decidiu manter abertas a todos a restrição avulsa e a troca de responsável**: as duas travas por pessoa que chegaram a ser implementadas de manhã (avulsa só para admin; troca só por criador, responsável atual ou admin) foram desfeitas, e da troca ficou só a confirmação. O texto abaixo descreve o estado final. **Tudo está implementado no código, sem commit e sem publicação nesta data; nenhuma migração foi criada nem é necessária.** Onde este trecho contradiz o texto de 10/11 acima (por exemplo os rótulos "Manual" e "Restrição"), vale este.

### Comportamento entregue

1. **Rolagem só na área dos cards.** A partir de 640 px de largura, o quadro ganha a altura que falta até o pé da janela e cada coluna rola os próprios cards. O cabeçalho, os filtros, os contadores, o título de cada coluna e o "+ Nova pendência" do pé de A fazer ficam parados. Altura mínima de 24 rem: em janela baixa a página volta a rolar. Abaixo de 640 px nada mudou (a página inteira rola). A rolagem de lado da grade continua.
2. **Troca de responsável com confirmação.** O campo "Responsável" do card aberto não grava mais na hora: pergunta "Passar a responsabilidade de X para Y? Y recebe um e-mail avisando." e só grava com a confirmação (cancelar deixa como estava). Qualquer pessoa com o quadro continua podendo trocar; o servidor não mudou nesse ponto.
3. **Formulário abre ligado ao cronograma.** Em "+ Nova pendência", "Ligar a" abre em "Tarefa do médio prazo"; sem tarefas no cronograma do mês, em "Serviço do longo prazo"; sem nenhum dos dois, em "Sem ligação". A opção "Sem ligação" (card avulso, data digitada) continua para todos, agora como a última das três. O servidor aceita `create_card` de origem `manual` de qualquer pessoa, como antes.
4. **Filtro "Origem".** "Restrição" virou **"Restrição de vagão (antiga)"** e só é listada quando o quadro da obra tem algum card com essa origem (são cópias feitas uma única vez pela 0043; em produção não há nenhum). "Manual" virou **"Avulsa (sem ligação)"**. Os rótulos saem de `PENDING_ORIGIN_LABELS`, usado só pelo chip do card e pelo filtro; PDF, dashboards, e-mail e Claudia não mostram a origem do card (conferido por busca).
5. **Anotações do médio prazo no card.** Card criado com origem `medio_prazo` e sem descrição recebe as anotações da tarefa (`plan_tasks.notes`) como descrição, cortadas em 4.000 caracteres. Vale para o botão "Criar pendência" do cronograma (que não tem campo de descrição) e para o "+ Nova pendência" do quadro com a descrição em branco. O formulário mostra "As anotações da tarefa entram na descrição do card.".

### Decisões

- **Troca de responsável e avulsa abertas a todos (decisão do gerente, 16/11/2026).** A primeira versão do dia restringia as duas; o gerente preferiu não travar por pessoa. Foram removidos `canChangeResponsible`, `RESPONSIBLE_LOCKED` e `UNLINKED_REFUSED`, o campo desabilitado, o rótulo "Sem ligação (só administrador)" e o aviso de "nada a que ligar". A única trava por pessoa do quadro segue sendo a exclusão do card (criador ou admin).
- **O incentivo a ligar é só o padrão do formulário**: quem quer uma restrição avulsa precisa escolher "Sem ligação" de propósito.
- **A lista de origens é lida ao abrir o formulário** (antes, só quando a pessoa escolhia ligar): é ela que decide o padrão. Se a leitura falhar, o formulário fica em "Tarefa do médio prazo" com o erro e o "Tentar de novo"; "Sem ligação" continua clicável.
- **Anotações:** são as da tarefa escolhida (`sourceId`), lidas na criação. É cópia, não vínculo: editar a anotação depois não muda o card. Falha ao ler a anotação não derruba a criação (o card nasce sem descrição e a falha vai para o log). O serviço do longo prazo não tem anotação copiada.
- **Altura do quadro:** medida no navegador (`useFitHeight` em `pending-board.tsx`): altura visível do contêiner do layout que rola, menos o topo do quadro e o respiro de baixo. O layout (`src/app/(app)/layout.tsx`) não foi alterado. A linha da coluna usa `minmax(0,1fr)` para a coluna mais cheia não esticar o quadro.
- **Confirmação ao trocar para si mesmo** também é pedida, sem a frase do e-mail (quem pega para si não recebe aviso).

### Arquivos

`src/domain/pending-board.ts` (rótulos), `src/application/use-cases/pending-commands.ts` (cópia das anotações), `src/infrastructure/repositories/supabase/pending-repository.ts` (`resolveSourceForCreate` devolve `notes`), `src/modules/pendencias/pending-board.tsx`, `card-dialog.tsx`, `create-pending-dialog.tsx`, `pending-view.ts` (`filterOrigins`), manual da Claudia (`vagoes-lista-de-pendencia`) e passeio guiado (`tour/pages/restricoes.ts`). As props do `CreatePendingDialog` não mudaram: os botões do médio e do longo prazo seguem sem alteração.

### Validação (16/11/2026)

- `node --import tsx --test tests/pending-*.test.ts tests/agent-manual.test.ts tests/tour*.test.ts`: passou, depois da reversão. Testes novos em `tests/pending-commands.test.ts` (avulsa aceita de quem não é admin, troca de responsável por quem não criou nem é responsável, anotações copiadas e cortadas, rótulos) e em `tests/pending-view.test.ts` (`filterOrigins`).
- `npx eslint` e `npx prettier --check` nos arquivos alterados: sem erro.
- `npx tsc --noEmit -p .`: sem erros.

### Não verificado

- **Nada foi aberto no navegador.** A rolagem por coluna, a altura medida, o arrastar e soltar com a coluna rolada ou vazia, a confirmação da troca de responsável e o padrão do formulário não foram vistos em tela, nem em 1500 px nem no celular.
- Nada rodou contra o banco real: a leitura de `plan_tasks.notes` pela rota.
- `npm run build` e o e2e não foram rodados.

### Pendências e próximas etapas (não implementado)

- Conferir no navegador os cinco itens acima antes de publicar, em especial arrastar um card para o fim de uma coluna rolada.
- O texto de 10/11 deste documento e a tabela "Estado" não foram reescritos; continuam descrevendo a entrega original.
- Os cards avulsos antigos não foram convertidos nem marcados; se o coordenador quiser ligá-los a uma tarefa, não há ação de "ligar depois" no card.
- A descrição herdada não acompanha mudanças posteriores nas anotações da tarefa.

## Gantt de legalização como origem (19/11/2026)

Pedido do usuário em 19/11/2026: no Gantt de longo prazo (legalização), permitir criar restrições como na Linha de Balanço e no médio prazo.

### Comportamento entregue

- O botão **"Criar pendência"** (barra do cronograma e rodapé de "Informações da tarefa") passou a aparecer também no Gantt de legalização, que reusa a tela do médio prazo. Mesmas regras: só título, lead time e responsável são digitados; a entrega é o dia útil anterior ao início da linha e acompanha a reprogramação; desabilitado em tarefa-resumo e em linha nova ou ainda não salva; só aparece para quem abre o Quadro de Restrições (aba 1.4), qualquer que seja o perfil.
- No quadro, o card dessa origem aparece como **"Gantt de legalização · nome da linha"**, e o texto da entrega no card diz "a tarefa … do Gantt de legalização".
- As anotações da linha viram a descrição do card criado sem descrição, como no médio prazo.

### Decisões

- **Sem migração e sem origem nova no banco.** O card é gravado com `origin = 'medio_prazo'` e `source_id` = id da linha (`plan_tasks.id`), que o servidor já aceitava e resolvia (teste "o Gantt de legalização não entra na sucessão" de `tests/pending-commands.test.ts`): a linha do Gantt de legalização segue a si mesma, sem a sucessão mensal. O que mudou no servidor foi só a resposta: `resolvePendingSources` devolve `sourceLegalization: true` quando a tarefa achada é de um plano `kind: 'legalizacao'`. É campo só da resposta, como `sourceStart`; não vai ao banco.
- Consequência aceita: no filtro de origem do quadro, esses cards entram em "Médio prazo"; e, se a linha for excluída do Gantt (`sourceMissing`), o card volta a dizer "Médio prazo", porque sem a tarefa não há como saber de que plano ela era.

### Arquivos

`src/modules/medio-prazo/schedule-sheet.tsx` (saiu o `!variant` de `canPend`), `src/application/use-cases/pending-commands.ts` (`sourceLegalization` no resolvedor), `src/domain/pending-board.ts`, `src/modules/pendencias/pending-view.ts` (`originLabel`), `src/modules/pendencias/card-dialog.tsx`, tour e manual do longo e do médio prazo.

### Validação (19/11/2026)

Sequência do `ci.yml` rodada local, toda verde: `typecheck`, `lint` (sem erros; só os avisos que já existiam), `format:check`, `npm test` (1.554 testes, incluindo os novos casos de `tests/pending-commands.test.ts` e `tests/pending-view.test.ts` para `sourceLegalization` e o rótulo "Gantt de legalização · …"), `validate:migrations`, `build` e `test:e2e` (10 testes). Sem commit nem publicação.

### Não verificado

- Uso real logado: criar o card a partir de uma linha do Gantt de legalização numa obra de verdade e ver a entrega mudar ao reprogramar a linha. Nenhuma tela foi aberta no navegador nesta entrega.

### Próximas etapas (não implementado)

- Oferecer as linhas do Gantt de legalização no campo "Ligar a" do formulário "+ Nova pendência" do quadro (hoje só tarefas do plano do mês e serviços da Linha de Balanço).
- Filtro de origem próprio para "Gantt de legalização" no quadro.

## Criar pela Claudia (24/11/2026)

A Claudia cadastra cards pelo chat, de qualquer tela da obra: consulta o quadro, não duplica e devolve uma proposta que a pessoa aplica. Os comandos são `create_card` comuns, enviados a `POST /api/pendencias/commands`; nada mudou nas regras nem no banco. A tela do quadro relê quando uma proposta é aplicada (evento `obra360:restricoes-mudaram` em `src/modules/pendencias/api.ts`). Detalhes, decisões e validação em `docs/agente-ia.md`, seção "Restrições pelo chat (24/11/2026)".

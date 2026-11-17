# Checklist de equipamentos (aba 9)

> **12/11/2026:** a aba 9 passou a ser a **3.2** e a tela logada deixou de ser aberta a todos: é liberada por pessoa (módulo `checklist`). O QR do operador não muda. O código do operador pelo QR foi publicado em `df1e428`. Ver [Menu numerado e liberações](menu-e-liberacoes-2026-11-12.md).

Entregue em 11/11/2026, a pedido do usuário ("vamos desenvolver um módulo de checklist diário, semanal e
mensal de equipamentos"; "checklist permita que o tst edite"). Fica no grupo **SST** do menu, abaixo da
vistoria de segurança.

**Situação:** código, testes e migração prontos e validados localmente (testes, tipos, lint, validação das
migrações e build). **A migração 0047 ainda não foi aplicada no Supabase**, a tela não foi exercitada num
navegador e nenhuma gravação foi feita num banco real. Sem a 0047 a aba responde "indisponível" e as
demais seguem normais. **Nenhum modelo vem cadastrado:** as fichas da empresa não foram fornecidas, então
os TSTs criam os modelos na própria tela.

**Atualização de 11/11/2026 (noite):** a migração foi aplicada no `takt-hub` pela CLI do Supabase, a pedido do usuário, e conferida no catálogo (tabela, RLS ligada, grant para `service_role`, sem acesso de `anon`). A tela ainda não foi aberta logada em produção.

## Nº do equipamento ou pavimento, liberação e aviso ao TST (17/11/2026)

**Pedido:** três mensagens da responsável de SST em 17/11/2026, na conversa do Cloudflare Access, com prints da tela:

1. "Precisamos incluir opção de colocar o número do equipamento ou pavimento no checklist." (print do modelo "REDE U (PISO A PISO)", tipo SST, semanal).
2. "Consegue incluir opção de liberação de equipamento no campo de Periodicidade ou algum outro lugar que seja feito uma única vez?" (print da lista Diário / Semanal / Mensal).
3. "Quando algum item não conforme é possível ele comunicar o TST da obra?" (print de "Últimas inspeções" com duas inspeções pelo QR com não conformes).

**Situação:** código, testes e a migração `0053_checklist_location_release.sql` prontos e validados localmente. Com o "faça tudo" do usuário em 17/11/2026: **a 0053 foi aplicada no `takt-hub`** (transação pelo pooler, estado lido antes e depois: as duas colunas novas, `once` nos dois CHECKs de periodicidade, o índice único `checklist_runs_spot_day_idx` no lugar da unicidade antiga; 11 modelos, 7 equipamentos e 2 inspeções intactos, sem dia repetido); no Takt Hub (`App-Takt`), **a migração `20261117100000_obra360_checklist_nc_email.sql` foi aplicada** (o tipo `obra360.checklist_nc` entrou nos dois CHECKs da fila) e **a Edge Function `email-dispatch` foi republicada** com o modelo novo; o código dos dois repositórios foi **enviado ao `main`**, depois das migrações. Não houve modelo de UX prévio: são campos dentro das telas que já existem.

### Decisões tomadas na implementação (apresentadas ao usuário, que mandou publicar sem mudar)

- **O local é uma opção do modelo**, e não um campo solto em toda inspeção: "Pedir o nº do equipamento ou o pavimento a quem preenche". Com ela ligada, o campo é obrigatório. Motivo: só assim o sistema sabe que aquele checklist se repete por local.
- **Com local, o checklist se repete no período, uma vez por local.** Sem isso, o "Rede U (piso a piso)" semanal aceitaria um pavimento só por semana pelo QR. Os demais modelos seguem como antes.
- **A liberação vale para sempre**, por equipamento (e por local, se o modelo pede): não há "liberar de novo" a não ser excluindo a inspeção.
- **Quem recebe o aviso são os TSTs com a obra** (`profiles.tst` e a obra em `work_ids`, a mesma lista da aba 3.1), menos quem registrou. Admin que não é TST não recebe. Obra sem TST marcado não avisa ninguém.
- **Só a inspeção nova avisa.** Editar uma inspeção e acrescentar uma não conformidade não envia e-mail.

### Como funciona

- **Local** (`ChecklistModel.asksLocation`, `ChecklistRun.location`, até 60 caracteres):
  - `save_model` aceita `asksLocation` (ausente mantém o que o modelo tem). `save_run` aceita `location` (ausente mantém o da inspeção). O local só é guardado quando o modelo pede ou a inspeção já tem um.
  - Unicidade: mesmo equipamento, modelo, dia **e local** (`checklistKey`, sem acento nem maiúsculas). Pelo link, mesmo local no período.
  - `checklistBoard` passou a devolver `periodRuns` (todas as inspeções do período); a situação fica vermelha se qualquer uma tem não conformidade. `operatorDues` devolve `asksLocation` e `doneLocations`.
  - Tela logada: caixa de marcar no editor do modelo; campo no formulário da inspeção; o cartão do quadro lista os locais feitos e, para quem registra, abre uma inspeção nova (as feitas ficam em "Últimas inspeções", que mostra o local).
  - Tela do operador: campo obrigatório no topo do formulário, lista "Já feito …", botão **Preencher outro** no checklist já feito e bloqueio do local repetido antes do envio.
- **Liberação** (`ChecklistFrequency` ganhou `'once'`, rótulo "Liberação"; na lista do modelo, "Liberação (uma única vez)"):
  - `periodKey('once', dia)` é sempre `'once'`: qualquer inspeção deixa o checklist feito. Texto do pendente: "pendente de liberação".
  - Segunda inspeção recusada na tela e no link, com o dia da primeira. A própria inspeção segue editável.
  - `loadChecklist` lê também as inspeções `once` anteriores à janela de 120 dias (até 1.000), para o equipamento liberado há mais tempo não voltar a pendente. Vale para a aba, o QR e o dashboard.
  - `ChecklistSummary.due` ganhou `once`; a tela mostra o cartão "Liberações pendentes" quando há liberação devida. Os quadros do dashboard somam a liberação nos pendentes.
- **Aviso ao TST** (`src/infrastructure/email/checklist-nc.ts`):
  - As duas rotas de gravação (`/api/checklist/commands` e `/api/publico/checklist/[token]`) chamam `notifyChecklistNc` depois de gravar uma inspeção nova com não conformidade. Nunca derruba a gravação: cada falha vira log, sem endereço nem texto.
  - Enfileira em `takt.email_enqueue` com o tipo e o modelo `obra360.checklist_nc`, um e-mail por TST, chave `obra360.checklist_nc:<inspeção>:<pessoa>` (repetir não duplica).
  - Payload: obra, equipamento, checklist, periodicidade, local, operador, origem (`qr` ou `tela`), data, total e até 10 itens não conformes (texto até 140 e descrição até 200 caracteres, cortando para o payload ficar abaixo de 3.400 bytes; o teto da fila é 4.096) e o link `/obras/<obra>/checklist`.
  - A rota pública devolve `saved.notified`; a confirmação do operador só diz que o técnico foi avisado quando pelo menos um e-mail entrou na fila.
  - A rota pública não ganhou caminho novo em `/api/publico/` (ponto levantado pela AIRON Labs em 17/11/2026): só passou a enfileirar e-mail dentro do `POST` que já existia, com o mesmo freio de 20 envios por link a cada 10 minutos.
- **Banco** (0053): `checklist_models.asks_location boolean default false`; `checklist_runs.location text default ''`; os dois CHECKs de `frequency` passam a aceitar `once`; a unicidade `(equipment_id, model_id, done_on)` dá lugar ao índice único `checklist_runs_spot_day_idx (equipment_id, model_id, done_on, location)`. Nenhuma linha existente muda.
- **Sem a 0053** o que já funcionava segue gravando: as colunas novas só vão no comando quando usadas (na atualização, a gravação tenta com a coluna e repete sem ela se o valor é o padrão). Usar o local ou a liberação responde "Aplique a migração 0053". A 0053 entrou em `MIGRATION_CHECKS`.

### Validação de 17/11/2026

- `tests/checklist.test.ts`: 4 testes novos (local pedido pelo modelo e guardado; repetição por local na tela e pelo QR, quadro e visão do operador; liberação pendente, feita para sempre, recusada na segunda vez e por local; assunto, payload e tamanho do e-mail) e um ajuste de texto num teste antigo ("neste período" virou "nesta semana").
- Sequência do `ci.yml` local: tipos, lint (sem erro), Prettier, 1.554 testes, validação das migrações (com a 0053 num PostgreSQL isolado), build e e2e. O teto do índice do manual da assistente subiu de 15.500 para 16.000 caracteres (seção nova `checklist-local-liberacao-aviso`).
- Navegador (`next dev` com as rotas do checklist respondidas pelas regras reais em memória; equipamento "GERAL", tipo GLOBAL): a lista de periodicidade mostrou "Liberação (uma única vez)"; o admin criou "REDE U (PISO A PISO)" semanal com a opção de local e "LIBERAÇÃO DA GRUA"; apareceu o cartão "Liberações pendentes"; a inspeção exigiu o local, gravou "3º pavimento", reabriu como inspeção nova, recusou "3º PAVIMENTO" no mesmo dia e aceitou "4º pavimento" (o quadro passou a listar os dois); a liberação saiu de "pendente de liberação" para feita. No celular (390 px, sem cookie) o QR mostrou "Já feito nesta semana: 3º pavimento, 4º pavimento" e **Preencher outro**, bloqueou o envio sem local e com local repetido, gravou "5º pavimento" com um item não conforme e a confirmação informou o aviso ao técnico; a liberação feita ficou sem botão. Sem rolagem lateral em 1.440 e 390 px. O envio do e-mail em si não passa por esse teste (a resposta da rota foi simulada).
- **Não validado:** gravação num banco real pelo sistema, o e-mail de ponta a ponta (nenhum aviso real foi enfileirado ainda) e o uso logado em produção.

## QR barrado pelo Cloudflare Access no servidor da ATR (17/11/2026)

A equipe da obra relatou: "quando pessoal que não tem login acessa com QR code, pede login". O print mostrava a tela do **Cloudflare Access** ("Log in to planejamento - teste (homologação ATR)", em `aironlab.cloudflareaccess.com`), e não a do sistema.

- **Não é o sistema.** O `matcher` de `src/proxy.ts` já deixa `/checklist/` e `/api/publico/` fora do login desde 12/11/2026. Quem autoriza é o código secreto do equipamento, conferido pela rota.
- **É o Cloudflare Access** que fica na frente de `planejamento-teste.aironlab.com.br` inteiro, antes do container. Ele é administrado pela AIRON Labs (Thiago), e o painel não está ao alcance deste repositório.
- **O que precisa ficar liberado** (aplicação self-hosted com política Bypass, Include: Everyone), que é tudo o que a tela do operador carrega:
  - `/checklist/*`: a página que o QR abre;
  - `/api/publico/*`: a API que carrega e envia o checklist com as fotos (as fotos vão no próprio envio);
  - `/_next/static/*`: o JavaScript e o CSS compilados. A chave do Supabase só é lida no servidor (`proxy.ts`, `supabase-server.ts`) e não vai para esses arquivos;
  - opcional, só ícones: `/icon.svg`, `/apple-icon`, `/manifest.webmanifest`, `/favicon.ico`.
- **Situação em 17/11/2026:** rascunho de e-mail ao Thiago com esses caminhos criado no Gmail do usuário, ainda não enviado. **Nada mudou no código.** Depois da liberação, conferir abrindo o link de um QR numa janela anônima ou num celular sem login.
- Se o endereço do sistema mudar, o QR impresso aponta para o endereço de onde a etiqueta foi impressa (`window.location.origin`). Etiquetas impressas no endereço antigo precisam ser reimpressas.

## Checklists de cada QR: incluir e tirar (16/11/2026)

**Pedido:** a equipe de SST mandou um print do quadro (equipamento "GERAL", tipo "GLOBAL", com nove checklists diários) com a pergunta "neste campo consigo incluir opção de incluir e desativar os checklists que estão vinculados no QR code?". Até aqui o equipamento recebia todos os modelos ativos do tipo dele, sem escolha.

**Situação:** código, testes e a migração `0052_checklist_equipment_models.sql` prontos e validados localmente. **A 0052 foi aplicada no `takt-hub` em 16/11/2026**, a pedido do usuário, numa transação pelo pooler, com o estado lido antes e depois (as duas colunas `text[]` com default vazio; os 5 equipamentos e os 9 modelos intactos, todos com as listas vazias; a API REST lê as colunas com a chave de serviço e recusa sem chave, 401). **Código enviado ao `main` em 16/11/2026**, depois da migração. Sem a 0052 o resto da aba seguiria normal, e só "Salvar" em Checklists do QR responderia "aplique a migração 0052".

### Como funciona

- Na linha do equipamento, o admin (`canManageChecklist`) tem o botão **Checklists do QR** (`EquipmentModels` em `checklist-overview.tsx`). Abre a lista dos modelos ativos em dois grupos: **do tipo do equipamento** (marcados por padrão; "um modelo novo deste tipo entra sozinho") e **de outros tipos** ("entram só se marcados"). Há "Marcar todos" e "Desmarcar todos" por grupo e, com mais de nove modelos, o campo **Procurar** (nome ou tipo). **Salvar** manda a lista final.
- Comando `set_equipment_models { id, modelIds }` (cadastro: só admin, como os demais fora de `save_run` e `delete_run`).
- Gravado como **exceção ao tipo**, em duas colunas de `checklist_equipment`: `hidden_model_ids` (modelos do tipo que o admin tirou) e `extra_model_ids` (modelos de outro tipo que ele incluiu). Vazias = o comportamento anterior. Por isso um modelo novo do tipo continua entrando sozinho. `equipmentModelLinks` converte a lista escolhida nessas duas listas; `modelsFor` passou a ler as duas, e com ele o quadro, os cartões, o operador pelo QR e o quadro do dashboard.
- Modelo desativado não aparece na escolha e **guarda a marcação** que tinha (volta igual se reativado).
- Inspeção **nova** só de um checklist ligado ao QR, pela tela ou pelo link ("foi tirado do QR de …" ou "é de …, e o equipamento é …", com a indicação de Checklists do QR). Editar ou excluir uma inspeção já feita segue valendo.
- O **link e a etiqueta não mudam**. Desmarcar tudo é permitido (o QR abre sem checklists, e a linha avisa "Nenhum checklist ligado a este QR").
- A gravação das duas colunas vai à parte (`mutation.equipmentModels`), e `equipmentToRow` não as inclui: cadastrar, renomear e desativar não dependem da 0052. Coluna ausente com `model_ids` no erro vira a mensagem da 0052. A 0052 entrou na lista de migrações sondadas (`MIGRATION_CHECKS`).

### Validação de 16/11/2026

- `tests/checklist.test.ts`: 3 testes novos (tirar um do tipo e incluir de outro, com o quadro e o operador seguindo a escolha; modelo novo do tipo entra sozinho; pedido repetido não grava; desmarcar tudo; marcação guardada de modelo desativado; recusas de modelo inexistente, desativado e repetido; inspeção nova recusada pela tela e pelo link para checklist tirado, a antiga segue editável) e o comando novo na lista dos que exigem admin.
- Sequência do `ci.yml` local: tipos, lint (sem erro), Prettier, 1.512 testes, validação das migrações (com a 0052) e build.
- Navegador (`next dev` com as rotas do checklist respondidas pelas regras reais em memória, dados como os do print: "GERAL", tipo GLOBAL, nove diários, mais dois modelos de outros tipos): o admin abriu "Checklists do QR", desmarcou dois GLOBAL e marcou "SERRA CIRCULAR" (Serra circular); a gravação saiu com `hidden_model_ids` = os dois e `extra_model_ids` = a serra, o quadro e a visão do operador passaram a mostrar os oito; reaberto, desmarcar tudo salvou e a linha avisou "Nenhum checklist ligado a este QR". Em 390 px, sem rolagem lateral.
- **Não validado:** o uso logado em produção (a 0052 está aplicada, mas nenhuma escolha foi gravada ainda).

## Operador pelo QR, assinatura, fotos e cadastro só com admin (12/11/2026)

**Pedido:** a equipe de SST levantou quatro pontos e o usuário respondeu a cada um: (1) o preenchimento é do funcionário que opera o equipamento — decidido: **tela sem login**, aberta por QR; (2) assinatura — **sim**, desenhada na tela; (3) cadastro só com a responsável de SST — **só administradores** (ela passa a admin); (4) foto — o campo **já entra**, opcional. O modelo das telas e as sete regras abaixo foram publicados antes do código e aprovados sem mudança.

**Situação:** código, testes e migração `0048_checklist_operator.sql` prontos e validados localmente. **A 0048 foi aplicada no `takt-hub` em 12/11/2026**, a pedido do usuário, numa transação (pelo pooler), com o estado lido antes e depois: colunas novas em `checklist_equipment` e `checklist_runs`, as duas restrições, o índice único do link, o bucket privado `checklist` (2 MB, JPEG e PNG), `service_role` gravando, `anon` sem acesso (401) e a API REST lendo as colunas novas. As três tabelas estavam vazias. **Código publicado em 12/11/2026** (`df1e428`, CI e Imagem verdes). A pessoa de SST ainda precisa ser marcada como admin em Configurações → Usuários.

### Regras aprovadas

1. **Um link secreto por equipamento, sem login.** `checklist_equipment.public_token`; o endereço é `/checklist/<token>`. Quem abre vê só aquele equipamento (obra, nome, tipo e os checklists dele). Nada mais do sistema sai por esse caminho.
2. **Pelo link só se registra o dia de hoje, e só o que está pendente no período** (diário uma vez por dia, semanal uma por semana, mensal uma por mês). O operador não edita nem apaga; corrigir é com TST e admin, logados. A tela logada segue podendo repetir um semanal ou mensal em outro dia.
3. **Nome completo (nome e sobrenome) e assinatura são obrigatórios pelo link.** Na tela logada os dois campos existem e são opcionais; quem assina precisa ter o nome escrito.
4. **Fotos opcionais, até 4 por inspeção**, da inspeção como um todo, comprimidas no celular (JPEG de até 1280 px e ~600 KB).
5. **Cadastro só com admin** (`canManageChecklist`): modelos, equipamentos e a troca do link. O TST (`canWriteChecklist`) registra, corrige e exclui inspeções e vê o QR.
6. **"Gerar novo link" invalida a etiqueta antiga** (`rotate_equipment_token`). Desativar o equipamento também fecha o link. Renomear não troca o link.
7. **No histórico aparecem o nome do operador, a assinatura (com data e hora) e as fotos**; a inspeção vinda do link leva a marca "pelo QR" (`source = 'link'`, `created_by = 'qr'`).

### Como funciona

- **Tela do operador** (`src/app/checklist/[token]/page.tsx`, `src/modules/checklist/operator-app.tsx`): lista dos checklists do equipamento com a situação, formulário (itens, fotos, observação, nome, assinatura) e confirmação; com item não conforme, a confirmação manda avisar o técnico de segurança. O nome fica guardado no aparelho (`localStorage`) para o dia seguinte. Precisa de internet.
- **API pública** (`src/app/api/publico/checklist/[token]/route.ts`): `GET` devolve a visão do operador; `POST` registra uma inspeção. Obra, equipamento, data e autoria são do servidor; o corpo só traz modelo, respostas, nome, assinatura e fotos. Freio de 20 envios por link a cada 10 minutos (em memória, por processo) e corpo de até 6 MB. Respostas com `X-Robots-Tag: noindex`.
- **Proxy** (`src/proxy.ts`): `checklist/` e `api/publico/` saíram do `matcher`, porque o operador não tem sessão. Nada mais mora em `api/publico/`.
- **Arquivos:** bucket privado `checklist` (`<obra>/<inspeção>/<foto>.jpg` e `<obra>/<inspeção>/assinatura-<id>.png`). Assinatura e fotos viajam em base64 dentro do comando e sobem pelo servidor, antes das linhas; se a gravação falha, os arquivos enviados saem. O planejador confere tamanho e a assinatura do formato (JPEG/PNG). A tela pede as URLs assinadas de uma inspeção só quando ela é aberta (`GET /api/checklist/arquivos`). Excluir a inspeção e excluir a obra levam os arquivos.
- **QR e etiquetas:** `qrcode-generator` (dependência nova, sem serviço externo) desenha o QR em SVG no navegador (`src/modules/checklist/qr.tsx`). "QR do operador" na linha do equipamento mostra QR, endereço, copiar, imprimir e, para o admin, "Gerar novo link". `/imprimir/checklist/{obraId}` é a folha de etiquetas (todas as ativas, ou uma com `?equipamento=`). O segredo só chega a TST e admin: `GET /api/checklist` zera `publicToken` para os demais.
- **Componentes divididos** entre a tela logada e a do operador: `answer-list.tsx` (C / NC / N/A) e `run-fields.tsx` (quadro de assinatura e fotos).

### Validação de 12/11/2026

- `tests/checklist.test.ts`: 16 testes (6 novos: cadastro só admin; link novo e troca; registro pelo QR com arquivos na pasta da inspeção; recusas do link; edição mantendo e trocando assinatura e fotos; visão do operador).
- Sequência do `ci.yml` local: tipos, lint (sem erro), Prettier, 1.361 testes, validação das migrações (com a 0048) e build.
- Navegador (`next dev` com um Supabase falso em memória — tabelas do checklist e bucket — exercitando as rotas reais): o admin criou modelo e equipamento e abriu o QR; num contexto de celular (390 px, sem cookie) o link abriu, o formulário bloqueou o envio sem respostas, com um nome só e sem assinatura, aceitou foto e assinatura desenhada, e o envio gravou a inspeção (`source = 'link'`, `created_by = 'qr'`) com o PNG e o JPEG na pasta da inspeção; o histórico mostrou "pelo QR", a assinatura e a foto; a edição logada manteve os dois; "Gerar novo link" fez o endereço antigo responder "link inválido"; a folha de etiquetas renderizou. Pela API: TST recebe 403 em `save_equipment` e `save_model` e continua vendo o link; perfil de consulta recebe o equipamento sem o segredo. O `matcher` do proxy foi conferido caminho a caminho (só `/checklist/<token>` e `/api/publico/` ficam sem sessão).
- **Não validado:** gravação num banco real pelo sistema, envio real de arquivo ao Storage, leitura do QR impresso por um celular e a tela logada em produção.

## As três peças

- **Modelo** (`checklist_models`): a ficha. Nome, tipo de equipamento, periodicidade (`daily`, `weekly`,
  `monthly`) e a lista ordenada de itens (`items`, JSON `[{ id, text }]`, até 60). Lista única para todas
  as obras, como os tipos de apontamento da aba 6.
- **Equipamento** (`checklist_equipment`): o que existe na obra ("Betoneira 01"), de um tipo. Recebe os
  modelos ativos do mesmo tipo; a comparação ignora acento e maiúsculas (`checklistKey`). Desde 16/11/2026 o
  admin tira modelos do tipo e inclui modelos de outro tipo em cada equipamento ("Checklists do QR", 0052).
- **Inspeção** (`checklist_runs`): um modelo preenchido num equipamento num dia. `answers` guarda, por
  item, o texto como estava no dia, a resposta (`c`, `nc`, `na`) e a observação.

## O que a tela faz

`/obras/{obraId}/checklist`.

- **Cartões:** pendentes hoje, na semana e no mês, e checklists do período corrente com não conformidade.
- **Equipamentos da obra:** cada equipamento com os checklists do tipo dele — âmbar pendente no período,
  verde feito, vermelho feito com não conformidade. Clicar abre o formulário de inspeção. Abaixo, o
  cadastro de equipamentos; renomear, desativar e reativar.
- **Inspeção:** C / NC / N/A por item, descrição obrigatória no NC, "Marcar os demais como conforme",
  data (hoje por padrão) e observação geral.
- **Últimas inspeções:** as 30 mais recentes dos últimos 120 dias, com quem registrou, as respostas,
  edição e exclusão.
- **Modelos de checklist:** criar, editar (itens com ordem, colar vários de uma vez), desativar e reativar.

## Regras (`checklist-commands.ts`)

- Inspeções: o tipo TST (`profiles.tst`, migração 0040) e os admins (`canWriteChecklist`). Cadastro de
  modelos e equipamentos: só admins desde 12/11/2026 (`canManageChecklist`). Todos que têm a obra
  consultam: a seção `checklist` é aberta, como `seguranca`.
- Período: o dia; a semana de segunda a domingo; o mês (`periodKey`).
- Um modelo só é preenchido uma vez por equipamento por dia (regra e unicidade no banco).
- Sem data futura. Todos os itens respondidos. NC exige descrição.
- A edição da inspeção usa os itens que ela guardou; editar o modelo não reescreve o histórico. Na edição
  do modelo, o item que permanece mantém o id.
- Nome de modelo único (lista toda) e nome de equipamento único na obra, sem acento nem maiúsculas.
- Modelo e equipamento não são excluídos, são desativados. Só a inspeção é excluída.
- A API carrega as inspeções dos últimos 120 dias (`CHECKLIST_WINDOW_DAYS`); edição ou exclusão de uma
  mais antiga busca a linha à parte.

## Arquivos

- Domínio: `src/domain/equipment-checklist.ts`
- Regras: `src/application/use-cases/checklist-commands.ts`
- Banco: `supabase/migrations/0047_equipment_checklist.sql`, `0048_checklist_operator.sql`, `0052_checklist_equipment_models.sql`,
  `src/infrastructure/repositories/supabase/checklist-repository.ts`
- API: `src/app/api/checklist/route.ts`, `commands/route.ts`, `arquivos/route.ts` e a pública
  `src/app/api/publico/checklist/[token]/route.ts`
- Tela: `src/modules/checklist/`
- Manual e tour: `src/modules/agente/manual/checklist.ts`, `src/modules/tour/pages/checklist.ts`
- Testes: `tests/checklist.test.ts` (16) e a semente em `tests/delete-work.test.ts`

## Pendente

- **Local, liberação e aviso ao TST (17/11/2026):** conferir logado em produção, conferir um e-mail real de não conformidade e marcar os TSTs de cada obra (sem TST marcado, ninguém é avisado).
- **Cloudflare Access (17/11/2026):** a AIRON Labs respondeu no mesmo dia que liberou `/checklist/*`, `/api/publico/*`, `/_next/static/*` e os ícones, e que testou de fora sem login. Falta o teste da obra: ler um QR num celular sem login e enviar um checklist com foto. Avisar a AIRON Labs antes de criar outra rota em `/api/publico/` (tudo ali fica aberto à internet).
- **Checklists do QR (16/11/2026):** conferir logado em produção (marcar e desmarcar, ler o QR depois de salvar). A 0052 já está aplicada e o código foi enviado.

- **Publicar o código** (a 0048 já está aplicada). Marcar a responsável de SST como admin.
- Marcar os TSTs (mesma marcação da aba 6). A 0047 já está aplicada.
- Cadastrar os modelos com as fichas que a equipe de SST usa hoje, os equipamentos, e imprimir as etiquetas.
- Testar com um celular real: ler o QR impresso, fotografar, assinar e enviar.
- Não construído: foto presa a um item, modo sem internet, PDF da inspeção, abrir apontamento na aba 6 a partir
  de uma não conformidade, checklist no dashboard e na assistente (relatórios), histórico além de 120 dias
  na tela.

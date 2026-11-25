# Planejamento em três níveis

## Para que serve este documento

Continuidade entre os modelos de IA que trabalham no repositório, no que toca longo, médio e curto prazo — o equivalente ao que `docs/ifc-federacao.md` faz para IFC e federação. A cada alteração nesses três níveis, atualizar aqui: comportamento entregue, decisões, arquivos, migrações, validação e pendências. Não descrever intenção como funcionalidade pronta.

## Diagnóstico de 19/09/2026

Os três níveis são **três planilhas independentes que não conversam**. Cada uma tem o seu modelo de dado:

| Nível | Modelo | Origem do dado |
| --- | --- | --- |
| Longo prazo | `Activity` em vagões | importada do Prevision, fatiada por vagão |
| Médio prazo | `PlanTask` (plano do mês) + Look Ahead sobre `Activity` | escrita à mão; a janela é calculada |
| Curto prazo | `WeeklyCommitment` | escrita à mão, sem depender de nada |

O único fio entre eles é um `activityId` opcional que quase nunca é preenchido. A consequência: o sistema não dizia se o plano do mês cobre o que a janela anuncia, se a semana corresponde ao mês, nem se o que falhou na semana mudou alguma coisa acima. Cada tela é uma boa planilha — e planilha o Sheets já fazia. O que só um sistema faz é levar informação de um nível para o outro.

**Independência de preenchimento não é ausência de rastro.** O curto prazo se sustentar sozinho é decisão do usuário e continua valendo: a conferência entre níveis sugere e reconcilia, nunca exige, nunca bloqueia, nunca cria linha sozinha.

## Etapa 1 — fechar o ciclo do que já era coletado (19/09/2026)

### Regras novas, em `src/domain/rules.ts`

- `ppcSeries(commitments)` — o PPC semana a semana. O valor de uma semana isolada diz pouco; o Last Planner usa a série.
- `causePareto(commitments)` — as 17 causas em ordem de peso, com participação e acumulado **sobre as falhas**. Antes as causas eram coletadas e não eram lidas em lugar nenhum.
- `plannedAt(items, date)`, `executedAt(activities, entries, date)`, `progressCurve({...})` — a curva S. O planejado assume avanço linear de cada frente entre início e término: é aproximação declarada, e a alternativa seria inventar uma curva de produção que ninguém mediu. O executado não é aproximado, sai do lançamento datado. A referência do planejado é a linha de base quando houver — comparar o executado com um planejamento já reprogramado é comparar a obra com a desculpa dela.

### Correção de comportamento

`teamLoad` contava apenas `Activity.teamId` e ignorava o recurso das linhas do plano do mês. Quem planejava na grade nova via "dentro da capacidade" com o mês estourado. Passa a somar os dois e a devolver a separação (`activities`, `tasks`); linha de base congelada não entra na conta, porque retrato não é compromisso.

### Telas

- **Curto prazo** (`src/modules/curto-prazo/commitments-overview.tsx`): fechamento da semana abaixo da planilha — série do PPC, Pareto das causas, arrasto do não cumprido para a semana seguinte e geração de pendência a partir da falha. A linha original do "Não" permanece: ela é o registro do que aconteceu.
- **Longo prazo** (`src/modules/longo-prazo/s-curve.tsx`): curva de avanço acumulado, planejado contra executado, com desvio em pontos percentuais. O executado para em hoje; prolongá-lo inventaria medição.
- **Médio prazo** (`src/modules/medio-prazo/look-ahead-overview.tsx`): a lista da janela de três meses (antes eram só quatro cartões de número) e a conferência de cobertura entre níveis.

### Pareamento por nome

A conferência de cobertura casa frentes **por nome normalizado**, não por vínculo: `PlanTask.activityId` e `WeeklyCommitment.activityId` são opcionais e quase nunca preenchidos. É a mesma estratégia que a comparação do plano do mês com a sua linha de base já usa. É conferência, não vínculo, e erra quando o nome muda entre níveis — a tela diz isso.

## Etapa 2 — a grade do plano do mês no padrão Project (20/09/2026)

Referência: o guia de usabilidade de cronograma trazido pelo usuário, de sistema já consolidado. Ele foi adotado como padrão desta grade; o que segue diz o que foi implementado e o que ficou fora, de propósito.

### Vínculos nos quatro tipos, com defasagem

Havia só um par predecessora/sucessora, e a coerência era conferida como se todo vínculo fosse Término-Início. Isso descreve mal a obra: a alvenaria do 5º não espera a do 4º terminar para começar — ela começa alguns dias depois de a outra começar, que é Início-Início com defasagem, e é assim que a equipe sobe o prédio. Quem só tinha TI ou mentia a data ou não usava o vínculo.

- `PlanDependency` ganhou `type` (TI/II/TT/IT), `lagDays` e `lagBusiness`. Migração `0022_plan_link_types.sql`, que reescreve `commit_planning` por causa das três colunas. Os padrões descrevem o que já estava gravado: todo vínculo existente é TI sem defasagem.
- `parseLinks` e `formatLink` leem e escrevem a sintaxe do Project (`12`, `12II+2d`, `12TT-1d`, `12TI+2dd`). O número é a **posição na lista**, não o número hierárquico — o hierárquico muda a cada recuo e a referência apontaria para outra linha.
- `lagBusiness` separa `2d` de `2dd`: dois dias úteis e dois corridos caem em datas diferentes quando o intervalo atravessa um fim de semana.
- `linkBoundary` dá a data mais cedo que cada tipo permite e qual ponta ele prende; `linkConflicts` aponta os vínculos desrespeitados. **Apontar não é reprogramar** — ver a decisão em aberto abaixo.

### Percentual-alvo

`targetPercent` devolve quanto do tempo útil planejado já passou na data de referência. É leitura de **tempo**, não medição física, e a tela precisa dizer isso: confundir os dois numa obra é grave, porque vira um avanço que ninguém mediu.

### Na grade

Cadeado (a grade abre bloqueada, contra alteração acidental em reunião), recolher e expandir item de resumo, teclado no padrão do Project (F2, Esc, Enter desce, setas), predecessoras com tipo e defasagem, incoerência apontada por tipo de vínculo, e as colunas calculadas de % alvo, desvio, término da base e variação em dias.

### Decisões em aberto — precisam do usuário

1. *(Resolvida em 25/09/2026 — ver etapa 4: o usuário escolheu o agendamento automático.)* **Reprogramação automática (ASAP).** O guia exige datas, duração e predecessoras ligadas por um motor único (secao 7.1). Hoje as datas não se movem sozinhas: a rede aponta a incoerência e a reprogramação é manual — decisão anterior do próprio usuário, e não a desfiz sozinho. Ligar o motor muda datas na tela de quem planeja, e é a mudança de maior impacto do guia inteiro.
2. *(Resolvida: o rascunho com "Revisar e salvar" e motivo obrigatório foi implementado depois desta etapa, e o usuário confirmou em 25/09/2026 que quer mantê-lo.)* **Rascunho com gravação atômica e motivo obrigatório** (secao 12). Hoje cada célula grava ao sair dela, o que o usuário pediu explicitamente. O guia quer rascunho local, revisão antes de salvar e motivo por revisão. A concorrência otimista já existe, mas no nível do snapshot inteiro (`planning_meta.version`), não por tarefa, e o histórico é por comando, sem motivo.

### Do guia, ainda não implementado

Colunas configuráveis e redimensionáveis, seleção de intervalo com copiar/colar e preencher para baixo, desfazer/refazer, filtros, modo reunião, calendário de feriados e jornada, e duração em horas ou meses. Nada disso foi tentado pela metade.

## Pendências

- **Rede de atividades sem porta de entrada.** Os comandos `link_activities`/`unlink_activities`, a regra `dependencyConflicts` e a tabela `activity_dependencies` (migração 0010) existem, mas **nenhuma tela cria ou mostra** essas ligações. O plano do mês tem a sua própria rede, essa sim com tela. Decidir com o usuário: dar interface à rede das atividades do cronograma ou remover o caminho morto. Nada foi apagado por enquanto.
- O executado alimenta o sistema só pela tela do vagão (`record_progress`). Médio e curto prazo não lançam avanço físico, então a medição vive num lugar e o planejamento em outros dois.
- A ordem dos locais na Linha de Balanço sai de um interpretador de nomes do Prevision (`height`, em `line-of-balance.tsx`). Um campo próprio de cota/ordem no local seria mais firme.
- Não há curva por serviço nem desvio por frente em dias — a curva S é da obra inteira.

## Migrações

A etapa 1 não precisou de nenhuma: era cálculo sobre o que já estava gravado. A etapa 2 traz `0022_plan_link_types.sql`, que acrescenta tipo e defasagem ao vínculo do plano e reescreve `commit_planning`. **Precisa ser aplicada antes de o código correspondente subir**: sem ela, tipo e defasagem são descartados em silêncio a cada gravação.

## Etapa 3 — redesenho em seis abas (23/09/2026)

O sistema passou a se chamar **Sistema de Gestão de Projetos – ATR** e a navegação da obra virou seis abas numeradas na lateral (`WORK_TABS` em `src/modules/layout/work-nav.tsx`): 1 Cronograma de longo prazo, 2 Planejamento por vagões, 3 Cronograma de médio prazo, 4 Cronograma de curto prazo, 5 Modelo federado, 6 BIM 4D. Arquivos IFC, Dívidas, Integrações e Configurações da obra ficaram num grupo **Apoio** abaixo das abas, por escolha do usuário. No celular, as abas viram uma faixa rolável (`WorkTabsMobile`). O cabeçalho comum das abas está em `src/modules/layout/tab-header.tsx`, e abrir uma obra leva à aba 1. Um documento de orçamento integrado ao IFC (EAP e composições) foi apresentado junto do pedido, e o usuário decidiu deixá-lo fora do escopo.

### Aba 1 — longo prazo

A ordem da tela mudou para Linha de Balanço → módulo de restrições → curva de avanço → linhas de base. O quadro antes chamado "Pendências" passou a se chamar **Módulo de restrições**. A entidade sempre foi `Restriction`, e "pendência" continua designando o item de terminalidade do vagão (`PendingItem`): usar a mesma palavra para as duas coisas confundia. Nenhum comando nem dado mudou.

### Aba 3 — alocação de recursos e atrasos contra a linha de base

Regras novas, puras, em `src/domain/schedule-analysis.ts` (testes em `tests/schedule-analysis.test.ts`):

- `weeklyTeamLoad(data, workId, from, to)`: carga semana a semana (semanas começando na segunda) por equipe. Soma as atividades do cronograma e as tarefas **não resumo** dos planos vivos, contra `weeklyCapacity`. Plano congelado ou linha de base não conta, pelo mesmo motivo do `teamLoad`: retrato não é compromisso. Cada semana devolve os itens que a compõem, para a tela mostrar quem causa a superalocação. Uma linha "sem equipe" aparece só como informação.
- `baselineVariance(live, baseline, calendar)`: variação de início e término em **dias úteis do calendário do plano**, com sinal positivo para atraso. O pareamento usa primeiro `sourceTaskId` e depois o nome normalizado. Cada tarefa sai com o status atrasada/adiantada/no prazo, conforme o término, ou como nova/removida. O resumo traz a quantidade de atrasadas, o maior atraso, o atraso médio e a variação do término do plano.

Telas novas, montadas abaixo da grade em `medio-prazo/page.tsx`:

- `ResourceAnalysis`: grade equipes × semanas colorida por carga/capacidade, com texto e ícone além da cor. Um clique na célula lista os itens da semana, e o histograma da equipe escolhida traz a linha de capacidade. O período é o mês de um plano vivo ou as próximas 12 semanas.
- `BaselineDelays`: escolha do plano e de uma das suas linhas de base congeladas, com indicadores, comparação em barras (atual × base) das tarefas atrasadas e tabela completa de variações.

Premissas declaradas: atividade concluída continua contando carga, igual ao `teamLoad`. Tarefa que começa atrasada e termina no prazo conta como "no prazo", mas o Δ de início aparece. Linhas de resumo ficam fora da análise de atrasos.

**Validação:** 9 testes novos passando. As telas não foram abertas logadas no navegador.

### Pendências desta etapa

- Validar no navegador, com dados reais, a grade de carga e a comparação com a linha de base.
- A capacidade continua sendo "atividades simultâneas por semana". Um histograma em homens-hora exigiria cadastrar quantidade de pessoas e produtividade, o que não existe hoje.

### Migração 0023 — aplicada

`0023_plan_revisions.sql` veio do trabalho de 22/09 sobre as revisões do plano do mês. Ela acrescenta `schedule_meta` a `medium_term_plans` e `plan_tasks`, cria gatilhos que tornam imutáveis a linha de base congelada e o `history_events`, e reescreve `commit_planning`. O usuário a **aplicou no Supabase remoto em 23/09/2026**. A presença das colunas foi conferida pela API REST, com resposta 200 nas duas tabelas. A migração não é reexecutável, porque cria as funções `guard_*` e os gatilhos sem `or replace`/`if not exists`. Se for preciso rodá-la de novo em outro ambiente, é necessário remover antes os gatilhos e as funções.

### Aba 1 — longo prazo como leitura do Prevision (23/09/2026)

A pedido do usuário, a aba 1 passou a dizer, na descrição e num aviso logo abaixo do título, que o cronograma de longo prazo **por enquanto é mantido apenas no Prevision**. A tela serve para consultar esses dados e criar e acompanhar restrições. As atividades chegam pela importação em Integrações. Linhas de base e curva de avanço continuam disponíveis, mas não substituem a edição do cronograma, que não é feita aqui.

### Nome do sistema: Obra 360 (23/09/2026)

O usuário escolheu o nome **Obra 360** para substituir "Sistema de Gestão de Projetos – ATR". O novo nome aparece na lateral, com o subtítulo "Gestão de projetos e obras", no cabeçalho do celular, no login, no título da aba do navegador (`Obra 360 · ATR`) e no tour. A troca foi só de texto na tela. O **endereço do site** (projeto `planejamento-de-vagao` na Vercel), o **repositório** e o `package.json` não mudaram. Mudar o endereço exige atualizar o Site URL e as Redirect URLs no Supabase. A recomendação é fazer isso junto com um domínio próprio.

## Etapa 4 — planejador de longo prazo: fluxograma que se expande em Linha de Balanço (25/09/2026)

A pedido do usuário, a aba 1 ganhou uma ferramenta para **preencher** o planejamento de longo prazo no próprio sistema. Ela reproduz o "Planejamento de Longo Prazo" do App-ATR (`~/Applications/App-ATR`), criado entre 13 e 20/05/2026 e removido em 08/07/2026 no commit `10995b7` ("Remove módulos LOB, Restrições e PMP"). A documentação daquela ferramenta é o histórico do Git: `git show 10995b7^:src/app/dashboard/planejamento-longo-prazo/PlanejamentoLongoPrazoClient.tsx` (2.197 linhas) e `git show 10995b7^:src/lib/data/planejamento-lp.ts`. O repositório não tinha documento escrito, e esses dois arquivos foram a fonte da reprodução. Lá o plano ficava no Redis (Upstash) como um JSON por projeto.

### O que a aba 1 mostra agora

A aba tem duas visões, alternadas no cabeçalho, e o endereço guarda a escolhida em `?visao=`:

- **Planejador** (padrão, `src/modules/longo-prazo/planner/`): o cronograma de longo prazo é montado aqui.
- **Vagões e restrições** (`?visao=prevision`, chamada "Prevision e restrições" na primeira versão do dia): a tela anterior. Mostra a Linha de Balanço das atividades dos vagões, o módulo de restrições, a curva de avanço e as linhas de base dos vagões. O aviso diz que essas atividades são só leitura aqui e que quem responde por elas é o plano.

### O modelo do plano (igual ao original)

Cada **serviço** percorre uma faixa contínua de pavimentos, do inicial ao final, e tem:

- uma **duração por pavimento**, em dias corridos, com a opção de duração própria em alguns pavimentos;
- um **ritmo**: dias entre o início de um pavimento e o início do seguinte (0 = todos juntos);
- **predecessoras**, cada uma com espera em dias (negativa = antecipação) e dois modos:
  - **cruzamento automático**: em cada pavimento que os dois serviços têm em comum, o sucessor só começa depois que a predecessora terminou ali;
  - **pavimento específico**: o sucessor começa no seu primeiro pavimento depois que a predecessora termina aquele pavimento.
- **equipes**, com nome e número de pessoas;
- **unidade de medição** (%, apartamento, m², m, unidade ou outra) e total previsto.

A obra tem um número de pavimentos, e cada um pode ter um nome ("Térreo", "Cobertura"). O botão "Usar os locais da obra" preenche esses nomes com os locais importados do Prevision, em ordem de altura (`height`/`byHeight`, agora exportados por `line-of-balance.tsx`). Fachadas, halls e equipamentos ficam de fora, porque não têm altura.

### Telas do planejador

- **Fluxograma** (`plan-canvas.tsx`): diagrama de rede AON. Cada coluna é um nível de precedência, cada cartão é um serviço e as setas são as predecessoras, com a espera e o pavimento de referência escritos na seta. Cada cartão traz uma miniatura da Linha de Balanço do serviço e pode ser expandido no lugar, mostrando os pavimentos com início e término.
- **Expandir em Linha de Balanço**: a obra inteira passa para a Linha de Balanço, e cada retângulo de pavimento sai da miniatura do cartão e anima até a sua posição no gráfico (tempo × pavimento). Com `prefers-reduced-motion` a troca é instantânea. Na Linha de Balanço há zoom, linha de hoje, sobreposição cinza da linha de base escolhida e barra de avanço medido por pavimento. Arrastar um serviço o reprograma: a data nunca fica antes do mínimo das predecessoras, e as sucessoras são empurradas.
- **Indicadores**: serviços, pavimentos, prazo planejado em meses (com a diferença para a linha de base) e avanço físico.
- **Resumo dos serviços**: tabela expansível por pavimento, com botão de ocultar e mostrar.
- **Alocação de equipes**: pico diário de pessoas por equipe em cada semana.
- **Formulário do serviço** (`activity-form.tsx`), **pavimentos**, **linhas de base** e **medições** (`plan-panels.tsx`).
- **Exportar e importar** em JSON. A importação também aceita o `.plp.json` exportado pela ferramenta antiga (`fromLegacyProject`), que converte as chaves em português e a predecessora única dos arquivos mais antigos.
- Plano vazio oferece um **exemplo de edifício** encadeado (`examplePlanDocument`), para partir de algo e ajustar.

### Onde o dado fica — decisão

O plano é **um documento JSON por obra**, na tabela `long_term_plans` (migração `0024_long_term_plans.sql`), lido e gravado por `GET/PUT /api/long-term-plan` (`src/app/api/long-term-plan/route.ts`). Ele fica **fora do snapshot de planejamento** e não passa por `commit_planning`, como `ifc_federations`. Motivos:

- O original já era um documento único.
- O plano é editado como um todo: arrastar um serviço reprograma a cadeia inteira.
- Uma migração ausente ou um plano com problema não derruba as outras telas, porque o snapshot lê todas as tabelas em cada requisição.

Consequências dessa escolha:

- O plano e as `Activity` dos vagões são registros distintos, ligados pela geração de vagões (seção seguinte). Editar o plano não muda os vagões sozinho.
- **Não há histórico campo a campo** (`history_events`). Ficam registrados só a última gravação (`updated_at`, `updated_by`) e as linhas de base, que são fotos do plano.
- **Concorrência**: cada gravação envia a `revision` lida, e o servidor só grava se ela ainda for a do banco. Se outra pessoa salvou no meio tempo, a resposta é 409, a tela fica só leitura e oferece recarregar. Assim nenhuma edição é apagada em silêncio.
- **Salvamento automático** 1 s depois da última alteração, como no original. Fechar a aba com alteração pendente faz o navegador perguntar antes.
- Perfil **Consulta** vê tudo e não altera nada, e a API recusa a gravação.

### Diferenças em relação ao original — correções

Regras em `src/domain/long-term-plan.ts`, com testes em `tests/long-term-plan.test.ts`:

- **Cruzamento automático exato.** O original olhava só o primeiro ou o último pavimento. Com duração própria num pavimento do meio, ou com faixas de pavimentos diferentes, a sucessora podia cruzar a predecessora. Agora a regra confere todos os pavimentos em comum. Sem pavimento em comum, vale término-início do serviço inteiro.
- **Fim do serviço** é o do pavimento que termina por último. O original usava a duração padrão do último pavimento e ignorava as durações próprias. O mesmo vale para a alocação de equipes, que no original também ignorava a duração por pavimento.
- **Término mostrado é o último dia trabalhado.** O original exibia o dia seguinte: 5 dias a partir de segunda apareciam terminando no sábado.
- **Reprogramação em ordem topológica.** O original fazia várias passadas sem ordem. **Ciclo de predecessoras** agora é impedido: o formulário não oferece as opções que fechariam um ciclo, e a API recusa.
- **Avanço físico ponderado** pelos pavimento-dias de cada serviço. Serviço com unidade e ainda sem medição conta como 0%. O original fazia média simples só dos serviços já medidos, o que inflava o avanço no começo da obra.
- A unidade de medição fica **travada** depois da primeira medição do serviço. No original isso estava pela metade (`temMedicoes = false`).
- Excluir um serviço remove também os vínculos que apontavam para ele e as medições dele.

### O que ficou de fora

- **Restrições criadas no formulário do serviço.** O original tinha um quadro de restrições próprio. Aqui a `Restriction` depende de um vagão, e o serviço do planejador não tem vagão. As restrições continuam na visão "Prevision e restrições".
- **Vários projetos por obra.** O original tinha uma lista de projetos. Aqui é um plano por obra, e as linhas de base guardam as versões.
- Dias úteis e feriados: o macro é em dias corridos, como no original.

### Migração 0024 — aplicada em 25/09/2026

`0024_long_term_plans.sql` cria `long_term_plans` com `work_id` como chave, `document` jsonb, `revision`, `updated_at` e `updated_by`, e liga o RLS sem política: o acesso é só pela API, com a chave de serviço, como nas tabelas IFC. **Não reescreve `commit_planning`** e pode ser rodada de novo (`if not exists`). O usuário a aplicou no Supabase remoto em 25/09/2026; a tabela responde pela API REST.

### Validação (25/09/2026)

- `npx tsc --noEmit`: sem erros. `npm test`: 249 testes passando, 15 deles novos, em `tests/long-term-plan.test.ts`. Os testes cobrem o cálculo por pavimento, o cruzamento exato, a predecessora por pavimento, a cascata e o "Recalcular", os níveis do fluxograma, o ciclo, a validação, o pico de equipe, o avanço ponderado, o plano de exemplo e a conversão do `.plp.json` antigo.
- **Navegador** (Playwright sobre o `next dev` local, com o acesso sem login de `DEV_AUTH_BYPASS_PROFILE_ID`, na obra Brizz Smart Stay). Como a `0024` ainda não existe no banco, a API do plano foi **simulada** no navegador. O que foi conferido:
  - o fluxograma com setas e rótulos de espera e pavimento;
  - a animação fluxograma → Linha de Balanço e a volta;
  - o cartão expandido nos pavimentos;
  - o cadastro de um serviço com predecessora, gravado com o vínculo;
  - o arraste da Estrutura, que empurrou a Alvenaria os mesmos 19 dias e gravou com a revisão seguinte;
  - o plano vazio com "exemplo de edifício";
  - os painéis de pavimentos, linhas de base e medições;
  - a visão "Prevision e restrições".
  
  Nenhum erro apareceu no console. Na primeira rodada os rótulos de todos os serviços caíam no mesmo pavimento e se sobrepunham. Isso foi corrigido: cada serviço desloca o rótulo três pavimentos.
- **API de verdade, sem a migração:** o GET responde "Aplique a migração 0024_long_term_plans.sql…". O PUT com pavimento fora da obra é recusado com a mensagem da validação.
- **Não validado:** gravação real no Supabase, dois usuários salvando ao mesmo tempo (o 409), celular, e um plano grande (400 serviços × 60 pavimentos). No último caso as camadas esmaecidas continuam no DOM, e com linha de base são cerca de 48 mil retângulos.

### O plano é o responsável pelas atividades dos vagões (25/09/2026)

Decisão do usuário, no mesmo dia: **o plano de longo prazo responde pelas atividades dos vagões**. O botão **"Gerar vagões"** no Planejador (`planner/wagon-sync.tsx`) leva o plano salvo para uma sequência de vagões da obra, ou cria uma se a obra ainda não tem.

**Como funciona** (`src/application/use-cases/sync-long-term-plan.ts`, comando `sync_long_term_plan` em `commands.ts`, rota `POST /api/long-term-plan/sync`):

- Cada serviço × pavimento do plano vira atividade de vagão, com o pavimento como local, criado se ainda não existir. Entram todos os serviços, inclusive os ocultos no gráfico, porque ocultar é só leitura.
- **Vagões liberados não mudam.** O plano ocupa só a cauda não liberada, a partir do dia seguinte ao último vagão liberado, ou de hoje / do início da sequência, o que vier mais tarde. O que termina antes dessa fronteira fica fora, e a prévia informa quantos.
- A cauda vira uma **grade contínua** de vagões com o takt da sequência. Em dias úteis, cada vagão vai de segunda a domingo e conta só os dias úteis como takt; sem essa continuidade, o fatiamento recusaria as atividades. Cada serviço × pavimento é fatiado nos vagões que atravessa pelo mesmo `sliceActivity` da importação do Prevision ("parte 2 de 3 · 35%", peso proporcional). Vagão da grade sem atividade não é criado.
- **Idempotente.** Vagão que começa no mesmo dia de um vagão da cauda reaproveita o registro, com as restrições e pendências dele. Atividade com a mesma chave `plano:<serviço>:<pavimento>#<parte>@<início do vagão>` reaproveita o registro, com avanço, critérios, equipe e anotação. Gerar de novo sem mudar o plano não perde nada; um teste garante isso.
- O que sai é sempre mostrado na prévia antes de confirmar: vagões da cauda que não voltam, e junto deles restrições e pendências; atividades que o plano não gera mais, e quantas tinham avanço ou critério atendido; atividades do Prevision ou de demonstração na cauda, que são substituídas. Atividade **manual** sobrevive se o vagão dela continua e ela ainda cabe no período.
- A equipe da atividade é preenchida quando o nome de uma equipe do plano coincide com uma equipe cadastrada na obra.
- A rota lê o plano **salvo** no banco, nunca o que o navegador mandar, e exige a revisão que a tela mostra (409 se mudou). A rota genérica `/api/planning/commands` recusa `sync_long_term_plan`.
- Depois de gerar, `long_term_plans` guarda a revisão, a sequência, a data e o autor. O Planejador avisa quando o plano mudou depois da última geração.
- **Prevision:** a sincronização em Integrações continua atualizando o cache de leitura, mas **não regenera** sequência que já tem atividade de origem `long_term`. Regenerar ali apagaria a cauda montada pelo plano.
- Origem nova `Activity.origin = 'long_term'`, com rótulo "Plano de longo prazo" no detalhe do vagão.

**Migração 0026** (`0026_long_term_wagons.sql`) — **aplicada pelo usuário em 25/09/2026.** Ela acrescenta `synced_revision`, `synced_sequence_id`, `synced_at` e `synced_by` a `long_term_plans` e alarga a checagem `activities_origin_check` para aceitar `long_term`. Não reescreve `commit_planning`. Ficou separada da 0024 porque a 0024 já tinha sido aplicada quando a decisão veio. As colunas novas foram conferidas pela API REST (resposta 200).

**Validação:** 6 testes novos em `tests/long-term-sync.test.ts` cobrem a geração encadeada, os pesos somando 1 por serviço × pavimento, a idempotência com avanço e restrição preservados, o adiamento que troca vagões, o vagão liberado intocado com a cauda começando no dia seguinte, a grade em dias úteis e o bloqueio na rota genérica. No navegador, o diálogo foi conferido com a API simulada: prévia, confirmação e aviso de "vagões em dia". **Não foi rodada nenhuma geração real no Supabase:** a primeira deve ser feita pelo usuário, conferindo a prévia. Na obra Brizz Smart Stay, a sequência "Planejamento principal" tem takt de 21 dias e atividades do Prevision na cauda, que seriam substituídas pelas do plano.

### Pendências

- Primeira geração real de vagões, conferindo a prévia.
- O médio prazo e o 4D leem as atividades dos vagões; passam a refletir o plano só depois de gerar os vagões.
- Restrições ligadas a serviço e pavimento do planejador.
- Histórico de alterações do plano.

## Curto prazo com a cara da planilha (25/09/2026)

O usuário pediu que a aba 4 ficasse mais parecida com a planilha do Google Sheets usada hoje, com o mesmo efeito de lista suspensa para empresas, semanas, status e causas. Decisões tomadas com ele:

- **Empresa:** lista suspensa com as empresas do cadastro e as já digitadas na planilha, sem repetir grafias equivalentes (`companyOptions`). Aceita digitar uma empresa nova, que passa a aparecer na lista.
- **Equipe:** lista filtrada pela empresa da linha. Um nome novo cria a equipe no cadastro daquela empresa (`create_team`), com capacidade 3 (`NEW_TEAM_CAPACITY`) como ponto de partida, ajustável em Configurações. Trocar a empresa de uma linha desfaz a equipe de outra empresa.
- **Semana:** lista da primeira semana da obra até 4 semanas depois da atual (`weekOptions`), no formato "número · início". Vale para a coluna e para o "Semana analisada".
- **Status:** pílula verde (Sim) ou vermelha (Não).
- **Causas:** a lista fica travada até o Status ser Não, e então é obrigatória. Escolher Não sem causa não grava nada: a linha fica marcada e um aviso aparece no topo. O apontamento é gravado quando a causa é escolhida, porque `record_fulfillment` exige a causa. **Correção de comportamento:** antes, a tela mandava a primeira causa da lista automaticamente, gerando causa falsa no Pareto.
- **Filtros:** funil em todas as colunas, como no Sheets, com classificação A→Z/Z→A, busca e marcação de valores. A classificação de datas usa a data, não o texto "dd/mm". Filtro e classificação não alteram o PPC, que continua sendo da semana inteira.
- **Ordem padrão:** por empresa e, dentro dela, por início, como na planilha de origem.
- **Aparência:** manteve o estilo do Obra 360, por escolha do usuário, sem a faixa azul do Sheets.
- **Vocabulário:** "Gerar pendência" virou **Gerar restrição**, alinhado ao módulo de restrições da aba 1.

Arquivos: `src/modules/curto-prazo/sheet-controls.tsx` (`PillSelect`, `PillCombo` e `ColumnFilter`; os popovers ficam num portal com `data-sheet-popover`) e `src/modules/curto-prazo/sheet-view.ts` (filtro, ordem, semanas e empresas). Os testes estão em `tests/sheet-view.test.ts` (8) e `tests/sheet-controls.test.ts` (4).

**Validação:** a tela foi aberta num Chrome controlado por script, pelo acesso local sem login, com linhas de exemplo injetadas só no navegador: nenhum dado foi gravado. Foram conferidos as pílulas, o Não aguardando causa, o funil de Empresa e a criação de equipe filtrada pela empresa, sem erros no console. A gravação real de cada lista ainda não foi exercitada, porque exigiria escrever no banco de produção.

**Resolvido em seguida (ver "Semana 1 de cada obra"):** a numeração da semana era contada a partir da primeira semana com linha na obra (em obra nova, a atual é a 1). A planilha de origem usa outra origem (ex.: 113). Falta decidir se o número deve seguir a contagem da planilha.

## Etapa 4 — o médio prazo no layout do MS Project (25/09/2026)

O usuário pediu que a aba 3 ficasse mais parecida com o MS Project, que é onde a equipe faz o médio prazo hoje, e mandou um print da tela do Project que usam (Gantt de acompanhamento da obra MZN). As decisões foram tomadas com ele antes de codar:

| Pergunta | Decisão |
| --- | --- |
| O que mais faz falta | Tabela e Gantt lado a lado; datas que se recalculam. Caminho crítico e arrastar barras **não** foram pedidos. |
| Reprogramação | Automática, como o Project. Data digitada = "Não iniciar antes de". |
| Origem do plano | Digitado direto no sistema (sem importar XML do Project). |
| Período | **Um cronograma por mês**, cada um com **horizonte de três meses**. O usuário chegou a responder "janela móvel" e se corrigiu. Revisto em 16/11/2026: o mesmo mês pode ter mais de um cronograma (seção daquela data). |
| Mês seguinte | Nasce como **cópia do mês anterior**. |
| Linha de base | Quando o usuário clicar, como no Project. |
| Datas reais | Como no Project: % > 0 preenche o início real, 100% preenche o término real, e a data real prende a tarefa. |
| Gravação | Mantém rascunho + "Revisar e salvar" com motivo obrigatório. |
| Visual | Layout do Project, visual do Obra 360 (sem faixa de opções nem azul do Project). |

### Tela (`src/modules/medio-prazo/schedule-sheet.tsx` + `gantt-chart.tsx`)

- **Tabela e Gantt lado a lado**, com divisória arrastável e a mesma rolagem vertical. Modos "Tabela e Gantt", "Somente tabela" e "Somente Gantt" e escala Dias/Semanas/Meses ficam na barra de status, como no Project. O Gantt se alinha à tabela **medindo** a altura da linha e do cabeçalho (ResizeObserver), não por constante.
- **Colunas do print**, nesta ordem: Id, Indicadores, % concluída, Nome da tarefa (com EAP 1.1 e recolher), Duração ("10 dias", "10 dias corridos", "0 dias"), Início real, Término real, Início, Término, Início e Término da linha de base, Predecessoras ("18;19", "27TI+6 dias") e Nomes dos recursos. Anotações, % alvo, Desvio, Decorrido e Variação continuam disponíveis em "Colunas", ocultas por padrão. Datas no formato "Seg 24/08/26", com "ND" onde não há data. A entrada aceita o mesmo texto copiado do Project.
- **Linha 0**: resumo do cronograma inteiro (envelope das datas, % ponderado pela duração).
- **Indicadores**: concluída, "Não iniciar antes de" (só quando é a restrição, e não a rede, que segura o início), fora do horizonte e anotação. Cada um tem ícone e texto, nunca só cor.
- **Gantt de acompanhamento** (`gantt-chart.tsx`, componente só de apresentação):
  - barra azul com o avanço preenchido e, com linha de base escolhida, barra cinza embaixo;
  - resumo como colchete preto e marco como losango com "dd/mm";
  - setas com cotovelo nos quatro tipos de vínculo;
  - linha verde de hoje, tracejado no início e no fim do horizonte, sombra fora do horizonte e nos dias não úteis;
  - clique na barra seleciona a linha na tabela.
  As funções de layout são puras e testadas em `tests/gantt-chart.test.ts`.
- **Ferramentas e teclado do Project**: Inserir tarefa acima da selecionada (Insert), recuar e diminuir o recuo (Alt+Shift+→/←), Vincular as selecionadas em TI (Ctrl+F2), Desvincular (Ctrl+Shift+F2) e Excluir. Mantidos: cadeado, desfazer e refazer, Ctrl+D, copiar e colar, filtros e modo reunião. Recuar uma linha que vira resumo tira dela os vínculos e as datas reais, que passam a ficar nas subtarefas. *(Revisto em 16/11/2026: os vínculos ficam no resumo, menos os que passariam a ligá-lo às próprias subtarefas e os TT/IT que chegam nele; ver "Vínculo com resumo".)*
- **Horizonte**: o cabeçalho mostra "Horizonte de três meses: Ter 01/09/26 a Seg 30/11/26". Tarefas fora dele recebem indicador e aviso e têm o filtro "Fora do horizonte". São sinalizadas, **não bloqueadas**, porque a rede pode empurrar uma tarefa para fora.
- **Novo cronograma do mês**: o mês seguinte ao último vem sugerido, junto com "Cópia de ‹mês›" ou "Em branco".
- **Linha de base**: a mais recente aparece por padrão (o Project mostra a base sempre).
- **Plano gravado antes desta etapa**: ao abrir, a tela aplica a regra nova. Tarefa com % e sem início real recebe o início previsto, e o "Não iniciar antes de" passa a valer junto das predecessoras. Um aviso azul diz quantas linhas mudaram. O ajuste vai ao banco no próximo "Revisar e salvar", e o diálogo de revisão também o menciona. Sem isso, o servidor recusaria a gravação.
- Removido `src/modules/medio-prazo/gantt.tsx`: a grade antiga, sem uso desde a etapa 2. O passo "medio-gantt" do tour apontava para ela e estava quebrado; agora aponta para a tela nova, e os textos do tour foram reescritos.
- Corrigido no caminho: começar a digitar direto numa célula selecionava a primeira letra, e a segunda a apagava.

### Domínio e servidor

- `PlanTask.actualStart`/`actualEnd` e `MediumTermPlan.copiedFromPlanId`, gravados em `schedule_meta` (jsonb criado na 0023). **Nenhuma migração nova.**
- `scheduleTasks` (`src/domain/plan-schedule.ts`):
  - com data real, o início é o início real e o término é o término real, e a rede não move a tarefa;
  - sem data real, o início é o **mais tarde** entre `anchorStart` ("Não iniciar antes de") e os limites das predecessoras. Antes, `anchorStart` era ignorado quando havia predecessora;
  - **marco** (duração 0) tem início = término e, ligado por TI, fica no dia em que a predecessora termina, como no Project. A tarefa depois dele começa no dia útil seguinte.
- `withProgress`, `withActualStart` e `withActualEnd` aplicam as regras do Project entre % e datas reais:
  - 0% apaga as datas reais;
  - % acima de 0 preenche o início real;
  - 100% preenche o término real;
  - término real põe a tarefa em 100% e recalcula a duração.
  Limpar o término real com 100% é recusado, e a mensagem pede para reduzir o % antes.
- `parseDuration` e `formatDuration` entendem o texto do Project ("10 dias", "10 dias corridos", "8 horas", "2 meses", "0 dias"). `parseLinks` e `formatLink` passam a escrever `27TI+6 dias` e `12II+2 dias corridos`, com `;` como separador, e continuam aceitando `2d`/`2dd` e vírgula.
- `planWindow(month)`: do dia 1 do mês ao último dia do mês + 2.
- `rollUpPlan`: o resumo passa a ter início real (o mais cedo), término real (só quando todas as subtarefas terminaram) e `milestone`.
- `save_plan_revision` valida as datas reais:
  - término real exige início real, e o início não pode vir depois do término;
  - término real exige 100%, e % acima de 0 exige início real;
  - resumo não recebe data real.
  As datas reais entram no histórico por campo.
- `create_plan` com `copyFrom`:
  - copia tarefas (com ids novos), vínculos, calendário, recursos, anotações, % e datas reais;
  - deixa de fora as tarefas concluídas antes do novo horizonte e os resumos que ficam sem filhos;
  - acerta os níveis;
  - quando uma tarefa perde uma predecessora, fixa o início dela para a data não pular;
  - recusa copiar de linha de base, de mês posterior e de outra obra.
  O plano de origem não muda.

### Validação

- `npm test`: 249 testes passando, incluindo `tests/plan-monthly.test.ts` (14 testes) e `tests/gantt-chart.test.ts` (11 testes). `tests/plan-schedule.test.ts` e `tests/expansao.test.ts` foram ajustados à regra nova: duração 0 agora é aceita, revisão com % exige início real, e mudou o formato do texto do vínculo.
- `npm run typecheck`: limpo nos arquivos desta etapa. Os únicos erros são de `src/modules/longo-prazo/planner/`, trabalho em andamento de outra sessão.
- **Navegador**: a tela foi aberta com `next dev` e o acesso de desenvolvimento, e dirigida por Playwright sem janela, com as gravações bloqueadas na rede. O cenário foi montado só no rascunho, **sem salvar**: resumo com três subtarefas, predecessoras `2` e `3TI+2 dias`, marco de 0 dias, 100% e 40%. As datas conferiram com o Project. A tabela e o Gantt ficaram alinhados, e o console não registrou erros.

### Pendências

- Não foi feito nenhum "Revisar e salvar" real com datas reais nem criado nenhum mês por cópia no Supabase. As duas coisas estão cobertas pelos testes do comando, mas falta um uso real.
- Não foi validado com um plano grande (centenas de linhas) nem em tela de celular. No celular, o modo "Somente tabela" é o indicado.
- Não pedidos e não feitos: caminho crítico e folga, arrastar barras no Gantt, importar ou exportar XML do Project, e "rolar até a tarefa".
- O resumo de marcos conta com peso 1 no % ponderado.


## Semana 1 de cada obra (25/09/2026)

A pedido do usuário, **Configurações da obra** ganhou o campo **Numeração das semanas**, que define a semana 1 da obra. É dela que sai o número de cada semana no curto prazo, para bater com a planilha da obra (que estava na semana 113). A semana 1 pode ser informada de dois jeitos: pelo **número da semana atual** (113 → semana 1 = 29/07/2024) ou pela **data**. Qualquer dia vale pela segunda-feira da semana. Há também um botão para voltar à numeração automática, que conta a partir da primeira semana com linha na planilha. No curto prazo, ao lado de "Semana atual", o link "definir/alterar semana 1" leva ao campo. A lista de semanas passa a começar na semana 1.

**Onde fica:** tabela própria `work_settings` (migração `0025_work_settings.sql`, **criada e não aplicada**), lida e gravada por `GET/PUT /api/work-settings`, com o gancho `useWorkSettings` (`src/modules/configuracoes/work-settings.ts`). Ficou fora do snapshot de propósito: outra sessão estava alterando `entities`, `commands` e `mappers`, e pôr a semana 1 em `works` exigiria reescrever `commit_planning`. Sem a migração, a leitura responde "indisponível", o curto prazo segue com a numeração automática e a configuração mostra o aviso. Consulta vê, os demais perfis gravam, e a obra é verificada no servidor. O banco recusa uma data que não seja segunda-feira.

**Regras:** `src/domain/week-numbering.ts` (`normalizeWeekOne`, `weekNumberFrom`, `weekOneFromCurrent`), com testes em `tests/week-numbering.test.ts` (5). Semanas anteriores à semana 1 aparecem com número zero ou negativo.

**Validação:** a rota respondeu "indisponível" com o banco atual e recusou data inválida. No navegador de teste, com a resposta simulada, a configuração mostrou a prévia "113 → 29/07/2024", e o curto prazo passou a mostrar "Semana atual: 113", com as semanas de 1 a 117. A gravação real depende da `0025`.

## Revisão de operação e estética (01 e 02/10/2026)

Registro completo em `docs/revisao-2026-10-01.md`. O que toca os três níveis:

- **Bug corrigido:** a sincronização do Prevision (`POST /api/prevision/schedule`) usava a data fixa de demonstração 08/09/2026 como "hoje" ao regenerar a cauda dos vagões; passou a usar o relógio único das rotas (`src/infrastructure/clock.ts`), o mesmo da geração de vagões pelo plano e dos comandos.
- **02/10/2026 — o usuário cancelou o BIM 4D.** As abas passam a ser quatro: longo prazo, vagões, médio prazo e curto prazo. O modelo federado e os arquivos IFC ficam no grupo Apoio.
- **Snapshot por obra e histórico fora dele:** migração `0027_planning_snapshot.sql` (aplicada em 02/10/2026; sem ela a leitura volta a ser por tabela). O histórico do vagão e o histórico da tarefa do plano do mês passam a vir de `GET /api/history`, pelo hook `useHistory`.
- **Aba 3 em seções na URL** (`?secao=cronograma|janela|equipes|cobertura|historico|recursos|linha-de-base`), com um único cabeçalho e o alternador no padrão da aba 1.
- **Aba 4 no celular:** cada linha da planilha vira um cartão abaixo de 1024 px, com as mesmas pílulas de Status e Causa; a tabela com os filtros de coluna continua no desktop.
- **Em todas as abas:** cabeçalho único (`TabHeader` com ajuda "Como funciona"), prosa explicativa movida para a ajuda contextual, formulários em gaveta lateral (`CommandForm`), confirmações próprias no lugar do `window.confirm`, avisos por toast, paleta única dos gráficos (`src/shared/palette.ts`: planejado azul, executado verde, hoje âmbar, atrasado vermelho, linha de base cinza) e tipografia mínima de 12 px.
- **Provider:** recarga ao voltar o foco e a cada dois minutos, dados antigos mantidos durante a recarga, faixa "Sem resposta do servidor" com tentar de novo.

**Pendências desta revisão:** 0027 e 0025 aplicadas (conferido em 02/10/2026); versão por obra na concorrência (hoje `planning_meta.version` é único); validar no navegador autenticado as telas reorganizadas.

## Go-live do curto prazo (07/10/2026)

O curto prazo entra sozinho em produção num Supabase novo da ATR. Os outros níveis (longo prazo, vagões e médio prazo) e o grupo Apoio continuam no código, mas ficam restritos a quem está em `DEVELOPER_EMAILS` até serem liberados, um de cada vez. O histórico semanal do Sheets entra pelo importador `scripts/import-curto-prazo.ts`. Detalhes, validação e pendências estão em [go-live-curto-prazo.md](go-live-curto-prazo.md).

## Curto prazo: colunas ajustáveis e PDFs da semana (08/10/2026)

O usuário disse que a planilha estava ruim de usar e pediu duas coisas: colunas de largura arrastável e PDFs do planejamento e do fechamento, no formato da planilha da obra. Ele enviou dois exemplos: "PCP-BLT - Semana 115" e "PCP-BLT - Resultados Semana 114".

- **Colunas ajustáveis** (`src/modules/curto-prazo/column-widths.tsx`):
  - a tabela passou a `table-layout: fixed`, com `<colgroup>`;
  - cada cabeçalho tem uma alça na borda direita: arrastar muda a largura, duplo clique volta ao padrão e, com foco na alça, as setas ajustam;
  - as larguras ficam no `localStorage` de cada pessoa (`obra360.curto-prazo.colunas`), porque são preferência de quem lê, não dado da obra;
  - "Larguras padrão" restaura todas;
  - os padrões estão em `COLUMN_DEFAULTS` (`commitments-overview.tsx`). Os dias da semana têm 68 px para o cabeçalho com o filtro não cortar.
- **PDFs** (`src/modules/curto-prazo/print-sheet.tsx`, rota `src/app/imprimir/curto-prazo/[obraId]/page.tsx`):
  - os botões "PDF do planejamento" e "PDF do fechamento" abrem, numa aba nova, uma página fora do layout do sistema, que chama a impressão do navegador ("Salvar como PDF", A4 paisagem);
  - o título da página vira o nome do arquivo: `PCP-<código> - Semana N` ou `PCP-<código> - Resultados Semana N`;
  - o cabeçalho (faixa azul, obra, semana analisada e atual, datas sobre Seg. a Sáb.) fica no `<thead>` e se repete em cada folha;
  - a ordem das linhas é a padrão da planilha (empresa, depois início), sem os filtros da tela;
  - o fechamento acrescenta Realizado (Sim em verde, Não em vermelho), Causas e Justificativa.
  - O login continua exigido pelo proxy, e os dados vêm da mesma `/api/planning`.
- **Sem biblioteca de PDF:** a impressão do navegador dá o resultado do exemplo e evita mais uma dependência.
- **Validação:**
  - o sistema rodou localmente contra o banco de produção, só leitura e com o acesso local sem login;
  - o Playwright renderizou as semanas 114 (fechamento) e 115 (planejamento) da Blentt, e os títulos saíram exatamente como os nomes dos arquivos do usuário;
  - a planilha da tela foi conferida por captura;
  - checagens: TypeScript, ESLint, 337 testes e build.

## Curto prazo: semana encerrada e janela do PDF (08/10/2026)

- **Semana encerrada** (`src/domain/week-lock.ts`, testes em `tests/week-lock.test.ts`):
  - o usuário pediu que a semana que ficou para trás congele, de modo que só admins editem, e escolheu a folga: **até a terça-feira seguinte, inclusive**, para lançar o fechamento;
  - `isWeekLocked(weekStart, today)` vale quando hoje passa de segunda + 8 dias, e "hoje" é o de São Paulo;
  - o servidor (`applyCommand`) recusa `create_commitment`, `update_commitment` (nas duas pontas: tirar a linha de uma semana encerrada ou pôr nela), `record_fulfillment` e `delete_commitment` quando a semana está encerrada e o ator não é admin;
  - na planilha, a semana encerrada fica só para leitura para quem não é admin, com aviso. O admin vê um aviso de que está alterando uma semana encerrada;
  - o importador do histórico passou a exigir **admin**, porque todo histórico cai em semanas encerradas.
- **Janela do PDF** (`src/modules/curto-prazo/print-dialog.tsx`):
  - os botões "PDF do planejamento" e "PDF do fechamento" abrem antes uma janela;
  - a janela tem a lista de empreiteiros no estilo do filtro de coluna da planilha (pesquisar, selecionar tudo, limpar, contagem de linhas) e começa com o filtro de Empresa da planilha, se houver;
  - também tem a ordem das linhas: **por empreiteiro** (empresa, depois início) ou **por data de início** (início, depois empresa);
  - os empreiteiros desmarcados vão na URL como `excluir`, e a ordem como `ordem=inicio|empreiteiro`. A página de impressão aplica os dois.
- **Validação:**
  - o sistema rodou localmente contra a produção, com o acesso local sem login no perfil de um planejador;
  - a semana 114 da Blentt apareceu encerrada e só para leitura;
  - uma edição que regravava os mesmos valores foi recusada pelo servidor com 400;
  - o PDF de fechamento sem ATR ENG e por data de início saiu com 105 linhas e nenhuma do ATR ENG.

## Curto prazo: retorno da implantação (09/10/2026)

O Daniel (planejador da Blentt) testou em produção e mandou observações. O que foi achado e corrigido:

- **"Painel ruim" / tela deslocada:**
  - a página chegava a 2.473 px numa tela de 1.366;
  - a causa eram os ícones das células (`position: absolute`, 582 deles), que escapavam do quadro da planilha porque o quadro não era posicionado e alargavam a página inteira;
  - o quadro passou a `relative`, com altura limitada (`max-h-[calc(100dvh-12rem)]`) e rolagem própria nos dois sentidos, e o cabeçalho ficou fixo (`sticky`). A barra de rolagem lateral, que antes só aparecia depois de 148 linhas, fica à vista.
- **"Travando":**
  - a semana tinha 46 mil elementos, porque a tabela e os cartões do celular eram desenhados juntos e um deles ficava escondido por CSS. Agora `useWideScreen` desenha só um dos dois, e a página caiu para 22 mil;
  - a recarga automática (a cada 5 min (com verificação de versão antes, desde 12/10/2026) e ao voltar à aba) baixa os ~3 MB da obra e redesenhava tudo, até duas vezes por recarga. Agora uma resposta idêntica à anterior não muda estado nenhum, e o "Recarregando…" só aparece quando há aviso de conexão.
- **"Larguras padrão" não fazia nada:** sem larguras mexidas, voltar ao padrão não muda nada visível. Ele virou **"Ajustar à tela"** (`fitWidths`, testado em `tests/column-widths.test.ts`), que reduz as colunas proporcionalmente até o mínimo legível de cada uma (`COLUMN_MIN`). Sem preferência gravada, a planilha já abre ajustada. Duplo clique na borda continua voltando a coluna ao padrão. (Desde 23/11/2026 o ajuste é contínuo e o botão volta ao automático; ver a seção do retorno do Jorge.)
- **Linha nova pulava para a ordem alfabética:**
  - a ordem das linhas fica presa enquanto se edita: linha nova entra no fim, e linha editada não muda de lugar, como no Sheets;
  - "Organizar por empresa" aparece quando a ordem diverge e volta à ordem padrão. Trocar de semana ou recarregar também volta;
  - classificar por uma coluna, no funil, continua valendo por cima.
- **Validação:**
  - medido com o Playwright numa tela de 1.366×768, contra os dados reais e com o perfil de planejador;
  - a página ficou com 1.366 px, sem rolagem lateral, e o cabeçalho continua fixo ao rolar.
  - A ordem estável não foi exercitada criando linhas em produção, para não deixar histórico de teste. A lógica fica em `commitments-overview.tsx` (`pinned`).
- **Ordem de inclusão como padrão (09/10/2026, segundo retorno):** o usuário pediu que a tarefa adicionada não suba na lista e fique embaixo, para uma experiência linear. A ordem presa só durante a sessão não bastava, porque ao recarregar a planilha voltava a ordenar por empresa. Agora:
  - a ordem padrão é `createdAt`: a nova entra embaixo e fica embaixo, mesmo depois de recarregar;
  - no histórico importado, as linhas de uma semana têm o mesmo `createdAt`, e o desempate é o da planilha de origem (empresa, depois início);
  - acima da planilha, "Organizar por empresa" agrupa por empresa durante a sessão (as novas continuam entrando embaixo), e "Voltar à ordem de inclusão" desfaz;
  - testado com o Playwright interceptando a gravação, sem escrever em produção: a linha nova ficou em 117 de 117, depois de incluir e depois de recarregar.
- **Apontamento livre (09/10/2026):**
  - o usuário pediu para liberar desde já o preenchimento do Realizado e das causas;
  - na semana atual isso já era livre, então a decisão foi tirar a trava de semana encerrada do **apontamento**;
  - `record_fulfillment` (Realizado, causa, justificativa) não confere mais a semana: quem pode editar a obra lança ou corrige o apontamento em qualquer semana;
  - criar, editar e excluir linhas de semana encerrada continua só para admins;
  - na planilha, os campos de Status, Causa e Justificativa ficam habilitados na semana encerrada (só o perfil de consulta não edita), e o aviso e a ajuda explicam a regra;
  - testes em `tests/week-lock-commands.test.ts`.
- **"A tarefa sobe ao marcar Sim/Não" e varredura de bugs (09/10/2026):**
  - A reprodução com gravação real, perfil de admin e o código publicado não moveu a linha: a ordem presa não depende do apontamento. O que move é a **classificação pelo funil** (ex.: Status A→Z), que era contínua e levava a linha recém-marcada para junto das outras "Sim". Agora classificar é ação de uma vez, como no Sheets: reescreve a ordem presa, o funil indica a coluna, e nem apontar nem editar movem a linha ("Voltar à ordem de inclusão" desfaz).
  - Bugs da planilha corrigidos: Sim não podia ser corrigido para Não (`statusOf` ignorava a marcação pendente); a marcação pendente era desfeita antes de a gravação confirmar; o rascunho da linha nova era apagado antes de gravar e se perdia quando outra linha estava salvando ou o servidor recusava (agora só limpa após criar, e o foco volta ao campo para a próxima linha); gravações disparadas enquanto outra estava em curso eram descartadas em silêncio (agora entram numa fila); campos de texto e data não refletiam a linha atualizada por outra pessoa (`key` pelo valor); "Levar p/ próxima" sumia na semana encerrada embora a semana seguinte esteja aberta; o Pareto "esta semana" seguia os filtros de coluna.
  - Provedor de dados: a recarga após um comando podia reaproveitar uma leitura iniciada antes da gravação e não mostrar a mudança; agora espera essa leitura e pede outra.

## Curto prazo: retorno da implantação, segunda rodada (11/10/2026)

O Pedro (planejador da Blentt) mandou oito observações. O que foi feito:

- **"Área vazia ao rolar" e "quando mexo no PCP fica descendo":** reproduzido com o zoom do navegador em 125%: a casca de `100vh` passava da janela, o corpo da página rolava (sobrava área vazia abaixo da planilha) e o navegador rolava ao focar campos. Agora, dentro do sistema (`[data-app-shell]` no layout), `html` e `body` ficam com `overflow: hidden` e só a coluna de conteúdo rola. Login, privacidade e impressão ficam fora da casca e seguem normais.
- **Fechamento em seção própria:** a série do PPC e o Pareto saíram de baixo da planilha para `?secao=fechamento` (`closing-overview.tsx`, navegação em `section-nav.tsx`, como no médio prazo). A planilha fica sozinha na página.
- **Velocidade:** a resposta de `/api/planning` para quem não desenvolve vem sem vagões, planos e IFC (`slimForShortTerm`, `scope-planning.ts`); os cartões de obra desses usuários deixam de mostrar restrições e vagões atrasados (só o PPC). Após gravar, a planilha reflete o comando na hora (`local-apply.ts` aplicado pelo provedor) e a recarga de confirmação roda em segundo plano. A tabela redesenha só a linha alterada (`SheetRow`/`SheetCard` memorizados). Na Blentt o volume (6 mil linhas) ainda dá ~3 MB por recarga; carregar por semana fica como próximo passo.
- **"Marquei Sim para testar e não consigo voltar para vazio":** novo comando `clear_fulfillment` (liberado em qualquer semana, como o apontamento) e botão "Limpar apontamento" na coluna final da linha (e no cartão), com confirmação.
- **Coluna final:** "Do não cumprido" virou "Apontamento" e só aparece quando a semana tem algum apontamento; o ✕ ficou mais estreito.
- **"Inclusão de equipe pelo PCP":** já existia (digitar um nome novo cria a equipe); o campo ganhou a dica "Não achou? Digite o nome para criar uma equipe nova".
- **Fechamento:** filtros de empreiteiro e equipe (marcar/desmarcar, como o filtro de coluna) aplicados à série do PPC e ao Pareto; bloco "Justificativas por causa" com temas recorrentes (`justifications.ts`, agrupamento por termos, testado) e busca; botão "Analisar com IA" (`POST /api/curto-prazo/analise`, Claude via `@anthropic-ai/sdk`, modelo `claude-sonnet-5-5`), que só funciona com `ANTHROPIC_API_KEY` definida no servidor e, sem ela, avisa.
- **Relatório único das justificativas** (pedido 5): feito a partir dos dados de produção em 11/10/2026 e entregue ao usuário como página publicada; não vive no repositório.
- **Logos no PDF (11/10/2026):** no cabeçalho dos PDFs do curto prazo, o nome da obra à esquerda deu lugar aos logos da ATR e da Takt lado a lado (`/logo-atr.png` e `/logo-takt.png`, os mesmos do login), num fundo branco sobre a faixa azul; o nome da obra continua no título ao centro.

## Curto prazo: tempo nos PDFs (12/10/2026)

Pedido do usuário: previsão do tempo dia a dia no PDF do planejamento e o tempo observado no PDF do fechamento.

- **Fonte:** Open-Meteo (`src/infrastructure/integrations/weather/open-meteo.ts`): previsão de até 16 dias e dados observados de dias passados (API de previsão para as últimas semanas, arquivo ERA5 para semanas mais antigas). Sem chave. **O uso gratuito é só para fins não comerciais**; o plano comercial (~€29/mês) entra pela variável `OPEN_METEO_API_KEY`, que troca os hosts para `customer-*.open-meteo.com` sem mudar código. Decisão de licença pendente com o usuário.
- **Local da obra:** migração `0029_work_location.sql` acrescenta `place`, `latitude` e `longitude` a `work_settings`. A tela Configurações da obra ganhou o painel "Local da obra" (`work-location.tsx`): busca de cidade/endereço pela geocodificação do Open-Meteo (`/api/clima/geocode`), escolha na lista e gravação pelo `PUT /api/work-settings`, que virou atualização parcial.
- **Rota:** `GET /api/clima?workId=&semana=` (`src/app/api/clima/route.ts`) devolve os 7 dias da semana (`src/domain/weather.ts`): código WMO traduzido para rótulo e ícone, máx/mín, chuva em mm e probabilidade (só na previsão), com `observed` por dia (dia já passado = observado). Sempre responde 200: sem local ou provedor fora, `available:false` com motivo, para o PDF não travar. Cache em memória por instância (30 min previsão, 24 h arquivo).
- **No PDF** (`weather-strip.tsx`, no fim do documento): seis quadros de Seg a Sáb com ícone, rótulo, máx/mín, chuva e a marca "obs."/"prev."; título "Previsão do tempo para a semana" (planejamento), "Tempo na semana" (fechamento) ou misto na semana corrente; frase de resumo (dias com chuva relevante) e a fonte. A impressão espera a resposta do tempo por até 4 s e sai mesmo sem ela.
- **Estado em 12/10/2026:** a 0029 foi aplicada pelo usuário no `takt-hub` (colunas conferidas pela API; o painel esconde o campo de busca enquanto a migração falta, e foi isso que ele viu antes de aplicar). Pendências: informar o local de cada obra em Configurações; decidir a licença do Open-Meteo.

## Tráfego das recargas (12/10/2026)

Cada recarga do planejamento baixa a obra inteira (Blentt: 3,9 MB em JSON, ~350 KB comprimidos), e isso acontecia a cada 2 minutos por aba aberta, ao voltar à aba e depois de cada gravação. Com poucos usuários, dá ~10 GB/mês de saída no Supabase e o mesmo volume de função na Vercel, suficiente para estourar planos gratuitos. O que mudou:

- **Verificação de versão antes de recarregar:** `GET /api/planning/version` (`src/app/api/planning/version/route.ts`) devolve a `planning_meta.version`, que o `commit_planning` incrementa a cada gravação. O provedor (`planning-provider.tsx`) só baixa o planejamento quando a versão mudou; a decisão pura está em `src/application/planning-version.ts`, testada.
- **Intervalo de 2 para 5 minutos**, ainda só com a aba visível, e ao voltar à aba depois de 30 s. Uma aba parada passa de 3,9 MB a cada 2 min para algumas centenas de bytes a cada 5 min. Medido com relógio simulado: 11 min parada = 2 verificações e nenhuma recarga cheia; voltar à aba = 1 verificação.
- A recarga após uma gravação continua cheia (confirma a gravação e registra a versão nova). Próximo passo, se ainda for preciso: carregar o curto prazo por janela de semanas.
- Cada verificação ainda é uma invocação de função na Vercel com leitura de sessão e perfil; baixar isso exigiria cache do perfil no servidor.
- **Busca de endereço (12/10/2026, retorno do usuário):** a geocodificação do Open-Meteo não achava "Rua Maranhão, 2176 - Portão, Curitiba - PR", porque só conhece nomes de lugares. A busca de `/api/clima/geocode` passou a ter três caminhos: coordenadas coladas (inclusive de um link do Google Maps); endereço completo pelo **Nominatim (OpenStreetMap)** (`src/infrastructure/integrations/geocoding/nominatim.ts`: rua, número, bairro, cidade e UF, com CEP no rótulo; fila de 1 pedido/s, cache de 24 h e identificação no User-Agent, como a política do serviço pede; `GEOCODING_USER_AGENT` opcional); e, só se nada vier, o Open-Meteo. O debounce da tela subiu para 700 ms. Testes em `tests/geocoding.test.ts`.

## Velocidade ao clicar (12/10/2026)

O usuário relatou demora ao clicar. Medido de uma máquina perto do banco: gravar um apontamento levava 1,8 s no servidor (baixa o planejamento inteiro, 3,9 MB, aplica o comando e devolve os 3,9 MB ao banco, regravando 6 mil linhas); `GET /api/planning` 0,5–0,8 s; e a produção rodava as funções da Vercel em `iad1` (EUA) com o banco em São Paulo (`x-vercel-id: gru1::iad1`), somando ~130 ms a cada ida e volta. Três frentes:

- **Região das funções:** `vercel.json` ganhou `"regions": ["gru1"]` (São Paulo, ao lado do Supabase sa-east-1). Conferir pelo cabeçalho `x-vercel-id` (`gru1::gru1`).
- **Resposta imediata ao clique (feito):** `src/app/(app)/obras/loading.tsx` e `obras/[obraId]/loading.tsx` são esqueletos que o Next mostra no instante do clique em "Obras", numa obra ou numa aba, antes de a função no servidor responder; o `<Link>` da lateral já os traz no prefetch. Sem dado nenhum, de propósito.
- **Planilha ↔ Fechamento sem servidor (feito):** a página do curto prazo ficou magra (`curto-prazo/page.tsx` só renderiza `CurtoPrazoSections`); a seção vem de `?secao=` lida no cliente com `useSearchParams` (dentro de `Suspense`), e o `SectionNav` troca a URL com `window.history.pushState`, que o Next intercepta e repassa ao roteador. Voltar/Avançar, clique do meio e Ctrl/Cmd+clique seguem funcionando porque o `<a href>` é real. O planejamento já está no `PlanningProvider`; a troca não busca nada.
- **Gravar só o que mudou (feito):** `SupabasePlanningRepository.commit` manda ao `commit_planning` apenas as linhas cujo JSON mudou (`diffChangedRows`, em `mappers.ts`) e os ids apagados (`diffDeletedIds`). O `commit_planning` (migração 0023, conferido: nada o redefine até a 0029) faz `insert … on conflict do update` linha a linha e só apaga o que `p_deletes` lista, então as linhas ausentes do payload ficam como estão. Um apontamento na Blentt passou de regravar 6 mil linhas (3,9 MB) para 1 linha + 1 evento de histórico (~2 KB). Validado em `scripts/validate-plan-database.mjs` e `validate-bootstrap-sql.mjs` (payload parcial muda só a linha enviada; payload vazio e `{}` só sobem a versão).
- **Leitura recortada nos comandos do curto prazo (feito):** `commandScope` (`src/application/use-cases/command-scope.ts`) diz o que cada comando precisa, e `fetchShortTermScope` lê só isso, em paralelo, depois de ler a versão (a versão vem antes para uma gravação concorrente entre as duas leituras virar `version_conflict`, nunca sobrescrita): `record_fulfillment`, `clear_fulfillment` e `delete_commitment` leem obra, perfis, equipes da obra e a própria linha (~10 KB em vez de 3,9 MB); `create_commitment` e `update_commitment` também a semana envolvida (destino, ao mover); `create_team`/`update_team` só obra, perfis e equipes. Ficam com o planejamento inteiro: `delete_team` (confere atividades e tarefas do mês que usam a equipe), a linha vinculada a atividade do cronograma e todos os demais comandos, que ainda assim gravam só o que mudou. Testes: `tests/planning-repository.test.ts` (cliente PostgREST de mentira: tabelas e filtros lidos, payload, retry de conflito) e `tests/infrastructure.test.ts`.
- **Sem recarga depois do próprio comando (feito):** a rota de comandos devolve `{ id, version }` (a versão gravada é a esperada + 1, garantida pelo `for update` do `commit_planning`). Se ela é exatamente a conhecida + 1 (`confirmsOwnWrite`, em `planning-version.ts`), a projeção local já é o que o banco tem: o provider registra a versão nova e não baixa nada. Antes, cada clique na planilha baixava os 3,9 MB e redesenhava a planilha inteira em segundo plano, travando a tela meio segundo, e era isso que o usuário sentia como demora ao clicar. Qualquer outra resposta (versão desconhecida, salto maior porque alguém gravou no meio, comando sem projeção) recarrega como antes.
- **Uma leitura de sessão por requisição (feito):** `getAuthUser`, `loadProfile` e `getRouteAccess` em `supabase-server.ts` estão em `cache()` do React. O layout de `(app)` e a página (ou um handler que pede perfil e usuário) chamavam o Supabase duas ou três vezes no mesmo render; agora é uma.

## Etapa 5 — engenharia reversa do Project: caminho crítico, restrições, prazo final e exportação (13/10/2026)

O usuário pediu a aba 3 "o mais próximo possível do MS Project" e que se buscasse no GitHub o que existe de consolidado, com uma bancada de testes antes de trazer ao sistema. A pesquisa, os candidatos avaliados e o veredito estão em `docs/engenharia-reversa-project.md`. Em uma linha: não há motor TypeScript livre que reproduza o Project; o que há de consolidado é o conhecimento (o `MicrosoftScheduler` do MPXJ e os artigos da Microsoft) e o formato de arquivo (MSPDI). O motor próprio foi ampliado com essas regras e ganhou exportação para o Project.

### Motor (`src/domain/plan-schedule.ts`)

- `analyzeSchedule(tasks, links, calendar, { criticalSlack })` faz as duas passadas e devolve, por linha, `TaskSchedule`: início e término cedo e tardios, folga total e livre (dias úteis), crítica, o que segura a data (`drivenBy`: rede, restrição, data real, início guardado ou, no resumo, os filhos), as predecessoras determinantes (`driverIds`), vínculo desrespeitado (`conflict`) e prazo perdido (`deadlineMissed`). `scheduleTasks` continua existindo e é só as datas, para o servidor e para quem não precisa de folga.
- **Oito restrições** (`PlanTask.constraintType` + `constraintDate`; rótulos e siglas do Project em pt-BR em `CONSTRAINT_LABELS`/`CONSTRAINT_ABBREVIATIONS`): NIAD e NTAD só empurram para a frente; NIDD, NTDD, DIE e DTE prendem a data mesmo contra a rede e marcam o vínculo como desrespeitado; OMTP agenda nas datas tardias e refaz as sucessoras a partir delas. `anchorStart` (o "Não iniciar antes de" antigo) virou **legado**: `constraintOf(task)` o lê como NIAD, o mapper converte na leitura e o comando de revisão não o grava mais.
- **Prazo final** (`PlanTask.deadline`): não reprograma; corta o término tardio (folga negativa quando não cabe) e acende o indicador quando o término passa dele.
- **Passada inversa**: término tardio = o inverso exato do limite da passada direta, a partir das datas tardias das sucessoras; sem sucessora, o fim do projeto. Data real fixa as datas tardias (iniciada: início tardio = início real; concluída: término tardio = término real).
- **Folgas e crítica**: folga total = menor entre a do término e a do início; tarefa iniciada só tem a do término; concluída nunca é crítica e tem folga livre zero; folga livre nunca negativa; crítica = folga total ≤ limite (0, configurável). Resumo é crítico quando alguma subtarefa é. A folga negativa aparece na predecessora cujo término tardio fica antes do término cedo e, como o Project real mostra (conferido em 20/10/2026, corrigido em 21/10/2026), também na tarefa presa pela restrição. Desde 21/10/2026 o motor segue o Project também nas datas exibidas, com o dia e a ponta dele (08:00 ou 17:00), a tarefa em andamento dividida e as demais regras medidas: ver "Correções de 21/10/2026" em `docs/engenharia-reversa-project.md`.
- **Correção**: vínculo IT (início-término) agora termina a sucessora no dia útil **anterior** ao início da predecessora (terminar às 08:00 é terminar às 17:00 da véspera), como o Project. O motor antigo terminava no mesmo dia; o teste `motor calcula IT` mudou de propósito.

### Servidor e persistência

- `save_plan_revision` valida a restrição (tipo que exige data sem data, data inválida) e o prazo final, recusa restrição e prazo em resumo, grava `constraintType`/`constraintDate`/`deadline` e apaga `anchorStart`; os três campos entram no histórico por campo. `create_plan` com cópia leva a restrição no formato atual e, para quem perdeu a predecessora e não tinha data, cria NIAD no início atual (como antes).
- Os campos novos ficam no jsonb `schedule_meta` de `plan_tasks` (migração 0023). **Nenhuma migração nova.** O mapper lê `anchorStart` antigo como NIAD e grava sempre o formato atual.
- Não implementado (e por quê): defasagem em percentual ou horas (a coluna `lag_days` é inteira em dias; exigiria migração), duração restante separada, restrição em resumo, tarefas manuais/inativas/divididas. Lista completa em `docs/engenharia-reversa-project.md`.

### Testes e bancada

- `tests/fixtures/cenarios-project.ts` + `tests/plan-cpm.test.ts`: 33 cenários com o resultado esperado do Project (vínculos nos quatro tipos com defasagem útil e corrida, marcos, feriados, dias corridos, as oito restrições, prazo final, dois caminhos, folga total diferente da livre, resumo, datas reais, predecessora determinante) mais testes de restrições, dias úteis com sinal, tarefa iniciada/concluída, folga crítica configurável, comando de revisão e mapper. A bancada original (fora do repositório, `scratchpad/bancada/`) rodou os mesmos cenários: 169/169 checagens.

### Tela (`schedule-sheet.tsx` + `gantt-chart.tsx`)

- **Colunas novas**, todas ocultas por padrão (a tabela padrão continua igual ao print do Project): Tipo de restrição (lista com os oito tipos, em português; aceita também a sigla NIAD/NIDD/NTAD/NTDD/DIE/DTE/OMBP/OMTP ou o código ao colar), Data da restrição, Prazo final, Início tardio, Término tardio, Folga total, Folga livre e Crítica (Sim/Não). As três primeiras são só de subtarefa; as demais valem para resumo e para a linha 0 (término tardio = fim do projeto).
- **Edição como no Project**: digitar o início cria "Não iniciar antes de" na data; digitar o término recalcula a duração **e** cria "Não terminar antes de"; escolher um tipo com data numa tarefa sem data usa o início (ou o término) atual; digitar uma data de restrição numa tarefa sem restrição cria NIAD; apagar a data volta a "O mais breve possível". Tarefa nova nasce sem restrição. Recuar uma linha que vira resumo tira dela restrição e prazo, além de vínculos e datas reais (desde 16/11/2026 os vínculos ficam; ver "Vínculo com resumo"). Decisão a confirmar com o usuário: digitar o início numa tarefa que já tinha DIE/NIDD troca o tipo para NIAD (o Project mantém o tipo e troca só a data em alguns casos).
- **Indicadores**: restrição (azul = semiflexível, vermelho = inflexível, cinza = OMTP; o texto diz "segurando a data" quando é ela, e não a rede, que fixa o início), prazo final perdido e vínculo desrespeitado, sempre com ícone e texto.
- **Gantt de acompanhamento**: barra **vermelha** para tarefa e marco críticos ("Caminho crítico", ligado por padrão, como no Gantt de acompanhamento do Project); **linha de folga** do fim da barra até o término tardio ("Folga", desligado por padrão); **seta de prazo final** verde, vermelha quando perdido; borda tracejada no vínculo desrespeitado; e o **"Caminho da tarefa"** do Project 2013 (desligado por padrão): com uma linha selecionada, predecessoras determinantes em âmbar cheio, demais predecessoras em âmbar claro, sucessoras determinadas em roxo cheio, demais sucessoras em roxo claro, vínculo determinante mais grosso e o resto apagado. As três opções ficam no grupo "Exibir" e são lembradas por pessoa e plano, como as outras preferências. Tudo o que a cor diz está também no texto da dica e do rótulo acessível.
- Filtros novos: Críticas, Com vínculo desrespeitado, Prazo final perdido. Barra de status: quantas críticas e o fim do projeto. Painel de detalhes: datas tardias, folgas, crítica, restrição, prazo final e as predecessoras determinantes (pelo Id da linha). Diálogo de revisão e histórico mostram os três campos novos; `anchorStart` aparece no histórico antigo como "Não iniciar antes de (antigo)".
- **Exportar para o Project (.xml)** (`src/domain/mspdi.ts`): gera o MSPDI com cabeçalho, calendário (jornada 08–12/13–17 ajustada à carga horária, feriados nos dois formatos), tarefas com EAP, durações em horas (úteis, decorridas, horas, meses → dias úteis), marcos, cedo/tardias e folgas do motor em décimos de minuto, restrições com código e data, prazo final, % e datas reais, anotações, vínculos com defasagem (úteis e decorridas) e linha de base escolhida. Sem `<Resources>`: o Project não lê nomes de recurso do XML, então a coluna sai vazia (próxima etapa: `<Resources>` + `<Assignments>`). O Project recalcula tudo ao abrir, e é justamente aí que uma divergência do motor apareceria. **Conferido no Project 2019 real em 21/10/2026**, com três defeitos encontrados e corrigidos no mesmo dia: o `<HonorConstraints>` é lido invertido (o elemento saiu); o `<StartDate>` passou a ser o início das tarefas sem predecessora; e a tarefa sem predecessora que começa depois dele sai como NIAD. As horas seguem a ponta do dia calculada pelo motor (marco, IT e dias corridos às 08:00 quando é o caso), e a tarefa dividida sai com o término sem o empurrão, para o Project dividi-la de novo. Detalhes em `docs/engenharia-reversa-project.md`.

### Validação (13/10/2026)

- Sequência do CI local: `typecheck` limpo, `lint` sem erros (30 avisos pré-existentes), `format:check` limpo, `npm test` com **485 testes passando** (eram 476 antes desta etapa, mais 33 cenários do Project, testes de restrição/folga/comando/mapper, 7 testes novos do Gantt e 9 da exportação), `validate:migrations` OK, `build` OK e `test:e2e` 8/8 com as variáveis fictícias do Supabase.
- A tela foi renderizada no servidor (`react-dom/server`) com um plano de exemplo (resumo com três subtarefas, marco, 50% com início real, prazo final perdido, NIAD, DIE que desrespeita a rede): sem erro de render, com os três alternadores, o botão de exportação, as colunas novas no menu "Colunas", os indicadores de restrição, prazo e vínculo desrespeitado, a seta de prazo final e a barra crítica em vermelho no HTML. O `.xml` do mesmo plano passou num parser XML estrito, com o cabeçalho na ordem do esquema, códigos de restrição e vínculo corretos (NIAD = 4, DIE = 2; TI = 1, TT = 0, II = 3) e defasagens em décimos de minuto (2 dias decorridos = 28800, formato 8; 1 dia útil = 4800, formato 7).
- **Não validado em navegador logado**: a aba 3 é restrita ao desenvolvedor e o banco de desenvolvimento é a produção; efeitos (preferências no `localStorage`, alinhamento medido do Gantt, download do arquivo) não rodam na renderização no servidor.

### Ajustes de digitação pedidos ao ver a tela (14/10/2026)

- **Inserir tarefa** entra **abaixo** da linha selecionada (antes entrava acima, como a tecla Insert do Project), no mesmo nível; abaixo de um resumo vira a primeira subtarefa, senão as subtarefas dele passariam para a linha nova. A linha nova já abre com o nome em edição. Sem linha selecionada, entra no fim.
- **Enter na última linha** grava a célula e cria a próxima tarefa, para digitar uma atrás da outra; nas demais linhas, Enter continua descendo uma linha. As duas operações vão numa só entrada do desfazer.
- **Cmd+Alt+→ / Cmd+Alt+←** (Ctrl no Windows) recuam e diminuem o recuo, além de Alt+Shift+setas do Project.
- **Recuo em bloco**: com um intervalo selecionado (Shift+setas ou Shift+clique), recuar e diminuir o recuo agem em todas as linhas, da primeira selecionada ao fim da subárvore da última (subtarefas recolhidas acompanham), mantendo a estrutura relativa, numa só entrada do desfazer. Recusa com frase curta quando a primeira linha não pode recuar ou há linha no nível 0. Função pura `shiftLevels`, testada em `tests/sheet-columns.test.ts`.
- **Colunas arrastáveis**: a ordem das colunas muda arrastando o cabeçalho (ou, com o foco no cabeçalho, Alt+← / Alt+→) e fica guardada com as outras preferências; Id e Indicadores ficam presas no começo; "Restaurar padrão" também devolve a ordem. Funções puras `moveColumn` e `normalizeOrder`, testadas. No Chrome do Mac, Cmd+Alt+setas também troca de aba e pode vencer o atalho da página; Alt+Shift+setas continua valendo.

### Permissão de teste (14/10/2026)

Quem testa o curto prazo pode ganhar acesso ao médio prazo (ou a qualquer outro módulo em desenvolvimento) pela lista "Módulos" de cada usuário em Configurações (admin), sem virar admin nem desenvolvedor; substituiu o botão "Permissão de teste" no mesmo dia (migração 0031). Detalhes, regras e a migração 0030 (aplicada em 14/10/2026) em `docs/go-live-curto-prazo.md`.

### Pendências

- Abrir o `.xml` exportado no Project e comparar datas, folgas e críticas; cada divergência vira cenário em `tests/fixtures/cenarios-project.ts`. Primeiro ponto a conferir: a folga negativa em restrição inflexível (aqui aparece na predecessora, pela leitura do MPXJ).
- Confirmar com o usuário o comportamento de "digitar o início numa tarefa com DIE/NIDD".
- Recursos na exportação (`<Resources>`/`<Assignments>`), defasagem em percentual (migração), duração restante, restrição em resumo e tarefas inativas — lista completa em `docs/engenharia-reversa-project.md`.

## Curto prazo: semanas vizinhas (19/10/2026)

**Pedido da obra:** o Daniel (planejador da Blentt) monta o planejamento de cada empreiteiro com a semana anterior e a próxima à vista ("quando estou fazendo o planejamento do Claudiomir da RC, deixo a semana anterior e a próxima semana"). Assim ele vê a continuidade das tarefas, leva o que não foi feito e percebe o que vai continuar. A planilha mostrava uma semana por vez. O usuário aprovou a proposta.

**O que foi entregue** (`src/modules/curto-prazo/commitments-overview.tsx`):

- **Ligar a visão:** a caixa "Semanas vizinhas", ao lado do PPC, liga a visão. A escolha fica no `localStorage` de cada pessoa (`obra360.curto-prazo.vizinhas`), como as larguras das colunas, porque é preferência de quem lê.
- **Disposição:**
  - a semana anterior aparece acima da semana analisada, e a próxima abaixo, na mesma tabela e com as mesmas colunas;
  - cada semana tem uma faixa com o nome ("Semana anterior", "Semana analisada", "Próxima semana"), o período, o número de linhas (quantas passam no filtro) e o PPC;
  - no celular, a mesma ordem, em cartões;
  - a linha de datas no topo do cabeçalho fica vazia nessa visão, porque cada faixa traz o próprio período.
- **O centro é a semana escolhida no seletor**, e não a semana atual. Antes da semana 1 da obra não há semana anterior (`neighborWeeks` em `sheet-view.ts`, testado em `tests/sheet-view.test.ts`).
- **Filtros:**
  - os filtros de coluna valem para as três semanas. O de Empresa é o que permite planejar um empreiteiro por vez;
  - os valores oferecidos no filtro saem das três semanas;
  - a classificação pelo funil e a ordem presa valem só para a semana analisada. As vizinhas ficam na ordem de inclusão.
- **Semana anterior:**
  - só aceita apontamento (Status, causa, justificativa, Limpar) e "Levar p/ próxima", mesmo quando ainda está aberta;
  - para editar as linhas dela, escolha essa semana no seletor;
  - as linhas aparecem esmaecidas.
- **Próxima semana:** é editável como a analisada, se não estiver encerrada. Não tem linha em branco: entra nela o que se leva, e para escrever uma linha nova basta escolher a semana no seletor.
- **"Levar p/ próxima" para qualquer linha:**
  - nessa visão, o botão aparece em qualquer linha, e não só na do Não: também na linha com Sim (atividade que continua) e na ainda sem apontamento;
  - a linha levada entra como compromisso novo da semana seguinte, sem apontamento e sem marca de continuação, e a de origem não muda;
  - por isso, a coluna "Apontamento" fica sempre visível nessa visão;
  - fora dela, o comportamento antigo continua: só o Não é levado;
  - "Gerar restrição" continua só no Não.
- **A trava de semana encerrada não mudou.** O "Levar" confere a semana de destino, como antes.

**Decisões tomadas por padrão, a confirmar com a obra:**
- o centro da visão é a semana selecionada no seletor;
- a linha levada depois de um Sim entra como linha normal, sem marca de continuação, e conta no PPC da semana seguinte como qualquer compromisso.

**Validação:** typecheck, lint, 518 testes, `format:check` e build passaram. **Não foi aberta no navegador:** o acesso às variáveis do banco de produção para o `next dev` foi negado nesta sessão, e não há base local com dados. Falta conferir na tela com o Daniel:
- a faixa de cada semana;
- o filtro de Empresa nas três semanas;
- o "Levar" da semana anterior para a analisada;
- o celular.

## Médio prazo seguindo o Project: motor, exportação e a interface (21/10/2026)

O usuário pediu: "siga como o Project, corrija tudo", e também "copie a interface e a usabilidade da ferramenta", citando a Linha do Tempo e o planejamento de recursos. A referência foi o Project 2019 do próprio usuário, na VM do UTM: a bancada rodou lá e as telas foram capturadas lá (`scripts/ms-project/`).

**Identidade visual.** A decisão de 25/09/2026 foi mantida: copia-se o layout, as visões e o comportamento do Project, mas com o visual do Obra 360. A tela não tem faixa de opções, nem o azul e o tema escuro do Project.

### Motor e exportação

Estão descritos em `docs/engenharia-reversa-project.md`, seção "Correções de 21/10/2026". Em resumo:
- o motor trabalha com o dia e a ponta dele (08:00 ou 17:00) e segue o Project também nas datas da tabela;
- folga negativa na tarefa presa por restrição;
- NIDD sem sucessora;
- TT com piso no início do projeto;
- tarefa em andamento dividida;
- dias corridos em 24 h.

A bancada passou a ter 69 cenários com os valores medidos no Project, em todas as tarefas e campos. O `.xml` teve três defeitos corrigidos. `TaskSchedule` ganhou `edges`, `stop` e `resume`. `PlanTask` ganhou `timeline`, gravado no jsonb `schedule_meta` (**sem migração**) e aceito pelo `save_plan_revision`. `src/domain/resource-usage.ts` calcula a carga diária de cada equipe e não conta o dia de uma ponta às 08:00.

### Tela (`src/modules/medio-prazo/`)

- **Modo de exibição** (`schedule-sheet.tsx`):
  - seletor com Gráfico de Gantt (desde 23/11/2026, "Gantt de controle"), Planejador de Equipe, Uso dos Recursos e Planilha de Recursos, e os mesmos atalhos na barra de status;
  - nome da visão em pé na borda esquerda, como no Project;
  - a visão escolhida, a Linha do Tempo e "Recursos nas barras" ficam nas preferências do usuário por plano;
  - os comandos que só servem ao Gantt (inserir, recuo, vínculos, excluir, Exibir e filtros) só aparecem nele.
- **Linha do Tempo** (`timeline-band.tsx`):
  - faixa acima de qualquer visão, ligada por padrão e com caixa para esconder;
  - Início e Término nas pontas; barras das tarefas marcadas, com nome e período, a parte concluída mais escura e empilhadas quando se cruzam; marcos em losango com a legenda;
  - a moldura da janela visível do Gantt: arrastar a moldura ou clicar na faixa rola o Gantt;
  - "Adicionar/Remover da Linha do Tempo": botão na barra, aba Geral das Informações, menu de contexto da própria faixa e Delete;
  - escala que se ajusta à largura (dia, semana, mês, trimestre ou ano) e teclado completo.
- **Gantt** (`gantt-chart.tsx`):
  - arrastar a barra muda o início, gravando o "Não iniciar antes de" como a célula Início;
  - esticar a ponta muda a duração;
  - arrastar de uma barra a outra cria um TI;
  - arrastar o progresso muda o %;
  - duplo clique abre as Informações;
  - nome da equipe à direita da barra; marco com a data ao lado;
  - barra que acaba às 08:00 termina na borda do dia;
  - tarefa dividida desenhada em dois trechos ligados por pontilhado.
- **Planejador de Equipe** (`team-planner.tsx`):
  - uma linha por equipe, com as tarefas em blocos;
  - equipe superalocada em vermelho, aberta em subfaixas, com os blocos em conflito contornados;
  - painel "Tarefas não atribuídas: N" embaixo, com altura ajustável;
  - arrastar o bloco para outra equipe reatribui; arrastar na horizontal muda o início (NIAD);
  - a diagonal grava os dois num passo só do desfazer;
  - pelo teclado: Shift+↑/↓ troca de equipe, Shift+←/→ move um dia útil e há o seletor "Atribuir a…".
- **Uso dos Recursos** (`resource-usage-view.tsx`):
  - equipes em negrito, com as tarefas recuadas embaixo;
  - trabalho em horas (dias úteis × jornada);
  - grade por dia (zoom Dias) ou por semana, com as células superalocadas em vermelho;
  - grupo "Sem alocação".
- **Planilha de Recursos** (`resource-sheet-view.tsx`):
  - Nome, Tipo, Iniciais, Grupo (empresa), Unid. máximas (capacidade × 100%), Trabalho, Tarefas e Pico;
  - ordenação por coluna;
  - só leitura, com o link "Configurar recursos".
- **Informações da tarefa** (`task-info-dialog.tsx`):
  - abas Geral, Predecessoras, Recursos, Avançado e Anotações;
  - abre por Shift+F2, pelo botão "Informações", com duplo clique na barra ou no bloco, e com duplo clique numa célula calculada ou na grade bloqueada; na célula editável, o duplo clique continua editando;
  - o OK aplica tudo num passo só do desfazer, pelas mesmas funções de edição das células.
- **Barra de status:**
  - "Pronto", "Editando", "Alterações não salvas" ou "Salvando…";
  - "Novas tarefas: Agendadas automaticamente";
  - atalhos das visões e controle deslizante de zoom; um só controle vale para o Gantt, o Planejador e o Uso dos Recursos.
- **Rolar até a tarefa:** botão e Ctrl+Shift+F5.
- **Tour:** um passo para cada controle novo, em `src/modules/tour/pages/medio-prazo.ts`.

**Recursos = equipes.** Os recursos do Project são as equipes cadastradas da obra. A capacidade (`weeklyCapacity`, atividades simultâneas) faz o papel das "Unidades máximas", e o recurso fica superalocado no dia em que tem mais tarefas ao mesmo tempo do que isso. A seção "Recursos" da aba, com a carga semanal contra a capacidade, continua existindo.

### Validação (21/10/2026)

- **Motor contra o Project montado à mão:** 1.492 checagens nos 69 cenários, 4 divergências. São as duas diferenças conhecidas: restante fracionado de tarefa em andamento e determinante com TT corrido.
- **`.xml` exportado aberto no Project contra o motor:** 1.169 checagens, 2 divergências, no mesmo caso do restante fracionado.
- **Typecheck, lint e testes** (ver o commit). Os componentes foram exercitados em Chromium headless, numa página isolada fora do repositório que monta a tela inteira (`Sheet`) com dados de exemplo (16 tarefas, vínculos dos quatro tipos, tarefa dividida, marcos, equipe superalocada). A primeira passada achou 9 problemas, todos corrigidos:
  - **Alta (1):** esticar tarefa dividida contava a pausa.
  - **Médios (3):** a pausa contava como trabalho nas visões de recursos; o Planejador movia o início de tarefa iniciada; Ctrl+Z não funcionava fora da grade.
  - **Baixos (5):** faixa branca sob a Linha do Tempo; folga com ponto decimal; avanço desenhado por pixel e não por dia útil; barra de status abaixo da dobra; foco perdido ao fechar o diálogo.
- **Não foi aberta no app logado:** falta conferir à mão, no navegador, o arrasto diagonal no Planejador, a moldura da Linha do Tempo e o arrasto das barras do Gantt com dados reais.

### Pendências

- Conferir na tela com dados reais, logado (ver acima).
- Recursos no `.xml` (`<Resources>`/`<Assignments>`).
- Frações de dia (restante de tarefa em andamento, durações em horas).
- Tarefa com início real e 0% que a predecessora empurra: o motor marca a parada no próprio dia do início real, então a dica do Gantt e a duração ao esticar contam esse dia como trabalhado (no Project a parte feita tem duração zero). Corrigir pede mudar a regra de divisão no motor, no Gantt, no Planejador e na tela juntos.
- A tabela não tem menu de contexto; o da Linha do Tempo é da própria faixa.

## Curto prazo: planilha sem espera, apontamento em lote e alça de arrastar (26/10/2026)

**Pedido do usuário:** dois vídeos gravados na Blentt em 23/10/2026 comparando a mesma tarefa, marcar Não, escolher a causa e escrever a justificativa em quatro linhas: 18 s no Google Sheets, 85 s no Obra 360. "Vamos resolver para colocar para rodar da melhor forma."

### Diagnóstico, medido nos vídeos e no código

- **A tela ficou parada 75% do tempo** (quadros sem mudança). A linha em âmbar ("gravando") apareceu 4 vezes, de 3,75 a 4,5 s cada: **16 s dos 85 s** eram espera do sistema. Enquanto a linha gravava, Status, Causa e os botões ficavam desabilitados.
- **Os outros ~69 s eram a interação**, não o servidor: a justificativa só liberava depois que o Status gravava; nada de preencher várias linhas de uma vez (no Sheets a pessoa arrasta a célula para baixo); Enter não descia de linha; cada linha tinha 53 px de altura, pelos dois botões empilhados de Apontamento (11 linhas na tela, contra 20 no Sheets); e, mesmo em 1912 px de largura, Status, Causas e Justificativas ficavam fora da tela, exigindo rolar de lado.
- **O caminho do servidor não explica os 4 s.** Medido daqui contra o banco de produção, com uma linha criada e apagada só na "Obra - Teste": `record_fulfillment` leva **0,35–0,42 s** (6 idas ao Supabase: versão, quatro leituras em paralelo, `commit_planning`; ~100 ms cada ida daqui, menos a partir da Vercel em `gru1`). A Vercel responde em 75 ms quente e 0,7 s fria. Cada requisição à API autenticava **duas vezes** no Supabase Auth (proxy e rota). O que sobra (fria da função, rede do canteiro, recarga de 3,9 MB em curso) agora é mensurável pelo `Server-Timing`.

### Decisões do usuário

- Preencher várias linhas: **barra de seleção e alça de arrastar**, as duas.
- Coluna Apontamento: **botões compactos lado a lado** ("Levar ›", "Limpar"), não um menu.

### O que mudou

- **Projeção antes do servidor** (`planning-provider.tsx`, `projectsBeforeServer` em `local-apply.ts`): comandos que mudam linha existente (`record_fulfillment`, `record_fulfillments`, `clear_fulfillment`, `update_commitment`, `delete_commitment`) são aplicados aos dados da tela **antes** do `fetch`; a célula mostra a escolha no mesmo instante do clique. Se o servidor recusar ou a rede cair, a recarga completa devolve a linha ao que o banco tem. Criar linha ou equipe continua projetado depois da resposta, porque depende do id do servidor.
- **Nada trava enquanto grava** (`commitments-overview.tsx`): Empresa, Semana, Equipe, Status, Causa e os botões deixaram de ficar desabilitados com `saving`; a linha ganha um filete âmbar à esquerda e `aria-busy`, e o cabeçalho mostra "Gravando…" enquanto a fila sobe. A fila continua em série, para a ordem das gravações valer.
- **Justificativa em qualquer ordem:** aberta mesmo sem Status; escrita antes, fica guardada na linha (`drafts`) e sobe junto com o Sim ou com a causa. O rascunho só sai quando o servidor gravou.
- **Teclado como no Sheets** (`row-navigation.ts`): Enter desce e Shift+Enter sobe para a mesma coluna da linha vizinha, nas células de Status, Causas, Justificativas, Atividade, Semana, Início e Término; as setas para cima e para baixo também, só nos campos de texto (num select elas trocam o valor). Sair da célula é o que grava. Cada célula leva `data-col`; cada linha, `tr[data-row-id]`.
- **Apontamento em lote:** caixa de marcar por linha (e "marcar todas as visíveis" no cabeçalho); com linhas marcadas aparece a barra (`bulk-bar.tsx`): Status (manter/Sim/Não), Causa, Justificativa (manter/trocar), "Hoje: …" embaixo de cada campo, aviso das linhas que ficariam de fora e "Aplicar a N". Vai um comando só, **`record_fulfillments`** (`commands.ts`, `command-scope.ts`, `module-access.ts`, `local-apply.ts`): até 500 linhas, tudo ou nada, um evento de histórico, leitura recortada só nas linhas do lote. No celular a barra fica fixa no rodapé. Com a planilha filtrada, só as linhas à vista contam.
- **Alça de arrastar** (`fill-handle.tsx`): o quadradinho no canto inferior direito das células de Status, Causas e Justificativas, visível ao passar o mouse; arrasta para baixo ou para cima e copia o valor nas linhas por onde passou (realce `.fill-target`, em `globals.css`), num `record_fulfillments` só. Regras: Status Sim copia o Sim; Status Não copia Não com a causa da origem nas linhas sem causa (sem causa em nenhuma das duas, a linha fica "aguardando a causa", como no clique); Causa só entra em linha com Não (as outras ficam de fora, com aviso); Justificativa em linha sem Status vira rascunho. Soltar fora da tabela ou o navegador tomar o ponteiro (rolagem por toque) cancela sem gravar.
- **Linha mais baixa:** "Levar p/ próxima" e "Limpar apontamento" viraram "Levar ›" e "Limpar", lado a lado, com a explicação no `title` (e os textos do tour). A linha passou de ~53 px para **37 px**. A coluna Apontamento caiu de 208 para 168 px e a planilha de teste (checkbox, 12 colunas, Apontamento) coube em 1559 px num quadro de 1568 px, sem rolar de lado.
- **Servidor** (`src/proxy.ts`, `src/infrastructure/auth/trusted-user.ts`, `supabase-server.ts`): o proxy valida a sessão uma vez e repassa a identidade à rota em cabeçalhos `x-obra360-user-id`/`-email` **assinados** (HMAC-SHA256 com `OBRA360_TRUSTED_HEADER_SECRET` ou, sem ela, a chave de serviço); qualquer `x-obra360-*` vindo do navegador é apagado antes, e a rota só confia com assinatura válida e id em UUID, senão lê a sessão como antes. A assinatura existe porque o `matcher` do proxy pula caminhos com sufixo de imagem (`/api/admin/users/x.png`), e ali um cabeçalho forjado chegaria à rota. Resultado: **1 ida ao Auth por requisição em vez de 2**. `POST /api/planning/commands` e `GET /api/planning` devolvem `Server-Timing` (`auth`, `commit`/`snapshot`, `total`) e, acima de 1,5 s, registram uma linha JSON (`logRouteTiming`, em `log.ts`) com o tipo do comando, nunca o corpo.

### Validação

- **Testes:** 676 de 676. Novos: `tests/bulk-fulfillment.test.ts` (lote: grava, tudo ou nada, limites, consulta, recorte), `tests/row-navigation.test.ts`, `tests/fill-handle.test.ts` (linhas entre origem e alvo, linha sob o ponteiro), `tests/bulk-bar.test.ts` (regras da barra, linha a linha), `tests/trusted-user.test.ts` (ida e volta, forja, adulteração, sem segredo); casos novos em `tests/local-apply.test.ts` e `tests/module-access.test.ts`.
- **Navegador (Playwright, Chromium 1600 px), numa página de prévia temporária** fora do layout autenticado, com as APIs respondidas pelo Playwright com dados de teste e **um servidor simulado de 1,5 s por comando**: a causa escolhida apareceu em 60 ms e a justificativa foi digitada 0,5 s depois, com a gravação ainda em curso; Enter na justificativa da linha 1 levou o foco à da linha 2; a justificativa escrita antes do Status foi mantida e enviada no `record_fulfillment` do Sim; três linhas marcadas com Não + causa saíram num só `record_fulfillments` e mostraram Não em 58 ms; a alça arrastada da linha 7 à 9 realçou 2 linhas e mandou um só `record_fulfillments`; linha com Apontamento de 37 px; tabela cabendo no quadro; nenhum erro no console. A página de prévia e o roteiro foram apagados.
- **Checagens:** typecheck, lint, Prettier e build.
- **Não conferido:** produção. O `Server-Timing` é o que vai dizer onde ficam os ~3,5 s que o servidor medido daqui não explica; no celular, a barra fixa e a planilha em cartão não foram abertas em aparelho real.

### Pendências

- **Medir em produção:** abrir a aba Rede com um apontamento e ler o `Server-Timing` do POST (`auth` deve ficar em dezenas de ms; `commit` perto de 0,2–0,4 s). Se o total continuar em segundos, a diferença é partida fria da função ou a rede do canteiro, e o próximo passo é carregar a planilha **por janela de semanas** (hoje 3,9 MB de uma obra inteira), pendência que já estava anotada em 12/10.
- O `matcher` do proxy pula qualquer caminho com sufixo de imagem, inclusive sob `/api/` e `/obras/`; a assinatura torna a forja inócua, mas a conferência de módulo do proxy também é pulada ali (as rotas repetem a checagem). Vale restringir a exclusão por extensão aos caminhos estáticos.
- A alça não rola a página sozinha ao chegar na borda (o Sheets rola).
- Na barra, uma linha com Não ainda aguardando a causa conta como "sem Status"; Status Não + causa na barra resolve essas linhas.

### Desfazer (26/10/2026, mesmo dia)

Pedido do usuário logo depois de publicar: "adicione um botão de desfazer". Com a barra de lote e a alça, um arrasto errado muda dezenas de linhas; o Desfazer é o que torna isso barato.

- **Onde:** botão "Desfazer" ao lado do PPC (com "(N)" quando há mais de uma ação na pilha e o que vai ser desfeito no `title`), **Ctrl+Z / Cmd+Z** fora de um campo de texto (dentro dele, Ctrl+Z continua sendo o desfazer do próprio campo) e um botão "Desfazer" nos avisos de lote, alça, "Levar", exclusão e "Limpar", que desfaz aquela ação em particular (`action` novo em `ToastProvider`; o aviso com ação fica 8 s).
- **O que desfaz** (`src/modules/curto-prazo/undo.ts`): apontamento de uma linha, do lote ou da alça; justificativa; "Limpar"; edição de célula (empresa, equipe, semana, período, atividade) e equipe criada na linha (a equipe fica no cadastro); "Levar p/ próxima" (apaga a linha criada); exclusão (recria a linha, com id novo, e regrava o Sim/Não); linha nova (apaga).
- **Como:** cada gravação guarda o estado anterior das linhas e o comando inverso; as últimas 20, só nesta sessão, como no Sheets. O inverso do apontamento é um `record_fulfillments` só, em que a linha que não tinha Status vai com **`clear: true`**, item novo do lote (`FulfillmentItem` virou união em `commands.ts`; o `clear_fulfillment` passou a usar o mesmo `clearFulfillment`). Desfazer é uma gravação comum: entra no histórico e passa pelas mesmas regras (semana encerrada, papel).
- **Validação:** `tests/undo.test.ts` (comandos inversos), casos de `clear` em `tests/bulk-fulfillment.test.ts` e `tests/local-apply.test.ts`; 680 testes. No navegador (prévia temporária, servidor simulado de 400 ms): botão desabilitado sem ação; desfazer um apontamento mandou `record_fulfillments` com `clear` e a célula voltou a vazia; o "Desfazer" do aviso do lote limpou as 3 linhas num comando; Ctrl+Z desfez uma atividade renomeada e, com o cursor num campo de texto, não mandou nada; exclusão desfeita recriou a linha com o Sim. Sem erros no console.
- **Pendências:** sem Refazer; a pilha zera ao recarregar; desfazer uma ação antiga pelo aviso não desfaz as que vieram depois nas mesmas linhas (vale a última gravação).

## Curto prazo: inserir linha no meio e arrastar linhas (30/10/2026)

Pedido da obra, trazido pelo usuário: "colocar uma função pra inserir linha no meio do planejamento"; logo depois, "seria bom se fosse possível arrastar as atividades pra cima e para baixo". Até aqui a linha nova só entrava embaixo e a ordem salva era a de inclusão (`createdAt`), sem lugar para guardar outra.

### Decisões

- **A posição fica no banco**, coluna nova `weekly_commitments.order_index` (`WeeklyCommitment.order`), e vale para todos que abrem a planilha. A ordem da sessão (`pinned`) sozinha não bastava: recarregar desfaria o que a obra arrumou.
- **Quem insere ou arrasta grava a semana inteira** (1, 2, 3…), na ordem que a tela mostra. Gravar só a linha mexida deixaria a ordem salva diferente da tela quando ela estava classificada pelo funil ou organizada por empresa. A linha sem posição (todas as de antes, e a criada depois pela linha em branco do fim) segue a regra antiga, depois das posicionadas: a nova entra embaixo e fica embaixo.
- **"Inserir linha acima"**, como o "Inserir" do Excel: com ele chega-se a qualquer lugar (o topo e o meio; o fim é a linha em branco de sempre). Abre uma linha em branco logo acima, já no campo da atividade. Enter cria e a linha em branco continua aberta para a próxima, que entra logo abaixo da criada; sair da linha depois de criar, Esc ou "Cancelar" fecham. No celular, o cartão "Nova linha acima de …" tem "Inserir" e "Cancelar".
- **Arrastar pela alça ⠿** do começo da linha (HTML5 drag and drop, com o filete azul indicando se cai em cima ou embaixo). Com a alça em foco, as setas ↑ e ↓ movem uma posição e o foco acompanha a linha. No celular não há arrasto: o cartão ganhou setas de subir e descer.
- **Só na semana analisada e para quem edita a semana**, como a linha em branco: nas vizinhas não há alça nem inserir. Semana encerrada: só admin (`guardWeek`, a mesma trava das outras edições de linha).
- **"Organizar por empresa" e o funil continuam só da tela**; a faixa da ordem passa a dizer isso e oferece "Salvar esta ordem" (grava) e "Voltar à ordem salva" (antes "Voltar à ordem de inclusão").
- **Linha que muda de semana perde a posição** e entra embaixo da semana nova.

### O que mudou

- `src/domain/commitment-order.ts` (novo): a ordem saiu da tela para o domínio, porque o servidor precisa numerar exatamente como a tela mostra. `sheetOrder` (posição, depois inclusão, depois empresa e início para o lote importado), `byCompany`, `orderPositions` (linha da semana fora da lista vai para o fim; id de outra semana é ignorado), `insertionOrder` e `placeBefore`. `compareText` mora aqui e `sheet-view.ts` o reexporta.
- `commands.ts`: `create_commitment` aceita `beforeId` e `order` (a ordem da tela, sem a linha nova; sem ela, vale a salva). Referência que sumiu nesse meio-tempo não é erro: a linha entra embaixo. Comando novo **`reorder_commitments`** (`workId`, `weekStart`, `ids`), com até 2.000 ids, liberado para quem não é desenvolvedor (`module-access.ts`), lendo só a semana (`command-scope.ts`). Só as linhas cuja posição mudou são tocadas e viajam na gravação. No histórico, o arrasto guarda a contagem de linhas e não a lista de ids.
- `local-apply.ts`: o arrasto é projetado antes da resposta do servidor, como o apontamento; a inserção numera a semana quando o servidor devolve o id, pela mesma regra (`insertionOrder`).
- `commitments-overview.tsx`: alça na coluna da caixa de marcar (44 px), "Inserir linha acima" ao lado do ✕ (coluna de 56 px), linha em branco no meio (a mesma `BlankRow`/`BlankCard`, com `insert`), faixa da ordem. A ordem da tela (`pinned`) ganhou `session` (ordem só desta tela) e `sig` (as posições salvas): quando outra pessoa reordena, a recarga traz as posições novas e a tela que segue a ordem salva passa a mostrá-las. `mergePinned` (`sheet-view.ts`) põe a linha que a tela ainda não conhece acima da que vem depois dela na ordem salva: a inserida aparece no lugar, mesmo com a ordem classificada.
- Desfazer: arrasto (volta a ordem anterior), linha inserida (apaga) e **exclusão**, que agora devolve a linha ao mesmo lugar (`recreateCommand` manda `beforeId` com a linha que vinha logo abaixo).
- Migração **`0036_commitment_order.sql`**: coluna `order_index integer` e `commit_planning` reescrita (cópia da 0031 com a coluna no upsert). Sondagem em `migrations.ts`; bootstrap regenerado (36 migrações).
- Tour "Como usar" (passos "Arrastar a linha" e "Inserir linha acima"; textos de ordem, filtros e exclusão) e a ajuda "Como funciona" da tela.

### Validação (30/10/2026)

- `tests/commitment-order.test.ts` (13 testes): ordem salva, inserir na ordem da tela e na salva, referência que sumiu, arrasto que só toca o que mudou, trava da semana e papel, troca de semana, recorte de leitura, projeção local igual à do servidor, `mergePinned` e ida e volta de `order_index` (inclusive banco sem a coluna). 759 testes, `typecheck`, `lint` (sem aviso novo) e `format:check` passando.
- `npm run validate:migrations` (PGlite): `commit_planning` grava `order_index` e `planning_snapshot` o devolve. `node scripts/validate-bootstrap-sql.mjs`: OK. Ele falhava antes desta mudança por contar 39 tabelas: a 0035 criou 3 e o número não tinha sido atualizado. Passou para 42.
- No navegador (prévia temporária em `/campo/`, já apagada, com as APIs respondidas pelo `applyCommand` real): inserir duas linhas seguidas acima da 3ª, Esc fechando, recarga mantendo a ordem, arrastar a última para o topo e a primeira para baixo da terceira, seta ↓ na alça (o foco seguiu a linha), Desfazer do movimento, exclusão desfeita voltando ao mesmo lugar, "Organizar por empresa" + "Salvar esta ordem", e no celular as setas do cartão e o "Inserir". A ordem gravada no servidor bateu com a tela em todos os passos. Nenhum erro no console.

### Pendências

- **0036 aplicada pelo usuário no `takt-hub` em 30/10/2026**, antes da publicação (conferir em Configurações → Banco de dados; daqui a leitura de produção foi bloqueada pelo modo automático). Com o código antigo no ar ela não quebra nada: nada manda posição, e as linhas seguem sem ela.
- **Não publicado.** Decisão do usuário (30/10): esperar e publicar junto com a exclusão de obra (0037, outra sessão em andamento) e o manual da Claudia. Até lá o código está só no disco, sem commit.
- Os PDFs seguem as ordens próprias deles ("por empreiteiro" ou "por início"), não a da planilha. Se a obra quiser o PDF na ordem arrastada, é uma terceira opção no diálogo de impressão.
- A Claudia lista a semana pela ordem de inclusão (`agent-tools.ts`, `listWeek`), não pela salva. Não foi mexido porque o arquivo está com o trabalho do manual em andamento; a troca é uma linha (`sheetOrder`).
- Duas pessoas arrastando a mesma semana ao mesmo tempo: vale a última gravação, que leva a ordem inteira da tela de quem gravou.

## Curto prazo: painel na primeira página do PDF do fechamento (30/10/2026)

Pedido do usuário: "no relatório de fechamento colocar na primeira página um dashboard com o PPC da semana comparado com as semanas anteriores, o PPC geral da obra comparado com as outras obras e as principais causas", mais um ranking dos PPCs das obras. Antes de implementar, ele pediu o modelo da tela. O modelo foi entregue como página publicada (dados de exemplo) e aprovado sem mudanças ("adorei, pode seguir com ele"). O usuário falou em fechamento "mensal", mas o PDF que existe é o semanal ("Resultados Semana N"), e foi nele que o painel entrou.

### Decisões (todas do modelo aprovado)

- **Só no PDF do fechamento, na página 1**, com a planilha de resultados a partir da página 2. O PDF do planejamento não muda. Na janela do PDF entrou a caixa "Painel na primeira página", só no fechamento e já marcada; desmarcada, o PDF sai como antes. Na URL da impressão, só a caixa desmarcada aparece, como `painel=0`: sem o parâmetro, o fechamento sai com o painel (correção de 31/10/2026, abaixo).
- **O painel considera sempre a obra inteira.** Os empreiteiros desmarcados na janela saem só da planilha; se o painel seguisse o recorte, a comparação com as outras obras deixaria de valer. Com recorte, o rodapé diz quem ficou fora da planilha.
- **Nada depois da semana analisada:** série, médias, Pareto e ranking contam só até ela, para o PDF de uma semana antiga sair igual depois.
- **Série:** as 12 semanas com linha até a analisada, como a da tela Fechamento: barra hachurada para semana em aberto, fora da média, e faixa âmbar na analisada. "Média das últimas 12 semanas" é a média simples dos PPCs semanais apurados, como o cartão da tela Fechamento (âmbar abaixo de 70%).
- **PPC geral = cumpridos ÷ assumidos de todas as semanas apuradas desde o início da obra**, somando as linhas e não fazendo a média dos percentuais. É o que ordena o ranking.
- **Ranking:**
  - mostra todas as obras ativas pelo nome, para qualquer pessoa com obra liberada. De outra obra só saem números agregados (PPC geral, semanas apuradas e PPC da semana), nunca linhas, empreiteiros ou justificativas;
  - a obra do PDF entra mesmo inativa, e obra sem nenhuma linha até a semana fica fora;
  - obra com menos de 4 semanas apuradas aparece no fim, "em início", sem posição;
  - empate exato divide a posição;
  - a coluna da semana usa o mesmo período do calendário, porque cada obra tem a sua semana 1;
  - a folha mostra até 7 obras; se a obra do PDF ficar de fora, ela entra na 7ª linha, e a legenda diz quantas ficaram fora, todas contadas na média.
- **Causas em dois recortes:** as da semana, com a posição de cada uma no Pareto da obra, e o Pareto da obra até a semana, com as causas que somam 80% em vermelho e as demais agrupadas em "Outras N causas".

### O que mudou

- `src/domain/closing-ranking.ts` (novo, puro): `workPpc` (PPC geral e da semana de uma obra até a semana), `rankWorks`, `buildRanking`, `withLocalWork` e `rankingMean`. O PDF troca a linha da própria obra pelo cálculo com os dados que já carregou (`withLocalWork`), para o painel e o ranking nunca mostrarem números diferentes da mesma obra.
- `GET /api/curto-prazo/ranking?semana=&obra=` (`src/app/api/curto-prazo/ranking/route.ts`):
  - lê `works` e só `work_id, week_start, fulfilled` de `weekly_commitments` até a semana, de todas as obras, pelo service role. A primeira página traz a contagem, e as demais páginas de 1000 linhas vêm 6 por vez;
  - exige perfil com obra liberada;
  - qualquer falha depois da autorização responde 200 com `available: false`, como a rota do tempo.
- `src/modules/curto-prazo/closing-dashboard.ts` (novo, puro): monta o painel (série, semana anterior apurada, média, causas, posição) e escreve a frase de resumo em trechos, comparando os valores já arredondados para a frase nunca contradizer os cartões.
- `src/modules/curto-prazo/print-dashboard.tsx` (novo):
  - a folha em si: cabeçalho igual ao da planilha, resumo, quatro cartões, série, ranking, causas da semana, Pareto e rodapé;
  - altura fixa de 732 px dentro da área útil de A4 paisagem com 7 mm de margem (1069 × 741 px), e quebra de página depois;
  - cores fixas, porque é papel.
- `print-sheet.tsx`: com o painel ligado no fechamento, busca o ranking e espera a resposta antes de chamar a impressão, como já fazia com o tempo, com limite de 8 s; passou disso, o painel sai com "Ranking das obras indisponível no momento". A página `imprimir/curto-prazo/[obraId]` lê o `painel`, e `print-dialog.tsx` ganhou a caixa.
- Manual da Claudia (`curto-prazo-pdf-impressao`): a caixa da janela e a seção "O painel na primeira página do fechamento".
- **Nenhuma migração.**

### Validação (30/10/2026)

- `tests/closing-dashboard.test.ts`, com 10 testes:
  - PPC geral ponderado e só com semanas apuradas;
  - ranking com empate e obras em início;
  - obra sem linha e semanas posteriores fora;
  - troca da linha da própria obra;
  - o cenário do modelo aprovado, com a frase exata;
  - semana em aberto, sem ranking, empate de causas, semana sem falhas, falha sem causa e falha única;
  - chamada do Pareto, corte "Outras" e ranking que cabe na folha.
- A bateria do CI passou: `typecheck`, `lint` (nenhum aviso nos arquivos novos ou alterados), `format:check`, 774 testes, `validate:migrations` e `build` e o teste de fumaça no navegador (8 de 8).
- Renderização no Chromium com um harness fora do repositório: o componente com dados de exemplo, impresso em A4 paisagem com margem de 7 mm, em três cenários (o do modelo; semana em aberto com 13 obras e nome longo; ranking indisponível). Nos três, o painel ocupou uma folha só e nenhum quadro cortou conteúdo. O harness achou dois defeitos, já corrigidos: as barras do ranking não apareciam e o Pareto e o ranking com muitas obras passavam da altura do quadro.
- **Não validado:** a rota contra o banco real e o PDF gerado pelo botão no sistema. Desta máquina a sessão não alcançou o Supabase (`fetch failed`), então o tempo da rota com o volume real (todas as obras, ~6 mil linhas só na Blentt) não foi medido.

### Pendências

- **Sem commit e não publicado.** O código está só no disco, junto com o trabalho de outras sessões (ordem das linhas, exclusão de obra, manual da Claudia).
- Conferir no sistema: gerar o PDF do fechamento de uma semana encerrada da Blentt e comparar os números com a tela Fechamento (série, média e Pareto devem bater; a tela conta também as semanas posteriores, o PDF não).
- Se a rota ficar lenta com o volume real, o próximo passo é uma função SQL que agregue por obra e semana (exigiria migração). Um cache curto também ajudaria, mas faria a linha das outras obras ficar até alguns minutos atrás.

### Correção de 31/10/2026: fechamento sem o painel

Um engenheiro mandou um PDF do fechamento sem o painel na manhã seguinte à publicação (`65cd066`, 30/10/2026). O deploy estava no ar: os arquivos estáticos da página de login mudaram depois do push. A causa era outra:

- o sistema recarrega os dados da aba aberta, mas não o código;
- quem estava com a planilha aberta desde antes do deploy usava a janela antiga do PDF, que não manda o parâmetro do painel;
- a página de impressão, que abre numa aba nova e já com o código novo, exigia `painel=1` e por isso saía sem o painel.

A regra foi invertida: no fechamento, o painel sai sempre, e só a caixa desmarcada (`painel=0`) o tira. Funciona também a partir de uma aba antiga.

## Etapa — Linha de Balanço no estilo Prevision e medições fotográficas (04/11/2026)

Pedido do usuário em 04/11/2026: no longo prazo, "dois planejamentos": a Linha de Balanço parecida com o Prevision, com uma ferramenta para criar **fluxo de serviços** e facilitar o lançamento na Linha de Balanço, e a **interface de medição** do Prevision, para medições fotográficas dos serviços.

Seguindo o combinado de 30/10/2026, o modelo de UX foi publicado antes do código (<https://claude.ai/artifact/PQq34sq1UaWSw3WUTPnMi6>: cinco telas com dados de exemplo e 28 regras numeradas). O usuário aprovou sem mudanças ("adorei, pode seguir"), e a implementação seguiu as 28 regras. **Migração 0038 aplicada no `takt-hub` em 04/11/2026; código commitado e publicado no mesmo dia, junto com o dashboard da aba 0.**

### O que a aba 1 mostra agora

Cinco visões, trocadas no cabeçalho (`?visao=`), em `src/app/(app)/obras/[obraId]/longo-prazo/page.tsx`:

- **Linha de Balanço** (padrão, `src/modules/longo-prazo/lob/lob-view.tsx`): blocos por serviço × local, locais de baixo para cima, tempo com meses e segundas-feiras, parte medida cheia e parte a fazer clara, contorno vermelho nos atrasados, linhas de hoje e das medições (M1, M2…), sobreposição da linha de base escolhida. Arrastar empurra as sucessoras e nunca entra antes das predecessoras; setas do teclado movem um dia útil; desfazer (botão e Ctrl+Z) reverte as mudanças de datas da sessão. Filtros de serviço, local e período, zoom Semana/Mês/Trimestre, tecla H, tabela ordenável, lista de atrasos, indicadores (serviços, locais, término × linha de base, avanço físico × previsto), painel do bloco selecionado (início, duração, equipe, unidade, observação, predecessoras com espera e "equipe segue", sucessoras que acompanham, atraso com motivo, datas reais, fotos), gaveta de locais, gaveta de linhas de base (criar, comparar, restaurar, excluir), "Importar do Planejador" e exportar CSV. Gráfico em `lob-chart.tsx` e `lob-model.ts`, tabela em `lob-table.tsx`, painéis em `lob-activity-panel.tsx`, `lob-locals-panel.tsx`, `lob-baselines-panel.tsx`.
  - **Painel "Atividade selecionada" acima do gráfico (11/11/2026, pedido do usuário):** o painel saiu da lateral (coluna fixa de 320 px) e fica entre os indicadores e o gráfico, que passou a usar a largura toda. O conteúdo é o mesmo, em até três colunas conforme a largura do próprio painel (dados do bloco; dependências, sucessoras e observação; situação, datas reais, fotos e exclusão). Como o painel cresce ao selecionar e empurra o gráfico para baixo, o `click` que vem depois do soltar do ponteiro caía fora do bloco e desfazia a seleção: `lob-chart.tsx` passou a ignorar esse clique. Validado no navegador com obra de exemplo e API simulada (1300 px e 400 px): sem seleção, bloco selecionado, sem rolagem horizontal. Não verificado na tela real logada.
- **Fluxos de serviços** (`flows-view.tsx`, `flow-editor.tsx`, `flow-network.tsx`): lista dos fluxos da empresa com as obras em que cada um foi lançado; editor com nome, sentido padrão, rede desenhada a partir das predecessoras e tabela (nome, cor, duração por local em dias úteis, equipe com sugestões das equipes da obra, unidade, "Depois de" com espera), salvamento automático 1 s depois com trava de revisão, duplicar, excluir e "Lançar na Linha de Balanço".
- **Lançar fluxo** (`lob-launch-dialog.tsx`): fluxo, locais marcados, início, sentido e ritmo (contínuo, takt fixo, todos juntos), com prévia calculada no navegador pela mesma função do servidor (`planLaunch`), aviso dos blocos mantidos e da linha de base automática.
- **Medições** (`measurements-view.tsx`, `measurement-sheet.tsx`, `measurement-photos.tsx`): rodadas, avanço físico, folha com abas Atuais/Futuras/Concluídas, agrupada por local, previsto até a data, anterior, realizado acumulado com atalhos, desvio, datas reais e ações (fotos, observação, motivo do atraso, histórico). No celular (abaixo de 768 px) a folha vira um local por vez, com cartões, − e + de 5 em 5, "Tirar foto" (câmera traseira) e "Galeria". As fotos são comprimidas no navegador pelo mesmo `compressImage` da Terminalidade e sobem direto ao Storage por URL assinada.
- **Vagões e restrições** e **Planejador**: como antes. O Planejador continua responsável por "Gerar vagões" (regra 1).

### Onde o dado fica

- `src/domain/lob.ts`: tipos e regras puras (dias úteis, cascata, lançamento, previsto, atraso, avanço físico, medições, importação do Planejador).
- `src/application/use-cases/lob-commands.ts`: 26 comandos, que recebem os dados de uma obra e devolvem o que gravar, como a Terminalidade.
- `src/infrastructure/repositories/supabase/lob-repository.ts` e as rotas `GET /api/lob`, `POST /api/lob/commands`, `GET/POST/PUT/DELETE /api/lob/flows` e `POST/DELETE /api/lob/upload-url`. Todas exigem o módulo "Longo prazo" (`/api/lob` entrou em `RESTRICTED_API_PREFIXES`); consulta só lê.
- **Migração 0038** (`0038_lob.sql`, criada e **aplicada no `takt-hub` em 04/11/2026**, por conexão direta ao banco numa transação; conferidos as 10 tabelas, o `grant` para `service_role`, o bucket e a leitura pela API REST): `service_flows` (da empresa, sem obra), `lob_locals`, `lob_services`, `lob_launches`, `lob_activities`, `lob_dependencies`, `lob_baselines`, `lob_measurements`, `lob_measurement_items`, `lob_photos` e o bucket privado `medicoes` (JPEG até 2 MB). Fora do snapshot, não reescreve `commit_planning`, reexecutável. Sem ela, só as três visões novas respondem "indisponível". As tabelas da obra têm `on delete cascade` a partir de `works`, então o `delete_work` da 0037 leva tudo junto sem ser reescrito, e a rota de exclusão apaga também a pasta da obra no bucket `medicoes` (`work-files.ts`). Uma medição aberta por obra é garantida por índice único parcial. Sondagem nova na tela de saúde do banco; bootstrap regenerado (38 migrações) e `conferencia.sql` com as 10 tabelas e o bucket.

### Decisões de implementação (onde o modelo não dizia)

- Tudo em dias úteis, segunda a sexta, sem feriados (regra 5; desde 23/11/2026 o calendário é por obra, com esse padrão). O fim do bloco é exclusivo; o término mostrado é o último dia trabalhado.
- Atraso: previsto até hoje menos medido ≥ 10 pontos, e nunca em bloco a 100%. O limiar evita marcar em vermelho tudo o que andou na semana desde a última medição.
- Importar do Planejador: cada pavimento vira local, cada serviço × pavimento um bloco com a data atual; a espera do Planejador (dias corridos) vira dias úteis e nunca passa da folga real entre os blocos, para a importação não empurrar nada; nomes repetidos ganham sufixo "(2)". Só funciona com a Linha de Balanço vazia.
- Linha de base automática "Antes do lançamento dd/mm/aaaa", com sufixo se houver duas no mesmo dia. O lançamento devolve quantos blocos entraram e quantos foram mantidos.
- Medições: cada valor é gravado ao sair do campo (não há botão "Salvar rascunho"); campo vazio é recusado em vez de virar 0%; esvaziar um lançamento existente o remove, com confirmação; motivo ou observação num bloco não lançado cria o lançamento com o valor anterior. Corrigir a última medição já salva preenche as datas reais como o fechamento; excluir uma medição desfaz as datas reais iguais à data dela que nenhuma outra medição sustenta; numa medição já salva, a única foto de um avanço não pode ser excluída.
- Indicadores e contagem de atrasos são da obra inteira, não dos filtros.
- Fluxo: novo serviço já entra ligado ao último (para manter um só serviço inicial); "Lançar" fica desabilitado enquanto há alteração não salva; falha de rede no salvamento não tenta de novo sozinha.

### Correções feitas pela bateria de testes

O agente de testes achou quatro defeitos, todos corrigidos com teste: `isLocalDate` (`long-term-plan.ts`, também usado pelo Planejador) estourava `RangeError` com mês 13 ou dia 32 em vez de devolver falso; a importação do Planejador usava a espera em dias corridos como dias úteis e empurrava blocos no primeiro arrasto; a importação criava locais ou serviços homônimos que a 0038 recusaria; campo vazio virava 0%. Também: fluxo com serviço dependente de si mesmo passava pela trava de lançamento, e "12 meses" eram 360 dias.

### Validação (04/11/2026)

- Sequência do CI inteira: `typecheck`, `lint` (nenhum aviso nos arquivos novos), `format:check`, `npm test` com 908 testes (75 novos em `tests/lob.test.ts` e `tests/lob-commands.test.ts`, mais a semente da exclusão de obra com as tabelas da 0038), `validate:migrations`, bootstrap (77 de 77 itens), `build` e o teste de fumaça (8 de 8).
- **Navegador**: `next dev` local apontado para um Supabase falso (só o perfil) e as rotas `/api/*` respondidas no Playwright pelas regras reais do domínio, com uma obra de exemplo de 14 locais, 8 serviços, 112 blocos e 3 medições salvas com fotos. Conferidos em 1440 px e 400 px: Linha de Balanço, lista de atrasos, seleção e painel, arrasto (término de 18/03/2027 para 22/04/2027 com as sucessoras empurradas), tabela, lançamento de um segundo fluxo pelo endereço `?lancar=` (linha de base automática gravada), fluxos, medição (dois valores gravados, "Salvar" travado por avanço sem foto, foto enviada pelo diálogo) e a folha no celular. Nenhum erro de console. A conferência achou e corrigiu dois defeitos de layout: a tabela do fluxo empurrava a página 115 px (textos só para leitor de tela escapando do contêiner rolável) e, no celular, as três grades não encolhiam até a tela.
- **Não validado**: gravação real pelas telas (a 0038 foi aplicada e as tabelas respondem pela API, mas nenhum fluxo foi lançado em obra real), envio real de foto ao Storage, dois usuários editando o mesmo fluxo (409), e celular de verdade com câmera.

### Fontes consultadas sobre o Prevision

Artigos do suporte (suporteprevision.freshdesk.com): "Criando um Macrofluxo", "Como lançar o macrofluxo no Cronograma?", "Análise e ajustes do planejamento em linha de balanço" e "Como fazer medição física da obra". Deles saíram: macrofluxo criado pelo administrador e lançado por usuário normal; lançamento por lote com backup automático; sentido topo → base ou base → topo definido no pacote; macrofluxo e cronograma independentes depois do lançamento; medição com data retroativa, atividades atuais e futuras (12 meses), acumulado que não pode cair, atalhos "igualar ao previsto" e "100%", coluna de ações com imagens, observações e motivos de atraso, início e término reais digitados, data travada depois de salvar; na Linha de Balanço, barra azul-escura nas medições, azul-clara em hoje, arrastar replaneja as sucessoras, atalhos de seta, +, −, H e Ctrl+Z.

### Pendências

- Conferir no ar: abrir a aba 1 de uma obra logado e ver as três visões novas sem o aviso de "indisponível".
- Primeiro uso real: cadastrar os locais, criar o fluxo da empresa e lançar numa obra, ou importar o plano do Planejador de uma obra que já o tem.
- Etapa 3, a combinar (regra 27): "Gerar vagões" a partir da Linha de Balanço (e então tirar o Planejador), datas marco, edição em lote, medição sem sinal (fila no aparelho, como a Terminalidade), importar o cronograma do Prevision direto para a Linha de Balanço, "Importar .xml do Project" na tela de fluxos e o PDF da medição.
- O dashboard da aba 0 (outra sessão, também só no disco) lê o longo prazo do Planejador (`/api/long-term-plan`), não da Linha de Balanço: quando a Linha de Balanço virar a fonte, o quadro de longo prazo do dashboard deve passar a ler `/api/lob` (blocos, medições e avanço físico).
- Lacunas conhecidas: corrigir para cima um valor da última medição já salva não exige foto no servidor (a tela marca em âmbar); o motivo do atraso é pedido pela tela, mas o servidor não o exige; não há limpeza periódica de fotos órfãs no bucket (mesma pendência da Terminalidade); o takt padrão do diálogo de lançamento é 10 dias úteis, sem ler a sequência de vagões.

## Médio prazo: tabela do cronograma com altura de tela no notebook (04/11/2026)

**Pedido do usuário:** "o campo de adição de informações no médio prazo está muito pequeno", com print da Essenza num notebook: a tabela e o Gantt mostravam cinco linhas.

### Causa

A área de trabalho (barras, Linha do Tempo, visão e barra de status) era medida do lugar dela até o pé da janela, para a barra de status ficar à vista sem rolar (correção "barra de status abaixo da dobra", 21/10). Com o cabeçalho da aba acima, numa janela de cerca de 800 px de altura, o que sobrava para a visão era menor que o piso `MIN_VIEW` (200 px), e a visão ficava presa nele: cinco linhas e meia.

### O que mudou (`schedule-sheet.tsx`)

- Se, medida do lugar dela, a área de trabalho deixa a visão com pelo menos `COMFORT_VIEW` (360 px, cerca de 11 linhas), nada muda: monitor grande continua com a barra de status à vista sem rolar.
- Abaixo disso, a área de trabalho passa a ter a altura de uma tela inteira, descontada a barra fixa da trilha (medida: elementos `sticky` filhos do contêiner que rola). Rolando a página até o cronograma, a tabela ocupa todo o espaço livre e a barra de status fica no pé da tela.
- `MIN_VIEW` continua valendo para janela baixa demais até para isso.

### Validação (04/11/2026)

- Typecheck, ESLint (sem aviso novo; os dois avisos do arquivo já existiam) e Prettier no arquivo.
- A regra rodou em Chromium headless numa maquete do layout (barra fixa da trilha, cabeçalho da aba, área de trabalho com as faixas do print), fora do repositório: em 1470×800 a visão foi de 200 px para 357 px (de ~5 para ~11 linhas) e a área de trabalho cabe na tela depois de rolar; em 1920×1000, de 318 para 557 px; em 2560×1360 ficou igual (678 px).
- **Não foi aberta no app logado.**

### Pendências

- Conferir logado no notebook, na Essenza: rolar até o cronograma e ver a tabela até o pé da tela.
- Se o pedido era o campo "Anotações e encaminhamentos" do painel de detalhes (hoje com altura mínima de 96 px), aumentá-lo é outra mudança, não feita aqui.

## Longo prazo: Gantt de legalização na aba 1 (04/11/2026)

Pedido do usuário em 04/11/2026: no longo prazo, um botão de "Gantt de legalização/terminalização": nos 12 meses até a entrega da obra, um Gantt com o caminho crítico da obra e a legalização.

Seguindo o combinado de 30/10/2026, o modelo de UX foi publicado antes do código (<https://claude.ai/artifact/EtzWbULbk4K2Qk1pEQa93j>: o Gantt com dados de exemplo, o diálogo de criação, o "Trazer da Linha de Balanço", 18 regras numeradas e as próximas etapas A–C). O usuário aprovou sem mudanças ("pode seguir"), e a implementação seguiu as 18 regras. **Nenhuma migração.** Commitado e publicado (push para `main`) em 05/11/2026, a pedido do usuário.

### O que a aba 1 mostra agora

- Visão nova **Gantt de legalização** (`?visao=legalizacao`) na barra de visões da aba 1, depois de Medições. A aba passa a ter seis visões.
- **Sem Gantt na obra:** o botão "Criar Gantt de legalização" abre o diálogo com a entrega contratual, a janela que sai dela, "Modelo ATR de legalização" ou "Em branco", a caixa "Trazer também os serviços da Linha de Balanço que passam pela janela" (marcada; o botão vira "Criar e revisar a Linha de Balanço" e a lista do "Trazer" abre sozinha uma vez depois de criar), a prévia (primeira tarefa, entrega prevista, críticas, calculadas no navegador com o mesmo `buildLegalizationTasks` e o motor) e o nome opcional. O perfil de consulta vê o estado vazio sem o botão.
- **Com Gantt:** o mesmo componente do cronograma do médio prazo (tabela e Gantt no layout do Project, motor conferido no Project 2019, restrições, prazo final, caminho crítico, linha de base, desfazer, "Informações da tarefa", exportação .xml, rascunho e "Revisar e salvar" com motivo), com título próprio, a janela de 12 meses sombreada no Gantt, o filtro e o indicador "Fora da janela" no lugar de "Fora do horizonte" (sem a faixa amarela de aviso: tarefa antes da janela é normal, regra 6), o indicador LB nas linhas trazidas da Linha de Balanço, o zoom inicial em meses e a coluna "Folga total" visível por padrão (valem até a pessoa guardar as preferências dela).
- **Resumo no topo:** cinco cartões ("Entrega contratual"; "Entrega prevista", com os dias úteis depois ou antes do prazo; "Caminho crítico", com as tarefas críticas e a folga total do marco da entrega; "Marcos de legalização", cumpridos de quantos; "Próximo marco", que seleciona a tarefa no cronograma) e, quando a entrega prevista passa do prazo, o aviso vermelho "A entrega prevista passa N dias úteis do prazo. O que empurra: …", com os nomes da cadeia clicáveis e a folga que a obra em si ainda tem, quando tem.
- **"Alterar entrega"** (no lugar do seletor de mês, com "Salvar entrega") troca a data contratual e, se quiser, o nome; a janela anda junto e o prazo final do marco que estava na entrega antiga vai para a nova. As tarefas não mudam de data. Grava direto no banco, então fica travado com rascunho aberto ("Salve ou descarte o rascunho antes de alterar a entrega."): o "Revisar e salvar" seria recusado por o cronograma ter mudado por fora. Gantt gravado sem entrega válida abre só um aviso com "Informar a entrega".
- **"Trazer da Linha de Balanço"** (na barra de ferramentas) busca a Linha de Balanço a cada abertura e mostra um resumo por serviço ("Locais", "Início (1º local)", "Término (último)", "% medido" e "No Gantt": "Linha nova · LB", "Atualiza a linha LB" ou "Fora da janela"); "Trazer N linhas" leva os marcados para o rascunho num passo só do desfazer e avisa quantas linhas entraram e quantas foram atualizadas. Fica travado com célula em edição ou gravação; obra sem blocos recebe o convite para lançar um fluxo; se o Gantt tem "Acabamentos internos dos apartamentos", um aviso sugere apagá-la quando as linhas LB a cobrirem.
- **Fora do resto do sistema (regra 17):** o Gantt e as tarefas dele não aparecem na lista de cronogramas do mês, em "Próximos 90 dias" e "Cobertura", em Recursos e na carga das equipes, na variação contra linha de base do médio prazo, no quadro do médio prazo do dashboard nem para a assistente (briefing e ferramentas).

### Decisões (as 18 regras do modelo, resumidas)

- **Onde fica e como funciona.** (1) Botão na barra de visões da aba 1, depois de Medições, com `?visao=legalizacao` no endereço. (2) É o mesmo cronograma do médio prazo, sem motor novo. (3) Um Gantt por obra, vivo até a entrega; linha de base quando a pessoa clicar. (4) Mesma gravação e mesmos papéis do médio prazo: rascunho e "Revisar e salvar" com motivo; consulta só vê; planejador, gerente e admin editam; quem vê a aba 1 vê o Gantt.
- **Entrega e janela.** (5) A entrega contratual vira o "Prazo final" do marco "Entrega das chaves", não uma restrição "Deve terminar em": passando dela, o marco fica vermelho e a folga negativa mostra o atraso. (6) Janela de 12 meses antes da entrega, sombreada e usada no zoom inicial; tarefa pode começar antes dela. (7) A tolerância de 180 dias do contrato não entra no cálculo.
- **Caminho crítico.** (8) Ligado por padrão, com a coluna "Folga total" à mostra; crítica é folga total ≤ 0, como no Project. (9) Cinco números no topo; marco de legalização é toda tarefa de duração zero dentro do grupo "Legalização". (10) Aviso vermelho com a cadeia quando a entrega prevista passa do prazo.
- **Modelo pronto.** (11) "Modelo ATR de legalização" com 38 linhas: o caminho crítico da obra, a legalização por órgão (Corpo de Bombeiros, concessionárias, elevadores, Prefeitura, Receita Federal, cartório e condomínio) e o marco da entrega; esperas de órgão em dias corridos; "Em branco" continua disponível. (12) Montado de trás para frente: as tarefas sem predecessora ganham "Não iniciar antes de" calculado a partir da entrega; daí em diante o motor agenda para frente. (13) O órgão é a linha de resumo, sem coluna nova. (14) Responsável na coluna "Nomes dos recursos", com as equipes da obra.
- **Linha de Balanço.** (15) "Trazer da Linha de Balanço" cria uma linha por serviço, com início do primeiro local, término do último e % medido, no grupo "Caminho crítico da obra", com indicador LB e "Não iniciar antes de" no início da Linha de Balanço. (16) Trazer de novo atualiza só as linhas LB (início, duração, %); não sincroniza sozinho.
- **Fora do resto do sistema.** (17) Nesta etapa o Gantt fica só na aba 1. (18) Sem migração: o tipo e a data de entrega vão no `schedule_meta` que já existe.

### Decisões de implementação (onde o modelo não dizia)

- **Gravação:** o Gantt é um `MediumTermPlan` com `kind: 'legalizacao'` e `deliveryDate` no `schedule_meta`; a tarefa trazida da Linha de Balanço guarda `lobServiceId` no `schedule_meta` dela. O `month` obrigatório recebe o mês em que a janela começa. `create_plan` ignora o Gantt na regra de um cronograma por mês e recusa copiar dele ("Copie de um cronograma do mês, não do Gantt de legalização."). Um segundo Gantt na mesma obra é recusado ("Esta obra já tem um Gantt de legalização.").
- **Janela:** do dia seguinte à mesma data 12 meses antes até a entrega (entrega 30/09/2027 → 01/10/2026 a 30/09/2027); dia 31 num mês curto vira o último dia do mês.
- **Modelo ATR:** 38 linhas e 38 vínculos, os da tela 1 do modelo (a tela 2 dizia "41 vínculos"; era erro de texto). A origem começa cerca de 280 dias úteis antes da entrega e é corrigida em até 8 rodadas até o marco cair na entrega, ou no dia útil anterior quando ela cai em fim de semana ou feriado, para o Gantt não nascer atrasado. O modelo nasce com 0% em tudo e sem equipes.
- **"Em branco":** só o marco "Entrega das chaves" com o prazo final (a tela 2 do modelo citava também a linha de resumo).
- **Resumo:** o marco da entrega é a tarefa com prazo final igual à entrega, preferindo o marco (duração zero) quando outra tarefa também tem esse prazo (sem nenhuma, o marco com "entrega" no nome); o atraso em dias úteis usa o calendário do cronograma (feriados); a cadeia segue as predecessoras determinantes a partir dele, preferindo as críticas e de menor folga, sem os marcos intermediários, para caber numa linha; marcos de legalização são as tarefas de duração zero abaixo da linha de resumo "Legalização" (comparada sem acento nem caixa), e cumprido é 100%; o próximo marco é o primeiro não concluído com início a partir de hoje.
- **Trazer da Linha de Balanço:** % medido = blocos ponderados pela duração, pela última medição fechada. Vêm marcados os serviços que tocam a janela, inclusive os que começam antes do fim dela e terminam depois (a regra 15 falava só nos que terminam dentro); os textos da tela dizem "que passam pela janela". Início no dia útil seguinte quando cai em fim de semana, duração em dias úteis do primeiro ao último dia, % acima de zero preenche o início real e 100% o término real. Linhas novas entram no fim do grupo "Caminho crítico da obra", um nível abaixo dele (sem o grupo, no fim do cronograma), sem vínculos. A linha é reconhecida pelo serviço de origem, então renomeá-la não quebra a atualização.
- **Alterar entrega** (`update_legalization_plan`): leva junto só o prazo final que estava na data antiga; outros prazos finais ficam. Recusado em linha de base.
- **Linha de base:** `freeze_plan_baseline` copia o tipo e a entrega para a linha de base, que também fica fora do médio prazo. A exclusão (`delete_plan`) é a do médio prazo e recusa plano com linha de base salva.
- **Acesso:** `create_legalization_plan` e `update_legalization_plan` são da seção `longo-prazo`; `save_plan_revision`, `freeze_plan_baseline` e `delete_plan` foram liberados também para ela. Ressalva registrada no código: esses três comandos não distinguem o tipo do plano antes de ler o banco, então quem tem só a aba 1 poderia, por chamada feita à mão, gravar um plano do mês. Aceito por enquanto (mesma equipe).

### Arquitetura

- `src/domain/legalization.ts` (novo, funções puras): tipo e filtros (`isLegalizationPlan`, `isMonthlyPlan`, `legalizationPlanIds`, usados no isolamento da regra 17), janela (`legalizationWindow`, `legalizationMonth`), modelo ATR (`LEGALIZATION_TEMPLATE`, `buildLegalizationTasks`), resumo do topo (`legalizationSummary`) e importação da Linha de Balanço (`lobServiceRows`, `applyLobImport`).
- `src/domain/entities.ts` (`MediumTermPlan.kind` e `deliveryDate`, `PlanTask.lobServiceId`) e `src/infrastructure/repositories/supabase/mappers.ts` (os três no `schedule_meta`).
- `src/application/use-cases/commands.ts`: `create_legalization_plan` e `update_legalization_plan`; `create_plan` e `freeze_plan_baseline` passam a conhecer o tipo. `src/application/module-access.ts`: os comandos da seção `longo-prazo`.
- `src/modules/medio-prazo/schedule-sheet.tsx`: `SheetVariant` (título, subtítulo, janela e o nome dela, `headerExtra` no lugar do seletor de mês (como função, enxerga o rascunho: é assim que "Alterar entrega" trava com rascunho aberto), `footerExtra` no lugar de "Novo cronograma do mês", zoom e colunas iniciais, `summary` e `tools`) e `SheetApi` (`canEdit`, `replaceTasks` num passo só do desfazer, `selectTask`). Sem variante, o cronograma do mês segue como estava.
- A visão na página da aba 1 (`src/app/(app)/obras/[obraId]/longo-prazo/page.tsx`: item na barra de visões, descrição e parágrafo no "Como funciona") e os componentes em `src/modules/longo-prazo/legalizacao/`: `legalization-view.tsx` (estado vazio, variante do cronograma, um Gantt vivo por obra), `legalization-summary.tsx` (resumo do topo), `legalization-forms.tsx` (criar e alterar entrega) e `lob-import.tsx` (trazer da Linha de Balanço).
- Isolamento (regra 17), por `isMonthlyPlan` ou `legalizationPlanIds`: lista de cronogramas do mês (`schedule-sheet.tsx`), "Próximos 90 dias" e "Cobertura" (`look-ahead-overview.tsx`), Recursos (`resource-analysis.tsx`, `schedule-analysis.ts`), carga das equipes (`rules.ts`), variação contra linha de base (`baseline-delays.tsx`), quadro do médio prazo do dashboard (`medium-term-panel.ts`) e a assistente (`agent-briefing.ts`, `agent-tools.ts`). Em `resources.ts` (uso da equipe) as linhas do Gantt saem da contagem do médio prazo, mas continuam no total, porque a equipe segue vinculada; as Configurações da obra mostram "N no Gantt de legalização" ao lado de "no médio" e "no curto", para a equipe com o excluir travado não parecer sem uso (`work-resources.tsx`). Em `scope-planning.ts`, quem tem o longo prazo sem o médio prazo recebe só o Gantt de legalização e as linhas de base dele, com tarefas e vínculos; os planos do mês continuam fora.
- Manual da assistente (seção `longo-prazo-gantt-legalizacao`, a visão geral da aba 1 com a visão nova e uma frase na visão geral do médio prazo) e tour da aba 1 (passos com os alvos `longo-legal-criar`, `longo-legal-gantt`, `longo-legal-resumo`, `longo-legal-entrega` e `longo-legal-trazer-lb`; os passos `longo-visoes` e de abertura citam a visão nova).

### Validação (04/11/2026)

- **Testes:** 27 em `tests/legalization.test.ts` (janela; modelo ATR com 38 linhas e 38 vínculos, níveis, restrições, reagendamento idempotente, entrega em sábado, domingo, feriado e em 12 datas de anos diferentes sem o marco passar do prazo; resumo no prazo, com atraso forçado, com feriado e com outra tarefa no mesmo prazo final; `lobServiceRows`; `applyLobImport`; os comandos, inclusive recusas; ida e volta do mapper; acesso por módulo; recorte de `slimForModules`) e 7 em `tests/legalization-isolation.test.ts` (carga de equipe, uso da equipe, carga semanal, quadro do médio prazo do dashboard, briefing e ferramentas da assistente dão o mesmo resultado com e sem o Gantt no mesmo mês; rodado contra as versões antigas, 6 dos 7 falham). O agente de testes achou um defeito, corrigido: o resumo tomava como entrega qualquer tarefa com o prazo final igual à entrega, mesmo sem ser o marco.
- **CI inteiro verde:** `typecheck`, `lint` (0 erros; 1 aviso novo, do mesmo tipo de um que já existia no `schedule-sheet.tsx`), `format:check`, `npm test` (1019 de 1019), `validate:migrations`, `build` e o teste de fumaça no navegador (8 de 8).
- **Navegador** (Playwright, Chromium 1600 px), numa página de prévia temporária fora do layout autenticado, com todas as APIs respondidas pelo Playwright com dados de teste (o `next dev` local não alcança o banco: o `.env.local` deste repositório aponta para o Supabase antigo, que não existe mais): estado vazio, diálogo de criação com a janela 01/10/2026 a 30/09/2027 e a prévia "no prazo · 11 tarefas críticas", criar (um único `create_legalization_plan` interceptado), o "Trazer da Linha de Balanço" abrindo sozinho com Estrutura e Alvenaria fora da janela e Revestimento cerâmico e Pintura marcados, "Trazer 2 linhas" pondo as duas linhas LB no fim do grupo "Caminho crítico da obra", o resumo com a vistoria da prefeitura alongada ("Entrega prevista Dom 10/10/27 · 6 dias úteis depois do prazo", folga total -6, cadeia de elevadores à instituição do condomínio no aviso vermelho), "Alterar entrega" travado com o rascunho aberto, nenhum erro no console. Na mesma página, o cronograma do médio prazo com um plano do mês no mesmo mês do Gantt listou só o plano do mês no seletor. A página de prévia foi apagada.
- **Não validado:** nada foi aberto logado nem gravado no Supabase real; a importação com uma Linha de Balanço real não foi testada.

### Pendências e próximas etapas

- Conferir logado numa obra real: criar o Gantt pelo modelo ATR, editar, "Revisar e salvar", definir linha de base, alterar a entrega e abrir o .xml exportado no Project.
- Primeira importação real: "Trazer da Linha de Balanço" numa obra com blocos lançados e medições salvas, conferindo datas, duração e % das linhas LB, e trazer de novo para ver a atualização.
- Conferir com a equipe a lista e as durações do modelo ATR (regra 11: "é o que mais precisa do seu olho"), em especial as esperas de órgão em dias corridos (Bombeiros 30, Prefeitura 60, cartório 45 + 45, concessionárias 30 a 45).
- Ressalva de acesso: fazer `save_plan_revision`, `freeze_plan_baseline` e `delete_plan` conferirem o tipo do plano antes de autorizar pela seção (ler o plano na rota de comandos), para quem tem só a aba 1 não gravar um plano do mês.
- O resumo e a importação acham os grupos pelo nome: renomear "Legalização" tira os marcos do resumo, e renomear "Caminho crítico da obra" manda as linhas LB para o fim do cronograma.
- Próximas etapas do modelo (não entram agora):
  - **A.** Cartão "Entrega prevista" no dashboard da obra (aba 0) e no dashboard geral.
  - **B.** "Vistoria interna de terminalidade" com o % de pendências resolvidas da aba 5.
  - **C.** PDF do Gantt para a diretoria e anexar o documento emitido (AVCB, Habite-se) à linha do marco.

## Curto prazo: local da linha e filtro de local no PDF (05/11/2026)

Pedido do usuário: "no curto prazo, adicione um campo de local (opcional) para que as tarefas possam ser filtradas por local ao gerar o PDF. O local deve ser o mesmo do longo prazo (lista suspensa que vem de configuração de obra)". Implementado sem modelo de UX (é uma coluna nova e uma seção na janela do PDF, no padrão das que já existem).

### De onde vem a lista

Dos **"Locais da obra" da Linha de Balanço** (aba 1, gaveta "Locais da obra", tabela `lob_locals` da 0038), de cima para baixo como na gaveta. É a lista do longo prazo atual; a gaveta também traz os locais do planejamento dos vagões ("Usar os locais da obra"). A linha guarda o **id** do local (`weekly_commitments.local_id`, migração **0039, criada e não aplicada**): renomear o local muda o nome em todas as linhas, e apagar o local deixa a linha sem local (`on delete set null`). Como `/api/lob` é restrita ao módulo do longo prazo e o curto prazo é aberto a todos, a lista sai de uma rota própria, `GET /api/curto-prazo/locais?workId=` (só id, nome e ordem, para quem tem a obra), lida pelo hook `src/modules/curto-prazo/use-work-locals.ts`. Obra sem local cadastrado: a célula fica travada com a dica "Cadastre os locais em Configurações da obra (Locais da obra)" (até 05/11/2026 a dica mandava para a aba 1; ver a seção seguinte).

### O que mudou

- **Planilha:** coluna **Local** (opcional) entre Atividade e Equipe, lista suspensa com os locais da obra e "(sem local)" para tirar; funil de filtro pelo nome do local, com "(vazias)"; trava igual às outras células da linha (semana encerrada só admin, Consulta só lê). No celular, o cartão ganha o campo, só nas obras com locais.
- **O local acompanha a linha:** "Levar ›" leva o local para a semana seguinte; a alça de preencher copia o local (um `update_commitment` por linha, desfeito de uma vez); o Desfazer devolve o local anterior, inclusive "sem local"; a exclusão desfeita recria a linha com o local. "Inserir linha acima" não herda o local, como as outras colunas.
- **Comandos:** `create_commitment` e `update_commitment` aceitam `localId`; em `update_commitment`, **ausente mantém** o local (telas e chamadas de antes do campo não o apagam) e `null` tira. O servidor só confere o formato (os locais não vêm no planejamento carregado); a chave estrangeira recusa local inexistente. A projeção otimista (`local-apply.ts`) segue a mesma regra.
- **PDF:** a janela antes do PDF ganha a seção **Local** no estilo da lista de empreiteiros (contagem, pesquisa, "(sem local)"), só quando alguma linha da semana tem local; o filtro de coluna Local da planilha vira a seleção inicial. Os desmarcados vão na URL como `excluir-local=<id>` (vazio = "sem local"). A página de impressão filtra por empreiteiro e por local, põe a coluna Local depois de Atividade quando alguma linha impressa tem local e escreve "Local: Torre A, Torre B" sob o título de cada folha. Ela espera os locais carregarem e, com recorte de local e a lista em erro, mostra o erro em vez de imprimir. O painel da primeira página do fechamento continua na obra inteira (o rodapé cita o recorte). Vale para os dois PDFs da janela.
- **Arquivos:** `src/modules/curto-prazo/commitment-local.ts` e `print-options.ts` (puros, novos), `commitments-overview.tsx`, `print-dialog.tsx`, `print-sheet.tsx`, `print-dashboard.tsx`, `undo.ts`, `fill-handle.tsx`, a página de impressão, `local-apply.ts`, `commands.ts`, mappers, `entities.ts`, `migrations.ts` (verificação da 0039), manual da Claudia e tour do curto prazo (passo "Local (opcional)").

### Validação (05/11/2026)

Testes novos: `tests/commitment-local.test.ts` (11), `tests/commitment-local-command.test.ts` (4) e um caso em `tests/local-apply.test.ts`; `npm run validate:migrations` passa com a 0039 (grava o local, recusa local inexistente, apagar o local deixa a linha sem local). Nada foi aberto no navegador logado, o PDF não foi impresso com a coluna, e a gravação real depende de aplicar a 0039.

### Pendências

- **Aplicar a 0039 no takt-hub antes de publicar o código.** Sem ela o código funciona, mas a coluna Local não grava.
- Comando em lote para o local (a alça manda uma gravação por linha); a assistente ainda não lê o local; quem tinha larguras de coluna salvas vê a planilha 128 px mais larga até "Ajustar à tela"; o nome do arquivo do PDF não cita o recorte por local.

## Configurações da obra: cadastro dos locais da obra (05/11/2026)

**Pedido do usuário:** "onde fica o campo para inserir os locais? deveria estar em configuração da obra". Até aqui os locais da coluna Local do curto prazo só se cadastravam na aba 1 (Linha de Balanço → "⋯" → "Locais da obra"), que é restrita ao módulo do longo prazo: quem só tem o curto prazo via a coluna travada e não tinha onde cadastrar.

### O que mudou

- **Seção "Locais da obra"** nas Configurações da obra (`src/modules/configuracoes/work-locals.tsx`), logo abaixo de "Local da obra" (a cidade, que é outra coisa). Mostra os locais do topo para a base e a contagem, ou "Nenhum local cadastrado. Sem locais, a coluna Local do curto prazo fica travada.". O botão "Cadastrar locais" ("Cadastrar e ordenar locais" quando já há algum) abre **a mesma gaveta da Linha de Balanço** (`lob-locals-panel.tsx`, carregada só ao abrir): cadastro em lote da base ao topo, renomear na lista, setas para a ordem, lixeira e "Usar os locais dos vagões". Consulta vê a lista sem o botão.
- **A lista é a mesma** (`lob_locals`, migração 0038, já aplicada): o que se cadastra aqui aparece na Linha de Balanço e na coluna Local do curto prazo, e vice-versa. Nada de banco mudou; **nenhuma migração nova**.
- **Rota própria, aberta:** `GET/POST /api/work-locals` (`src/app/api/work-locals/route.ts`). Lê quem tem a obra; grava quem tem a obra e não é Consulta. Aceita só os quatro comandos do cadastro (`create_locals`, `rename_local`, `reorder_locals`, `delete_local`, filtrados por `parseWorkLocalCommand` em `src/application/use-cases/work-locals.ts`) e aplica as regras de sempre (`planLobCommand`): nome repetido recusado, limite de 300, local com blocos na Linha de Balanço não sai. `/api/lob/commands` continua restrita ao longo prazo.
- **Gaveta:** passou a receber `locals` e `blocksOf` em vez da Linha de Balanço inteira, para servir às duas telas. Textos: descrição "De cima para baixo, como o prédio · valem na Linha de Balanço e no curto prazo"; a confirmação de exclusão sem blocos avisa que as linhas do curto prazo que usavam o local ficam sem local; o botão "Usar os locais da obra" virou **"Usar os locais dos vagões"** (o título da gaveta já é "Locais da obra").
- **Curto prazo:** a dica da coluna sem locais passou a "Cadastre os locais em Configurações da obra (Locais da obra)".
- **Manual da Claudia** (seção "Configurações da obra: semana 1, local da obra e locais da obra", com palavras-chave como "onde cadastro os locais"; curto prazo e longo prazo ajustados) e **tour** das Configurações da obra (passos "Locais da obra" e "Cadastrar e ordenar locais").
- Decisões tomadas sem perguntar, por seguirem o padrão das outras seções da página: quem edita é quem edita o resto das Configurações da obra (todos menos Consulta); a gaveta da aba 1 continua lá. Não houve modelo de UX antes: a seção reaproveita a gaveta que já existia.

### Validação (05/11/2026)

- `tests/work-locals.test.ts` (4 testes: os quatro comandos aceitos, os demais e entrada inválida recusados, a lista de baixo para cima com os blocos, e as regras da Linha de Balanço valendo pela rota nova); manual e tour passam nos testes deles.
- **Navegador:** `next dev` local com o acesso sem login apontado para um Supabase falso (só o perfil) e `/api/planning` e `/api/work-locals` respondidas no Playwright pelas regras reais (`parseWorkLocalCommand`, `planLobCommand`, `workLocalsView`), fora do repositório. Planejador em 1440 px: seção com 3 locais, gaveta aberta, cadastro de "Cobertura" (entra no topo), renomear "2º pavimento", descer "Cobertura", excluir "Térreo" com bloco (confirmação avisa e o servidor recusa: "O local "Térreo" tem 1 bloco…"), excluir "1º pavimento" (confirmação cita o curto prazo); a seção acompanha cada passo. Consulta: lista sem botão, com "Seu perfil permite consulta aos locais.". Obra sem locais: texto do vazio e "Cadastrar locais". Celular em 400 px sem rolagem horizontal; nenhum erro de console.
- **Não foi aberta no app logado** nem contra o banco real.

### Pendências

- Conferir logado, numa obra real: cadastrar os locais nas Configurações da obra e escolher um na coluna Local do curto prazo.
- A terminalidade tem o seu próprio cadastro de "Pavimentos e unidades" na mesma página; as duas listas são independentes. Unificar, se fizer sentido, é outra decisão.

## Médio prazo: importar do MS Project e carga dos cronogramas de novembro (08/11/2026)

**Pedido do usuário:** "dentro do médio prazo quero criar uma ferramenta que possibilite que o usuário suba arquivos do MS Project direto para o sistema", ao criar um novo cronograma, e "inserir todos os médios prazos do mês de novembro no sistema para que comecem a operar 100% dentro da plataforma". Isso muda a decisão de 25/09/2026 ("Origem do plano: digitado direto no sistema, sem importar XML do Project").

Antes de codar, o modelo da tela foi publicado com as regras numeradas e a carga de novembro (https://claude.ai/artifact/2YVb8UYKWXFXP8Gn6UpRN5). O usuário respondeu "aprovado tudo", confirmou a exclusão do cronograma de teste da Blentt, mandou usar a versão do Drive do arquivo da Atmos e decidiu liberar o módulo de médio prazo **pessoa por pessoa** (em Configurações › Usuários, como já era), sem abrir para todos.

### Regras aprovadas

1. **Formato:** o `.xml` que o próprio Project grava (Arquivo › Salvar como › "Formato XML (*.xml)"). O `.mpp` é um formato fechado; ao escolher um, a gaveta explica o passo do XML. Aceitar o `.mpp` direto exigiria rodar no servidor um conversor de terceiros (o MPXJ compilado, pacote `@byteink/mppjs`, 68 MB, código aberto LGPL com proveniência SLSA) com acesso às chaves do sistema; ficou de fora porque a importação acontece uma vez por obra e, depois dela, cada mês nasce como cópia do anterior dentro do sistema.
2. **O que entra:** todas as tarefas do arquivo, na ordem e nos níveis do Project, com duração, % concluída, início e término reais, restrições, prazo final, anotações e vínculos nos quatro tipos com defasagem. O resumo do projeto (tarefa 0) não entra: o sistema calcula a linha 0.
3. **Recursos viram equipes:** liga à equipe da obra quando o nome bate (sem diferenciar acento e maiúscula, também no formato "EMPRESA - NOME", e "EMPRESA - NOME" casa com a equipe NOME da empresa que começa por EMPRESA, como "ATR - Adenir" com "adenir · ATR OBRA"). Sem candidata única, sugere criar a equipe com o nome do Project e a empresa antes do " - " (a empresa que já existe na obra mantém a grafia de lá). Na conferência dá para trocar cada um por outra equipe ou "Sem recurso". A equipe criada nasce com capacidade 1 (as "Unidades máximas" de 100% do Project) e aparece também no curto prazo.
4. **Linha de base:** a linha de base 0 do Project vira uma linha de base congelada do cronograma, "Linha de base do Project", já exibida no Gantt. Folha sem base fica fora dela (no Project aparece sem base); resumo entra sempre, para a estrutura não mudar.
5. **Calendário:** dias úteis, horas por dia e dias sem trabalho do calendário do projeto, inclusive períodos (recesso de fim de ano). Dia trabalhado fora do normal e calendário por recurso não existem no sistema e geram aviso.
6. **O que o sistema não tem:** tarefa manual vira automática com "Não iniciar antes de" na data dela; inativa não entra; linha em branco é ignorada; defasagem em horas ou % vira dias; vínculo com tarefa-resumo passa para as subtarefas (o sistema só vincula subtarefas): o que chega no resumo vai para as subtarefas sem predecessora dentro dele, o que sai, das subtarefas sem sucessora dentro dele. Cada caso vira um aviso na conferência. *(Revisto em 16/11/2026: o vínculo com tarefa-resumo entra no próprio resumo, como no arquivo; o que liga o resumo às próprias subtarefas sai com `vinculo_resumo_proprio`, e o TT ou IT que chega a um resumo, com `vinculo_resumo_termino`. O aviso `vinculo_resumo` deixou de existir.)*
7. **Datas:** o sistema refaz a rede ao gravar, como o Project faz ao abrir, e a conferência lista antes as tarefas cuja data ficaria diferente do arquivo.
8. **Quem pode:** quem já cria cronograma do mês (planejador, gestor ou admin com o módulo de médio prazo). Continua valendo um plano vivo por mês por obra.

### O que mudou

- **Leitor do XML** (`src/domain/mspdi-import.ts`, puro, sem dependência, roda no navegador e no Node): `parseMspdi(xml)` lê o MSPDI com um leitor XML próprio (pula o `TimephasedData`, que é a maior parte do arquivo) e `buildPlanImport(project, { month, fileName })` devolve o rascunho nas regras do servidor: linhas por `key` (o UID do Project), vínculos, calendário, linha de base, as datas que o Project mostra (`fileDates`), recursos com a contagem de tarefas, avisos agrupados por código e contagens.
- **Ponte com o comando** (`src/application/use-cases/plan-import.ts`): `suggestResourceChoices` (regra 3), `toImportCommand` e `compareWithProject`, que calcula as datas pelo mesmo `scheduleTasks` do servidor e lista as folhas diferentes do arquivo. A tela e o script usam as mesmas funções.
- **Comando `import_plan`** (`commands.ts`, liberado pelo módulo `medio-prazo` em `module-access.ts`): numa gravação só, cria o cronograma do mês com o calendário do arquivo, cria ou reaproveita as equipes (mesmo nome e empresa não duplica), grava as tarefas com as datas do motor e, com `baselineName`, congela a linha de base do Project. Valida como o "Revisar e salvar" (hierarquia, %, datas reais, restrição e prazo só em subtarefa, defasagem inteira de -365 a 365, vínculo sem tarefa, repetido ou para si mesma; ciclo cai na mensagem do motor) e recusa segundo plano no mesmo mês. Registra `plan_import` no histórico com o arquivo e as contagens. **Nenhuma migração**: tudo cabe nas tabelas e no `schedule_meta` que já existem.
- **Gaveta "Novo cronograma do mês"** (`src/modules/medio-prazo/new-plan-drawer.tsx`, no lugar do formulário antigo de `schedule-sheet.tsx`): "Partir de" ganhou "Importar do MS Project (.xml)". Escolhido o arquivo, a gaveta se alarga e mostra a conferência: linhas e resumos, vínculos, concluídas e em andamento, recursos; linha de base, calendário e horizonte; os avisos; a tabela de recursos → equipes com a escolha por linha; e as datas que mudam (até 40 linhas, depois "mais N"). O nome vem do título do arquivo (ou do nome do arquivo, quando o título é genérico como "msproj11"). O botão vira "Criar cronograma de Nov/26".
- **Script da carga** (`scripts/import-medio-prazo.ts`): o mesmo caminho da tela, por obra. Sem `--apply` simula e imprime o relatório; `--replace` exclui na mesma transação o cronograma vivo do mês e as linhas de base dele.
- **Conversão .mpp → .xml pela VM** (`scripts/ms-project/converter-xml.ps1`): no Project 2019 da VM, o `FileSaveAs` com `FormatID = 'MSProject.XML'` funciona quando chamado por `InvokeMember` com argumentos nomeados; a chamada posicional com `[Type]::Missing` não acha a sobrecarga. Em 20/10 o "Salvar como XML" tinha falhado (ver `docs/engenharia-reversa-project.md`).
- **Manual da Claudia** (seção "Criar o cronograma do mês…", com "Importar do MS Project") e **tour** ("Novo cronograma do mês").

### Carga de novembro

Arquivos que o usuário salvou em `~/Downloads/Médio prazo/`, exceto a Atmos, que veio do Drive compartilhado ("ATM Médio Prazo nov-fev.26.mpp", salvo em 06/11; a cópia da pasta Downloads era de 03/11, sem avanço). Os quatro foram convertidos para XML no Project da VM e simulados contra o banco de produção antes de gravar:

| Obra | Arquivo | Linhas | Vínculos | Linha de base | Datas iguais ao Project | Recursos |
| --- | --- | --- | --- | --- | --- | --- |
| Blentt | BLT_Médio Prazo NOV - JAN | 290 | 251 | 287 linhas | 273 de 274 folhas | 47: 16 ligados, 31 criados |
| Atmos | ATM Médio Prazo nov-fev.26 | 372 | 360 | 372 linhas | 285 de 285 | 18 criados |
| Brizz | Médio Prazo 05 - NOV - JAN (título BRZ-OUT-DEZ_26) | 94 | 118 (8 de resumo viraram 50) | 94 linhas | 80 de 80 | 1 criado |
| Tauá | 05 NOV - JAN - Atualização Gabriel | 25 | 14 | 25 linhas | 17 de 17 | 6 criados |

A única data diferente é a da linha 6 da Blentt ("SS2 - Infra carregadores carros elétricos"): vínculo IT com defasagem de -10 dias úteis a partir de uma tarefa que começa em 15/12 às 08:00. O Project mostra o término em 01/12 às 08:00 e o motor em 30/11, o fim do dia útil anterior: é o mesmo instante em horas de trabalho, com outra data na tabela (regra "subtrair cai no fim do dia" da passada direta; registrado em `docs/engenharia-reversa-project.md`).

**Gravado em produção em 08/11/2026** pelo `scripts/import-medio-prazo.ts --apply`, com o perfil do usuário, uma transação por obra, e conferido no banco:

- **Atmos:** "ATM Médio Prazo nov-fev.26", 372 tarefas, 360 vínculos, 283 com equipe, de 02/11/2026 a 06/04/2027, linha de base com 372 linhas, 18 equipes criadas.
- **Brizz:** "BRZ-OUT-DEZ_26", 94 tarefas, 118 vínculos, de 03/11/2026 a 20/01/2027, linha de base com 94 linhas, 1 equipe criada (Carpinteiros).
- **Tauá:** "05 NOV - JAN", 25 tarefas, 14 vínculos, de 07/10/2026 a 05/03/2027, linha de base com 25 linhas, 6 equipes criadas (a obra não tinha equipe).
- **Blentt:** "BLT_Médio Prazo NOV - JAN", 290 tarefas, 251 vínculos, 271 com equipe, de 03/11/2026 a 05/03/2027, linha de base com 287 linhas, 31 equipes criadas e 16 recursos ligados a equipes que já existiam. Antes, saiu o cronograma de teste "Teste do teste" (7 tarefas) com as linhas de base "Base 14/10/2026" e "Base 1/10/2026", como o usuário autorizou. O banco não deixava: o gatilho `guard_plan_baseline` (0023, ajustado na 0037) recusa apagar ou alterar linha de base ("Linha de base é imutável"), com exceção só da exclusão da obra inteira, e o `delete_plan` da aplicação cai no mesmo gatilho (hoje nenhuma linha de base sai pela tela). A exclusão foi feita por SQL, com autorização explícita do usuário, numa transação com a exceção do `obra360.deleting_work` restrita à Blentt, conferindo as contagens antes do commit (12 vínculos, 19 tarefas, 3 planos) e subindo a `planning_meta.version` para as telas abertas recarregarem. A primeira tentativa, sem essa autorização, foi bloqueada pela proteção automática da sessão.

Essenza, Mozine, Bioma, Nova Sede e SEPAT não tinham arquivo e seguem sem cronograma de novembro. O acesso à aba 3 continua **pessoa por pessoa** (decisão do usuário): quem vai operar o médio prazo de cada obra precisa do módulo "Médio prazo" marcado em Configurações › Usuários.

### Validação (08/11/2026)

- **Testes novos:** `tests/mspdi-import.test.ts` (15, 16 desde 16/11/2026: níveis, nulas e inativas, formatos de duração, marco, manual, estimada, restrições, vínculos nos quatro tipos com defasagem útil, corrida, negativa e em horas, vínculo com resumo, recursos, calendário com recesso, feriado e exceção de dia útil, linha de base, entidades e BOM, XML que não é do Project, e ida e volta com `buildMspdi`), `tests/plan-import-command.test.ts` (7: gravação completa com equipe existente, equipe criada, vínculo, datas pela rede, feriado e linha de base; equipe reaproveitada; sem linha de base; 14 recusas; mês ocupado; ciclo; módulo) e `tests/plan-import.test.ts` (3: sugestão de equipes, montagem do comando e comparação de datas).
- **Arquivos reais:** leitura de 1 a 23 ms por arquivo; o motor sobre o rascunho chega às datas do Project em 655 de 656 folhas.
- **Navegador:** a gaveta foi aberta numa página de prévia temporária com `next dev` e as APIs respondidas pelo Playwright com as regras reais (`applyCommand` sobre os dados de exemplo), com o XML real da Blentt. Em 1440 px: o .mpp é recusado com a explicação, a conferência aparece com os números do arquivo, a troca de equipe de um recurso funciona, "Criar cronograma de Nov/26" grava (290 tarefas) e avisa "Cronograma importado do Project", sem erro de console. Em 400 px, sem rolagem lateral. A primeira passada achou a gaveta cortada à direita no celular (o `fieldset` não encolhia; ganhou `min-w-0`) e o nome do arquivo repetido; os dois foram corrigidos. **Não foi aberta no app logado.**

### Pendências

- Liberar o módulo "Médio prazo" para as pessoas de cada obra (Configurações › Usuários).
- Conferir logado, numa obra real: abrir os cronogramas importados, a linha de base do Project no Gantt e as equipes novas no Planejador de Equipe.
- Não há como excluir linha de base pela tela (gatilho do banco). Se for preciso, é uma migração que abra a exceção para o `delete_plan`.
- Fora do escopo aprovado: importar por cima de um cronograma que já existe e aceitar o .mpp direto.

## Médio prazo: Linha do Tempo, tabela e Gantt do tamanho da tela (08/11/2026)

**Pedido do usuário**, com print do cronograma importado da Atmos num notebook: "o quadrado em vermelho deve ser do tamanho de toda a tela. Está muito pequeno como está". O quadrado ia da Linha do Tempo à barra de status, com a tabela mostrando umas dez linhas.

### Causa

Desde 04/11 a área de trabalho inteira (título, comandos, Exibir, filtros, avisos, Linha do Tempo, visão e barra de status) cabia do lugar dela até o pé da janela, ou numa tela inteira quando a visão ficaria com menos de 360 px. Como as quatro faixas de cima entravam na conta, num notebook sobravam cerca de 360 px para a tabela e o Gantt.

### O que mudou (`schedule-sheet.tsx`)

- A **"mesa"** (Linha do Tempo, visão e barra de status) tem sozinha a altura de uma tela, descontada a barra fixa da trilha. As faixas de cima ficam acima dela: rolando a página até a Linha do Tempo, a mesa ocupa a tela toda, e a barra de status fica no pé.
- A mesa começa no elemento marcado com `data-workspace-stage` (a Linha do Tempo) ou na visão, quando a faixa está escondida. Saiu o `COMFORT_VIEW`; o `MIN_VIEW` continua para janela baixa demais.
- Vale também para o Gantt de legalização da aba 1, que usa o mesmo cronograma.
- Em troca, a barra de status deixa de aparecer sem rolar a página, inclusive em monitor grande: para ver a mesa inteira, rola-se até ela.

### Validação (08/11/2026)

- Página de prévia temporária com o cronograma importado da Atmos (372 tarefas) e as APIs respondidas pelo Playwright, rolada até a Linha do Tempo: em 1470×815 (o notebook do print), a mesa vai do topo da janela até 16 px do pé, com **24 linhas** visíveis na tabela (eram cerca de 10); em 1920×1080, **34 linhas**. Sem erro de console.
- Typecheck, ESLint (sem aviso novo), Prettier e `npm test` (1200 testes).
- **Não foi aberta no app logado.**


## Longo prazo: Linha de Balanço do Atmos importada do Prevision e fluxos de pavimentos (11/11/2026)

**Pedido do usuário** (10/11/2026): "salvei em download a linha de balanço do atmos. Suba ela no sistema no longo prazo para que eu veja como ela ficou. Já crie os fluxogramas de pavimentos tipos e demais pavimentos". O arquivo (`Atmos.xml`) é a exportação do Prevision no formato XML do MS Project: 50 serviços no nível 1 ("EST - Estrutura de concreto", "ALV - Alvenaria"…), cada um com os seus locais no nível 2 (606 blocos), com início, término, duração e % concluído. **Não há vínculos no arquivo nem feriados no calendário** (o Prevision desconta feriados na duração, mas não os exporta).

### O que entrou no banco (takt-hub, obra Atmos, 11/11/2026)

Gravado pelo script `scripts/import-lob-prevision.ts --apply`, depois de simulação conferida. A Linha de Balanço do Atmos estava vazia, e não havia nenhum fluxo da empresa.

- **48 locais**, de baixo para cima: demais pavimentos e tipo na ordem do Prevision (Subsolo 01, Térreo, Mezanino, 2º a 15º pavto, Caixa de água, Cobertura), depois os 14 halls, os 14 panos de fachada e "Equipamentos". Os nomes ficaram iguais aos do Prevision ("2ºpavto"), para uma próxima importação casar. A fachada vai pela data em que o trabalho começa em cada pano (Sul 2 ao 10 embaixo, Leste - Fachada Cremalheira em cima), porque o Prevision a lista do último pano ao primeiro e a diagonal sairia invertida.
- **50 serviços**, ordenados pelo primeiro início, com as 8 cores da paleta em rodízio.
- **606 blocos com as mesmas datas do Prevision.** A duração aqui é contada em dias úteis sem feriados (o calendário da Linha de Balanço), então em 189 blocos ela fica maior que a do Prevision (feriados e recesso de fim de ano no meio), com o término igual.
- **1.196 dependências**, deduzidas porque o arquivo não as traz: 556 "equipe segue" (o mesmo serviço de um local ao próximo, na ordem em que acontece, com a espera igual à folga real, como o ritmo do lançamento) e 640 de sequência dentro de cada local (o bloco depende dos que começam no dia de início anterior ao dele e dos que terminam na véspera; blocos que começam juntos correm em paralelo; espera = a do fluxo, sem passar da folga real). Os equipamentos não dependem uns dos outros. Conferido: com as dependências, **nenhum bloco se move** (`cascade` vazio).
- **Medição M1 em 11/11/2026**, salva, com o % do arquivo nos 15 blocos que têm avanço (Estrutura do Térreo ao 5º a 100%, 6º a 20%; Alvenaria do Mezanino a 100% e do Térreo a 80%; contenção, escavação, estacas e blocos a 100%; Piso do Subsolo a 29%; Grua a 41%). **Sem fotos** (a importação não passa pela regra 21). Início real = início do Prevision nos blocos com avanço; término real = término do Prevision nos blocos a 100%. Avanço físico 7,4%, igual ao previsto até 11/11; dois blocos atrasados pelo próprio arquivo: Estrutura do 6º (20% contra cerca de 38% previsto) e Alvenaria do 2º (prevista desde 10/11, 0%).
- **Linha de base "Prevision — Atmos.xml (11/11/2026)"** com os 606 blocos, para comparar quando os blocos forem arrastados.

### Fluxos de serviços criados (da empresa)

Deduzidos da ordem em que os serviços acontecem em cada local do grupo. Entra o serviço presente em ao menos um terço dos locais do grupo (e em dois, no mínimo); a predecessora é a antecessora imediata dele na maioria dos locais; a espera é a menor folga real entre os dois; a duração é a mais frequente no Prevision (dias úteis dele), com a menor no empate. Os dois passam pelas travas de lançamento (um só serviço inicial, sem ciclo).

- **"Pavimentos tipo — Atmos"** (2º ao 15º, 21 serviços): Estrutura 12 d → (espera 36 d) Alvenaria 10 d → Infra elétrica, Infra hidráulica + esgoto de teto e Infra de A/C + Exaustão em paralelo, 10 d → (espera 5 d) Reboco interno + Contrapiso → Lixamento de teto 5 d → Drywall estruturação → infras de drywall + fiação → fechamento das chapas → Impermeabilização → Porcelanato e azulejo → Forro de gesso → Massa corrida + 1ª demão → Portas de madeira → Limpeza grossa → Vinílico + Rodapé, Acabamentos elétricos e Marmoraria/louças/metais em paralelo → Pintura final → Limpeza fina 5 d. Ficaram de fora Mobiliários (3 pavimentos) e Instalações piscina (1).
- **"Demais pavimentos — Atmos"** (Subsolo 01, Térreo, Mezanino, Caixa de água, Cobertura, 22 serviços): a mesma sequência, com a espera de 35 d entre Estrutura e Alvenaria e Mobiliários no fim (20 d, 70 d depois da limpeza fina, como no Térreo e no Mezanino). Ficaram de fora os serviços de um local só: contenção, escavação, estacas, blocos, Piso do Subsolo e "ALV - Cobertura". Como os demais pavimentos são diferentes entre si, a duração única é aproximada (a Estrutura tem 10 d no fluxo, mas 50 d no Térreo).
- Halls, fachada e equipamentos não viraram fluxo (o pedido foi dos pavimentos); estão na Linha de Balanço com as dependências.

### Código

- `src/domain/lob-prevision-import.ts` (puro): `readPrevisionSchedule` (lê o resultado de `parseMspdi`; nível 1 = serviço, folhas abaixo = blocos, local = nomes dos níveis 2 em diante; bloco repetido, serviço sem local, tarefa sem data ou inativa viram aviso), `localGroup` (tipo, demais, hall, fachada, equipamentos, pelo nome), `buildPrevisionImport` (locais, serviços, blocos, dependências, medição, linha de base e fluxos; locais já cadastrados em Configurações são reaproveitados pelo nome) e `detachFlowIds`.
- `scripts/import-lob-prevision.ts`: `node --import tsx scripts/import-lob-prevision.ts <arquivo.xml> --obra <código> --actor <profileId> [--date AAAA-MM-DD] [--sem-fluxos] [--env-file …] [--apply]`. Sem `--apply` só simula e imprime o relatório; recusa obra que já tem serviços, blocos, medições ou linhas de base na Linha de Balanço; não recria fluxo com nome existente; apaga o que entrou se a gravação falhar no meio. Para o takt-hub, `--env-file` aponta para o `.env.local` do App-Takt (o deste repositório é do banco antigo).
- `tests/lob-prevision-import.test.ts`: 9 testes (grupos, ordem dos locais e da fachada, avisos, datas mantidas sem nada se mover, dependências, medição e datas reais, fluxo do tipo com paralelos e espera, ids do fluxo, locais reaproveitados).
- Nenhuma migração. A única tela que mudou foi o gráfico, com as faixas (abaixo).

### Validação (11/11/2026)

- Simulação contra o banco real antes de gravar; depois da gravação, releitura pelo `loadLob` e `listFlows` do repositório: 48 locais, 50 serviços, 606 blocos, 1.196 dependências, 1 linha de base, 1 medição com 15 lançamentos e os 2 fluxos (revisão 1).
- Tela conferida no navegador com os dados reais do Atmos (`next dev` local com Supabase falso e as rotas `/api/lob` e `/api/lob/flows` respondidas pelo Playwright com o que foi lido do banco): Linha de Balanço em Mês e Trimestre, indicadores (50 serviços, 48 locais, término 26/04/2028, 7,4%), M1 e hoje desenhados, os dois atrasados contornados; visão Fluxos com a rede dos paralelos. Sem erro de console. **Não foi aberta no app logado.**
- Typecheck, ESLint (nenhum aviso novo), Prettier, `npm test` (1.260 testes), `validate:migrations` e `build`.

### Gráfico: serviços simultâneos no mesmo local em faixas (11/11/2026)

A conferência achou que o gráfico desenhava um bloco por serviço na altura inteira da linha do local, sem tratar sobreposição. No Atmos, as três infras e os três acabamentos de cada pavimento têm as mesmas datas, e Grua, Cremalheiras e Elevadores dividem o local "Equipamentos": o último desenhado cobria os outros (cerca de 4 dos 21 serviços de cada pavimento escondidos, e o clique pegava o de cima). O usuário aprovou a correção proposta ("sim").

- `lob-model.ts`: `assignLanes` agrupa os blocos visíveis de um local que se sobrepõem no tempo (fim exclusivo; bloco que começa no fim do outro não conta) e põe cada um na primeira faixa livre, pela ordem de início e depois do serviço (as infras saem sempre na mesma ordem em todos os pavimentos). Bloco sem sobreposição fica com a linha inteira, como antes. A linha cresce só quando precisa (`rowHeightFor`: faixas de no mínimo 12 px; 30 px com uma, 34 com duas, 47 com três); `LobRow` ganhou `height` e `lanes`, e as posições das linhas são acumuladas de cima para baixo. O fantasma da linha de base acompanha a faixa do bloco. Serviço escondido pela legenda e bloco fora do período não ocupam faixa.
- `lob-chart.tsx`: faixa zebrada e rótulo do local usam a altura de cada linha; o nome do serviço numa faixa de menos de 16 px sai em 9 px, e abaixo de 10 px some (o bloco continua clicável, com a dica ao passar o mouse).
- Manual da Claudia (`src/modules/agente/manual/longo-prazo.ts`) com uma frase sobre as faixas.
- Testes em `tests/lob-model.test.ts` (4): sequência sem faixa, três simultâneos em três faixas, faixa reaproveitada em sobreposição em cadeia, linha que cresce sem os blocos se cobrirem e as demais com 30 px, serviço escondido sem faixa.
- Conferido no navegador com os dados reais do Atmos em Trimestre e Semana: as três infras e os três acabamentos de cada pavimento um sobre o outro, Grua e as duas Cremalheiras em faixas próprias, fachada com Textura e Esquadrias separadas; clicar na faixa do meio do 2º pavimento seleciona "ALV - Infra hidráulica" (13/01 a 26/01). Sem erro de console. O gráfico do Atmos ficou mais alto (os pavimentos com 47 px).

### Pendências

- Abrir a aba 1 do Atmos logado e conferir.
- Repetir a importação para as outras obras quando houver o XML do Prevision (o script serve para qualquer obra com a Linha de Balanço vazia); um botão "Importar do Prevision" na tela ainda depende de modelo de UX.
- Feriados: o calendário da Linha de Balanço não tem feriados; quando tiver, as durações dos 189 blocos voltam a bater com as do Prevision.

## Longo prazo: IDP ponderado por custo e tela Custos (11/11/2026)

**Pedido do usuário** (11/11/2026): "vamos adicionar ao indicador o índice de desempenho de prazo. O IDP é calculado pela % física real / % física planejada; o ideal é colocarmos uma ponderação de custo". O modelo de UX ([IDP na Linha de Balanço](https://claude.ai/artifact/383wHAi9Twf5o3sMVpa7X9), com os dados reais do Atmos e 12 regras numeradas) foi aprovado com **uma mudança**: "a única questão é criar uma tela para apropriar custos em cada pacote de serviço". O cadastro dos custos deixou de ser um painel lateral da Linha de Balanço e virou a visão **Custos** da aba 1 (`?visao=custos`).

Por que na Linha de Balanço: em produção, `long_term_plans` (o Planejador, que os dashboards leem) está vazia; só o Atmos tem longo prazo, e na Linha de Balanço.

### Regras aprovadas (numeração do modelo)

1. **Fórmula.** IDP = % físico real ÷ % físico planejado, na mesma data, com os mesmos blocos e o mesmo peso, com duas casas ("0,94"). Pesado por custo, é o índice do valor agregado (valor agregado ÷ valor planejado).
2. **Onde aparece.** Quinto cartão nos Indicadores da Linha de Balanço, quadro "IDP por medição" nas Medições, coluna por pacote na tela Custos e linha no relatório da Claudia (`consultar_lob`).
3. **Data.** A data é a da última medição fechada; a medição aberta não conta. O cartão "Avanço físico" continua com o "previsto até hoje".
4. **Planejado.** Vem da linha de base escolhida no seletor da Linha de Balanço. Sem escolha, vem da manual mais recente. Sem linha de base manual, vem do cronograma atual. Bloco criado depois da linha de base usa as datas atuais. Medições, Custos e a Claudia não têm seletor: usam a regra sem escolha.
5. **Custo por pacote.** O custo do pacote de serviço é a soma dos itens apropriados a ele, em R$. Ele se reparte entre os blocos do pacote pela duração.
6. **Pacote sem custo.** Enquanto algum pacote com blocos estiver sem item de custo, tudo segue pesado pela duração e as telas dizem quantos faltam. Item de valor zero conta como informado. Se todos têm custo e a soma é zero, também fica a duração.
7. **Um peso só.** Com os custos completos, o avanço físico, o previsto até hoje, o quadro das Medições e o IDP passam juntos para o peso por custo. Cada cartão diz qual peso vale.
8. **Cadastro.** Tela própria, por mudança do usuário (era um painel na barra). Edita quem já pode alterar a Linha de Balanço.
9. **Sigilo.** O perfil de consulta recebe cada item como porcentagem do total de todos os itens (`maskCosts`). O valor em reais não sai do servidor, e o peso e o IDP saem iguais.
10. **Faixas.** IDP de 1,00 ou mais é verde ("em dia"); de 0,90 a 0,99, amarelo ("atenção"); abaixo de 0,90, vermelho ("atrasado"). A cor segue o número mostrado: 0,996 aparece como 1,00 e fica verde.
11. **Sem número.** Sem medição fechada, mostra "—" e "sem medição". Sem nada previsto até a data, mostra "—" e "nada previsto até a data". Sem blocos, mostra "—" e "sem blocos ainda".
12. **Dashboards.** O Dashboard da obra (aba 0) e o Dashboard geral ficam para a próxima etapa. Eles continuam lendo o Planejador antigo.

### A tela Custos

- **Modelo de dados.** Cada pacote recebe **itens de custo** (linhas do orçamento: código opcional, descrição e valor) e o custo do pacote é a soma deles; item sem pacote fica "não apropriado" e não entra no peso. Assim cabem os dois jeitos de trabalhar: quem tem um valor por pacote digita direto na linha do pacote (vira um item "Custo do pacote"), e quem tem o orçamento detalhado cola as linhas e aponta cada uma a um pacote.
- **Quatro cartões.** "Custo apropriado" mostra a soma dos pacotes com blocos e, à parte, o valor em pacotes sem blocos. Depois vêm "Pacotes com custo" (N de M, com o peso vigente), "Não apropriado" (soma e quantidade) e "IDP". Todos são calculados sobre o rascunho, com "(não salvo)" enquanto houver alteração pendente.
- **Pacotes de serviço.** Uma tabela na ordem da obra mostra blocos, dias úteis, itens, custo, peso, real, planejado e IDP de cada pacote.
  - O custo se edita na própria linha quando o pacote tem até um item. Com dois ou mais, a linha mostra a soma.
  - Colar uma coluna do Excel num campo de custo preenche aquele pacote e os seguintes. Pacote com vários itens é pulado junto com o valor da linha dele, para não desalinhar.
  - Pacote sem blocos aparece apagado: o custo dele não entra no IDP.
  - Pacote com blocos e sem custo fica com o campo em âmbar.
- **Itens do pacote.** O painel permite editar código, descrição e valor, "Mover para" outro pacote ou "Não apropriado", excluir e adicionar itens. Ele fica ao lado da tabela a partir de 1536 px e embaixo dela nas telas menores.
- **Não apropriados.** Seleção em lote com "Apropriar N selecionados em [pacote]" e "Excluir selecionados".
- **Colar do orçamento.** Lê as linhas coladas do Excel (tabulação; ponto e vírgula quando não há tabulação), mostra uma prévia e joga as linhas no rascunho, acrescentando ou substituindo os itens atuais. Como cada linha é lida:
  - o valor é a última célula numérica;
  - célula com o nome de um pacote (sem acento e sem diferença de caixa) aponta o pacote;
  - célula curta com cara de código, antes da descrição, vira o código;
  - a descrição é o texto mais longo, e uma linha só com pacote e valor usa o nome do pacote como descrição;
  - linhas de total, sem valor, com valor negativo ou sem descrição são ignoradas, com o motivo.
- **Rascunho.** Tudo fica local até "Salvar", que manda um único comando `save_costs` (`upsert` + `remove`). Há "Descartar" com confirmação e aviso ao sair da página ou trocar de visão com alterações pendentes.
- **Valores.** `parseMoney` aceita "R$ 1.234,56", "1234,56" e "1.500" (mil e quinhentos). Campo inválido fica vermelho e não entra no rascunho. Item novo exige descrição.
- **Perfil de consulta.** Vê a tela sem campos, com "x,x% do total".
- **Sem a migração 0044.** Avisa e mostra tudo só para leitura, pesado pela duração.

### Outras telas

- **Linha de Balanço** (`lob-view.tsx`):
  - O cartão "IDP · desempenho de prazo" mostra a conta, a referência e o peso, por exemplo "73,3% ÷ 95,0% em 06/11 (medição nº 2) · contra a linha de base “X” · peso por custo".
  - Com custos faltando, aparece em vermelho "Faltam custos em N de M pacotes." e o link "Apropriar custos" ("Ver custos" para quem só consulta).
  - O cartão "Avanço físico" segue o peso vigente.
  - Na barra entrou o botão "Custos", com o selo pacotes com custo / pacotes com blocos.
  - A opção vazia do seletor de linha de base diz qual linha de base o IDP usa ("nenhuma no gráfico (IDP: “X”)").
  - Sem a 0044, a nota do cartão diz que a apropriação ainda não foi ativada, em vez do aviso de custos faltando.
- **Medições:** o quadro do avanço físico segue o peso vigente. O quadro novo "IDP por medição" lista as medições da mais nova para a mais antiga. Duas medições fechadas no mesmo dia dão dois pontos.
- **Claudia:**
  - `consultar_lob` traz a linha do IDP (com a referência, o peso e quantos pacotes faltam) e a coluna "IDP na última medição" por serviço.
  - O relatório nunca escreve valores em reais. Ela recebe a `LobData` completa, mas só o administrador a usa.
  - O roteiro (`chat.ts`) e o manual (seção `longo-prazo-idp-custos`) foram atualizados. Para caber no limite do índice, foram encurtados 12 resumos de seções do longo prazo.
- **Tour:** passos novos para o cartão do IDP, o botão "Custos", o quadro das Medições e os cinco blocos da tela Custos.

### Arquitetura

- **Domínio:**
  - `src/domain/lob-performance.ts` reúne `parseMoney`, `serviceCosts`, `lobWeights`, `performanceBaseline`, `plannedPercents`, `lobPerformance`, `weightedProgress`, `servicePerformance`, `idpTone` e `maskCosts`.
  - `src/domain/lob.ts` ganhou `LobCostItem`, `LobData.costs`, `LobCostAccess`, o comando `save_costs` e os limites (5.000 itens por obra, 3.000 por gravação).
  - `physicalProgress`/`plannedProgress` aceitam um peso por bloco. Sem ele, continuam pela duração.
- **Servidor:**
  - `loadLobWithCosts` devolve `{ data, costsAvailable }` e tolera a falta da 0044. Sem as tabelas da 0038, continua lançando `LobUnavailableError`.
  - `loadLob` também tolera a falta da 0044 e devolve `costs: []`.
  - `LobCostsUnavailableError` responde 503, e o `save_costs` sem a tabela é recusado antes de planejar.
  - Os itens de custo são inseridos e atualizados em lotes de 500 (atualização por `upsert`). As exclusões de todas as tabelas da Linha de Balanço vão em blocos de 100 ids, para a URL não estourar.
  - `GET /api/lob` devolve `costAccess` (`full`, `masked` para consulta, `unavailable`).
- **Migração `0044_lob_costs.sql`:**
  - Cria a tabela `lob_cost_items` com:
    - `work_id` com `on delete cascade`, então o `delete_work` da 0037 leva os itens;
    - `service_id` com `on delete set null`, então excluir o pacote deixa o item não apropriado;
    - `amount numeric(16,2)` maior ou igual a zero e descrição obrigatória;
    - RLS sem política e grant para `service_role`.
  - Fica fora do snapshot, não reescreve `commit_planning` e pode ser rodada de novo.
  - A tela Configurações → Banco de dados ganhou a sondagem da 0044.
- **Pacote SQL completo:** `supabase/bootstrap/obra360-schema.sql` foi regenerado e agora inclui também a 0043, que tinha ficado de fora. `scripts/validate-bootstrap-sql.mjs` passou a esperar 60 tabelas, e `supabase/bootstrap/conferencia.sql` ganhou as tabelas da 0043 e da 0044.

### Conferência com o Atmos (leitura de produção, 11/11/2026)

Medição M1 de 11/11 contra a linha de base "Prevision — Atmos.xml (11/11/2026)":

- **Peso por duração** (como fica até haver custos): real 7,45% ÷ planejado 7,42% = 1,00.
- **Custos de exemplo do modelo** (R$ 64,47 mi, só para conferir a conta): 21,2% ÷ 21,3% = 1,00, verde. Por pacote:
  - estrutura 0,99;
  - grua 1,02;
  - alvenaria 1,06;
  - piso do subsolo 0,88.

Nenhum custo foi gravado.

### Validação (11/11/2026)

- `npm run typecheck`, `lint` (nenhum aviso novo), `format:check`, `npm test` (1.313 testes), `validate:migrations`, `build` e `test:e2e` (10) passaram. `scripts/validate-bootstrap-sql.mjs` passou com 44 migrações, 37 de 37 sondagens e 87 de 87 itens.
- Testes novos ou ampliados:
  - `tests/lob-performance.test.ts` (15, uma obra pequena com as contas à mão);
  - `tests/lob-costs-model.test.ts` (11);
  - `tests/lob-commands.test.ts` (9 de `save_costs`);
  - `tests/delete-work.test.ts` (itens de custo com e sem pacote; excluir pacote deixa o item sem pacote; checks da 0044);
  - `tests/agent-global-tools.test.ts` (4 do IDP no relatório).
- Navegador sem banco (Supabase falso + Playwright respondendo `/api/*`), a 390, 1100, 1440 e 1680 px:
  - na tela Custos: digitar, colar uma coluna, importar, apropriar em lote, mover, salvar com um único `save_costs`, confirmação ao sair, perfil de consulta e 0044 ausente;
  - na Linha de Balanço e nas Medições: custos faltando, completos, sem custo e sem medição.
- **Não validado:** uso logado com dados reais, a primeira gravação de custos no banco e a troca manual do seletor de linha de base.

### Pendências

- **Migração 0044 aplicada no `takt-hub` em 11/11/2026**, a pedido do usuário, por conexão direta ao banco numa transação. Conferidos: as 10 colunas, as chaves (obra em cascata, pacote com `set null`), RLS ligada, 3 índices, o grant para `service_role` e a leitura REST (200 com a chave de serviço, 401 anônima). Tabela vazia.
- Publicado pelo `main` a pedido do usuário (mesmo dia); conferir no ar o workflow "Imagem" e a tela logada.
- Cadastrar os custos do Atmos. O Obra Prima conectado ao Claude é de outra empresa e não tem as obras da ATR, então a fonte é a planilha do orçamento, colada na tela.
- Próxima etapa (regra 12): levar o avanço físico e o IDP da Linha de Balanço para o Dashboard da obra e o Dashboard geral.
- Depois: IDC (desempenho de custo, precisa do custo realizado), curva S físico-financeira e importação do orçamento.

## Curto prazo: Status em branco pela própria célula (16/11/2026)

### Pedido

"Se o planejador preencher o Status sem querer, não tem como colocar em branco?" Havia como, mas fora da célula: o botão "Limpar" da coluna Apontamento (11/10/2026) e o "Desfazer". A lista do Status só tinha "Sim" e "Não", e a coluna Apontamento fica no fim da linha. Na conferência a 1680 px, ela ficou fora da área visível, à direita de Justificativas. O planejador procurava o vazio na própria lista.

### Comportamento entregue

- A lista do Status tem sempre uma **opção em branco no topo**, inclusive na linha com Sim ou Não gravado. Escolhê-la faz exatamente o que o "Limpar" faz (`clearFulfillment` em `commitments-overview.tsx`, comando `clear_fulfillment`): tira Status, causa e justificativa, e a linha continua.
- **Delete ou Backspace** com a célula do Status em foco fazem o mesmo, como apagar a célula no Sheets. Em linha sem Status, a tecla não faz nada.
- Com o apontamento já gravado, pergunta antes ("Limpar o apontamento de “…”?"). Cancelar mantém o Status e não grava nada. Um "Não" ainda aguardando a causa sai na hora, sem pergunta e sem ida ao servidor.
- O aviso traz "Desfazer", e a limpeza entra na pilha do Ctrl+Z, como no botão.
- Com Status preenchido, o `title` da célula explica: "Para deixar sem Status, escolha a opção em branco ou tecle Delete."
- Vale na tabela e no cartão do celular, que usam o mesmo seletor. O perfil de consulta continua sem apontar. O botão "Limpar" da coluna Apontamento foi mantido.
- Atualizados o texto de "Como preencher" e o manual da Claudia (`src/modules/agente/manual/curto-prazo.ts`, seção de apontamento, palavras-chave "status em branco" e "voltar status para vazio").

Sem migração e sem comando novo. A barra de linhas marcadas continua sem "limpar em lote".

### Validação (16/11/2026)

- `npm run typecheck`, `lint` (nenhum aviso nos arquivos alterados), `format:check` e `npm test` (1.464 testes) passaram.
- Navegador sem banco (Supabase falso, `next dev` na 3102 e Playwright respondendo `/api/*` com `applyCommand` real), a 1680 e 390 px. Casos conferidos:
  - lista com `['', 'Sim', 'Não']`;
  - branco com confirmação grava `clear_fulfillment`;
  - cancelar mantém o Sim;
  - Delete limpa um Não com causa e justificativa;
  - Delete em linha vazia não abre nada;
  - Não pendente sai sem pergunta;
  - Enter continua descendo na coluna;
  - o cartão do celular tem a opção em branco.
- **Não validado:** uso logado com dados reais.

## Médio prazo: arrastar a largura da coluna derrubava a tela (16/11/2026)

### Pedido

O usuário mandou o print da tela "Algo deu errado — Esta tela não pôde ser exibida" no cronograma do médio prazo (`/obras/…/medio-prazo`). Ela aparecia ao arrastar a borda de um cabeçalho para mudar a largura da coluna.

### Causa

O separador de cada cabeçalho (`schedule-resize`, em `src/modules/medio-prazo/schedule-sheet.tsx`) calculava a largura nova **dentro** do atualizador do estado: `setWidths(w => … e.currentTarget.dataset.width …)`. O React zera `currentTarget` ao fim do evento. O `pointermove` é evento contínuo, e o atualizador nem sempre roda na hora: no primeiro movimento ele roda dentro do evento e funciona, mas os seguintes ficam na fila e rodam na pintura seguinte. Aí `currentTarget` já é `null`. O `TypeError: Cannot read properties of null (reading 'dataset')` estourava dentro de `Sheet` durante a renderização, e o limite de erro trocava a tela inteira pelo aviso. O defeito existia desde `d096cac` (21/10/2026).

### Comportamento entregue

- A largura é calculada no próprio evento, com o elemento guardado numa variável, e o estado recebe o número pronto. Limites mantidos: 36 a 600 px.
- O separador entre a tabela e o Gantt já calculava o valor no evento e não tinha o defeito. As setas do teclado no separador da coluna também não. Nos outros módulos, a busca por atualizador que leia `currentTarget` não achou outro caso. Os que leem `event.target` não têm o problema, porque o React não zera `target`.

Sem migração e sem mudança de dado: as larguras continuam só no estado da tela.

### Validação (16/11/2026)

- Página de prévia temporária, apagada depois, com o `Sheet` real e três tarefas. `next dev` na 3102 e Playwright arrastando a borda de "Nome da tarefa": 15 passos de mouse real, depois 10 movimentos no mesmo instante, como um mouse rápido.
  - **Com o código antigo:** a tela caiu no aviso "Esta tela não pôde ser exibida", com `Cannot read properties of null (reading 'dataset')` dentro de `Sheet`. Este é o erro do print.
  - **Com a correção:** a coluna passou de 300 para 420 px, sem erro no console.
- **Não validado:** uso logado no servidor da ATR depois da publicação.

## Médio prazo: mais de um cronograma no mesmo mês (16/11/2026)

### Pedido

"Permita que seja criado mais de um cronograma de médio prazo para o mesmo mês." Até aqui valia a decisão de 25/09/2026: um cronograma vivo por mês por obra. Ao escolher um mês que já tinha cronograma, "Novo cronograma do mês" recusava com "Esta obra já tem um plano para este mês.". A importação do Project tinha a mesma trava. Assim não dava, por exemplo, para importar uma versão corrigida do .xml de novembro sem apagar a anterior, e a tela não tem botão de excluir.

### Comportamento entregue

- **`create_plan` e `import_plan`** (`commands.ts`) aceitam um mês que já tem cronograma. A trava existia só no código. O banco nunca teve índice único em `(work_id, month)`, então **não há migração**.
- **Nome:** um nome repetido no mesmo mês ganha " (2)", " (3)"… (`uniquePlanName` em `src/domain/legalization.ts`), sem diferença de maiúsculas e espaços. Vale para o nome digitado, para o padrão "Plano de AAAA-MM" e para o título do arquivo do Project. Linha de base, Gantt de legalização e cronogramas de outro mês ou de outra obra não ocupam nome.
- **Cópia:** "Partir de" pode ser outro cronograma do mesmo mês. A recusa passou a ser "O plano de origem deve ser do mesmo mês ou de um mês anterior ao novo plano.". Copiar de um mês posterior continua recusado. O subtítulo da cópia do mesmo mês diz de qual: "copiado de Nov/26 · Novembro".
- **Gaveta "Novo cronograma do mês":** quando o mês escolhido já tem cronograma, ela avisa antes de criar, com o nome que será gravado ("Nov/26 já tem o cronograma “Novembro”. O novo entra ao lado, como “Novembro (2)”…"). A descrição da gaveta passou a ser "Cada cronograma cobre um mês, com horizonte de três meses. O mesmo mês pode ter mais de um.".
- **Qual cronograma aparece onde só cabe um:** a ordem única `newestPlanFirst` põe o mês mais recente primeiro e, no mesmo mês, o criado por último. Antes, o empate dependia da ordem em que o banco devolvia as linhas. Usam essa ordem:
  - o seletor "Mês" e a abertura da tela, que vai para o criado por último no mês corrente;
  - os seletores das seções Linha de base e Cobertura;
  - o quadro do médio prazo no Dashboard e no Dashboard geral (`pickPlan`);
  - o resumo da obra e as ferramentas da Claudia;
  - o plano oferecido ao ligar uma pendência da aba 2 (`linkablePlan`, agora com `created_at` lido em `pending-repository.ts`).
- **Recursos e carga das equipes** (`weeklyTeamLoad`) não mudaram. Eles já somavam todos os cronogramas vivos da obra, inclusive as cópias de meses vizinhos que se sobrepõem. Dois cronogramas do mesmo mês com as mesmas tarefas contam em dobro, como as cópias já contavam.
- **Pendência ligada a tarefa do médio prazo:** o card segue a tarefa só para meses seguintes, como antes. A cópia feita dentro do mesmo mês não leva o card junto. No caminho por nomes, o "plano do mês seguinte" é o criado por último naquele mês.
- Textos atualizados: descrição e "Como funciona" da aba, tour (passo "Mês do cronograma"), manual da Claudia (`geral.ts` e `medio-prazo.ts`, com as palavras-chave "dois cronogramas no mesmo mês" e "mais de um cronograma"), comentário de `MediumTermPlan` e o README.

### Validação (16/11/2026)

- Testes:
  - os dois testes que exigiam a recusa agora exigem a aceitação com nome numerado: `legalization.test.ts` e `plan-import-command.test.ts`;
  - novos em `plan-monthly.test.ts`: cópia do mesmo mês, numeração (padrão, maiúsculas e espaços, outro mês, linha de base e outra obra) e a ordem de `newestPlanFirst`;
  - novo em `dashboard-medium-term.test.ts`: `pickPlan` com dois cronogramas no mês escolhe o criado por último, qualquer que seja a ordem dos dados.

### Pendências

- **Não há botão para excluir cronograma na tela.** O comando `delete_plan` existe, mas sem interface. Com mais de um por mês, um cronograma criado por engano fica no seletor até alguém excluí-lo por SQL.
- **Não validado:** uso logado no servidor da ATR.

## Médio prazo: rascunho automático no navegador (16/11/2026)

### Pedido

"O sistema não salva rascunho, caso o usuário feche sem salvar? Importante implantar." Até aqui o rascunho do cronograma existia só na memória da tela. Havia o aviso do navegador ao fechar a aba e a pergunta ao clicar num link. Mesmo assim, fechar, a queda do navegador, o computador dormir, a sessão expirar ou a tela cair (como no defeito da largura da coluna, corrigido no mesmo dia) perdiam tudo o que não tinha passado por "Revisar e salvar".

### Comportamento entregue

- **Gravação contínua no `localStorage` deste navegador**, por pessoa e por cronograma: chave `obra360.medio-prazo.rascunho.v1.<actorId>.<planId>`, guardada 400 ms depois da última mudança e na hora em `pagehide`, ao ocultar a aba e ao desmontar a tela. Guarda `{v, actorId, planId, savedAt, baseHash, draft}`. O `baseHash` é uma impressão digital (cyrb53) do retrato (`planSnapshot`) de quando a edição começou. O original e o retrato não são guardados, porque o banco os devolve iguais enquanto o hash bate, e isso evita dobrar o espaço usado. A célula em digitação ainda não confirmada e a pilha do Ctrl+Z não vão.
- **Ao reabrir**, o rascunho guardado que difere do que está gravado volta, com o aviso "Rascunho não salvo recuperado, guardado neste navegador em 16/11 às 09:52. Ele ainda não está no sistema.", com "Revisar e salvar" e "Descartar rascunho" (pede confirmação). A leitura é feita no estado inicial do `Sheet`, e não num efeito, para não disputar com o efeito que recarrega o cronograma quando não há rascunho. É seguro porque o `Sheet` só monta no navegador, depois de o planejamento carregar.
- **Cronograma salvo no sistema depois que o rascunho começou** (outra pessoa ou outro computador): o hash não bate, o aviso fica âmbar e "Revisar e salvar" fica barrado, no botão e dentro do `save()`. A pessoa escolhe entre duas saídas:
  - "Descartar rascunho" fica com a versão do sistema;
  - "Usar sobre a versão atual" passa a contar as alterações contra a versão gravada agora e libera o salvar, e a revisão mostra o que muda antes de gravar por cima.

  Sem isso, o rascunho ficaria preso, porque `save_plan_revision` recusa quando o retrato esperado difere. É também o caminho depois de "Outra pessoa alterou o cronograma. Atualize a página…": recarregar não perde mais o rascunho.
- **A chave sai** ao salvar com sucesso, ao descartar e quando o rascunho volta a ficar igual ao gravado. Rascunho corrompido, de outro formato, de outra pessoa ou de outro plano é ignorado e apagado. Espaço cheio ou bloqueado mostra um aviso só ("Rascunho não guardado neste navegador").
- Perfil consulta, linha de base e plano congelado não guardam rascunho. Vale também no Gantt de legalização da aba 1, que usa o mesmo `Sheet`; a chave por plano separa os dois.
- A pergunta ao sair por link virou "Sair sem salvar no sistema?" e explica que o rascunho fica guardado só neste navegador e volta ao reabrir. O aviso do navegador ao fechar a aba continua.
- Código:
  - `src/modules/medio-prazo/draft-storage.ts`: funções puras `draftKey`, `hashText`, `serializeDraft`, `parseDraft`, `decideRecovery` e `formatSavedAt`;
  - integração em `schedule-sheet.tsx`;
  - manual da Claudia (`medio-prazo.ts`, seção de rascunho, com as palavras-chave "rascunho automático", "fechei sem salvar", "perdi as alterações" e "rascunho recuperado").

Sem migração: nada vai ao servidor.

### Validação (16/11/2026)

- `tests/plan-draft-storage.test.ts` (7 testes): chave, ida e volta, rascunho inválido, de outra pessoa ou de outro plano, decisão de restaurar e de marcar como desatualizado.
- Navegador: prévia temporária com o `Sheet` real, `next dev` e Playwright. 20 de 20 casos passaram, entre eles:
  - editar e recarregar traz o rascunho com o aviso;
  - recarregar antes dos 400 ms também guarda;
  - descartar apaga e não volta;
  - salvar envia `save_plan_revision` e apaga a chave;
  - rascunho corrompido abre a tela normal;
  - rascunho desatualizado mostra o aviso âmbar com o salvar barrado, e "Usar sobre a versão atual" libera;
  - a pergunta de saída fala do navegador.
- **Não validado:** uso logado no servidor da ATR.

### Limites

- Só neste navegador e computador; outro aparelho não vê o rascunho.
- Com duas abas no mesmo cronograma, vale a última que gravou.
- Rascunho abandonado fica no navegador até ser salvo ou descartado; não há limpeza por idade.
- Ao reabrir, a grade continua começando bloqueada (cadeado). Salvar e descartar não precisam de "Liberar edição".

## Médio prazo: calendário nos campos de data (16/11/2026)

### Pedido

"No médio prazo, ao clicar em campos tipo data, abra o calendário para permitir que o usuário possa selecionar uma data com mais facilidade." Até aqui as datas da grade se digitavam ("dd/mm/aa", "Seg 24/08/26"). Os campos nativos de data só abriam o calendário pelo ícone pequeno no canto.

### Comportamento entregue

- **Grade do cronograma.** As colunas Início real, Término real, Início, Término, Data da restrição e Prazo final abrem um calendário sob a célula:
  - ao passar o mouse, e sempre na célula ativa, a célula editável mostra um ícone de calendário; **um clique nele** seleciona a célula e abre o calendário;
  - duplo clique, F2 ou Enter abrem o editor da célula já com o calendário;
  - quem começa digitando não vê o calendário, para não atrapalhar quem digita; **Alt+↓** abre e fecha, como a lista suspensa do Project.
- **O calendário:**
  - mostra o mês da data da célula, com o dia marcado em azul, o dia de hoje contornado e os dias sem trabalho do calendário do cronograma (fins de semana e feriados) esmaecidos, mas escolhíveis. Os dias dos meses vizinhos completam seis semanas, para a altura não mudar;
  - tem as setas de mês anterior e próximo e o botão "Hoje". "Limpar" só aparece nas colunas que aceitam vazio (Início real, Término real, Data da restrição, Prazo final);
  - escolher um dia grava na hora, pelo mesmo caminho do texto digitado (as mesmas regras e o mesmo reagendamento), e devolve o foco à célula. O resultado é idêntico ao de digitar a data;
  - o foco fica no campo de texto da célula: digitar continua valendo, e uma data válida digitada leva o calendário ao mês dela. Esc cancela, clicar fora grava o texto, e data inválida mostra a faixa vermelha com o editor aberto, como antes;
  - abre embaixo da célula ou, sem espaço, em cima, e acompanha a rolagem.
- O calendário não aparece em resumos, colunas calculadas e na grade bloqueada, porque nesses casos nada se edita.
- **Campos nativos de data.** O clique em qualquer ponto do campo abre o calendário do navegador (`showPicker`), não só o ícone. Vale para:
  - Início, Término, Prazo final e Data da restrição nas Informações da tarefa;
  - "Referência do % alvo";
  - o "Mês" do novo cronograma;
  - a "Data de término" da pendência criada a partir do cronograma (diálogo do módulo de pendências, o mesmo usado pelas outras telas).

  Navegador sem `showPicker` segue como era.
- Código:
  - `src/modules/medio-prazo/date-picker.tsx`: o calendário, em portal no `body`;
  - `src/modules/medio-prazo/month-grid.ts`: as seis semanas do mês e a troca de mês;
  - `src/shared/native-picker.ts`: o clique que abre o calendário nativo;
  - integração em `schedule-sheet.tsx` (`CALENDAR_COLS`, `pickDate`, ícone na célula), `task-info-dialog.tsx`, `new-plan-drawer.tsx` e `create-pending-dialog.tsx`;
  - manual da Claudia e tour do médio prazo.

Sem migração e sem mudança de dado.

### Validação (16/11/2026)

- `tests/date-picker.test.ts` (2 testes): seis semanas de domingo a sábado, mês que começa no domingo e no sábado, fevereiro bissexto e a troca de mês na virada do ano.
- Navegador: prévia temporária com o `Sheet` real e três tarefas (apagada depois), `next dev` na 3102 e Playwright. Casos conferidos:
  - o ícone fica invisível fora da célula e aparece no hover;
  - o clique no ícone abre o calendário em "Novembro de 2026", com 3/11 marcado e 16/11 como hoje, e sem "Limpar" no Início;
  - as setas trocam o mês com o foco no campo;
  - escolher 10/11 grava "Ter 10/11/26", reagenda o Término, marca a célula como alterada, fecha o calendário e devolve o foco à célula;
  - escolher 12/11 no Reboco deu "Qui 12/11/26 → Dom 15/11/26", igual a digitar 12/11/26;
  - Início real: com "Limpar", digitar 05/01/27 leva o calendário a janeiro de 2027, e Esc fecha sem gravar;
  - começar digitando não abre o calendário, e Alt+↓ abre;
  - "Hoje" grava 16/11 e "Limpar" volta a ND;
  - clicar fora grava o texto válido e fecha; texto inválido mostra "Data inválida." com o editor aberto;
  - com a grade bloqueada não há ícone;
  - perto do pé da tela, o calendário abre para cima;
  - nas Informações da tarefa (Shift+F2), o clique no Início chama `showPicker`;
  - sem erro de console do calendário.
- Ícone medido na largura padrão da coluna (104 px): não cobre a data em seis dos sete dias da semana. Em "Dom", o mais largo, encosta 2 px.
- **Não validado:** uso logado no servidor da ATR; Safari e Firefox (o calendário da grade é próprio, igual nos navegadores; o nativo depende do navegador).

## Médio prazo: copiar e colar em todas as células (16/11/2026)

### Pedido

"No médio prazo permita que todas as células aceitem copiar e colar." A grade já tinha Ctrl+C e Ctrl+V, mas a colagem era tudo ou nada. Bastava o intervalo pegar uma célula calculada (Id, Indicadores, folgas, linha de base…), uma célula de resumo, ou o início de uma tarefa já iniciada, para nada ser colado, com "O intervalo contém uma célula bloqueada ou calculada.". Copiar uma linha inteira e colar em outra sempre caía nisso, porque a linha começa pelo Id. Colar além da última linha também era recusado ("Colagem ultrapassa a grade."), e uma célula copiada não preenchia uma seleção maior.

### Comportamento entregue

A colagem passou a seguir o Excel e o Project (`pasteGrid` em `schedule-sheet.tsx`):

- **Onde cai:** a partir da célula de cima à esquerda da seleção. Se a seleção for múltipla exata do bloco copiado, ele se repete até cobri-la; uma célula copiada preenche qualquer seleção (`pasteTargets` em `clipboard.ts`). O intervalo colado fica selecionado.
- **Célula que não recebe valor fica como estava, sem barrar as outras.** São três grupos:
  - as calculadas: Id, Indicadores, Início e Término tardios, folgas, Crítica, linha de base, Decorrido, % alvo, Desvio e Variação;
  - as de resumo que vêm das subtarefas (`LEAF_ONLY`);
  - as presas ao andamento real (`pasteable`): o Início de tarefa já iniciada e o Término e a Duração de tarefa concluída, que se corrigem pelas datas reais. A conferência é feita no rascunho em montagem, então colar o Início real e o Início na mesma linha respeita a ordem das colunas.

  Um aviso "Colagem aplicada" diz quantas células ficaram como estavam. Se nenhuma recebe valor: "Nada foi colado: a célula de destino é calculada…".
- **Célula que já mostra o mesmo texto não é regravada.** Colar de volta a mesma data no Início não cria a restrição "Não iniciar antes de", e colar uma linha sobre ela mesma não muda nada.
- **Passou da última linha: vira tarefa nova no fim**, no nível e na data da última linha visível, como o "Inserir tarefa" nela, com o reagendamento uma vez só. Com filtro ligado isso é recusado ("Limpe o filtro…"), como o próprio "Inserir tarefa". O que passa da última coluna visível fica de fora, e o aviso conta.
- **Valor inválido cancela a colagem inteira e diz onde está**, por exemplo "Linha 3 · Duração: Use duração como…". O número da linha é o Id.
- Com a grade bloqueada: "Libere a edição da grade para colar.". Área de transferência sem texto (uma imagem) não apaga a célula.
- **Ctrl+D** usa as mesmas regras. Com uma linha só selecionada, copia a de cima, como no Excel (antes não fazia nada e deixava um passo vazio no desfazer).
- A colagem inteira é um passo só do Ctrl+Z. O limite de 1000 células por operação continua. As calculadas são contadas antes de entrar no limite, então uma coluna inteira preenchida com uma célula cabe.
- O editor de uma célula aberto continua com a colagem do próprio campo de texto.
- Manual da Claudia (`medio-prazo.ts`, seção "Editar uma célula") reescrito com essas regras.

Sem migração e sem mudança de dado.

### Validação (16/11/2026)

- `tests/plan-clipboard.test.ts`: dois testes novos para `pasteTargets` (repetição pela seleção e bloco que não divide a seleção).
- Navegador: `next dev` na 3102 com Supabase falso e Playwright, cronograma de cinco tarefas (um resumo, uma iniciada, uma concluída). Casos conferidos:
  - grade bloqueada: "Libere a edição da grade para colar.";
  - copiar Id…Duração de "Formas" e colar no Id de "Pintura": % concluída, nome e duração colados, e o aviso "2 células calculadas… ficaram como estavam";
  - "7 dias" numa seleção de Duração de cinco linhas: o resumo e a concluída ficaram, as outras três mudaram;
  - três nomes colados na última linha: duas tarefas novas no fim, com o aviso;
  - "4 dias / abc": "Linha 3 · Duração: …", sem alterar nada;
  - colar só no Id: "Nada foi colado…";
  - Ctrl+D numa linha: copiou o nome da linha de cima;
  - área de transferência vazia: nada mudou.
- **Não validado:** uso logado no servidor da ATR; os atalhos de teclado nativos de copiar e colar no Safari e no Firefox. No teste, os eventos de copiar e colar foram disparados diretamente.

## Médio prazo: calendário para os dias sem trabalho (16/11/2026)

### Pedido

"No médio prazo vamos melhorar a forma de definir dias não trabalhados. Está muito manual, abra um calendário para que possamos selecionar dias não úteis." Até aqui, os feriados do "Calendário de trabalho" eram um campo de texto, "Feriados (AAAA-MM-DD, separados por vírgula)". Um recesso de fim de ano exigia digitar data por data, e um erro de digitação só aparecia ao sair do campo.

### Comportamento entregue

- **Seção "Calendário de trabalho".** O campo de texto saiu. No lugar dele há o botão **"Dias sem trabalho"** e, ao lado, um resumo: "Nenhum dia marcado.", "3 dias no período: 20/11, 24/12, 25/12" ou, com dias fora do período, "… · 12 no total". O período é o horizonte do cronograma (três meses) ou a janela do Gantt de legalização. O botão abre um diálogo.
- **O diálogo mostra três meses lado a lado**, a partir do mês de início do cronograma. As setas trocam o mês, e "Voltar ao início" volta ao primeiro. No celular, os meses ficam um embaixo do outro.
  - **Clique** num dia marca ou desmarca. Dia sem trabalho fica vermelho.
  - **Arrastar** com o mouse marca ou desmarca o período, com prévia durante o arrasto. O primeiro dia decide: se estava livre, o período é marcado; se estava marcado, é desmarcado. **Shift+clique** repete, até o dia clicado, o que o clique anterior fez. No toque não há arrasto, para o dedo poder rolar a tela; marca-se um dia por vez.
  - **Fim de semana** fora dos dias úteis da semana aparece cinza e não se marca, porque já não é trabalhado. Num período, só entram os dias úteis da semana, como na importação do Project: o recesso que atravessa um sábado não grava o sábado. Um dia marcado que deixou de ser útil, porque o sábado foi desmarcado depois, por exemplo, ainda se desmarca.
  - **Feriado nacional** (`src/domain/holidays.ts`: datas fixas, Consciência Negra desde 2024 e Sexta-feira Santa) tem um ponto laranja e o nome na dica. **Carnaval** (segunda e terça) e **Corpus Christi** têm um ponto cinza. São ponto facultativo, não feriado nacional, e por isso não são marcados sozinhos. O botão **"Marcar N feriados nacionais destes meses"** marca os nacionais dos três meses à vista que caem em dia útil e ainda não estão marcados. A dica do botão lista quais são.
  - **Lista à direita** com todos os dias marcados, inclusive os que estão fora dos meses à vista, em ordem. Cada dia traz a data ("Sex 25/12/26"), o nome do feriado, "novo" quando foi marcado nesta abertura e um X para desmarcar. Clicar na data leva o calendário até o mês dela. "Desmarcar todos" limpa a lista.
  - **Teclado:** um dia por vez recebe o Tab. As setas andam um dia ou uma semana, PageUp/PageDown andam um mês, e Enter ou espaço marcam. Ao sair dos meses à vista, o calendário acompanha.
  - **Aplicar** grava a lista no rascunho e reagenda as tarefas pela rede, num passo só do Desfazer. O rodapé diz quantos dias foram marcados e desmarcados. **Cancelar**, o X ou Esc fecham sem mudar nada. Erro do motor aparece no rodapé, com o diálogo aberto.
  - **Sem a edição liberada** (grade bloqueada, cronograma congelado, salvando), o diálogo abre só para consulta: sem "Marcar feriados", sem X, com "Fechar".
- **O dado não mudou:** continua a lista `holidays` do `WorkCalendar` no `schedule_meta`. Ela vai ao banco em "Revisar e salvar" ("Calendário alterado nesta revisão."), entra no rascunho guardado no navegador e sai no .xml do Project como antes. **Sem migração.**
- Vale também no **Gantt de legalização** (aba 1), que usa a mesma grade.
- Código:
  - `src/modules/medio-prazo/non-working-days.ts` (puro): marcar dia e período, feriados nacionais que faltam numa faixa de meses, Carnaval e Corpus Christi, e o resumo ao lado do botão;
  - `src/modules/medio-prazo/non-working-days-dialog.tsx`: o diálogo;
  - integração em `schedule-sheet.tsx` (botão, resumo e `onApply` com `scheduleTasks`);
  - manual da Claudia (`medio-prazo.ts`, seção "Calendário de trabalho", com as palavras-chave "dias sem trabalho", "feriados" e "recesso");
  - texto do passo "Calendário de trabalho" do tour.

### Validação (16/11/2026)

- `tests/non-working-days.test.ts` (7 testes):
  - marcar e desmarcar;
  - sábado que não marca;
  - recesso nos dois sentidos do arrasto;
  - desmarcar um período;
  - feriados nacionais de novembro a janeiro, com e sem domingo útil;
  - Carnaval e Corpus Christi de 2027;
  - o resumo;
  - o dia marcado empurrando a tarefa no motor.
- Navegador: `next dev` na 3102, Supabase falso e Playwright, com um cronograma de duas tarefas (Formas, 18 a 24/11; Pintura, 21 a 25/12), em 1600 px e 390 px. Casos conferidos:
  - sem liberar a edição, o diálogo abre só para consulta, e o clique não marca;
  - "Marcar 4 feriados nacionais destes meses" marcou 02/11, 20/11, 25/12 e 01/01. A Proclamação da República (domingo) ficou de fora;
  - o clique no sábado não marcou;
  - o arrasto de 21/12 a 31/12 marcou os oito dias úteis, com a prévia durante o arrasto;
  - o clique desmarcou Finados;
  - o Shift+clique de 26/01 a 29/01 marcou os quatro dias;
  - PageDown em 29/01 foi a 28/02, e o calendário passou a mostrar de dezembro a fevereiro;
  - "Aplicar": Formas passou a terminar em 25/11 (era 24/11) e Pintura em 08/01 (era 25/12). O resumo mostrou "15 dias no período: 20/11, 21/12, …";
  - Desfazer voltou as datas e o calendário num passo, e Esc fechou sem aplicar;
  - sem erro de console.
- **Não validado:** uso logado no servidor da ATR; Safari e Firefox.

### Limites e próximas etapas

- Os feriados estaduais e municipais não são conhecidos: o sistema não sabe a cidade da obra. Marcam-se à mão.
- Não há "dia trabalhado fora do normal" (um sábado de trabalho num calendário de segunda a sexta), nem calendário por recurso, como já era antes.
- Os dias sem trabalho são de cada cronograma. O mês seguinte nasce como cópia e os leva junto, mas não há calendário da obra compartilhado entre os cronogramas.

## Médio prazo: excluir várias tarefas de uma vez (16/11/2026)

### Pedido

"Ainda no médio prazo, permita excluir mais de uma tarefa." Até aqui a lixeira excluía só a tarefa ativa, com os subitens dela. Mesmo com um intervalo selecionado, era preciso excluir linha por linha, com uma pergunta e um passo do desfazer para cada uma.

### Comportamento entregue

- **A lixeira exclui o intervalo selecionado.** A seleção é feita com Shift+clique ou Shift+setas, em qualquer coluna, a mesma que o recuo e o vínculo já usavam. O botão diz "Excluir as N tarefas selecionadas e os subitens (Delete)". Com uma linha só, diz como selecionar várias.
- **Uma pergunta só.**
  - Com várias linhas: "Excluir 3 tarefas?" ou "Excluir 3 tarefas e 2 subitens?", com a lista das linhas escolhidas (Id · nome; até 8, depois "e mais N").
  - Com uma linha, a pergunta de antes: "Excluir “Estrutura” e 2 subitens?". O singular "1 subitem" foi corrigido; antes saía "1 subitens".
  - Um resumo selecionado junto com subtarefas dele conta como uma raiz só.
- **O que sai** (`removeTasks`, puro, em `schedule-sheet.tsx`):
  - cada linha escolhida, com a subárvore inteira, inclusive o que está recolhido;
  - todos os vínculos que tocam qualquer tarefa excluída.

  A ordem é renumerada e a rede reagenda as sucessoras. Tirar subárvores inteiras não deixa nível pulado. O resumo que perde todos os filhos vira tarefa comum, como já acontecia ao excluir o último subitem. Tudo é um passo só do Ctrl+Z, e a exclusão fica no rascunho até "Revisar e salvar".
- **Tecla Delete** (ou o Backspace do Mac) com a seleção no **Id** ou no **Nome da tarefa**: faz o mesmo que a lixeira, sempre perguntando antes, como o Delete no nome da tarefa do Project. Nas outras colunas a tecla continua sem efeito. Com o editor da célula aberto, ela apaga texto, como sempre.
- Depois de excluir, a seleção e o foco ficam na linha que subiu para o lugar da primeira excluída (ou na última que sobrou), e as setas continuam funcionando.
- Mantido como era:
  - com filtro ou busca ativos, a exclusão não roda, como as outras operações de estrutura;
  - com a grade bloqueada, também não;
  - linhas que não ficam juntas na grade se excluem em mais de uma vez. Não há Ctrl+clique para escolher linhas soltas.
- Vale também no Gantt de legalização (mesma grade). Manual da Claudia (seção "Editar a grade", palavra-chave "excluir várias tarefas") e passo "Excluir tarefas" do tour atualizados. **Sem migração.**

### Validação (16/11/2026)

- `tests/plan-remove.test.ts` (4 testes):
  - três linhas soltas com vínculos;
  - resumo com subtarefa recolhida e subtarefa escolhida dentro dele;
  - subtarefas que saem sem levar o resumo, com a estrutura válida;
  - nada escolhido e tudo escolhido.
- Navegador: `next dev` na 3102, Supabase falso e Playwright. O cronograma tinha seis linhas, Estrutura (resumo com Formas e Armação), Alvenaria, Reboco e Pintura, com Armação → Reboco → Pintura. Casos conferidos:
  - Shift+clique de Alvenaria a Pintura e lixeira: o botão disse "Excluir as 3 tarefas selecionadas…", a pergunta listou "4 · Alvenaria, 5 · Reboco, 6 · Pintura" e as três saíram, com o foco na última linha;
  - um Ctrl+Z trouxe as três de volta;
  - Estrutura + Formas (Shift+↓): "Excluir “Estrutura” e 2 subitens?", e Cancelar não mudou nada;
  - Delete no Nome de Reboco: perguntou, excluiu e tirou o vínculo de Pintura. O foco foi para Pintura, e ↑ andou para a linha de cima;
  - Delete na Duração não fez nada;
  - Backspace no Id com Formas…Alvenaria: "Excluir 3 tarefas?", e ficaram Estrutura e Pintura;
  - sem erro de console.
- **Não validado:** uso logado no servidor da ATR.

## Médio prazo: vínculo com resumo (grupo) como predecessora e sucessora (16/11/2026)

### Pedido

"Permita ligar uma tarefa a um grupo como predecessora e antecessora." Até aqui só as subtarefas se vinculavam. O motor recusava qualquer vínculo com resumo ("Vincule as subtarefas, não as tarefas-resumo."), a coluna Predecessoras do resumo era calculada, o Vincular pulava os resumos, a barra do resumo no Gantt não se vinculava, e a importação do Project espalhava pelas subtarefas os vínculos que o arquivo tinha nos resumos.

### Regras do motor (`analyzeSchedule`, `src/domain/plan-schedule.ts`)

Seguem o Project. O resumo virou um nó da rede:
- **Resumo como sucessora:** o vínculo vale para **todas as folhas** abaixo dele, em qualquer nível. Cada subtarefa herda a predecessora, e quem tem uma predecessora própria mais tarde segue a mais tarde. Só entram vínculos que chegam no início, **TI e II**. TT ou IT para um resumo é recusado: "Resumo como sucessora aceita só Término-Início ou Início-Início, como no Project."
- **Resumo como predecessora:** a sucessora enxerga o **envelope** do resumo: o início mais cedo e o término mais tarde das folhas. Qualquer tipo é aceito: TI e TT usam o término do grupo; II e IT, o início.
- **Ordem da rede:** o resumo entra depois de todas as folhas dele, e o vínculo que chega a um resumo chega a cada folha. O ciclo que só existe através de resumos é pego pela mesma mensagem, "Essa ligação criaria um ciclo entre as linhas.". Resumo e as próprias subtarefas (ou os resumos acima) não se vinculam: "Um resumo não se vincula às próprias subtarefas."
- **Passada inversa:**
  - O vínculo de uma tarefa para um resumo limita o término tardio dela pelo menor início tardio das folhas do resumo.
  - O resumo com sucessora impõe um término tardio a todas as subtarefas dele. Num vínculo que sai do término (TI, TT), é o limite da sucessora. Num que sai do início (II, IT), é esse limite mais a duração do envelope.
  - Na prática, a subtarefa que segura o término do grupo fica crítica, e as mais curtas ganham folga.
- **Folga livre:** conta o vínculo que sai do término de um resumo acima da tarefa.
- **Indicadores:**
  - o "vínculo desrespeitado" de um vínculo herdado acende no **resumo**, quando alguma subtarefa ainda não iniciada fica presa antes da predecessora (por "Deve iniciar em", por exemplo);
  - a subtarefa fica com a folga negativa;
  - subtarefa já iniciada não conta como conflito: o restante dela espera a predecessora, como no "dividir tarefas em andamento".
- **Predecessoras determinantes:** a predecessora herdada aparece na subtarefa que ela segura.

### Tela

- **Coluna Predecessoras:** passa a ser editável na linha do resumo (saiu de `LEAF_ONLY`), digitando, colando ou copiando.
- **Informações da tarefa:**
  - a aba Predecessoras libera o resumo e explica a regra;
  - a lista de predecessoras não oferece mais a própria tarefa, as subtarefas dela e os resumos acima, que seriam recusados;
  - os resumos aparecem com "(resumo)".
- **Vincular e Desvincular:** o resumo entra na seleção como uma tarefa a mais, menos quando alguma subtarefa dele também está selecionada. Nesse caso quem se liga são as subtarefas, como antes.
- **Gantt:** arrastar a barra do resumo para fora da linha cria o vínculo, como nas outras barras, e a barra do resumo também serve de alvo. Ela continua sem mover, esticar ou puxar avanço.
- **Recuo:** a linha que vira resumo **mantém os vínculos**. Saem só os que a estrutura nova recusa (`linksForStructure`): resumo com as próprias subtarefas e TT ou IT chegando a um resumo. O aviso "N vínculos saíram" explica.
- **Textos:** a dica "Durações e predecessoras" explica a regra. Manual da Claudia (seção "Predecessoras", com "Vínculo com resumo (grupo)") e tour atualizados.

### Importação e exportação

- **Importação do Project** (`mspdi-import.ts`, feita por um agente em paralelo): o vínculo com resumo entra **no próprio resumo**, como no arquivo. A redistribuição pelas subtarefas e o aviso `vinculo_resumo` saíram.
  - O vínculo que liga um resumo às próprias subtarefas continua descartado (`vinculo_resumo_proprio`).
  - O TT ou IT que chega a um resumo é descartado com o aviso novo `vinculo_resumo_termino`: "Vínculos que chegam ao término de uma tarefa-resumo (TT ou IT) foram descartados: o Project só aceita Término-Início e Início-Início com o resumo como sucessora."
  - O `dropCycles` passou a montar a mesma rede do motor, então o ciclo que só existe através de resumos é descartado na importação, com `vinculo_ciclo`.
- **Exportação .xml** (`mspdi.ts`): o vínculo vai no resumo, como o Project grava. A folha cujo resumo tem predecessora deixou de ganhar "Não iniciar antes de" e de contar para o início do projeto, porque ela herda a predecessora.

Nada muda no banco: o vínculo continua sendo uma linha de `plan_dependencies`, agora com uma ponta num resumo. **Sem migração.** O servidor valida pelo mesmo motor no "Revisar e salvar".

### Validação (16/11/2026)

- Testes novos e revistos:
  - `tests/plan-summary-links.test.ts` (10): resumo como predecessora e como sucessora, resumo intermediário, resumo para resumo, subtarefa com predecessora própria, II com defasagem, prazo final, subtarefa presa antes (conflito no resumo), subtarefa iniciada (sem conflito) e as recusas;
  - `tests/sheet-columns.test.ts`: o recuo mantém os vínculos válidos, e há um teste novo de `linksForStructure`;
  - `tests/gantt-chart.test.ts`: o resumo se vincula e serve de alvo;
  - `tests/mspdi-import.test.ts`: 16 testes.
- Os cenários da bancada conferida no Project (`tests/fixtures/cenarios-project.ts`, rodados por `tests/plan-cpm.test.ts`) continuam passando sem mudança.
- Navegador, com `next dev` na 3102, Supabase falso e Playwright:
  - "1" na Predecessoras da Estrutura (resumo) levou Formas e Armação para depois da Fundação;
  - "2" na Alvenaria fez ela esperar a Armação, a subtarefa mais longa;
  - "1TT" no resumo e "2" na Formas (a subtarefa do próprio resumo) mostraram as recusas;
  - o arrasto da barra da Estrutura até o Reboco criou o vínculo, com a dica "De: Estrutura, Para: Reboco";
  - recuar o Reboco sob a Alvenaria manteve os vínculos dos dois;
  - nas Informações da Estrutura, a lista de predecessoras saiu sem as subtarefas dela;
  - sem erro de console.
- **Conferência no Project real: pendente.**
  - Os 20 cenários estão em `scripts/ms-project/cenarios-resumo.json`, com R01 a R20: tipos, aninhamento, prazo final, restrição, tarefa em andamento e as três recusas.
  - O motor calcula os 17 cenários válidos com os resultados esperados pela regra do Project.
  - A VM "Windows" ligou, mas o login automático do Windows estava desligado (`AutoAdminLogon` vazio) e ninguém estava logado, então a tarefa agendada que abre o Project não rodou.
  - Para conferir: entrar na VM e rodar `exportar-cenarios.ts` com esse arquivo, `vm.sh enviar` (com `entrada.txt` = `resumo,resumo-project`), `montar-no-project.ps1` e `comparar.py` (ver `docs/engenharia-reversa-project.md`).
  - Pontos que só o Project responde:
    - a passada inversa do resumo com sucessora II ou IT (R04, R06, R18);
    - se o Project lista a predecessora herdada como determinante da subtarefa;
    - a folga livre das subtarefas;
    - as mensagens das três recusas.
- **Não validado:** uso logado no servidor da ATR.

## Médio prazo: dividir a tela ao meio (16/11/2026)

### Pedido

"Crie um botão para recentralizar metade da tela com o Gantt (direita) e a outra metade com as infos."

### Comportamento entregue

- Botão **"Dividir ao meio"** (ícone de duas colunas) na barra de status, logo depois de "Tabela e Gantt", "Somente tabela" e "Somente Gantt". **Duplo clique na faixa** entre a tabela e o Gantt faz o mesmo.
- Ele volta para tabela e Gantt lado a lado, se a tela estiver em outro modo, e mede a largura da área: a tabela fica com metade, à esquerda, e o Gantt com a outra metade, à direita (`splitInHalf` em `schedule-sheet.tsx`).
- Quando as colunas visíveis não enchem a metade, o "Nome da tarefa" alarga até encher. O limite é 600 px, o máximo que as preferências guardam. Se ainda faltar, a tabela fica mais estreita e o Gantt ocupa o resto, porque a tabela nunca passa da soma das colunas.
- A divisão e a largura do nome ficam salvas nas preferências do cronograma, como já acontecia ao arrastar a faixa.
- Vale também no Gantt de legalização da aba 1, que usa a mesma tela. Passo "Tabela e Gantt" do tour e manual da Claudia atualizados. **Sem migração.**

### Validação (16/11/2026)

- `tsc` e `eslint` sem erros novos.
- Navegador, com `next dev` na 3102, Supabase falso e Playwright, cronograma de seis linhas. Larguras medidas (área / tabela / Gantt):
  - tela de 1600 px: faixa arrastada para 417 px de tabela, e o botão levou a 624 / 624 numa área de 1254;
  - em "Somente Gantt", o botão voltou para lado a lado com 624 / 624;
  - faixa movida pelo teclado para 960 px, e o duplo clique na faixa voltou para 624 / 624;
  - tela de 2560 px (área de 1510): 752 / 752;
  - só Id e Nome visíveis, com a tabela em 400: o botão levou a 624 / 624, com o Nome alargado de 300 para 470. Depois de recarregar, a divisão e o Nome continuaram assim;
  - sem erro de console.
- **Não validado:** uso logado no servidor da ATR.

## Médio prazo: imprimir o cronograma em A3 (16/11/2026)

### Pedido e modelo

"Crie um botão de imprimir planejamento." Antes do código, foi publicado um modelo da folha (A4 deitada com dados de exemplo e 11 regras numeradas, como no PDF do fechamento). Resposta do usuário: "pode seguir assim, plote em A3 ao invés de A4". As 11 regras ficaram como no modelo, só com o papel trocado.

### Comportamento entregue

- **Botão "Imprimir"** no rodapé, ao lado de "Exportar para o Project (.xml)". **Ctrl+P** (Cmd+P) na tela do cronograma abre a mesma impressão (regra 1). A impressão pelo menu do navegador também sai igual: o evento `beforeprint` monta as folhas antes do retrato da página.
- **Papel A3 deitado**, margem de 7 mm (`@page`). Na tela de impressão do navegador, "Salvar como PDF" gera o arquivo.
- **Cabeçalho de cada folha:**
  - faixa azul com os logos da ATR e da Takt;
  - "Planejamento de médio prazo · obra (código)";
  - cronograma, mês, janela e linha de base escolhida;
  - "Impresso em dd/mm/aaaa às hh:mm por (nome)".

  Embaixo vem uma linha com tarefas, avanço do plano, críticas, início e término, e à direita o filtro ativo e os grupos recolhidos.
- **Tabela com colunas fixas** (regra 3): Id, Nome da tarefa, Duração, Início, Término, % concluída e Recursos. Ela ocupa 690 px dos 1534 px da folha, cerca de 45% (regra 4). Os textos são os mesmos da grade (`raw`/`planRaw`), com a linha 0 do cronograma inteiro. O recurso é o nome curto que o Gantt escreve ao lado da barra.
- **Gantt dos três meses do cronograma** na largura da folha (regra 5): meses em cima e semanas embaixo.
  - Desenha as faixas dos dias sem trabalho pelo calendário do cronograma, as barras com avanço, o resumo em colchete, os marcos com a data e a linha de hoje.
  - A crítica sai em vermelho só com "Caminho crítico" ligado. A linha de base sai em cinza sob a barra quando há uma escolhida, e o nome da equipe sai ao lado da barra só com "Nomes dos recursos" ligado (regra 8).
  - Barra que passa da janela é cortada na borda. O nome que não cabe à direita vai para a esquerda da barra.
  - Não saem as setas dos vínculos, a folga, o prazo final nem o caminho da tarefa, que também não estavam no modelo aprovado.
- **Quais linhas** (regra 6): as mesmas linhas do Gantt da tela (`ganttRows`). Filtro, busca e grupos recolhidos valem, e o cabeçalho escreve o filtro ("Filtro: Críticas · busca “laje”") ou "Filtro: nenhum · todos os grupos abertos".
- **Rascunho** (regra 7): sai o que está na tela. Uma faixa amarela avisa quantas tarefas ainda não estão no sistema, e as linhas alteradas ganham uma faixa amarela à esquerda. A célula em digitação é confirmada antes, como no salvar.
- **Várias folhas** (regra 9): 41 linhas por folha, ou 40 com a faixa do rascunho. A conta é fixa, porque cada faixa tem altura fixa (`print-layout.ts`). Cada folha repete o cabeçalho, os títulos da tabela e a régua do Gantt; nenhuma linha é cortada, e o rodapé traz a legenda e "Folha n de m".
- **Nome do arquivo** (regra 10): o título da aba vira o nome sugerido do PDF durante a impressão, por exemplo "Médio prazo ATM - Novembro 2026". Com mais de um cronograma no mês, o nome do cronograma vai junto. O título da aba volta ao normal depois.
- **Gantt de legalização** (regra 11): mesmo botão, com o título dele e a janela de 12 meses. A régua passa a anos e meses quando as semanas não cabem.
- **Como funciona:** `print-schedule.tsx` desenha as folhas (tabela em HTML, Gantt em SVG) e `schedule-sheet.tsx` as põe direto no `<body>` (portal) só enquanto imprime. Na impressão, o resto da página some e a casca do sistema deixa de prender a altura da tela; na tela, as folhas nunca aparecem. Os logos ficam em cache desde a abertura do cronograma. Tour (passo "Imprimir") e manual da Claudia (seção "Imprimir") atualizados. **Sem migração.**

### Validação (16/11/2026)

- `tests/print-schedule.test.ts` (8 testes):
  - medidas da folha A3;
  - colunas que somam a tabela;
  - linhas por folha e paginação (95 linhas viram 41 + 41 + 13);
  - régua de 3 meses (meses, semanas a partir da segunda e última semana cortada) e de 12 meses (anos e meses);
  - dias sem trabalho com feriado;
  - barra com as bordas do dia e cortada na janela;
  - lado do nome;
  - cores e nome do arquivo.
- Navegador, com `next dev` na 3102, Supabase falso e Playwright. Cronograma de exemplo com 7 grupos (56 tarefas), equipes, linha de base 2 dias antes e uma tarefa renomeada no rascunho. Resultados:
  - o botão montou 2 folhas (40 + 17 linhas), chamou a impressão com o título "Médio prazo RH-01 - Novembro 2026" e o título voltou depois;
  - a faixa do rascunho apareceu e 1 linha saiu marcada. As folhas ficaram escondidas na tela;
  - Ctrl+P montou e chamou de novo;
  - com o filtro "Críticas", o evento `beforeprint` montou 1 folha com "Filtro: Críticas";
  - o PDF gerado pelo Chromium (`page.pdf` com o tamanho do CSS) saiu em 420 × 297 mm, conferido visualmente, inclusive o PDF gerado sem clicar em nada, que é o caminho do menu do navegador;
  - sem erro de console.
- **Não validado:**
  - impressão real numa impressora A3;
  - Safari e Firefox;
  - o Gantt de legalização no navegador (a régua de 12 meses está coberta só pelo teste);
  - uso logado no servidor da ATR.

## Médio prazo: abrir no cronograma mais recente (16/11/2026)

### Pedido

"Sempre mostrar o planejamento de médio prazo mais recente antes, não o mais antigo."

### O que estava acontecendo

A tela do cronograma abria no cronograma do **mês corrente**. Quando a obra já tinha criado o do mês seguinte, por exemplo dezembro copiado de novembro ainda em novembro, a tela continuava abrindo novembro, o mais antigo. Ao mesmo tempo, a Claudia, o resumo dos três meses e a variação da linha de base já usavam o mais recente. A ordem do seletor já era do mais recente ao mais antigo.

### Comportamento entregue

- A tela abre no **mais recente**: o cronograma do mês mais adiante e, no mesmo mês, o criado por último. Plano congelado só entra se não houver nenhum vivo. A regra fica em `latestPlan` (`src/domain/legalization.ts`), sobre a mesma ordem `newestPlanFirst` do seletor e da Claudia.
- Escolher outro cronograma no seletor continua valendo enquanto a tela está aberta. Ao voltar para a aba, ela abre de novo no mais recente.
- **Não mudou** o painel de médio prazo do Dashboard da obra e do Dashboard geral (`pickPlan`). Ele escolhe o cronograma do mês da **semana analisada**, para que uma semana passada seja lida contra o cronograma daquela época.
- Tour (passo do seletor) e manual da Claudia atualizados. **Sem migração.**

### Validação (16/11/2026)

- `tests/plan-monthly.test.ts` ganhou o teste "latestPlan: a tela abre no mais recente, mesmo com o mês corrente criado antes". Ele cobre novembro criado em 08/11 com dezembro criado depois (abre dezembro), dois no mesmo mês em qualquer ordem, plano congelado e lista vazia.
- A consulta de leitura aos cronogramas de produção (mês e data de criação por obra), para ver o caso real da equipe, foi barrada pela permissão desta sessão. A causa foi deduzida do código.
- **Não validado:** uso logado no servidor da ATR.

## Longo prazo e Quadro de Restrições: retorno do Atmos (16/11/2026)

### Pedido

O coordenador de obras do Atmos testou o longo prazo e o Quadro de Restrições e mandou um retorno por e-mail em 16/11/2026. O pedido do gerente foi resolver os pontos e responder, com uma orientação: usar a Claudia para pré-preencher o vínculo entre o orçamento (execução) e os pacotes de serviço (planejamento), deixando para o engenheiro da obra só validar e corrigir. A diferença de avanço e de IDP em relação ao Prevision (20% lá, 7,3% aqui) vem do peso: o Prevision pondera pelo financeiro, e o Obra 360 só faz isso depois que todos os pacotes com blocos têm custo apropriado; até lá pesa pela duração.

A parte do Quadro de Restrições está em [Lista de pendência](lista-pendencia.md), seção "Retorno do Atmos (16/11/2026)".

### Comportamento entregue (implementado; **sem migração**)

- **Menu "⋯" cortado.** A barra quebra em várias linhas, e o botão "⋯", alinhado à direita, podia cair no começo de uma linha: aberto para a esquerda, o menu sumia atrás do menu lateral. O painel flutuante agora mede o espaço ao abrir e troca de lado quando não cabe (`Popover`, em `lob-view.tsx`).
- **Barra reorganizada.** Em cima ficam as ações da obra: "Lançar fluxo", "Nova medição", "Custos", "Salvar linha de base", "Atrasos", "Desfazer" e "⋯". Os controles de visualização foram para o cabeçalho do quadro do gráfico: "Serviços", "Locais", "Período", "Linha de base", zoom, "Hoje", "Caminho crítico", o cadeado e "Tabela".
- **Filtro no lugar da legenda.** A legenda de chips embaixo do gráfico saiu. Esconder e mostrar serviços é pelo filtro "Serviços", que mostra a cor de cada um e ganhou busca pelo nome (em listas com mais de 8 itens; vale também para "Locais").
- **Zoom.** Quatro escalas, cada uma com o seu cabeçalho de tempo em duas faixas: "Semana" (16 px por dia; meses em cima, uma coluna por semana com o dia da segunda-feira), "Mês" (4,5 px por dia; anos em cima, meses embaixo), "Trimestre" (1,5 px por dia; anos em cima, T1 a T4 embaixo) e "Obra inteira" (encaixa a obra na largura da tela; é como a tela abre). Os botões "−" e "+" multiplicam a escala em passos de 1,25 (de 0,25 a 6 vezes), e Ctrl + roda do mouse (ou a pinça do trackpad) sobre o gráfico faz o mesmo, mantendo parado o ponto sob o ponteiro. Antes, "Mês" (encaixado, 1,5 a 4 px por dia) e "Trimestre" (1 px) ficavam quase iguais numa obra de dois anos. Geometria e cabeçalho em `lob-model.ts` (`pxPerDayFor`, `lobHeader`), desenho em `lob-chart.tsx`.
- **Datas travadas.** O gráfico abre com as datas travadas: arrastar e as setas não mudam nada. O cadeado no cabeçalho do gráfico libera e trava; a escolha fica guardada no navegador (`localStorage`, chave `obra360.lob.datas-travadas`). O painel do bloco selecionado continua editando início e duração, porque ali a mudança é deliberada. Perfil de consulta não vê o cadeado.
- **Caminho crítico.** O botão "Caminho crítico" destaca com contorno roxo os blocos sem folga e esmaece os demais; o selo mostra quantos são, a dica do bloco mostra a folga em dias úteis e uma linha abaixo do gráfico explica o destaque. A conta está em `src/domain/lob-critical.ts` (`lobCriticalPath`): passagem de volta do CPM sobre as dependências entre blocos ("depois de" e "equipe segue", com a espera, inclusive negativa), a partir do fim da obra. Como a Linha de Balanço não reagenda para o mais cedo, a folga sai da data atual de cada bloco: quantos dias úteis ele pode atrasar sem empurrar o término. Folga zero ou negativa (dependência violada) é crítico; bloco preso num ciclo fica de fora.
- **Claudia sugere o vínculo dos custos.** Na visão Custos, o botão "Sugerir com a Claudia" aparece para quem pode editar quando há itens do orçamento sem pacote. A Claudia lê o código e a descrição de cada item não apropriado (o valor em reais não é enviado) e propõe o pacote de serviço; custos indiretos (administração, canteiro, taxas) ficam sem pacote. Vai em lotes de 300 itens, com andamento na tela e cancelamento entre lotes, até 3.000 itens por clique. As sugestões entram só no rascunho: cada item ganha o selo "Sugestão da Claudia" ("confira" quando ela ficou em dúvida) e todos aparecem no quadro "Sugestões da Claudia", com os duvidosos primeiro e um seletor de pacote por linha. O engenheiro confere, corrige e clica em "Salvar"; "Desfazer sugestões" devolve tudo a não apropriado. Rota `POST /api/lob/costs/suggest` (módulo longo prazo, consulta recusada), que confere o teto de gasto da IA antes de chamar e grava o uso depois, como uma pergunta; a resposta do modelo vem em saída estruturada (JSON com esquema) e é validada no servidor (`suggestCostLinks` e `parseCostLinks`, em `src/infrastructure/agent/chat.ts`; teto em `src/infrastructure/agent/budget.ts`, extraído da rota da Claudia sem mudar comportamento).
- **Sienge.** Não existe integração direta com o Sienge. O texto de "Colar do orçamento" passou a dizer que a planilha pode ser a exportação do orçamento do Sienge (código, descrição e valor).

### O que já existia e foi só esclarecido

- **Avanço menor que o da medição anterior.** A trava já existe na tela e no servidor (`validateMeasurementValue`): o acumulado não pode ficar abaixo do valor da medição fechada anterior. O que continua permitido é corrigir, para cima ou para baixo, um valor dentro da última medição, que é a única editável; na primeira medição da obra não há anterior. Não foi possível ver nos dados de produção qual foi o caso do Atmos (a leitura do banco foi barrada pela permissão da sessão).
- **Versões do cronograma.** São as linhas de base ("Salvar linha de base": guardar com nome, comparar no gráfico, restaurar).

### Validação (16/11/2026)

- Testes: `tests/lob-critical.test.ts` (7, novo), `tests/lob-model.test.ts` (14, com 10 novos de zoom e cabeçalho), `tests/lob-costs-model.test.ts` (5 novos), `tests/agent-cost-links.test.ts` (7, novo), manual e tour.
- Chamada real à IA com 24 itens e 12 pacotes fictícios: 18 itens ligados ao pacote certo, 6 indiretos ou sem pacote correspondente deixados de fora, 3,5 s e US$ 0,008 no Sonnet 5.5. Estimativa para um orçamento de 1.500 itens: de US$ 0,25 a 0,45 (não medido).
- Navegador (Playwright, `next dev` local com Supabase falso e APIs respondidas pelo script, obra de exemplo com 16 locais, 12 serviços e 192 blocos; 1500, 1100 e 390 px): o menu "⋯" abre inteiro dentro da área da página nas três larguras; as quatro escalas dão larguras bem diferentes (8.342, 2.443, 904 e 1.144 px); "+" duas vezes leva de 2.443 a 3.741 px; caminho crítico com 16 blocos em destaque; arrastar com as datas travadas não manda comando e, liberado, manda um `update_activity`; busca no filtro de serviços; na visão Custos, a sugestão manda só id, código e descrição e o resumo e o quadro de revisão aparecem. Sem erro de console.
- **Não validado:** uso logado no servidor da ATR; a sugestão da Claudia com o orçamento real do Atmos (qualidade dos vínculos e tempo de um lote de 300); o zoom pela pinça do trackpad; a rota de sugestão de ponta a ponta com o banco (autorização, teto e gravação do uso têm só as funções puras testadas).

### Próximas etapas (não implementadas)

- **Calendário com feriados e recessos na Linha de Balanço.** Hoje o calendário é de segunda a sexta. Ligar feriados muda o término calculado de todos os blocos (a duração é em dias úteis), então pede cadastro por obra, migração e a conversão das durações já gravadas; fica para uma etapa própria, com modelo antes. **Feito em 23/11/2026**, sem conversão das durações (ver a seção do retorno do Jorge).
- **Cenários.** Simular mudanças sem alterar o planejamento vigente e guardar o cenário com nome. Hoje o caminho é salvar uma linha de base antes de mexer e restaurá-la.
- **Sienge direto.** Buscar o orçamento pela API do Sienge depende de credenciais de API da ATR. **Feito em 23/11/2026** (ver [Orçamento direto do Sienge](#longo-prazo-orçamento-direto-do-sienge-na-visão-custos-23112026)).
- Levar o caminho crítico para a tabela e para o relatório da Claudia.

## Médio prazo: salvamento automático no lugar do "Revisar e salvar" (17/11/2026)

### Pedido e decisão

"Essa função de salvar o cronograma manualmente não está legal. Criar a linha de base já tem esse propósito de manter o histórico. Vamos deixar salvando automaticamente em cada mudança sem controlar revisão. A aba de comentários serve para isso, inclusive. O controle de versionamento é feito pela linha de base. Deixe um lembrete para o usuário salvar a linha de base sempre que não tiver salvado no planejamento."

Isso **reverte a decisão de 25/09/2026** ("Rascunho + Revisar e salvar com motivo obrigatório"). Não há mais revisão nem motivo digitado. O versionamento passa a ser a linha de base, e o porquê de uma mudança vai nas anotações da tarefa.

### Comportamento entregue

- **Gravação automática.** Cada alteração da pessoa vai ao sistema 1,2 s depois da última (`AUTOSAVE_MS`), uma gravação por vez. O comando é o mesmo `save_plan_revision`, com o motivo fixo "Salvamento automático"; **o servidor não mudou e não há migração**.
- **A edição não trava enquanto grava.** O que for alterado durante uma gravação vai na seguinte. Ao fim de cada gravação, a referência de conflito (`base`) passa a ser a versão recém-gravada.
- **Só alteração da pessoa dispara gravação.** O rascunho que chega do servidor (abertura, recarga, retorno de gravação) é marcado em `serverDraft` e não regrava, o que evita laço.
- **Ctrl+Z e Ctrl+Y continuam depois de salvo.** A pilha de desfazer deixou de ser zerada a cada gravação, e desfazer também é gravado.
- **Estado ao lado do seletor de mês:** "Salvando…", "Tudo salvo", "Não salvo: (motivo)" ou "Não salvo: o cronograma mudou no sistema". Saíram o botão "Revisar e salvar", o diálogo "Revisar atualização" e o aviso verde "Cronograma salvo".
- **Recusa do servidor ou queda da rede:** o motivo fica em vermelho, com "Tentar salvar de novo". Outra alteração tenta de novo sozinha. "Descartar alterações não salvas" só aparece nesse caso e no conflito.
- **Conflito** (o cronograma foi salvo por outra pessoa, em outro computador ou em outra aba): as gravações param, a tela pede a versão do sistema e mostra o aviso âmbar com "Usar sobre a versão atual" (grava por cima) e "Descartar alterações". Continua sem junção das duas versões.
- **Cópia de segurança no navegador** (o rascunho de 16/11): continua guardando o que ainda não chegou ao sistema. Ao reabrir o cronograma no mesmo navegador, ela é gravada sozinha; se o cronograma mudou no meio-tempo, cai no aviso de conflito. O aviso azul "Rascunho não salvo recuperado" saiu.
- **Lembrete da linha de base.** Cronograma vivo com tarefas e sem nenhuma linha de base mostra o aviso azul "Este cronograma ainda não tem linha de base", com o botão "Definir linha de base agora" (o mesmo formulário do rodapé, só com tudo salvo). Some quando a primeira linha de base é definida. Vale também no Gantt de legalização.
- Sair da tela com gravação pendente pergunta "Sair antes de terminar de salvar?"; fechar a aba também avisa.
- Textos, tour (passos "Salvamento automático" e "Descartar alterações não salvas") e manual da Claudia (médio e longo prazo) atualizados.

### Validação (17/11/2026)

- Navegador, com `next dev` na 3102, Supabase falso e Playwright. As gravações foram aplicadas por `applyCommand` de verdade sobre os dados de exemplo. Resultados:
  - abre com "Tudo salvo", lembrete da linha de base visível e sem botão "Revisar e salvar";
  - uma edição mostrou "Salvando…" e chegou ao servidor com o motivo "Salvamento automático";
  - duas edições seguidas viraram uma gravação só;
  - com o servidor demorando 2,5 s, a edição seguinte não travou e foi na gravação seguinte;
  - Ctrl+Z e Ctrl+Y depois de salvo voltaram e refizeram o nome no servidor;
  - recusa do servidor mostrou "Não salvo: …" e o botão; "Tentar salvar de novo" gravou;
  - cronograma alterado por fora mostrou o aviso de conflito; "Usar sobre a versão atual" gravou por cima;
  - a linha de base definida pelo lembrete foi criada e o lembrete sumiu;
  - recarregar a página trouxe o que estava gravado;
  - sem erro de console.
- **Não validado:** uso logado no servidor da ATR, duas pessoas reais editando ao mesmo tempo e cronograma grande (cada gravação recarrega o planejamento inteiro, como o salvar manual já fazia).

### Limites e próximas etapas

- Cada gravação gera entradas "Salvamento automático" no histórico da tarefa. São mais entradas que antes, e sem motivo.
- O lembrete só olha se existe alguma linha de base. Ele não avisa que o cronograma mudou depois da última.
- No conflito não há junção por tarefa: vale uma versão ou a outra.

## Médio prazo: mais de um recurso por tarefa (17/11/2026)

### Pedido

"Precisamos ter a opção de colocar mais de um recurso."

### Como foi modelado

- `PlanTask.teamId` continua sendo o **primeiro** recurso, na coluna `team_id` de sempre. Os demais vão em `extraTeamIds`, dentro do `schedule_meta` (jsonb). **Sem migração**, e tudo o que lê só `teamId` continua funcionando.
- Leitura e escrita passam por `taskTeamIds` e `setTaskTeamIds` (`src/domain/entities.ts`): ordem escolhida, sem repetição.
- Como no Project, cada recurso fica ocupado pela tarefa inteira (100% cada). Não há percentual de unidades por recurso.

### Comportamento entregue

- **Coluna "Nomes dos recursos":** o seletor ganhou "Mais de um recurso…", que abre a aba Recursos das Informações da tarefa. A coluna mostra todos, separados por "; ". Com vários, o seletor traz a opção "(atual)" para manter. Digitar ou colar "Elétrica;Revestimentos" também vale; recurso fora do cadastro é recusado pelo nome.
- **Informações da tarefa, aba Recursos:** uma caixa de marcar por equipe, com a capacidade ao lado, no lugar da lista de escolha única.
- **Carga:** a tarefa entra na linha e na carga de **cada** equipe em quatro lugares: Planejador de Equipe, Uso dos Recursos e Planilha de Recursos (`resource-usage.ts`), a seção Recursos semana a semana (`schedule-analysis.ts`), o aviso de capacidade (`teamLoad`) e a contagem de uso da equipe (`teamUsage`). Equipe usada só como recurso adicional também não pode ser excluída.
- **Planejador de Equipe:** arrastar uma tarefa com vários recursos para outra linha troca só a equipe da linha de origem; soltar em "não atribuídas" tira só essa. O seletor "Atribuir a" troca o primeiro recurso.
- **Filtro por recurso e busca:** acham a tarefa por qualquer das equipes. No Dashboard, o filtro por empreiteiro do médio prazo também.
- **Gantt e impressão:** os nomes de todas as equipes ao lado da barra e na coluna Recursos. O resumo dos três meses e a lista de tarefas da Claudia também mostram todas.
- **Servidor** (`save_plan_revision`): valida que cada recurso adicional é equipe da obra, tira repetidos, limita a 21 e registra `extraTeamIds` no histórico da tarefa ("Recursos adicionais").

### Validação (17/11/2026)

- `tests/plan-multi-resource.test.ts` (3 testes): os auxiliares; a tarefa na linha e na carga de cada equipe, com superalocação; e o servidor (grava, tira repetido, recusa equipe de fora, ida e volta pelo formato do banco, equipe adicional não pode ser excluída). `tests/team-planner.test.ts` ajustado para a equipe de origem do arrasto.
- Navegador, com `next dev` na 3102, Supabase falso e Playwright gravando por `applyCommand`:
  - uma equipe pelo seletor;
  - "Mais de um recurso…" com duas caixas marcadas: a célula mostrou "SM MARTINS · Revestimentos; ATR ENG · Elétrica" e o servidor gravou as duas;
  - a opção "(atual)" apareceu ao reabrir o seletor;
  - colar "Elétrica;Revestimentos" em outra linha funcionou;
  - o filtro por cada uma das equipes achou a tarefa;
  - as duas equipes continuaram depois de recarregar;
  - sem erro de console.
- **Não validado:** o arrasto no Planejador com tarefa de vários recursos no navegador (só o cálculo, pelos testes) e uso logado no servidor da ATR.

### Limites e próximas etapas

- A importação do `.xml` do Project continua ligando um recurso por tarefa, e a exportação segue sem os nomes dos recursos.
- O curto prazo e a criação de linha da semana a partir da tarefa (Claudia) usam o primeiro recurso.
- A marca de célula alterada na coluna de recursos só olha o primeiro recurso.

## Gantt de legalização: criar pendência a partir de uma linha (19/11/2026)

A pedido do usuário, o botão "Criar pendência" do cronograma (barra e "Informações da tarefa") deixou de ser escondido no Gantt de legalização da aba 1.1: a linha selecionada vira card do Quadro de Restrições (aba 1.4), com a entrega no dia útil anterior ao início e acompanhando a reprogramação, como já acontecia no médio prazo e na Linha de Balanço. O quadro mostra a origem como "Gantt de legalização · nome da linha". Sem migração. Comportamento, decisões, validação e pendências em [Lista de pendência](lista-pendencia.md#gantt-de-legalização-como-origem-19112026).


## Retorno do Jorge (Atmos): nove pontos de curto, médio e longo prazo (23/11/2026)

### Pedido

O engenheiro Jorge Lucas mandou em 20/11/2026 um retorno por e-mail com nove pontos: dois do curto prazo, dois do médio e cinco do longo prazo, vários comparando com o Prevision e o MS Project. O gerente aprovou o plano de ação inteiro em 23/11/2026, incluindo o botão que leva tarefas do cronograma para a planilha da semana, o calendário por obra na Linha de Balanço (migração 0056) e a visão Curva S sem modelo prévio.

### Curto prazo (implementado; **sem migração**)

- **Excluir linha.** A exclusão já existia (✕ com confirmação e Desfazer), mas ficava na última coluna, em cinza-claro e sem título, e saía da tela quando a coluna "Apontamento" aparecia. Agora a coluna **"Ações"** (inserir acima e ✕) fica presa à borda direita do painel, com fundo opaco, e o ✕ é mais escuro e fica vermelho ao passar o mouse. O perfil de consulta não vê a coluna.
- **"Limpar" na linha em branco.** Quem preenche empresa, datas ou equipe sem escrever a atividade vê "Limpar (Esc)" e um ✕ na coluna Ações; os dois e a tecla Esc esvaziam o rascunho. No celular, o cartão "Nova linha" tem o botão "Limpar".
- **"Excluir N" na barra de linhas marcadas.** Uma confirmação só, que diz quantas têm apontamento. Manda um `delete_commitment` por linha pela mesma fila do ✕ (não há comando novo no servidor) e entra no Desfazer como uma ação, que recria as linhas no lugar e regrava o Sim/Não. Só aparece para quem pode excluir; a trava da semana encerrada não mudou (a partir da quarta-feira seguinte, só admin).
- **Tela maior.** A aba do curto prazo (planilha e Fechamento) deixou de ter o teto de 1.600 px de largura: `isFullWidthPath` (`src/modules/curto-prazo/full-width.ts`) é lida pela barra de cima e pelo `AppMain` (`src/modules/layout/top-bar.tsx`), que substitui o `<main>` do layout. As outras telas continuam com o teto.
- **Colunas acompanham o painel.** Um `ResizeObserver` mede o painel e reajusta as colunas a cada mudança de largura, considerando só as colunas à vista (antes a conta incluía "Apontamento" e a caixa de marcar mesmo escondidas). Sem larguras escolhidas à mão, a tabela ocupa o painel inteiro. Quem arrastou uma borda fica com as suas larguras, guardadas com a largura do painel em que foram definidas (chave `_painel` no mesmo registro `obra360.curto-prazo.colunas`), e elas crescem ou encolhem na proporção do painel, sem descer do mínimo de cada coluna. Larguras guardadas no formato antigo valem como estão e ganham a referência na primeira medição.
- **"Ajustar à tela" mudou de sentido.** Antes ajustava uma vez e gravava as larguras, o que congelava a planilha. Agora apaga as larguras escolhidas e volta ao ajuste automático.
- **Botões de "Apontamento".** Passaram a quebrar de linha, e o mínimo da coluna foi de 112 para 130 px (Causas e Justificativas cederam 18 px), porque os botões estouravam a célula e ficavam atrás da coluna presa.

Regras puras em `column-widths.tsx` (`parseStoredWidths`, `serializeStoredWidths`, `rescaleWidths`, `layoutWidths`), `undo.ts` (`restorePlan`, `deletionLabel`) e `bulk-bar.tsx`.

### Médio prazo (implementado; **sem migração**)

- **"Mostrar até" o nível.** Ao lado de Expandir e Recolher há a lista "Mostrar até: Nível 1, Nível 2… Todos (nível N)", como "Mostrar subtarefas" do Project. Escolher o Nível K recolhe os resumos de profundidade K ou maior e abre os de cima. A profundidade é a do número EAP (`rollUpPlan`), não o `level` cru. A seta de cada resumo continua valendo e leva a lista a "Personalizado". Usa o mesmo estado `folded`, então fica guardada por pessoa e cronograma e vale na impressão, cujo cabeçalho diz "mostrando até o nível K". Fica desligada com busca ou filtro. Regras em `plan-view.ts` (`outlineDepth`, `maxOutlineDepth`, `foldedForLevel`, `shownLevel`). Vale também no Gantt de legalização.
- **"Gantt de controle".** O Jorge procurava o Tracking Gantt pelo nome que o Project em português usa. A visão já existia (barra da linha de base, % concluída, início e término reais) com o nome "Gráfico de Gantt"; foi renomeada no seletor "Modo de exibição", na barra de status e no rótulo em pé. O lembrete do cronograma sem linha de base diz que a barra cinza e a variação em dias só aparecem depois de "Definir linha de base". No Gantt de legalização o modo de exibição leva o mesmo nome.
- **"Levar para o curto prazo".** Botão no grupo "Tarefa" do Gantt de controle, para quem não é consulta e tem o curto prazo liberado; não aparece no Gantt de legalização. O diálogo escolhe a semana (atual ou próxima) e lista as tarefas-folha selecionadas, ou todas as previstas na semana, com a situação de cada uma: "Linha nova" (marcada), "Já está na planilha" (nome igual na semana; desmarcada), "Concluída no cronograma" (desmarcada), "Sem dia nesta semana" e "Só cai em dia sem trabalho nesta semana" (indisponíveis). "Criar N linhas" manda um `create_commitment` por tarefa, em sequência, com nome, empresa e equipe do recurso principal e os dias do primeiro ao último dia útil da tarefa dentro da semana. **Não cria vínculo** entre a tarefa e a linha: a decisão de o curto prazo se sustentar sozinho continua. Se o servidor recusar uma linha, a criação para e o diálogo diz quantas entraram. Regra em `src/domain/plan-to-week.ts`, que a Claudia também passou a usar em `propor_criar_linhas`, sem mudar o comportamento dela; diálogo em `carry-to-week-dialog.tsx`.

### Longo prazo, Linha de Balanço (implementado; **migração 0056 aplicada em 23/11/2026**)

- **Dias sem trabalho grifados.** Faixas cinza-claras atrás dos blocos nos sábados, domingos e dias sem trabalho do calendário da obra, com dias seguidos numa faixa só. Aparecem a partir de 2,5 px por dia (zooms Semana e Mês); no Trimestre somem. No zoom Semana (dia com 14 px ou mais) o cabeçalho mostra o número de cada dia. `LobLayout.offRuns` e `LobHeader.days`, em `lob-model.ts`.
- **Calendário de dias úteis por obra.** Botão "Calendário" na barra da Linha de Balanço: dias da semana trabalhados e um calendário clicável de dias sem trabalho, no molde do médio prazo, com o atalho dos feriados nacionais que faltam. Tabela `lob_calendars` (uma linha por obra, só quando alguém configura); obra sem linha usa segunda a sexta sem feriados, que era a regra fixa, então **aplicar a migração não mudou data nenhuma**. O calendário vai em `LobData.calendar` e todas as contas de dias úteis o recebem (blocos, cascata, lançamento de fluxo, previsto, atraso, caminho crítico, IDP, Curva S, dashboard, legalização, assistente e importador do Prevision). Tipo e regras em `src/domain/lob-calendar.ts`.
- **Mudar o calendário.** Comando `set_calendar`. As durações em dias úteis ficam como estão, sem conversão; o início que cai em dia sem trabalho vai ao próximo dia útil e a rede é recalculada em cascata, numa gravação só. Só empurra para a frente: tirar um feriado não adianta datas. Antes de gravar, a tela mostra a prévia "N blocos mudam de data; o término da obra passa de … para …", calculada no navegador com a função do servidor (`calendarChangePreview`). Quando algum bloco muda, o servidor guarda antes a linha de base automática "Antes da mudança de calendário dd/mm/aaaa". O "Desfazer" não cobre a mudança; a volta é essa linha de base.
- **Término gravado na linha de base.** Toda foto nova guarda o término de cada bloco (`LobBaselineEntry.finish`), e o `set_calendar` preenche o das linhas de base antigas pelo calendário antigo. Sem isso, o término da linha de base seria recalculado com o calendário novo e a comparação esconderia o efeito da mudança. Lê-se por `baselineEntryFinish` e `baselineEntryEnd`.
- **Desvio contra a linha de base.** Com uma linha de base escolhida, a dica do bloco mostra "Linha de base: dd/mm → dd/mm" e "Desvio: +N dias úteis (atrasado)", "−N dias úteis (adiantado)" ou "no prazo" (pelo término, citando o início quando difere), ou "não estava na linha de base". O tracejado tem dica própria (serviço, local, nome da linha de base, datas e desvio) e, ao passar o mouse no bloco ou no tracejado, uma linha fina liga os dois. O bloco ganha o selo "+12d" ou "−3d" a partir de 2,5 px por dia. A Tabela tem as colunas "Início (linha de base)", "Término (linha de base)" e "Desvio (dias úteis)", e o painel do bloco tem a linha "Linha de base". O cartão "Término previsto" e a gaveta de linhas de base passaram de dias corridos sem unidade para **dias úteis** do calendário da obra, com a unidade escrita. Regra em `baselineDeviation` e `workdayDelta` (`lob.ts`).
- **Arrasto.** Antes, só o bloco arrastado se movia; as sucessoras ficavam esmaecidas até o servidor regravar e devolver a obra inteira, com um UPDATE por bloco alterado, duas leituras completas e a reassinatura de todas as fotos. Agora:
  - durante o arrasto, as sucessoras andam junto, calculadas no navegador pela mesma regra do servidor (`createMovePlanner`, que monta a rede uma vez e recalcula só o bloco e as sucessoras);
  - ao soltar, a tela aplica o resultado na hora e grava em segundo plano, com "Salvando…", "Salvo" ou "Não salvou" ao lado de "Desfazer". Recusa de regra desfaz na tela; outra falha relê a obra;
  - os comandos saem um por vez, na ordem (`LobSession`, em `lob-api.ts`). Como Medições e Custos usam o mesmo hook, os comandos deles também saem em sequência;
  - no servidor, `update_activity` e o novo `set_activity_dates` (usado pelo Desfazer, que virou uma gravação só) leem apenas blocos, dependências e calendário, gravam os blocos alterados em lote e respondem `{ partial: true, activities }`, sem reler a obra nem reassinar fotos. Os outros comandos mantêm a resposta inteira;
  - a escala do zoom "Obra inteira" não muda no meio da edição, e cada linha do gráfico só redesenha se algo dela mudou.
- **Curva S.** Visão nova `?visao=curva-s`, depois de Medições, só de leitura e aberta a todos os perfis. Três séries do avanço físico acumulado, mês a mês: linha de base (tracejada), previsto (cronograma atual) e realizado (medições fechadas, com ponto só nos meses que tiveram medição), mais a linha "hoje". Abaixo, o "Progresso mensal" em barras com o ganho de cada série e a tabela "Mês a mês" com o desvio em pontos percentuais. Três cartões comparam os valores na data da última medição. Regras (`lobCurve`, em `src/domain/lob-curve.ts`):
  1. uma linha por mês, do primeiro início ao último término, olhando o cronograma atual e a linha de base, estendida para caber toda medição fechada;
  2. o valor do mês é o do último dia do mês;
  3. o peso é o de `lobWeights` (custo quando todos os pacotes com blocos têm custo, senão duração), para bater com o avanço físico e o IDP;
  4. sem escolha, a linha de base é a do IDP (`performanceBaseline`); bloco criado depois dela entra com as datas atuais;
  5. o realizado do mês é o da última medição fechada até o fim do mês; mês sem medição nova repete a anterior, sem ponto e com ganho zero; mês futuro e mês anterior à primeira medição ficam sem realizado, então o primeiro mês medido concentra o realizado até ali.

### Migração

`supabase/migrations/0056_lob_calendar.sql` (criada como 0055 e renumerada antes do envio, porque o `main` recebeu no mesmo dia a `0055_portal_sso_uso_unico.sql`; o conteúdo aplicado é o mesmo): cria `lob_calendars` (`work_id` com `on delete cascade`, `weekdays`, `holidays`, `updated_by`, `updated_at`), RLS ligada sem política e grant para `service_role`. **Aplicada no `takt-hub` em 23/11/2026**, numa transação, pelo pooler; conferido depois: tabela criada, zero linhas, RLS ligada e os grants de `service_role`. Não reescreve `commit_planning` nem `delete_work` (a exclusão de obra leva a linha pela cascata). Com o código antigo no ar a tabela é ignorada; o código novo sem a tabela lê com o calendário padrão e só a gravação responde 503.

### Validação (23/11/2026)

- Sequência do CI local, toda verde: tipos, lint (0 erros), `prettier --check`, 1.687 testes (depois de reencaixar sobre o `main` do dia), `validate:migrations`, build de produção e o teste de fumaça no navegador (10 de 10).
- Testes novos: `plan-to-week` (10), `plan-view` (5 novos), `column-widths`, `undo`, `bulk-bar`, `lob-calendar` (15), `lob-curve` (10), `lob-moves` (equivalência do planejador contra as funções antigas em 360 movimentos aleatórios), `lob-baseline-deviation`, `lob-sync` (otimista, fila, recusa, falha, divergência, desfazer), `lob-batch-write` (606 blocos numa requisição, com `fetch` trocado), além de casos novos em `lob-commands`, `lob-model`, `lob-prevision-import` e `delete-work`.
- Navegador, curto e médio prazo (`next dev` na 3102, Supabase falso, Playwright, comandos aplicados por `applyCommand` sobre os dados de exemplo; 1366, 1920 e 2560 px): coluna Ações presa e opaca em qualquer rolagem; ✕ com confirmação e Desfazer na mesma posição; "Limpar" e Esc; "Excluir 3" com uma confirmação, três comandos e um Desfazer que devolve as três; consulta sem ✕ nem "Excluir N"; página sem teto de largura só no curto prazo; colunas redistribuídas a cada redimensionamento e larguras escolhidas escalando na proporção (×1,40 de 1920 para 2560); "Gantt de controle" no seletor; "Mostrar até" nos três níveis e em "Personalizado"; "Levar para o curto prazo" criando três linhas com os dias recortados (27/11 a 03/12 virou 27/11; 18/11 a 25/11 virou 23/11 a 25/11). Três defeitos achados e corrigidos nessa conferência: botões de "Apontamento" atrás da coluna presa, coluna Ações vazia para consulta e uma fresta à direita no ajuste automático.
- Navegador, longo prazo (mesma montagem, com `planLobCommand` de verdade respondendo no formato da rota; obra de 36 blocos com linha de base e duas medições, e obra de 606 blocos e 1.151 dependências): faixas de fim de semana em Semana e Mês e nenhuma no Trimestre; número de cada dia no cabeçalho do zoom Semana; calendário com feriado em 25/11 mostrando a prévia "12 blocos mudam de data; o término da obra passa de 24/12/2026 para 25/12/2026", gravando um `set_calendar` e criando a linha de base automática; sábado como dia trabalhado; consulta só vê; dica do bloco e do tracejado com o desvio (+4 e −3 dias úteis), par destacado, legenda, colunas da Tabela, painel e cartão em dias úteis; sucessoras andando junto no arrasto, um POST parcial ao soltar, "Salvando…" e "Salvo", sem voltar e deslizar; com o servidor levando 2,5 s, dois arrastos seguidos aparecem na hora e saem em ordem, um por vez; recusa (400) e falha (500) voltam a tela ao estado confirmado com o aviso; Desfazer numa gravação só; Curva S com os números de três meses conferidos contra conta independente (out/26: 27,8 / 27,8 / 21,1; nov/26: 85,0 / 78,3 / 62,2). Sem erro de console.
- Fluidez do arrasto na obra de 606 blocos, primeiro bloco da rede, 30 dias, 605 blocos acompanhando, em `next dev`: intervalo entre quadros com mediana de 16,7 ms, p90 de 25 ms e pior caso de 50 ms; o movimento custa 0,4 ms dentro do mesmo dia e de 44 a 65 ms quando o dia muda; ao soltar, uma tarefa de 75 a 96 ms. A build de produção não foi medida.
- Dois defeitos de desenho achados e corrigidos nessa conferência: o bloco era desenhado até o fim exclusivo e cobria o sábado e o domingo grifados (agora vai até o fim do último dia trabalhado, `drawnWidth`, sem mudar regra de data), e o selo do desvio não cabia no bloco de cinco dias no zoom Mês (agora entra compacto, "+4", `fitBadge`).
- Gravação em lote: o upsert deixou de mandar `created_at` e confere o que volta; se um bloco apagado por outra pessoa for recriado pelo upsert, ele é apagado de novo e o comando sai como conflito, o que faz a tela reler a obra (`recreatedRows`). A forma do upsert (todas as colunas menos `created_at`, conflito em `id`) foi conferida contra a tabela real do `takt-hub` com três linhas, dentro de uma transação desfeita: sem erro e com `created_at` preservado. A tabela não tem gatilho nem coluna gerada.
- **Não validado:** uso logado no servidor da ATR; a gravação em lote e a leitura curta pela API real (PostgREST), de ponta a ponta; o arrasto por toque; o arrasto com a obra real do Atmos; celular e impressão do curto prazo; recusa do servidor no meio de "Criar N linhas"; Safari.

### Limites e próximas etapas

- O link do diálogo "Levar para o curto prazo" abre a planilha na semana atual; quando o destino foi a próxima, é preciso trocar a semana lá (a planilha não lê a semana pela URL).
- A exclusão em lote faz uma ida ao servidor por linha.
- A gravação em lote dos blocos é um upsert por `id` em lotes de 1.000, sem transação entre lotes; uma função no banco daria atomicidade e pediria migração.
- O IDP contra a linha de base, depois de uma mudança de calendário, ainda calcula o previsto do bloco congelado por início + duração no calendário atual.
- No Atmos, as durações importadas do Prevision já incluem os feriados (para manter o término); marcar esses feriados no calendário empurra os términos. A prévia mostra isso antes de gravar, e a conversão das durações não foi feita.
- A Curva S não tem custo realizado (curva financeira) nem exportação, e os dashboards continuam lendo o Planejador antigo.
- Cenários continuam pendentes. A integração direta com o Sienge foi feita no mesmo dia (seção própria, abaixo).

## Médio prazo: filtro de data (23/11/2026)

### Pedido

Gabriel Andrade, na conversa "Feedback Obra 360" de 23/11/2026: "está faltando um filtro de data", ao analisar com o Jorge o planejamento do próximo ano. O usuário confirmou que é no médio prazo (a Linha de Balanço já tinha o seletor "Período").

### Comportamento entregue

- Na barra de filtros do cronograma (visão Gantt de controle), depois do filtro de recurso, entraram os campos **"De"** e **"até"**. Ficam só as tarefas com algum dia dentro do intervalo: término ≥ "De" e início ≤ "até". Tarefa que atravessa o intervalo, ou que começa antes e termina dentro, aparece.
- Cada ponta é opcional: só "De" mostra dali em diante; só "até" mostra o que começa até a data.
- "Limpar datas" aparece com algum campo preenchido. Data final anterior à inicial não filtra nada: o campo fica marcado e a dica explica.
- Combina com a busca, a situação e o recurso. Como nos outros filtros, cada resultado vem com os resumos acima dele, e inserir, recuar, vincular e excluir ficam desligados com o filtro ativo.
- O intervalo sai no cabeçalho da impressão ("Filtro: de Seg 04/01/27 a Sex 26/02/27").
- Vale também no Gantt de legalização da aba 1.1, que usa a mesma tela.

### Decisões

- O resumo não é testado contra o intervalo: ele aparece por causa das tarefas dele que caem nas datas. Assim um grupo longo não aparece vazio.
- O filtro é da sessão da tela, como a busca e a situação: não é gravado nem guardado no navegador.
- Sem migração e sem mudança no servidor: é só `src/modules/medio-prazo/schedule-sheet.tsx` (estado `range`), mais o tour e o manual da Claudia do médio prazo.

### Validação (23/11/2026)

Sequência do `ci.yml` rodada local, toda verde: `verify:portal-kit`, `typecheck`, `lint` (sem erros; só os avisos que já existiam), `format:check`, `npm test` (1.692 testes), `validate:migrations`, `build` e `test:e2e` (10 testes).

### Não verificado

- A tela não foi aberta no navegador: não há teste automático do filtro (a regra está dentro do componente) nem conferência visual da barra em tela estreita.

### Próximas etapas (não implementado)

- Atalhos de período ("este mês", "próximos 30 dias", ano) e filtro de data nas visões Planejador de Equipe e Uso dos Recursos.



## Longo prazo: busca ao adicionar predecessora na Linha de Balanço (23/11/2026)

Jorge Lucas, na conversa "Feedback Obra 360" de 23/11/2026: no quadro que abre acima da Linha de Balanço, ao adicionar uma predecessora, não havia filtro; era preciso procurar na lista à mão ou ir apertando a letra inicial. No Atmos a lista tem cerca de 600 blocos.

### Comportamento entregue

- No painel "Atividade selecionada", a lista suspensa "adicionar predecessora…" virou um **campo de busca** ("buscar predecessora…"). Ao digitar, a lista abaixo fica só com os blocos que combinam.
- A busca olha o rótulo "Serviço · Local", não diferencia maiúsculas nem acentos, e cada palavra digitada precisa aparecer, em qualquer ordem: "alv 12" acha "Alvenaria · 12º pavimento".
- Clicar no campo sem digitar abre a lista inteira, na mesma ordem de antes (local, depois serviço). A lista mostra até 50 blocos por vez; havendo mais, o rodapé diz quantos faltam e pede para refinar.
- Teclado: setas percorrem, Enter escolhe, Esc fecha. Depois de escolher, a espera e o botão "Ligar" seguem como eram; ao ligar, o campo volta em branco.
- As candidatas são as mesmas de antes: qualquer bloco que ainda não seja predecessora e que não feche um ciclo.

### Decisões

- Campo de busca com lista, e não um filtro ao lado da lista suspensa antiga: um controle só, e a lista suspensa nativa não permite buscar no meio do texto.
- Sem migração e sem mudança no servidor: `src/modules/longo-prazo/lob/predecessor-picker.tsx` (campo), `filterPredecessorOptions` em `lob-model.ts` (regra, testada em `tests/lob-model.test.ts`) e a troca em `lob-activity-panel.tsx`; mais o tour e o manual da Claudia do longo prazo.
- O editor de **Fluxos de serviços** continua com a lista suspensa nas predecessoras: ali a lista é de serviços do fluxo (dezenas), não de blocos.

### Validação (23/11/2026)

- Sequência do `ci.yml` rodada local, toda verde: `verify:portal-kit`, `typecheck`, `lint` (sem erros; só os avisos que já existiam), `format:check`, `npm test` (1.693 testes), `validate:migrations`, `build` e `test:e2e`.
- Tela aberta no navegador com dados simulados (`next dev` + Supabase falso + Playwright respondendo `/api/*`; 20 locais × 12 serviços = 240 blocos): o campo abre com 50 blocos e o rodapé "Mais 189 blocos"; "eletricas 12" deixa só "Instalações elétricas · 12º pavimento"; "ALV" deixa os 20 de Alvenaria; setas + Enter escolhem; "Ligar" envia `add_dependency` com o bloco certo e o campo volta em branco; texto sem resultado mostra "Nenhum bloco com esse texto."; Esc fecha. Sem erro no console.

### Não verificado

- A tela não foi aberta logada com os dados reais do Atmos (cerca de 600 blocos).

### Próximas etapas (não implementado)

- A mesma busca nas predecessoras do editor de Fluxos de serviços, se a equipe pedir.

## Longo prazo: orçamento direto do Sienge na visão Custos (23/11/2026)

### Pedido

Do usuário, em 23/11/2026: para facilitar o vínculo entre as tarefas do planejamento de longo prazo e o orçamento, testar a ligação com a API do Sienge dentro do sistema; depois do teste no Atmos (empreendimento 32), deixar pronto para todas as obras.

### O que a consulta ao Sienge mostrou

- Credencial usada: o usuário de API `atrincorporadora-bruno` (subdomínio `atrincorporadora`), o mesmo do App-ATR, só com leituras. Liberado: Empreendimentos (`/v1/enterprises`), Centros de custo e as Planilhas de Orçamento (`/v1/building-cost-estimations/{obra}/sheets` e `.../sheets/{unidade}/items`). Bloqueado (403): Acompanhamentos de obra (`/v1/building-projects/progress-logs`), que não é usado aqui.
- São 73 empreendimentos. Cada obra tem dois, "(ADM)" e "(ENG)"; o orçamento fica no ENG (Atmos 32, Essenza 33, Mozine 34, Blentt 35, MySunset 36, Brizz Smart Stay 40, Sonatta 42, Bioma 44). Há nomes repetidos de tabelas antigas (Essenza 20 e 33, Mozine 24 e 34) e um auxiliar "ATMOS - IMPORTAÇÃO ORÇAMENTO" (110).
- Orçamento do Atmos (32): 10 unidades construtivas, 10.789 linhas, 9.414 itens (folhas), 1.566 deles com valor, total de R$ 48.396.732,45. A soma dos itens de cada unidade bate com o total que o Sienge dá na raiz da unidade. "Personalização" (6.172 itens, R$ 5.500,00) e "Assistência técnica" (1.658 itens, R$ 0,00) são quase só itens zerados.
- A árvore tem quatro níveis; só o último tem serviço, quantidade e total. Os itens são insumos e serviços ("Areia Média", "Cimento CP II") e só fazem sentido com o grupo acima ("CANALETA REFORÇO MEZANINO - Materiais"). No Atmos são 241 grupos com valor.
- O código da EAP se repete entre as unidades (toda unidade começa em "01"; 256 códigos repetidos no Atmos).

### Comportamento entregue

- **Ligação da obra com o Sienge.** Configurações da obra ganhou a seção "Orçamento do Sienge": mostra o empreendimento ligado e, para o administrador, "Escolher o empreendimento" (lista lida do Sienge, com o empreendimento ENG de mesmo nome da obra já marcado como sugestão), "Salvar" e "Desfazer a ligação". Os demais perfis só veem.
- **"Buscar do Sienge" na visão Custos**, ao lado de "Colar do orçamento", para quem edita. O diálogo lê o orçamento do empreendimento ligado e mostra o total, o nível de detalhe, as unidades construtivas (com linhas e valor, marcáveis) e a prévia do que muda na tela.
- **Nível de detalhe.** "Por grupo de serviço" (padrão): cada grupo vira uma linha com a soma dos itens. "Item a item": cada insumo ou serviço vira uma linha, com a descrição "grupo › item". Itens com valor zero ficam de fora.
- **Código.** Cada linha leva a unidade construtiva na frente do código da EAP: "UC7 03.001.004". É a chave do vínculo.
- **Trazer.** As linhas entram no rascunho da tela como não apropriadas (apontar à mão ou com "Sugerir com a Claudia"); só "Salvar" grava, pelo `save_costs` de sempre.
- **Nova busca.** O item com o mesmo código mantém o pacote e atualiza descrição e valor. Os itens do Sienge das unidades marcadas que não vieram (saíram do orçamento, zeraram ou estavam em outro nível de detalhe) saem do rascunho. Ao trocar o nível de detalhe, a linha nova herda o pacote do grupo acima ou, de grupo para baixo, dos itens quando todos estão no mesmo pacote. Itens digitados ou colados (código sem "UC") e os de unidades não marcadas não mudam.
- O sistema só lê o Sienge.

### Arquitetura

- `src/domain/sienge-budget.ts`: funções puras (lista de empreendimentos, itens de uma unidade, linhas por nível de detalhe, código `UC`, sugestão de empreendimento pelo nome).
- `src/infrastructure/integrations/sienge/client.ts`: cliente só de leitura, autenticação Basic, intervalo mínimo de 320 ms entre chamadas (teto do Sienge: 200 por minuto), até três tentativas em 429 e 5xx, páginas de 200, três unidades lidas ao mesmo tempo. Só as rotas REST; as de dados em massa (`/bulk-data`, cota de 20 chamadas por dia) ficam de fora.
- `GET /api/sienge/enterprises` (só administrador) e `GET /api/sienge/budget?workId=` (módulo longo prazo, perfil que edita, acesso à obra). O orçamento lido fica dez minutos na memória do servidor por empreendimento; `atualizar=1` força nova leitura.
- `work_settings.sienge_building_id` (migração `0057_sienge_link.sql`), lida e gravada por `/api/work-settings` (`siengeBuildingId`; gravação só de administrador). Sem a coluna, a seção avisa e o resto das configurações segue funcionando.
- Tela: `src/modules/configuracoes/sienge-link.tsx`, `src/modules/longo-prazo/lob/costs-sienge-dialog.tsx` e a junção com o rascunho em `costs-sienge.ts` (`mergeSiengeBudget`).
- Variáveis de servidor: `SIENGE_SUBDOMAIN`, `SIENGE_API_USER`, `SIENGE_API_PASSWORD` (documentadas no `.env.example`). Sem elas a busca responde "Sienge não configurado".

### Decisões

- **Sem coluna nova nos itens de custo.** O vínculo com o Sienge vai no código do item ("UC…"), que já existia; a gravação continua a mesma.
- **Por grupo como padrão.** O grupo é a unidade que corresponde a um pacote de serviço; item a item são 1.566 linhas de insumos no Atmos.
- **Itens do Sienge que não vieram saem do rascunho**, sem opção de manter: manter contaria o custo duas vezes, principalmente ao trocar o nível de detalhe.
- **Só o administrador liga a obra ao empreendimento**, porque a ligação decide de qual empreendimento a obra enxerga o orçamento. A busca em si é de quem edita o longo prazo da obra, como o resto da visão Custos.
- **A sugestão pelo nome não grava sozinha.** Com nomes repetidos no Sienge, vale o ENG de código maior, e o administrador confere antes de salvar.
- **Nada do orçamento fica guardado fora dos itens de custo.** A leitura é feita na hora (com a memória de dez minutos), sem tabela de espelho nem sincronização agendada.

### Validação (23/11/2026)

- Sequência do `ci.yml` rodada local: `verify:portal-kit`, `typecheck`, `lint` (sem erros; só avisos que já existiam), `npm test` (1.707 testes, com `tests/sienge-budget.test.ts` novo), `validate:migrations`, `build` e `test:e2e`, todos verdes. O `format:check` acusou só três arquivos de outro trabalho em andamento na mesma pasta (importação do Prevision), fora desta entrega.
- Leitura real no Sienge pelo cliente novo (`fetchBudget(32)`, Atmos): 20,5 s, 10 unidades construtivas, 1.566 itens com valor, 241 linhas por grupo, total de R$ 48.396.732,45 nos dois níveis de detalhe, códigos sem repetição. A sugestão pelo nome acertou Atmos (32), Essenza (33), Mozine (34), Blentt (35), MySunset (36), Brizz (40), Sonatta (42) e Bioma (44); "Tauá" e "My Sunset" (com espaço) ficaram sem sugestão.
- Tela aberta no navegador com dados simulados (`next dev` + Supabase falso + Playwright respondendo `/api/*`, com o orçamento real do Atmos nas respostas do Sienge): sem ligação, o diálogo avisa e aponta as Configurações; nas Configurações, a lista abre com "Atmos (ENG) (código 32)" marcado e "Salvar" grava; o diálogo mostra 241 linhas por grupo e 1.566 item a item; desmarcando a unidade 4 ficam 237 linhas e R$ 44.990.455,98; "Trazer" põe 237 itens não apropriados na tela; a segunda busca mostra "0 novas, 237 iguais" e o botão desabilitado.

### Não verificado

- A tela não foi usada logada em produção: o servidor da ATR ainda não tem as três variáveis `SIENGE_*`. A migração 0057 foi **aplicada no `takt-hub` em 23/11/2026** (numa transação; as 8 linhas de `work_settings` foram preservadas e nenhuma obra está ligada ainda).
- As rotas `/api/sienge/*` não foram chamadas com sessão real (no navegador, as respostas foram simuladas com os dados reais do Sienge).
- Só o orçamento do Atmos foi lido inteiro; as outras obras não foram conferidas.

### Próximas etapas (não implementado)

- Pôr as variáveis `SIENGE_*` no servidor da ATR (Thiago) e ligar cada obra ao seu empreendimento em Configurações da obra.
- Custo realizado (apropriações e contas a pagar) para a curva financeira; pede liberar outras rotas no usuário de API.
- Medições do Sienge (Acompanhamentos de obra), hoje bloqueadas para o usuário de API.
- A Claudia ainda não consulta o Sienge; ela só conhece a tela pelo manual.

---

## Longo prazo: Linhas de Balanço do Brizz, do Essenza e do Tauá transcritas pela API do Prevision (23/11/2026)

**Pedido do usuário** (23/11/2026): "no longo prazo quero que vc busque as informações pela minha API do Prevision e transcreva todas as linhas de balanço no sistema", com a chave de API dele; as do Blentt e da Mozine, que não estão no Prevision, ele vai salvar na pasta de downloads.

### O que entrou no banco (takt-hub, 23/11/2026)

Gravado pelo script `scripts/import-lob-prevision.ts --prevision <id> --sem-fluxos --apply`, depois de simulação conferida, com o perfil admin do usuário como ator. As três obras estavam com a Linha de Balanço vazia e sem calendário próprio.

| Obra (código) | Obra no Prevision (id) | Locais | Serviços | Blocos | Dependências | Medição M1 | Dias sem trabalho no calendário | Período |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Brizz (BRZ) | Brizz Smart Stay (40096) | 20 | 69 | 283 | 549 | 4 blocos com avanço | 49 | 06/07/2026 a 13/09/2028 |
| Essenza (ESZ) | Essenza Home Club (22268) | 35 | 60 | 545 | 851 | 326 blocos (309 concluídos) | 106 | 16/09/2024 a 31/05/2027 |
| Tauá (TAU) | Tauá - Dreamis (35062) | 37 | 58 | 590 | 1.296 | 2 blocos com avanço | 84 | 22/06/2026 a 09/05/2029 |

Em cada obra entraram também a linha de base "Prevision — API, obra <id> (23/11/2026)" e a medição M1 de 23/11/2026, salva e sem fotos, com o % concluído do Prevision. Nenhum fluxo de serviços foi criado (`--sem-fluxos`), porque o pedido foi só a transcrição.

**Conferência depois da gravação** (leitura do banco comparada, bloco a bloco, com a resposta da API): início e término iguais aos do Prevision em 283/283, 545/545 e 590/590 blocos; nenhum bloco se move com as dependências gravadas; a duração em dias úteis é igual à do Prevision em todos os blocos, menos um do Essenza (o Prevision grava o término dele às 18h e conta um dia a menos; o término aqui é o mesmo).

### Como a leitura pela API funciona

- **API usada**: a GraphQL (`https://api.prevision.com.br/graphql`, cabeçalho `UserAuthorization: token <chave>`), porque a chave que o Prevision mostra em Configurações → Integrações tem 24 caracteres e só vale nela. A API REST nova (`PREVISION_API_TOKEN`, um JWT), usada pela tela Integrações, respondeu 401 a essa chave. O Prevision avisa que a GraphQL funciona até **17/01/2028**; a REST já tem as rotas equivalentes (`/activities`, `/activities/dependencies`, `/floors`).
- **Cliente**: `src/infrastructure/integrations/prevision/graphql.ts`, só consulta. Lê o calendário, os lotes, os serviços e as atividades com as predecessoras. O Prevision entrega no máximo 50 itens por página, qualquer que seja o tamanho pedido: toda lista é percorrida até o fim e conferida com o total, e a leitura falha em vez de transcrever uma lista cortada (na primeira tentativa, os serviços do Brizz vieram 50 de 70 e a trava segurou). Há pausa de 1,5 s entre consultas.
- **Regras** (`src/domain/lob-prevision-import.ts`, funções `readPrevisionApiSchedule` e `previsionApiCalendar`, sem banco e com testes):
  1. Cada atividade do Prevision (serviço × lote) vira um bloco com as mesmas datas.
  2. Os locais ficam na ordem da tela do Prevision (o lote de posição 1 no topo); só entram lotes e serviços que têm atividade.
  3. A cor do serviço é a do Prevision.
  4. O calendário do Prevision (dias da semana, feriados e recessos dentro da janela do calendário dele) é gravado na obra **quando ela ainda não tem calendário próprio**; se já tem, o da obra é mantido e o script avisa. Com o calendário dele, a duração em dias úteis fica igual à do Prevision.
  5. As dependências são as **reais** do Prevision, não deduzidas como no XML do Atmos. Aqui toda dependência é término → início com espera em dias úteis; cada vínculo do Prevision (término → início, início → início, término → término, início → término, com defasagem em dias corridos, para depois ou para antes) vira o início mínimo que ele impõe à sucessora, medido a partir do fim da predecessora (negativo quando as duas se sobrepõem). A espera nunca passa da folga real entre os dois blocos, para as datas do Prevision ficarem como estão: isso reduziu a espera em 1 vínculo do Brizz, 3 do Essenza e 1 do Tauá, em que as datas do próprio Prevision não cumprem a regra dele.
  6. Mesmo serviço em locais diferentes vira "equipe segue"; serviços diferentes, dependência comum.
  7. Atividade dividida em partes no Prevision (o mesmo serviço duas vezes no mesmo lote) vira um bloco só, o primeiro, com aviso; nenhuma das três obras tem esse caso.
- **Script**: `--prevision <id>` lê da API (chave em `PREVISION_GRAPHQL_TOKEN`, que não fica no repositório nem no servidor); `--salvar-json` guarda a resposta e `--json` grava a partir dela, para a gravação usar exatamente o que foi simulado; `--listar-prevision` mostra as obras e os ids. Continua recusando obra com Linha de Balanço preenchida e apagando o que entrou se a gravação falhar no meio (inclusive o calendário novo).

### O que ficou de fora, e por quê

- **Atmos**: já tinha a Linha de Balanço carregada em 11/11/2026 e está em uso (3 medições e 4 linhas de base feitas no sistema). Não foi regravada; as dependências dela continuam as deduzidas do XML.
- **Blentt e Mozine**: não existem no Prevision. O usuário vai salvar os arquivos na pasta de downloads; em 23/11/2026 eles ainda não estavam lá.
- **Obras do Prevision sem obra no sistema**: Terrazzo Tomio, Casa Pinheiro, Arandá, Lummi e My Sunset (obras encerradas entre 2023 e 2026). Nenhuma obra foi criada para elas.
- **"Atmos - Gantt"** (id 40427): cronograma do tipo Gantt no Prevision, não é Linha de Balanço; o leitor recusa.
- **Nova Sede, Bioma e SEPAT**: não têm obra no Prevision.
- **Linha de base do Prevision**: a linha de base gravada aqui são as datas atuais do Prevision no dia da carga, não a linha de base ativa dele. No Essenza (obra em andamento desde 2024) o desvio contra a base começa zerado.
- **Datas reais**: a GraphQL não entrega início e término reais; o bloco com avanço recebe o início planejado como início real, e o concluído recebe o término planejado (ou a data da medição, se for posterior), como na carga do Atmos.
- **Vínculo da obra com o Prevision** (`works.prevision_project_id`): não foi preenchido; ele muda o que cada pessoa vê na tela Integrações.

### Validações

- `node --import tsx --test tests/lob-prevision-import.test.ts`: 15 testes, 5 novos para a API (calendário pela janela, ordem de locais e serviços, cores, recusa de Gantt, avisos, conversão das dependências, espera reduzida e par repetido).
- Simulação das três obras sem avisos e com "nenhum bloco se move com as dependências", antes de gravar.
- Conferência do banco contra a API depois de gravar (acima).
- Não conferido: as três Linhas de Balanço numa sessão logada no servidor da ATR.

### Próximas etapas (não implementado)

- ~~Transcrever Blentt e Mozine~~: feito em 24/11/2026 (seção seguinte).
- Trazer a linha de base ativa do Prevision como linha de base do Essenza, se o desvio histórico interessar.
- Um botão na tela para o administrador repetir a carga sem o script, e a migração da leitura para a API REST antes de 17/01/2028.

## Longo prazo: Linhas de Balanço do Blentt e da Mozine transcritas do relatório "Avanço Físico-Financeiro" (24/11/2026)

O Blentt e a Mozine não estão no Prevision: o planejamento deles fica em outro sistema, que exporta o relatório **"Avanço Físico-Financeiro"** em CSV. O usuário salvou um arquivo de cada obra e pediu a transcrição para a Linha de Balanço.

### O que foi entregue

- **Leitor do relatório** em `src/domain/lob-progress-report-import.ts` (`readProgressReportSchedule`, `parseCsv`, `localKey`), que devolve o mesmo `PrevisionSchedule` das outras importações. O relatório tem uma linha por atividade e por mês, com Código, Unidade, Local, Macro Etapa, Etapa, mês, Início/Término Planejado Base, Início/Término Planejado, Início/Término Real, Caminho Crítico e os avanços do mês. Não traz predecessoras.
- **`scripts/import-lob-prevision.ts <relatório.csv> --obra <código> --actor <perfil> [--origem <nome>]`**: arquivo `.csv` passa pelo leitor novo; `.xml` e `--prevision` seguem como antes. Sem `--apply` é simulação.
- **`buildPrevisionImport`** ganhou: datas reais vindas da origem (`actualDates`), linha de base com datas próprias (`baseDates`), nome da origem na linha de base e na medição (`sourceLabel`) e reordenação dos locais da obra (`reorderLocals`, com os já cadastrados que mudam de posição em `localUpdates`).

### Regras da leitura

1. Cada **código** de atividade é um bloco (Etapa × Local), nas datas de "Início/Término Planejado". A duração é contada em dias úteis do calendário da obra (as duas obras não têm calendário próprio: segunda a sexta).
2. A **linha de base** gravada guarda as datas "Início/Término Planejado Base" do relatório. Atividade sem essas datas fica fora dela, e as telas a tratam como bloco criado depois da linha de base.
3. "Início/Término Real" viram as **datas reais** do bloco.
4. **Avanço** (medição M1): 100% com término real; sem ele, a soma do "Real (%)" dos meses. Esse percentual é financeiro: atividade sem custo fica em 0% até terminar, e atividade com 100% financeiro sem término real fica com 99%.
5. **Locais** na ordem do código (o 2º número é o local dentro da unidade), de baixo para cima; fachadas e equipamentos pelo campo Unidade. Local já cadastrado com outra grafia é reaproveitado ("2º pavto." = "2 PAV"). Todos os locais da obra são reordenados pela ordem do relatório; os cadastrados sem bloco vão para o fim.
6. A mesma etapa com dois códigos no mesmo local (duas passadas) vira dois serviços: a que começa depois ganha "(2)", porque o bloco é único por serviço × local.
7. Linhas sem código ("Despesas Indiretas") e atividades sem datas planejadas ficam de fora, com aviso.
8. **Dependências deduzidas**, como no Atmos: "equipe segue" do mesmo serviço entre locais e sequência dos serviços dentro de cada local, com a espera limitada à folga real, para nenhum bloco se mover.

### Gravado em produção (takt-hub, 24/11/2026)

| Obra | Arquivo | Locais | Serviços | Blocos | Dependências | Linha de base | M1 | Período |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Blentt | `export (1).csv` | 27 usados (13 novos; 34 na obra) | 69 | 681 | 1.436 | 639 blocos | 330 blocos, 325 concluídos | 02/09/2024 a 29/06/2027 |
| Mozine | `export (2).csv` | 22 (todos novos) | 65 | 444 | 924 | 412 blocos | 254 blocos, 241 concluídos | 25/09/2024 a 08/01/2027 |

Gravado com `--sem-fluxos` (nenhum fluxo de serviços criado) e ator = perfil admin do usuário. A obra de cada arquivo foi reconhecida pelos pavimentos: o Blentt tem 12 pavimentos nos compromissos do curto prazo e nos locais já cadastrados.

**No Blentt**, os 21 locais já cadastrados (usados na coluna Local do curto prazo) foram mantidos com o mesmo id: 14 receberam blocos (SS2, SS1, TÉRREO, 2 PAV a 12 PAV) e 7 ficaram sem bloco, no fim da lista (COBERTURA, CXD, TOPO CXD e as quatro FACHADA n-n). O relatório usa outros nomes para a caixa d'água e as fachadas ("Caixa de água", "Fachada Sul - T ao 9°"…), que entraram como locais novos.

Ficaram de fora, por não terem datas no relatório: "Impermeabilização de parede" no Blentt (14 atividades) e "Impermeabilização de piso" e "Porcelanato" na Mozine (9 cada).

### Validações

- Conferência no banco depois da gravação, bloco a bloco contra os arquivos: início, término e datas reais idênticos em 681/681 (Blentt) e 444/444 (Mozine); linha de base idêntica em 639/639 e 412/412; avanço idêntico em todos; `cascade` não move nenhum bloco.
- `tests/lob-progress-report-import.test.ts` (5 testes): CSV com aspas e BOM, grafias de pavimento, leitura completa, arquivo de outro formato recusado, gravação com datas reais, linha de base e reordenação.
- Sequência do `ci.yml` até os testes (tipos, lint, Prettier, testes). Build e teste de navegador não foram rodados.

### Pendências

- Conferir as duas obras logado no servidor da ATR.
- Juntar no Blentt os locais repetidos (CXD e "Caixa de água", as fachadas), se o usuário quiser: é renomear ou excluir em Configurações.
- As dependências são deduzidas; o relatório não traz as reais.
- O avanço das atividades em andamento é o financeiro do relatório, não o físico.

## Longo prazo: Linha de Balanço do Blentt atualizada pela exportação do Agilean (25/11/2026)

O Daniel (Blentt) mandou, em resposta ao mailing de 24/11, a exportação em Excel da Linha de Balanço replanejada no **Agilean** (o sistema de planejamento do Blentt e da Mozine, de onde também saiu o relatório "Avanço Físico-Financeiro" de 24/11): "Pode atualizar nossa LOB atualizada do Agilean? Seguiremos fazendo medições e replan pelo Obra 360 após a atualização." O usuário pediu para pôr a planilha no lugar da Linha de Balanço atual do Blentt.

### Por que é atualização, e não importação do zero

A planilha é só o desenho: traz serviço, local e datas, mas **não traz avanço, datas reais, linha de base nem dependências**. Apagar o Blentt e reimportar perderia a M1 (avanço real de 330 blocos, 325 concluídos), as datas reais e a linha de base "Planejado Base" do relatório. Por isso os blocos existentes foram mantidos (mesmo id) e só mudaram de início e duração; o resto ficou como estava.

### Formato da exportação do Agilean

- Uma folha ("Agilean"). Linha 1: o mês ("setembro de 2024", mesclado sobre os dias dele); linha 2: a letra do dia da semana; linha 3: o número do dia. **Cada dia ocupa 4 colunas** (o Agilean trabalha em quartos de dia) e **só os dias de trabalho têm coluna**: fim de semana, feriado e recesso não aparecem.
- Coluna A: o grupo ("Edificação Fluxo geral", "Edificação Áreas comuns", "Fachadas Fachada"…); coluna H: o local. Cada local ocupa as linhas até o rótulo seguinte (4 ou mais; serviços simultâneos ficam em faixas de uma linha).
- Cada bloco é uma célula mesclada com o texto **"Serviço - N d"** e a cor do serviço. Quando o Agilean tem sigla para o serviço, a célula traz a sigla ("Med. hid.", "DW1", "Esq Alum"), sempre a mesma para a mesma cor. O par cor + rótulo identifica o serviço (a cor de "Estrutura" também pinta "Piso de concreto"). Durações podem ter fração ("2.5 d").

### O que foi entregue

- **`src/infrastructure/files/xlsx.ts`** (`readXlsxSheet`): leitura de uma folha de .xlsx sem biblioteca nova (o zip é aberto com `node:zlib`): valores, textos compartilhados e ricos, cor de preenchimento sólido e células mescladas. A grade é o tipo `XlsxGrid` de `src/domain/xlsx-grid.ts`.
- **`src/domain/lob-agilean-import.ts`**: `readAgileanLob` (lê a grade: dias, calendário, locais e blocos) e `planAgileanUpdate` (liga cada serviço do Agilean a um da obra e monta a atualização, sem gravar).
- **`scripts/update-lob-agilean.ts <exportação.xlsx> --obra <código> --actor <perfil> [--backup <arquivo>] [--apply]`**: sem `--apply` é simulação com o relatório da ligação; com `--apply`, guarda o estado anterior em JSON e grava tudo numa mutação só (`applyLobMutation`); se falhar no meio, restaura.

### Regras

1. **Datas do bloco**: início = dia da coluna onde o bloco começa; término = dia da coluna onde termina (o mesmo que o Agilean mostra como início e término). A duração é contada em dias úteis do calendário: bate com o "N d" quando o bloco começa no início do dia; quando começa ou termina no meio de um dia, conta o dia inteiro (155 blocos ficam com meio dia a um dia a mais que o rótulo).
2. **Calendário**: segunda a sexta, menos os dias úteis sem coluna no período da planilha. Vai para a obra só se ela não tiver calendário próprio; se tiver, fica o dela (com aviso).
3. **Locais** pela mesma chave da importação ("12º pavto." = "12 PAV", "5ºpavto" = "5 PAV"). O mesmo pavimento em "Áreas comuns" e "Fluxo geral" é um local só, como na carga de 24/11.
4. **Ligação dos serviços**, em rodadas: vence o par com nome igual (desconsiderando o "(2)"), depois sigla compatível (cada pedaço é o começo de uma palavra do nome, na ordem, podendo pular palavras: "Esq Alum" → "Esquadrias de alumínio", "ELE-DW" → "Infra elétrica no DW", "Balancins" → "Montagem de balancins"), depois por eliminação (o único serviço da obra que ainda tem bloco livre em todos os locais dele). Em cada nível, decide a menor soma de diferenças de início. O serviço da obra precisa ter bloco livre em todos os locais do serviço do Agilean.
5. Bloco do Agilean sem par, bloco da obra sem par ou local da planilha que não existe na obra **impedem a gravação**.
6. **Dependências**: as deduzidas saem e entram as deduzidas para as datas novas, pela mesma regra da importação ("equipe segue" + sequência no local, espera limitada à folga real). Conferido que nenhum bloco se move.
7. **Linha de base automática** "Antes da atualização pelo Agilean (dd/mm/aaaa)" com as datas de antes. A linha de base manual do relatório continua sendo a referência do IDP.
8. **Cores** do Agilean nos serviços (quando um serviço da obra recebe mais de uma cor, vale a do grupo com mais blocos).
9. Medições, datas reais, fotos, custos e restrições não mudam.

### Gravado em produção (takt-hub, 25/11/2026)

Arquivo `Blentt_2026-11-25-14-25-25.xlsx` (anexo do e-mail do Daniel), ator = perfil admin do usuário.

- **681 de 681 blocos ligados**, nenhum sobrando. 74 serviços do Agilean (cor + rótulo) em 69 serviços da obra: 50 por nome igual, 21 por sigla e 3 por eliminação, conferidos à mão: "DW1" → "Drywall estrutura + 1ªchapa", "Pint. 1" → "Massa corrida + 1ªdemão", "Prumadas de AF" → "Prumadas de água fria". Os dois "Forro de gesso" (fluxo geral e áreas comuns) caíram em "Forro de gesso" e "Forro de gesso (2)" pelas datas.
- **179 blocos mudaram de início ou término** (70 terminam antes, 108 até 30 dias depois, 1 mais de 30 dias depois); 290 foram regravados, porque o calendário com feriados muda a contagem de dias de blocos que mantêm início e término. 69 dos que mudaram já estavam concluídos: o Agilean os mostra nas datas em que aconteceram (por exemplo, Pastilha da Fachada Sul - 10º à cob, planejada para 11/01/2027 e medida 100%, agora em 05 a 09/10/2026).
- Calendário gravado: segunda a sexta com 28 dias sem trabalho (recesso de 23/12/2024 a 03/01/2025 e os feriados que o Agilean marca até 27/05/2027).
- Dependências: 1.436 saíram, 1.431 entraram. Linha de base automática com 681 blocos. Cores do Agilean nos 69 serviços.
- Estado anterior guardado no JSON de backup do scratchpad da sessão (atividades, serviços, dependências e calendário).

### Validações

- Conferência no banco depois da gravação: 681 blocos com os mesmos ids; todo bloco do Agilean tem um bloco com o mesmo local, início e término; datas reais iguais às de antes; M1 com os mesmos 330 itens; 249 itens de custo intactos; duas linhas de base; `cascade` não move nenhum bloco.
- `tests/lob-agilean-import.test.ts` (7 testes): cabeçalho e feriado pela coluna que falta, faixas e quartos de dia, planilha de outro formato recusada, siglas, ligação por nome, sigla, eliminação e datas, blocos sem par e local inexistente, calendário próprio mantido e leitura de um .xlsx montado no teste (zip sem compressão e com deflate, textos ricos, cor e mescla).
- Sequência do `ci.yml` em 25/11/2026: `verify:portal-kit`, `typecheck`, `lint` (0 erros), `format:check`, `npm test` (1.807 testes), `validate:migrations`, `build` e `test:e2e` (10). O manual da Claudia (seção do calendário da Linha de Balanço) explica a atualização; a seção da Linha de Balanço ficou com 8.999 caracteres, no limite de 9.000 do teste do manual.
- **Não verificado:** a tela logada do Blentt depois da atualização.

### Pendências

- Conferir o Blentt logado no servidor da ATR (cores do Agilean, algumas claras como o amarelo de "Pintura Final", e o calendário).
- A Mozine continua com a carga de 24/11; a mesma atualização vale para ela quando mandarem a exportação.
- Daqui em diante o Blentt mede e replaneja no Obra 360: uma nova exportação do Agilean passaria por cima das datas replanejadas aqui.

## Linha de Balanço: preenchimento invertido (24/11/2026)

Pedido do usuário: "no longo prazo, vamos inverter. Atividades passadas ficam transparentes e atividades futuras preenchidas."

- **Antes:** a parte medida do bloco era cheia e a parte a fazer, transparente (42%).
- **Agora:** a parte **medida fica transparente** (42%) e a parte **a fazer fica cheia**. Serviço concluído aparece todo transparente; serviço futuro, todo cheio; no bloco em andamento, a esquerda (feito) é transparente e a direita (falta) é cheia.
- **Decisão:** "passada" foi lida como "já medida", não como "anterior a hoje": o gráfico sempre desenhou a medição dentro do bloco, e assim um bloco antigo que não foi medido continua cheio, com o contorno vermelho de atraso, que é o que precisa chamar a atenção. Contornos (atraso, caminho crítico, seleção), selos de desvio e a linha de base não mudaram.
- **Arquivos:** `src/modules/longo-prazo/lob/lob-chart.tsx` (desenho e cor do rótulo, que agora considera a parte medida à esquerda), texto "Como funciona" em `lob-view.tsx` e a seção da Linha de Balanço no manual da Claudia.
- **Validação:** gráfico renderizado com dados de exemplo (concluídos, em andamento, atrasados e futuros) e conferido por imagem; sequência do CI verde. **Não verificado:** tela logada em produção.

## Linha de Balanço: linhas vermelhas, restrições do serviço e janela de detalhes (24/11/2026)

Pedidos do usuário, na mesma sessão: "ao clicar na tarefa do longo prazo, deve aparecer quais são as restrições"; "devem aparecer as restrições por meio de linhas vermelhas finas; ao clicar duas vezes, abrir um menu de detalhes como acontece no médio prazo".

- **Linhas vermelhas finas** (`DependencyLinks` em `lob-chart.tsx`): com um bloco selecionado, o gráfico liga cada predecessora a ele e ele a cada sucessora, com seta no destino. Só as dependências do selecionado, entre blocos visíveis; somem durante o arrasto.
- **Restrições do serviço** (`service-restrictions.tsx`): o painel do bloco lista os cards do Quadro de Restrições ligados ao serviço (`origin: longo_prazo`), com sinal de prazo, coluna, entrega, "começar até", responsável e link para o card. Lê `GET /api/pendencias` ao abrir a visão, ao voltar à aba e quando um card é criado; só para quem tem o módulo `restricoes`.
- **Duplo clique** (`onOpen` do gráfico, `ActivityDetailsDialog` em `lob-view.tsx`): abre o mesmo painel numa janela modal.
- **Decisão (interpretação):** "restrições por linhas" foi lido como o que prende o bloco no cronograma, isto é, as dependências; as restrições do Quadro entram como lista no painel e na janela. Se a intenção era marcar no gráfico as datas das restrições do Quadro, é ajuste a fazer.
- **Validação:** gráfico renderizado com dependências e bloco selecionado, conferido por imagem; sequência do CI verde. **Não verificado:** duplo clique, janela e lista de restrições na tela logada (dependem do navegador e do banco).


## Linha de Balanço: mover e editar o pacote inteiro, e histórico de alterações (25/11/2026)

Pedido do Jorge Lucas (Atmos), em resposta no fio "Feedback Obra 360": "as tarefas do mesmo pacote não estão se deslocando todas juntas, preciso fazer para cada pavimento. Além disso, no Prevision existe a possibilidade de fazer uma configuração em massa, onde eu consigo fazer com que todas as atividades daquele pacote tenham a mesma duração ou então que tenha a mesma lógica de predecessoras, estou tendo que fazer uma a uma." No mesmo e-mail ele confirmou que os arrastos de 16/11 e 23/11 no Atmos (277 e 102 blocos) foram replanejamento dele: o Obra 360 é o cronograma vigente e o Prevision ficou desatualizado; nada foi restaurado.

**Causa:** a cascata da Linha de Balanço só empurra (`createMovePlanner`): arrastar um pavimento para a frente só leva o seguinte se ele for ultrapassado, para trás não puxa nada, e o pavimento do meio não move os de baixo (são predecessores dele).

**Modelo de UX aprovado** ("curti, pode seguir") com dados reais do Atmos e 13 regras numeradas: <https://claude.ai/artifact/6JETav5wYHvnutiret3fGn>. Decisões do usuário antes do modelo: (1) antecipar um pacote não puxa as sucessoras dos outros pacotes, e todas as tarefas do pacote se movem juntas; (2) trocar as ligações deduzidas do Atmos pelas reais do Prevision, mantendo as datas; (3) registrar quem alterou.

### O que foi entregue

- **Arrastar: Pacote | Bloco** (`lob-view.tsx`, `lob-chart.tsx`): chave no cabeçalho do gráfico, ao lado do cadeado, começa em Pacote e fica guardada por pessoa no navegador (`obra360.lob.arrasto:<perfil>`). No modo Pacote, o bloco clicado realça o serviço inteiro; arrastar qualquer bloco move todos os blocos **não iniciados** do serviço o mesmo número de dias úteis, com prévia dia a dia (blocos do pacote e sucessoras empurradas) e a dica "Pacote +N dias úteis · K blocos · M sucessoras empurradas". Alt + arrastar move só o bloco. ← → e Shift + seta movem o pacote selecionado. Um arrasto é uma gravação e um passo do Ctrl+Z.
- **Avisos:** "N blocos do pacote andaram X dias úteis para a frente/para trás; M sucessoras empurradas", mais "K blocos já iniciados ficaram" e "S sucessoras ficaram com folga de até D dias úteis (não são puxadas)"; para trás sem folga, "Não dá para antecipar: X já começa logo depois de Y." e nenhum comando sai.
- **Editar o pacote** (`lob-package-dialog.tsx`, botão no painel do bloco em `lob-activity-panel.tsx`, escondido para consulta e com as datas travadas): pacote; locais (todos marcados, Todos/Nenhum, iniciados indicados e fora da edição); duração (vazio mantém); ritmo "Encadear" (padrão; ordem de hoje pela data de início, com a espera entre locais) ou "Manter os inícios"; predecessoras de outros pacotes (pacote, mesmo local ou 1 a 3 abaixo/acima, espera), "Substituir" (padrão) ou "Somar"; quadro "Hoje neste pacote: …" com a lógica atual, que também é o valor inicial; prévia recalculada a cada mudança (blocos que mudam, ligações +/−, sucessoras empurradas, folgas novas, término do pacote e da obra); erros com a mesma mensagem do servidor. "Aplicar" grava tudo ou nada, depois da linha de base automática "Antes da edição do pacote dd/mm/aaaa" (só quando alguma data muda).
- **Desfazer da edição:** a pilha do Ctrl+Z passou a guardar as ligações (`{ dates, links? }`); a edição do pacote desfaz por `revert_service_edit`, que devolve datas e ligações (as retiradas voltam com o mesmo id e a data de criação original). Depois de recarregar a tela, só a linha de base automática devolve as datas; as ligações, não.
- **Histórico** (`lob-history-panel.tsx`, botão "Histórico" na barra, para todos que veem a aba): as últimas 100 alterações com data e hora, autor (`profiles.name`), frase pronta e número de blocos. Toda alteração da Linha de Balanço grava uma linha em `history_events` (`entity_type = 'lob'`, `entity_id` = obra, `action` = tipo do comando, `changes` com as datas antes e depois de cada bloco, até 2000, e o total exato). Medições ficam de fora (têm autor próprio) e custos entram só como contagem, sem valores. Conta a partir de 25/11/2026. **Sem migração:** o `service_role` já tinha INSERT e SELECT na tabela (conferido no banco em 25/11/2026). Se a gravação do histórico falhar, o comando continua valendo e o erro vai para o log.
- **Claudia:** tópicos novos no manual (`longo-prazo-lob-pacote`, `longo-prazo-lob-historico`), o tópico da Linha de Balanço atualizado, a ferramenta `consultar_lob` da Claudia geral entregando as 10 alterações mais recentes do histórico, e a orientação de que mover ou editar pacote é pela tela (ela não faz pelo chat).
- **Tour:** passos para a chave, o botão "Editar o pacote" e o "Histórico".

### Regras (numeração do modelo)

1. Pacote é o padrão do arrasto; Alt + arrastar move só o bloco.
2. Mesmo deslocamento em dias úteis do calendário da obra; o ritmo entre locais não muda e nenhum bloco cai em dia sem trabalho.
3. Bloco iniciado (com início real, que a medição preenche no primeiro avanço; conferido no banco: todo bloco medido tem início real) não anda com o pacote nem entra na edição em massa. A rede ainda o empurra se uma predecessora dele andar, como sempre.
4. Para a frente, as sucessoras de outros pacotes são empurradas só quando preciso; para trás, o pacote inteiro para quando o primeiro bloco encosta numa predecessora de fora (inclusive um bloco iniciado do próprio pacote). Sucessoras nunca são puxadas.
5. Teclado, desfazer e uma gravação por arrasto.
6. "Editar o pacote" no painel do bloco, para quem edita.
7. Locais: todos marcados, um a um.
8. Duração: vazio mantém, preenchido aplica em todos os marcados.
9. Ritmo: "Encadear" refaz as ligações entre os locais marcados (as "equipe segue" ganham a espera escolhida; as demais ligações entre eles saem), o primeiro local fica e os seguintes encostam no anterior, nunca antes de uma predecessora de fora.
10. Predecessoras: "Substituir" tira as ligações que já vinham do pacote da regra e cria as da regra; a ligação que já existe é reaproveitada (só a espera muda); local sem correspondente é pulado e listado; regra que fecha ciclo ou aponta para o próprio pacote é recusada.
11. Prévia, linha de base automática e desfazer.
12. Histórico de toda alteração.
13. Ligações reais do Prevision no Atmos (abaixo).

### Arquivos

- `src/domain/lob-package.ts` (novo, puro): `isStartedActivity`, `createPackageMovePlanner`/`planPackageMove` (mesma foto e mesma cascata de `createMovePlanner`, para a tela e o servidor darem o mesmo resultado), `planPackageEdit`, `packageLogic`, `PACKAGE_LIMITS`. No Atmos real (606 blocos, 1.183 ligações): montar o planejador leva cerca de 15 ms, cada passo do arrasto de 3 a 4 ms, a prévia da edição cerca de 40 ms.
- `src/domain/lob.ts`: comandos `move_service`, `edit_service`, `revert_service_edit` e os tipos `LobPackageEdit`, `LobPackageRule`, `LobLinkRevert`.
- `src/application/use-cases/lob-commands.ts`: leitura e regras dos três comandos; `move_service` entrou em `LOB_SCHEDULE_COMMANDS` (aplicado na hora na tela, gravado em segundo plano, resposta parcial).
- `src/application/use-cases/lob-history.ts`, `src/infrastructure/repositories/supabase/lob-history-repository.ts`, `src/app/api/lob/history/route.ts` (`GET ?workId=&limit=`), e a gravação em `src/app/api/lob/commands/route.ts`.
- `src/domain/lob-dependency-replacement.ts` e `scripts/replace-lob-dependencies-prevision.ts` (ligações reais do Prevision; abaixo).
- Testes: `tests/lob-package.test.ts` (18), `tests/lob-history.test.ts` (14), ajustes em `tests/lob-commands.test.ts`, `tests/agent-global-tools.test.ts` e `tests/agent-manual.test.ts`.

### Validação

- Testes da Linha de Balanço, da Claudia e do tour verdes (detalhe da sequência do CI no commit).
- **Navegador** (`next dev` com Supabase falso e as rotas `/api/lob*` respondidas pelas regras reais, sobre os dados reais do Atmos lidos do banco só para leitura): chave em Pacote; Shift + → moveu os 18 blocos da DRY - Estruturação 5 dias úteis e empurrou 108 sucessoras; Shift + ← voltou e avisou a folga de 5 sucessoras; o segundo Shift + ← avisou "Não dá para antecipar: DRY - Estruturação · Mezanino já começa logo depois de ACA - Lixamento de teto · Mezanino"; arrasto com o mouse (+60 dias úteis, 220 empurradas) e Ctrl+Z; "Editar o pacote" com 8 dias encadeado (18 blocos, linha de base automática criada) e Ctrl+Z devolvendo durações e ligações (1.183); modo Bloco mandando `update_activity`; histórico listando as sete ações com autor; janela no celular (400 px) sem rolagem horizontal; nenhum erro no console.
- **Não verificado:** tela logada no servidor da ATR e a gravação real no banco (histórico inclusive).

### Ligações reais do Prevision no Atmos (regra 13)

Hoje o Atmos tem 1.183 ligações: 1.160 deduzidas na importação de 11/11/2026 (gravadas no mesmo instante da linha de base "Prevision — Atmos.xml") e 23 criadas à mão pelo Jorge (16 em 23/11 e 7 em 25/11). A troca mantém as datas, troca só as deduzidas, preserva as criadas à mão e não recria as que ele apagou.

- `src/domain/lob-dependency-replacement.ts` (puro): `translatePrevisionLinks` (atividade do Prevision → bloco pelo nome do serviço e do local, normalizados como o importador), `previsionLinkLag` (vínculo do Prevision → término → início com espera), `reconstructDeducedDependencies` (roda o próprio `buildPrevisionImport` sobre a linha de base da importação), `planDependencyReplacement` (remover, inserir, manter, ignorar, conflitos, ciclos) e `replacementBaseline` ("Antes das ligações do Prevision dd/mm/aaaa"). 10 testes em `tests/lob-dependency-replacement.test.ts`.
- `scripts/replace-lob-dependencies-prevision.ts --obra ATM --prevision 29875 --out <pasta> [--json <resposta salva>] [--env-file …] [--actor <perfil>] [--confirmar <código do plano>] [--apply]`: sem `--apply` só lê (banco e GraphQL do Prevision) e grava o relatório em JSON e CSVs (`;` e BOM, para o Excel). O `--apply` recusa se o código do plano mudou (qualquer ligação ou data alterada desde a simulação), se a reconstrução não bater, se houver ciclo ou se algum bloco se moveria; guarda antes um backup JSON, cria a linha de base automática, grava por `applyLobMutation` (restaurando as ligações retiradas se falhar no meio) e relê o banco para conferir. A gravação direta não passa pela rota de comandos, então **não entra no Histórico**.
- **Reconstrução conferida:** o conjunto deduzido refeito tem 1.196 ligações (556 "equipe segue"), e as 1.160 que restam estão todas nele: **36 foram apagadas à mão** (24 "equipe segue") e 57 deduzidas tiveram a espera mudada à mão. Os nomes casaram 606 de 606 blocos. Atmos = obra 29875 no Prevision.
- **Simulação de 25/11/2026** (somente leitura; código do plano `9816fdce2c60`): remover 165 deduzidas que o Prevision não tem; trocar a espera de 43 (a deduzida sai e entra a real); inserir 107 reais; manter 975 (952 deduzidas iguais às do Prevision e as 23 criadas à mão, todas também no Prevision com a mesma espera); ignorar 0; ciclos 0; **nenhum bloco muda de data**; ficam 1.125 ligações. **7 conflitos** (blocos que hoje estão antes do que a ligação real pediria; a ligação grava a folga atual para nada se mover), todos vindos de datas mudadas na obra depois de 11/11, o maior de 35 dias úteis (PIN - 2ªdemão de pintura no Hall do 2º pavimento contra a pintura final do 15º).
- **Decisões do script:** ligação criada à mão fica sempre como está; deduzida igual à do Prevision fica com o mesmo id; a espera gravada é a do Prevision, sem passar da folga atual (o que faltar vira conflito); início → início e término → término viram término → início com a espera calculada pelas durações de hoje.
- **Achado:** o `delay` do Prevision é em **dias úteis** (com essa leitura nenhum dos 1.125 vínculos é descumprido nas datas do próprio Prevision); o importador (`readPrevisionApiSchedule`/`buildPrevisionImport` em `lob-prevision-import.ts`) o lê como dias corridos. No Atmos isso daria espera diferente em 47 vínculos; Brizz, Essenza e Tauá, gravados em 23/11 com essa leitura, devem ter esperas menores nos vínculos com defasagem maior que 1 ou do tipo início → início. Nenhuma data mudou nessas obras, mas a rede ficou mais frouxa que a do Prevision. Correção a fazer.
- A gravação (`--apply`) **não foi executada**: espera o Jorge conferir a lista dos 7 conflitos.

### Pendências

- Uso real logado; conferir no servidor que o histórico grava (a primeira alteração depois da publicação deve aparecer na gaveta).
- Ligações do Prevision no Atmos: mandar a lista dos 7 conflitos ao Jorge e aplicar depois do ok (simular de novo antes, porque qualquer arrasto muda o código do plano).
- Corrigir a leitura do `delay` do Prevision (dias úteis) no importador e rever as esperas de Brizz, Essenza e Tauá.
- Fica para depois (do modelo): mover vários pacotes selecionados juntos; a Claudia editar o pacote pelo chat; levar o replanejamento do Obra 360 de volta ao Prevision.
- O tópico "Linha de Balanço" do manual da Claudia passa dos 7.000 caracteres que a ferramenta entrega (já passava antes): a parte final ("Criar pendência do serviço", "Locais, linhas de base e outras ações") não chega a ela. Dividir o tópico é ajuste a fazer.

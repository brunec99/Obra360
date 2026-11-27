# IFC e modelo federado

## Direção acordada

**02/10/2026 — BIM 4D cancelado.** O usuário decidiu concentrar o sistema nos quatro níveis de planejamento (longo prazo, vagões, médio e curto prazo). Consequências:

- A tela `/obras/{obraId}/quatro-d`, o módulo `src/modules/quatro-d/` (visualizador, simulação) e `tests/four-d-simulation.test.ts` foram removidos. A seção "Simulação 4D" abaixo fica como histórico do que existiu.
- O **Modelo federado** deixa de ser a aba 5 e passa ao grupo **Apoio** da lateral, ao lado de Arquivos IFC. Continua funcionando como ferramenta de análise virtual dos projetos; nenhuma migração ou rota mudou.
- A **vinculação por regras** (`src/modules/ifc/link-rules.tsx`) saiu da tela de Arquivos IFC, porque só alimentava o 4D. A entidade `LinkRule`, os comandos `create_link_rule`/`delete_link_rule`, as regras puras (`matchesRule`, `serviceForElement`, `rulesNeedingReview`) e a tabela `link_rules` continuam no domínio, nos testes e no banco. Nenhuma migração remove a tabela.
- As telas de IFC e federação receberam o cabeçalho de Apoio, ajuda contextual ("Como funciona"), formulários em gaveta, avisos por toast e a paleta única (`src/shared/palette.ts`). Ver `docs/revisao-2026-10-01.md`.

Antes disso, a direção era priorizar a montagem e a exploração do modelo federado, com o 4D para depois. No redesenho de 23/09/2026, o BIM 4D (então aba 6) ganhou a simulação animada do cronograma de longo prazo (ver a seção "Simulação 4D" abaixo), que nunca chegou a consumir as composições salvas.

Este documento é o ponto de continuidade entre os modelos de IA que trabalham no repositório. Em cada alteração de IFC/federação, atualizar aqui: comportamento entregue, decisões, arquivos envolvidos, migrações, validação e pendências. Não descrever intenção como funcionalidade pronta. Preservar alterações locais de outro trabalho. A mesma orientação foi acrescentada ao `AGENTS.md` local, que atualmente é ignorado pelo Git; este documento e o README mantêm a orientação em arquivos versionáveis.

## Etapa 1 — composição e exploração (18/09/2026)

Implementada em `/obras/{obraId}/federacao`, com entrada **Modelo federado** no menu da obra.

- Selecionar uma versão de cada modelo ou deixá-lo fora do conjunto. A seleção inicial usa a versão mais recente, sem substituir uma seleção explícita.
- Consultar a disponibilidade de dados e geometria antes de carregar. Uma versão incompleta permanece selecionável para registrar a composição, mas impede seu carregamento até que o usuário escolha versões prontas ou a deixe de fora.
- Salvar composições nomeadas, compartilhadas entre usuários com acesso à obra. Cada salvamento cria uma nova cópia com IDs de versões fixos; não há edição nem exclusão de composições nesta etapa.
- Abrir uma composição não baixa geometria automaticamente. O botão **Carregar conjunto** aplica a seleção. Se a seleção mudar, o aviso distingue a composição em edição da cena anterior.
- Colorir por modelo, pavimento ou classe IFC; ocultar/isolar modelos; recortar por pavimento; mostrar tudo; enquadrar o conjunto.
- Clicar em elementos para consultar modelo/versão, nome, classe, pavimento e GlobalId. IDs locais são resolvidos dentro de cada versão, nunca globalmente na federação.
- Consultores podem abrir e explorar composições, mas não salvá-las. Autorização por obra e restrição de escrita são verificadas no servidor.

### Dados e API

A migração **`0021_ifc_federations.sql` precisa ser aplicada no Supabase** para persistir composições. Esta alteração adiciona o arquivo de migração; não executa SQL no ambiente remoto.

`ifc_federations`: `id`, `work_id`, `name`, `version_ids`, `created_at`, `created_by`. Há RLS habilitado, sem políticas para acesso direto de anon/authenticated, seguindo o padrão das tabelas IFC existentes. A API usa a service role somente após verificar o perfil.

A composição fica fora de `PlanningData` e de `commit_planning`: não participa do snapshot inteiro que os comandos de planejamento regravam. O array de versões não possui FK individual; a API valida existência, obra e unicidade por modelo antes da inserção. As versões IFC são preservadas pelo aplicativo. Se futuramente houver exclusão de versões, será necessário rever esse contrato.

- `GET /api/ifc/federations?workId=...`: retorna `{ federations }`, em ordem decrescente de criação, com paginação interna para não truncar a lista no limite do Supabase.
- `POST /api/ifc/federations`: recebe `{ workId, name, versionIds }`; retorna `201` com `{ federation }`. Nome de 1 a 120 caracteres, 1 a 200 modelos e apenas uma versão de cada modelo da própria obra. O autor vem da sessão.
- Não há troca automática para a revisão mais recente, nem sobrescrita de uma composição existente.
- Sem a tabela nova, a página informa qual migração falta. Montagem e carregamento continuam independentes do salvamento.

### Fluxo da geometria

O visualizador lê o mapa paginado de elementos e carrega os `.frag` existentes. A identidade de leitura é `(versionId, GlobalId)`, e o ID local da malha é sempre restrito ao modelo correspondente. A cor por modelo deriva do `modelId`, para se manter entre revisões.

Agrupamentos por pavimento/classe são preparados uma vez por carga; filtros e cores não baixam a geometria novamente. Alterações visuais são serializadas no worker. Troca de conjunto/desmontagem aborta consultas e descarta modelos/worker. O carregador compartilhado também verifica cancelamento depois da carga assíncrona e remove da cena os modelos de uma carga que falhou.

O contador descreve registros com GlobalId relacionados à geometria, não o total absoluto de entidades IFC. Malhas sem dados recebem cor do modelo ou cinza nas outras modalidades; não entram no recorte por pavimento. As legendas por classe/pavimento contam o conjunto completo, independentemente dos filtros de visibilidade.

### Arquivos principais

| Arquivo | Responsabilidade |
| --- | --- |
| `src/modules/federacao/federation-overview.tsx` | Seleção, disponibilidade, abertura e salvamento |
| `src/modules/federacao/viewer.tsx` | Exploração 3D independente de planejamento |
| `src/domain/ifc-federation.ts` | Contrato e validação da composição |
| `src/app/api/ifc/federations/route.ts` | Autorização e persistência |
| `src/modules/ifc/fragments-stage.ts` | Carregador compartilhado e cancelamento |
| `supabase/migrations/0021_ifc_federations.sql` | Tabela e índice das composições |
| `tests/ifc-federation.test.ts` | Preservação de versões e validações de composição |

### Limites atuais

- **Sistemas internos do IFC ainda não são extraídos.** A disciplina cadastrada no modelo é um texto e não equivale a um sistema interno.
- Não há normalização de pavimentos entre arquivos: nomes distintos continuam distintos.
- Modelos usam o posicionamento presente na geometria convertida; não há diagnóstico de georreferenciamento, transformação manual ou detecção de interferências.
- A seleção de modelos/versões é persistida. Câmera, cor, pavimento, visibilidade e seccionamento são controles temporários da sessão e não são salvos.
- Falha em uma geometria interrompe a carga do conjunto e apresenta o erro. Não há carregamento parcial silencioso.
- Ainda não há histórico de alterações de uma mesma composição, comparação de revisões nem consumo pelo 4D.

## Próximas etapas

1. **Sistemas IFC:** ampliar a extração para sistemas e relações com elementos, preservando identidade por versão e associações múltiplas. Criar fixtures de IFC com sistemas reais antes de alterar a ingestão. Não inferir sistema apenas pela classe ou disciplina.
2. **Sistemas da obra:** definir um cadastro comum e um mapeamento explícito dos sistemas de cada arquivo. Nomes iguais não bastam para concluir que dois sistemas são equivalentes.
3. **Exploração por sistema:** árvore, filtro, isolamento e cores, com indicação de elementos sem sistema e sistemas sem geometria. Manter o filtro combinado com modelo e pavimento.
4. **Coordenação espacial:** validar posicionamento/unidades de arquivos de origens distintas e definir como registrar transformações sem alterar a fonte.
5. **BIM 4D, posteriormente:** consumir a composição salva e estender regras de vínculo; discutir granularidade de serviço/local antes de atribuir avanço a elementos.

A migração de sistemas deve ficar fora do snapshot de planejamento, assim como elementos, propriedades, quantidades e composições. Como o `.ifc` original é opcional e as relações são removidas do `.frag`, versões antigas podem precisar de reenvio para extrair sistemas; não prometer recuperação a partir da geometria atual.

## Validação desta etapa

- `npm run typecheck`: aprovado após os ajustes finais.
- `node --import tsx --test tests/*.test.ts`: 126 testes aprovados, incluindo 4 novos testes de composição. Usado porque `npm test` tenta abrir um socket IPC do `tsx` bloqueado pelo sandbox.
- `git diff --check`: aprovado.
- `npm run build`: bloqueado pelo ambiente (Turbopack tenta abrir porta local e recebe `Operation not permitted`, inclusive na tentativa com elevação).
- `npm run build -- --webpack`: bloqueado pelo download da fonte Inter (`ENOTFOUND fonts.googleapis.com`). O build de produção não foi concluído; não houve alteração nas fontes nem na configuração de build para contornar essa limitação.
- Persistência no Supabase e interação 3D com arquivos reais: ainda não verificadas nesta etapa; requerem ambiente autenticado e migração aplicada.

## Revisão crítica da página e ajustes de interface (18/09/2026)

Esta revisão atualiza a apresentação da etapa 1, preservando a persistência e o escopo de federação independente do 4D. A análise considerou o código da página, sua hierarquia, estados, controles, escalabilidade da seleção e uma prévia interativa dos componentes reais com dados fictícios. Não equivale a validação de modelos reais no ambiente autenticado.

### Diagnóstico e decisões

| Achado | Impacto | Ajuste entregue |
| --- | --- | --- |
| Cards de modelos ocupavam toda a largura antes da cena | Alto: rolagem excessiva e seleção distante do resultado | Lista lateral de 310 px em telas amplas; visualizador ao lado. Em telas menores, os painéis se empilham. |
| Incluir/excluir modelo era uma opção do seletor de versão | Alto: duas decisões diferentes no mesmo campo | Checkbox de inclusão separado do seletor de versão; versão lembrada ao retirar/reincluir um modelo. |
| Carregar ficava depois de uma lista potencialmente longa | Alto: ação principal podia ficar fora da primeira tela | Botão e motivo de indisponibilidade antes da lista, com rolagem própria na lista. |
| Sem busca nem seleção em lote | Moderado: esforço cresce com a quantidade de arquivos | Busca por nome/disciplina, filtro de selecionados, Selecionar disponíveis e Limpar seleção. |
| Salvar e abrir competiam com montar e explorar | Moderado: vários formulários abertos sem necessidade | Área recolhível de composições, com abertura e salvamento separados e versões fixas explicitadas. |
| Só era possível selecionar elementos pelo canvas | Alto: peças pequenas/sobrepostas eram difíceis de consultar | Busca por nome, classe, GlobalId, pavimento e modelo, com seleção pelo teclado e destaque na cena. |
| Controles de visibilidade em chips, detalhes no fim da página | Moderado: relação fraca entre ação e estado | Painel Modelos em cena / Buscar elementos e seção fixa de detalhes, próximos ao canvas. |
| Recorte e modelos ocultos sem resumo evidente | Moderado: cena vazia podia parecer falha | Resumo de recorte ativo e ação Limpar recorte; rótulos Visível/Oculto e ícones associados. |
| Carregamento não era informado ao montador | Alto: ações repetidas durante a carga | Estado comunicado pelo visualizador; seleção/carregamento bloqueados durante a operação. |
| Botões desabilitados e pequenos controles pouco claros | Moderado: estados e interação inconsistentes | Estilos desabilitados locais à página, alvos ampliados, labels, foco visível, `aria-pressed` e mensagens de estado. |
| Textos técnicos e legendas competiam com o trabalho principal | Baixo: ruído visual | Limites da etapa e legenda detalhada em áreas recolhíveis. |

A base que foi preservada: versões explícitas, cópias imutáveis, aviso de seleção diferente da cena, autorização no servidor, identidade de elemento restrita à versão e reaproveitamento de geometria já carregada.

### Comportamento detalhado

- **Selecionar disponíveis** escolhe a versão mais recente com transcrição e geometria disponíveis de cada modelo da obra. Pode escolher uma versão anterior se o envio mais recente estiver incompleto. A versão escolhida permanece visível no seletor. A ação abrange a obra, não apenas os resultados da busca de modelos.
- Buscar modelos não altera a composição. Limpar seleção remove todos os modelos; limpar filtros apenas restaura a lista visível.
- **Aplicar seleção ao 3D** substitui o antigo rótulo Recarregar conjunto. O estado de falha/carga/conjunto carregado aparece junto ao visualizador. A ausência de WebGL bloqueia a carga, preservando montagem e salvamento.
- **Buscar elementos** respeita modelos ocultos e o pavimento atual. Termos são combinados, ignorando caixa e acentos. A lista mostra até 50 resultados e informa a contagem total; o usuário pode refinar a busca. Elementos sem linha transcrita ainda podem ser consultados pelo clique, mas não aparecem na busca.
- A busca usa `useDeferredValue`; limita o número de nós renderizados. A seleção usa `(versionId, localId)` e não mistura elementos de arquivos distintos com o mesmo ID local.
- A legenda continua descrevendo o conjunto completo, independentemente de visibilidade, e identifica esse escopo no título.
- Nenhuma migração adicional foi criada por esta revisão. Continua necessário aplicar a `0021` para salvar/abrir composições.

### Arquivos desta revisão

- `src/modules/federacao/federation-overview.tsx`: composição, busca de modelos, inclusão, ações em lote e estados.
- `src/modules/federacao/viewer.tsx`: ferramentas, exploração, busca/seleção e inspeção de elementos.
- `src/modules/federacao/element-search.ts`: busca limitada com contagem total e escopo de visibilidade.
- `src/app/globals.css`: estados desabilitados restritos a `.federation-page`.
- `src/modules/tour/tours.ts`: orientação atualizada para o novo fluxo.
- `tests/ifc-element-search.test.ts`: busca, identidades, recortes e limite de resultados.

### Validação e limites

- TypeScript aprovado; suíte completa com **129 testes aprovados** (3 novos testes de busca).
- Prévia isolada gerada com esbuild/PostCSS a partir dos componentes reais, com contexto e respostas de API fictícios. Inspeção visual em desktop e viewport de 390 px: painéis, campos e ferramentas se reorganizam sem transbordamento horizontal visível.
- Interações verificadas na prévia: Selecionar disponíveis exclui modelo sem geometria; busca por `hidraulica` encontra disciplina `Hidráulica`; Limpar seleção desabilita carga e salvamento; formulário recolhível abre corretamente.
- O servidor local não pôde iniciar: `listen EPERM 127.0.0.1:3000`. O Chrome confirmou conexão recusada antes da prévia isolada. Persistência remota, geometrias reais, raycast e destaque 3D não foram testados nesta revisão. Os bloqueios de build de produção registrados acima continuam pendentes.
- A revisão não é uma certificação WCAG: foram melhorados rótulos, foco, alvos e estados, mas não foi executada auditoria automatizada completa de contraste ou leitor de tela.

## Preparação da implantação (19/09/2026)

O build de produção foi executado com sucesso com acesso de rede/processos locais, além de TypeScript e 129 testes. A consulta inicial ao Supabase identificou 0020 e 0021 pendentes; a conferência após o push confirmou as novas colunas e a tabela, resolvendo o bloqueio. A prévia Vercel do commit `f3351ae` foi concluída com sucesso e o conjunto segue para promoção a `main`. Ver [registro de implantação](implantacao-2026-09-19.md) para evidências, bloqueios e sequência de conclusão.

## Seccionamento nos visualizadores (20/09/2026)

Entregue nos visualizadores de **Modelos IFC** e **Modelo federado**, acima da cena. O campo **Seccionamento** permite ativar um plano de corte horizontal (Y) ou vertical (X/Z), ajustar a posição de 0 a 100% pelo slider ou campo numérico, inverter o lado preservado e remover o corte. Os controles ficam indisponíveis até existir geometria válida carregada. O corte inicial é horizontal, em 50%, desativado.

### Comportamento e decisões

- A posição é proporcional à caixa de toda a geometria carregada. Na federação, é a união das caixas em coordenadas globais: os modelos recebem o mesmo plano, preservando o alinhamento entre arquivos. Os eixos são os da cena, não os da câmera.
- O lado de coordenada menor permanece visível por padrão; **Inverter lado** preserva o maior. O corte combina com pavimento e visibilidade por modelo sem mudar de posição quando esses filtros mudam.
- **Remover corte** restaura a geometria respeitando os outros filtros. Na federação, **Mostrar tudo** e **Limpar recorte** também removem o seccionamento. Carregar/recarregar uma versão ou conjunto começa sem corte. A seleção do elemento é limpa ao ajustar o plano.
- O renderer e todos os modelos Fragments compartilham os planos globais por `getClippingPlanesEvent`, para que renderização, descarte de tiles e raycast usem o mesmo corte. O Fragments transforma os planos internamente; não se aplica a transformação uma segunda vez.
- A renderização recebe o plano imediatamente. As atualizações do worker são agrupadas com intervalo acima de `maxUpdateRate`, inclusive uma atualização final quando o valor muda durante uma operação pendente. Isso evita perder a última posição após arrastar o slider ou remover o corte. Desmontagem cancela timers e restaura callbacks.
- O clique ignora resultados de uma configuração de corte anterior e pontos no lado oculto enquanto o worker atualiza. A busca textual e as contagens continuam considerando elementos inteiros dos modelos/pavimentos filtrados, incluindo os dois lados do plano; há aviso na busca quando o corte está ativo.
- É uma ferramenta de visualização temporária: não modifica arquivos, quantitativos, dados IFC ou composições salvas. Não preenche as faces abertas do corte, não cria desenho de seção e não salva vistas. Nenhuma migração ou mudança de API foi necessária. BIM 4D permanece para outra etapa.

### Arquivos e validação

- `src/modules/ifc/section-plane.ts`: cálculo do plano global, caixa do conjunto e sincronização com Fragments.
- `src/modules/ifc/use-section-plane.ts` e `section-controls.tsx`: estado por carga, ciclo de vida e controles compartilhados.
- `src/modules/ifc/model-viewer.tsx` e `src/modules/federacao/viewer.tsx`: integração nas duas telas, seleção e limpeza.
- `src/modules/tour/tours.ts`: orientação para encontrar os novos controles.
- `tests/ifc-section.test.ts`: oito testes de eixos, extremos, coordenadas negativas, inversão, entradas inválidas, plano compartilhado, atualização final e descarte.
- TypeScript e build de produção aprovados. Suíte completa: **141 testes aprovados**, incluindo os oito testes de seccionamento.
- A inspeção visual nesta sessão não pôde ser concluída: o acesso de Computer Use foi encerrado pela restrição da URL atual do navegador. Não houve interação autenticada com modelos reais. Permanece pendente verificar visualmente corte, inversão, clique, filtros combinados, recarga e uso em tela estreita com os arquivos da obra. Os testes do controlador usam caixas e callbacks controlados; não substituem a validação WebGL/worker em navegador.


## Simulação 4D — redesenho em seis abas (23/09/2026)

No redesenho, o sistema passou a se chamar "Sistema de Gestão de Projetos – ATR". O Modelo federado virou a **aba 5**, e o BIM 4D, a **aba 6**. A tela de modelos IFC continua existindo com o nome **Arquivos IFC**, no grupo Apoio da lateral. O usuário esclareceu que "seleção em vídeo" significa **simulação animada**, sem exportação de arquivo de vídeo.

**Implementado, sem migração:** a tela BIM 4D (`/obras/{obraId}/quatro-d`) anima o cronograma de longo prazo sobre o modelo federado carregado.

- **Linha do tempo:** vai do menor início ao maior término das atividades da obra e da linha de base escolhida. Avança em quadros de 1 dia, 1 semana ou 1 mês, a 1–8 quadros por segundo. Tem reproduzir/pausar, quadro anterior/seguinte, reinício, "Hoje", controle deslizante e data exata, e a reprodução para no último quadro.
- **Modos:**
  - **Planejado:** o serviço aparece quando começa a janela prevista e fica cheio no término previsto.
  - **Executado:** último lançamento datado até a data.
  - **Planejado × executado:** cor pelo desvio em relação à linha de base escolhida ou, sem ela, ao cronograma atual. Com tolerância de 5 pontos, o serviço fica adiantado, no prazo ou atrasado.
- **Serviços não iniciados:** ficam ocultos ou, por opção, aparecem como fantasma translúcido. O avanço parcial continua sendo um tom do serviço inteiro, nunca verificação por elemento.
- **Painel "Nesta data":** lista os serviços que começam e terminam no quadro, os que estão em execução e o planejado × executado geral.
- **Tabela serviço × vagão:** acompanha a data, com planejado e executado, e segue como alternativa sem WebGL.

**Como a cena é repintada:** os elementos são agrupados uma única vez, a cada carga ou mudança de regras, em células serviço × pavimento. Cada quadro envia ao Fragments só as células que mudaram: `highlight` para cor e opacidade, `setVisible` para ocultar e um `update(true)` ao final. Isso roda em `requestAnimationFrame`, e quadros são pulados enquanto a pintura anterior não termina. A geometria só é carregada por ação explícita. As funções puras estão em `src/modules/quatro-d/simulation.ts`, com testes em `tests/four-d-simulation.test.ts` (11).

**Pendente de validação num navegador com IFC real:**

- desempenho de `highlight`/`setVisible` com centenas de milhares de elementos a 8 quadros/s;
- se o destaque persiste em elementos ocultados e reexibidos;
- se o worker acumula materiais;
- a ordenação da transparência do fantasma;
- o comportamento dos controles em telas estreitas.

**Próximas etapas:** consumir as composições salvas da federação no 4D e estender as regras de vínculo para além de pavimento e tipo.

## Cor e opacidade por modelo no federado (14/10/2026)

O usuário pediu que, no modelo federado, o cliente escolha o nível de opacidade e a cor de cada modelo, ou a cor padrão.

### Comportamento

- Em "Modelos em cena", cada modelo ganhou o botão de paleta, que abre a aparência dele:
  - **Cor**: "Cor padrão" (o tom da paleta do sistema para a disciplina, como antes), "Cor do IFC" (as cores originais do arquivo, sem pintura) ou "Escolher cor" (seletor de cor, uma cor para o modelo inteiro);
  - **Opacidade**: de 10% a 100%, de 5 em 5;
  - "Voltar ao padrão" devolve cor padrão e 100%.
- A cor escolhida vale na pintura "por modelo"; nas pinturas por pavimento e por classe a cor é a do grupo, e a **opacidade do modelo continua valendo**. A tela avisa isso quando a pintura não é por modelo. O elemento selecionado segue em âmbar, opaco.
- O ponto de cor ao lado do nome mostra a cor escolhida (um círculo multicolorido quando é a cor do IFC), e a linha diz "· 40% opaco" quando o modelo não está opaco. O botão de paleta fica azul quando a aparência difere do padrão.
- **Onde fica guardado:** no navegador (`localStorage`, chave `obra360:federacao:aparencia`), por id de modelo — o mesmo id em todas as revisões e composições, como a cor da paleta. É preferência de quem olha, não dado da obra: não vai ao banco e não muda a composição salva. Só o que difere do padrão é guardado.
- **Como pinta** (`viewer.tsx`, efeito de pintura serializado): cor padrão ou escolhida → `highlight` com a cor e `opacity`/`transparent`; cor do IFC → `resetHighlight` e, abaixo de 100%, `setOpacity` (API do `@thatopen/fragments` 3.4, que preserva a cor original).

### Arquivos

- `src/modules/federacao/appearance.ts` (modelo da aparência, leitura e gravação no navegador, regra da cor pintada), com testes em `tests/federation-appearance.test.ts`.
- `src/modules/federacao/viewer.tsx` (estado, pintura e o painel `AppearanceControls`).

### Validação e limites

- Tipos, lint e testes passando (`tests/federation-appearance.test.ts`: conferência do que vem do armazenamento e a regra da cor).
- **Não validado na tela:** em 14/10/2026 nenhuma obra tem versão de modelo com geometria enviada (a tabela `ifc_model_versions` está vazia em produção; os modelos da Blentt ainda não receberam arquivo), e o sistema não tem como apagar um modelo IFC depois, então não subi um IFC de teste. Conferir quando o primeiro conjunto for carregado: opacidade baixa com várias disciplinas sobrepostas e a "Cor do IFC" em modelos que vêm sem cor (o visualizador mostraria o cinza padrão do arquivo).

## Renomear modelo IFC (15/10/2026)

O usuário pediu para mudar o nome dos arquivos IFC. Em Arquivos IFC, cada modelo ganhou "Renomear", que troca o **nome e a disciplina** do modelo (comando `update_ifc_model`; nome obrigatório, até 120 caracteres, sem repetir outro modelo da obra, ignorando maiúsculas). As versões e os arquivos enviados não mudam: a coluna "Arquivo" continua com o nome original do `.ifc`, e as composições do federado passam a mostrar o nome novo. Quem tem o módulo IFC liberado pode renomear; consulta não. O nome fica no snapshot do planejamento (`ifc_models`), sem migração. Teste em `tests/ifc-model-rename.test.ts`; na tela, o "Renomear" abriu preenchido num modelo da Blentt, sem salvar.

Na conferência de 15/10/2026, a Blentt já tinha 49 modelos e 75 versões enviadas (o envio voltou a funcionar com a correção do recorte por módulo de 14/10).

## Tour guiado (20/10/2026)

Arquivos IFC (30 passos) e Modelo federado (26) ganharam tour "Como usar" cobrindo cada botão e campo, incluindo o seccionamento (`tourId` em `section-controls.tsx`: `ifc-section` e `federation-section`). Só marcações `data-tour`, sem mudança de comportamento. Detalhes em [tour-guiado.md](tour-guiado.md).

## Modelos do Orçamento 4D no federado (27/11/2026)

O usuário pediu para trazer ao Modelo federado os modelos que já estão no sistema Orçamento 4D e as ferramentas do 3D de lá: visualização, corte, medidas, seleção de objetos e o menu de modelos (liga/desliga e opacidade).

### Comportamento entregue

A tela `/obras/{obraId}/federacao` passou a ter **duas fontes de modelos**, trocadas por dois botões abaixo do título:

- **Modelos do Orçamento 4D** (abre por padrão quando a obra tem modelos lá): todos os modelos prontos da obra entram na cena de uma vez, na revisão atual do Orçamento 4D, com os painéis flutuantes do visualizador de lá.
- **Arquivos IFC do Obra 360**: a tela das etapas anteriores, sem mudança (escolha de versões, Carregar conjunto, composições salvas, cores por modelo/pavimento/classe, busca de elementos, seccionamento por plano).

Obra sem modelo no Orçamento 4D não mostra os botões: a tela é a de arquivos, como antes.

Na fonte Orçamento 4D:

1. **Modelos**: uma linha por disciplina, com caixa de ligar/desligar, cor e opacidade (10% a 100%). Desligada, a disciplina vira vulto transparente ou some (opção "Desmarcadas somem em vez de ficar transparentes") e deixa de ser clicável; com opacidade abaixo de 100% o clique também a atravessa quando há algo opaco atrás. "Enquadrar tudo" e "Resetar".
2. **Caixa de corte**: seis planos numa caixa girada para acompanhar o prédio (o giro sai das faces das paredes), ajustada por três faixas de dois cursores (Altura, Comprimento, Largura) ou pelas alças nas faces, no 3D. "Ajustar à seleção" e "Modelo inteiro".
3. **Medir**: distância entre dois pontos com encaixe em vértice, aresta ou superfície, com as componentes horizontal e vertical; lista de medidas, apagar uma, limpar todas, Esc cancela.
4. **Seleção**: o clique pinta a peça de azul, a câmera passa a girar em torno dela e o painel à direita mostra nome, modelo, classe, tipo, pavimento, material, classificação, GlobalId, quantitativos (do IFC e da geometria) e propriedades (da peça somadas às do tipo). Peça de conjunto seleciona o conjunto; com Alt, só a peça.
5. **Recentralizar**: enquadra os modelos visíveis ou a caixa de corte.

Cor, opacidade e o modo das desmarcadas ficam no navegador (`localStorage`, chaves `obra360:federado:estilo:{modelo}` e `obra360:federado:ocultos`). Corte, medidas, seleção e visibilidade são da sessão.

### De onde vêm os dados

O Orçamento 4D usa o mesmo banco (Supabase `takt-hub`), no schema `orcamento`. **Nada é copiado e nada é gravado lá**: o Obra 360 lê, no servidor e com a chave de serviço, `orcamento.empreendimentos`, `obras_privadas`, `modelos_ifc`, `elementos_ifc`, `tipos_ifc` e a função `orcamento.geometria_parte` (a geometria Fragments fica em `orcamento.geometrias`, em partes de 2 MB). **Sem migração.**

- **Ligação da obra:** pelo nome, sem acento nem caixa (`matchOrcamentoObra`). Em 27/11/2026 casam Atmos, Bioma, Blentt, Brizz, Essenza, Mozine e Tauá; Nova Sede, SEPAT e Sonatta não têm modelos lá. Empreendimento listado em `orcamento.obras_privadas` nunca casa, e dois empreendimentos com o mesmo nome também não.
- **Autorização:** a do Obra 360, não a do Orçamento 4D: módulo "Modelo federado" liberado e a obra entre as da pessoa (`orcamentoAccess`). Toda rota confere que o modelo pedido é da obra ligada; id de modelo de outra obra responde 404.
- **Rotas** (todas `GET`, sob `/api/ifc`, que o proxy já libera para o módulo):
  - `/api/ifc/orcamento?workId=` → `{ obra, models }` (só modelos com `status = 'pronto'`);
  - `/api/ifc/orcamento/geometria?workId=&modeloId=&revisao=&parte=` → bytes de uma parte; 409 se a revisão pedida não é a atual;
  - `/api/ifc/orcamento/elemento?workId=&modeloId=&expressId=` → `{ element }` (`null` para geometria sem linha no banco);
  - `/api/ifc/orcamento/conjuntos?workId=&modeloId=` → `{ pairs }` (peça, conjunto).
- **Geometria no navegador:** as partes são baixadas quatro por vez, juntadas e guardadas na Cache API (`obra360-federado-v1`) por modelo, revisão e número de partes; revisão nova apaga a anterior. Três modelos são abertos por vez.

### Decisões

- **Ler em vez de copiar.** Os dois sistemas dividem o banco, e a geometria de uma obra tem de 27 a 68 MB: copiar para o Storage do Obra 360 dobraria o espaço e deixaria duas revisões para manter.
- **O visualizador foi copiado do Orçamento 4D**, não reescrito: `Visualizador.ts`, `medicao.ts` e `orientacao.ts` vieram de `~/Orçamento-4D/app/src/viewer` (commit `ae6a175`), com os nomes em português para as duas cópias poderem ser comparadas. Saiu o que é só de lá: linha do tempo 5D, cores da Claudia, destaque do item da EAP, isolamento e a conversão de `.ifc` no navegador. As regras puras da medição foram para `medicao-regras.ts`, sem three.js.
- **Dependências novas:** `@thatopen/components` 3.4.8 e `camera-controls` 3.1.2, fixadas nas versões do Orçamento 4D. O `@thatopen/fragments` continua em 3.4.7: o `^3.4.8` do npm puxaria o 3.6 e os `.frag` das duas bases foram gerados com o 3.4.
- **A tela antiga ficou como segunda fonte**, intacta. Unificar os dois visualizadores fica para depois, se fizer sentido.
- three.js e o That Open só são carregados no navegador, quando a cena abre (`import()` dentro do efeito).

### Arquivos

| Arquivo | Responsabilidade |
| --- | --- |
| `src/domain/orcamento-models.ts` | Regras puras: ligação da obra pelo nome, modelos prontos, conferência de parâmetros, junção das partes, formato do elemento |
| `src/infrastructure/orcamento/ifc-models.ts` | Leitura do schema `orcamento` e autorização (`orcamentoAccess`) |
| `src/app/api/ifc/orcamento/**/route.ts` | As quatro rotas |
| `src/modules/federacao/federation-hub.tsx` | Troca de fonte, cabeçalho e ajuda da fonte Orçamento 4D |
| `src/modules/federacao/orcamento/scene.tsx` | Cena, painéis (Modelos, Caixa de corte, Medir) e painel do elemento |
| `src/modules/federacao/orcamento/visualizador.ts` | Cena 3D, pintura, clique, caixa de corte e medição (cópia adaptada) |
| `src/modules/federacao/orcamento/medicao.ts`, `medicao-regras.ts`, `orientacao.ts` | Desenho e regras da medição; giro do prédio |
| `src/modules/federacao/orcamento/geometry.ts` | Download em partes e cache no navegador |
| `src/modules/federacao/orcamento/visualizador.css` | Estilos dos painéis, sob `.f3d` |
| `tests/orcamento-models.test.ts`, `tests/federado-medicao.test.ts`, `tests/federado-orientacao.test.ts` | 21 testes |

Tour "Como usar" do federado com 8 passos novos (`federado-*`), pulados quando a outra fonte está aberta. Manual da Claudia com a seção `federacao-orcamento-4d` e remissões nas duas seções antigas.

### Validação

- Sequência do `ci.yml` local: `verify:portal-kit`, `typecheck`, `lint` (34 avisos, os mesmos de antes), `format:check`, `npm test` (1.880 testes, 21 novos), `validate:migrations`, `build` e `test:e2e` (10 de fumaça), todos aprovados.
- **Rotas reais com dados reais (só leitura):** `next dev` local com um Supabase de teste que respondia o perfil e repassava ao banco de produção apenas as leituras do schema `orcamento` e o nome da obra. Lista do Blentt (16 modelos, 145.900 elementos), parte de geometria (200, `application/octet-stream`), elemento com propriedades, conjuntos; parte fora do intervalo e revisão antiga (409), modelo do Atmos pedido pela obra Blentt (404), obra que não é da pessoa (403), parâmetro inválido (400).
- **Tela no navegador (Chromium sem tela, WebGL por software) com os 16 modelos do Blentt:** carga em cerca de 20 s; desligar a Arquitetura (vulto e sumir); cor e opacidade da Estrutura gravadas no navegador; Resetar; clique selecionou a laje "L1" da Estrutura com quantitativos e 13 propriedades; caixa de corte ligada, faixa de altura reduzida, "Ajustar à seleção" fechou a caixa na laje; duas medidas com horizontal e vertical, apagar uma, desligar; troca para "Arquivos IFC do Obra 360" e volta; largura de 390 px sem rolagem horizontal; nenhum erro no console.
- **Não validado:** uso logado em produção, arrasto das alças da caixa com o mouse, toque em celular real e as obras maiores (Tauá, 19 modelos e 68 MB; Atmos, 275 mil elementos) no navegador de quem usa.

### Limites e pendências

- A ligação é pelo nome da obra. Se uma obra for renomeada num dos sistemas, a fonte Orçamento 4D deixa de aparecer; um vínculo explícito em Configurações da obra resolveria e fica como próxima etapa se houver caso.
- A fonte Orçamento 4D não tem cores por pavimento/classe, filtro de pavimento, busca de elementos por texto nem composições salvas; a fonte de arquivos não tem caixa de corte nem medição.
- Vínculos com o orçamento, custos e o 5D continuam só no Orçamento 4D.
- Modelo enviado no Orçamento 4D depois de a tela aberta só aparece ao recarregar.
- O visualizador é uma cópia: correções feitas no Orçamento 4D precisam ser trazidas à mão.
- A marca "That Open Company" aparece no canto da cena; vem da biblioteca, como no Orçamento 4D.


# Diário de Obra (aba 2.4)

Decidido com o usuário em 24/11/2026, a partir do modelo aprovado no mesmo dia. O diário do dia é
preenchido no Obra 360 e enviado ao Sienge pela API REST `construction-daily-report`, por um botão, no fim
do dia. A obra piloto é o Atmos (empreendimento 32 do Sienge), que já tem 368 diários lançados à mão no
Sienge.

**Situação:** código do módulo escrito em 24/11/2026 e gravado no branch `diario-de-obra` (commit local,
**sem push e sem publicação**; o `main` não tem o diário). **A migração `0059_daily_report.sql` foi criada e não foi aplicada**: sem ela a tela responde
"indisponível" e as demais seguem normais. **Nenhum diário foi gravado no Sienge de verdade ainda** (ver
"Integração com o Sienge"). O módulo nasce sem ninguém liberado, fora os administradores.

## O que a tela faz

`/obras/{obraId}/diario`, grupo **2 · Controles de obra** do menu, item **2.4 · Diário de Obra**. O modo de
campo fica em `/campo/diario` e funciona sem sinal: o rascunho e as fotos ficam no aparelho e sobem para o
Obra 360 quando o sinal volta. Subir para o Obra 360 não é enviar ao Sienge.

- **Dia e situação:** um diário por obra e dia, em rascunho ou enviado (com o número do Sienge). A tela
  lista os diários dos 60 dias até a data.
- **Clima e jornada:** turnos manhã, tarde e noite, cada um com início, fim e clima (Aberto, Chuva leve,
  Chuva forte, Impraticável). O diário novo vem com manhã (08:00–12:00) e tarde (13:00–17:00), a jornada
  que o Atmos lançava no Sienge. Índice pluviométrico em mm, opcional.
- **Atividades:** trazidas dos compromissos do curto prazo da semana ou avulsas, com local (Locais da
  obra), quantidade, unidade e observação.
- **Mão de obra:** as linhas do histograma do dia (empresa × função), com "Repetir o último dia".
- **Equipamentos:** tipo (lista do Sienge), quantidade e situação (Em uso, Parado, Quebrado).
- **Ocorrências:** tipo (lista do Sienge) e descrição.
- **Observações** e **fotos** com descrição e local.
- **Conferência e envio:** a tela monta o mesmo corpo que o servidor vai enviar e mostra o que impede o
  envio e o que vai ficar de fora; o botão **"Enviar ao Sienge"** cria o diário e manda as fotos.
- **Ligações com o Sienge**, feitas na própria tela: o usuário do Sienge de quem preenche, o local da
  obra ↔ local do Sienge e a empresa do histograma ↔ tipo de equipe do Sienge.

## Decisões

1. **Envio por botão.** Nada sai sozinho para o Sienge: o diário fica em rascunho no Obra 360 até alguém
   clicar em "Enviar ao Sienge".
2. **Um diário por obra e dia** (`unique (work_id, report_date)`).
3. **A mão de obra é o histograma do dia.** O diário não guarda equipes: lê e grava as mesmas linhas de
   `headcount_entries` da aba 2.2 (um lançamento só). A grafia que a obra já usa vence, como no
   histograma.
4. **Ao Sienge a mão de obra vai por empresa**, somando as funções: uma linha por tipo de equipe do
   Sienge. A função fica só no Obra 360. ATR e Takt (`isOwnCompany`) vão como `DIRECT_LABOR`, as demais
   como `THIRD_PARTY`; um tipo que junte própria e terceira vai como terceira.
5. **Depois de enviado, o diário fica travado.** O Sienge não tem rota para corrigir clima, jornada,
   pluviométrico e observações. Corrigir é o administrador **excluir do Sienge e reabrir**: o diário volta
   a rascunho e, no novo envio, recebe outro número no Sienge.
6. **Foto nova pode entrar depois do envio**, porque o Sienge aceita anexo a qualquer momento. A foto que
   já foi ao Sienge não se edita.
7. **Foto sem local, ou com local ainda não ligado ao local do Sienge, não entra no Relatório Fotográfico
   do Sienge**: sobe como anexo comum. A tela avisa antes do envio.
8. **Acesso:** módulo liberado por pessoa (`diario` em `RESTRICTED_SECTIONS`; o admin marca em
   Configurações → Usuários → Módulos). Quem tem o módulo e a obra preenche e envia; o papel consulta só
   lê (`canWriteDailyReport`); só o admin exclui do Sienge e reabre (`canAdminDailyReport`) e liga empresa
   a tipo de equipe.
9. **Ligações.** A obra precisa estar ligada ao empreendimento em Configurações da obra ("Orçamento do
   Sienge", já existente, migração 0057). O código de usuário do Sienge é de cada pessoa
   (`profiles.sienge_user_code`) e vai como responsável. O local da obra guarda o código do local do
   Sienge (`lob_locals.sienge_site_id`). A empresa ↔ tipo de equipe vale para todas as obras
   (`sienge_crew_links`) e é automática quando o nome é igual ao do tipo de equipe.
10. **Gravação com versão.** `version` sobe a cada gravação; o servidor recusa a de quem leu uma versão
    antiga, para duas pessoas no mesmo dia não se sobrescreverem.
11. **Fora do snapshot do planejamento**, como o histograma e a terminalidade: rotas próprias em
    `/api/diario`, e a falta das tabelas derruba só este módulo.
12. **O modo de campo fica fora do proxy** (`/campo/` é casca estática guardada pelo service worker, como
    o da terminalidade); quem autoriza são as APIs, que seguem o módulo.

## Integração com o Sienge

Usa as mesmas variáveis do orçamento (`SIENGE_SUBDOMAIN`, `SIENGE_API_USER`, `SIENGE_API_PASSWORD`), que
passam a servir também para gravar. As chamadas contam no painel de consumo e as leituras de apoio ficam
10 minutos na memória do processo.

### Rotas usadas

| Chamada ao Sienge | Para quê | Situação em 24/11/2026 |
| --- | --- | --- |
| `GET /construction-daily-report` (lista, por empreendimento e datas) | achar o diário de um dia | liberada (leitura conferida) |
| `GET /construction-daily-report/{buildingId}/{id}` (detalhe) | usada só no levantamento; o código não a chama nesta etapa | liberada (leitura conferida) |
| `GET /construction-daily-report/types` | tipos de ocorrência (11), de equipe (57) e de equipamento (4) | liberada (leitura conferida) |
| `POST /construction-daily-report` | cria o diário, numa chamada | **não devolveu 403, mas nenhum diário foi gravado**: a tentativa no empreendimento de teste (1000) foi recusada porque a obra não está "em andamento" |
| `POST /construction-daily-report/{buildingId}/{id}/attachments` (multipart, campo `file`) | uma foto por chamada | **não exercitada** (depende de um diário criado) |
| `DELETE /construction-daily-report/{buildingId}/{id}` | excluir do Sienge antes de reabrir (admin) | **não exercitada** |
| `GET /sites?buildingId=` | locais da obra no Sienge | **não liberada no usuário de API**: sem ela o código do local é digitado |
| `GET /building-projects/.../tasks` | tarefas do planejamento do Sienge | **não liberada**; não é usada nesta etapa |
| empreendimentos e orçamento | ligação da obra (já existente) | liberadas |

O levantamento de 24/11/2026 foi só de leitura, mais a tentativa de gravação recusada descrita acima.

### Mapa de campos (Obra 360 × Sienge)

| Obra 360 | Sienge (`POST /construction-daily-report`) | Observação |
| --- | --- | --- |
| obra (`work_settings.sienge_building_id`) | `buildingId` | sem a ligação, o envio é impedido |
| data do diário | `date` (`yyyy-MM-dd`) | |
| código de usuário de quem envia (`profiles.sienge_user_code`) | `responsibleId` | sem ele o diário vai sem responsável (aviso) |
| índice pluviométrico (mm) | `rainfallIndex` | de 0 a menos de 9999,99; vazio não vai |
| observações | `notes` | até 4.000 caracteres; vazio não vai |
| turno (manhã, tarde, noite) | `shifts[].description` | hoje em inglês (`Morning`, `Afternoon`, `Night`): **a confirmar** |
| início e fim do turno | `shifts[].startTime`, `finishTime` (`HH:mm`) | fim depois do início; ao menos um turno |
| clima do turno | `shifts[].weatherCondition` | hoje em inglês (`Fine`, `Light rain`, `Heavy rain`, `Unworkable`): **a confirmar** |
| atividade (do curto prazo ou avulsa) | `detachedTasks[]`: `description`, `notes`, `quantity`, `unitOfMeasure`, `siteId` | descrição até 200; `siteId` só quando o local está ligado |
| ocorrência | `events[]`: `eventTypeId`, `description` | |
| mão de obra (histograma do dia, somada por empresa) | `crews[]`: `crewTypeId`, `quantity`, `assignment` | empresa sem tipo de equipe não segue (aviso); a função não vai |
| equipamento | `equipments[]`: `equipmentTypeId`, `quantity`, `status` (`IN_USE`, `IDLE`, `OUT_OF_ORDER`) | |
| foto (JPEG reduzido no aparelho) | anexo: `description`, `localId`, `showInReports` | descrição obrigatória; `localId` e `showInReports` só com o local ligado |

A documentação do POST dá turno e clima em inglês, e a leitura devolve em português ("Manhã", "Aberto").
Se o Sienge recusar o inglês, a troca é nas constantes `SIENGE_SHIFT` e `SIENGE_WEATHER` de
`src/domain/sienge-daily-report.ts`.

### Ordem do envio

1. `POST /api/diario/enviar` cria o diário no Sienge (se ainda não criou), marca-o como enviado e devolve
   as fotos que faltam.
2. A tela chama `POST /api/diario/enviar/foto` para cada foto, uma de cada vez. A que falhar fica com o
   erro e é reenviada sozinha, sem repetir o diário.
3. A recusa do Sienge fica em `daily_reports.last_error`, já no texto que a tela mostra, e o diário segue
   em rascunho.

## Onde está

| Parte | Arquivo |
| --- | --- |
| Contrato: tipos, limites, comandos e respostas | `src/domain/daily-report.ts` |
| Corpo do envio, bloqueios e avisos (puro, usado pela tela e pelo servidor) | `src/domain/sienge-daily-report.ts` |
| Regras dos comandos e permissões | `src/application/use-cases/daily-report-commands.ts` |
| Leitura e gravação | `src/infrastructure/repositories/supabase/daily-report-repository.ts` |
| Chamadas ao Sienge | `src/infrastructure/integrations/sienge/daily-report.ts` |
| Rotas | `src/app/api/diario/` (`route.ts`, `commands`, `upload-url`, `enviar`, `enviar/foto`, `reabrir`) |
| Tela e cliente | `src/modules/diario/` |
| Páginas | `src/app/(app)/obras/[obraId]/diario/page.tsx` e `src/app/campo/diario/page.tsx` |
| Banco | `supabase/migrations/0059_daily_report.sql` |
| Menu, liberação e contagem de acessos | `src/modules/layout/work-nav.tsx`, `src/application/module-access.ts`, `src/domain/access-usage.ts` |
| Manual da assistente e tour | `src/modules/agente/manual/diario.ts`, `src/modules/tour/pages/diario.ts` |
| Testes | `tests/daily-report*.test.ts`, `tests/sienge-daily-report*.test.ts`, e os casos do diário em `tests/module-access.test.ts` e `tests/access-usage.test.ts` |

### Banco (migração 0059, criada e não aplicada)

- `daily_reports`: um diário por obra e dia, com turnos, atividades, ocorrências e equipamentos em jsonb,
  a situação (`draft` ou `sent`), o empreendimento e o número do diário no Sienge, a última recusa e a
  versão.
- `daily_report_photos`: fotos do diário, com local, descrição e a situação do envio de cada uma.
- `sienge_crew_links`: empresa do histograma ↔ tipo de equipe do Sienge, para todas as obras.
- Colunas `lob_locals.sienge_site_id` e `profiles.sienge_user_code`.
- Bucket privado `diario` (a imagem e a miniatura, em `<obra>/<diário>/<foto>.jpg`).

Não reescreve `commit_planning` e pode ser rodada de novo.

### Tour

Os passos apontam para cinco marcações `data-tour` da tela: `diario-dia`, `diario-turnos`,
`diario-mao-de-obra`, `diario-fotos` e `diario-enviar`. `tests/tour-targets.test.ts` reprova enquanto a
tela não tiver as cinco.

## Validações feitas

Em 24/11/2026, no branch `diario-de-obra`:

- **Testes do módulo** (`node:test`): `tests/daily-report.test.ts` (19, regras dos comandos e acerto do
  histograma), `tests/sienge-daily-report.test.ts` (9, corpo enviado ao Sienge, bloqueios e avisos),
  `tests/sienge-daily-report-client.test.ts` (12, chamadas ao Sienge com `fetch` simulado: URL, método,
  corpo, gravação que não repete em 500 nem em erro de rede, `clientMessage` do Sienge na mensagem, 403 nos
  locais) e `tests/daily-report-model.test.ts` (21, fila do aparelho e situação do dia).
- **Sequência da CI inteira:** `verify:portal-kit`, `tsc`, `eslint` (0 erros; os 34 avisos já existem no
  `main`), Prettier, `npm test` (1.784 testes, todos passando), `validate:migrations` com a 0059,
  `next build` (as seis rotas `/api/diario/*`, a página e a casca estática `/campo/diario` no resultado) e o
  e2e de fumaça (10 de 10).
- **Tela no navegador** (Chromium, celular 390×844 com toque e computador 1440×900), com `next dev`,
  Supabase falso e as rotas `/api/diario/*` respondidas em memória pelas regras reais
  (`planDailyReportCommand`, `buildSiengeDailyReport`). Passaram os 11 passos do roteiro: abrir um dia sem
  diário, preencher todas as seções (com "Repetir o último dia" e duas fotos), salvar (o `save_report`
  chegou com o conteúdo e a mão de obra certos), ligações com o Sienge, conferência e envio com uma foto
  recusada e reenviada por "Tentar de novo", "Excluir do Sienge e reabrir", sem sinal (guardado no aparelho
  e sincronizado sozinho na volta), conflito de versão, troca de dia, modo de campo `/campo/diario` e
  perfil de consulta. Sem erro de React no console. Seis defeitos achados nessa conferência foram
  corrigidos antes do commit: tela cortada à direita no celular, conflito de versão tratado como recusa
  comum (agora a rota responde 409 e a tela trava e oferece recarregar), aviso de pendências piscando a
  cada tecla, rodapé cortado no celular, título do rodapé enganoso no perfil de consulta e texto cortado
  no campo de código do local.
- **Histograma (2.2):** o dia cujo diário já foi enviado mostra o aviso de que mudar o efetivo ali não
  altera o diário que está no Sienge (`sentDiaryDays` em `GET /api/histograma`; sem a 0059 a lista vem
  vazia e o histograma segue normal). Testes do histograma passando.
- **Não validado:** gravação num Supabase real (a 0059 não foi aplicada), envio real ao Sienge, o service
  worker abrindo `/campo/diario` sem sinal a frio, a câmera do celular, Safari/iPhone e uso no celular
  real.

## Pendências

- **Aplicar a migração 0059** no `takt-hub`, antes de publicar o código.
- **Primeiro envio real**, no Atmos (empreendimento 32), para confirmar os valores de turno e clima (inglês
  na documentação do POST, português na leitura), o anexo de foto e a exclusão.
- **Pedir a liberação, no usuário de API do Sienge,** de `GET /sites` (lista de locais; hoje o código é
  digitado) e de `GET /building-projects/.../tasks`.
- **Liberar o módulo** para quem preenche em cada obra (Configurações → Usuários → Módulos) e pedir a
  cada pessoa o código de usuário do Sienge.
- **Ligar os locais** da obra piloto aos locais do Sienge e as empresas do histograma aos tipos de equipe.
- **Testar no celular real**, com e sem sinal.
- Conferir os textos do manual da assistente e do tour com a tela publicada (foram escritos junto com
  ela, a partir do contrato e do modelo).

**Fora desta etapa:**

- Atividades ligadas às tarefas do planejamento do Sienge.
- Correção parcial de um diário enviado, por PUT (`/tasks`, `/crews`, `/events`, `/equipments`).
- Sugestão automática do clima pela rota `/api/clima`.
- Ferramentas da assistente (Claudia) para ler ou preencher o diário: hoje ela só explica a tela pelo
  manual.
- O diário nos dashboards (aba 0 e Dashboard geral) e no resumo semanal.

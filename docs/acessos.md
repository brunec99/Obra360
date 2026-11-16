# Acessos ao Obra 360: aba "Acessos" no Dashboard geral (15/11/2026)

## O pedido

Em 15/11/2026 o usuário pediu, para admins, "uma aba no dashboard geral de acessos por usuários para monitorar quem tem acessado o portal, quais módulos e por quanto tempo".

Até então o sistema não registrava uso de ninguém. O único dado existente era a data do último login de cada pessoa, guardada pelo Supabase Auth (que é dividido com o Takt Hub). Por isso a entrega tem duas partes: a **captura** do tempo de uso, que é nova, e a **aba** que mostra esse tempo.

O modelo de UX foi publicado antes do código e **aprovado sem mudança** no mesmo dia ("aprovado, ja faça todas as alteraçoes e commit"): https://claude.ai/artifact/Gi9MZbuyDxZ8YCqhVGUkBM. Ele traz a aba no formato real, com dados de exemplo, como o minuto é contado e 18 regras numeradas.

## Regras aprovadas

Onde fica e quem vê

1. O Dashboard geral ganha duas abas: "Obras" (a tela de antes, sem mudança) e "Acessos", com endereço próprio (`/dashboard/acessos`).
2. Só admin vê a aba e os dados. Para os demais a tela continua sem abas, `/dashboard/acessos` volta para `/dashboard` e a rota de dados responde 403. Ninguém vê o próprio uso nem o dos outros.
3. Aparecem todas as pessoas cadastradas, inclusive admins. Quem não entrou no período fica no fim, apagado, com o último acesso ou "Nunca entrou". O filtro "Papel" tira os admins.

Como conta

4. Tempo é **tempo ativo**: a aba do Obra 360 está visível e houve clique, tecla, rolagem, toque ou movimento do ponteiro nos últimos 5 minutos. Conta até 5 minutos depois da última interação e para. Aba escondida, computador parado ou tela bloqueada não contam.
5. Sessão é uma entrada no sistema. Voltar depois de 30 minutos sem uso abre outra. Duas abas abertas ao mesmo tempo nunca somam mais que o relógio.
6. O módulo vem da tela aberta, com o número do menu: 0 a 3.2, mais Vagões e as telas de Apoio. Fora das obras: Lista de obras, Dashboard geral, Configurações e Agente de IA. O modo de campo da terminalidade e da segurança conta no módulo, marcado "campo". A janela da Claudia conta para a tela que está embaixo.
7. Período em dias corridos, no horário de Brasília, contando sábado e domingo: Hoje, 7 dias (abre aqui), 30 dias, Este mês, Mês anterior e Intervalo (até 400 dias). As setas dos cartões comparam com o período anterior do mesmo tamanho.
8. Aparelho: computador ou celular/tablet, pelo navegador. O modo de campo conta sempre como celular. Não grava IP, localização nem o que foi digitado ou visto.

O que a tela mostra

9. Seis cartões e a frase do resumo: pessoas que entraram (de quantas cadastradas), tempo ativo, média por pessoa que entrou, sessões, no sistema agora (uso ativo nos últimos 5 minutos; a tela atualiza sozinha a cada minuto) e sem acesso no período.
10. Tabela por pessoa, aberta em "tempo ativo, maior primeiro"; ordena por qualquer coluna. Clicar na linha abre as sessões, o tempo por módulo e o tempo por obra da pessoa.
11. Tempo por módulo e tempo por obra, maior primeiro, com o número de pessoas. Os filtros de pessoa, papel, obra, módulo e aparelho recortam tudo, cartões inclusive.
12. Uso por dia: pessoa × dia em minutos ativos. Até 31 dias, uma coluna por dia; período maior, uma coluna por semana.
13. "Baixar planilha (.csv)": uma linha por pessoa × dia × obra × módulo, com o recorte da tela. A aba não tem PDF.

Dados, privacidade e subida

14. A contagem começa no dia da publicação com a migração aplicada; não há como recuperar o uso de antes. Para quem não tem uso medido, a tabela usa o último login do Supabase ("último login 28/10, antes da medição").
15. Guarda de 13 meses; o mais antigo é apagado sozinho.
16. A página de privacidade (`/privacidade`) ganhou a seção "Registro de uso do Obra 360".
17. Sem sinal no modo de campo, o minuto não conta. O registro nunca trava a tela nem mostra erro.
18. Migração nova (0051) com duas tabelas e duas funções. Sem ela o sistema segue normal: o registro falha em silêncio e a aba avisa que falta a 0051.

## Arquitetura

**Captura (navegador → servidor)**

- `src/modules/acessos/active-clock.ts`: a conta pura do tempo ativo (corte exato em "última interação + 5 min", tick de 5 s com no máximo 15 s por passo, envio a cada 60 s, no máximo 120 s por envio, resto em milissegundos guardado para o próximo envio). Usa `performance.now()`, que não pula com ajuste do relógio do computador.
- `src/modules/acessos/access-tracker.tsx`: componente sem tela, montado no layout `(app)` e nas páginas `/campo/seguranca` e `/campo/terminalidade`. Envia ao trocar de tela, a cada 60 s, ao esconder a aba e no `pagehide` (os dois últimos por `navigator.sendBeacon`). Sem sinal ou com erro, o tempo se perde em silêncio. No campo, manda a obra de `?obra=`.
- `POST /api/acessos` (`src/app/api/acessos/route.ts`): só pede sessão. Lê `{ path, seconds, workId? }`, deduz tela e obra pelo `path` (`screenOfPath`) e o aparelho pelo User-Agent, e chama `record_access`. Responde 204 em quase tudo, inclusive sem a 0051.
- `record_access` (0051): trava por pessoa, abre sessão nova depois de 30 minutos, limita cada registro ao tempo que passou desde o registro anterior da mesma pessoa (+2 s de folga; o primeiro de uma sessão vale até 120 s), soma na linha de uso da sessão, dia, obra, tela, campo e aparelho, e apaga o que passou de 13 meses.

**Leitura (aba)**

- `GET /api/dashboard/acessos?de=&ate=` (`src/app/api/dashboard/acessos/route.ts`): só admin. Devolve o `AccessPayload`: uso e sessões do período e do anterior do mesmo tamanho (uma chamada a `access_report`, que responde um jsonb compacto e não esbarra no limite de linhas da API), perfis com e-mail e último login do Supabase Auth, obras e o último acesso de cada pessoa.
- `src/infrastructure/access/access-store.ts`: as chamadas ao banco e a conversão da resposta compacta.
- `src/domain/access-usage.ts`: catálogo das telas, leitura do endereço, aparelho, período e formatos. `src/domain/access-report.ts`: todas as contas da aba (`buildAccessView`, `personDetail`, `filteredUsage`). Os filtros são aplicados na tela, sem voltar ao servidor.
- Tela: `src/app/(app)/dashboard/acessos/page.tsx` (confere o admin), `src/modules/dashboard/acessos/` (`access-overview.tsx`, `use-access-data.ts`, `access-csv.ts`, `access-styles.ts`, `params.ts`) e as abas em `src/modules/dashboard/dashboard-tabs.tsx`, usadas também pela aba Obras.
- Tour (`src/modules/tour/pages/acessos.ts`, mais um passo no tour do Dashboard geral), manual da Claudia (`src/modules/agente/manual/acessos.ts`, três seções na tela `dashboard-geral`), a Claudia geral reconhece a aba como Dashboard geral, e a migração entrou na sondagem de Configurações → Banco de dados.

## Migração 0051

`supabase/migrations/0051_access_usage.sql`: tabelas `access_sessions` e `access_usage` (RLS ligada sem política, grant para `service_role`), funções `record_access` e `access_report` (sem acesso para `public`, `anon` e `authenticated`; execução só para `service_role`). `access_usage.work_id` não tem chave estrangeira de propósito: excluir uma obra não apaga o histórico de uso, e a tela mostra "Obra excluída". Pode ser rodada de novo.

**Estado: criada em 15/11/2026, não aplicada.** Até ser aplicada no `takt-hub`, a aba mostra o aviso e só o último login de cada pessoa.

## Diferenças em relação ao modelo

Pequenas, todas da implementação; nenhuma regra mudou.

- **Setas dos cartões:** somem enquanto o período anterior começa antes do primeiro dia medido (a dica diz "o período anterior não foi todo medido"). Sem isso, a segunda semana depois da publicação mostraria "▲ 600%". Empate aparece como "= igual a…".
- **Antes da 0051:** a frase diz "A contagem do tempo de uso ainda não começou", o cartão "Sem acesso" mostra "—" e as linhas levam o selo "Sem medição" com o último login, em vez de "Sem acesso" (que seria falso para quem fez login no período).
- **Com filtro de obra, módulo ou aparelho**, o selo e o cartão dizem "Sem uso no recorte" e a frase diz "usaram o recorte escolhido".
- **Nomes curtos** ("1.3 Curto", "3.1 Segurança") só em "Onde passa o tempo"; o resto usa os nomes do catálogo ("1.4 Quadro de Restrições"). "Nunca entrou" leva "cadastrada em dd/mm".
- **Uso por dia:** legenda de 0 a 91+ (faixas 1–30, 31–60, 61–90, 91+ minutos; por semana, 1–120, 121–300, 301–600, 601+); minuto que arredonda para zero aparece como "<1".
- **Detalhe:** com mais de cinco módulos, os quatro maiores e "Outros N módulos"; "Ver as N sessões" alterna com "Mostrar só as 5 mais recentes".
- **Troca de período:** o período anterior fica na tela, apagado, até o novo chegar; a atualização de 1 minuto mantém o detalhe aberto e não roda com a aba escondida.
- **Último acesso:** "ontem 10:22" quando foi no dia anterior (o modelo mostrava "qui 12/11 10:22" numa sexta).

## Validação (15/11/2026)

- `npm run validate:migrations` (PostgreSQL isolado, PGlite) passou a exercitar a 0051: sessão nova depois de 30 min, segunda aba limitada ao relógio, teto do primeiro registro, dia de Brasília perto da meia-noite, `access_report`, guarda de 13 meses, função negada a `authenticated` e liberada a `service_role`.
- Testes: `tests/access-usage.test.ts` (endereço, aparelho, período, formatos, cartões, frase, tabela, módulos, obras, uso por dia, filtros, detalhe, leitura compacta, URL e o estado sem a 0051), `tests/access-tracker.test.ts` (19 casos: tempo ativo, corte em 5 min, aba escondida, salto de timer, teto, troca de tela, obra do campo) e `tests/access-csv.test.ts` (7 casos da planilha). `tests/delete-work.test.ts` passou a semear `access_usage` e confere que o uso fica depois da exclusão da obra, como o custo da IA.
- Prévia da tela no navegador (Chromium, computador e celular), montada fora do Next com a rota simulada: 7 dias, 30 dias com filtro, intervalo de 60 dias (colunas por semana), estado sem a 0051, ordenação, URL, linha aberta pelo teclado, download do .csv e a atualização de 1 minuto. Sem erro no console nem rolagem lateral.
- Sequência do CI em 16/11/2026: typecheck, lint (sem erros; os avisos são os de antes), Prettier, 1.464 testes, migrações, build e e2e (10 de 10), todos verdes.
- **Não conferido:** a tela logada com dados reais e o registro em produção, que dependem da migração aplicada e da publicação.

## Pendências

- Aplicar a 0051 no `takt-hub` (pedido explícito do usuário) e publicar.
- Conferir logado: registro chegando (Configurações → Banco de dados mostra a 0051), aba com dados no dia seguinte, aviso some.
- Fora desta entrega, citadas no modelo: coluna "Último acesso" em Configurações → Usuários; PDF da aba; guardar no aparelho o tempo do campo sem sinal; dar à Claudia geral uma consulta aos dados de uso (hoje o manual diz que ela não lê esses números).

# Administrador vê todas as obras (24/11/2026)

**Situação:** a migração `0058_admin_all_works.sql` foi **aplicada no `takt-hub` em 24/11/2026**, a pedido do usuário, numa transação pelo pooler, com os perfis lidos antes e conferidos antes do commit: os 3 admins passaram de 9, 6 e 2 obras para as 10, os outros 37 perfis ficaram como estavam e os dois gatilhos existem. Código e testes enviados ao `main` no mesmo dia. Sem uso real logado.

## O pedido

Em 24/11/2026 um administrador não conseguia cadastrar a obra Bioma (código BIO). A consulta ao banco mostrou que a obra já existia: um gestor a cadastrou em 30/10/2026 e, como a obra nova só entrava no perfil de quem cadastrava, só ele a via. O cadastro era recusado com "Código de obra já utilizado.", porque a conferência do código olha todas as obras, e a lista de obras do administrador não a mostrava. O usuário então definiu a regra: **"todas as obras devem aparecer para os usuários admins"**.

## Comportamento

1. Quem tem o papel **Admin** vê todas as obras, em todas as telas e rotas (lista de obras, Dashboard geral, Claudia, configurações, modo de campo).
2. Obra nova, cadastrada por qualquer gestor ou admin, entra para todos os admins. Quem cadastrou segue recebendo a obra, como antes.
3. Quem passa a ser Admin recebe todas as obras na troca do papel.
4. Na grade de Configurações → Usuários, as células de obra do admin ficam marcadas em cinza, sem clique, como já eram as de módulo. Revogar obra de admin é recusado com "Administradores veem todas as obras. Para tirar uma obra, mude antes o papel da pessoa."; a revogação em lote pula os admins marcados.
5. Quem deixa de ser Admin mantém as obras que tinha naquele momento; daí em diante elas voltam a ser liberadas e revogadas uma a uma.
6. Consulta, TST, Planejador e Gestor não mudaram: só veem as obras liberadas para eles.

## Decisões

- **A regra é gravada no dado, não conferida em cada leitura.** O acesso por obra é lido de `profiles.work_ids` em mais de cem pontos (rotas, recorte do snapshot, telas, Claudia). Em vez de abrir uma exceção para o admin em cada um, o perfil do admin passa a conter sempre todas as obras, e nada que lê o acesso mudou.
- **Quem garante é o banco.** A migração 0058 cria dois gatilhos: `admin_profile_all_works` (antes de inserir ou alterar um perfil de papel `admin`, completa `work_ids` com as obras que faltam, mantendo a ordem que já havia) e `admin_profiles_receive_work` (depois de inserir uma obra, acrescenta-a aos perfis admin). Assim a regra vale por qualquer caminho de gravação: `commit_planning`, convite, primeiro login, scripts de importação e SQL direto. A última instrução da migração acerta os admins que já existem.
- **Exclusão de obra.** `delete_work` tira a obra dos perfis antes de apagar a linha de `works`; o gatilho deixa de fora a obra indicada em `obra360.deleting_work`, senão ela voltaria para a lista dos admins. A migração não reescreve `delete_work` nem `commit_planning`.
- **Os comandos repetem a regra** (`src/application/use-cases/commands.ts`, depois de cada comando), para o resultado gravado já sair certo e para o modo local e os testes, que não têm o gatilho. Vale para as obras carregadas no recorte do comando; o gatilho cobre o resto.

## O que mudou no código

- `supabase/migrations/0058_admin_all_works.sql`: os dois gatilhos e o acerto dos admins existentes. Pode ser rodada de novo.
- `src/application/use-cases/commands.ts`: depois de qualquer comando, todo admin carregado recebe as obras que faltam; `revoke_access` sobre admin é recusado.
- `src/application/module-access.ts` (`accessBatchChange`): a revogação de obras em lote não altera admin.
- `src/application/use-cases/local-apply.ts`: a projeção local de `set_role` para admin já mostra todas as obras.
- `src/modules/configuracoes/users-table.tsx`: célula de obra do admin marcada e travada.
- Manual da Claudia (`src/modules/agente/manual/acesso-configuracoes.ts`) e tour de Configurações (`src/modules/tour/pages/configuracoes.ts`) com a regra nova e a explicação do "Código de obra já utilizado.".

## Validação (24/11/2026)

- `tests/admin-all-works.test.ts`: os comandos (obra nova para todos os admins, promoção, recusa da revogação, lote, projeção local) e a migração num PostgreSQL em memória com todas as migrações (acerto dos admins existentes sem tocar nos demais, rodar duas vezes, obra nova, perfil novo, promoção, gravação que tira obra de admin, e a obra excluída por `delete_work` saindo dos admins).
- Banco de produção consultado só para leitura: 10 obras; a Bioma estava liberada apenas para quem a cadastrou; há 3 perfis admin, com 9, 6 e 2 obras.
- Migração aplicada no `takt-hub` com conferência dentro da transação (admins com todas as obras, não-admins sem mudança, mesma contagem de perfis) e os gatilhos lidos do catálogo depois do commit.
- **Não validado:** a tela logada (lista de obras e grade de usuários).

## Pendências

- Conferir logado: lista de obras de um admin com as 10 obras e a grade de usuários com as células travadas.

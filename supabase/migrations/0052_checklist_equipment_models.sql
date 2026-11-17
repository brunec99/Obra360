-- Aba 3.2, Checklist de equipamentos (16/11/2026): escolher, equipamento por equipamento, os checklists que
-- o QR mostra. Pedido da equipe de SST: "incluir e desativar os checklists que estão vinculados no QR code".
-- O equipamento continua recebendo sozinho os modelos ativos do tipo dele; estas duas listas guardam só a
-- exceção. `hidden_model_ids`: modelos do tipo que o admin tirou deste equipamento. `extra_model_ids`:
-- modelos de outro tipo que o admin incluiu nele. Vazias = o comportamento de antes (só o tipo).
-- Só acrescenta colunas: não reescreve commit_planning e pode ser rodada de novo. Sem ela a aba segue igual,
-- e só a gravação da escolha responde "aplique a migração 0052".
alter table checklist_equipment add column if not exists extra_model_ids text[] not null default '{}';
alter table checklist_equipment add column if not exists hidden_model_ids text[] not null default '{}';

notify pgrst, 'reload schema';

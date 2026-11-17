-- Aba 3.2, Checklist de equipamentos (17/11/2026): dois pedidos da equipe de SST.
--
-- 1. "Incluir opção de colocar o número do equipamento ou pavimento no checklist." O modelo passa a poder
--    pedir o local a quem preenche (`checklist_models.asks_location`), e a inspeção guarda o que foi escrito
--    (`checklist_runs.location`). Com local, o mesmo checklist é preenchido mais de uma vez no período, uma
--    por local ("Rede U, piso a piso": um por pavimento). Por isso a unicidade deixa de ser
--    (equipamento, modelo, dia) e passa a ser (equipamento, modelo, dia, local); sem local (''), vale o
--    mesmo de antes. A aplicação compara o local sem acento e sem maiúsculas antes de gravar.
--
-- 2. "Incluir opção de liberação de equipamento no campo de Periodicidade [...] que seja feito uma única
--    vez." A periodicidade ganha o valor 'once' (Liberação), no modelo e na inspeção.
--
-- Só acrescenta colunas e alarga duas regras: nenhuma linha existente muda (location = '' e
-- asks_location = false). Não reescreve commit_planning e pode ser rodada de novo. Sem ela a aba segue
-- igual, e só a gravação que usa o local ou a liberação responde "aplique a migração 0053".

alter table checklist_models add column if not exists asks_location boolean not null default false;
alter table checklist_runs add column if not exists location text not null default '';

alter table checklist_models drop constraint if exists checklist_models_frequency_check;
alter table checklist_models add constraint checklist_models_frequency_check
  check (frequency in ('daily', 'weekly', 'monthly', 'once'));
alter table checklist_runs drop constraint if exists checklist_runs_frequency_check;
alter table checklist_runs add constraint checklist_runs_frequency_check
  check (frequency in ('daily', 'weekly', 'monthly', 'once'));

-- A unicidade nova entra antes de a antiga sair: em nenhum momento a tabela fica sem a regra.
create unique index if not exists checklist_runs_spot_day_idx on checklist_runs (equipment_id, model_id, done_on, location);
alter table checklist_runs drop constraint if exists checklist_runs_equipment_id_model_id_done_on_key;

notify pgrst, 'reload schema';

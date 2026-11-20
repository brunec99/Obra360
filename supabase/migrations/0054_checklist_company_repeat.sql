-- Aba 3.2, Checklist de equipamentos (20/11/2026): dois pedidos da equipe de SST.
--
-- 1. "Incluir no checklist além do nome do colaborador o nome da empresa que o mesmo trabalha." A inspeção
--    guarda a empresa do operador (`checklist_runs.operator_company`), ao lado do nome. Pelo QR é
--    obrigatória; na tela logada, opcional.
--
-- 2. "Permitir o preenchimento duplicado do mesmo equipamento, pois acontece do equipamento ser usado por
--    mais de uma pessoa no dia." A unicidade (equipamento, modelo, dia, local) sai: o mesmo checklist aceita
--    mais de uma inspeção no dia. No lugar dela fica um índice comum, para as mesmas buscas. A liberação
--    (periodicidade 'once') segue única, pela regra da aplicação.
--
-- Só acrescenta uma coluna e afrouxa uma regra: nenhuma linha existente muda (operator_company = ''). Não
-- reescreve commit_planning e pode ser rodada de novo. Sem ela, o checklist pelo QR responde "ainda não está
-- disponível" (a empresa é obrigatória ali) e a segunda inspeção do dia é recusada.

alter table checklist_runs add column if not exists operator_company text not null default '';

create index if not exists checklist_runs_spot_idx on checklist_runs (equipment_id, model_id, done_on);
drop index if exists checklist_runs_spot_day_idx;
-- Banco que nunca recebeu a 0053 ainda tem a unicidade original da 0047.
alter table checklist_runs drop constraint if exists checklist_runs_equipment_id_model_id_done_on_key;

notify pgrst, 'reload schema';

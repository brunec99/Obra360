-- Ligação da obra com o empreendimento do Sienge (23/11/2026): o código do empreendimento de onde a
-- visão Custos da Linha de Balanço busca o orçamento ("Buscar do Sienge"). Fica em work_settings, fora
-- do snapshot, como a semana 1 e o local. Pode ser rodada de novo; não reescreve commit_planning. Sem
-- ela, a seção "Orçamento do Sienge" das Configurações da obra avisa e a busca fica indisponível.
alter table work_settings
  add column if not exists sienge_building_id integer check (sienge_building_id is null or sienge_building_id > 0);

-- A coluna nova só aparece na API depois que o PostgREST relê o esquema.
notify pgrst, 'reload schema';

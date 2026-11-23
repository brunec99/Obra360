-- Aba 1, calendário de dias úteis da Linha de Balanço, POR OBRA (23/11/2026, retorno de quem vem do
-- Prevision): os dias da semana trabalhados e os dias sem trabalho (feriados e recessos). Uma linha
-- por obra, gravada só quando alguém configura o calendário. Obra SEM linha usa o padrão, segunda a
-- sexta sem feriados, que era a regra fixa do sistema: aplicar esta migração não muda nenhuma data
-- de nenhuma obra. As durações dos blocos (lob_activities.duration_days) continuam em dias úteis e
-- não são convertidas.
--
-- Fica FORA do snapshot e do commit_planning, como as tabelas da 0038 e da 0044: a ausência desta
-- tabela derruba só a gravação do calendário (a leitura segue com o padrão). Não reescreve
-- commit_planning e pode ser rodada de novo.
--
-- Exclusão de obra: `on delete cascade` a partir de works, então o delete_work da 0037 (que apaga a
-- obra no fim) leva o calendário junto, sem reescrever aquela função.
create table if not exists lob_calendars (
  work_id text primary key references works(id) on delete cascade,
  -- Dias da semana trabalhados: 0 = domingo … 6 = sábado. Ao menos um.
  weekdays smallint[] not null default '{1,2,3,4,5}'::smallint[]
    check (cardinality(weekdays) between 1 and 7 and weekdays <@ '{0,1,2,3,4,5,6}'::smallint[]),
  -- Dias sem trabalho (feriados e recessos). O teto é o mesmo da aplicação.
  holidays date[] not null default '{}'::date[] check (cardinality(holidays) <= 1500),
  updated_by text not null,
  updated_at timestamptz not null default now()
);

-- Mesmo contrato das demais tabelas: RLS ligada sem política e acesso só pelo servidor. O grant é
-- explícito porque no projeto takt-hub a exposição automática de tabelas novas está desligada.
alter table lob_calendars enable row level security;
grant select, insert, update, delete on lob_calendars to service_role;

notify pgrst, 'reload schema';

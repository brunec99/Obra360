-- Acessos ao Obra 360 (15/11/2026, modelo aprovado "Aba Acessos no Dashboard geral", regra 18). O navegador conta o
-- tempo ativo em cada tela (aba visível e uso nos últimos 5 minutos, regra 4) e manda ao servidor a cada minuto
-- (`POST /api/acessos`); a aba "Acessos" do Dashboard geral, só para admin, lê daqui quem entrou, em quais módulos e
-- por quanto tempo.
--
-- Fica FORA do snapshot e do commit_planning, como a segurança (0040): não reescreve commit_planning e pode ser
-- rodada de novo. Sem ela o sistema segue normal: o registro falha em silêncio e a aba avisa que falta a 0051.
--
-- O que NÃO fica gravado (regra 8): IP, localização, nome do aparelho e o que foi digitado ou visto na tela.

-- Uma entrada no sistema (regra 5): abre quando a pessoa usa o sistema depois de 30 minutos sem uso. `seconds` é o
-- tempo ativo somado de todas as telas da sessão.
create table if not exists access_sessions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  started_at timestamptz not null,
  last_at timestamptz not null,
  seconds integer not null default 0 check (seconds >= 0)
);
create index if not exists access_sessions_profile_idx on access_sessions (profile_id, last_at desc);
create index if not exists access_sessions_last_idx on access_sessions (last_at);

-- O tempo ativo de uma sessão numa tela, num dia (Brasília), numa obra e num aparelho (regras 6 e 8). `work_id` sem
-- chave estrangeira de propósito: excluir a obra não apaga o histórico de uso (como o custo da IA), e a tela mostra
-- "Obra excluída". Telas fora das obras e o modo de campo sem `?obra=` gravam `work_id` nulo.
create table if not exists access_usage (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references access_sessions(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  day date not null,
  work_id text,
  screen text not null check (length(screen) between 1 and 40),
  field boolean not null default false,
  device text not null check (device in ('desktop', 'mobile')),
  seconds integer not null default 0 check (seconds >= 0),
  first_at timestamptz not null,
  last_at timestamptz not null
);
create unique index if not exists access_usage_key_idx
  on access_usage (session_id, day, coalesce(work_id, ''), screen, field, device);
create index if not exists access_usage_day_idx on access_usage (day);
create index if not exists access_usage_profile_idx on access_usage (profile_id, last_at desc);

-- Grava um minuto (ou o que o navegador acumulou) de uma pessoa numa tela. Chamada só pelo servidor, com a chave de
-- serviço, depois de conferir a sessão. Regras:
-- - Sessão nova quando a última da pessoa terminou há mais de 30 minutos (regra 5).
-- - Nunca soma mais que o relógio: o tempo de cada registro é limitado ao que passou desde o registro anterior da
--   mesma pessoa (+2 s de folga para a rede), o que cobre duas abas abertas ao mesmo tempo. O primeiro registro de
--   uma sessão vale no máximo 120 s, o que o navegador junta entre dois envios.
-- - As gravações da mesma pessoa entram em fila (trava por pessoa), para duas abas não abrirem duas sessões.
-- - Guarda de 13 meses (regra 15): o que passou disso sai aqui mesmo, pelo índice de `last_at`.
create or replace function record_access(
  p_profile uuid,
  p_work text,
  p_screen text,
  p_field boolean,
  p_device text,
  p_seconds integer,
  p_at timestamptz default now()
) returns void
language plpgsql
set search_path = public
as $$
declare
  v_day date := (p_at at time zone 'America/Sao_Paulo')::date;
  v_session access_sessions%rowtype;
  v_seconds integer := least(greatest(coalesce(p_seconds, 0), 0), 300);
begin
  if v_seconds = 0 then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtext('access_usage:' || p_profile::text));
  select * into v_session from access_sessions where profile_id = p_profile order by last_at desc limit 1;
  if not found or v_session.last_at < p_at - interval '30 minutes' then
    v_seconds := least(v_seconds, 120);
    insert into access_sessions (profile_id, started_at, last_at, seconds)
    values (p_profile, p_at - make_interval(secs => v_seconds), p_at, 0)
    returning * into v_session;
  else
    v_seconds := least(v_seconds, greatest(0, ceil(extract(epoch from (p_at - v_session.last_at)))::integer + 2));
  end if;
  insert into access_usage (session_id, profile_id, day, work_id, screen, field, device, seconds, first_at, last_at)
  values (v_session.id, p_profile, v_day, nullif(p_work, ''), p_screen, coalesce(p_field, false), p_device, v_seconds, p_at, p_at)
  on conflict (session_id, day, coalesce(work_id, ''), screen, field, device)
  do update set seconds = access_usage.seconds + excluded.seconds, last_at = greatest(access_usage.last_at, excluded.last_at);
  update access_sessions
  set last_at = greatest(last_at, p_at), seconds = seconds + v_seconds
  where id = v_session.id;
  delete from access_sessions where last_at < p_at - interval '13 months';
end;
$$;

-- A leitura da aba numa ida só (um valor jsonb, sem o limite de linhas da API): o uso do período, as sessões que
-- esse uso toca, o último registro de cada pessoa (de qualquer data, para "Último acesso") e o primeiro dia guardado
-- ("medindo desde"). Linhas como listas, para a resposta sair menor que objetos com nomes repetidos.
create or replace function access_report(p_from date, p_to date)
returns jsonb
language sql
stable
set search_path = public
as $$
  with u as (
    select * from access_usage where day between p_from and p_to and seconds > 0
  )
  select jsonb_build_object(
    'usage', coalesce((
      select jsonb_agg(jsonb_build_array(session_id, profile_id, day, work_id, screen, field, device, seconds, last_at))
      from u
    ), '[]'::jsonb),
    'sessions', coalesce((
      select jsonb_agg(jsonb_build_array(s.id, s.profile_id, s.started_at, s.last_at, s.seconds))
      from access_sessions s
      where s.id in (select session_id from u)
    ), '[]'::jsonb),
    'last', coalesce((
      select jsonb_agg(jsonb_build_array(l.profile_id, l.last_at, l.work_id, l.screen, l.field, l.device))
      from (
        select distinct on (profile_id) profile_id, last_at, work_id, screen, field, device
        from access_usage
        where seconds > 0
        order by profile_id, last_at desc
      ) l
    ), '[]'::jsonb),
    'since', (select min(day) from access_usage)
  );
$$;

-- Mesmo contrato das demais tabelas: RLS ligada sem política e acesso só pelo servidor. Grant explícito, porque no
-- takt-hub a exposição automática de tabelas novas está desligada; as funções saem do `public` (que as recebe por
-- padrão) e ficam só com a chave de serviço.
alter table access_sessions enable row level security;
alter table access_usage enable row level security;
grant select, insert, update, delete on access_sessions, access_usage to service_role;
revoke all on function record_access(uuid, text, text, boolean, text, integer, timestamptz) from public, anon, authenticated;
grant execute on function record_access(uuid, text, text, boolean, text, integer, timestamptz) to service_role;
revoke all on function access_report(date, date) from public, anon, authenticated;
grant execute on function access_report(date, date) to service_role;

comment on table access_sessions is 'Entradas no Obra 360 (0051): sessão nova depois de 30 min sem uso. Gravada só por record_access.';
comment on table access_usage is 'Tempo ativo por sessão, dia, obra, tela e aparelho (0051). Gravado só por record_access; guarda de 13 meses.';

notify pgrst, 'reload schema';

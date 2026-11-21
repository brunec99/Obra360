-- Entrada pelo Portal Inteligência da ATR (login único): o token do Portal vale UMA vez.
--
-- O token chega na barra de endereço (/portal-login?token=...), então pode sobrar no histórico. Sem esta
-- marca, quem o achasse dentro dos 5 minutos de validade entraria de novo. Mesmo desenho dos outros
-- sistemas da ATR (função `consumir_token_sso` do pacote padrão), com nome próprio, porque este projeto
-- do Supabase é dividido com o Takt Hub e outros sistemas: nada aqui pode colidir com o que é deles.
--
-- Guarda o SHA-256 da chave de uso único calculada pelo kit (emissor + app + id do token), nunca o token.
-- Sem policy DE PROPÓSITO: só o servidor do Obra 360 (chave de serviço) chama a função. RLS ligada +
-- nenhuma policy = negado para anon e authenticated.

create table if not exists public.obra360_sso_token_usado (
  token_hash text primary key,
  usado_em   timestamptz not null default now(),
  expira_em  timestamptz not null
);

comment on table public.obra360_sso_token_usado is
  'Obra 360: tokens do Portal Inteligência já trocados por sessão (SHA-256). Impede reuso dentro da '
  'validade. [rls-sem-policy-proposital] Quem escreve é public.obra360_consumir_token_sso, com service_role.';

alter table public.obra360_sso_token_usado enable row level security;
revoke all on table public.obra360_sso_token_usado from anon, authenticated;

create index if not exists obra360_sso_token_usado_expira on public.obra360_sso_token_usado (expira_em);

-- TRUE na primeira vez, FALSE em qualquer repetição. A atomicidade vem do `on conflict do nothing` na
-- chave primária: duas chamadas simultâneas com o mesmo token não recebem TRUE as duas.
create or replace function public.obra360_consumir_token_sso(p_token_hash text, p_expira_em timestamptz)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_token_hash is null or pg_catalog.length(p_token_hash) = 0 then
    return false;
  end if;

  -- Limpeza oportunista: a janela é de 5 minutos, a tabela fica com algumas dezenas de linhas.
  delete from public.obra360_sso_token_usado where expira_em < pg_catalog.now() - interval '1 hour';

  insert into public.obra360_sso_token_usado (token_hash, expira_em)
  values (p_token_hash, p_expira_em)
  on conflict (token_hash) do nothing;

  return found;
end $$;

revoke all on function public.obra360_consumir_token_sso(text, timestamptz) from public;
revoke all on function public.obra360_consumir_token_sso(text, timestamptz) from anon, authenticated;
grant execute on function public.obra360_consumir_token_sso(text, timestamptz) to service_role;

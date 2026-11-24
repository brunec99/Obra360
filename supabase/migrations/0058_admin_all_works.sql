-- Administrador vê todas as obras (24/11/2026). Até aqui a obra liberada era por pessoa também para o
-- admin: quem cadastrava a obra era o único a enxergá-la, e outro admin que tentasse cadastrar a mesma
-- obra recebia "Código de obra já utilizado." sem vê-la na lista (caso da Bioma, BIO).
--
-- A regra fica no banco, em `profiles.work_ids`, porque todo o sistema lê o acesso dali (rotas, recorte
-- do snapshot, telas): o perfil de papel `admin` sempre contém todas as obras, por qualquer caminho de
-- gravação (commit_planning, convite, primeiro login, SQL). Pode ser rodada de novo; não reescreve
-- commit_planning nem delete_work.

-- 1. Perfil admin gravado (novo, promovido ou com work_ids alterado) recebe as obras que faltam. A ordem
--    que já estava é mantida. A obra em exclusão (`obra360.deleting_work`, posta por delete_work antes de
--    tirá-la dos perfis) fica de fora, senão voltaria para a lista com a linha de `works` ainda existindo.
create or replace function admin_profile_all_works() returns trigger language plpgsql as $$
begin
  if new.role = 'admin' then
    new.work_ids := coalesce(new.work_ids, '{}') || array(
      select w.id from works w
      where not (w.id = any(coalesce(new.work_ids, '{}')))
        and w.id is distinct from nullif(current_setting('obra360.deleting_work', true), '')
      order by w.created_at, w.id
    );
  end if;
  return new;
end $$;

drop trigger if exists admin_profile_all_works on profiles;
create trigger admin_profile_all_works
  before insert or update on profiles
  for each row execute function admin_profile_all_works();

-- 2. Obra nova entra no perfil de todos os administradores, não só no de quem cadastrou.
create or replace function admin_profiles_receive_work() returns trigger language plpgsql as $$
begin
  update profiles set work_ids = array_append(work_ids, new.id)
  where role = 'admin' and not (new.id = any(work_ids));
  return new;
end $$;

drop trigger if exists admin_profiles_receive_work on works;
create trigger admin_profiles_receive_work
  after insert on works
  for each row execute function admin_profiles_receive_work();

-- 3. Acerto dos administradores que já existem: a gravação passa pelo gatilho do item 1.
update profiles set work_ids = work_ids where role = 'admin';

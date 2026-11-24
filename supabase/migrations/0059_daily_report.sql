-- Diário de Obra (2.4), 24/11/2026: o diário do dia é preenchido no Obra 360 e enviado ao Sienge pela API
-- `construction-daily-report`, só quando a pessoa clica em "Enviar". Fica FORA do snapshot e do
-- commit_planning, como o histograma (0045) e a terminalidade (0028): a ausência destas tabelas derruba só
-- o módulo do diário. Não reescreve commit_planning e pode ser rodada de novo.

-- Um diário por obra e dia (a unicidade abaixo). A mão de obra NÃO fica aqui: é o histograma do dia
-- (`headcount_entries`), que o diário lê e grava. Jornada/clima (`shifts`), atividades, ocorrências e
-- equipamentos vão em jsonb porque só existem dentro do diário e são gravados sempre juntos, com a versão.
-- `version` sobe a cada gravação: a aplicação atualiza com `where version = <lida>` e recusa a gravação de
-- quem leu uma versão antiga. `status = 'sent'` trava o diário; `sienge_building_id` e `sienge_id` guardam
-- o empreendimento e o número do diário no Sienge na hora do envio (a ligação da obra pode mudar depois, e
-- a exclusão no Sienge precisa do par usado no envio). `last_error` é a última recusa do Sienge, já no
-- texto que a tela mostra. Excluir a obra leva os diários junto (delete_work apaga a linha de works).
create table if not exists daily_reports (
  id text primary key,
  work_id text not null references works(id) on delete cascade,
  report_date date not null,
  status text not null default 'draft' check (status in ('draft', 'sent')),
  shifts jsonb not null default '[]'::jsonb,
  rainfall numeric(6,2) check (rainfall is null or (rainfall >= 0 and rainfall < 9999.99)),
  notes text not null default '',
  tasks jsonb not null default '[]'::jsonb,
  events jsonb not null default '[]'::jsonb,
  equipments jsonb not null default '[]'::jsonb,
  sienge_building_id integer,
  sienge_id integer,
  sent_at timestamptz,
  sent_by text,
  last_error text not null default '',
  version integer not null default 1 check (version >= 1),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_by text not null,
  updated_at timestamptz not null default now(),
  unique (work_id, report_date)
);

-- Fotos no bucket privado `diario`: a imagem comprimida no navegador e uma miniatura, ambas JPEG, em
-- `<obra>/<diário>/<foto>.jpg` e `<foto>-thumb.jpg`. Apagar o diário apaga as linhas (os arquivos, a
-- aplicação remove). O local é o cadastro da obra (`lob_locals`); excluir o local só desliga a foto dele.
-- `sienge_status` acompanha o envio foto a foto: o diário é criado no Sienge primeiro e cada foto sobe
-- depois, como anexo, então uma foto pode falhar sozinha (`error`, com a mensagem) e ser reenviada.
create table if not exists daily_report_photos (
  id text primary key,
  report_id text not null references daily_reports(id) on delete cascade,
  work_id text not null references works(id) on delete cascade,
  storage_path text not null,
  thumb_path text not null,
  description text not null default '',
  local_id text references lob_locals(id) on delete set null,
  show_in_reports boolean not null default true,
  sienge_status text not null default 'pending' check (sienge_status in ('pending', 'sent', 'error')),
  sienge_error text not null default '',
  created_by text not null,
  created_at timestamptz not null default now()
);
create index if not exists daily_report_photos_report_idx on daily_report_photos (report_id);

-- Ligação empresa do histograma → tipo de equipe do Sienge. É GLOBAL (sem obra): a mesma empreiteira
-- trabalha em várias obras e o tipo de equipe do Sienge é um cadastro da empresa inteira. A chave é o
-- nome normalizado da empresa (`headcountKey`: sem acento, minúsculo), para "GGP " e "ggp" serem a mesma
-- linha; `company` guarda a grafia para mostrar.
create table if not exists sienge_crew_links (
  company_key text primary key check (length(trim(company_key)) > 0),
  company text not null,
  crew_type_id integer not null check (crew_type_id > 0),
  updated_by text not null,
  updated_at timestamptz not null default now()
);

-- Local da obra → código do local no Sienge (sem ele a foto não entra no Relatório Fotográfico de lá).
-- A coluna entra em `lob_locals` porque o cadastro de locais é um só para a obra inteira.
alter table lob_locals add column if not exists sienge_site_id integer check (sienge_site_id is null or sienge_site_id > 0);

-- Código de usuário do Sienge de cada pessoa: vai como responsável do diário. Vazio = ainda não informou.
alter table profiles add column if not exists sienge_user_code text not null default '';

-- Mesmo contrato das demais tabelas: RLS ligada sem política (navegador não lê nada) e acesso só pelo
-- servidor. Grant explícito, porque no takt-hub a exposição automática de tabelas novas está desligada.
alter table daily_reports enable row level security;
alter table daily_report_photos enable row level security;
alter table sienge_crew_links enable row level security;
grant select, insert, update, delete on daily_reports, daily_report_photos, sienge_crew_links to service_role;

-- Bucket privado das fotos do diário, com os mesmos limites da terminalidade (JPEG até 2 MB): o próprio
-- Storage recusa o resto, porque a URL assinada de envio aceitaria qualquer arquivo. O bloco só age onde
-- as colunas de limite existem (o Supabase real), para a validação local em PGlite seguir rodando.
insert into storage.buckets (id, name, public) values ('diario', 'diario', false) on conflict (id) do nothing;
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'storage' and table_name = 'buckets' and column_name = 'allowed_mime_types') then
    execute $q$update storage.buckets set file_size_limit = 2097152, allowed_mime_types = array['image/jpeg'] where id = 'diario'$q$;
  end if;
end $$;

notify pgrst, 'reload schema';

-- Nuflow · Segurança: usuários e permissões, histórico de alterações e backups
-- Rodar UMA vez no Supabase: SQL Editor > New query > colar tudo > Run.
-- Pode rodar de novo sem problema (não apaga nada).

-- 1) Usuários do painel e papel de cada um
--    admin  = vê tudo (DRE, Financeiro, Análise, Administração)
--    equipe = cadastra bikes, registra vendas, mexe no estoque e na captação
--    Quem NÃO estiver na lista é tratado como admin (assim ninguém fica trancado do lado de fora).
create table if not exists painel_usuarios (
  email text primary key,
  nome text,
  papel text not null default 'equipe' check (papel in ('admin', 'equipe')),
  criado_em timestamptz default now()
);

create or replace function painel_eh_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (
    select 1 from painel_usuarios
     where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
       and papel = 'equipe'
  );
$$;

alter table painel_usuarios enable row level security;
drop policy if exists painel_usuarios_ler on painel_usuarios;
create policy painel_usuarios_ler on painel_usuarios for select to authenticated using (true);
drop policy if exists painel_usuarios_admin on painel_usuarios;
create policy painel_usuarios_admin on painel_usuarios for all to authenticated
  using (painel_eh_admin()) with check (painel_eh_admin());

-- 2) Histórico de alterações (quem mudou o quê e quando). Ninguém edita nem apaga o histórico.
create table if not exists auditoria (
  id bigserial primary key,
  quando timestamptz not null default now(),
  usuario text default (auth.jwt() ->> 'email'),
  acao text not null,          -- criou / alterou / excluiu
  base text,                   -- firebase / supabase
  colecao text,                -- bikes, financeiro, clientes, submissoes...
  registro_id text,
  resumo text,
  antes jsonb,
  depois jsonb
);
create index if not exists auditoria_quando_idx on auditoria (quando desc);
alter table auditoria enable row level security;
drop policy if exists auditoria_gravar on auditoria;
create policy auditoria_gravar on auditoria for insert to authenticated with check (true);
drop policy if exists auditoria_ler on auditoria;
create policy auditoria_ler on auditoria for select to authenticated using (painel_eh_admin());

-- 3) Backups: pasta privada no armazenamento, só administradores leem
insert into storage.buckets (id, name, public)
values ('backups', 'backups', false)
on conflict (id) do nothing;

drop policy if exists backups_gravar on storage.objects;
create policy backups_gravar on storage.objects for insert to authenticated
  with check (bucket_id = 'backups' and painel_eh_admin());
drop policy if exists backups_ler on storage.objects;
create policy backups_ler on storage.objects for select to authenticated
  using (bucket_id = 'backups' and painel_eh_admin());

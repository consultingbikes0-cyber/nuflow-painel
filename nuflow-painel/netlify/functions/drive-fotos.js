-- Nuflow · Importação da planilha da Sense
-- Rodar UMA vez no Supabase: SQL Editor > New query > colar tudo > Run.
-- Pode rodar de novo sem problema (não apaga nada).

-- 1) Novas colunas nos envios
alter table submissoes
  add column if not exists origem text default 'formulario',   -- 'formulario' ou 'sense'
  add column if not exists codigo_externo text,                -- código da Sense (COD.2)
  add column if not exists fotos_link text,                    -- link da pasta de fotos no Google Drive
  add column if not exists cor text,                           -- cor por extenso (ex.: Azul/Cinza)
  add column if not exists condicao_origem text;               -- NOVA ou USADA (como vem na planilha)

-- Evita importar o mesmo código da Sense duas vezes
create unique index if not exists submissoes_origem_codigo
  on submissoes (origem, codigo_externo);

-- 2) Catálogo de fichas técnicas por modelo (preenche uma vez, todas as bikes do modelo reusam)
create table if not exists catalogo_modelos (
  chave text primary key,            -- marca|modelo|ano, em minúsculas
  marca text,
  modelo text,
  ano text,
  tipo text,
  suspensao text,
  shock text,
  freios text,
  relacao text,
  rodas text,
  outros_componentes text,
  atualizado_em timestamptz default now()
);

alter table catalogo_modelos enable row level security;

drop policy if exists catalogo_painel on catalogo_modelos;
create policy catalogo_painel on catalogo_modelos
  for all to authenticated using (true) with check (true);

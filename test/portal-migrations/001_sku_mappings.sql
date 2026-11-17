-- SKU mapping: each B2B organization (tenant = VTEX customerId) maps its own
-- part codes (owner_sku) to VTEX SKUs (vtex_sku). See docs/SKU-MAPPING.md.

create table sku_mappings (
  tenant_id  uuid not null,                 -- customerId from the VTEX token
  owner_sku  text collate "C" not null,     -- byte order: prefix ranges use the index
  vtex_sku   text collate "C" not null,
  import_id  bigint not null,               -- last import that touched the row
  updated_at timestamptz not null default now(),
  primary key (tenant_id, owner_sku)
);
-- Reverse lookup and keyset paging by VTEX SKU (not unique, hence owner_sku).
create index sku_mappings_vtex_idx on sku_mappings (tenant_id, vtex_sku, owner_sku);
-- Replace and re-mapping leave dead rows; vacuum this table sooner than the default.
alter table sku_mappings set (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.02
);

create table sku_mapping_imports (
  id            bigint generated always as identity primary key,
  tenant_id     uuid not null,
  user_id       text not null,
  file_name     text not null check (char_length(file_name) between 1 and 255),
  mode          text not null check (mode in ('merge', 'replace')),
  status        text not null check (status in ('running', 'sweeping', 'completed', 'failed')),
  rows_received int not null default 0,
  rows_inserted int not null default 0,
  rows_updated  int not null default 0,
  rows_rejected int not null default 0,
  rows_deleted  int not null default 0,
  sweep_cursor  text collate "C",            -- last owner_sku swept by Replace
  started_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(), -- heartbeat: a stale import is released
  finished_at   timestamptz
);
-- At most one active import per organization, enforced by the database.
create unique index sku_mapping_imports_active_idx
  on sku_mapping_imports (tenant_id)
  where status in ('running', 'sweeping');
create index sku_mapping_imports_history_idx
  on sku_mapping_imports (tenant_id, started_at desc);

create table sku_mapping_stats (            -- total kept incrementally, never count(*)
  tenant_id  uuid primary key,
  total      bigint not null default 0 check (total >= 0),
  updated_at timestamptz not null default now()
);

-- Supabase exposes the public schema through its Data API. The portal reaches
-- these tables only from the server, as the owner role (which bypasses RLS);
-- with RLS on and no policy, the anon and authenticated roles see nothing.
alter table sku_mappings enable row level security;
alter table sku_mapping_imports enable row level security;
alter table sku_mapping_stats enable row level security;

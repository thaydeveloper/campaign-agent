-- SKU Mapping in the VTEX Admin (app demoindsupply.sku-mapping).
--
-- The Admin app reaches this database only through the Supabase Data API
-- (PostgREST), which cannot keep a transaction open across requests. Each
-- step of an import is therefore one function that runs in its own
-- transaction, with the same rules as src/server/sku-mapping.ts: one import
-- at a time per organization, a stale import released after 15 minutes,
-- chunks that can be sent again safely and the total kept in the same
-- transaction as each chunk.
--
-- The app calls these functions as sku_mapping_writer, a role that can run
-- them and nothing else: it has no grant on any table. The functions run as
-- their owner (security definer) with a fixed search_path.
--
-- Expected failures raise SQLSTATE P0001 with a code as the message, which
-- the app translates: INVALID_INPUT, INVALID_ROWS, IMPORT_RUNNING and
-- IMPORT_NOT_RUNNING.

do $$
begin
  if not exists (select from pg_roles where rolname = 'sku_mapping_writer') then
    create role sku_mapping_writer nologin;
  end if;
  execute format('grant usage on schema %I to sku_mapping_writer', current_schema());
end
$$;

-- Opens an import for an organization. Fails with IMPORT_RUNNING while
-- another one is active (portal or Admin: the unique index of migration 001
-- holds for both). An import without a chunk for 15 minutes is released first.
create function sku_mapping_admin_start(p_tenant uuid, p_user_id text, p_file_name text)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_import_id bigint;
begin
  if p_tenant is null
     or coalesce(char_length(btrim(p_user_id)), 0) not between 1 and 255
     or coalesce(char_length(btrim(p_file_name)), 0) not between 1 and 255 then
    raise exception 'INVALID_INPUT' using errcode = 'P0001';
  end if;

  update sku_mapping_imports
  set status = 'failed', finished_at = now()
  where tenant_id = p_tenant
    and status in ('running', 'sweeping')
    and last_seen_at < now() - interval '15 minutes';

  begin
    insert into sku_mapping_imports (tenant_id, user_id, file_name, mode, status)
    values (p_tenant, btrim(p_user_id), btrim(p_file_name), 'merge', 'running')
    returning id into v_import_id;
  exception when unique_violation then
    raise exception 'IMPORT_RUNNING' using errcode = 'P0001';
  end;

  return jsonb_build_object('importId', v_import_id);
end
$$;

-- Saves one chunk: up to 5,000 [owner_sku, vtex_sku] pairs. Codes repeated
-- in the chunk keep the last pair. Unchanged rows are not written, so sending
-- a chunk again changes nothing. Only the user who opened the import, in the
-- same organization, can add to it.
create function sku_mapping_admin_chunk(
  p_tenant uuid,
  p_user_id text,
  p_import_id bigint,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
as $$
declare
  sku_pattern constant text := '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$';
  v_received int;
  v_distinct int;
  v_written int;
  v_inserted int;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'INVALID_ROWS' using errcode = 'P0001';
  end if;
  v_received := jsonb_array_length(p_rows);
  if v_received not between 1 and 5000 then
    raise exception 'INVALID_ROWS' using errcode = 'P0001';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_rows) as entry(pair)
    where case
      when jsonb_typeof(pair) <> 'array' then true
      when jsonb_array_length(pair) <> 2 then true
      when jsonb_typeof(pair -> 0) <> 'string' or jsonb_typeof(pair -> 1) <> 'string' then true
      else (pair ->> 0) !~ sku_pattern or (pair ->> 1) !~ sku_pattern
    end
  ) then
    raise exception 'INVALID_ROWS' using errcode = 'P0001';
  end if;

  perform 1
  from sku_mapping_imports
  where id = p_import_id
    and tenant_id = p_tenant
    and user_id = p_user_id
    and status = 'running'
  for update;
  if not found then
    raise exception 'IMPORT_NOT_RUNNING' using errcode = 'P0001';
  end if;

  with incoming as (
    select distinct on (pair ->> 0) pair ->> 0 as owner, pair ->> 1 as vtex
    from jsonb_array_elements(p_rows) with ordinality as entry(pair, position)
    order by pair ->> 0, position desc
  ),
  written as (
    insert into sku_mappings (tenant_id, owner_sku, vtex_sku, import_id)
    select p_tenant, owner, vtex, p_import_id from incoming
    on conflict (tenant_id, owner_sku) do update
      set vtex_sku = excluded.vtex_sku, import_id = excluded.import_id, updated_at = now()
      where sku_mappings.vtex_sku is distinct from excluded.vtex_sku
    returning (xmax = 0) as is_new
  )
  select (select count(*) from incoming), count(*), count(*) filter (where is_new)
  into v_distinct, v_written, v_inserted
  from written;

  if v_inserted > 0 then
    insert into sku_mapping_stats (tenant_id, total) values (p_tenant, v_inserted)
    on conflict (tenant_id) do update
      set total = sku_mapping_stats.total + excluded.total, updated_at = now();
  end if;

  update sku_mapping_imports
  set rows_received = rows_received + v_received,
      rows_inserted = rows_inserted + v_inserted,
      rows_updated = rows_updated + (v_written - v_inserted),
      last_seen_at = now()
  where id = p_import_id;

  return jsonb_build_object(
    'inserted', v_inserted,
    'updated', v_written - v_inserted,
    'unchanged', v_distinct - v_written
  );
end
$$;

-- Closes an import. The app reports the rows its own validation refused.
create function sku_mapping_admin_finish(
  p_tenant uuid,
  p_user_id text,
  p_import_id bigint,
  p_rejected_rows int
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_inserted int;
  v_updated int;
begin
  if p_rejected_rows is null or p_rejected_rows not between 0 and 100000000 then
    raise exception 'INVALID_INPUT' using errcode = 'P0001';
  end if;

  update sku_mapping_imports
  set status = 'completed', rows_rejected = p_rejected_rows,
      finished_at = now(), last_seen_at = now()
  where id = p_import_id
    and tenant_id = p_tenant
    and user_id = p_user_id
    and status = 'running'
  returning rows_inserted, rows_updated into v_inserted, v_updated;
  if not found then
    raise exception 'IMPORT_NOT_RUNNING' using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'inserted', v_inserted,
    'updated', v_updated,
    'total', coalesce((select total from sku_mapping_stats where tenant_id = p_tenant), 0)
  );
end
$$;

-- Stops an import of this user. Rows already sent stay saved.
create function sku_mapping_admin_cancel(p_tenant uuid, p_user_id text, p_import_id bigint)
returns jsonb
language plpgsql
security definer
as $$
begin
  update sku_mapping_imports
  set status = 'failed', finished_at = now()
  where id = p_import_id
    and tenant_id = p_tenant
    and user_id = p_user_id
    and status in ('running', 'sweeping');
  return jsonb_build_object('cancelled', found);
end
$$;

-- Total, last finished import and the import still sending chunks (stale
-- ones left out). `mine` tells whether p_user_id opened it.
create function sku_mapping_admin_overview(p_tenant uuid, p_user_id text)
returns jsonb
language sql
stable
security definer
as $$
  with recent as (
    select status, started_at,
           last_seen_at < now() - interval '15 minutes' as stale,
           jsonb_build_object(
             'id', id,
             'fileName', file_name,
             'status', status,
             'inserted', rows_inserted,
             'updated', rows_updated,
             'rejected', rows_rejected,
             'startedAt', started_at,
             'finishedAt', finished_at,
             'mine', user_id = p_user_id
           ) as summary
    from sku_mapping_imports
    where tenant_id = p_tenant
    order by started_at desc
    limit 5
  )
  select jsonb_build_object(
    'total', coalesce((select total from sku_mapping_stats where tenant_id = p_tenant), 0),
    'lastImport', (
      select summary from recent
      where status in ('completed', 'failed')
      order by started_at desc limit 1
    ),
    'activeImport', (
      select summary from recent
      where status in ('running', 'sweeping') and not stale
      order by started_at desc limit 1
    )
  )
$$;

-- One page of 50 mappings, optionally limited to codes starting with
-- p_query whatever their case. Ordered by the code in lower case, then by the
-- code itself (index of migration 004). Keyset paging: p_after and p_before
-- are owner_sku cursors, so every page costs the same whatever the table size.
create function sku_mapping_admin_page(
  p_tenant uuid,
  p_query text default '',
  p_after text default null,
  p_before text default null
)
returns jsonb
language plpgsql
stable
security definer
as $$
declare
  page_size constant int := 50;
  sku_pattern constant text := '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$';
  v_prefix text := lower(btrim(coalesce(p_query, '')));
  v_after text := case when p_after ~ sku_pattern then p_after end;
  v_before text := case when v_after is null and p_before ~ sku_pattern then p_before end;
  v_backwards boolean := v_before is not null;
  v_query text := 'select owner_sku, vtex_sku, updated_at from sku_mappings where tenant_id = $1';
  v_rows jsonb;
  v_count int;
  v_more boolean;
  v_first text;
  v_last text;
begin
  if v_prefix <> '' and v_prefix !~ '^[a-z0-9._-]{1,80}$' then
    return jsonb_build_object('rows', '[]'::jsonb, 'next', null, 'previous', null);
  end if;

  -- Only the conditions in use, so each variant is a plain index range scan.
  if v_prefix <> '' then
    v_query := v_query || ' and lower(owner_sku) >= $2 and lower(owner_sku) < $2 || ''~''';
  end if;
  if v_after is not null then
    v_query := v_query || ' and (lower(owner_sku), owner_sku) > (lower($3), $3)';
  end if;
  if v_before is not null then
    v_query := v_query || ' and (lower(owner_sku), owner_sku) < (lower($4), $4)';
  end if;
  v_query := v_query
    || case when v_backwards
         then ' order by lower(owner_sku) desc, owner_sku desc'
         else ' order by lower(owner_sku), owner_sku' end
    || format(' limit %s', page_size + 1);

  execute format(
    'select count(*)::int, coalesce(jsonb_agg(jsonb_build_object('
      '''ownerSku'', owner_sku, ''vtexSku'', vtex_sku, ''updatedAt'', updated_at'
      ') order by lower(owner_sku), owner_sku), ''[]''::jsonb) from (%s) as page',
    v_query
  )
  into v_count, v_rows
  using p_tenant, v_prefix, v_after, v_before;

  -- The extra row only says there is more: drop it (the last one in the
  -- order it was read: the highest going forward, the lowest going back).
  v_more := v_count > page_size;
  if v_more then
    v_rows := v_rows - (case when v_backwards then 0 else -1 end);
  end if;
  v_first := v_rows -> 0 ->> 'ownerSku';
  v_last := v_rows -> -1 ->> 'ownerSku';

  return jsonb_build_object(
    'rows', v_rows,
    'previous', case
      when v_backwards then case when v_more then v_first end
      when v_after is not null then v_first
    end,
    'next', case
      when v_backwards then v_last
      when v_more then v_last
    end
  );
end
$$;

-- Fixed search_path, and only sku_mapping_writer may run the functions:
-- Postgres lets PUBLIC run new functions, and Supabase also grants them to
-- anon and authenticated by default.
do $$
declare
  fn text;
  api_role text;
begin
  foreach fn in array array[
    'sku_mapping_admin_start(uuid, text, text)',
    'sku_mapping_admin_chunk(uuid, text, bigint, jsonb)',
    'sku_mapping_admin_finish(uuid, text, bigint, int)',
    'sku_mapping_admin_cancel(uuid, text, bigint)',
    'sku_mapping_admin_overview(uuid, text)',
    'sku_mapping_admin_page(uuid, text, text, text)'
  ] loop
    execute format('alter function %s set search_path = %I, pg_temp', fn, current_schema());
    execute format('revoke all on function %s from public', fn);
    foreach api_role in array array['anon', 'authenticated'] loop
      if exists (select from pg_roles where rolname = api_role) then
        execute format('revoke all on function %s from %I', fn, api_role);
      end if;
    end loop;
    execute format('grant execute on function %s to sku_mapping_writer', fn);
  end loop;
end
$$;

-- Lets the Data API act as sku_mapping_writer with a token whose `role`
-- claim is sku_mapping_writer (npm run db:writer-token), as migration 003 does
-- for the reader. Kill switch: `revoke sku_mapping_writer from authenticator`
-- invalidates every writer token at once.
do $$ begin
  if exists (select from pg_roles where rolname = 'authenticator') then
    grant sku_mapping_writer to authenticator;
  end if;
end $$;

notify pgrst, 'reload schema';

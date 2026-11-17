-- Read-only access for other systems (the FastStore store) to look up mappings.
-- The role is created without login; `npm run db:reader` gives it a password
-- outside the repository. RLS is on, so the role also needs a select policy.

do $$
begin
  if not exists (select from pg_roles where rolname = 'sku_mapping_reader') then
    create role sku_mapping_reader nologin;
  end if;
  execute format('grant usage on schema %I to sku_mapping_reader', current_schema());
end
$$;

grant select on sku_mappings to sku_mapping_reader;

create policy sku_mapping_reader_select on sku_mappings
  for select to sku_mapping_reader
  using (true);

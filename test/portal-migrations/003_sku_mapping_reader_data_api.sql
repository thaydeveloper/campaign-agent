-- Lets the Supabase Data API (PostgREST) act as the read-only role, so the
-- FastStore store can read sku_mappings over HTTPS with a token whose `role`
-- claim is sku_mapping_reader (npm run db:reader-token). PostgREST connects as
-- `authenticator` and switches to the token's role, which it can only do for
-- roles it belongs to. Without `authenticator` (plain Postgres) this is a no-op.
--
-- Kill switch: `revoke sku_mapping_reader from authenticator` invalidates every
-- reader token at once; the direct connection (db:reader) is unaffected.
do $$ begin
  if exists (select from pg_roles where rolname = 'authenticator') then
    grant sku_mapping_reader to authenticator;
  end if;
end $$;

notify pgrst, 'reload schema';

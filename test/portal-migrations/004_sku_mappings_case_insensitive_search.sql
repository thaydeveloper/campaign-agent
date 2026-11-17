-- Case-insensitive search and listing order on the portal screen. Codes stay
-- case-sensitive keys (ABC-1 and abc-1 are two codes), but typing "abc" finds
-- both. Codes are ASCII, so lower() under collate "C" only folds A-Z and keeps
-- byte order, which the prefix range (`< prefix || '~'`) relies on.
create index sku_mappings_owner_ci_idx
  on sku_mappings (tenant_id, lower(owner_sku), owner_sku);

-- =============================================================================
-- 0301_outbound_source.sql
-- Outbound engine (docs/OUTBOUND-PLAN.md), Phase 1 step 2: what
-- outbound-source needs from the database.
--
--   1. A paging cursor per profile. DataForSEO's business listings search
--      pages with an offset_token that is only valid for the exact same
--      request, so the profile keeps the token AND a key of the request it
--      belongs to (source_cursor_key). When the audience changes, the key
--      changes and sourcing starts again from the top; dedupe (0300) drops
--      businesses already on file.
--   2. outbound_insert_leads(profile, rows): one insert for a whole page that
--      skips duplicates on ANY of 0300's three unique rules (listing, domain,
--      email) and skips suppressed domains, including existing clients'
--      sites. supabase-js upsert can only name one conflict target, which is
--      why this is SQL.
--
-- Scheduling (cron) comes with the enrich and verify functions; until then
-- outbound-source is called by hand. Service-role only, like 0300.
--
-- Test: scripts/test_outbound_source.sql. Idempotent / safe to re-apply.
-- =============================================================================

alter table outbound_profiles
  add column if not exists source_cursor_key   text,
  add column if not exists source_offset_token text,
  add column if not exists source_total_count  int,
  add column if not exists source_exhausted_at timestamptz,
  add column if not exists last_sourced_at     timestamptz;

comment on column outbound_profiles.source_cursor_key is
  'Key of the DataForSEO request source_offset_token belongs to. A different key means start over.';
comment on column outbound_profiles.source_exhausted_at is
  'Set when the last page came back short or without a token: nothing more to source for this audience.';


-- rows: a jsonb array of objects with outbound_leads column names
-- (source_ref, business_name, category, address, city, region, postal_code,
-- country_code, phone, website_url, rating, review_count, raw). Returns
-- {"received", "inserted", "duplicates", "suppressed", "invalid"}; invalid
-- rows lack a source_ref or a business name.
create or replace function outbound_insert_leads(p_profile_id uuid, p_rows jsonb, p_source text default 'dataforseo')
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_received   int;
  v_suppressed int := 0;
  v_inserted   int := 0;
  v_valid      int := 0;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'outbound_insert_leads: p_rows must be a json array';
  end if;
  v_received := jsonb_array_length(p_rows);

  with incoming as (
    select r.*
      from jsonb_to_recordset(p_rows) as r(
        source_ref text, business_name text, category text, address text, city text,
        region text, postal_code text, country_code text, phone text, website_url text,
        rating numeric, review_count int, raw jsonb)
     where nullif(btrim(r.source_ref), '') is not null
       and nullif(btrim(r.business_name), '') is not null
  ),
  allowed as (
    select * from incoming i
     where i.website_url is null
        or not outbound_is_suppressed(null, i.website_url)
  ),
  ins as (
    insert into outbound_leads (
      profile_id, source, source_ref, business_name, category, address, city, region,
      postal_code, country_code, phone, website_url, rating, review_count, raw)
    select p_profile_id, p_source, a.source_ref, a.business_name, a.category, a.address, a.city,
           a.region, a.postal_code, coalesce(nullif(a.country_code, ''), 'US'), a.phone, a.website_url,
           round(a.rating, 1), a.review_count, a.raw
      from allowed a
    on conflict do nothing
    returning 1
  )
  select (select count(*) from incoming),
         (select count(*) from incoming) - (select count(*) from allowed),
         (select count(*) from ins)
    into v_valid, v_suppressed, v_inserted;

  return jsonb_build_object(
    'received',   v_received,
    'inserted',   v_inserted,
    'suppressed', v_suppressed,
    'invalid',    v_received - v_valid,
    'duplicates', v_valid - v_inserted - v_suppressed
  );
end;
$$;

revoke all on function outbound_insert_leads(uuid, jsonb, text) from public, anon, authenticated;

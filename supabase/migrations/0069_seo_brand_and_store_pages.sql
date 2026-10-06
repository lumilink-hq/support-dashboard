-- =============================================================================
-- 0069_seo_brand_and_store_pages.sql
-- Module 21 follow-up (plan.md, Phase 6b): two settings the /seo Overview needs
-- to show what search EARNS a client rather than total traffic.
--
--   seo_client_settings.brand_terms — searches containing any of these (as
--     whole words) count as brand searches: people who already knew the name.
--     The site's own domain name ("packsclub") is always a brand term, so this
--     is only for the rest ("packs"). Set by LumiLink staff, like
--     value_per_click_cents; the table is already tenant read-only (0061).
--
--   seo_locations.store_page_url — the page on the client's site for this
--     location (for PACKS, the store's menu: https://www.packsclub.com/menu/
--     orange-county). The Overview counts Google clicks landing on it and every
--     page under it. Like search_console_site_url, nothing derives it; set by
--     LumiLink staff.
--
-- Matching is done in insights.ts (brandSplit / storeTraffic), not here, so the
-- portal and the monthly report count the same way.
--
-- Idempotent / safe to re-apply.
-- =============================================================================

alter table seo_client_settings
  add column if not exists brand_terms text[] not null default '{}';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'seo_client_settings_brand_terms_check') then
    alter table seo_client_settings
      add constraint seo_client_settings_brand_terms_check
      check (cardinality(brand_terms) <= 20);
  end if;
end;
$$;

alter table seo_locations
  add column if not exists store_page_url text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'seo_locations_store_page_url_check') then
    alter table seo_locations
      add constraint seo_locations_store_page_url_check
      check (store_page_url is null or length(btrim(store_page_url)) between 4 and 500);
  end if;
end;
$$;

-- SETUP AFTER APPLYING (per client, by LumiLink staff):
--   insert into seo_client_settings (client_id, brand_terms)
--     values ('<uuid>', array['packs'])
--     on conflict (client_id) do update set brand_terms = excluded.brand_terms;
--   update seo_locations set store_page_url = 'https://www.packsclub.com/menu/orange-county'
--     where id = '<location uuid>';

-- End of 0069.

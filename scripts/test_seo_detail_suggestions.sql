-- =============================================================================
-- test_seo_detail_suggestions.sql — non-destructive test of 0071 (module 30):
-- the suggestions table's limits and uniqueness, tenant isolation, status
-- changes only through decide_seo_detail_suggestions(), the crawl page-text
-- limits, and when a website is due for suggestions.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_seo_detail_suggestions.sql
--
-- To see it FAIL:
--   * drop both tenant guards from decide_seo_detail_suggestions ("and
--     s.client_id = v_client" and the "exists (... seo_locations ...)" clause;
--     either one alone still protects)
--     → "rpc: tenant A can't decide tenant B's suggestion" fails.
--   * drop "and s.status = 'open'" → "rpc: a dismissal isn't overturned" fails.
--   * grant update on seo_detail_suggestions to authenticated (plus a policy)
--     → "rls: a tenant can't edit suggestions directly" fails.
--   * drop the last_success_at clause from the targets view
--     → "targets: not due again until the next crawl" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_a      uuid;
  v_b      uuid;
  v_la     uuid;
  v_la2    uuid;
  v_lb     uuid;
  v_s1     uuid;
  v_s2     uuid;
  v_s3     uuid;
  v_sb     uuid;
  v_user   uuid;
  v_n      int;
  v_denied boolean;
begin
  insert into clients (name, slug, is_active) values ('Suggest A', 'suggest-a', true) returning id into v_a;
  insert into clients (name, slug, is_active) values ('Suggest B', 'suggest-b', true) returning id into v_b;
  insert into seo_locations (client_id, name, website_url, created_at) values (v_a, 'A1', 'https://a.example', now() - interval '2 days') returning id into v_la;
  insert into seo_locations (client_id, name, website_url, created_at) values (v_a, 'A2', 'https://a.example', now() - interval '1 day') returning id into v_la2;
  insert into seo_locations (client_id, name, website_url) values (v_b, 'B1', 'https://b.example') returning id into v_lb;

  -- ---------------------------------------------------------------------------
  -- Table guardrails
  -- ---------------------------------------------------------------------------
  insert into seo_detail_suggestions (client_id, location_id, field, value, quote, source_url, method)
  values (v_a, v_la, 'services', 'Pre-rolls', 'Shop pre-rolls', 'https://a.example/menu', 'model') returning id into v_s1;
  insert into seo_detail_suggestions (client_id, location_id, field, value, quote, source_url, method)
  values (v_a, v_la, 'licensed', 'true', 'License C10-0000123-LIC', 'https://a.example/menu', 'pattern') returning id into v_s2;
  insert into seo_detail_suggestions (client_id, location_id, field, value, quote, source_url, method)
  values (v_a, v_la2, 'services', 'Delivery', 'Same-day delivery', 'https://a.example/menu2', 'model') returning id into v_s3;
  insert into seo_detail_suggestions (client_id, location_id, field, value, quote, source_url, method)
  values (v_b, v_lb, 'services', 'Flower', 'Flower', 'https://b.example/', 'model') returning id into v_sb;

  begin
    insert into seo_detail_suggestions (client_id, location_id, field, value, quote, source_url, method)
    values (v_a, v_la, 'services', '  PRE-ROLLS ', 'x', 'u', 'model');
    v_denied := false;
  exception when unique_violation then v_denied := true;
  end;
  assert v_denied, 'table: one suggestion per location, field and value (case and spaces ignored)';

  insert into seo_detail_suggestions (client_id, location_id, field, value, quote, source_url, method)
  values (v_a, v_la2, 'services', 'Pre-rolls', 'Shop pre-rolls', 'u', 'model');
  assert true, 'table: the same value for another location is fine';

  begin
    insert into seo_detail_suggestions (client_id, location_id, field, value, quote, source_url, method)
    values (v_a, v_la, 'phone_number', '555', 'x', 'u', 'model');
    v_denied := false;
  exception when check_violation then v_denied := true;
  end;
  assert v_denied, 'table: only intake fields';

  begin
    insert into seo_detail_suggestions (client_id, location_id, field, value, quote, source_url, method)
    values (v_a, v_la, 'services', repeat('x', 121), 'x', 'u', 'model');
    v_denied := false;
  exception when check_violation then v_denied := true;
  end;
  assert v_denied, 'table: values are short';

  -- Crawl page text limits.
  insert into seo_crawl_runs (location_id, client_id, site_host, root_url, page_limit, phase, finished_at)
  values (v_la, v_a, 'a.example', 'https://a.example/', 100, 'done', now() - interval '1 hour');
  insert into seo_crawl_pages (location_id, client_id, run_id, url, status_code, page_text, json_ld)
  select v_la, v_a, run_id, 'https://a.example/', 200, 'hello', '[{"@type":"Store"}]' from seo_crawl_runs where location_id = v_la;
  begin
    update seo_crawl_pages set page_text = repeat('x', 20001) where location_id = v_la;
    v_denied := false;
  exception when check_violation then v_denied := true;
  end;
  assert v_denied, 'crawl: page text is capped at 20,000 characters';

  -- ---------------------------------------------------------------------------
  -- When a website is due
  -- ---------------------------------------------------------------------------
  assert (select is_due from seo_detail_suggestion_targets where location_id = v_la), 'targets: a finished crawl with no run yet is due';
  assert not exists (select 1 from seo_detail_suggestion_targets where location_id = v_la2), 'targets: only the website''s primary';
  assert not exists (select 1 from seo_detail_suggestion_targets where location_id = v_lb), 'targets: no finished crawl, not a target';

  insert into job_attempts (client_id, job_type, entity_id, status, next_run_at, last_success_at)
  values (v_a, 'seo_detail_suggestions', v_la, 'idle', now() - interval '1 minute', now() - interval '10 minutes');
  assert not (select is_due from seo_detail_suggestion_targets where location_id = v_la), 'targets: not due again until the next crawl';
  update seo_crawl_runs set finished_at = now() where location_id = v_la;
  assert (select is_due from seo_detail_suggestion_targets where location_id = v_la), 'targets: due after a newer crawl';
  update job_attempts set next_run_at = now() + interval '1 hour' where entity_id = v_la and job_type = 'seo_detail_suggestions';
  assert not (select is_due from seo_detail_suggestion_targets where location_id = v_la), 'targets: a backed-off job waits';
  update seo_crawl_runs set phase = 'pages' where location_id = v_la;
  assert not exists (select 1 from seo_detail_suggestion_targets where location_id = v_la), 'targets: an unfinished crawl is not a target';

  -- ---------------------------------------------------------------------------
  -- As tenant A
  -- ---------------------------------------------------------------------------
  v_user := gen_random_uuid();
  insert into auth.users (id, email) values (v_user, 'suggest-test@example.com');
  update users set client_id = v_a, role = 'admin' where id = v_user;
  perform set_config('request.jwt.claim.sub', v_user::text, true);
  set local role authenticated;

  select count(*) into v_n from seo_detail_suggestions;
  assert v_n = 4, format('rls: tenant A sees its own suggestions only (saw %s)', v_n);

  begin
    update seo_detail_suggestions set status = 'accepted' where id = v_s1;
    get diagnostics v_n = row_count;
    v_denied := v_n = 0;
  exception when others then v_denied := true;
  end;
  assert v_denied, 'rls: a tenant can''t edit suggestions directly';
  begin
    insert into seo_detail_suggestions (client_id, location_id, field, value, quote, source_url, method)
    values (v_a, v_la, 'awards', 'Made up', 'x', 'u', 'model');
    v_denied := false;
  exception when others then v_denied := true;
  end;
  assert v_denied, 'rls: a tenant can''t add suggestions';

  assert decide_seo_detail_suggestions(v_la, array[v_s1, v_s2], 'accepted') = 2, 'rpc: accept two';
  assert decide_seo_detail_suggestions(v_la, array[v_s1], 'dismissed') = 0, 'rpc: a decided one can''t be decided again';
  assert decide_seo_detail_suggestions(v_la, array[v_s3], 'dismissed') = 0, 'rpc: only suggestions of the location named';
  assert decide_seo_detail_suggestions(v_lb, array[v_sb], 'dismissed') = 0, 'rpc: tenant A can''t decide tenant B''s suggestion';
  assert decide_seo_detail_suggestions(v_la2, array[v_s3], 'dismissed') = 1, 'rpc: dismiss';
  begin
    perform decide_seo_detail_suggestions(v_la, array[v_s1], 'open');
    v_denied := false;
  exception when others then v_denied := true;
  end;
  assert v_denied, 'rpc: only accepted or dismissed';

  select count(*) into v_n from seo_detail_suggestions where status <> 'open' and decided_by = v_user and decided_at is not null;
  assert v_n = 3, 'rpc: who decided and when are recorded';
  assert (select status from seo_detail_suggestions where id = v_s3) = 'dismissed', 'rpc: a dismissal isn''t overturned';

  begin
    perform request_seo_detail_suggestions(v_la);
    v_denied := false;
  exception when insufficient_privilege then v_denied := true;
  end;
  assert v_denied, 'rls: a tenant can''t dispatch the job';

  reset role;
  assert (select status from seo_detail_suggestions where id = v_sb) = 'open', 'rpc: tenant B''s suggestion is untouched';
  raise notice 'test_seo_detail_suggestions: all assertions passed';
end;
$$;

rollback;

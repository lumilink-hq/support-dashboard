-- =============================================================================
-- test_seo_role_checks.sql — non-destructive test of 0084: on /seo a viewer
-- reads but can't change anything (tables or RPCs) and never sees the Google
-- access token; an agent can work /seo but can't connect or disconnect Google;
-- an admin can do both.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_seo_role_checks.sql
--
-- To see it FAIL: drop the policy seo_keywords_role_insert -> "viewer cannot
-- add a keyword" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

create temp table t (k text primary key, v uuid) on commit drop;
grant all on t to authenticated;

do $$
declare
  v_admin  uuid := gen_random_uuid();
  v_agent  uuid := gen_random_uuid();
  v_viewer uuid := gen_random_uuid();
  v_client uuid;
  v_loc    uuid;
  v_id     uuid;
begin
  insert into auth.users (id, email, raw_user_meta_data, last_sign_in_at)
  values (v_admin, 'admin@seoroles.example', '{"business_name":"SEO Roles Co"}', now());
  select client_id into v_client from users where id = v_admin;

  insert into client_invites (client_id, email, role) values
    (v_client, 'agent@seoroles.example', 'agent'),
    (v_client, 'viewer@seoroles.example', 'viewer');
  insert into auth.users (id, email, last_sign_in_at) values
    (v_agent, 'agent@seoroles.example', now()),
    (v_viewer, 'viewer@seoroles.example', now());

  insert into seo_locations (client_id, name, website_url)
  values (v_client, 'Main', 'https://seoroles.example.com') returning id into v_loc;
  insert into seo_keywords (client_id, location_id, keyword) values (v_client, v_loc, 'existing keyword');

  insert into seo_keyword_suggestions (client_id, keyword, source, search_volume)
  values (v_client, 'suggested keyword', 'related', 100) returning id into v_id;
  insert into t values ('suggestion', v_id);

  -- A connected Google account (no vault secret needed to read the cache).
  insert into google_oauth_tokens (client_id, access_token_cache, access_token_expires_at)
  values (v_client, 'ya29.test-token', now() + interval '1 hour');
  insert into google_oauth_connections (client_id, google_account_email, status)
  values (v_client, 'owner@seoroles.example', 'connected');

  insert into t values ('admin', v_admin), ('agent', v_agent), ('viewer', v_viewer), ('loc', v_loc);
end $$;

set local role authenticated;

-- ---------------------------------------------------------------------------
-- Viewer: reads, changes nothing, gets no token
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', (select v::text from t where k = 'viewer'), true);
do $$
declare
  v_n int;
begin
  assert (select count(*) from seo_keywords) = 1, 'viewer can read keywords';
  assert (select count(*) from seo_locations) = 1, 'viewer can read locations';

  begin
    insert into seo_keywords (client_id, location_id, keyword)
    values (current_client_id(), (select v from t where k = 'loc'), 'viewer keyword');
    raise exception 'viewer cannot add a keyword';
  exception when insufficient_privilege then null;
  end;

  update seo_keywords set is_active = false;
  get diagnostics v_n = row_count;
  assert v_n = 0, 'viewer cannot remove a keyword';

  update seo_locations set name = 'Hijacked';
  get diagnostics v_n = row_count;
  assert v_n = 0, 'viewer cannot edit a location';

  delete from seo_locations;
  get diagnostics v_n = row_count;
  assert v_n = 0, 'viewer cannot delete a location';

  assert not dismiss_seo_keyword_suggestion((select v from t where k = 'suggestion')), 'viewer cannot dismiss a suggestion';
  assert not dismiss_seo_competitor_gap('some keyword'), 'viewer cannot dismiss a gap';
  assert not dismiss_seo_link_opportunity('example.org'), 'viewer cannot dismiss a link';
  assert request_seo_run_now((select v from t where k = 'loc'), 'seo_crawl') = 'not_allowed', 'viewer cannot run now';
  assert link_seo_gbp_location('locations/1', null) = 'not_allowed', 'viewer cannot link a profile';
  -- 0085's propose_seo_gbp_categories was dropped in 0089 (no category edits).

  begin
    perform decide_seo_detail_suggestions((select v from t where k = 'loc'), '{}', 'dismissed');
    raise exception 'viewer decided detail suggestions';
  exception when insufficient_privilege then null;
  end;

  -- 0088: no tenant can read the Google token through PostgREST at all.
  assert to_regprocedure('public.get_my_google_access_token()') is null, 'token RPC is gone';
  begin
    perform access_token_cache from google_oauth_tokens;
    raise exception 'viewer read google_oauth_tokens';
  exception when insufficient_privilege then null;
  end;
  assert (disconnect_google_oauth())->>'error' = 'not_admin', 'viewer cannot disconnect Google';
  assert (store_google_oauth_tokens('r', 'a', now(), '{}', 'x@example.com'))->>'error' = 'not_admin',
    'viewer cannot store Google tokens';
end $$;

-- ---------------------------------------------------------------------------
-- Agent: works /seo, can't read the token (0088), can't connect/disconnect Google
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', (select v::text from t where k = 'agent'), true);
do $$
begin
  insert into seo_keywords (client_id, location_id, keyword)
  values (current_client_id(), (select v from t where k = 'loc'), 'agent keyword');
  assert (select count(*) from seo_keywords) = 2, 'agent can add a keyword';

  assert dismiss_seo_keyword_suggestion((select v from t where k = 'suggestion')), 'agent can dismiss a suggestion';
  assert request_seo_run_now((select v from t where k = 'loc'), 'seo_crawl') <> 'not_allowed', 'agent can run now';
  begin
    perform access_token_cache from google_oauth_tokens;
    raise exception 'agent read google_oauth_tokens';
  exception when insufficient_privilege then null;
  end;

  assert (disconnect_google_oauth())->>'error' = 'not_admin', 'agent cannot disconnect Google';
  assert exists (select 1 from google_oauth_connections), 'connection survives agent attempt';
end $$;

-- ---------------------------------------------------------------------------
-- Admin: can disconnect
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', (select v::text from t where k = 'admin'), true);
do $$
begin
  assert (disconnect_google_oauth())->>'ok' = 'true', 'admin can disconnect Google';
  assert not exists (select 1 from google_oauth_connections), 'admin disconnect removed the connection';
end $$;

reset role;

select 'test_seo_role_checks: all assertions passed' as result;

rollback;

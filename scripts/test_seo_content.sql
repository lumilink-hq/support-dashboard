-- =============================================================================
-- test_seo_content.sql — non-destructive test of 0056: the article ledger and
-- its uniqueness index, the trigger that retires a discarded article's topic,
-- the narrowed live-draft index, the gap view, service-only access (rule 4),
-- the per-client weekly scheduling gated on an active 'seo' entitlement, and
-- that a tenant can't edit an article while approving it.
-- Needs pg_net + pgvector; the Vault secrets are created here.
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/test_seo_content.sql
--
-- To see it FAIL:
--   * drop index uq_seo_content_posts_topic;
--     -> "ledger: a sibling location can't write about the same keyword" fails.
--   * drop trigger trg_retire_seo_content_post on seo_actions;
--     -> "retire: a rejected article frees its topic" fails.
--   * grant select on seo_content_posts to authenticated;
--     -> "rule 4: authenticated must not read seo_content_posts" fails.
--   * drop trigger trg_protect_seo_actions_tenant_columns on seo_actions;
--     -> "trigger: a tenant cannot edit the article while approving it" fails.
--   * recreate uq_seo_actions_live without `action_type = 'onpage_fix'`;
--     -> the insert of a second article draft for one location raises a
--     duplicate-key error (the "index: two article drafts..." assertion is never
--     reached, which is the failure).
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client_a uuid;
  v_client_b uuid;
  v_loc_a    uuid;
  v_loc_a2   uuid;
  v_loc_off  uuid;
  v_loc_nosite uuid;
  v_loc_b    uuid;
  v_kw1      uuid;
  v_kw2      uuid;
  v_kw3      uuid;
  v_comp1    uuid;
  v_comp2    uuid;
  v_act1     uuid;
  v_act2     uuid;
  v_act3     uuid;
  v_user_a   uuid;
  v_seen     int;
  v_denied   boolean;
  v_row      record;
  v_txt      text;
  v_vec      text := '[' || array_to_string(array(select 0.05 from generate_series(1, 384)), ',') || ']';
begin
  insert into clients (name, slug, is_active) values ('Content Test A', 'content-test-a', true) returning id into v_client_a;
  insert into clients (name, slug, is_active) values ('Content Test B', 'content-test-b', true) returning id into v_client_b;
  insert into seo_locations (client_id, name, website_url) values (v_client_a, 'Loc A',  'https://a.example.com') returning id into v_loc_a;
  insert into seo_locations (client_id, name, website_url) values (v_client_a, 'Loc A2', 'https://a2.example.com') returning id into v_loc_a2;
  insert into seo_locations (client_id, name, website_url, is_active) values (v_client_a, 'Loc Off', 'https://off.example.com', false) returning id into v_loc_off;
  insert into seo_locations (client_id, name) values (v_client_a, 'Loc NoSite') returning id into v_loc_nosite;
  insert into seo_locations (client_id, name, website_url) values (v_client_b, 'Loc B', 'https://b.example.com') returning id into v_loc_b;

  -- ---------------------------------------------------------------------------
  -- The ledger
  -- ---------------------------------------------------------------------------
  insert into seo_actions (client_id, location_id, action_type, target_field, proposed_value, status, idempotency_key)
  values (v_client_a, v_loc_a, 'content_publish', 'article', '{"kind":"article","title":"One"}', 'pending_approval', 'c-1') returning id into v_act1;
  insert into seo_actions (client_id, location_id, action_type, target_field, proposed_value, status, idempotency_key)
  values (v_client_a, v_loc_a2, 'content_publish', 'article', '{"kind":"article","title":"Two"}', 'pending_approval', 'c-2') returning id into v_act2;

  -- index: two article drafts for one location coexist (the narrowed live index)
  insert into seo_actions (client_id, location_id, action_type, target_field, proposed_value, status, idempotency_key)
  values (v_client_a, v_loc_a, 'content_publish', 'article', '{"kind":"article","title":"Three"}', 'pending_approval', 'c-3') returning id into v_act3;
  select count(*) into v_seen from seo_actions where location_id = v_loc_a and action_type = 'content_publish' and status = 'pending_approval';
  assert v_seen = 2, 'index: two article drafts for one location coexist';

  -- ...while on-page fixes still collide on (page, field).
  insert into seo_actions (client_id, location_id, action_type, target_field, target_url, proposed_value, status, idempotency_key)
  values (v_client_a, v_loc_a, 'onpage_fix', 'title_tag', 'https://a.example.com/x', '{"value":"T"}', 'pending_approval', 'op-1');
  begin
    insert into seo_actions (client_id, location_id, action_type, target_field, target_url, proposed_value, status, idempotency_key)
    values (v_client_a, v_loc_a, 'onpage_fix', 'title_tag', 'https://a.example.com/x', '{"value":"T2"}', 'pending_approval', 'op-2');
    v_denied := false;
  exception when unique_violation then v_denied := true; end;
  assert v_denied, 'index: on-page fixes are still one live draft per page and field';

  insert into seo_content_posts (client_id, location_id, action_id, topic_keyword, topic_key, title, body_text, topic_embedding, content_embedding)
  values (v_client_a, v_loc_a, v_act1, 'Drain  Cleaning Tulsa', 'drain cleaning tulsa', 'One', 'body one', v_vec::vector, v_vec::vector);

  begin
    insert into seo_content_posts (client_id, location_id, topic_keyword, topic_key, title, body_text)
    values (v_client_a, v_loc_a, 'x', 'NOT NORMALISED', 't', 'b');
    v_denied := false;
  exception when check_violation then v_denied := true; end;
  assert v_denied, 'ledger: topic_key must be the normalised keyword';

  begin
    insert into seo_content_posts (client_id, location_id, action_id, topic_keyword, topic_key, title, body_text)
    values (v_client_a, v_loc_a2, v_act2, 'drain cleaning tulsa', 'drain cleaning tulsa', 'Two', 'body two');
    v_denied := false;
  exception when unique_violation then v_denied := true; end;
  assert v_denied, 'ledger: a sibling location can''t write about the same keyword';

  -- A different client may use the same phrase.
  insert into seo_content_posts (client_id, location_id, topic_keyword, topic_key, title, body_text)
  values (v_client_b, v_loc_b, 'drain cleaning tulsa', 'drain cleaning tulsa', 'B one', 'body b');

  -- The stored vector round-trips at the right dimension.
  select vector_dims(topic_embedding) into v_seen from seo_content_posts where action_id = v_act1;
  assert v_seen = 384, 'ledger: embeddings are 384-dimensional (gte-small)';

  -- retire: pending doesn't retire; rejected / rolled_back / failed do.
  update seo_actions set status = 'approved' where id = v_act1;
  select state into v_txt from seo_content_posts where action_id = v_act1;
  assert v_txt = 'active', 'retire: an approved article stays active';

  update seo_actions set status = 'rejected' where id = v_act1;
  select state into v_txt from seo_content_posts where action_id = v_act1;
  assert v_txt = 'discarded', 'retire: a rejected article frees its topic';

  insert into seo_content_posts (client_id, location_id, action_id, topic_keyword, topic_key, title, body_text)
  values (v_client_a, v_loc_a2, v_act2, 'drain cleaning tulsa', 'drain cleaning tulsa', 'Two', 'body two');
  update seo_actions set status = 'rolled_back' where id = v_act2;
  select state into v_txt from seo_content_posts where action_id = v_act2;
  assert v_txt = 'discarded', 'retire: a rolled-back article frees its topic';

  insert into seo_content_posts (client_id, location_id, action_id, topic_keyword, topic_key, title, body_text)
  values (v_client_a, v_loc_a, v_act3, 'drain cleaning tulsa', 'drain cleaning tulsa', 'Three', 'body three');
  update seo_actions set status = 'failed' where id = v_act3;
  select state into v_txt from seo_content_posts where action_id = v_act3;
  assert v_txt = 'discarded', 'retire: a failed article frees its topic';

  -- deleting the action detaches the ledger row rather than deleting it
  insert into seo_actions (client_id, location_id, action_type, target_field, proposed_value, status, idempotency_key)
  values (v_client_a, v_loc_a, 'content_publish', 'article', '{"kind":"article"}', 'pending_approval', 'c-4') returning id into v_act1;
  insert into seo_content_posts (client_id, location_id, action_id, topic_keyword, topic_key, title, body_text)
  values (v_client_a, v_loc_a, v_act1, 'water heater flush', 'water heater flush', 'Four', 'body four');
  delete from seo_actions where id = v_act1;
  select action_id into v_row from seo_content_posts where topic_key = 'water heater flush';
  assert v_row.action_id is null, 'ledger: deleting the action leaves the ledger row with a null action_id';

  -- ---------------------------------------------------------------------------
  -- The gap view
  -- ---------------------------------------------------------------------------
  insert into seo_keywords (client_id, location_id, keyword) values (v_client_a, v_loc_a, 'kw one')   returning id into v_kw1;
  insert into seo_keywords (client_id, location_id, keyword) values (v_client_a, v_loc_a, 'kw two')   returning id into v_kw2;
  insert into seo_keywords (client_id, location_id, keyword) values (v_client_a, v_loc_a, 'kw three') returning id into v_kw3;
  insert into seo_keywords (client_id, location_id, keyword) values (v_client_a, v_loc_off, 'kw off');
  insert into seo_keywords (client_id, location_id, keyword) values (v_client_a, v_loc_nosite, 'kw nosite');

  -- kw one: an older rank (5) and a newer one (12); the newer one must win.
  insert into seo_rankings (client_id, location_id, keyword_id, rank_type, position, check_date) values
    (v_client_a, v_loc_a, v_kw1, 'organic', 5,  current_date - 14),
    (v_client_a, v_loc_a, v_kw1, 'organic', 12, current_date - 1),
    (v_client_a, v_loc_a, v_kw1, 'local_pack', 1, current_date - 1);   -- a local pack row must be ignored
  -- kw two: checked, not found.
  insert into seo_rankings (client_id, location_id, keyword_id, rank_type, position, check_date) values
    (v_client_a, v_loc_a, v_kw2, 'organic', null, current_date - 1);
  -- kw three: never checked.

  insert into seo_competitors (client_id, location_id, domain) values (v_client_a, v_loc_a, 'rival-one.com') returning id into v_comp1;
  insert into seo_competitors (client_id, location_id, domain) values (v_client_a, v_loc_a, 'rival-two.com') returning id into v_comp2;
  insert into seo_competitor_rankings (client_id, location_id, competitor_id, keyword_id, rank_type, position, check_date) values
    (v_client_a, v_loc_a, v_comp1, v_kw1, 'organic', 1,  current_date - 14),   -- stale: superseded by the newer check
    (v_client_a, v_loc_a, v_comp1, v_kw1, 'organic', 4,  current_date - 1),
    (v_client_a, v_loc_a, v_comp2, v_kw1, 'organic', 9,  current_date - 1),
    (v_client_a, v_loc_a, v_comp1, v_kw2, 'organic', null, current_date - 1);

  select * into v_row from seo_keyword_gaps where keyword_id = v_kw1;
  assert v_row.own_position = 12, format('gaps: uses the LATEST organic position, got %s', v_row.own_position);
  assert v_row.has_rank_data, 'gaps: has_rank_data is true once checked';
  assert v_row.best_competitor_position = 4, format('gaps: best competitor position is from the latest competitor check, got %s', v_row.best_competitor_position);
  assert v_row.competitors_ranking = 2, format('gaps: counts the competitors ranking on the latest check, got %s', v_row.competitors_ranking);

  select * into v_row from seo_keyword_gaps where keyword_id = v_kw2;
  assert v_row.own_position is null and v_row.has_rank_data, 'gaps: a checked keyword that was not found is null with has_rank_data';
  assert v_row.best_competitor_position is null and v_row.competitors_ranking = 0, 'gaps: competitors with no position count as not ranking';

  select * into v_row from seo_keyword_gaps where keyword_id = v_kw3;
  assert v_row.own_position is null and not v_row.has_rank_data, 'gaps: a never-checked keyword has no rank data';

  select count(*) into v_seen from seo_keyword_gaps where client_id = v_client_a;
  assert v_seen = 3, format('gaps: inactive and site-less locations are excluded, got %s rows', v_seen);

  -- ---------------------------------------------------------------------------
  -- Scheduling: weekly, per client, gated on an ACTIVE seo entitlement
  -- ---------------------------------------------------------------------------
  select count(*) into v_seen from seo_content_targets where client_id = v_client_a;
  assert v_seen = 0, 'targets: no entitlement means not a target';

  insert into entitlements (client_id, feature, status) values (v_client_a, 'seo', 'pending');
  select count(*) into v_seen from seo_content_targets where client_id = v_client_a;
  assert v_seen = 0, 'targets: a PENDING entitlement is not enough';

  update entitlements set status = 'active' where client_id = v_client_a and feature = 'seo';
  select count(*) into v_seen from seo_content_targets where client_id = v_client_a and is_due;
  assert v_seen = 1, 'targets: an active entitlement with a site and keywords is due';

  insert into entitlements (client_id, feature, status) values (v_client_b, 'seo', 'active');
  select count(*) into v_seen from seo_content_targets where client_id = v_client_b;
  assert v_seen = 0, 'targets: an entitled client with no keywords is not a target';

  assert request_seo_content(v_client_a) is null, 'dispatch: without the Vault secrets nothing is sent';
  assert (select last_error from job_attempts where client_id = v_client_a and job_type = 'seo_content' and entity_id is null) = 'missing_vault_secret',
    'dispatch: without the Vault secrets it settles as a failure instead of hanging';
  update job_attempts set next_run_at = now() where client_id = v_client_a and job_type = 'seo_content';

  perform vault.create_secret('https://example.supabase.co/functions/v1/seo-content', 'seo_content_url', '');
  perform vault.create_secret('unit-test-shared-secret', 'voice_tool_secret', '');

  assert request_seo_content(v_client_a) is not null, 'dispatch: succeeds once the secrets exist';
  assert request_seo_content(v_client_a) is null, 'dedup: a second dispatch while running is refused';
  perform complete_job_attempt(v_client_a, 'seo_content', true, null, 10080, 1440, null);
  select next_run_at into v_row from job_attempts where client_id = v_client_a and job_type = 'seo_content' and entity_id is null;
  assert v_row.next_run_at > now() + interval '6 days', 'dispatch: a successful run is next due in about a week';
  select count(*) into v_seen from seo_content_targets where client_id = v_client_a and is_due;
  assert v_seen = 0, 'targets: not due again for a week';

  -- ---------------------------------------------------------------------------
  -- As tenant A (authenticated, RLS in effect)
  -- ---------------------------------------------------------------------------
  insert into seo_actions (client_id, location_id, action_type, target_field, previous_value, proposed_value, diff, status, idempotency_key)
  values (v_client_a, v_loc_a, 'content_publish', 'article', '{"value":null}', '{"kind":"article","title":"Real title","body_html":"<p>Real body</p>"}', '{"field":"article","before":null,"after":"Real title"}', 'pending_approval', 'c-approve')
  returning id into v_act1;

  v_user_a := gen_random_uuid();
  insert into auth.users (id, email) values (v_user_a, 'seo-content-test@example.com');
  update users set client_id = v_client_a, role = 'admin' where id = v_user_a;
  perform set_config('request.jwt.claim.sub', v_user_a::text, true);
  set local role authenticated;

  begin perform 1 from seo_content_posts limit 1; v_denied := false;
  exception when insufficient_privilege then v_denied := true; end;
  assert v_denied, 'rule 4: authenticated must not read seo_content_posts';

  begin perform 1 from seo_keyword_gaps limit 1; v_denied := false;
  exception when insufficient_privilege then v_denied := true; end;
  assert v_denied, 'rule 4: authenticated must not read seo_keyword_gaps';

  begin perform 1 from seo_content_targets limit 1; v_denied := false;
  exception when insufficient_privilege then v_denied := true; end;
  assert v_denied, 'rule 4: authenticated must not read seo_content_targets';

  begin perform request_seo_content(v_client_a); v_denied := false;
  exception when insufficient_privilege then v_denied := true; end;
  assert v_denied, 'authenticated must not execute request_seo_content';

  -- The article's content is read-only to the tenant: it cannot be rewritten
  -- while approving it.
  begin
    update seo_actions
       set status = 'approved',
           proposed_value = '{"kind":"article","title":"Buy cheap watches","body_html":"<p>spam</p>"}'
     where id = v_act1;
    v_denied := false;
  exception when insufficient_privilege then v_denied := true; end;
  assert v_denied, 'trigger: a tenant cannot edit the article while approving it';

  update seo_actions set status = 'approved' where id = v_act1;
  reset role;
  select * into v_row from seo_actions where id = v_act1;
  assert v_row.status = 'approved' and v_row.approved_by = v_user_a, 'approve: the clean approval works and is attributed to the caller';
  assert v_row.proposed_value ->> 'title' = 'Real title', 'approve: the article text is untouched';

  raise notice 'ALL 0056 SEO CONTENT TESTS PASSED';
end;
$$;

rollback;

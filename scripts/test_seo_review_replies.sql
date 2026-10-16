-- =============================================================================
-- test_seo_review_replies.sql — 0090: review replies are OFF unless the client's
-- review_replies_enabled is on; a tenant can't switch it on; one reply action
-- per review, ever; existing drafting triggers still work.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_seo_review_replies.sql
--
-- To see it FAIL:
--   * drop "and s.review_replies_enabled" from seo_draft_targets' review branch
--     -> "off: an unanswered review alone doesn't make the store due" fails.
--   * grant update on seo_client_settings to authenticated;
--     create policy tmp on seo_client_settings for update using (true);
--     -> "a tenant can't switch replies on" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client uuid;
  v_loc    uuid;
  v_user   uuid;
  v_seen   int;
  v_denied boolean;
begin
  insert into clients (name, slug, is_active) values ('Replies', 'replies-test', true) returning id into v_client;
  insert into entitlements (client_id, feature, status) values (v_client, 'seo', 'active'); -- 0092: scheduled SEO work needs a paying client
  insert into seo_locations (client_id, name) values (v_client, 'Store') returning id into v_loc;
  insert into seo_gbp_locations (client_id, location_name, account_name, linked_location_id)
  values (v_client, 'locations/1', 'accounts/1', v_loc);
  insert into seo_gbp_reviews (client_id, location_name, review_id, location_id, star_rating, comment, created_at_google)
  values (v_client, 'locations/1', 'r1', v_loc, 5, 'Great', now() - interval '2 days');

  -- Off by default.
  select count(*) into v_seen from seo_draft_targets where location_id = v_loc;
  assert v_seen = 0, 'off: an unanswered review alone doesn''t make the store due';
  insert into seo_client_settings (client_id) values (v_client);
  select count(*) into v_seen from seo_client_settings where client_id = v_client and review_replies_enabled = false;
  assert v_seen = 1, 'off: the default is false';
  select count(*) into v_seen from seo_draft_targets where location_id = v_loc;
  assert v_seen = 0, 'off: a settings row without the switch doesn''t either';

  -- On.
  update seo_client_settings set review_replies_enabled = true where client_id = v_client;
  select count(*) into v_seen from seo_draft_targets where location_id = v_loc;
  assert v_seen = 1, 'on: an unanswered recent review makes the store due';

  -- Not for answered or old reviews.
  update seo_gbp_reviews set reply_comment = 'Thanks' where review_id = 'r1';
  select count(*) into v_seen from seo_draft_targets where location_id = v_loc;
  assert v_seen = 0, 'on: an answered review isn''t a reason';
  update seo_gbp_reviews set reply_comment = null, created_at_google = now() - interval '40 days' where review_id = 'r1';
  select count(*) into v_seen from seo_draft_targets where location_id = v_loc;
  assert v_seen = 0, 'on: a review older than 30 days isn''t a reason';
  update seo_gbp_reviews set created_at_google = now() - interval '2 days' where review_id = 'r1';

  -- One reply action per review, whatever happened to it.
  insert into seo_actions (client_id, location_id, action_type, target_field, idempotency_key, status, proposed_value)
  values (v_client, v_loc, 'review_reply', 'gbp_review_reply', 'review-reply:locations/1:r1', 'rejected', '{}');
  select count(*) into v_seen from seo_draft_targets where location_id = v_loc;
  assert v_seen = 0, 'once: a declined review isn''t asked about again';
  begin
    insert into seo_actions (client_id, location_id, action_type, target_field, idempotency_key, status, proposed_value)
    values (v_client, v_loc, 'review_reply', 'gbp_review_reply', 'review-reply:locations/1:r1', 'pending_approval', '{}');
    v_denied := false;
  exception when unique_violation then v_denied := true;
  end;
  assert v_denied, 'once: a second reply action for the same review is refused';

  -- Escalated is a real status.
  insert into seo_actions (client_id, location_id, action_type, target_field, idempotency_key, status, proposed_value)
  values (v_client, v_loc, 'review_reply', 'gbp_review_reply', 'review-reply:locations/1:r2', 'escalated', '{}');

  -- Page-fix drafting is unchanged.
  insert into seo_findings (client_id, location_id, module, finding_type, severity, title, target_url)
  values (v_client, v_loc, 'crawl', 'missing_title', 'warning', 'No title', 'https://x.example/');
  select count(*) into v_seen from seo_draft_targets where location_id = v_loc;
  assert v_seen = 1, 'crawl findings still schedule drafts';

  -- A tenant can read the switch but not flip it.
  v_user := gen_random_uuid();
  insert into auth.users (id, email) values (v_user, 'replies-test@example.com');
  update users set client_id = v_client, role = 'admin' where id = v_user;
  update seo_client_settings set review_replies_enabled = false where client_id = v_client;
  perform set_config('request.jwt.claim.sub', v_user::text, true);
  set local role authenticated;
  select count(*) into v_seen from seo_client_settings where client_id = v_client;
  assert v_seen = 1, 'a tenant can read its settings';
  begin
    update seo_client_settings set review_replies_enabled = true where client_id = v_client;
    get diagnostics v_seen = row_count;
    v_denied := v_seen = 0;
  exception when others then v_denied := true;
  end;
  assert v_denied, 'a tenant can''t switch replies on';
  reset role;

  raise notice 'test_seo_review_replies: all assertions passed';
end;
$$;

rollback;

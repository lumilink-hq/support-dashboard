-- =============================================================================
-- test_seo_gbp_posts.sql — 0091: Business Profile posts are OFF unless the
-- client's gbp_posts_enabled is on, need a linked profile, and come at most
-- once a week and only after the last one was dealt with.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_seo_gbp_posts.sql
--
-- To see it FAIL: drop "and s.gbp_posts_enabled" from the posts branch of
-- seo_draft_targets -> "off: a linked store isn't due for a post" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client uuid;
  v_loc    uuid;
  v_seen   int;
  v_user   uuid;
  v_denied boolean;
begin
  insert into clients (name, slug, is_active) values ('Posts', 'posts-test', true) returning id into v_client;
  insert into seo_locations (client_id, name) values (v_client, 'Store') returning id into v_loc;
  insert into seo_client_settings (client_id) values (v_client);

  select count(*) into v_seen from seo_draft_targets where location_id = v_loc;
  assert v_seen = 0, 'nothing to do yet';
  update seo_client_settings set gbp_posts_enabled = true where client_id = v_client;
  select count(*) into v_seen from seo_draft_targets where location_id = v_loc;
  assert v_seen = 0, 'on but no linked profile: not due';

  insert into seo_gbp_locations (client_id, location_name, account_name, linked_location_id)
  values (v_client, 'locations/1', 'accounts/1', v_loc);
  update seo_client_settings set gbp_posts_enabled = false where client_id = v_client;
  select count(*) into v_seen from seo_draft_targets where location_id = v_loc;
  assert v_seen = 0, 'off: a linked store isn''t due for a post';
  update seo_client_settings set gbp_posts_enabled = true where client_id = v_client;
  select count(*) into v_seen from seo_draft_targets where location_id = v_loc;
  assert v_seen = 1, 'on + linked: due';

  -- A waiting draft blocks the next, however old.
  insert into seo_actions (client_id, location_id, action_type, target_field, idempotency_key, status, proposed_value, created_at)
  values (v_client, v_loc, 'gbp_post', 'gbp_post', 'gbp-post:x:w1', 'pending_approval', '{}', now() - interval '20 days');
  select count(*) into v_seen from seo_draft_targets where location_id = v_loc;
  assert v_seen = 0, 'a post still waiting for approval blocks the next';

  -- Dealt with, but this week: still not due. Older than a week: due.
  update seo_actions set status = 'published', created_at = now() - interval '3 days' where idempotency_key = 'gbp-post:x:w1';
  select count(*) into v_seen from seo_draft_targets where location_id = v_loc;
  assert v_seen = 0, 'at most one a week';
  update seo_actions set created_at = now() - interval '8 days' where idempotency_key = 'gbp-post:x:w1';
  select count(*) into v_seen from seo_draft_targets where location_id = v_loc;
  assert v_seen = 1, 'due again after a week';

  -- One draft per store per week at the database too.
  insert into seo_actions (client_id, location_id, action_type, target_field, idempotency_key, status, proposed_value)
  values (v_client, v_loc, 'gbp_post', 'gbp_post', 'gbp-post:x:w2', 'pending_approval', '{}');
  begin
    insert into seo_actions (client_id, location_id, action_type, target_field, idempotency_key, status, proposed_value)
    values (v_client, v_loc, 'gbp_post', 'gbp_post', 'gbp-post:x:w2', 'pending_approval', '{}');
    v_denied := false;
  exception when unique_violation then v_denied := true;
  end;
  assert v_denied, 'the same week''s key twice is refused';

  -- A tenant can't switch posts on.
  v_user := gen_random_uuid();
  insert into auth.users (id, email) values (v_user, 'posts-test@example.com');
  update users set client_id = v_client, role = 'admin' where id = v_user;
  update seo_client_settings set gbp_posts_enabled = false where client_id = v_client;
  perform set_config('request.jwt.claim.sub', v_user::text, true);
  set local role authenticated;
  begin
    update seo_client_settings set gbp_posts_enabled = true where client_id = v_client;
    get diagnostics v_seen = row_count;
    v_denied := v_seen = 0;
  exception when others then v_denied := true;
  end;
  assert v_denied, 'a tenant can''t switch posts on';
  reset role;

  raise notice 'test_seo_gbp_posts: all assertions passed';
end;
$$;

rollback;

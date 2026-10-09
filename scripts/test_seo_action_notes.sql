-- =============================================================================
-- test_seo_action_notes.sql — non-destructive test of 0074: a tenant can
-- attach a note to a decision, only with the decision, and still can't edit
-- the draft itself; the service role (the dashboard's validated edit path) can.
--
-- Run:  docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_seo_action_notes.sql
--
-- To see it FAIL:
--   * remove " - 'decision_note'" from either side of the comparison in 0074's
--     trigger → "reject with a note" fails (the note reads as a draft edit).
--   * the "note without a decision" check in the trigger is belt and braces:
--     0042's WITH CHECK (status in approved/rejected) already refuses a
--     note-only update on a waiting draft, so removing just the trigger check
--     still passes "a note can't be added without a decision".
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_client uuid;
  v_loc    uuid;
  v_a      uuid;
  v_b      uuid;
  v_user   uuid := gen_random_uuid();
  v_denied boolean;
  v_note   text;
  v_status text;
begin
  insert into clients (name, slug, is_active) values ('Notes Test', 'notes-test', true) returning id into v_client;
  insert into seo_locations (client_id, name, website_url) values (v_client, 'N', 'https://notes.example.com') returning id into v_loc;
  insert into seo_actions (client_id, location_id, action_type, target_field, finding_type, target_url, proposed_value, diff, status, idempotency_key)
    values (v_client, v_loc, 'onpage_fix', 'title_tag', 'title_length', 'https://notes.example.com/',
            '{"value":"Notes Example: Drafted Title Here"}', '{"field":"title_tag","before":"Old","after":"Notes Example: Drafted Title Here"}',
            'pending_approval', 'test-notes-a') returning id into v_a;
  insert into seo_actions (client_id, location_id, action_type, target_field, finding_type, target_url, proposed_value, status, idempotency_key)
    values (v_client, v_loc, 'onpage_fix', 'meta_description', 'meta_description_length', 'https://notes.example.com/',
            '{"value":"A drafted meta description for the notes example page."}', 'pending_approval', 'test-notes-b') returning id into v_b;

  -- The service role writes a validated edit (the dashboard's path).
  update seo_actions
     set original_value = proposed_value,
         proposed_value = '{"value":"Notes Example: Edited Title Here"}',
         edited_at = now()
   where id = v_b;
  select status into v_status from seo_actions where id = v_b;
  assert v_status = 'pending_approval', 'service role: an edit leaves the draft waiting';

  insert into auth.users (id, email) values (v_user, 'seo-notes-test@example.com');
  update users set client_id = v_client, role = 'admin' where id = v_user;
  perform set_config('request.jwt.claim.sub', v_user::text, true);
  set local role authenticated;

  -- Reject with a note: allowed.
  update seo_actions set status = 'rejected', decision_note = 'Wrong city: we are online only.' where id = v_a;
  select decision_note, status into v_note, v_status from seo_actions where id = v_a;
  assert v_status = 'rejected' and v_note = 'Wrong city: we are online only.', 'reject with a note';

  -- A note after the decision: RLS (0042) only lets a tenant update a
  -- pending_approval row, so this matches nothing and the note is unchanged.
  update seo_actions set decision_note = 'changed my mind' where id = v_a;
  select decision_note into v_note from seo_actions where id = v_a;
  assert v_note = 'Wrong city: we are online only.', 'a note can''t be rewritten after the decision';

  -- A note with no decision on a waiting draft: the trigger refuses it.
  begin
    update seo_actions set decision_note = 'just a note' where id = v_b;
    v_denied := false;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  assert v_denied, 'a note can''t be added without a decision';

  -- Editing the draft as a tenant: still refused (0054).
  begin
    update seo_actions set proposed_value = '{"value":"forged"}' where id = v_b;
    v_denied := false;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  assert v_denied, 'a tenant still can''t edit the draft directly';

  begin
    update seo_actions set original_value = null where id = v_b;
    v_denied := false;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  assert v_denied, 'a tenant can''t erase the original either';

  -- Over 500 characters: refused by the check constraint.
  begin
    update seo_actions set status = 'approved', decision_note = repeat('x', 501) where id = v_b;
    v_denied := false;
  exception when check_violation then
    v_denied := true;
  end;
  assert v_denied, 'a note is at most 500 characters';

  -- Approve the edited draft, no note: fine.
  update seo_actions set status = 'approved' where id = v_b;
  select status into v_status from seo_actions where id = v_b;
  assert v_status = 'approved', 'approve an edited draft';

  raise notice 'ALL 0074 ACTION NOTE TESTS PASSED';
end;
$$;

rollback;

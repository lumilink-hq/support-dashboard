-- =============================================================================
-- 0208_loyalty_import_clocks.sql — the Joy import keeps Joy-active members
-- safe when the file has no activity dates. Builds on 0207.
--
-- WHY. Joy's REST API needs the Ultimate plan and its in-app export wasn't
-- available, so Tsunami's balances come from a Klaviyo profile export (Joy's
-- synced `Joy Loyalty Points` / `Joy Vip tier`), which has no activity or join
-- dates. Our hourly job expires points after a year with no activity and drops
-- a tier after six months with no order; with only Shopify order dates, a
-- member Joy considers active (logins, redemptions, claims) could be expired
-- or demoted right after the import, and at cutover that means mass point
-- losses and "Tier Downgrade" emails.
--
-- WHAT. loyalty_joy_apply_import as in 0207, except: a row with no
-- last_activity_at starts the expiry clock (last_activity_at) and the demotion
-- clock (last_demoted_at) at the export's taken_at, never moving either
-- backwards. A row WITH an activity date (Joy's own export) behaves as before.
--
-- Test: scripts/test_loyalty_joy_migration.sql. Idempotent / safe to re-apply.
-- =============================================================================

create or replace function loyalty_joy_apply_import(p_snapshot uuid)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_s       loyalty_joy_snapshots%rowtype;
  v_row     loyalty_joy_rows%rowtype;
  v_member  uuid;
  v_new     boolean;
  v_tier    text;
  v_balance int;
  v_r       jsonb;
  v_status  text;
  v_summary jsonb;
  v_prev    text := coalesce(current_setting('loyalty.quiet', true), '');
begin
  select * into v_s from loyalty_joy_snapshots where id = p_snapshot for update;
  if not found or v_s.kind <> 'import' then
    raise exception 'snapshot % is not an import snapshot', p_snapshot;
  end if;
  if v_s.applied_at is not null then
    raise exception 'snapshot % was already applied at %', p_snapshot, v_s.applied_at;
  end if;
  if exists (select 1 from loyalty_joy_snapshots
              where program_id = v_s.program_id and kind = 'import' and applied_at is not null and taken_at >= v_s.taken_at) then
    raise exception 'a newer (or same-time) Joy import is already applied; refusing to roll balances back to %', v_s.taken_at;
  end if;
  perform set_config('loyalty.quiet', 'on', true);

  for v_row in select * from loyalty_joy_rows where snapshot_id = p_snapshot order by row_no loop
    v_new := false;
    v_tier := null;
    if v_row.tier_name is not null then
      select key into v_tier from loyalty_tiers where program_id = v_s.program_id and lower(name) = lower(v_row.tier_name);
      if v_tier is null then
        update loyalty_joy_rows set status = 'unknown_tier', message = 'no tier named ' || v_row.tier_name
         where snapshot_id = p_snapshot and row_no = v_row.row_no;
        continue;
      end if;
    end if;

    v_member := loyalty_joy_match(v_s.program_id, v_row.shopify_customer_id, v_row.email);
    if v_member is null and v_row.shopify_customer_id is not null then
      v_member := loyalty_enroll_member(v_s.program_id, v_row.shopify_customer_id, v_row.email,
                                        v_row.first_name, v_row.last_name, coalesce(v_row.joined_at, v_s.taken_at));
      v_new := true;
    end if;
    if v_member is null then
      update loyalty_joy_rows set status = 'unmatched', message = 'no customer id and no unique email match'
       where snapshot_id = p_snapshot and row_no = v_row.row_no;
      continue;
    end if;

    if exists (select 1 from loyalty_ledger where program_id = v_s.program_id and idempotency_key = 'import:' || v_member || ':' || p_snapshot) then
      v_status := 'already_imported';   -- the same member twice in one file (by id and by email)
    else
      select points_balance into v_balance from loyalty_members where id = v_member;
      -- 'refund' is the only reason allowed below zero; an import target is >= 0,
      -- so the delta can only overdraw if Joy's balance is negative (rejected by the script).
      v_r := loyalty_post_entry(v_member, v_row.points - v_balance, 'import', 'import:' || v_member || ':' || p_snapshot, 0, null,
                                'joy_import', p_snapshot::text,
                                format('Joy balance %s at %s (ours was %s)', v_row.points, v_s.taken_at, v_balance),
                                'joy_import', v_s.taken_at);
      v_status := case when v_new then 'enrolled' else 'imported' end;
      if v_tier is not null then
        perform loyalty_set_tier(v_member, v_tier, 'import', 'joy_import');
      end if;
      -- 0208: with no activity date in the file (a Klaviyo export), start the
      -- expiry and demotion clocks at the export, so Joy-active members don't
      -- lose points or a tier within the hour (Joy counts logins and
      -- redemptions as activity; we only see orders). A date in the file wins.
      update loyalty_members
         set enrolled_at      = least(enrolled_at, coalesce(v_row.joined_at, enrolled_at)),
             last_activity_at = greatest(last_activity_at, coalesce(v_row.last_activity_at, v_s.taken_at)),
             last_demoted_at  = case when v_row.last_activity_at is null
                                     then greatest(last_demoted_at, v_s.taken_at) else last_demoted_at end,
             birthday         = coalesce(birthday, v_row.birthday),
             birthday_set_at  = case when birthday is null and v_row.birthday is not null then now() else birthday_set_at end
       where id = v_member;
    end if;

    update loyalty_joy_rows
       set member_id = v_member, status = v_status,
           our_points = (select points_balance from loyalty_members where id = v_member),
           our_tier = (select t.name from loyalty_members m join loyalty_tiers t on t.program_id = m.program_id and t.key = m.tier_key where m.id = v_member)
     where snapshot_id = p_snapshot and row_no = v_row.row_no;
  end loop;

  perform set_config('loyalty.quiet', v_prev, true);
  select jsonb_object_agg(status, n) into v_summary
    from (select status, count(*) n from loyalty_joy_rows where snapshot_id = p_snapshot group by status) x;
  update loyalty_joy_snapshots set applied_at = now(), summary = v_summary where id = p_snapshot;
  return v_summary;
end;
$$;

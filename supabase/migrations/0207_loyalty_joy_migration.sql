-- =============================================================================
-- 0207_loyalty_joy_migration.sql — LL Loyalty module 8: bring Joy's members
-- over, then compare against Joy daily through the parallel run.
-- Plan: docs/loyalty/PLAN.md, runbook docs/loyalty/CUTOVER.md. Builds on 0200-0206.
--
-- A Joy export (CSV, never in git: it's customer PII) is loaded by
-- scripts/joy-import.ts into loyalty_joy_rows under a loyalty_joy_snapshots
-- row, kind 'import' or 'compare'.
--
-- IMPORT SETS, IT DOESN'T ADD. Our webhooks earn from install (live_since), so
-- an order paid after install is in both systems. loyalty_joy_apply_import
-- writes one 'import' ledger entry per member equal to (Joy balance - our
-- balance), so afterwards ours equals Joy's at the export time, and sets the
-- tier to Joy's (reason 'import'). The entry's note keeps both numbers, so a
-- gap is recorded, never silently erased.
--   Day 0 (install): the opening balances.
--   Cutover: the TRUE-UP. During the parallel run shoppers still redeem and
--   claim in Joy, which our ledger never sees, so balances drift; the final
--   import (Joy's earning off) sets everyone to Joy's exact numbers.
-- A snapshot applies once, and an import older than the newest one already
-- applied is refused, so a stale file can never roll balances back. Keyed
-- 'import:<member>:<snapshot>'.
-- It also carries Joy's dates so clocks don't restart at cutover: enrolled_at
-- (anniversaries) moves EARLIER only, last_activity_at (expiry) LATER only;
-- birthday only fills a blank. Runs in quiet mode (0205): no Klaviyo events.
--
-- COMPARE IS READ-ONLY. loyalty_joy_compare records, per Joy row, our points
-- and tier next to Joy's, plus our members missing from the export. It never
-- changes a balance: a mismatch is something to explain, not paper over.
--
-- MATCHING: Shopify customer id first, then email (case-insensitive, only
-- when it's unique in the program). A Joy member we don't have is enrolled on
-- import if the row has a customer id; otherwise it's reported 'unmatched'.
--
-- PURGE. loyalty_joy_purge deletes a snapshot's rows (names, emails) once it
-- has served its purpose; snapshots older than 45 days should not exist.
--
-- Test: scripts/test_loyalty_joy_migration.sql. Idempotent / safe to re-apply.
-- =============================================================================

create table if not exists loyalty_joy_snapshots (
  id          uuid        primary key default gen_random_uuid(),
  program_id  uuid        not null references loyalty_programs(id) on delete cascade,
  kind        text        not null check (kind in ('import', 'compare')),
  taken_at    timestamptz not null,           -- when the export was downloaded from Joy
  file_name   text,
  row_count   int         not null default 0,
  applied_at  timestamptz,
  summary     jsonb,
  created_at  timestamptz not null default now()
);

create table if not exists loyalty_joy_rows (
  snapshot_id          uuid        not null references loyalty_joy_snapshots(id) on delete cascade,
  row_no               int         not null,
  shopify_customer_id  bigint,
  email                text,
  first_name           text,
  last_name            text,
  points               int         not null,
  tier_name            text,
  birthday             date,
  joined_at            timestamptz,
  last_activity_at     timestamptz,
  member_id            uuid,
  status               text,       -- import: imported/enrolled/already_imported/unmatched/unknown_tier; compare: match/points/tier/both/missing_here
  our_points           int,
  our_tier             text,
  message              text,
  primary key (snapshot_id, row_no)
);

create index if not exists idx_loyalty_joy_rows_status on loyalty_joy_rows(snapshot_id, status);

alter table loyalty_joy_snapshots enable row level security;
alter table loyalty_joy_rows      enable row level security;
revoke all on loyalty_joy_snapshots, loyalty_joy_rows from anon, authenticated;
grant select, insert, update, delete on loyalty_joy_snapshots, loyalty_joy_rows to service_role;

-- -----------------------------------------------------------------------------
-- Loading
-- -----------------------------------------------------------------------------
create or replace function loyalty_joy_create_snapshot(p_program uuid, p_kind text, p_taken_at timestamptz, p_file text default null)
returns uuid
language sql
set search_path = public, pg_temp
as $$
  insert into loyalty_joy_snapshots (program_id, kind, taken_at, file_name)
  values (p_program, p_kind, p_taken_at, p_file)
  returning id;
$$;

-- p_rows: [{row_no, shopify_customer_id, email, first_name, last_name, points,
-- tier_name, birthday, joined_at, last_activity_at}] (the script normalizes).
create or replace function loyalty_joy_add_rows(p_snapshot uuid, p_rows jsonb)
returns int
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_n int;
begin
  if (select applied_at from loyalty_joy_snapshots where id = p_snapshot) is not null then
    raise exception 'snapshot % was already applied', p_snapshot;
  end if;
  insert into loyalty_joy_rows (snapshot_id, row_no, shopify_customer_id, email, first_name, last_name, points,
                                tier_name, birthday, joined_at, last_activity_at)
  select p_snapshot, r.row_no, r.shopify_customer_id, nullif(lower(trim(r.email)), ''), r.first_name, r.last_name,
         coalesce(r.points, 0), nullif(trim(r.tier_name), ''), r.birthday, r.joined_at, r.last_activity_at
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as r(
      row_no int, shopify_customer_id bigint, email text, first_name text, last_name text, points int,
      tier_name text, birthday date, joined_at timestamptz, last_activity_at timestamptz)
  on conflict (snapshot_id, row_no) do nothing;
  get diagnostics v_n = row_count;
  update loyalty_joy_snapshots set row_count = (select count(*) from loyalty_joy_rows where snapshot_id = p_snapshot)
   where id = p_snapshot;
  return v_n;
end;
$$;

-- loyalty_joy_match — our member for a Joy row: customer id, else a unique email.
create or replace function loyalty_joy_match(p_program uuid, p_customer_id bigint, p_email text)
returns uuid
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    (select id from loyalty_members where program_id = p_program and shopify_customer_id = p_customer_id),
    (select min(id::text)::uuid from loyalty_members
      where p_email is not null and program_id = p_program and lower(email) = lower(p_email)
     having count(*) = 1));
$$;

-- -----------------------------------------------------------------------------
-- Import
-- -----------------------------------------------------------------------------
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
      update loyalty_members
         set enrolled_at      = least(enrolled_at, coalesce(v_row.joined_at, enrolled_at)),
             last_activity_at = greatest(last_activity_at, v_row.last_activity_at),
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

-- -----------------------------------------------------------------------------
-- Compare (read-only on members)
-- -----------------------------------------------------------------------------
create or replace function loyalty_joy_compare(p_snapshot uuid)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_s       loyalty_joy_snapshots%rowtype;
  v_summary jsonb;
  v_missing int;
begin
  select * into v_s from loyalty_joy_snapshots where id = p_snapshot;
  if not found or v_s.kind <> 'compare' then
    raise exception 'snapshot % is not a compare snapshot', p_snapshot;
  end if;

  update loyalty_joy_rows r
     set member_id = x.member_id, our_points = x.points, our_tier = x.tier,
         status = case
           when x.member_id is null then 'missing_here'
           when x.points <> r.points and lower(coalesce(x.tier, '')) <> lower(coalesce(r.tier_name, x.tier, '')) then 'both'
           when x.points <> r.points then 'points'
           when lower(coalesce(x.tier, '')) <> lower(coalesce(r.tier_name, x.tier, '')) then 'tier'
           else 'match' end,
         message = case when x.member_id is not null and x.points <> r.points
                        then format('ours %s, Joy %s (%s%s)', x.points, r.points, case when x.points > r.points then '+' else '' end, x.points - r.points) end
    from (select r2.row_no, m.id as member_id, m.points_balance as points, t.name as tier
            from loyalty_joy_rows r2
            left join loyalty_members m on m.id = loyalty_joy_match(v_s.program_id, r2.shopify_customer_id, r2.email)
            left join loyalty_tiers t on t.program_id = m.program_id and t.key = m.tier_key
           where r2.snapshot_id = p_snapshot) x
   where r.snapshot_id = p_snapshot and r.row_no = x.row_no;

  -- Our members with a balance or a tier above entry that Joy doesn't list.
  select count(*) into v_missing
    from loyalty_members m
   where m.program_id = v_s.program_id
     and not exists (select 1 from loyalty_joy_rows r where r.snapshot_id = p_snapshot and r.member_id = m.id)
     and (m.points_balance <> 0 or m.tier_key <> (select key from loyalty_tiers where program_id = m.program_id order by rank limit 1));

  select jsonb_build_object(
           'rows', count(*),
           'match', count(*) filter (where status = 'match'),
           'points_only', count(*) filter (where status = 'points'),
           'tier_only', count(*) filter (where status = 'tier'),
           'points_and_tier', count(*) filter (where status = 'both'),
           'missing_here', count(*) filter (where status = 'missing_here'),
           'missing_in_joy', v_missing,
           'points_diff_total', coalesce(sum(our_points - points) filter (where status in ('points', 'both')), 0))
    into v_summary
    from loyalty_joy_rows where snapshot_id = p_snapshot;
  update loyalty_joy_snapshots set applied_at = now(), summary = v_summary where id = p_snapshot;
  return v_summary;
end;
$$;

-- The mismatches, worst first, for the report.
create or replace function loyalty_joy_mismatches(p_snapshot uuid, p_limit int default 200)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select jsonb_build_object('row_no', row_no, 'status', status, 'shopify_customer_id', shopify_customer_id,
                              'email', email, 'joy_points', points, 'our_points', our_points,
                              'joy_tier', tier_name, 'our_tier', our_tier, 'member_id', member_id, 'message', message) as x
      from loyalty_joy_rows
     where snapshot_id = p_snapshot and status not in ('match', 'imported', 'enrolled', 'already_imported')
     order by abs(coalesce(our_points, 0) - points) desc, row_no
     limit p_limit) s;
$$;

-- loyalty_joy_purge — drop a snapshot's rows (the PII); keep the summary.
create or replace function loyalty_joy_purge(p_snapshot uuid)
returns int
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_n int;
begin
  delete from loyalty_joy_rows where snapshot_id = p_snapshot;
  get diagnostics v_n = row_count;
  update loyalty_joy_snapshots set row_count = 0, file_name = file_name || ' (purged)' where id = p_snapshot and file_name not like '%(purged)';
  return v_n;
end;
$$;

revoke execute on function loyalty_joy_create_snapshot(uuid, text, timestamptz, text) from public, anon, authenticated;
revoke execute on function loyalty_joy_add_rows(uuid, jsonb) from public, anon, authenticated;
revoke execute on function loyalty_joy_match(uuid, bigint, text) from public, anon, authenticated;
revoke execute on function loyalty_joy_apply_import(uuid) from public, anon, authenticated;
revoke execute on function loyalty_joy_compare(uuid) from public, anon, authenticated;
revoke execute on function loyalty_joy_mismatches(uuid, int) from public, anon, authenticated;
revoke execute on function loyalty_joy_purge(uuid) from public, anon, authenticated;

grant execute on function loyalty_joy_create_snapshot(uuid, text, timestamptz, text) to service_role;
grant execute on function loyalty_joy_add_rows(uuid, jsonb) to service_role;
grant execute on function loyalty_joy_match(uuid, bigint, text) to service_role;
grant execute on function loyalty_joy_apply_import(uuid) to service_role;
grant execute on function loyalty_joy_compare(uuid) to service_role;
grant execute on function loyalty_joy_mismatches(uuid, int) to service_role;
grant execute on function loyalty_joy_purge(uuid) to service_role;

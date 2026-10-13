-- =============================================================================
-- 0205_loyalty_klaviyo.sql — LL Loyalty module 6: Klaviyo events and profile
-- properties under the names Tsunami's flows already use (plan §4).
-- Plan: docs/loyalty/PLAN.md. Builds on 0200-0204.
--
-- NAMES ARE CONFIG. loyalty_programs.klaviyo_names maps each property/event to
-- its Klaviyo name; defaults are Joy's. A null name = not sent (the tier-
-- achieved and milestone event names are still unknown, plan §9).
--
-- OFF UNTIL CUTOVER. Joy keeps sending the same names during the parallel
-- run, so nothing goes to Klaviyo until klaviyo_enabled_at is set. Events
-- queued before it are skipped, never flooded out on the day. (To test during
-- the parallel run, point the names at 'LL: …' first, then switch.)
--
-- QUIET MODE. Rebuilding history must not email anyone: while the session
-- setting loyalty.quiet = 'on' (the backfill batch sets it; the Joy import in
-- module 8 must too), no events are queued. Tier changes and awards still
-- happen; only the outbox stays quiet.
--
-- EVENTS (loyalty_events outbox, 0202 + new kinds):
--   tier_up / tier_down  — from loyalty_tier_changes (up: spend/staff;
--                          down: inactivity/refund; enroll/import never)
--   milestone            — a milestone award in the ledger
--   reward_eligible      — a balance crosses a reward's points cost
--   demotion_warning, pre_birthday, birthday — run_loyalty_jobs (0202)
-- PROFILES: tier, points, member status, referral URL, birthday (MM/DD/YYYY);
--   pushed when they differ from what was last sent (hash). Never subscribes
--   anyone (plan §8b L1-4): profile-import doesn't touch consent.
--
-- The loyalty-klaviyo edge function sends both; pg_cron calls it every minute
-- for enabled programs with work.
--
-- Test: scripts/test_loyalty_klaviyo.sql. Idempotent / safe to re-apply.
-- =============================================================================

alter table loyalty_programs add column if not exists klaviyo_key_ref text;          -- vault.secrets NAME of the private API key
alter table loyalty_programs add column if not exists klaviyo_enabled_at timestamptz;
alter table loyalty_programs add column if not exists rewards_page_url text;         -- e.g. https://tsunami.store/pages/wave-rewards
alter table loyalty_programs add column if not exists klaviyo_names jsonb not null default jsonb_build_object(
  'prop_tier',              'Joy Vip tier',
  'prop_status',            'Joy member status',
  'prop_points',            'Joy Loyalty Points',
  'prop_referral_url',      'Joy Referral URL',
  'prop_birthday',          jsonb_build_array('Birthday', 'dateOfBirth'),
  'status_active',          'member',
  'status_excluded',        'excluded',
  'event_reward_eligible',  'Joy: Points Eligible Reward',
  'event_tier_down',        'Joy: Tier Downgrade',
  'event_pre_birthday',     'Joy: 7 Days Pre Birthday',
  'event_birthday',         'Joy: Birthday',
  'event_tier_up',          null,
  'event_milestone',        null,
  'event_demotion_warning', null);

alter table loyalty_members add column if not exists klaviyo_synced_hash text;
alter table loyalty_members add column if not exists klaviyo_synced_at timestamptz;
alter table loyalty_members add column if not exists klaviyo_error text;

alter table loyalty_events add column if not exists status text not null default 'pending';
update loyalty_events set status = 'sent' where sent_at is not null and status = 'pending';
alter table loyalty_events drop constraint if exists loyalty_events_status_check;
alter table loyalty_events add constraint loyalty_events_status_check check (status in ('pending', 'sent', 'skipped', 'failed'));
alter table loyalty_events drop constraint if exists loyalty_events_kind_check;
alter table loyalty_events add constraint loyalty_events_kind_check check (kind in (
  'demotion_warning', 'pre_birthday', 'birthday', 'tier_up', 'tier_down', 'milestone', 'reward_eligible'));

drop index if exists idx_loyalty_events_unsent;
create index if not exists idx_loyalty_events_pending on loyalty_events(program_id, created_at) where status = 'pending';

-- -----------------------------------------------------------------------------
-- Quiet mode + emitting
-- -----------------------------------------------------------------------------
create or replace function loyalty_quiet()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(current_setting('loyalty.quiet', true), '') = 'on';
$$;

-- loyalty_emit_event — 0202's, but silent in quiet mode.
create or replace function loyalty_emit_event(p_member uuid, p_kind text, p_dedupe_key text, p_payload jsonb default '{}'::jsonb)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if loyalty_quiet() then
    return false;
  end if;
  insert into loyalty_events (program_id, member_id, kind, payload, dedupe_key)
  select m.program_id, m.id, p_kind, coalesce(p_payload, '{}'::jsonb), p_dedupe_key
    from loyalty_members m where m.id = p_member
  on conflict (program_id, dedupe_key) do nothing;
  return found;
end;
$$;

-- loyalty_record_orders — 0201's batch, quiet for the backfill.
create or replace function loyalty_record_orders(p_program uuid, p_orders jsonb, p_source text)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_o      jsonb;
  v_status text;
  v_counts jsonb := '{"recorded":0,"duplicate":0,"not_member":0}'::jsonb;
  v_prev   text := coalesce(current_setting('loyalty.quiet', true), '');
begin
  if p_source = 'backfill' then
    perform set_config('loyalty.quiet', 'on', true);
  end if;
  for v_o in select * from jsonb_array_elements(coalesce(p_orders, '[]'::jsonb)) loop
    v_status := loyalty_record_order(p_program, v_o, p_source)->>'status';
    v_counts := jsonb_set(v_counts, array[v_status], to_jsonb((v_counts->>v_status)::int + 1));
  end loop;
  perform set_config('loyalty.quiet', v_prev, true);
  return v_counts;
end;
$$;

-- Tier changes -> tier_up / tier_down.
create or replace function loyalty_tier_change_event()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_names jsonb;
begin
  if new.direction = 'up' and new.reason in ('spend', 'staff') then
    perform loyalty_emit_event(new.member_id, 'tier_up', 'tier_change:' || new.id,
      jsonb_build_object('tier', (select name from loyalty_tiers where program_id = new.program_id and key = new.to_tier),
                         'previous_tier', (select name from loyalty_tiers where program_id = new.program_id and key = new.from_tier),
                         'reason', new.reason));
  elsif new.direction = 'down' and new.reason in ('inactivity', 'refund') then
    perform loyalty_emit_event(new.member_id, 'tier_down', 'tier_change:' || new.id,
      jsonb_build_object('tier', (select name from loyalty_tiers where program_id = new.program_id and key = new.to_tier),
                         'previous_tier', (select name from loyalty_tiers where program_id = new.program_id and key = new.from_tier),
                         'reason', new.reason));
  end if;
  return null;
end;
$$;

drop trigger if exists trg_loyalty_tier_change_event on loyalty_tier_changes;
create trigger trg_loyalty_tier_change_event
  after insert on loyalty_tier_changes
  for each row execute function loyalty_tier_change_event();

-- Ledger -> milestone, reward_eligible.
create or replace function loyalty_ledger_event()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_rw record;
begin
  if new.reason = 'milestone' then
    perform loyalty_emit_event(new.member_id, 'milestone', 'milestone:' || new.id,
      jsonb_build_object('milestone', new.rule_key, 'points_awarded', new.points,
                         'order_count', (select order_count from loyalty_earn_rules where program_id = new.program_id and key = new.rule_key)));
  end if;
  if new.points > 0 then
    for v_rw in
      select key, name, points_cost from loyalty_rewards
       where program_id = new.program_id and is_active and points_cost is not null
         and new.balance_after >= points_cost and new.balance_after - new.points < points_cost
    loop
      perform loyalty_emit_event(new.member_id, 'reward_eligible', 'reward_eligible:' || new.id || ':' || v_rw.key,
        jsonb_build_object('reward', v_rw.name, 'points_cost', v_rw.points_cost));
    end loop;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_loyalty_ledger_event on loyalty_ledger;
create trigger trg_loyalty_ledger_event
  after insert on loyalty_ledger
  for each row execute function loyalty_ledger_event();

-- -----------------------------------------------------------------------------
-- Profiles
-- -----------------------------------------------------------------------------

-- loyalty_klaviyo_properties — the profile properties for a member, by the
-- program's names. Null names are left out.
create or replace function loyalty_klaviyo_properties(p_member uuid)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_m     loyalty_members%rowtype;
  v_p     loyalty_programs%rowtype;
  v_n     jsonb;
  v_props jsonb := '{}'::jsonb;
  v_bday  text;
  v_name  text;
begin
  select * into v_m from loyalty_members where id = p_member;
  select * into v_p from loyalty_programs where id = v_m.program_id;
  v_n := v_p.klaviyo_names;

  if v_n->>'prop_tier' is not null then
    v_props := v_props || jsonb_build_object(v_n->>'prop_tier',
      (select name from loyalty_tiers where program_id = v_m.program_id and key = v_m.tier_key));
  end if;
  if v_n->>'prop_points' is not null then
    v_props := v_props || jsonb_build_object(v_n->>'prop_points', v_m.points_balance);
  end if;
  if v_n->>'prop_status' is not null then
    v_props := v_props || jsonb_build_object(v_n->>'prop_status', v_n->>('status_' || v_m.status));
  end if;
  if v_n->>'prop_referral_url' is not null and v_p.rewards_page_url is not null then
    v_props := v_props || jsonb_build_object(v_n->>'prop_referral_url', v_p.rewards_page_url || '?ref=' || v_m.referral_code);
  end if;
  if v_m.birthday is not null and jsonb_typeof(v_n->'prop_birthday') = 'array' then
    v_bday := to_char(v_m.birthday, 'MM/DD/YYYY');
    for v_name in select jsonb_array_elements_text(v_n->'prop_birthday') loop
      v_props := v_props || jsonb_build_object(v_name, v_bday);
    end loop;
  end if;
  return v_props;
end;
$$;

create or replace function loyalty_klaviyo_profiles_due(p_program uuid, p_limit int default 200)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select jsonb_build_object('member_id', m.id, 'email', m.email, 'properties', p.props, 'hash', md5(p.props::text)) as x
      from loyalty_members m
      cross join lateral (select loyalty_klaviyo_properties(m.id) as props) p
     where m.program_id = p_program and m.email is not null
       and m.klaviyo_synced_hash is distinct from md5(p.props::text)
       and (m.klaviyo_error is null or m.klaviyo_synced_at < now() - interval '15 minutes')
     order by m.klaviyo_synced_at nulls first
     limit p_limit
  ) s;
$$;

-- p_items: [{member_id, hash, error}]
create or replace function loyalty_klaviyo_profiles_result(p_items jsonb)
returns int
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_n int;
begin
  update loyalty_members m
     set klaviyo_synced_hash = case when i.error is null then i.hash else m.klaviyo_synced_hash end,
         klaviyo_synced_at   = now(),
         klaviyo_error       = left(i.error, 500)
    from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as i(member_id uuid, hash text, error text)
   where m.id = i.member_id;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- -----------------------------------------------------------------------------
-- Events
-- -----------------------------------------------------------------------------

-- loyalty_klaviyo_events_due — pending events ready to send, with the metric
-- name and the member's current state. Side effect: skips what must not be
-- sent (queued before klaviyo_enabled_at, no name configured, no email).
create or replace function loyalty_klaviyo_events_due(p_program uuid, p_limit int default 100)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_p loyalty_programs%rowtype;
begin
  select * into v_p from loyalty_programs where id = p_program;
  if v_p.klaviyo_enabled_at is null then
    return '[]'::jsonb;
  end if;

  update loyalty_events e
     set status = 'skipped',
         last_error = case when e.created_at < v_p.klaviyo_enabled_at then 'queued before Klaviyo was enabled'
                           when v_p.klaviyo_names->>('event_' || e.kind) is null then 'no Klaviyo name for ' || e.kind
                           else 'member has no email' end
    from loyalty_members m
   where e.program_id = p_program and e.status = 'pending' and m.id = e.member_id
     and (e.created_at < v_p.klaviyo_enabled_at
          or v_p.klaviyo_names->>('event_' || e.kind) is null
          or m.email is null);

  return (select coalesce(jsonb_agg(x order by (x->>'id')::bigint), '[]'::jsonb) from (
    select jsonb_build_object(
             'id', e.id,
             'metric', v_p.klaviyo_names->>('event_' || e.kind),
             'unique_id', 'll-' || e.program_id || '-' || e.id,
             'time', e.created_at,
             'email', m.email,
             'properties', e.payload || jsonb_build_object(
                'kind', e.kind,
                'points_balance', m.points_balance,
                'tier', (select name from loyalty_tiers where program_id = m.program_id and key = m.tier_key),
                'referral_url', case when v_p.rewards_page_url is not null then v_p.rewards_page_url || '?ref=' || m.referral_code end)) as x
      from loyalty_events e join loyalty_members m on m.id = e.member_id
     where e.program_id = p_program and e.status = 'pending'
     order by e.id
     limit p_limit) s);
end;
$$;

-- p_error null = sent. 5 failures = 'failed'.
create or replace function loyalty_klaviyo_event_result(p_event bigint, p_error text default null)
returns void
language sql
set search_path = public, pg_temp
as $$
  update loyalty_events
     set status = case when p_error is null then 'sent' when attempts + 1 >= 5 then 'failed' else 'pending' end,
         sent_at = case when p_error is null then now() end,
         attempts = attempts + case when p_error is null then 0 else 1 end,
         last_error = left(p_error, 500)
   where id = p_event;
$$;

create or replace function get_loyalty_klaviyo_key(p_program uuid)
returns text
language sql
stable
security definer
set search_path = public, extensions
as $$
  select (select decrypted_secret from vault.decrypted_secrets where name = p.klaviyo_key_ref)
    from loyalty_programs p where p.id = p_program;
$$;

-- -----------------------------------------------------------------------------
-- Dispatch: enabled programs with work, every minute.
-- -----------------------------------------------------------------------------
create or replace function loyalty_klaviyo_has_work(p_program uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select exists (select 1 from loyalty_events where program_id = p_program and status = 'pending')
      or jsonb_array_length(loyalty_klaviyo_profiles_due(p_program, 1)) > 0;
$$;

create or replace function request_loyalty_klaviyo(p_program uuid)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_url    text;
  v_secret text;
  v_req    bigint;
begin
  if to_regproc('net.http_post') is null then
    raise notice 'pg_net not installed — cannot request a Klaviyo sync';
    return null;
  end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'loyalty_klaviyo_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'voice_tool_secret';
  if v_url is null or v_secret is null then
    raise notice 'loyalty_klaviyo_url / voice_tool_secret not in Vault — cannot request a Klaviyo sync';
    return null;
  end if;
  execute
    'select net.http_post(url := $1, headers := $2, body := $3, timeout_milliseconds := 60000)'
    into v_req
    using v_url,
          jsonb_build_object('Content-Type', 'application/json', 'x-voice-tool-secret', v_secret),
          jsonb_build_object('program_id', p_program::text);
  return v_req;
end;
$$;

create or replace function run_due_loyalty_klaviyo()
returns int
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row record;
  v_n   int := 0;
begin
  for v_row in
    select id from loyalty_programs
     where is_active and klaviyo_enabled_at is not null and klaviyo_key_ref is not null
  loop
    if loyalty_klaviyo_has_work(v_row.id) and request_loyalty_klaviyo(v_row.id) is not null then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron not installed — loyalty Klaviyo sync NOT scheduled. Enable it, then re-run this migration.';
    return;
  end if;
  begin
    perform cron.unschedule('loyalty-klaviyo-due');
  exception when others then
    null;
  end;
  perform cron.schedule('loyalty-klaviyo-due', '* * * * *', $cron$select run_due_loyalty_klaviyo();$cron$);
end;
$$;

-- -----------------------------------------------------------------------------
-- Access: service role only (as 0200).
-- -----------------------------------------------------------------------------
revoke execute on function loyalty_quiet() from public, anon, authenticated;
revoke execute on function loyalty_emit_event(uuid, text, text, jsonb) from public, anon, authenticated;
revoke execute on function loyalty_record_orders(uuid, jsonb, text) from public, anon, authenticated;
revoke execute on function loyalty_tier_change_event() from public, anon, authenticated;
revoke execute on function loyalty_ledger_event() from public, anon, authenticated;
revoke execute on function loyalty_klaviyo_properties(uuid) from public, anon, authenticated;
revoke execute on function loyalty_klaviyo_profiles_due(uuid, int) from public, anon, authenticated;
revoke execute on function loyalty_klaviyo_profiles_result(jsonb) from public, anon, authenticated;
revoke execute on function loyalty_klaviyo_events_due(uuid, int) from public, anon, authenticated;
revoke execute on function loyalty_klaviyo_event_result(bigint, text) from public, anon, authenticated;
revoke execute on function get_loyalty_klaviyo_key(uuid) from public, anon, authenticated;
revoke execute on function loyalty_klaviyo_has_work(uuid) from public, anon, authenticated;
revoke execute on function request_loyalty_klaviyo(uuid) from public, anon, authenticated;
revoke execute on function run_due_loyalty_klaviyo() from public, anon, authenticated;

grant execute on function loyalty_quiet() to service_role;
grant execute on function loyalty_emit_event(uuid, text, text, jsonb) to service_role;
grant execute on function loyalty_record_orders(uuid, jsonb, text) to service_role;
grant execute on function loyalty_klaviyo_properties(uuid) to service_role;
grant execute on function loyalty_klaviyo_profiles_due(uuid, int) to service_role;
grant execute on function loyalty_klaviyo_profiles_result(jsonb) to service_role;
grant execute on function loyalty_klaviyo_events_due(uuid, int) to service_role;
grant execute on function loyalty_klaviyo_event_result(bigint, text) to service_role;
grant execute on function get_loyalty_klaviyo_key(uuid) to service_role;
grant execute on function loyalty_klaviyo_has_work(uuid) to service_role;
grant execute on function request_loyalty_klaviyo(uuid) to service_role;
grant execute on function run_due_loyalty_klaviyo() to service_role;

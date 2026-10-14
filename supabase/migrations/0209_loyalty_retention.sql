-- =============================================================================
-- 0209_loyalty_retention.sql — the retention rule from docs/loyalty/
-- DATA-PROTECTION.md (plan §8b L1-8), as a monthly job. Builds on 0200-0208.
--
--   loyalty_webhook_receipts  > 90 days   deleted (ids and outcomes only)
--   loyalty_joy_rows          > 45 days   snapshot rows purged (names, emails);
--                                         the snapshot's summary stays
--   loyalty_access_log        > 2 years   deleted
--
-- The access log is append-only (0206). loyalty_append_only gains ONE narrow
-- exception: a DELETE on loyalty_access_log of a row older than 2 years while
-- the session setting loyalty.retention_purge = 'on', which only
-- loyalty_retention_purge sets (transaction-local). Every other update or
-- delete is still refused.
--
-- Member data itself is not on a timer: it lives while the store runs the
-- program and goes on customers/redact or shop/redact (0201).
--
-- Test: scripts/test_loyalty_retention.sql. Idempotent / safe to re-apply.
-- =============================================================================

create or replace function loyalty_append_only()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;   -- cascade from loyalty_members / loyalty_programs
  end if;
  -- 0209: the retention job may delete access-log rows past their 2 years.
  if tg_op = 'DELETE' and tg_table_name = 'loyalty_access_log'
     and coalesce(current_setting('loyalty.retention_purge', true), '') = 'on' then
    if old.at < now() - interval '2 years' then
      return old;
    end if;
  end if;
  raise exception '% is append-only (% rejected); post a correcting entry instead', tg_table_name, tg_op;
end;
$$;

create or replace function loyalty_retention_purge()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_receipts  int;
  v_snapshots int := 0;
  v_rows      int := 0;
  v_log       int;
  v_snap      uuid;
begin
  delete from loyalty_webhook_receipts where received_at < now() - interval '90 days';
  get diagnostics v_receipts = row_count;

  for v_snap in
    select s.id from loyalty_joy_snapshots s
     where s.created_at < now() - interval '45 days'
       and exists (select 1 from loyalty_joy_rows r where r.snapshot_id = s.id)
  loop
    v_rows := v_rows + loyalty_joy_purge(v_snap);
    v_snapshots := v_snapshots + 1;
  end loop;

  perform set_config('loyalty.retention_purge', 'on', true);
  delete from loyalty_access_log where at < now() - interval '2 years';
  get diagnostics v_log = row_count;
  perform set_config('loyalty.retention_purge', '', true);

  return jsonb_build_object('ran_at', now(), 'webhook_receipts', v_receipts,
                            'joy_snapshots_purged', v_snapshots, 'joy_rows', v_rows, 'access_log', v_log);
end;
$$;

revoke execute on function loyalty_retention_purge() from public, anon, authenticated;
grant execute on function loyalty_retention_purge() to service_role;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron not installed — loyalty retention NOT scheduled. Enable it, then re-run this migration.';
    return;
  end if;
  begin
    perform cron.unschedule('loyalty-retention');
  exception when others then
    null;
  end;
  -- 03:17 UTC on the 1st of each month.
  perform cron.schedule('loyalty-retention', '17 3 1 * *', $cron$select loyalty_retention_purge();$cron$);
end;
$$;

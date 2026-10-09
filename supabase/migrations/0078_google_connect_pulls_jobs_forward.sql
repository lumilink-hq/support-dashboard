-- =============================================================================
-- 0078_google_connect_pulls_jobs_forward.sql
-- When a Google connection is made, or gains scopes (e.g. Business Profile
-- added to an existing Search Console connection), run the two Google syncs
-- at their next tick instead of waiting out the day.
--
-- WHY. seo-gbp-sync and seo-search-console record 'not_connected' and come
-- back in 24 hours when the connection lacks their scope (no Google calls, so
-- nothing to retry hourly). Without this, a client who adds Business Profile
-- right after that check waited until the next day for any data (PACKS,
-- 2026-10-09).
--
-- A trigger rather than a change to store_google_oauth_tokens (0046), so the
-- token-handling function stays exactly as reviewed. SECURITY DEFINER because
-- job_attempts is service-role only (0048) and the connection is written
-- under the signed-in user's session.
--
-- Idempotent / safe to re-apply.
-- =============================================================================

create or replace function google_connection_pull_jobs_forward()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if new.status = 'connected'
     and (tg_op = 'INSERT'
          or not (new.granted_scopes <@ old.granted_scopes)
          or old.status is distinct from 'connected') then
    update job_attempts
       set next_run_at = now()
     where client_id = new.client_id
       and job_type in ('seo_gbp_sync', 'seo_search_console')
       and entity_id is null
       and status <> 'running'
       and (next_run_at is null or next_run_at > now());
  end if;
  return new;
end;
$$;

revoke execute on function google_connection_pull_jobs_forward() from public, anon, authenticated;

drop trigger if exists trg_google_connection_pull_jobs_forward on google_oauth_connections;
create trigger trg_google_connection_pull_jobs_forward
  after insert or update of granted_scopes, status on google_oauth_connections
  for each row execute function google_connection_pull_jobs_forward();

-- End of 0078.

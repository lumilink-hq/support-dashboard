-- =============================================================================
-- 0065_seo_ai_share_of_voice.sql
-- Module 25 (plan.md, Phase 6c): AI visibility against competitors, and on
-- more AI platforms.
--
-- (a) SHARE OF VOICE on the two LLM Mentions platforms (Google AI Overviews,
--     ChatGPT). seo-ai-visibility (module 20) now also makes ONE
--     llm_mentions/multi_target_metrics call per (question, platform) that
--     counts answers citing the client AND each of up to 9 competitors, so
--     every site is measured the same way in the same call ($0.10 + $0.001 a
--     row, checked 2026-10-02).
--
-- (b) GEMINI, PERPLEXITY AND CLAUDE via DataForSEO's LLM Responses API: the
--     question is asked live, with web search on, and the domains the answer
--     cites are recorded. That is ONE SAMPLED ANSWER a week, not a count over
--     a dataset like LLM Mentions, so it reads "cited this week: yes/no" and
--     is noisier. Priced at $0.0006 a call plus the model's own cost (a few
--     cents with web search). The client's result is also written to
--     seo_ai_mentions (module 20) with the platform's name, so the existing
--     AI card and report show the new platforms without changes.
--     These calls take up to 2 minutes each, so they run as their own job,
--     seo_ai_responses, which works through a client's (question, platform)
--     pairs a few at a time and comes back every 10 minutes until the week's
--     set is done (a pair is "done" once it has a row from the last 6 days).
--
-- TABLE seo_ai_share_of_voice (vendor-written, tenant read-only): one row per
-- (question, platform, domain, day), the client's own domain included
-- (is_client), with method 'mentions' (a count of answers) or 'response'
-- (citations in one live answer).
--
-- Isolation and scheduling: scripts/test_seo_ai_share_of_voice.sql.
-- Idempotent / safe to re-apply.
-- =============================================================================

create table if not exists seo_ai_share_of_voice (
  id           uuid        primary key default gen_random_uuid(),
  client_id    uuid        not null references clients(id) on delete cascade,
  query_id     uuid        not null references seo_ai_queries(id) on delete cascade,
  platform     text        not null,   -- 'google', 'chat_gpt', 'perplexity', 'gemini', 'claude'
  domain       text        not null,
  is_client    boolean     not null default false,
  cited_count  int         not null default 0 check (cited_count >= 0),
  method       text        not null check (method in ('mentions', 'response')),
  check_date   date        not null default current_date,
  created_at   timestamptz not null default now(),

  unique (query_id, platform, domain, check_date)
);

create index if not exists idx_seo_ai_sov_client_date on seo_ai_share_of_voice(client_id, check_date desc);

alter table seo_ai_share_of_voice enable row level security;
drop policy if exists seo_ai_share_of_voice_tenant_select on seo_ai_share_of_voice;
create policy seo_ai_share_of_voice_tenant_select on seo_ai_share_of_voice
  for select using (client_id = current_client_id());
revoke all on seo_ai_share_of_voice from anon;
revoke insert, update, delete on seo_ai_share_of_voice from authenticated;
grant select on seo_ai_share_of_voice to authenticated, service_role;
grant insert, update, delete on seo_ai_share_of_voice to service_role;

-- -----------------------------------------------------------------------------
-- Scheduling for (b): per client, weekly, resumed every 10 minutes while
-- pairs remain. Same targets as module 20: an active question and a website.
-- -----------------------------------------------------------------------------
create or replace view seo_ai_responses_targets with (security_invoker = true) as
select
  c.id as client_id,
  ja.next_run_at,
  ja.status as job_status,
  (ja.next_run_at is null or ja.next_run_at <= now()) as is_due
from clients c
left join job_attempts ja
  on ja.client_id = c.id and ja.job_type = 'seo_ai_responses' and ja.entity_id is null
where exists (select 1 from seo_ai_queries q where q.client_id = c.id and q.is_active)
  and exists (
    select 1 from seo_locations l
     where l.client_id = c.id and l.is_active and l.website_url is not null
  );

revoke all on seo_ai_responses_targets from authenticated, anon;
grant select on seo_ai_responses_targets to service_role;

create or replace function request_seo_ai_responses(p_client_id uuid)
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
    raise notice 'pg_net not installed — cannot request AI responses';
    return null;
  end if;

  if not start_job_attempt(p_client_id, 'seo_ai_responses', null) then
    return null;  -- not due yet, or already in flight
  end if;

  -- Vendor budget ('dataforseo') is reserved INSIDE the edge function, per call.

  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'seo_ai_responses_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'voice_tool_secret';

  if v_url is null or v_secret is null then
    raise notice 'seo_ai_responses_url / voice_tool_secret not in Vault — cannot request AI responses';
    perform complete_job_attempt(p_client_id, 'seo_ai_responses', false, 'missing_vault_secret',
                                  10080, 1440, null);
    return null;
  end if;

  -- 150 s: one step runs up to ~100 s of live LLM calls.
  execute
    'select net.http_post(url := $1, headers := $2, body := $3, timeout_milliseconds := 150000)'
    into v_req
    using
      v_url,
      jsonb_build_object('Content-Type', 'application/json', 'x-voice-tool-secret', v_secret),
      jsonb_build_object('client_id', p_client_id::text);

  update job_attempts set dispatched_request_id = v_req
   where client_id = p_client_id and job_type = 'seo_ai_responses' and entity_id is null;

  return v_req;
end;
$$;

revoke execute on function request_seo_ai_responses(uuid) from public, authenticated;
grant execute on function request_seo_ai_responses(uuid) to service_role;

create or replace function run_due_seo_ai_responses(p_max_per_run int default 25)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row       record;
  v_requested int := 0;
  v_skipped   int := 0;
begin
  for v_row in
    select client_id from seo_ai_responses_targets
     where is_due
     order by next_run_at asc nulls first
     limit greatest(p_max_per_run, 1)
  loop
    if request_seo_ai_responses(v_row.client_id) is null then
      v_skipped := v_skipped + 1;
    else
      v_requested := v_requested + 1;
    end if;
  end loop;

  return jsonb_build_object('requested', v_requested, 'skipped', v_skipped, 'ran_at', now());
end;
$$;

revoke execute on function run_due_seo_ai_responses(int) from public, authenticated;
grant execute on function run_due_seo_ai_responses(int) to service_role;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron not installed — automatic AI responses NOT scheduled.';
    return;
  end if;
  begin
    perform cron.unschedule('seo-ai-responses-due');
  exception when others then null;
  end;
  -- Every 10 minutes (at :03, :13, ...). A client normally runs once a week;
  -- the short tick only matters while a week's pairs are still being worked
  -- through.
  perform cron.schedule('seo-ai-responses-due', '3,13,23,33,43,53 * * * *',
    $cron$select run_due_seo_ai_responses();$cron$);
end;
$$;

-- SETUP AFTER APPLYING (once per project):
--   1. DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are already set (module 7).
--   2. select vault.create_secret(
--        'https://<ref>.supabase.co/functions/v1/seo-ai-responses',
--        'seo_ai_responses_url', '');
--   3. supabase functions deploy seo-ai-responses --no-verify-jwt
--   4. supabase functions deploy seo-ai-visibility --no-verify-jwt  (share of voice)
--   Optional env on seo-ai-responses: SEO_AI_RESPONSE_PLATFORMS (default
--   "perplexity,gemini,claude") and SEO_AI_MODEL_PERPLEXITY / _GEMINI / _CLAUDE.
-- Then verify with:  select * from seo_ai_responses_targets;
--                    select run_due_seo_ai_responses();

-- End of 0065.

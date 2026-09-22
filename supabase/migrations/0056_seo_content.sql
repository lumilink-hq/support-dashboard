-- =============================================================================
-- 0056_seo_content.sql
-- Module 16 (plan.md): content generation. Weekly, per CLIENT, pick topics from
-- the ranking gap, draft an article and an image, and put it in the approval
-- queue (module 8) for module 5 to publish.
--
-- WHERE THE ARTICLE LIVES. In seo_actions (action_type 'content_publish'):
-- proposed_value carries the title, meta description, body HTML, the image and
-- the sanitised blocks the dashboard renders. That row is already protected by
-- 0054's tenant-column trigger, so nobody can edit an article after reading it
-- and before approving it: what is approved is what is published.
--
-- seo_content_posts is NOT where the article lives. It is a service-only ledger
-- of what each location has written about, holding what the uniqueness checks
-- need and the action can't usefully carry: the plain text, and two 384-dim
-- gte-small embeddings (topic phrase, and title+intro). Tenants can't read it.
--
-- WHAT "UNIQUE" MEANS HERE (plan.md: "check uniqueness against the location's
-- past posts and its sibling locations"). Three layers, cheapest first:
--   1. one ACTIVE article per client per normalised keyword (the unique index
--      below): two locations of one client can't both be writing about the same
--      keyword phrase;
--   2. topic-embedding similarity before drafting, so near-synonym topics on
--      sibling locations aren't picked either;
--   3. text overlap (5-word shingles) and embedding similarity of the finished
--      article against every active article of the client, at draft time AND
--      again just before publishing (a sibling may have been approved in
--      between).
--
-- 1. uq_seo_actions_live narrowed to on-page fixes. It keys on (location, page,
--    field); an article has no page yet, so every article of a location would
--    collide on ('', 'article').
-- 2. seo_content_posts + a trigger that retires a post when its action is
--    rejected, rolled back or failed, so a discarded topic can be written again.
-- 3. seo_keyword_gaps: latest own organic position vs the best competitor
--    position per tracked keyword. Service-only (rule 4).
-- 4. Public storage bucket seo-content-images. Public on purpose: the image goes
--    on the client's public blog anyway, Shopify must be able to fetch it by URL,
--    and paths are unguessable ({client}/{uuid}). Only service_role can write.
--    Replicate's own output URLs are not relied on; the image is copied here as
--    soon as it is generated.
-- 5. Weekly per-client scheduling, gated on an ACTIVE 'seo' entitlement: unlike
--    the audit jobs this one spends real money per run (a model call and an
--    image per article).
--
-- Idempotent / safe to re-apply.
-- =============================================================================

set search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- 1. Live-draft index: on-page fixes only
-- -----------------------------------------------------------------------------
drop index if exists uq_seo_actions_live;
create unique index uq_seo_actions_live
  on seo_actions (location_id, coalesce(target_url, ''), target_field)
  where action_type = 'onpage_fix'
    and target_field is not null
    and status in ('draft', 'pending_approval', 'approved', 'publishing', 'manual_required');

-- -----------------------------------------------------------------------------
-- 2. The ledger
-- -----------------------------------------------------------------------------
create table if not exists seo_content_posts (
  id                 uuid        primary key default gen_random_uuid(),
  client_id          uuid        not null references clients(id) on delete cascade,
  location_id        uuid        not null references seo_locations(id) on delete cascade,
  action_id          uuid        references seo_actions(id) on delete set null,

  topic_keyword      text        not null,
  topic_key          text        not null,                 -- lower(), whitespace-collapsed
  title              text        not null,
  body_text          text        not null,                 -- plain text, for the overlap check
  topic_embedding    vector(384),
  content_embedding  vector(384),
  similarity         jsonb       not null default '{}'::jsonb,  -- the draft-time report, for the reviewer

  state              text        not null default 'active' check (state in ('active', 'discarded')),
  created_at         timestamptz not null default now(),

  check (topic_key = lower(btrim(regexp_replace(topic_keyword, '\s+', ' ', 'g'))))
);

create unique index if not exists uq_seo_content_posts_topic
  on seo_content_posts (client_id, topic_key) where state = 'active';
create index if not exists idx_seo_content_posts_client on seo_content_posts (client_id, state);
create index if not exists idx_seo_content_posts_location on seo_content_posts (location_id);

alter table seo_content_posts enable row level security;
revoke all on seo_content_posts from authenticated, anon;
grant select, insert, update, delete on seo_content_posts to service_role;

create or replace function retire_seo_content_post()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if new.status in ('rejected', 'rolled_back', 'failed') and old.status is distinct from new.status then
    update seo_content_posts set state = 'discarded' where action_id = new.id and state = 'active';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_retire_seo_content_post on seo_actions;
create trigger trg_retire_seo_content_post
  after update of status on seo_actions
  for each row execute function retire_seo_content_post();

-- -----------------------------------------------------------------------------
-- 3. Gap analysis input
-- -----------------------------------------------------------------------------
-- One row per tracked keyword at an active, site-bearing location. own_position
-- is the latest ORGANIC position (null = not found within tracked depth, or no
-- data yet; has_rank_data tells them apart). best_competitor_position is the
-- best organic position among the client's tracked competitors on the latest
-- competitor check for that keyword.
create or replace view seo_keyword_gaps with (security_invoker = true) as
select
  k.id            as keyword_id,
  k.client_id,
  k.location_id,
  k.keyword,
  own.position    as own_position,
  (own.check_date is not null) as has_rank_data,
  comp.best_position as best_competitor_position,
  coalesce(comp.ranking_count, 0) as competitors_ranking
from seo_keywords k
join seo_locations l on l.id = k.location_id and l.is_active and l.website_url is not null
left join lateral (
  select r.position, r.check_date
    from seo_rankings r
   where r.keyword_id = k.id and r.rank_type = 'organic'
   order by r.check_date desc
   limit 1
) own on true
left join lateral (
  select min(cr.position) as best_position,
         count(*) filter (where cr.position is not null) as ranking_count
    from seo_competitor_rankings cr
   where cr.keyword_id = k.id
     and cr.rank_type = 'organic'
     and cr.check_date = (
       select max(c2.check_date) from seo_competitor_rankings c2
        where c2.keyword_id = k.id and c2.rank_type = 'organic'
     )
) comp on true;

revoke all on seo_keyword_gaps from authenticated, anon;
grant select on seo_keyword_gaps to service_role;

-- -----------------------------------------------------------------------------
-- 4. Storage bucket
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'storage schema not present — create the public bucket seo-content-images by hand';
    return;
  end if;
  insert into storage.buckets (id, name, public)
  values ('seo-content-images', 'seo-content-images', true)
  on conflict (id) do nothing;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Scheduling: weekly, per client
-- -----------------------------------------------------------------------------
create or replace view seo_content_targets with (security_invoker = true) as
select
  c.id as client_id,
  ja.next_run_at,
  ja.status as job_status,
  (ja.next_run_at is null or ja.next_run_at <= now()) as is_due
from clients c
left join job_attempts ja
  on ja.client_id = c.id and ja.job_type = 'seo_content' and ja.entity_id is null
where exists (select 1 from entitlements e where e.client_id = c.id and e.feature = 'seo' and e.status = 'active')
  and exists (
    select 1 from seo_locations l
     where l.client_id = c.id and l.is_active and l.website_url is not null
       and exists (select 1 from seo_keywords k where k.location_id = l.id)
  );

revoke all on seo_content_targets from authenticated, anon;
grant select on seo_content_targets to service_role;

create or replace function request_seo_content(p_client_id uuid)
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
    raise notice 'pg_net not installed — cannot request content generation';
    return null;
  end if;

  if not start_job_attempt(p_client_id, 'seo_content', null) then
    return null;  -- not due yet, or already in flight
  end if;

  -- The model and image calls are throttled INSIDE the function, per call.
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'seo_content_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'voice_tool_secret';

  if v_url is null or v_secret is null then
    raise notice 'seo_content_url / voice_tool_secret not in Vault — cannot request content generation';
    perform complete_job_attempt(p_client_id, 'seo_content', false, 'missing_vault_secret', 10080, 1440, null);
    return null;
  end if;

  -- Generous timeout: an article is a model call, an image render and an upload,
  -- and a run may write up to three of them.
  execute
    'select net.http_post(url := $1, headers := $2, body := $3, timeout_milliseconds := 300000)'
    into v_req
    using
      v_url,
      jsonb_build_object('Content-Type', 'application/json', 'x-voice-tool-secret', v_secret),
      jsonb_build_object('client_id', p_client_id::text);

  update job_attempts set dispatched_request_id = v_req
   where client_id = p_client_id and job_type = 'seo_content' and entity_id is null;

  return v_req;
end;
$$;

revoke execute on function request_seo_content(uuid) from public, authenticated;
grant execute on function request_seo_content(uuid) to service_role;

create or replace function run_due_seo_contents(p_max_per_run int default 10)
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
    select client_id from seo_content_targets
     where is_due
     order by next_run_at asc nulls first
     limit greatest(p_max_per_run, 1)
  loop
    if request_seo_content(v_row.client_id) is null then
      v_skipped := v_skipped + 1;
    else
      v_requested := v_requested + 1;
    end if;
  end loop;
  return jsonb_build_object('requested', v_requested, 'skipped', v_skipped, 'ran_at', now());
end;
$$;

revoke execute on function run_due_seo_contents(int) from public, authenticated;
grant execute on function run_due_seo_contents(int) to service_role;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron not installed — automatic content generation NOT scheduled.';
    return;
  end if;
  begin
    perform cron.unschedule('seo-content-due');
  exception when others then null;
  end;
  -- Hourly tick; the weekly cadence is the job's 10080-minute base interval.
  perform cron.schedule('seo-content-due', '40 * * * *', $cron$select run_due_seo_contents();$cron$);
end;
$$;

comment on table seo_content_posts is
  'Service-only ledger for module 16''s uniqueness checks (plain text + embeddings). The article itself '
  'lives in seo_actions.proposed_value, where 0054''s trigger keeps it read-only to the tenant.';

-- End of 0056.

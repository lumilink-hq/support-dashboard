-- =============================================================================
-- 0084_seo_role_checks.sql — the rest of the role checks (after 0083): viewers
-- are read-only on /seo, and connecting Google is admin-only.
--
-- Same method as 0083: RESTRICTIVE policies (ANDed with the tenant policies,
-- `to authenticated` only, so they can only narrow access), plus a guard in
-- each SECURITY DEFINER RPC, whose bodies are otherwise byte-identical to the
-- migration named above each one.
--
--   admin + agent : keywords, competitors, AI queries, location details and
--                   settings, finding dismissals, suggestion/gap/link
--                   dismissals, run-now, Business Profile linking, and reading
--                   the Google access token (it can edit the Business Profile
--                   at Google directly, so a viewer must not be handed it).
--   admin only    : storing and disconnecting the Google connection.
--
-- NOT HERE: propose_seo_gbp_categories (0081). 0081 is another session's
-- migration and was unpushed when this was written; copying its body here
-- would freeze a version that may still change. The /seo server action checks
-- the role; the database guard belongs in 0081 itself (or a later migration
-- once 0081 has shipped).
--
-- Report generation and Shopify connect have no tenant database write: the
-- report runs in an edge function behind the server's secret, and Shopify
-- connect is Shopify's own OAuth. Both are gated in the app.
-- =============================================================================

create or replace function public.current_user_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.users
     where id = auth.uid() and is_active and role = 'admin'
  );
$$;

revoke all on function public.current_user_is_admin() from public, anon;
grant execute on function public.current_user_is_admin() to authenticated;


-- -----------------------------------------------------------------------------
-- Tables a tenant writes directly (tenant policies FOR ALL, from 0042 onward).
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['seo_keywords', 'seo_competitors', 'seo_ai_queries',
                           'seo_locations', 'seo_location_details'] loop
    execute format('drop policy if exists %I on public.%I', t || '_role_insert', t);
    execute format('create policy %I on public.%I as restrictive for insert to authenticated
                      with check (public.current_user_can_act())', t || '_role_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_role_update', t);
    execute format('create policy %I on public.%I as restrictive for update to authenticated
                      using (public.current_user_can_act()) with check (public.current_user_can_act())', t || '_role_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_role_delete', t);
    execute format('create policy %I on public.%I as restrictive for delete to authenticated
                      using (public.current_user_can_act())', t || '_role_delete', t);
  end loop;
end $$;

-- seo_findings: tenants may only dismiss (update), per 0042.
drop policy if exists seo_findings_role_update on public.seo_findings;
create policy seo_findings_role_update on public.seo_findings
  as restrictive for update to authenticated
  using (public.current_user_can_act())
  with check (public.current_user_can_act());


-- -----------------------------------------------------------------------------
-- decide_seo_detail_suggestions — same as 0071 plus the role guard.
-- -----------------------------------------------------------------------------
create or replace function decide_seo_detail_suggestions(p_location_id uuid, p_ids uuid[], p_status text)
returns int
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_client uuid := current_client_id();
  v_n      int;
begin
  -- 0084: viewers are read-only.
  if not current_user_can_act() then
    raise exception 'You have view-only access.' using errcode = '42501';
  end if;
  if v_client is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_status not in ('accepted', 'dismissed') then
    raise exception 'status must be accepted or dismissed' using errcode = '22023';
  end if;
  update seo_detail_suggestions s
     set status = p_status, decided_at = now(), decided_by = auth.uid()
   where s.id = any(coalesce(p_ids, '{}'))
     and s.location_id = p_location_id
     and s.client_id = v_client
     and s.status = 'open'
     and exists (select 1 from seo_locations l where l.id = p_location_id and l.client_id = v_client);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke execute on function decide_seo_detail_suggestions(uuid, uuid[], text) from public, anon;
grant execute on function decide_seo_detail_suggestions(uuid, uuid[], text) to authenticated, service_role;


-- -----------------------------------------------------------------------------
-- dismiss_seo_keyword_suggestion — same as 0062 plus the role guard.
-- -----------------------------------------------------------------------------
create or replace function dismiss_seo_keyword_suggestion(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_client uuid := current_client_id();
  v_count  int;
begin
  -- 0084: viewers are read-only.
  if not current_user_can_act() then
    return false;
  end if;
  if v_client is null then
    return false;
  end if;
  update seo_keyword_suggestions
     set status = 'dismissed', dismissed_at = now()
   where id = p_id and client_id = v_client and status = 'open';
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

revoke execute on function dismiss_seo_keyword_suggestion(uuid) from public, anon;
grant execute on function dismiss_seo_keyword_suggestion(uuid) to authenticated, service_role;


-- -----------------------------------------------------------------------------
-- dismiss_seo_competitor_gap — same as 0063 plus the role guard.
-- -----------------------------------------------------------------------------
create or replace function dismiss_seo_competitor_gap(p_keyword text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_client  uuid := current_client_id();
  v_keyword text := lower(btrim(regexp_replace(coalesce(p_keyword, ''), '\s+', ' ', 'g')));
begin
  -- 0084: viewers are read-only.
  if not current_user_can_act() then
    return false;
  end if;
  if v_client is null or length(v_keyword) < 2 or length(v_keyword) > 80 then
    return false;
  end if;
  insert into seo_competitor_gap_dismissals (client_id, keyword)
  values (v_client, v_keyword)
  on conflict (client_id, keyword) do nothing;
  return true;
end;
$$;

revoke execute on function dismiss_seo_competitor_gap(text) from public, anon;
grant execute on function dismiss_seo_competitor_gap(text) to authenticated, service_role;


-- -----------------------------------------------------------------------------
-- dismiss_seo_link_opportunity — same as 0066 plus the role guard.
-- -----------------------------------------------------------------------------
create or replace function dismiss_seo_link_opportunity(p_domain text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_client uuid := current_client_id();
  v_domain text := lower(btrim(coalesce(p_domain, '')));
begin
  -- 0084: viewers are read-only.
  if not current_user_can_act() then
    return false;
  end if;
  if v_client is null or v_domain !~ '^[a-z0-9.-]+\.[a-z]{2,}$' then
    return false;
  end if;
  insert into seo_link_dismissals (client_id, referring_domain)
  values (v_client, v_domain)
  on conflict (client_id, referring_domain) do nothing;
  return true;
end;
$$;

revoke execute on function dismiss_seo_link_opportunity(text) from public, anon;
grant execute on function dismiss_seo_link_opportunity(text) to authenticated, service_role;


-- -----------------------------------------------------------------------------
-- request_seo_run_now — same as 0073 plus the role guard.
-- -----------------------------------------------------------------------------
create or replace function request_seo_run_now(p_location_id uuid, p_job_type text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_client  uuid := current_client_id();
  v_job     record;
  v_entity  uuid;
  v_primary uuid;
  v_row     record;
begin
  -- 0084: viewers are read-only.
  if not current_user_can_act() then
    return 'not_allowed';
  end if;
  if v_client is null or not exists (
    select 1 from seo_locations where id = p_location_id and client_id = v_client and is_active
  ) then
    return 'not_found';
  end if;

  select * into v_job from seo_run_now_jobs() j where j.job_type = p_job_type;
  if not found then
    return 'unknown_job';
  end if;

  if v_job.scope = 'client' then
    v_entity := null;
  elsif v_job.scope = 'site' then
    select s.primary_location_id into v_primary from seo_site_locations s where s.location_id = p_location_id;
    v_entity := coalesce(v_primary, p_location_id);
  else
    v_entity := p_location_id;
  end if;

  select * into v_row
    from job_attempts ja
   where ja.client_id = v_client and ja.job_type = p_job_type
     and ja.entity_id is not distinct from v_entity
   for update;

  -- Never run: the job's targets view already treats it as due.
  if not found or v_row.next_run_at is null or v_row.next_run_at <= now() then
    return 'already_due';
  end if;
  if v_row.status = 'running' and v_row.dispatched_at > now() - interval '30 minutes' then
    return 'running';
  end if;
  if v_row.last_run_at is not null and v_row.last_run_at > now() - v_job.cooldown then
    return 'cooldown';
  end if;

  update job_attempts
     set next_run_at = now()
   where client_id = v_client and job_type = p_job_type
     and entity_id is not distinct from v_entity;
  return 'ok';
end;
$$;

revoke execute on function request_seo_run_now(uuid, text) from public, anon;
grant execute on function request_seo_run_now(uuid, text) to authenticated, service_role;


-- -----------------------------------------------------------------------------
-- link_seo_gbp_location — same as 0076 plus the role guard.
-- -----------------------------------------------------------------------------
create or replace function link_seo_gbp_location(p_location_name text, p_location_id uuid)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_client uuid := current_client_id();
  v_row    seo_gbp_locations%rowtype;
begin
  -- 0084: viewers are read-only.
  if not current_user_can_act() then
    return 'not_allowed';
  end if;
  if v_client is null then
    return 'not_found';
  end if;

  select * into v_row from seo_gbp_locations
   where client_id = v_client and location_name = p_location_name
   for update;
  if not found then
    return 'not_found';
  end if;

  if p_location_id is not null and not exists (
    select 1 from seo_locations where id = p_location_id and client_id = v_client
  ) then
    return 'location_not_found';
  end if;

  if v_row.linked_location_id is not distinct from p_location_id then
    return 'ok';
  end if;

  -- Whatever profile held the target location lets go of it (one-to-one).
  if p_location_id is not null then
    update seo_gbp_locations
       set linked_location_id = null, link_source = null, linked_at = null
     where client_id = v_client and linked_location_id = p_location_id;
    update seo_locations
       set gbp_location_name = null, gbp_account_id = null, google_place_id = null, gbp_connected_at = null
     where client_id = v_client and id = p_location_id;
  end if;

  -- The location this profile used to feed forgets it.
  if v_row.linked_location_id is not null then
    update seo_locations
       set gbp_location_name = null, gbp_account_id = null, google_place_id = null, gbp_connected_at = null
     where client_id = v_client and id = v_row.linked_location_id;
  end if;

  update seo_gbp_locations
     set linked_location_id = p_location_id,
         link_source = case when p_location_id is null then null else 'manual' end,
         linked_at = case when p_location_id is null then null else now() end,
         -- A new location gets its own six-month backfill and review pull.
         metrics_through = null, metrics_backfilled_at = null, metrics_error = null,
         reviews_status = 'pending', reviews_backfilled_at = null, reviews_page_token = null,
         reviews_synced_at = null, reviews_error = null
   where client_id = v_client and location_name = p_location_name;

  update seo_gbp_reviews
     set location_id = p_location_id
   where client_id = v_client and location_name = p_location_name;

  if p_location_id is not null then
    update seo_locations
       set gbp_location_name = p_location_name,
           gbp_account_id = v_row.account_name,
           google_place_id = coalesce(v_row.place_id, google_place_id),
           gbp_connected_at = now()
     where client_id = v_client and id = p_location_id;

    -- Pull the new link's data soon rather than tomorrow.
    update job_attempts
       set next_run_at = least(coalesce(next_run_at, now()), now() + interval '15 minutes')
     where client_id = v_client and job_type = 'seo_gbp_sync' and entity_id is null
       and status <> 'running';
  end if;

  return 'ok';
end;
$$;

revoke execute on function link_seo_gbp_location(text, uuid) from public, anon;
grant execute on function link_seo_gbp_location(text, uuid) to authenticated, service_role;


-- -----------------------------------------------------------------------------
-- store_google_oauth_tokens — same as 0046 plus the admin guard.
-- -----------------------------------------------------------------------------
create or replace function store_google_oauth_tokens(
  p_refresh_token text,
  p_access_token  text,
  p_expires_at    timestamptz,
  p_scopes        text[],
  p_account_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_client_id uuid := current_client_id();
  v_secret_id uuid;
begin
  -- 0084: connecting Google is admin-only.
  if not current_user_is_admin() then
    return jsonb_build_object('ok', false, 'error', 'not_admin');
  end if;
  if v_client_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_signed_in');
  end if;
  -- A renewal/re-consent may not carry a fresh refresh token at all — Google
  -- only issues one on the FIRST consent (or with prompt=consent). Update the
  -- access token and scopes without touching the stored refresh token when
  -- none is supplied, rather than clobbering a working connection.
  if p_refresh_token is not null and length(trim(p_refresh_token)) > 0 then
    select refresh_token_secret_id into v_secret_id
      from google_oauth_tokens where client_id = v_client_id;

    if v_secret_id is not null then
      perform vault.update_secret(v_secret_id, p_refresh_token);
    else
      v_secret_id := vault.create_secret(
        p_refresh_token,
        'google_refresh_token:' || v_client_id::text,
        'Google OAuth refresh token for client ' || v_client_id::text);
    end if;
  else
    select refresh_token_secret_id into v_secret_id
      from google_oauth_tokens where client_id = v_client_id;
    if v_secret_id is null then
      return jsonb_build_object('ok', false, 'error', 'no_refresh_token_on_first_connect');
    end if;
  end if;

  insert into google_oauth_tokens
    (client_id, refresh_token_secret_id, access_token_cache, access_token_expires_at)
  values (v_client_id, v_secret_id, p_access_token, p_expires_at)
  on conflict (client_id) do update
    set refresh_token_secret_id = excluded.refresh_token_secret_id,
        access_token_cache      = excluded.access_token_cache,
        access_token_expires_at = excluded.access_token_expires_at,
        updated_at              = now();

  insert into google_oauth_connections
    (client_id, google_account_email, granted_scopes, status, last_refreshed_at)
  values (v_client_id, p_account_email, coalesce(p_scopes, '{}'), 'connected', now())
  on conflict (client_id) do update
    set google_account_email = coalesce(excluded.google_account_email,
                                         google_oauth_connections.google_account_email),
        granted_scopes = (
          select coalesce(array_agg(distinct s), '{}')
          from unnest(google_oauth_connections.granted_scopes || excluded.granted_scopes) s
        ),
        status = 'connected',
        last_refreshed_at = now(),
        last_error = null,
        updated_at = now();

  return jsonb_build_object('ok', true, 'client_id', v_client_id);
end;
$$;

revoke execute on function store_google_oauth_tokens(text, text, timestamptz, text[], text) from public, anon;
grant execute on function store_google_oauth_tokens(text, text, timestamptz, text[], text) to authenticated, service_role;


-- -----------------------------------------------------------------------------
-- disconnect_google_oauth — same as 0046 plus the admin guard.
-- -----------------------------------------------------------------------------
create or replace function disconnect_google_oauth()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_client_id uuid := current_client_id();
  v_secret_id uuid;
begin
  -- 0084: connecting Google is admin-only.
  if not current_user_is_admin() then
    return jsonb_build_object('ok', false, 'error', 'not_admin');
  end if;
  if v_client_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_signed_in');
  end if;

  select refresh_token_secret_id into v_secret_id
    from google_oauth_tokens where client_id = v_client_id;

  delete from google_oauth_tokens where client_id = v_client_id;
  delete from google_oauth_connections where client_id = v_client_id;

  if v_secret_id is not null then
    delete from vault.secrets where id = v_secret_id;
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function disconnect_google_oauth() from public, anon;
grant execute on function disconnect_google_oauth() to authenticated, service_role;


-- -----------------------------------------------------------------------------
-- get_my_google_access_token — same as 0047, but only for admins and agents.
-- -----------------------------------------------------------------------------
create or replace function get_my_google_access_token()
returns text
language sql
stable
security definer
set search_path = public, extensions
as $$
  select access_token_cache from google_oauth_tokens
   where client_id = current_client_id()
     -- 0084: the token can edit the client's Business Profile at Google
     -- directly; viewers don't get it.
     and current_user_can_act();
$$;

revoke execute on function get_my_google_access_token() from public, anon;
grant execute on function get_my_google_access_token() to authenticated, service_role;

-- Verify: scripts/test_seo_role_checks.sql (runs in a rolled-back transaction).

-- End of 0084.

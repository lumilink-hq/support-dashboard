-- =============================================================================
-- 0085_gbp_categories_role_check.sql — the one RPC 0084 left out.
--
-- propose_seo_gbp_categories (0081) creates an APPROVED seo_actions row: the
-- category pick is the approval. 0084 didn't copy it because 0081 was another
-- session's unpushed migration at the time. Both are live now, so: same body
-- as 0081 plus the 0083 role guard, so a viewer calling it directly gets
-- 'not_allowed' instead of changing the Business Profile.
-- =============================================================================

create or replace function propose_seo_gbp_categories(p_location_id uuid, p_categories jsonb)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_client   uuid := current_client_id();
  v_listing  seo_gbp_locations%rowtype;
  v_primary  text;
  v_current  jsonb;
  v_names    text[];
  v_finding  uuid;
  v_item     jsonb;
begin
  -- 0085: viewers are read-only (0083/0084).
  if not current_user_can_act() then
    return 'not_allowed';
  end if;
  if v_client is null or auth.uid() is null or not exists (
    select 1 from seo_locations where id = p_location_id and client_id = v_client and is_active
  ) then
    return 'not_found';
  end if;

  select * into v_listing from seo_gbp_locations
   where client_id = v_client and linked_location_id = p_location_id;
  if not found then
    return 'not_linked';
  end if;

  if p_categories is null or jsonb_typeof(p_categories) <> 'array' or jsonb_array_length(p_categories) > 9 then
    return 'invalid';
  end if;
  for v_item in select * from jsonb_array_elements(p_categories) loop
    if jsonb_typeof(v_item) <> 'object'
       or coalesce(v_item->>'name', '') !~ '^categories/gcid:[a-z0-9_]+$'
       or length(coalesce(v_item->>'displayName', '')) not between 1 and 100 then
      return 'invalid';
    end if;
  end loop;

  select array_agg(distinct e->>'name' order by e->>'name') into v_names
    from jsonb_array_elements(p_categories) e;
  v_names := coalesce(v_names, '{}');
  if cardinality(v_names) <> jsonb_array_length(p_categories) then
    return 'invalid';  -- duplicates
  end if;

  v_primary := v_listing.profile #>> '{categories,primaryCategory,name}';
  if v_primary is not null and v_primary = any(v_names) then
    return 'invalid';  -- the primary can't double as an additional category
  end if;

  v_current := coalesce(v_listing.profile #> '{categories,additionalCategories}', '[]'::jsonb);
  if v_names = coalesce((select array_agg(distinct e->>'name' order by e->>'name') from jsonb_array_elements(v_current) e), '{}') then
    return 'unchanged';
  end if;

  select id into v_finding from seo_findings
   where location_id = p_location_id and module = 'gbp_profile'
     and finding_type = 'gbp_no_additional_categories' and status = 'open'
   limit 1;

  begin
    insert into seo_actions (
      client_id, location_id, finding_id, action_type, target_field, finding_type, target_url,
      previous_value, proposed_value, diff, status, idempotency_key, drafted_by, approved_by, approved_at
    ) values (
      v_client, p_location_id, v_finding, 'gbp_field_update', 'gbp_additional_categories',
      'gbp_no_additional_categories', v_listing.maps_uri,
      jsonb_build_object('categories', v_current),
      jsonb_build_object('value', to_jsonb(v_names)::text, 'categories', p_categories),
      jsonb_build_object(
        'field', 'gbp_additional_categories',
        'before', nullif((select string_agg(e->>'displayName', ', ' order by e->>'displayName') from jsonb_array_elements(v_current) e), ''),
        'after', coalesce((select string_agg(e->>'displayName', ', ' order by e->>'displayName') from jsonb_array_elements(p_categories) e), 'No additional categories'),
        'scope', 'store'
      ),
      'approved',
      'gbp-categories:' || gen_random_uuid()::text,
      'person',
      auth.uid(),
      now()
    );
  exception when unique_violation then
    return 'already_pending';
  end;

  if v_finding is not null then
    update seo_findings set status = 'actioned' where id = v_finding;
  end if;

  -- Publish at the next 5-minute tick instead of whenever the job is next due.
  update job_attempts set next_run_at = now()
   where client_id = v_client and job_type = 'seo_publish' and entity_id = p_location_id
     and status <> 'running' and next_run_at > now();

  return 'ok';
end;
$$;

revoke execute on function propose_seo_gbp_categories(uuid, jsonb) from public, anon;
grant execute on function propose_seo_gbp_categories(uuid, jsonb) to authenticated, service_role;

-- Verify: scripts/test_seo_role_checks.sql (runs in a rolled-back transaction).

-- End of 0085.

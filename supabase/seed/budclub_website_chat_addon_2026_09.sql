-- =============================================================================
-- budclub_website_chat_addon_2026_09.sql — record that Bud Club (budmember001)
-- holds the Website Chat add-on, so /billing shows "Active" instead of an
-- "Add To Plan" button.
--
-- CONTEXT: the Stripe subscription item was added by hand (jay@budclub.com /
-- Jimmy Ngo), outside the self-serve Payment Link flow — so nothing wrote a
-- client_addons row (0039) automatically the way a webhook-driven purchase
-- eventually could. This is that manual write, source='manual', matching how
-- entitlements already records a comped/onboarding grant the same way.
--
-- NOT a migration. Per-client data, run by hand. Safe to re-run — the unique
-- (client_id, addon_key) constraint makes this an upsert.
-- =============================================================================

do $$
declare
  v_id uuid;
begin
  select id into v_id from clients where slug = 'budmember001';
  if v_id is null then
    raise exception 'No client with slug "budmember001". Nothing was configured.';
  end if;
  raise notice 'Granting website_chat to client % (budmember001)', v_id;
end;
$$;

insert into client_addons (client_id, addon_key, status, source)
select id, 'website_chat', 'active', 'manual'
  from clients where slug = 'budmember001'
on conflict (client_id, addon_key) do update
  set status = excluded.status,
      source = excluded.source,
      canceled_at = null;

-- Verify:
select c.slug, a.addon_key, a.status, a.source, a.started_at
  from client_addons a
  join clients c on c.id = a.client_id
 where c.slug = 'budmember001';

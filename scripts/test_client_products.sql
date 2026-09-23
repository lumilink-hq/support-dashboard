-- =============================================================================
-- test_client_products.sql — non-destructive test of 0059: signup writes the
-- product and the industry separately, the voice agent mode follows the
-- industry only for phone clients, and the constraints hold.
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/test_client_products.sql
--   (local stack: docker exec -i supabase_db_support-dashboard psql -U postgres -v ON_ERROR_STOP=1 < scripts/test_client_products.sql)
--
-- To see it FAIL:
--   * delete the `if not ('voice' = any(new.products))` block from
--     sync_voice_agent_mode()
--     -> "seo-only signup: no voice_agent_mode" fails.
--   * delete the `if v_biz_type = 'seo'` block from handle_new_user()
--     -> "legacy business_type=seo metadata: products = {seo}" fails.
--
-- Wraps everything in a transaction and ROLLS BACK.
-- =============================================================================

begin;

do $$
declare
  v_row   record;
  v_id    uuid;
  v_ok    boolean;
begin
  -- Each signup below inserts an auth user, which fires handle_new_user.
  -- ---------------------------------------------------------------------------
  -- Signup: phone agent, service industry
  -- ---------------------------------------------------------------------------
  v_id := gen_random_uuid();
  insert into auth.users (id, email, raw_user_meta_data)
  values (v_id, 'p-voice@example.com',
          '{"business_name":"Products Voice Co","business_type":"service","product":"voice"}');
  select c.business_type, c.products, c.settings ->> 'voice_agent_mode' as mode
    into v_row from clients c join users u on u.client_id = c.id where u.id = v_id;
  assert v_row.products = array['voice'], 'voice signup: products = {voice}';
  assert v_row.business_type = 'service', 'voice signup: industry kept';
  assert v_row.mode = 'scheduling', 'voice signup: service -> scheduling mode';

  -- ---------------------------------------------------------------------------
  -- Signup: Local SEO, ecommerce industry. No phone agent, so no agent mode.
  -- ---------------------------------------------------------------------------
  v_id := gen_random_uuid();
  insert into auth.users (id, email, raw_user_meta_data)
  values (v_id, 'p-seo@example.com',
          '{"business_name":"Products SEO Co","business_type":"ecommerce","product":"seo"}');
  select c.id, c.business_type, c.products, c.settings ->> 'voice_agent_mode' as mode
    into v_row from clients c join users u on u.client_id = c.id where u.id = v_id;
  assert v_row.products = array['seo'], 'seo signup: products = {seo}';
  assert v_row.business_type = 'ecommerce', 'seo signup: industry kept';
  assert v_row.mode is null, 'seo-only signup: no voice_agent_mode';

  -- ... then it adds the phone agent: the mode appears from the industry.
  update clients set products = array['seo', 'voice'] where id = v_row.id;
  select settings ->> 'voice_agent_mode' as mode into v_row from clients where id = v_row.id;
  assert v_row.mode = 'orders', 'adding voice to an ecommerce client -> orders mode';

  -- ---------------------------------------------------------------------------
  -- Legacy metadata from the previous app build: business_type = 'seo'
  -- ---------------------------------------------------------------------------
  v_id := gen_random_uuid();
  insert into auth.users (id, email, raw_user_meta_data)
  values (v_id, 'p-legacy@example.com',
          '{"business_name":"Products Legacy Co","business_type":"seo"}');
  select c.business_type, c.products into v_row
    from clients c join users u on u.client_id = c.id where u.id = v_id;
  assert v_row.products = array['seo'], 'legacy business_type=seo metadata: products = {seo}';
  assert v_row.business_type is null, 'legacy business_type=seo metadata: industry null';

  -- ---------------------------------------------------------------------------
  -- Junk metadata: dropped, never trusted
  -- ---------------------------------------------------------------------------
  v_id := gen_random_uuid();
  insert into auth.users (id, email, raw_user_meta_data)
  values (v_id, 'p-junk@example.com',
          '{"business_name":"Products Junk Co","business_type":"casino","product":"everything"}');
  select c.business_type, c.products into v_row
    from clients c join users u on u.client_id = c.id where u.id = v_id;
  assert v_row.products = array['voice'], 'junk product -> voice';
  assert v_row.business_type is null, 'junk industry -> null';

  -- ---------------------------------------------------------------------------
  -- Constraints
  -- ---------------------------------------------------------------------------
  v_ok := false;
  begin
    update clients set products = array['voice', 'chat'] where slug = 'products-voice-co';
  exception when check_violation then v_ok := true;
  end;
  assert v_ok, 'products rejects an unknown product';

  v_ok := false;
  begin
    update clients set business_type = 'seo' where slug = 'products-voice-co';
  exception when check_violation then v_ok := true;
  end;
  assert v_ok, 'business_type no longer accepts seo';

  -- A plain settings save must not reset a hand-set mode.
  update clients set settings = settings || '{"voice_agent_mode":"orders"}' where slug = 'products-voice-co';
  update clients set settings = settings || '{"other":1}' where slug = 'products-voice-co';
  select settings ->> 'voice_agent_mode' as mode into v_row from clients where slug = 'products-voice-co';
  assert v_row.mode = 'orders', 'unrelated update keeps a hand-set mode';

  -- No client is left with the old product-as-industry value.
  assert not exists (select 1 from clients where business_type = 'seo'), 'backfill: no business_type = seo';

  raise notice 'test_client_products: all assertions passed';
end $$;

rollback;

-- =============================================================================
-- seed.sql — sample data so the dashboard renders real rows from day one.
-- Email-only, WooCommerce-shaped. Runs via `supabase db reset` (after the
-- migration in supabase/migrations/).
--
-- One tenant ("Acme Outdoors"), a handful of email conversations, a normalized
-- orders_cache (recent/normal, stale >24h, abnormal on-hold), review_queue
-- items, and a local demo dashboard user mapped to the tenant.
--
-- Fixed UUIDs + ON CONFLICT DO NOTHING make this safe to re-run.
-- Timestamps are relative to now() so the >24h flag rule is demonstrable.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Tenant
-- -----------------------------------------------------------------------------
insert into clients (id, name, slug, is_active, store_platform, store_base_url,
                     store_credentials_ref, shipstation_credentials_ref,
                     support_email, phone_number,
                     brand_tone_config, abnormal_status_rules, business_hours, settings)
values (
  '11111111-0000-0000-0000-000000000001',
  'Acme Outdoors', 'acme-outdoors', true,
  'woocommerce', 'https://shop.acmeoutdoors.example',
  'vault://acme/woocommerce',            -- pointer only; never the raw key
  null,                                  -- ShipStation not wired yet (TBD)
  'support@acmeoutdoors.example', null,  -- phone_number null until voice is on
  '{"voice":"warm, concise, helpful","sign_off":"— The Acme Outdoors Team","use_emoji":false}'::jsonb,
  '{"abnormal_statuses":["on-hold","failed","refunded","cancelled"],"stale_after_hours":24}'::jsonb,
  '{"tz":"America/New_York","mon_fri":"09:00-17:00","sat":"10:00-14:00","sun":"closed"}'::jsonb,
  '{}'::jsonb
)
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- orders_cache — normalized snapshots (what the order panel reads).
--   1042: processing, placed 3h ago  -> normal, not stale, not shipped
--   1039: completed,  placed 5d ago  -> stale (>24h); ShipStation tracking filled
--   1051: on-hold,    placed 30h ago -> abnormal AND stale
-- -----------------------------------------------------------------------------
insert into orders_cache (id, client_id, order_number, store_platform, store_status,
                          is_abnormal, customer_name, customer_email, currency, order_total,
                          order_placed_at, line_items,
                          tracking_number, carrier, shipping_status, shipped_at, estimated_delivery,
                          raw_store, raw_shipping, fetched_at)
values
(
  '33333333-0000-0000-0000-000000001042',
  '11111111-0000-0000-0000-000000000001', '1042', 'woocommerce', 'processing',
  false, 'Jane Doe', 'jane.doe@example.com', 'USD', 248.00,
  now() - interval '3 hours',
  '[{"sku":"TENT-2P","name":"Trailhead 2-Person Tent","quantity":1,"total":"199.00"},
    {"sku":"STAKE-8","name":"Aluminum Stakes (8-pack)","quantity":1,"total":"49.00"}]'::jsonb,
  null, null, null, null, null,
  '{"id":1042,"status":"processing","payment_method_title":"Visa"}'::jsonb,
  '{}'::jsonb,
  now() - interval '10 minutes'
),
(
  '33333333-0000-0000-0000-000000001039',
  '11111111-0000-0000-0000-000000000001', '1039', 'woocommerce', 'completed',
  false, 'Mike Ross', 'mike.ross@example.com', 'USD', 89.50,
  now() - interval '5 days',
  '[{"sku":"BOTTLE-1L","name":"Insulated Bottle 1L","quantity":1,"total":"39.50"},
    {"sku":"SOCK-MERINO","name":"Merino Hiking Socks","quantity":2,"total":"50.00"}]'::jsonb,
  '9400111899223817567', 'USPS', 'in_transit',
  now() - interval '4 days', now() + interval '1 day',
  '{"id":1039,"status":"completed"}'::jsonb,
  '{"orderId":1039,"carrierCode":"usps","trackingNumber":"9400111899223817567"}'::jsonb,
  now() - interval '20 minutes'
),
(
  '33333333-0000-0000-0000-000000001051',
  '11111111-0000-0000-0000-000000000001', '1051', 'woocommerce', 'on-hold',
  true, 'Sara Lin', 'sara.lin@example.com', 'USD', 312.75,
  now() - interval '30 hours',
  '[{"sku":"PACK-65L","name":"Summit 65L Backpack","quantity":1,"total":"289.00"},
    {"sku":"RAINCOVER","name":"Pack Rain Cover","quantity":1,"total":"23.75"}]'::jsonb,
  null, null, null, null, null,
  '{"id":1051,"status":"on-hold","customer_note":"Please verify shipping address"}'::jsonb,
  '{}'::jsonb,
  now() - interval '15 minutes'
)
on conflict (client_id, order_number) do nothing;

-- -----------------------------------------------------------------------------
-- conversations (email) + messages
--   conv1 (1042): open, normal thread
--   conv2 (1051): flagged abnormal (on-hold)
--   conv3 (1039): flagged stale (>24h old order)
--   conv4:        awaiting_customer — no order id yet (the email "ask for it" rule)
-- -----------------------------------------------------------------------------
insert into conversations (id, client_id, channel, customer_identifier, customer_name,
                           subject, status, flagged, flag_reason, order_number,
                           external_ref, created_at, updated_at, last_message_at)
values
('22222222-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','email',
 'jane.doe@example.com','Jane Doe','Where is my order #1042?','open',false,null,'1042',
 'gmail-thread-1042', now() - interval '2 hours', now() - interval '90 minutes', now() - interval '90 minutes'),

('22222222-0000-0000-0000-000000000002','11111111-0000-0000-0000-000000000001','email',
 'sara.lin@example.com','Sara Lin','Order #1051 — has it shipped?','flagged',true,'abnormal_status','1051',
 'gmail-thread-1051', now() - interval '40 minutes', now() - interval '38 minutes', now() - interval '38 minutes'),

('22222222-0000-0000-0000-000000000003','11111111-0000-0000-0000-000000000001','email',
 'mike.ross@example.com','Mike Ross','Returns question on order 1039','flagged',true,'order_over_24h','1039',
 'gmail-thread-1039', now() - interval '6 hours', now() - interval '5 hours', now() - interval '5 hours'),

('22222222-0000-0000-0000-000000000004','11111111-0000-0000-0000-000000000001','email',
 'newcustomer@example.com','Pat Quinn','Problem with my recent order','awaiting_customer',false,null,null,
 'gmail-thread-misc', now() - interval '25 minutes', now() - interval '24 minutes', now() - interval '24 minutes')
on conflict (id) do nothing;

insert into messages (id, conversation_id, client_id, role, body, audio_url, model, meta, external_ref, created_at)
values
-- conv1
('66666666-0000-0000-0000-000000000011','22222222-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001',
 'customer','Hi, I ordered a tent (#1042) a few hours ago and wanted to check when it ships. Thanks! - Jane',
 null,null,'{}'::jsonb,'gmail-msg-1042-1', now() - interval '2 hours'),
('66666666-0000-0000-0000-000000000012','22222222-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001',
 'agent','Hi Jane! Order #1042 is being processed and hasn''t shipped yet. You''ll get a tracking email as soon as it does. — The Acme Outdoors Team',
 null,'claude-haiku-4-5','{"input_tokens":820,"output_tokens":48}'::jsonb,'gmail-msg-1042-2', now() - interval '90 minutes'),
-- conv2 (flagged abnormal)
('66666666-0000-0000-0000-000000000021','22222222-0000-0000-0000-000000000002','11111111-0000-0000-0000-000000000001',
 'customer','Order #1051 still says nothing on my end. Has it shipped yet?',
 null,null,'{}'::jsonb,'gmail-msg-1051-1', now() - interval '40 minutes'),
('66666666-0000-0000-0000-000000000022','22222222-0000-0000-0000-000000000002','11111111-0000-0000-0000-000000000001',
 'agent','Order #1051 is currently on hold, so I''ve flagged it for a team member to review and follow up with you shortly.',
 null,'claude-haiku-4-5','{"input_tokens":910,"output_tokens":40,"flagged":true}'::jsonb,'gmail-msg-1051-2', now() - interval '38 minutes'),
-- conv3 (flagged stale)
('66666666-0000-0000-0000-000000000031','22222222-0000-0000-0000-000000000003','11111111-0000-0000-0000-000000000001',
 'customer','I''d like to return the socks from order 1039. How do I start that?',
 null,null,'{}'::jsonb,'gmail-msg-1039-1', now() - interval '6 hours'),
-- conv4 (no order id)
('66666666-0000-0000-0000-000000000041','22222222-0000-0000-0000-000000000004','11111111-0000-0000-0000-000000000001',
 'customer','Something is wrong with my order, can you help?',
 null,null,'{}'::jsonb,'gmail-msg-misc-1', now() - interval '25 minutes'),
('66666666-0000-0000-0000-000000000042','22222222-0000-0000-0000-000000000004','11111111-0000-0000-0000-000000000001',
 'agent','Happy to help! Could you reply with your order number (it''s in your confirmation email, like #1042) so I can look it up?',
 null,'claude-haiku-4-5','{"input_tokens":760,"output_tokens":42}'::jsonb,'gmail-msg-misc-2', now() - interval '24 minutes')
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- review_queue — the human-review items behind the flagged conversations.
-- -----------------------------------------------------------------------------
insert into review_queue (id, client_id, conversation_id, reason, details, status, created_at)
values
('44444444-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001',
 '22222222-0000-0000-0000-000000000002','abnormal_status',
 'Order #1051 is in status on-hold (abnormal per client rules).','pending', now() - interval '38 minutes'),
('44444444-0000-0000-0000-000000000002','11111111-0000-0000-0000-000000000001',
 '22222222-0000-0000-0000-000000000003','order_over_24h',
 'Order #1039 was placed 5 days ago (older than 24h).','pending', now() - interval '5 hours')
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- Demo dashboard user (LOCAL DEV ONLY)
-- Creates a Supabase auth user and maps it to Acme so RLS-scoped reads return
-- data when you log in. Login: demo@acme.com / password
--
-- On a HOSTED project, do NOT run this block. Instead create the user via the
-- Auth dashboard/API, then:
--   insert into public.users (id, client_id, email, role)
--   values ('<auth-user-uuid>', '11111111-0000-0000-0000-000000000001', 'you@acme.com', 'admin');
-- -----------------------------------------------------------------------------
-- NOTE: GoTrue needs the token columns as empty strings (not NULL), and a
-- matching auth.identities row, or email/password sign-in fails even though the
-- auth.users row exists.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data,
                        confirmation_token, recovery_token,
                        email_change, email_change_token_new)
values (
  '00000000-0000-0000-0000-000000000000',
  '55555555-0000-0000-0000-000000000001',
  'authenticated','authenticated','demo@acme.com',
  crypt('password', gen_salt('bf')),
  now(), now(), now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
  '', '', '', ''
)
on conflict (id) do nothing;

-- Identity row — required for password sign-in. identity_data must carry `sub`.
insert into auth.identities (id, provider_id, user_id, identity_data, provider,
                             last_sign_in_at, created_at, updated_at)
values (
  gen_random_uuid(),
  '55555555-0000-0000-0000-000000000001',
  '55555555-0000-0000-0000-000000000001',
  jsonb_build_object(
    'sub', '55555555-0000-0000-0000-000000000001',
    'email', 'demo@acme.com',
    'email_verified', true,
    'phone_verified', false
  ),
  'email', now(), now(), now()
)
on conflict do nothing;

insert into public.users (id, client_id, email, full_name, role, is_active)
values (
  '55555555-0000-0000-0000-000000000001',
  '11111111-0000-0000-0000-000000000001',
  'demo@acme.com', 'Demo Admin', 'admin', true
)
on conflict (id) do nothing;

-- =============================================================================
-- Demonstrate the 0002 integration RPCs.
-- This runs one inbound email all the way through the pipeline the Zap will use,
-- so `supabase db reset` produces a conversation (#1055, Leo Park) built entirely
-- by the functions — visible flagged in the dashboard with a review item.
-- =============================================================================
do $$
declare
  v_client uuid := '11111111-0000-0000-0000-000000000001';
  v_conv   uuid;
  v_flag   jsonb;
begin
  -- 1. Inbound email arrives -> upsert conversation (by thread) + log message.
  v_conv := ingest_email(
    v_client,
    'gmail-thread-1055',            -- thread ref
    'gmail-msg-1055-1',             -- message ref (idempotency key)
    'leo.park@example.com', 'Leo Park',
    'Is order #1055 still processing?',
    'Hi, my order #1055 has been processing for a while — can you check? Thanks, Leo',
    '1055'                          -- order number (the triage step would extract this)
  );

  -- 2. Order fetched + normalized -> cached (stands in for the Woo/ShipStation step).
  insert into orders_cache (client_id, order_number, store_platform, store_status, is_abnormal,
                            customer_name, customer_email, currency, order_total, order_placed_at,
                            line_items, fetched_at)
  values (v_client, '1055', 'woocommerce', 'on-hold', true,
          'Leo Park', 'leo.park@example.com', 'USD', 142.00, now() - interval '2 days',
          '[{"sku":"JACKET-M","name":"Rain Jacket (M)","quantity":1,"total":"142.00"}]'::jsonb, now())
  on conflict (client_id, order_number) do nothing;

  -- 3. Evaluate the flag rule against the cached order.
  v_flag := evaluate_flag(v_client, 'on-hold', now() - interval '2 days');

  -- 4. Flagged (on-hold is abnormal) -> mark + enqueue for a human.
  if (v_flag ->> 'flagged')::boolean then
    perform apply_flag(v_conv, v_flag ->> 'reason', 'Order #1055 is on-hold (abnormal per client rules).');
  end if;

  -- 5. Auto-reply even when flagged: send a conservative holding message + log it.
  perform log_agent_reply(
    v_conv,
    'Thanks Leo! Order #1055 is currently on hold, so I''ve flagged it for a teammate who will follow up shortly.',
    'claude-haiku-4-5',
    'gmail-msg-1055-2',
    'flagged'
  );
end $$;

-- -----------------------------------------------------------------------------
-- Vault secrets for the demo client, so get_client_integration_secrets() resolves.
-- Guarded: if the Vault extension isn't present, skip without failing the reset.
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'acme_woocommerce') then
    perform vault.create_secret(
      '{"consumer_key":"ck_demo","consumer_secret":"cs_demo","base_url":"https://shop.acmeoutdoors.example"}',
      'acme_woocommerce', 'Acme WooCommerce API creds (demo)');
  end if;
  if not exists (select 1 from vault.secrets where name = 'acme_shipstation') then
    perform vault.create_secret(
      '{"api_key":"ss_demo","api_secret":"ss_secret_demo"}',
      'acme_shipstation', 'Acme ShipStation API creds (demo)');
  end if;

  update clients
    set store_credentials_ref       = 'acme_woocommerce',
        shipstation_credentials_ref = 'acme_shipstation',
        settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{order_number_scheme}', '"id"')
  where id = '11111111-0000-0000-0000-000000000001';
exception
  when undefined_table or invalid_schema_name or undefined_function then
    raise notice 'Supabase Vault not available; skipped secret seed (get_client_integration_secrets demo).';
end $$;

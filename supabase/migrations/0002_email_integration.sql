-- =============================================================================
-- 0002_email_integration.sql
-- Backend support for the live email Zap (Gmail → lookup → Claude → send → log).
--
-- The Zap runs as a service (service_role key, bypasses RLS). It resolves the
-- tenant from a plus-addressed alias (`proc+<slug>@...` → clients.slug), then
-- calls the RPCs below. These functions encapsulate the multi-step writes so the
-- Zap makes one call instead of several PostgREST round-trips — fewer Zapier
-- tasks, and the same flag logic the voice agent will reuse later.
--
-- Vault note: get_client_integration_secrets reads vault.decrypted_secrets.
-- Supabase enables the Vault extension by default; nothing to install here.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Idempotency / upsert targets
-- A re-fired Gmail trigger must not double-log. external_ref holds the Gmail
-- thread id (conversations) or message id (messages). NULLs stay distinct, so
-- rows without an external ref (e.g. seeded/voice) are unaffected.
-- -----------------------------------------------------------------------------
drop index if exists idx_conv_external_ref;
create unique index if not exists uq_conv_client_external_ref
  on conversations (client_id, external_ref);

create unique index if not exists uq_msg_client_external_ref
  on messages (client_id, external_ref);

-- -----------------------------------------------------------------------------
-- order_number_scheme convention (no DDL — stored in clients.settings JSONB).
-- -----------------------------------------------------------------------------
comment on column clients.settings is
  'Free-form client settings. Recognized keys: order_number_scheme = "id" '
  '(default; customer number == WooCommerce order id) or "meta:<meta_key>" '
  '(sequential-number plugin; look up by that order meta, e.g. meta:_order_number).';

-- =============================================================================
-- evaluate_flag — pure decision: should this order be flagged for review?
-- Reads the client's abnormal_status_rules. Abnormal status takes precedence
-- over the staleness window. Returns { flagged: bool, reason: text|null }.
-- Shared by both channels (email now, voice later).
-- =============================================================================
create or replace function evaluate_flag(
  p_client_id       uuid,
  p_store_status    text,
  p_order_placed_at timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_rules       jsonb;
  v_abnormal    jsonb;
  v_stale_hours numeric;
begin
  select abnormal_status_rules into v_rules from clients where id = p_client_id;
  if v_rules is null then
    return jsonb_build_object('flagged', false, 'reason', null);
  end if;

  v_abnormal    := coalesce(v_rules -> 'abnormal_statuses', '[]'::jsonb);
  v_stale_hours := coalesce((v_rules ->> 'stale_after_hours')::numeric, 24);

  if p_store_status is not null and v_abnormal ? p_store_status then
    return jsonb_build_object('flagged', true, 'reason', 'abnormal_status');
  elsif p_order_placed_at is not null
        and p_order_placed_at < now() - (v_stale_hours::text || ' hours')::interval then
    return jsonb_build_object('flagged', true, 'reason', 'order_over_24h');
  end if;

  return jsonb_build_object('flagged', false, 'reason', null);
end;
$$;

-- =============================================================================
-- ingest_email — upsert the conversation (by thread) and log the inbound
-- message (idempotent by message id) in one call. Returns the conversation id.
-- =============================================================================
create or replace function ingest_email(
  p_client_id           uuid,
  p_thread_ref          text,
  p_message_ref         text,
  p_customer_identifier text,
  p_customer_name       text,
  p_subject             text,
  p_body                text,
  p_order_number        text default null,
  p_role                text default 'customer'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conv uuid;
begin
  insert into conversations (client_id, channel, customer_identifier, customer_name,
                             subject, order_number, external_ref, status, last_message_at)
  values (p_client_id, 'email', p_customer_identifier, p_customer_name,
          p_subject, p_order_number, p_thread_ref, 'open', now())
  on conflict (client_id, external_ref) do update
    set last_message_at = now(),
        customer_name   = coalesce(conversations.customer_name, excluded.customer_name),
        order_number    = coalesce(excluded.order_number, conversations.order_number),
        updated_at      = now()
  returning id into v_conv;

  insert into messages (client_id, conversation_id, role, body, external_ref)
  values (p_client_id, v_conv, p_role::message_role_t, p_body, p_message_ref)
  on conflict (client_id, external_ref) do nothing;

  return v_conv;
end;
$$;

-- =============================================================================
-- log_agent_reply — log the outbound agent message (idempotent) and advance the
-- conversation status. Returns the message id (null if it was a duplicate).
-- =============================================================================
create or replace function log_agent_reply(
  p_conversation_id uuid,
  p_body            text,
  p_model           text default null,
  p_message_ref     text default null,
  p_new_status      text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client uuid;
  v_id     uuid;
begin
  select client_id into v_client from conversations where id = p_conversation_id;
  if v_client is null then
    raise exception 'conversation % not found', p_conversation_id;
  end if;

  insert into messages (client_id, conversation_id, role, body, model, external_ref)
  values (v_client, p_conversation_id, 'agent', p_body, p_model, p_message_ref)
  on conflict (client_id, external_ref) do nothing
  returning id into v_id;

  update conversations
    set last_message_at = now(),
        status          = coalesce(p_new_status, status),
        updated_at      = now()
  where id = p_conversation_id;

  return v_id;
end;
$$;

-- =============================================================================
-- apply_flag — write side of the flag decision: mark the conversation flagged
-- and enqueue a review item (one pending item per conversation+reason).
-- client_id is derived from the conversation, never trusted from the caller.
-- =============================================================================
create or replace function apply_flag(
  p_conversation_id uuid,
  p_reason          text,
  p_details         text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client uuid;
  v_id     uuid;
begin
  select client_id into v_client from conversations where id = p_conversation_id;
  if v_client is null then
    raise exception 'conversation % not found', p_conversation_id;
  end if;

  update conversations
    set flagged = true, status = 'flagged', flag_reason = p_reason, updated_at = now()
  where id = p_conversation_id;

  insert into review_queue (client_id, conversation_id, reason, details, status)
  select v_client, p_conversation_id, p_reason, p_details, 'pending'
  where not exists (
    select 1 from review_queue
    where conversation_id = p_conversation_id and reason = p_reason and status = 'pending'
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- =============================================================================
-- get_client_integration_secrets — resolve a client's store + shipping creds
-- from Supabase Vault. clients.*_credentials_ref hold Vault secret NAMES; the
-- decrypted JSON blobs are returned to the (service-role) caller. Secrets never
-- live in the clients table.
-- =============================================================================
create or replace function get_client_integration_secrets(p_client_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_woo_ref  text;
  v_ship_ref text;
begin
  select store_credentials_ref, shipstation_credentials_ref
    into v_woo_ref, v_ship_ref
  from clients where id = p_client_id;

  return jsonb_build_object(
    'woocommerce',
      (select decrypted_secret from vault.decrypted_secrets where name = v_woo_ref),
    'shipstation',
      (select decrypted_secret from vault.decrypted_secrets where name = v_ship_ref)
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Execute privileges: these are orchestration RPCs. Lock them to service_role;
-- the dashboard's authenticated/anon roles must not call them (especially the
-- secrets resolver).
-- -----------------------------------------------------------------------------
revoke execute on function evaluate_flag(uuid, text, timestamptz) from public;
revoke execute on function ingest_email(uuid, text, text, text, text, text, text, text, text) from public;
revoke execute on function log_agent_reply(uuid, text, text, text, text) from public;
revoke execute on function apply_flag(uuid, text, text) from public;
revoke execute on function get_client_integration_secrets(uuid) from public;

grant execute on function evaluate_flag(uuid, text, timestamptz) to service_role;
grant execute on function ingest_email(uuid, text, text, text, text, text, text, text, text) to service_role;
grant execute on function log_agent_reply(uuid, text, text, text, text) to service_role;
grant execute on function apply_flag(uuid, text, text) to service_role;
grant execute on function get_client_integration_secrets(uuid) to service_role;

-- End of 0002. (Trailing line so the final grant is never the terminal line.)

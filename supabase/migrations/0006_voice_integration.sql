-- =============================================================================
-- 0006_voice_integration.sql
-- Backend support for the voice (phone) agent: ElevenLabs Agents + native Twilio,
-- Claude Haiku as the custom LLM. Additive only — the core tables were built
-- voice-ready in 0001 (conversations.channel has 'voice', clients.phone_number,
-- messages.audio_url, external_ref = Twilio call SID, review_queue reasons
-- caller_request / no_order_id). This migration adds the three voice RPCs the
-- orchestration layer calls and reuses everything else from 0002/0005:
--   evaluate_flag, apply_flag, get_client_config, get_client_integration_secrets.
--
-- Tenant resolution for voice is by the DIALED number -> clients.phone_number,
-- the exact analog of email's `+<slug>` plus-address. Store phone numbers in
-- E.164 (e.g. +14155550123); resolve_client_by_number compares digits-only so
-- minor formatting differences don't break routing.
--
-- Every function here runs as the service role (bypasses RLS) like the 0002 RPCs.
-- Idempotent / safe to re-apply.
-- =============================================================================

-- =============================================================================
-- resolve_client_by_number — map an inbound (dialed) number to a tenant.
-- Digits-only comparison so +1 415 555 0123 / 14155550123 / (415) 555-0123 all
-- match the stored E.164 value. Returns null for an unknown/inactive number
-- (the caller should play a generic message and stop).
-- =============================================================================
create or replace function resolve_client_by_number(p_called_number text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id
  from clients
  where is_active
    and phone_number is not null
    and regexp_replace(phone_number, '\D', '', 'g')
      = regexp_replace(coalesce(p_called_number, ''), '\D', '', 'g')
  limit 1;
$$;

-- =============================================================================
-- ingest_call — upsert the voice conversation (keyed by Twilio call SID) so the
-- lookup webhook and the post-call logger share one row. Mirrors ingest_email
-- but for channel 'voice' (no subject; customer_identifier = caller number).
-- Idempotent on (client_id, external_ref): a retried tool call or post-call
-- webhook won't create a duplicate conversation. Returns the conversation id.
-- =============================================================================
create or replace function ingest_call(
  p_client_id         uuid,
  p_call_sid          text,
  p_caller_identifier text default null,
  p_caller_name       text default null,
  p_order_number      text default null
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
  values (p_client_id, 'voice', p_caller_identifier, p_caller_name,
          null, p_order_number, p_call_sid, 'open', now())
  on conflict (client_id, external_ref) do update
    set last_message_at = now(),
        customer_name   = coalesce(conversations.customer_name, excluded.customer_name),
        order_number    = coalesce(excluded.order_number, conversations.order_number),
        updated_at      = now()
  returning id into v_conv;

  return v_conv;
end;
$$;

-- =============================================================================
-- log_call_turn — append one transcript turn to a voice conversation and advance
-- its status. Voice analog of log_agent_reply, but role-flexible (customer /
-- agent / human) and carries an optional audio_url for a per-turn recording.
--
-- Idempotency: pass p_turn_ref (e.g. "<call_sid>:<n>") so a re-fired post-call
-- webhook that replays the whole transcript won't double-insert. NULL refs are
-- always distinct (unique index treats NULLs as distinct), so ad-hoc turns
-- without a ref are never blocked. Returns the message id (null on dup).
-- =============================================================================
create or replace function log_call_turn(
  p_conversation_id uuid,
  p_role            text,
  p_body            text default null,
  p_audio_url       text default null,
  p_model           text default null,
  p_turn_ref        text default null,
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

  insert into messages (client_id, conversation_id, role, body, audio_url, model, external_ref)
  values (v_client, p_conversation_id, p_role::message_role_t, p_body, p_audio_url, p_model, p_turn_ref)
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

-- -----------------------------------------------------------------------------
-- Execute privileges: orchestration RPCs. Lock to service_role like 0002/0005;
-- the dashboard's authenticated/anon roles must not call them.
-- -----------------------------------------------------------------------------
revoke execute on function resolve_client_by_number(text) from public;
revoke execute on function ingest_call(uuid, text, text, text, text) from public;
revoke execute on function log_call_turn(uuid, text, text, text, text, text, text) from public;

grant execute on function resolve_client_by_number(text) to service_role;
grant execute on function ingest_call(uuid, text, text, text, text) to service_role;
grant execute on function log_call_turn(uuid, text, text, text, text, text, text) to service_role;

-- End of 0006. (Trailing line so the final grant is never the terminal line.)

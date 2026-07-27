-- =============================================================================
-- 0009_reschedule_cancel.sql
-- Lets the voice agent find, cancel, and reschedule an existing appointment over
-- the phone. Additive to 0007. All RPCs are service_role-locked and client-scoped
-- (a caller can only touch the tenant they dialed), and they reuse the 0007
-- no-overlap exclusion constraint:
--   * cancel  -> status 'cancelled' (excluded by the constraint → the slot frees,
--                and the dashboard's revenue KPIs already ignore cancelled rows).
--   * reschedule -> moves starts_at/ends_at in place (keeps the same row, its
--                conversation link, and its revenue snapshot); a clash with another
--                live appointment raises exclusion_violation → 'slot_unavailable'.
-- Idempotent (create or replace).
-- =============================================================================

-- Comparable phone key: last 10 digits, tolerant of +1 / spaces / punctuation.
create or replace function _appt_phone_key(p text)
returns text
language sql
immutable
set search_path = public
as $$
  select right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 10);
$$;

-- ---------------------------------------------------------------------------
-- find_appointments — upcoming, changeable appointments for a caller. Matches on
-- phone FIRST (exact, privacy-preserving); only falls back to name when no phone
-- is given. Returns a jsonb array (possibly empty) the agent reads back to confirm
-- which one the caller means before doing anything.
-- ---------------------------------------------------------------------------
create or replace function find_appointments(
  p_client_id      uuid,
  p_customer_phone text        default null,
  p_customer_name  text        default null,
  p_from           timestamptz default now()
)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(row_to_json(t) order by t.starts_at), '[]'::jsonb)
  from (
    select a.id            as appointment_id,
           a.service_name,
           a.starts_at,
           a.ends_at,
           a.timezone,
           a.status,
           a.customer_name,
           a.service_address,
           a.is_emergency
    from appointments a
    where a.client_id = p_client_id
      and a.status in ('booked', 'confirmed', 'rescheduled')
      and a.ends_at >= p_from
      and case
            when _appt_phone_key(p_customer_phone) <> ''
              then _appt_phone_key(a.customer_phone) = _appt_phone_key(p_customer_phone)
            when p_customer_name is not null and length(trim(p_customer_name)) > 0
              then a.customer_name ilike '%' || trim(p_customer_name) || '%'
            else false
          end
    order by a.starts_at
    limit 5
  ) t;
$$;

-- ---------------------------------------------------------------------------
-- cancel_appointment — cancel a specific appointment (found via find_appointments).
-- Client-scoped; refuses if it's already cancelled/completed or belongs to another
-- tenant. Optional reason is appended to notes.
-- ---------------------------------------------------------------------------
create or replace function cancel_appointment(
  p_client_id      uuid,
  p_appointment_id uuid,
  p_reason         text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r appointments%rowtype;
begin
  update appointments
     set status     = 'cancelled',
         notes      = case
                        when p_reason is null or length(trim(p_reason)) = 0 then notes
                        else trim(both ' ' from coalesce(notes, '') ||
                             ' [cancelled: ' || trim(p_reason) || ']')
                      end,
         updated_at = now()
   where id = p_appointment_id
     and client_id = p_client_id
     and status not in ('cancelled', 'completed')
  returning * into r;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  return jsonb_build_object(
    'ok', true,
    'appointment_id', r.id,
    'service_name', r.service_name,
    'starts_at', r.starts_at,
    'status', r.status
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- reschedule_appointment — move an appointment to a new start time, keeping the
-- same duration (derived from the existing row), row identity, conversation link,
-- and revenue. A clash with another live appointment → 'slot_unavailable'. The new
-- start should come from check_availability.
-- ---------------------------------------------------------------------------
create or replace function reschedule_appointment(
  p_client_id      uuid,
  p_appointment_id uuid,
  p_new_starts_at  timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_starts   timestamptz;
  v_duration interval;
  v_new_end  timestamptz;
  r          appointments%rowtype;
begin
  select starts_at, (ends_at - starts_at)
    into v_starts, v_duration
  from appointments
  where id = p_appointment_id
    and client_id = p_client_id
    and status not in ('cancelled', 'completed');

  if v_duration is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- A visit that has already started/passed can't be "moved" — that would rewrite
  -- history into the future. It should become a NEW booking instead.
  if v_starts <= now() then
    return jsonb_build_object('ok', false, 'reason', 'already_started');
  end if;

  -- Never move an appointment into the past (the new start must be upcoming).
  if p_new_starts_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'past_time');
  end if;

  v_new_end := p_new_starts_at + v_duration;

  begin
    update appointments
       set starts_at  = p_new_starts_at,
           ends_at    = v_new_end,
           status     = 'rescheduled',
           updated_at = now()
     where id = p_appointment_id
       and client_id = p_client_id
    returning * into r;
  exception
    when exclusion_violation or unique_violation then
      return jsonb_build_object('ok', false, 'reason', 'slot_unavailable');
  end;

  return jsonb_build_object(
    'ok', true,
    'appointment_id', r.id,
    'service_name', r.service_name,
    'starts_at', r.starts_at,
    'ends_at', r.ends_at,
    'status', r.status
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Orchestration RPCs -> service_role only, like 0002/0006/0007.
-- ---------------------------------------------------------------------------
revoke execute on function _appt_phone_key(text) from public;
revoke execute on function find_appointments(uuid, text, text, timestamptz) from public;
revoke execute on function cancel_appointment(uuid, uuid, text) from public;
revoke execute on function reschedule_appointment(uuid, uuid, timestamptz) from public;

grant execute on function _appt_phone_key(text) to service_role;
grant execute on function find_appointments(uuid, text, text, timestamptz) to service_role;
grant execute on function cancel_appointment(uuid, uuid, text) to service_role;
grant execute on function reschedule_appointment(uuid, uuid, timestamptz) to service_role;

-- End of 0009.

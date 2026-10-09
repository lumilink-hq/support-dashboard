-- =============================================================================
-- 0074_seo_action_notes_and_edits.sql
-- /seo-approvals: a reason with a decision, and editing a draft before
-- approving it (2026-10-09).
--
-- DECISION NOTE. seo_actions.decision_note holds why a draft was rejected (or
-- a note on an approval). Until now the only record of why LumiLink's first
-- five drafts were rejected was plan.md. A tenant may set it ONLY in the same
-- UPDATE that changes the status, so a note can't be rewritten after the
-- fact, and 0054's rule that the draft itself is read-only still holds.
--
-- EDITS. The dashboard writes an edit with the service role, after reading
-- the draft under the tenant's own RLS (it must be theirs and still
-- pending_approval) and validating the new text with the same checks the
-- model's output passes (lib/seo-draft-edit.ts). Tenants still can't write
-- proposed_value themselves: the edit has to go through those checks, and
-- the publisher trusts what's stored. The engine's first version is kept in
-- original_value, with who edited and when.
--
-- Test: scripts/test_seo_action_notes.sql. Idempotent / safe to re-apply.
-- =============================================================================

alter table seo_actions
  add column if not exists decision_note  text,
  add column if not exists original_value jsonb,
  add column if not exists edited_by      uuid references users(id) on delete set null,
  add column if not exists edited_at      timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'seo_actions_decision_note_check') then
    alter table seo_actions
      add constraint seo_actions_decision_note_check
      check (decision_note is null or length(decision_note) <= 500);
  end if;
end;
$$;

-- 0054's guard, with decision_note added to what a tenant may change, and
-- only together with a status change.
create or replace function protect_seo_actions_tenant_columns()
returns trigger
language plpgsql
as $$
begin
  if current_user = 'authenticated' then
    if (to_jsonb(new) - 'status' - 'approved_by' - 'approved_at' - 'updated_at' - 'decision_note')
       is distinct from
       (to_jsonb(old) - 'status' - 'approved_by' - 'approved_at' - 'updated_at' - 'decision_note')
    then
      raise exception
        'a tenant may only approve or reject a draft; the draft itself is read-only '
        '(see 0054_seo_action_queue.sql)'
        using errcode = '42501';
    end if;

    if new.decision_note is distinct from old.decision_note and new.status is not distinct from old.status then
      raise exception 'a decision note is written with the decision itself (0074)'
        using errcode = '42501';
    end if;

    if new.status is distinct from old.status then
      new.approved_by := auth.uid();
      new.approved_at := now();
    elsif new.approved_by is distinct from old.approved_by
       or new.approved_at is distinct from old.approved_at then
      raise exception 'approved_by / approved_at are set by the approval itself'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

-- End of 0074.

-- =============================================================================
-- 0027_call_ceiling_105.sql
-- Actually lower the per-call ceiling to 105s.
--
-- WHY A SECOND MIGRATION. 0025 was applied while it still carried the original
-- 180s value. The file was edited to 105 afterwards, but `supabase db push`
-- skips any migration already recorded in schema_migrations — editing an
-- applied file changes nothing in the database. Verified in production:
--
--   select default_max_call_secs from platform_settings;  -->  180
--
-- while 0025 on disk says 105. Migrations are immutable history; a value that
-- needs to change after the fact needs a new migration.
--
-- WHY IT MATTERS. ElevenLabs terminates the call at 120s by severing the audio
-- mid-sentence. checkCallTime() in voice-order-lookup measures elapsed time
-- against THIS value to make the agent wind down (45s left) and say goodbye
-- (15s left). At 180 those fire at 135s and 165s elapsed — after the call is
-- already dead — so the graceful close never runs and every long call ends in
-- silence. 105 puts the goodbye at ~94s, roughly 26s before the cut.
--
-- INVARIANT: platform_settings.default_max_call_secs < the ElevenLabs agent's
-- "max call duration" (currently 120). Change one, change the other.
--
-- Idempotent / safe to re-apply.
-- =============================================================================

update platform_settings
   set default_max_call_secs = 105,
       note = coalesce(nullif(note, ''), '')
              || case when coalesce(note, '') = '' then '' else ' | ' end
              || '0027: max_call_secs 105 (< ElevenLabs 120s hard cut)'
 where id = 1
   and default_max_call_secs <> 105;

-- -----------------------------------------------------------------------------
-- Per-client overrides, re-run here for the same reason: 0025's section 2b was
-- added after that migration had already been applied, so it may never have
-- executed against this database.
--
-- Only values at or above 105 are touched. A client deliberately set LOWER (a
-- short demo line) keeps its setting.
-- -----------------------------------------------------------------------------
do $$
declare
  v_touched int;
begin
  update clients c
     set settings = coalesce(c.settings, '{}'::jsonb)
                    || jsonb_build_object(
                         'voice_caps',
                         coalesce(c.settings -> 'voice_caps', '{}'::jsonb)
                         || jsonb_build_object('max_call_secs', 105)
                       )
   where (coalesce(c.settings, '{}'::jsonb) -> 'voice_caps' ->> 'max_call_secs')
         is not null
     and (coalesce(c.settings, '{}'::jsonb) -> 'voice_caps' ->> 'max_call_secs')::int
         >= 105;

  get diagnostics v_touched = row_count;
  raise notice '0027: lowered max_call_secs to 105 on % client(s)', v_touched;
end $$;

-- Verify:
--   select default_monthly_minutes, default_max_call_secs from platform_settings where id = 1;
--   -- expect 100, 105

-- End of 0027.

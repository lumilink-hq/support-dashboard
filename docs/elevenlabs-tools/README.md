# ElevenLabs agent tool configs (scheduling agent "Lumi")

The three webhook (server) tools the scheduling agent uses, as validated ElevenLabs
tool JSON (paste into Add Tool → Webhook → JSON mode). They all POST to the
`scheduling` edge function; the function branches on the `action` field.

- `check_availability.json` — reads open slots (never books).
- `book_appointment.json` — books a slot returned by check_availability.
- `capture_lead.json` — records a caller who didn't book.

Notes:
- **Method is POST** with params in `request_body_schema` (the form defaults to GET +
  query params, which the function does not read).
- Auth is a **secret header** `x-voice-tool-secret` referenced by `secret_id`
  (`5BmqMzQ5V5mn7yw69e3s` = this workspace's stored `VOICE_TOOL_SECRET`). If you rotate
  the secret or use a different workspace, recreate the secret and update the id.
- `system__*` fields are auto-populated by ElevenLabs; `action` is a constant; the rest
  are collected by the model (`llm_prompt`).
- Not included here (add from the Add Tool menu): `transfer_to_number` and `end_call`.

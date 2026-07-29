# ElevenLabs agent tool configs

Validated ElevenLabs tool JSON — paste into Add Tool → Webhook → JSON mode.

## Orders agent (Tsunami)

- `lookup_order.json` — order status/tracking → `voice-order-lookup`.
- `request_callback.json` — creates the callback ticket → `voice-ticket`.
- Add `end_call` from the Add Tool menu (system tool, no JSON).

## Scheduling agent ("Lumi", Comfort Air — dormant)

All POST to the `scheduling` edge function; it branches on the `action` field.

- `check_availability.json` — reads open slots (never books).
- `book_appointment.json` — books a slot returned by check_availability.
- `capture_lead.json` — records a caller who didn't book.
- `find_appointment.json` / `reschedule_appointment.json` / `cancel_appointment.json`.

## ⚠️ Copy `lookup_order.json` — it is the only UI-generated file

`lookup_order.json` was **exported from the ElevenLabs form**, not hand-written, so it is the
canonical shape. The scheduling files pre-date a schema change and will NOT paste cleanly today.

Two things the older files lack, both of which produce a **422** on save:

1. `api_schema.request_body_schema` needs a **`value_type`** key (`"llm_prompt"`) alongside
   `required`. The scheduling files have neither.
2. Any **custom** (non-`system__`) dynamic variable must be declared in
   `dynamic_variables.dynamic_variable_placeholders`. `client_slug` is custom — it comes from
   `voice-personalization`, not ElevenLabs — so it needs:

   ```json
   "dynamic_variables": {
     "dynamic_variable_placeholders": {
       "client_slug": { "type": "string_literal", "value": "" }
     }
   }
   ```

Because the 422 body doesn't name either omission, this is not diagnosable from the error.
**If a paste fails, build it in the form and export instead of editing JSON by hand** — that is
how this file was produced, after three failed hand-written attempts.

## Older notes on the schema shape

`lookup_order.json` and `request_callback.json` were originally written in a plausible-looking
flat shape (`method`/`url`/`headers`/`body_parameters` at the top level) that ElevenLabs
rejects outright:

```
Validation Error: expected object, path: ["api_schema"] — received undefined
                  expected number, path: ["response_timeout_secs"] — received undefined
```

Both were rewritten on 2026-07-29 to match `check_availability.json` exactly. The details that
are easy to get wrong:

| Wrong | Right |
|---|---|
| `url` / `method` at top level | nested inside **`api_schema`** |
| `response_timeout_secs` omitted | **required**, a number (20 here) |
| `body_parameters` as an object map | `api_schema.request_body_schema.properties` as an **array**, each entry keyed by `id` |
| `"value_type": "dynamic"` | `"value_type": "dynamic_variable"` |
| `headers` object with an inline secret | `api_schema.request_headers` **array**, `{type:"secret", name, secret_id}` |

Every property object needs the full key set — `id`, `type`, `value_type`, `description`,
`dynamic_variable`, `constant_value`, `enum`, `is_system_provided`, `required` — even where the
values are empty. Omitting keys is what produces the vaguest errors.

**When adding a new tool, copy the nearest existing file and edit it.** Don't write one from
memory of the docs.

### System variable names are checked, and a wrong one is unobvious

The second failure on the same paste was `system__caller_number`, which does not exist. The
caller's number is **`system__caller_id`**. The error points at
`api_schema.request_body_schema.properties.<index>` with `"Unknown system variable"` buried in
an `invalid_union` — count the properties array from zero to find which one.

Note the distinction that makes this easy to miss: the body key the function receives is the
property's **`id`** (`caller_number`), while `dynamic_variable` is only the *source*. Renaming
the source does not change the request body, so the edge functions are unaffected.

| Variable | Status |
|---|---|
| `system__called_number` | documented — destination number |
| `system__caller_id` | documented — **the caller's number** |
| `system__conversation_id` | documented |
| `system__call_sid` | undocumented, but accepted in practice (used by `book_appointment`) |

Full list: `system__agent_id`, `system__current_agent_id`, `system__caller_id`,
`system__called_number`, `system__call_duration_secs`, `system__time`, `system__timezone`,
`system__conversation_id`, `system__agent_turns`, `system__current_agent_turns`.
([docs](https://elevenlabs.io/docs/eleven-agents/customization/personalization/dynamic-variables))

## Notes

- **Method is POST** with params in `request_body_schema` (the form defaults to GET +
  query params, which the functions do not read).
- Auth is a **secret header** `x-voice-tool-secret` referenced by `secret_id`
  (`5BmqMzQ5V5mn7yw69e3s` = this workspace's stored `VOICE_TOOL_SECRET`). If you rotate
  the secret or use a different workspace, recreate the secret and update the id in all files.
- `system__*` fields are auto-populated by ElevenLabs; `action` is a constant; the rest
  are collected by the model (`llm_prompt`).
- Not included here (add from the Add Tool menu): `transfer_to_number` and `end_call`.
- **Both `called_number` and `client_ref` are sent on every call.** ElevenLabs fills unused
  parameters with empty strings, and the functions treat `""` as absent — phone routes by
  number, web by slug. Send both and let the function decide; don't try to omit one.

-- =============================================================================
-- 0032_onboarding_kb_intake.sql
-- The three tables onboarding needs before a wizard can be built on top:
--
--   1. clients.business_type   — which KIND of business this is, so onboarding
--                                (and the agent) can branch: service/HVAC vs
--                                online store.
--   2. kb_documents/kb_chunks  — the knowledge base. Tenant-scoped pgvector,
--                                because the shared-agent design makes
--                                ElevenLabs' native KB unsafe (see §2).
--   3. client_intake_requests  — where a client asks for a change to how their
--                                bot behaves, WITHOUT being able to change it
--                                themselves (see §3).
--
-- No UI in this migration. The wizard is the next piece of work; this is the
-- storage and the safety rules it will write through.
--
-- Idempotent / safe to re-apply.
-- =============================================================================

-- pgvector must be resolvable while the DDL below runs. Supabase installs
-- extensions into the `extensions` schema, but a migration executed by a client
-- whose search_path is bare `public` then cannot see the `vector` type. Setting
-- it explicitly here removes a failure that depends on WHO ran the migration
-- rather than on what it says.
-- Plain `set`, not `set local`: SET LOCAL is silently a no-op outside a
-- transaction block (it only warns), and whether a migration runner wraps this
-- file in one is not something the file should depend on.
set search_path = public, extensions;

create extension if not exists vector;

-- =============================================================================
-- 1. business_type — the onboarding archetype
-- =============================================================================
--
-- WHY A COLUMN AND NOT JUST settings.voice_agent_mode.
--
-- `settings.voice_agent_mode` ('scheduling' | 'orders') already exists and is
-- read by voice-personalization to decide which prompt a call gets. It is an
-- AGENT-BEHAVIOUR switch, chosen per phone line.
--
-- business_type is a COMMERCIAL fact about the client, needed in places the
-- agent config has no business being consulted: which onboarding steps to show,
-- which runbook an operator follows, how a client is counted. It is also needed
-- BEFORE any agent exists — at signup, which is the whole point.
--
-- Two fields that must agree is how drift starts, so they are kept in lockstep
-- by a trigger rather than by discipline. See §1b: setting business_type
-- rewrites voice_agent_mode to match. One is the cause, the other the effect.
--
--   business_type  'service'    <-> voice_agent_mode 'scheduling'
--   business_type  'ecommerce'  <-> voice_agent_mode 'orders'
--
-- Only these two values, deliberately. A client doing both is a real thing and
-- is NOT modelled here, because voice_agent_mode has no 'both' — one phone line
-- gets exactly one prompt. Selling to such a client today means two clients
-- rows or a custom prompt, and that should be a conversation rather than a
-- column that silently half-works.
alter table clients
  add column if not exists business_type text;

do $$ begin
  alter table clients
    add constraint clients_business_type_chk
    check (business_type is null or business_type in ('service', 'ecommerce'));
exception when duplicate_object then null; end $$;

comment on column clients.business_type is
  'Onboarding archetype: service (HVAC/trades, books appointments) or ecommerce '
  '(online store, answers order questions). Drives which onboarding steps are '
  'shown and keeps settings.voice_agent_mode in sync via trg_clients_business_type. '
  'NULL means never asked — pre-0032 clients and SQL-seeded ones.';

-- -----------------------------------------------------------------------------
-- 1a. Backfill from what each client's agent is ALREADY doing.
--
--     voice_agent_mode is the only existing evidence of archetype, and it is
--     good evidence: an operator set it deliberately for the agent to work at
--     all. Clients with neither signal stay NULL rather than being guessed into
--     'service' — a wrong archetype would show an HVAC client the store-connect
--     step and hide it from a shop that needs it.
-- -----------------------------------------------------------------------------
do $$
declare
  v_touched int;
begin
  update clients
     set business_type = case
           when settings ->> 'voice_agent_mode' = 'orders' then 'ecommerce'
           when settings ->> 'voice_agent_mode' = 'scheduling' then 'service'
           -- A store platform is configured: they answer order questions
           -- whatever the phone line is set to.
           when store_platform is not null then 'ecommerce'
         end
   where business_type is null
     and (settings ->> 'voice_agent_mode' in ('orders', 'scheduling')
          or store_platform is not null);

  get diagnostics v_touched = row_count;
  raise notice '0032: set business_type on % client(s); any left null were never asked', v_touched;
end $$;

-- -----------------------------------------------------------------------------
-- 1b. Keep voice_agent_mode in step with business_type.
--
--     A trigger rather than a convention, because the failure mode is silent
--     and expensive: an HVAC client whose agent is left in 'orders' mode
--     answers its callers with order-status questions and cannot book a job.
--     Nothing errors; the calls are just wrong. Anyone can UPDATE clients — the
--     dashboard does it under RLS — so a rule that lives only in application
--     code is a rule that will be bypassed.
--
--     ONE DIRECTION ONLY. business_type drives voice_agent_mode, never the
--     reverse. An operator deliberately flipping voice_agent_mode for a single
--     odd client (a store that also books installs, say) keeps that override —
--     until someone sets business_type again, which is an explicit act that
--     should reasonably win.
-- -----------------------------------------------------------------------------
create or replace function sync_voice_agent_mode()
returns trigger
language plpgsql
as $$
begin
  if new.business_type is null then
    return new;
  end if;

  -- Only act when business_type actually changed (or was just set), so a plain
  -- UPDATE of some other column never clobbers an operator's mode override.
  --
  -- Nested rather than `tg_op = 'UPDATE' and ... old.business_type ...`:
  -- Postgres does not guarantee short-circuit evaluation of AND, and OLD is
  -- unassigned during an INSERT. The one-line version reads fine and can raise
  -- "record old is not assigned yet" on the insert path.
  if tg_op = 'UPDATE' then
    if new.business_type is not distinct from old.business_type then
      return new;
    end if;
  end if;

  new.settings := coalesce(new.settings, '{}'::jsonb)
    || jsonb_build_object(
         'voice_agent_mode',
         case new.business_type when 'ecommerce' then 'orders' else 'scheduling' end);

  return new;
end;
$$;

drop trigger if exists trg_clients_business_type on clients;
create trigger trg_clients_business_type
  before insert or update of business_type on clients
  for each row execute function sync_voice_agent_mode();

-- The trigger fires on future writes only, so bring existing rows into line
-- once, here. Same mapping, applied to whatever 1a just set.
update clients
   set settings = coalesce(settings, '{}'::jsonb)
     || jsonb_build_object(
          'voice_agent_mode',
          case business_type when 'ecommerce' then 'orders' else 'scheduling' end)
 where business_type is not null
   and coalesce(settings ->> 'voice_agent_mode', '') <>
       case business_type when 'ecommerce' then 'orders' else 'scheduling' end;

-- =============================================================================
-- 2. Knowledge base — tenant-scoped, pgvector
-- =============================================================================
--
-- WHY NOT ELEVENLABS' NATIVE KNOWLEDGE BASE, which is far less work.
--
-- Because of the shared agent. This platform runs ONE ElevenLabs agent for
-- every client, resolved per call by the dialed number
-- (voice-personalization). A knowledge base attached to that agent is attached
-- to ALL of them: client A's price list, policies and internal notes would be
-- retrievable on client B's calls. There is no per-call scoping to hang a
-- tenant boundary on.
--
-- The alternative — one agent per client — is exactly the architecture
-- docs/client-onboarding.md was written to escape ("onboarding a client is
-- config, not a build"). So the KB lives here, scoped by client_id under RLS,
-- and the agent reaches it through a tool that is handed a client_id it cannot
-- choose for itself.
--
-- This also makes it CROSS-CHANNEL by construction. Voice is the only channel
-- running today (email is paused, see FEATURES in lib/entitlements.ts), but a
-- KB in the database serves whatever reads it later; a KB inside a voice vendor
-- serves voice forever.

-- -----------------------------------------------------------------------------
-- kb_documents — one row per source: a synced page, a pasted policy, an FAQ.
-- -----------------------------------------------------------------------------
create table if not exists kb_documents (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references clients(id) on delete cascade,

  title        text not null,
  -- 'url'   — fetched from the client's website (the "website knowledge sync"
  --           that has been on the pricing page since launch)
  -- 'paste' — text the client typed or pasted in onboarding
  -- 'faq'   — a question/answer pair, stored as one chunkable document
  -- 'file'  — uploaded document, once uploads exist
  source_type  text not null default 'paste'
               check (source_type in ('url', 'paste', 'faq', 'file')),
  source_uri   text,
  content      text not null default '',

  -- Ingestion is asynchronous (fetch, chunk, embed), so its state has to be
  -- visible. Without this a document that failed to embed is indistinguishable
  -- from one nobody has asked about yet, and the client is told their site is
  -- synced when it is not.
  status       text not null default 'pending'
               check (status in ('pending', 'ready', 'failed')),
  last_error   text,
  -- Fingerprint of `content`, so a re-sync that fetched an unchanged page can
  -- skip re-embedding. Embeddings cost money per call; a nightly sync that
  -- re-embeds an unchanged site pays that bill every night for nothing.
  content_hash text,

  chunk_count  int not null default 0,
  synced_at    timestamptz,
  meta         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- drop+create rather than a bare `create trigger`, which raises duplicate_object
-- on re-apply and would break this file's idempotency claim on the second run.
drop trigger if exists trg_kb_documents_updated_at on kb_documents;
create trigger trg_kb_documents_updated_at
  before update on kb_documents
  for each row execute function set_updated_at();

create index if not exists idx_kb_documents_client on kb_documents(client_id);

-- One row per source URL per client. THE RE-SYNC GUARD: without it, syncing a
-- website nightly inserts a fresh copy of every page every night, the chunk
-- table grows without bound, and retrieval starts returning the same passage
-- five times — which reads to the caller as the agent repeating itself.
create unique index if not exists uq_kb_documents_source
  on kb_documents(client_id, source_uri) where source_uri is not null;

-- -----------------------------------------------------------------------------
-- kb_chunks — the retrievable units.
--
-- 1536 dimensions matches OpenAI text-embedding-3-small, which is the cheap
-- default. THE DIMENSION IS PART OF THE SCHEMA: changing embedding model later
-- means a new column or a new table plus a full re-embed, not a config change.
-- Worth deciding on purpose rather than discovering.
--
-- SUPERSEDED BY 0033: the embedding provider became Supabase's built-in
-- gte-small, which is 384-dimensional, so 0033 replaces this column. This file
-- is left as applied — editing a migration that has already run changes
-- nothing in the database and only makes the file disagree with it.
-- -----------------------------------------------------------------------------
create table if not exists kb_chunks (
  id          uuid primary key default gen_random_uuid(),
  -- Denormalised from the document ON PURPOSE. RLS has to filter chunks without
  -- joining to kb_documents on every retrieval, and the ANN search below runs
  -- before any join could narrow it.
  client_id   uuid not null references clients(id) on delete cascade,
  document_id uuid not null references kb_documents(id) on delete cascade,

  chunk_index int  not null,
  content     text not null,
  embedding   vector(1536),
  token_count int,
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),

  -- Re-ingesting a document upserts its chunks in place rather than duplicating.
  unique (document_id, chunk_index)
);

create index if not exists idx_kb_chunks_client on kb_chunks(client_id);
-- No separate index on document_id: the unique (document_id, chunk_index)
-- constraint already builds one with document_id leading, and a duplicate index
-- costs write throughput on every re-ingest for nothing.

-- HNSW over cosine distance. Built on vector_cosine_ops because match_kb below
-- uses the `<=>` operator; an index built for a different operator class is
-- SILENTLY IGNORED — the query still works, just sequentially, and the only
-- symptom is a call that pauses for a second before the agent speaks.
do $$ begin
  create index idx_kb_chunks_embedding on kb_chunks
    using hnsw (embedding vector_cosine_ops);
exception
  when duplicate_table then null;
  when undefined_object then
    raise notice '0032: hnsw/vector_cosine_ops unavailable; retrieval will sequential-scan. Check the pgvector version.';
end $$;

-- -----------------------------------------------------------------------------
-- RLS. NOT OPTIONAL, and not merely good practice here.
--
-- 0001 sets DEFAULT PRIVILEGES on this schema:
--     alter default privileges in schema public grant select ... to anon;
-- so EVERY table created afterwards — including these two — is granted SELECT
-- to the anon role automatically. A KB table left without RLS is therefore
-- readable by an unauthenticated request through PostgREST: every client's
-- pricing, policies and internal notes, to anyone with the project URL.
--
-- Enabling RLS with no anon policy closes it, because RLS denies by default.
-- -----------------------------------------------------------------------------
alter table kb_documents enable row level security;
alter table kb_chunks    enable row level security;

drop policy if exists kb_documents_tenant on kb_documents;
create policy kb_documents_tenant on kb_documents
  for all using (client_id = current_client_id())
  with check (client_id = current_client_id());

-- Chunks are readable by the tenant (so the dashboard can show what was
-- indexed) but NOT writable: they are derived data. A client editing chunk text
-- directly would desynchronise it from the embedding beside it, leaving a row
-- that retrieves on one meaning and reads as another — which is a very slow
-- thing to debug and an easy thing to prevent.
drop policy if exists kb_chunks_tenant_read on kb_chunks;
create policy kb_chunks_tenant_read on kb_chunks
  for select using (client_id = current_client_id());

-- -----------------------------------------------------------------------------
-- match_kb — nearest-neighbour retrieval for one client.
--
-- SECURITY DEFINER and service_role ONLY. It takes client_id as an argument and
-- bypasses RLS, which is exactly the shape that leaks a whole platform if it is
-- callable by tenants: any authenticated user could pass someone else's
-- client_id. Same posture as 0012's meter and 0025's cap setter.
--
-- The agent path is: ElevenLabs tool -> edge function (service role, resolves
-- the client from the DIALED NUMBER) -> match_kb. The client_id is derived from
-- the phone line, never from anything the caller or the model supplies.
-- -----------------------------------------------------------------------------
create or replace function match_kb(
  p_client_id       uuid,
  p_query_embedding vector(1536),
  p_match_count     int  default 5,
  p_min_similarity  real default 0.0
)
returns table (
  chunk_id    uuid,
  document_id uuid,
  title       text,
  content     text,
  similarity  real,
  source_uri  text
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    c.id,
    c.document_id,
    d.title,
    c.content,
    -- Cosine DISTANCE (0 = identical) inverted into a similarity, so callers
    -- can reason in "higher is better" and a threshold reads the obvious way.
    (1 - (c.embedding <=> p_query_embedding))::real as similarity,
    d.source_uri
  from kb_chunks c
  join kb_documents d on d.id = c.document_id
  where c.client_id = p_client_id
    and c.embedding is not null
    and d.status = 'ready'
    and (1 - (c.embedding <=> p_query_embedding)) >= p_min_similarity
  order by c.embedding <=> p_query_embedding
  limit greatest(coalesce(p_match_count, 5), 1);
$$;

revoke execute on function match_kb(uuid, vector, int, real) from public;
grant  execute on function match_kb(uuid, vector, int, real) to service_role;

comment on function match_kb(uuid, vector, int, real) is
  'Nearest-neighbour KB retrieval scoped to one client. SECURITY DEFINER and '
  'service_role only — it trusts its client_id argument, so a tenant-callable '
  'version would expose every client''s knowledge base.';

-- =============================================================================
-- 3. client_intake_requests — "here is what I want the bot to do"
-- =============================================================================
--
-- The onboarding wizard's free-text step, and the standing channel afterwards.
--
-- THE RULE THIS TABLE EXISTS TO ENFORCE: a client can ASK for a behaviour
-- change; only an operator can MAKE one.
--
-- The alternative was writing their text straight into
-- settings.voice_instructions, which voice-personalization injects verbatim
-- into the system prompt ("# Additional instructions from {client}"). That is a
-- direct line from a text box to what the agent says on a live call, with no
-- one in between. A client would reasonably write "always tell people we can
-- come out same day" and their agent would then promise same-day service it
-- cannot deliver — in the client's own name, to their own customers.
--
-- So requests land here as inert rows. An operator reads, decides, and edits
-- the config themselves; §3b records that decision.
create table if not exists client_intake_requests (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references clients(id) on delete cascade,

  -- Loose category, for triage and for grouping the wizard's questions.
  -- 'greeting'    — how the agent should open
  -- 'tone'        — persona and register
  -- 'never_say'   — hard prohibitions, the most safety-relevant kind
  -- 'faq'         — a question they want answered, becomes a kb_document
  -- 'escalation'  — when to transfer or take a callback
  -- 'hours'       — availability nuances
  -- 'other'       — anything the form did not anticipate
  topic      text not null default 'other'
             check (topic in ('greeting','tone','never_say','faq',
                              'escalation','hours','other')),
  body       text not null check (length(btrim(body)) > 0),

  status     text not null default 'new'
             check (status in ('new','in_review','applied','declined')),
  -- What the operator did about it, in words. Visible to the client, so they
  -- can see their request was read even when the answer was no.
  operator_note text,
  applied_at    timestamptz,

  -- Who asked. ON DELETE SET NULL so removing a staff account does not delete
  -- the request history that explains why the agent is configured as it is.
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_client_intake_requests_updated_at on client_intake_requests;
create trigger trg_client_intake_requests_updated_at
  before update on client_intake_requests
  for each row execute function set_updated_at();

create index if not exists idx_intake_client on client_intake_requests(client_id, created_at desc);
-- The operator's work queue: everything still waiting, oldest first, across all
-- tenants. Partial so it stays small as resolved requests accumulate.
create index if not exists idx_intake_open
  on client_intake_requests(created_at) where status in ('new','in_review');

alter table client_intake_requests enable row level security;

-- Read your own. Includes the status and the operator's note, so the client can
-- see where their request got to.
drop policy if exists intake_select_own on client_intake_requests;
create policy intake_select_own on client_intake_requests
  for select using (client_id = current_client_id());

-- Raise a new one, for your own tenant only.
--
-- The `status = 'new'` check is the important half. Without it a client could
-- INSERT a row that already says 'applied' — not changing the agent, but
-- removing the request from the operator's queue, so it is never actioned and
-- never chased. A silently dropped request is worse than a rejected one.
drop policy if exists intake_insert_own on client_intake_requests;
create policy intake_insert_own on client_intake_requests
  for insert with check (
    client_id = current_client_id()
    and status = 'new'
    and applied_at is null
    and operator_note is null
  );

-- THERE IS DELIBERATELY NO UPDATE OR DELETE POLICY.
--
-- 0001 grants UPDATE and DELETE on every table in this schema to
-- `authenticated`, so the only thing preventing a client from marking their own
-- request 'applied' — or deleting the record that they asked for something
-- unwise — is the ABSENCE of a policy here. RLS denies what it does not
-- explicitly permit.
--
-- Do not add a convenience policy so clients can edit a typo in their own
-- request. It cannot be written without also letting them set `status`, which
-- is the one column that must stay in operator hands.
--
-- Service role bypasses RLS entirely, which is how §3b writes.

-- -----------------------------------------------------------------------------
-- 3b. resolve_intake_request — an operator's decision, recorded.
--
--     Records the OUTCOME. It deliberately does NOT touch the agent's config:
--     applying a request means editing settings.voice_instructions, the
--     greeting, the services list — judgement calls with different shapes, and
--     an RPC that guessed which one to write would be the unreviewed path this
--     table was built to prevent, wearing a different hat.
-- -----------------------------------------------------------------------------
create or replace function resolve_intake_request(
  p_request_id uuid,
  p_status     text,
  p_note       text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_row client_intake_requests%rowtype;
begin
  if p_status not in ('in_review','applied','declined') then
    return jsonb_build_object(
      'ok', false,
      'error', format('status must be in_review, applied or declined (got %L)', p_status));
  end if;

  update client_intake_requests
     set status        = p_status,
         operator_note = coalesce(p_note, operator_note),
         applied_at    = case when p_status = 'applied' then now() else applied_at end
   where id = p_request_id
  returning * into v_row;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'unknown_request');
  end if;

  return jsonb_build_object(
    'ok', true, 'id', v_row.id, 'client_id', v_row.client_id,
    'status', v_row.status, 'topic', v_row.topic);
end;
$$;

revoke execute on function resolve_intake_request(uuid, text, text) from public;
grant  execute on function resolve_intake_request(uuid, text, text) to service_role;

comment on function resolve_intake_request(uuid, text, text) is
  'Operator decision on an intake request. Service role only — a tenant-callable '
  'version would let clients clear their own queue. Records the outcome; does '
  'not change agent config, which stays a human edit.';

-- =============================================================================
-- 4. VERIFY
-- =============================================================================
--
-- a) Archetype and agent mode agree everywhere. MUST return zero rows —
--    a hit means some client's phone line runs the wrong prompt:
--
--      select id, name, business_type, settings ->> 'voice_agent_mode' as mode
--        from clients
--       where business_type is not null
--         and coalesce(settings ->> 'voice_agent_mode', '') <>
--             case business_type when 'ecommerce' then 'orders' else 'scheduling' end;
--
-- b) Who still has no archetype (they will get the generic wizard):
--
--      select id, name, store_platform from clients where business_type is null;
--
-- c) THE ONE THAT MATTERS: knowledge bases are not world-readable. RLS must be
--    on for all three new tables — 0001's default privileges granted anon
--    SELECT on them at creation:
--
--      select relname, relrowsecurity from pg_class
--       where relname in ('kb_documents','kb_chunks','client_intake_requests');
--      -- all three must be true
--
-- d) No policy lets a client resolve their own request. Expect exactly two
--    policies on the intake table, SELECT and INSERT, and no UPDATE or DELETE:
--
--      select policyname, cmd from pg_policies
--       where tablename = 'client_intake_requests';
--
-- e) The ANN index exists and matches the operator class match_kb uses:
--
--      select indexname, indexdef from pg_indexes where tablename = 'kb_chunks';
--      -- look for hnsw (embedding vector_cosine_ops)
--
-- f) Retrieval is not tenant-callable:
--
--      select proname, proacl from pg_proc where proname in ('match_kb','resolve_intake_request');
--      -- service_role only; no authenticated, no PUBLIC
--
-- End of 0032.

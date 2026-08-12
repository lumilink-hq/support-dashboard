-- =============================================================================
-- 0033_kb_embedding_384.sql
-- Re-dimension the knowledge base from 1536 to 384.
--
-- WHY THIS IS A SEPARATE MIGRATION. 0032 shipped `embedding vector(1536)`,
-- sized for OpenAI text-embedding-3-small, and was applied before the embedding
-- provider was settled. The provider is now Supabase's built-in **gte-small**,
-- run inside the Edge Function via `Supabase.ai`, which returns **384** floats.
--
-- 0032 could not simply be edited: applying a migration records it as done, so
-- changing the file afterwards alters nothing in the database and leaves the
-- repo describing a schema that does not exist. Same lesson as 0027, which
-- exists only because 0025 had already run with the wrong call ceiling.
--
-- WHY gte-small OVER OpenAI
--   * No API key and no per-embedding bill. A nightly re-sync of every client's
--     site becomes compute we already pay for, not a line item that scales with
--     the customer base.
--   * No third-party egress. Client policies, pricing and internal notes stay
--     inside the project — easier to promise than to retract.
--   * A quarter of the storage and a faster index. At the size of a small
--     business's FAQ and policy set, retrieval quality is not the binding
--     constraint; having any KB at all is.
--
-- WHAT IT COSTS: gte-small truncates input at 512 tokens (the chunker targets
-- well under that) and handles heavily paraphrased questions less well than
-- OpenAI. If retrieval quality becomes the complaint, that is the moment to
-- revisit — and it will then cost a full re-embed, which is exactly why the
-- dimension is being pinned deliberately rather than discovered.
--
-- Idempotent / safe to re-apply.
-- =============================================================================

set search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- 1. REFUSE TO RUN IF THERE IS ANYTHING TO LOSE.
--
--    Section 3 drops the column. That is safe today only because nothing has
--    ever written to it — the ingestion worker did not exist when 0032 was
--    applied. If that assumption is wrong, dropping the column silently
--    destroys every embedding and the only symptom is a knowledge base that
--    quietly stops answering.
--
--    So it is checked rather than assumed. A failed migration is recoverable;
--    a silent data loss discovered weeks later is not.
-- -----------------------------------------------------------------------------
do $$
declare
  v_embedded int;
begin
  select count(*) into v_embedded from kb_chunks where embedding is not null;

  if v_embedded > 0 then
    raise exception
      '0033: % chunk(s) already carry a 1536-dim embedding. Dropping the column '
      'would destroy them. Re-embed deliberately: clear kb_chunks, set every '
      'kb_documents row back to status=''pending'', then re-run this migration '
      'and let kb-ingest rebuild them.', v_embedded;
  end if;

  raise notice '0033: no embeddings present, safe to re-dimension';
end $$;

-- -----------------------------------------------------------------------------
-- 2. Drop the ANN index BEFORE the column it indexes.
--
--    An HNSW index is built for a specific dimension and operator class. Left
--    in place it would either block the column change or survive as an index
--    over a type it no longer matches.
-- -----------------------------------------------------------------------------
drop index if exists idx_kb_chunks_embedding;

-- -----------------------------------------------------------------------------
-- 3. Replace the column.
--
--    `drop` + `add` rather than `alter column ... type`, because casting
--    between vector typmods needs a USING clause and produces a confusing error
--    when the dimensions differ. With no data to preserve (section 1 proved it),
--    replacing outright is the honest operation and reads as what it is.
-- -----------------------------------------------------------------------------
alter table kb_chunks drop column if exists embedding;
alter table kb_chunks add  column if not exists embedding vector(384);

comment on column kb_chunks.embedding is
  '384-dim gte-small vector, produced by the kb-ingest worker via Supabase.ai. '
  'Dimension is schema, not config: changing embedding model means altering '
  'this column and re-embedding every chunk.';

-- -----------------------------------------------------------------------------
-- 4. Rebuild the ANN index at the new dimension.
--
--    vector_cosine_ops because match_kb orders by `<=>`. An index built for a
--    different operator class is SILENTLY IGNORED — the query still returns
--    correct rows, just by sequential scan, and the only symptom is a pause
--    before the agent speaks.
-- -----------------------------------------------------------------------------
do $$ begin
  create index idx_kb_chunks_embedding on kb_chunks
    using hnsw (embedding vector_cosine_ops);
exception
  when duplicate_table then null;
  when undefined_object then
    raise notice '0033: hnsw/vector_cosine_ops unavailable; retrieval will sequential-scan. Check the pgvector version.';
end $$;

-- -----------------------------------------------------------------------------
-- 5. match_kb, re-created at 384.
--
--    DROPPED FIRST, and this is not housekeeping. `create or replace` with a
--    different parameter type does not replace anything — Postgres treats a
--    changed argument list as a NEW function and keeps both. PostgREST resolves
--    .rpc() by argument name, so a call would then match two candidates and
--    fail with "could not choose the best candidate function". Every KB lookup
--    would error, on a function that looks correct read in isolation. This is
--    the same trap 0031 documented for apply_billing_event.
--
--    Body is unchanged from 0032 apart from the dimension.
-- -----------------------------------------------------------------------------
drop function if exists match_kb(uuid, vector, int, real);

create or replace function match_kb(
  p_client_id       uuid,
  p_query_embedding vector(384),
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
    -- Cosine DISTANCE (0 = identical) inverted into a similarity, so callers can
    -- reason in "higher is better" and a threshold reads the obvious way.
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
  'Nearest-neighbour KB retrieval scoped to one client, 384-dim gte-small. '
  'SECURITY DEFINER and service_role only — it trusts its client_id argument, '
  'so a tenant-callable version would expose every client''s knowledge base.';

-- =============================================================================
-- 6. VERIFY
-- =============================================================================
--
-- a) The column is 384 (atttypmod carries the dimension + 4):
--
--      select a.attname, format_type(a.atttypid, a.atttypmod) as type
--        from pg_attribute a
--       where a.attrelid = 'kb_chunks'::regclass and a.attname = 'embedding';
--      -- expect: vector(384)
--
-- b) Exactly ONE match_kb, taking a 384-dim vector. Two rows here means the
--    drop did not take and every lookup will fail on ambiguity:
--
--      select pronargs, pg_get_function_identity_arguments(oid)
--        from pg_proc where proname = 'match_kb';
--
-- c) The ANN index came back:
--
--      select indexname, indexdef from pg_indexes where tablename = 'kb_chunks';
--      -- look for hnsw (embedding vector_cosine_ops)
--
-- End of 0033.

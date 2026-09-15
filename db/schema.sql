-- seopipe schema v0 — per-domain schemas. Idempotent (IF NOT EXISTS).
CREATE SCHEMA IF NOT EXISTS comy;
CREATE SCHEMA IF NOT EXISTS coid;
CREATE SCHEMA IF NOT EXISTS shared;

-- Outbox: finished articles waiting for edge pull (Fase 1: .my trickle)
CREATE TABLE IF NOT EXISTS comy.publish_outbox (
  slug            TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,
  service         TEXT DEFAULT '',
  city            TEXT DEFAULT '',
  language        TEXT DEFAULT 'en',
  status          TEXT DEFAULT 'ready',   -- ready|handed|failed
  handed_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_comy_outbox_status ON comy.publish_outbox (status, created_at);

CREATE TABLE IF NOT EXISTS coid.publish_outbox (LIKE comy.publish_outbox INCLUDING ALL);

-- Sync/job bookkeeping
CREATE TABLE IF NOT EXISTS shared.sync_state (
  name       TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS shared.job_runs (
  id         BIGSERIAL PRIMARY KEY,
  job        TEXT NOT NULL,
  status     TEXT NOT NULL,               -- ok|failed|running
  detail     TEXT DEFAULT '',
  started_at TIMESTAMPTZ DEFAULT now(),
  ended_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_job_runs_job ON shared.job_runs (job, started_at DESC);

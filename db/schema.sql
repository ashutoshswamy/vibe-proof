CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  firebase_uid TEXT PRIMARY KEY,
  email TEXT,
  display_name TEXT,
  photo_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_uid TEXT NOT NULL REFERENCES users(firebase_uid) ON DELETE CASCADE,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  score INTEGER NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
  findings JSONB NOT NULL DEFAULT '[]'::jsonb,
  checks JSONB NOT NULL DEFAULT '[]'::jsonb,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scans_user_checked_at_idx ON scans(firebase_uid, checked_at DESC);

CREATE TABLE IF NOT EXISTS rate_limit_events (
  id BIGSERIAL PRIMARY KEY,
  key_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rate_limit_events_key_created_idx ON rate_limit_events(key_hash, created_at DESC);

-- Tamper-evident evidence: append-only, each row carries the hash of the previous row of its run.
-- The DB is only storage; integrity is proven by `npx vibeproof verify <exported report>`, which needs no DB or server.
ALTER TABLE scans ADD COLUMN IF NOT EXISTS slow BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS head TEXT;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS retest_of UUID REFERENCES scans(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS evidence_log (
  run_id UUID NOT NULL,
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  prev TEXT NOT NULL,
  data JSONB NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE OR REPLACE FUNCTION evidence_log_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'evidence_log is append-only'; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS evidence_log_no_change ON evidence_log;
CREATE TRIGGER evidence_log_no_change BEFORE UPDATE OR DELETE ON evidence_log FOR EACH ROW EXECUTE FUNCTION evidence_log_append_only();

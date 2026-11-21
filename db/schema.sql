-- CTRL state. Postgres is the only stateful component; every app instance is stateless.
-- Applied idempotently at boot under an advisory lock.

CREATE TABLE IF NOT EXISTS events (
  id           bigserial PRIMARY KEY,
  received_at  timestamptz NOT NULL DEFAULT now(),
  source       text        NOT NULL,
  schema_fp    text        NOT NULL,
  raw          jsonb       NOT NULL,
  canonical    jsonb       NOT NULL,
  matched      text[]      NOT NULL DEFAULT '{}',
  alert_ids    text[]      NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS events_received_at ON events (received_at DESC);

CREATE TABLE IF NOT EXISTS schemas (
  fingerprint  text PRIMARY KEY,
  source       text        NOT NULL,
  name         text        NOT NULL,
  known_format text,
  fields       jsonb       NOT NULL,
  sample       jsonb,
  mapping      jsonb       NOT NULL DEFAULT '{}',
  mapped_by    jsonb       NOT NULL DEFAULT '{}',
  confidence   jsonb       NOT NULL DEFAULT '{}',
  proposals    jsonb       NOT NULL DEFAULT '[]',
  status       text        NOT NULL,
  event_count  bigint      NOT NULL DEFAULT 0,
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alerts (
  id                  text PRIMARY KEY,
  dedup_key           text        NOT NULL,
  rule_id             text        NOT NULL,
  rule_name           text        NOT NULL,
  team                text        NOT NULL,
  status              text        NOT NULL DEFAULT 'open',
  severity            text        NOT NULL,
  title               text        NOT NULL,
  body                text        NOT NULL DEFAULT '',
  color               text        NOT NULL DEFAULT 'zinc',
  fields              jsonb       NOT NULL DEFAULT '[]',
  steps               jsonb       NOT NULL DEFAULT '[]',
  runbook             jsonb,
  count               integer     NOT NULL DEFAULT 1,
  notified_count      integer     NOT NULL DEFAULT 0,
  notify_seq          integer     NOT NULL DEFAULT 0,
  group_interval_s    integer     NOT NULL DEFAULT 300,
  next_notify_at      timestamptz,
  last_notified_at    timestamptz,
  first_seen          timestamptz NOT NULL DEFAULT now(),
  last_seen           timestamptz NOT NULL DEFAULT now(),
  first_received_at   timestamptz NOT NULL DEFAULT now(),
  last_event_id       bigint,
  source              text        NOT NULL,
  schema_fp           text        NOT NULL,
  schema_name         text        NOT NULL,
  raw                 jsonb       NOT NULL,
  canonical           jsonb       NOT NULL,
  approval_code       text        NOT NULL,
  approval_expires_at timestamptz NOT NULL,
  acked_by            text,
  resolved_by         text,
  resolved_at         timestamptz,
  resolution          text
);
-- One open alert per dedup key; INSERT .. ON CONFLICT relies on this across all instances.
CREATE UNIQUE INDEX IF NOT EXISTS alerts_open_dedup ON alerts (dedup_key) WHERE status <> 'resolved';
CREATE INDEX IF NOT EXISTS alerts_last_seen ON alerts (last_seen DESC);
CREATE INDEX IF NOT EXISTS alerts_notify_due ON alerts (next_notify_at) WHERE next_notify_at IS NOT NULL;
-- Reply codes (6 digits, crypto.randomInt) are unique among alerts that are not resolved; inserts retry on conflict.
-- Older 4-digit codes of open alerts are invalidated (non-numeric, so no reply can match) before the index is built.
DROP INDEX IF EXISTS alerts_code;
UPDATE alerts SET approval_code = 'legacy:' || id WHERE status <> 'resolved' AND approval_code !~ '^(\d{6}|legacy:.*)$';
CREATE UNIQUE INDEX IF NOT EXISTS alerts_code_open ON alerts (approval_code) WHERE status <> 'resolved';

-- Transactional outbox: rows are written in the same transaction as the alert change.
CREATE TABLE IF NOT EXISTS deliveries (
  id                bigserial PRIMARY KEY,
  idempotency_key   text        NOT NULL UNIQUE,
  alert_id          text        NOT NULL,
  recipient         text        NOT NULL,
  address           text        NOT NULL,
  channel           text        NOT NULL,
  reason            text        NOT NULL,
  subject           text        NOT NULL DEFAULT '',
  body              text        NOT NULL DEFAULT '',
  status            text        NOT NULL DEFAULT 'pending',
  attempts          integer     NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  leased_by         text,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  event_received_at timestamptz NOT NULL,
  sent_at           timestamptz
);
CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS deliveries_alert ON deliveries (alert_id);
CREATE INDEX IF NOT EXISTS deliveries_sent_at ON deliveries (sent_at) WHERE status = 'sent';
CREATE INDEX IF NOT EXISTS deliveries_dead ON deliveries (id) WHERE status = 'dead';

CREATE TABLE IF NOT EXISTS audit_log (
  id     bigserial PRIMARY KEY,
  at     timestamptz NOT NULL DEFAULT now(),
  actor  text NOT NULL,
  action text NOT NULL,
  target text NOT NULL,
  detail text
);
CREATE INDEX IF NOT EXISTS audit_at ON audit_log (at DESC);

-- LLM features were removed; drop their leftovers on existing databases.
DROP TABLE IF EXISTS ai_proposals;
ALTER TABLE schemas DROP COLUMN IF EXISTS llm;

-- Rules that failed to evaluate, shown in the console. Cleared when the rule is saved.
CREATE TABLE IF NOT EXISTS rule_errors (
  rule_id    text PRIMARY KEY,
  count      bigint      NOT NULL,
  last_error text        NOT NULL,
  last_at    timestamptz NOT NULL DEFAULT now()
);

-- Failed SMS/email reply attempts per normalised sender. Shared by every instance; the limit is a count over a window.
CREATE TABLE IF NOT EXISTS reply_failures (
  id     bigserial PRIMARY KEY,
  sender text        NOT NULL,
  at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reply_failures_sender_at ON reply_failures (sender, at);

-- Runtime-editable config (rules, recipients, custom fields, runbooks). Seeded from config/*.yaml when empty; every instance
-- caches it in memory and reloads on a pg_notify 'config' event (plus a periodic version check as a fallback).
-- ids: 'rules' {rules}, 'recipients' {default_owner, recipients}, 'fields' {fields}, 'runbook:<id>' {file, format, content}.
CREATE TABLE IF NOT EXISTS config_docs (
  id         text PRIMARY KEY,
  doc        jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text        NOT NULL
);

-- "Propose a fix" (manual, from an alert) and runbook steps learned from resolved alerts (learned).
-- target: 'rule:<id>' or 'runbook:<id>'. An open learned proposal with the same normalised step merges (seen + 1).
CREATE TABLE IF NOT EXISTS proposals (
  id          bigserial PRIMARY KEY,
  kind        text        NOT NULL,
  target      text        NOT NULL,
  reason      text        NOT NULL,
  text        text        NOT NULL,
  patch       jsonb,
  fingerprint text        NOT NULL,
  alert_ids   text[]      NOT NULL DEFAULT '{}',
  seen        integer     NOT NULL DEFAULT 1,
  status      text        NOT NULL DEFAULT 'open',
  created_by  text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  decided_by  text,
  decided_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS proposals_open_fp ON proposals (target, fingerprint) WHERE status = 'open';

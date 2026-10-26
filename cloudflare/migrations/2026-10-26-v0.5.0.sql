-- v0.5.0：源有效期、定时体检、告警、审计、邀请码、反馈、登录设备
-- 执行一次：wrangler d1 execute kaytv-hub --remote --file=./migrations/2026-10-26-v0.5.0.sql

ALTER TABLE sources ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0;

ALTER TABLE sessions ADD COLUMN id TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN device TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN ip TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN ua TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0;
UPDATE sessions SET id = lower(hex(randomblob(16))) WHERE id = '';
UPDATE sessions SET last_seen = created_at WHERE last_seen = 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_sid ON sessions (id);

CREATE TABLE IF NOT EXISTS source_checks (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 0,
  ms INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  trigger TEXT NOT NULL DEFAULT 'manual',
  checked_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checks_source ON source_checks (source_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_checks_time ON source_checks (checked_at DESC);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'warning',
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  source_id TEXT NOT NULL DEFAULT '',
  dedupe TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_dedupe ON alerts (dedupe, status);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL DEFAULT 'admin',
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs (created_at DESC);

CREATE TABLE IF NOT EXISTS invite_codes (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  max_uses INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'feedback',
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  admin_note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_ip ON feedback (ip, created_at DESC);

INSERT OR IGNORE INTO settings (key, value)
SELECT 'registration_mode', CASE WHEN value = '0' THEN 'closed' ELSE 'open' END
FROM settings WHERE key = 'registration_open';
INSERT OR IGNORE INTO settings (key, value) VALUES ('registration_mode', 'open');
INSERT OR IGNORE INTO settings (key, value) VALUES ('min_version', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('update_url', 'https://github.com/kaynai1/kaytv/releases/latest');
INSERT OR IGNORE INTO settings (key, value) VALUES ('alert_fail_threshold', '2');

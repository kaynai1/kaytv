-- KayTV 云后台 D1 数据库结构
-- 执行：wrangler d1 execute kaytv-hub --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('vod', 'live', 'tvbox')),
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 100,
  probe_ok INTEGER,
  probe_ms INTEGER,
  probe_note TEXT NOT NULL DEFAULT '',
  probed_at INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sources_kind ON sources (kind, enabled, sort);

CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  level TEXT NOT NULL DEFAULT 'info',
  link TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  starts_at INTEGER NOT NULL DEFAULT 0,
  ends_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements (active, updated_at);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'blocked')),
  device TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_users_status ON users (status, created_at);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  id TEXT NOT NULL DEFAULT '',
  user_id TEXT NOT NULL,
  device TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  ua TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
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

CREATE TABLE IF NOT EXISTS user_data (
  user_id TEXT PRIMARY KEY,
  favorites TEXT NOT NULL DEFAULT '[]',
  history TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('site_name', 'KayTV'),
  ('registration_open', '1'),
  ('registration_auto_approve', '1'),
  ('registration_mode', 'open'),
  ('min_version', ''),
  ('update_url', 'https://github.com/kaynai1/kaytv/releases/latest'),
  ('alert_fail_threshold', '2');

CREATE TABLE IF NOT EXISTS kanju_config (
  id TEXT PRIMARY KEY,
  base_url TEXT NOT NULL DEFAULT '',
  secret TEXT NOT NULL DEFAULT '',
  client_name TEXT NOT NULL DEFAULT '',
  client_version TEXT NOT NULL DEFAULT '',
  build_version TEXT NOT NULL DEFAULT '',
  protocol_version TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 0,
  auto_refresh INTEGER NOT NULL DEFAULT 1,
  last_ok_at INTEGER NOT NULL DEFAULT 0,
  last_check_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0
);

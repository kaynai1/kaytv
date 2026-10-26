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
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

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
  ('registration_auto_approve', '1');

-- v0.6.0：看剧AI 云端代签（后台填域名自动识别签名参数）
-- 执行一次：npx wrangler@3 d1 execute kaytv-hub --remote --file=./migrations/2026-10-26-v0.6.0.sql
-- 说明：密钥只存 D1，接口只返回掩码，客户端永远拿不到明文。

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

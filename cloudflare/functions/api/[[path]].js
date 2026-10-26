/**
 * KayTV 云后台 API（Cloudflare Pages Functions + D1）
 * 公共：/api/config /api/register /api/login /api/me /api/sync /api/health
 * 管理：/api/admin/*（Bearer ADMIN_TOKEN）
 */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization',
  'access-control-max-age': '86400'
}

const SESSION_TTL = 30 * 24 * 3600 * 1000
const MAX_SYNC_BYTES = 512 * 1024
const PBKDF2_ITERATIONS = 100000
const PROBE_TIMEOUT = 20000
const KANJU_TIMEOUT = 20000
const KANJU_DISCOVER_TIMEOUT = 12000
const KANJU_MAX_BODY = 3 * 1024 * 1024
const KANJU_REFRESH_GAP = 5 * 60 * 1000
const KANJU_DEFAULT_CLIENT = 'dianyingtiantang-frontend'
const KANJU_DEFAULT_CLIENT_VERSION = '1.0.0'

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...CORS
    }
  })
}

function fail(message, status = 400) {
  return json({ ok: false, error: message }, status)
}

function clean(value, max = 200) {
  return String(value ?? '').trim().slice(0, max)
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value))
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function toInt(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.trunc(number) : fallback
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function randomToken(bytes = 32) {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)))
}

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
}

async function safeEqual(left, right) {
  const [a, b] = await Promise.all([sha256(String(left)), sha256(String(right))])
  let diff = 0
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index]
  return diff === 0
}

async function hashPassword(password, saltHex) {
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map((pair) => parseInt(pair, 16)))
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256
  )
  return bytesToHex(new Uint8Array(bits))
}

async function readBody(request) {
  const contentLength = Number(request.headers.get('content-length') || 0)
  if (contentLength > MAX_SYNC_BYTES * 2) throw new Error('内容过大')
  try {
    return await request.json()
  } catch {
    throw new Error('请求内容不是合法 JSON')
  }
}

function registrationModeOf(map) {
  const mode = map.registration_mode
  if (mode === 'open' || mode === 'invite' || mode === 'closed') return mode
  return map.registration_open === '0' ? 'closed' : 'open'
}

async function getSettings(env) {
  const rows = await env.DB.prepare('SELECT key, value FROM settings').all()
  const map = {}
  for (const row of rows.results || []) map[row.key] = row.value
  const registrationMode = registrationModeOf(map)
  return {
    siteName: map.site_name || 'KayTV',
    registrationOpen: registrationMode !== 'closed',
    registrationMode,
    autoApprove: map.registration_auto_approve !== '0',
    minVersion: String(map.min_version || '').trim(),
    updateUrl: String(map.update_url || '').trim(),
    failThreshold: Math.min(5, Math.max(1, toInt(map.alert_fail_threshold, 2)))
  }
}

async function publicConfig(env) {
  const settings = await getSettings(env)
  const now = Date.now()
  const sources = await env.DB.prepare(
    `SELECT id, kind, name, url, type, note FROM sources
     WHERE enabled = 1 ORDER BY sort ASC, created_at ASC`
  ).all()
  const announcement = await env.DB.prepare(
    `SELECT id, title, body, level, link, updated_at FROM announcements
     WHERE active = 1 AND (starts_at = 0 OR starts_at <= ?1) AND (ends_at = 0 OR ends_at >= ?2)
     ORDER BY updated_at DESC LIMIT 1`
  )
    .bind(now, now)
    .first()
  const kanju = await getKanju(env)
  return {
    ok: true,
    siteName: settings.siteName,
    version: now,
    registration: {
      open: settings.registrationOpen,
      mode: settings.registrationMode,
      autoApprove: settings.autoApprove
    },
    minVersion: settings.minVersion,
    updateUrl: settings.updateUrl,
    announcement: announcement
      ? {
          id: announcement.id,
          title: announcement.title,
          body: announcement.body,
          level: announcement.level,
          link: announcement.link,
          updatedAt: announcement.updated_at
        }
      : null,
    sources: (sources.results || []).map((row) => ({
      id: row.id,
      kind: row.kind,
      name: row.name,
      url: row.url,
      type: row.type || '',
      note: row.note || ''
    })),
    kanju: {
      enabled: Boolean(kanju?.enabled && kanju?.base_url && kanju?.secret),
      name: '看剧AI',
      proxy: '/api/kanju'
    }
  }
}

async function requireAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return { error: fail('服务端还没有配置 ADMIN_TOKEN，请在 Cloudflare 后台添加这个密钥', 503) }
  const header = request.headers.get('authorization') || ''
  const token = header.replace(/^Bearer\s+/i, '').trim()
  if (!token || !(await safeEqual(token, env.ADMIN_TOKEN))) {
    return { error: fail('管理员口令不正确', 401) }
  }
  return {}
}

function deviceFromUa(raw) {
  const ua = String(raw || '')
  if (/android/i.test(ua)) return /tv|aft|bravia|googletv/i.test(ua) ? 'Android TV' : 'Android 手机'
  if (/iphone|ipad|ipod/i.test(ua)) return 'iOS'
  if (/windows nt/i.test(ua)) return 'Windows'
  if (/mac os x/i.test(ua)) return 'macOS'
  if (/linux/i.test(ua)) return 'Linux'
  return '未知设备'
}

function clientIp(request) {
  return clean(request.headers.get('cf-connecting-ip') || '', 60)
}

async function fetchTimed(url, init = {}, timeout = KANJU_DISCOVER_TIMEOUT) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function normalizeKanjuUrl(value) {
  let raw = clean(value, 300)
  if (!raw) return ''
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`
  let url
  try {
    url = new URL(raw)
  } catch {
    return ''
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
  const host = url.hostname.toLowerCase()
  if (!host.includes('.') || host === 'localhost' || host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host)) return ''
  if (/^(10|127)\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return ''
  return url.origin
}

function kanjuPathAllowed(path) {
  const cleanPath = path.split('?')[0]
  return cleanPath === '/v1/browse/catalog' || cleanPath.startsWith('/v1/catalog/') || cleanPath.startsWith('/v1/playback/')
}

function kanjuMetaFromSource(text) {
  const clientName = (text.match(/["'](dianyingtiantang-frontend)["']/) || [])[1] || KANJU_DEFAULT_CLIENT
  const buildVersion = (text.match(/["'](dianyingtiantang-v[^"']{1,160})["']/) || [])[1] || ''
  const protocols = [...text.matchAll(/["'](20\d{2}-\d{2}-\d{2}[^"']{0,120})["']/g)].map((match) => match[1])
  const protocolVersion = protocols.find((value) => /playback|library/.test(value)) || protocols[0] || ''
  return { clientName, clientVersion: KANJU_DEFAULT_CLIENT_VERSION, buildVersion, protocolVersion }
}

async function kanjuHeaders(secret, method, path, meta = {}) {
  const timestamp = String(Date.now())
  const nonce = randomToken(16)
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${method}\n${path}\n${timestamp}\n${nonce}`)
  )
  return {
    accept: 'application/json, text/plain, */*',
    'x-ai-movie-timestamp': timestamp,
    'x-ai-movie-nonce': nonce,
    'x-ai-movie-signature': bytesToHex(new Uint8Array(signature)),
    'x-ai-movie-client-name': meta.clientName || KANJU_DEFAULT_CLIENT,
    'x-ai-movie-client-version': meta.clientVersion || KANJU_DEFAULT_CLIENT_VERSION,
    'x-ai-movie-protocol-version': meta.protocolVersion || '',
    'x-ai-movie-build-version': meta.buildVersion || ''
  }
}

async function kanjuRequest(config, path, method = 'GET', body = undefined) {
  const url = new URL(path, config.baseUrl)
  const headers = await kanjuHeaders(config.secret, method, `${url.pathname}${url.search}`, config)
  if (method !== 'GET') headers['content-type'] = 'application/json'
  const response = await fetchTimed(
    url.href,
    {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
      redirect: 'follow'
    },
    KANJU_TIMEOUT
  )
  const text = await response.text()
  if (text.length > KANJU_MAX_BODY) throw new Error('看剧AI 返回内容过大')
  return { response, text }
}

async function discoverKanju(input) {
  const baseUrl = normalizeKanjuUrl(input)
  if (!baseUrl) throw new Error('请输入有效的官网地址，例如 https://kanju78.com')
  const home = await fetchTimed(
    `${baseUrl}/`,
    {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
      },
      redirect: 'follow'
    },
    KANJU_DISCOVER_TIMEOUT
  )
  if (!home.ok) throw new Error(`打开官网失败：HTTP ${home.status}`)
  const finalUrl = home.url || `${baseUrl}/`
  const finalBase = new URL(finalUrl).origin
  const html = (await home.text()).slice(0, KANJU_MAX_BODY)
  const scriptUrls = []
  for (const match of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) scriptUrls.push(match[1])
  for (const match of html.matchAll(/<link[^>]+href=["']([^"']+)["'][^>]*>/gi)) {
    if (/modulepreload|as=["']script["']/i.test(match[0])) scriptUrls.push(match[1])
  }
  const unique = [...new Set(scriptUrls)]
    .map((value) => {
      try {
        const url = new URL(value, finalBase)
        return url.origin === finalBase ? url.href : ''
      } catch {
        return ''
      }
    })
    .filter(Boolean)
    .slice(0, 12)
  const fetched = await Promise.all(
    unique.map(async (url) => {
      try {
        const response = await fetchTimed(
          url,
          {
            headers: {
              accept: '*/*',
              'user-agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
            }
          },
          KANJU_DISCOVER_TIMEOUT
        )
        if (!response.ok) return ''
        return (await response.text()).slice(0, KANJU_MAX_BODY)
      } catch {
        return ''
      }
    })
  )
  const signing = [html, ...fetched].filter((text) =>
    /x-ai-movie-(signature|client-name|timestamp|nonce)/.test(text)
  )
  if (!signing.length) throw new Error('官网页面里没找到看剧AI签名代码，可能官网改版了')
  const joined = signing.join('\n')
  const meta = kanjuMetaFromSource(joined)
  const candidates = [...new Set((joined.match(/["']([0-9a-f]{64})["']/gi) || []).map((value) => value.slice(1, -1)))].slice(0, 8)
  if (!candidates.length) throw new Error('找到了签名代码，但没有提取到密钥')
  for (const secret of candidates) {
    try {
      const result = await kanjuRequest(
        { baseUrl: finalBase, secret, ...meta },
        '/v1/browse/catalog?page=1&limit=1'
      )
      if (!result.response.ok) continue
      const payload = JSON.parse(result.text)
      if (!payload || typeof payload !== 'object') continue
      return { baseUrl: finalBase, secret, ...meta }
    } catch {
      /* try next candidate */
    }
  }
  throw new Error('已提取签名参数，但官方接口验证失败；可能签名协议又变了')
}

async function getKanju(env) {
  try {
    return await env.DB.prepare('SELECT * FROM kanju_config WHERE id = ?1').bind('default').first()
  } catch {
    return null
  }
}

async function saveKanju(env, patch = {}) {
  const current = await getKanju(env)
  const now = Date.now()
  const next = {
    baseUrl: patch.baseUrl ?? current?.base_url ?? '',
    secret: patch.secret ?? current?.secret ?? '',
    clientName: patch.clientName ?? current?.client_name ?? KANJU_DEFAULT_CLIENT,
    clientVersion: patch.clientVersion ?? current?.client_version ?? KANJU_DEFAULT_CLIENT_VERSION,
    buildVersion: patch.buildVersion ?? current?.build_version ?? '',
    protocolVersion: patch.protocolVersion ?? current?.protocol_version ?? '',
    enabled: patch.enabled ?? current?.enabled ?? 0,
    autoRefresh: patch.autoRefresh ?? current?.auto_refresh ?? 1,
    lastOkAt: patch.lastOkAt ?? current?.last_ok_at ?? 0,
    lastCheckAt: patch.lastCheckAt ?? current?.last_check_at ?? 0,
    lastError: patch.lastError ?? current?.last_error ?? '',
    updatedAt: patch.updatedAt ?? now
  }
  await env.DB.prepare(
    `INSERT OR REPLACE INTO kanju_config
      (id, base_url, secret, client_name, client_version, build_version, protocol_version,
       enabled, auto_refresh, last_ok_at, last_check_at, last_error, updated_at)
     VALUES ('default', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
  )
    .bind(
      next.baseUrl,
      next.secret,
      next.clientName,
      next.clientVersion,
      next.buildVersion,
      next.protocolVersion,
      next.enabled,
      next.autoRefresh,
      next.lastOkAt,
      next.lastCheckAt,
      String(next.lastError || '').slice(0, 300),
      next.updatedAt
    )
    .run()
  return next
}

function kanjuInfo(row) {
  return {
    configured: Boolean(row?.base_url && row?.secret),
    enabled: Boolean(row?.enabled),
    autoRefresh: row ? Boolean(row.auto_refresh) : true,
    baseUrl: row?.base_url || '',
    secretMasked: row?.secret ? `${row.secret.slice(0, 4)}…${row.secret.slice(-4)}` : '',
    clientName: row?.client_name || '',
    clientVersion: row?.client_version || '',
    buildVersion: row?.build_version || '',
    protocolVersion: row?.protocol_version || '',
    lastOkAt: row?.last_ok_at || 0,
    lastCheckAt: row?.last_check_at || 0,
    lastError: row?.last_error || '',
    updatedAt: row?.updated_at || 0
  }
}

async function refreshKanju(env, row, force = false) {
  if (!row?.auto_refresh || !row?.base_url) return null
  const now = Date.now()
  if (!force && now - (row.last_check_at || 0) < KANJU_REFRESH_GAP) return null
  try {
    const found = await discoverKanju(row.base_url)
    const saved = await saveKanju(env, {
      ...found,
      enabled: 1,
      lastOkAt: now,
      lastCheckAt: now,
      lastError: '',
      updatedAt: now
    })
    return saved
  } catch (error) {
    await saveKanju(env, {
      lastCheckAt: now,
      lastError: String(error?.message || error).slice(0, 200)
    })
    return null
  }
}

async function handleKanjuProxy(segments, request, env) {
  const method = request.method.toUpperCase()
  if (method !== 'GET' && method !== 'POST') return fail('只支持 GET / POST', 405)
  const path = '/' + segments.slice(1).join('/')
  if (!kanjuPathAllowed(path)) return fail('接口不存在', 404)
  const row = await getKanju(env)
  if (!row?.enabled || !row.base_url || !row.secret) return fail('云端看剧AI还没有启用', 503)
  const query = new URL(request.url).search
  const pathWithQuery = path + query
  let body
  if (method === 'POST') {
    const text = await request.text()
    if (text.length > 64 * 1024) return fail('请求内容过大', 413)
    try {
      body = text ? JSON.parse(text) : {}
    } catch {
      return fail('请求内容不是 JSON', 400)
    }
  }
  let config = {
    baseUrl: row.base_url,
    secret: row.secret,
    clientName: row.client_name,
    clientVersion: row.client_version,
    buildVersion: row.build_version,
    protocolVersion: row.protocol_version
  }
  try {
    let result = await kanjuRequest(config, pathWithQuery, method, body)
    if ((result.response.status === 401 || result.response.status === 403) && row.auto_refresh) {
      const recentFailure =
        Date.now() - (row.last_check_at || 0) < 60 * 1000 && /401|403|验证失败|签名/.test(row.last_error || '')
      const refreshed = recentFailure ? null : await refreshKanju(env, row, true)
      if (refreshed) {
        config = {
          baseUrl: refreshed.baseUrl,
          secret: refreshed.secret,
          clientName: refreshed.clientName,
          clientVersion: refreshed.clientVersion,
          buildVersion: refreshed.buildVersion,
          protocolVersion: refreshed.protocolVersion
        }
        result = await kanjuRequest(config, pathWithQuery, method, body)
      }
    }
    if (!result.response.ok) {
      await saveKanju(env, { lastCheckAt: Date.now(), lastError: `HTTP ${result.response.status}` })
      return fail(`看剧AI 接口暂时不可用（HTTP ${result.response.status}）`, 502)
    }
    let payload
    try {
      payload = JSON.parse(result.text)
    } catch {
      return fail('看剧AI 返回内容不是 JSON', 502)
    }
    if (Date.now() - (row.last_ok_at || 0) > 5 * 60 * 1000) {
      await saveKanju(env, { lastOkAt: Date.now(), lastCheckAt: Date.now(), lastError: '' })
    }
    return json(payload)
  } catch (error) {
    await saveKanju(env, {
      lastCheckAt: Date.now(),
      lastError: String(error?.message || error).slice(0, 200)
    })
    return fail('看剧AI 接口连接失败', 502)
  }
}


async function currentUser(request, env) {
  const header = request.headers.get('authorization') || ''
  const token = header.replace(/^Bearer\s+/i, '').trim()
  if (!token) return null
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.status, u.device, u.created_at, u.last_seen,
            s.id AS session_id, s.last_seen AS session_seen
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ?1 AND s.expires_at > ?2`
  )
    .bind(token, Date.now())
    .first()
  if (!row || row.status !== 'active') return null
  if (Date.now() - (row.session_seen || 0) > 5 * 60 * 1000) {
    await env.DB.prepare('UPDATE sessions SET last_seen = ?1 WHERE id = ?2').bind(Date.now(), row.session_id).run()
  }
  return row
}

async function createSession(env, userId, request, device) {
  const token = randomToken()
  const id = crypto.randomUUID()
  const now = Date.now()
  const ip = request ? clientIp(request) : ''
  const ua = request ? clean(request.headers.get('user-agent') || '', 300) : ''
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(now).run()
  await env.DB.prepare(
    `INSERT INTO sessions (token, id, user_id, device, ip, ua, created_at, last_seen, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
  )
    .bind(token, id, userId, clean(device, 80) || deviceFromUa(ua), ip, ua, now, now, now + SESSION_TTL)
    .run()
  return { token, expiresAt: now + SESSION_TTL }
}

async function audit(env, request, action, target = '', detail = '', actor = 'admin') {
  try {
    await env.DB.prepare(
      'INSERT INTO audit_logs (id, actor, action, target, detail, ip, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)'
    )
      .bind(
        crypto.randomUUID(),
        clean(actor, 20) || 'admin',
        clean(action, 40),
        clean(target, 120),
        clean(typeof detail === 'string' ? detail : JSON.stringify(detail), 500),
        request ? clientIp(request) : '',
        Date.now()
      )
      .run()
  } catch (error) {
    console.error('audit failed', error)
  }
}

async function openAlert(env, { kind, level = 'warning', title, body = '', sourceId = '', dedupe = '' }) {
  const key = dedupe || `${kind}:${sourceId}:${title}`
  const exists = await env.DB.prepare("SELECT id FROM alerts WHERE dedupe = ?1 AND status = 'open'").bind(key).first()
  if (exists) return false
  await env.DB.prepare(
    `INSERT INTO alerts (id, kind, level, title, body, source_id, dedupe, status, created_at, resolved_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'open', ?8, 0)`
  )
    .bind(crypto.randomUUID(), clean(kind, 30), clean(level, 10), clean(title, 120), clean(body, 500), sourceId, key, Date.now())
    .run()
  return true
}

async function resolveAlerts(env, kind, sourceId) {
  await env.DB.prepare(
    "UPDATE alerts SET status = 'resolved', resolved_at = ?1 WHERE status = 'open' AND kind = ?2 AND source_id = ?3"
  )
    .bind(Date.now(), kind, sourceId)
    .run()
}

async function recordSourceCheck(env, source, result, trigger, threshold) {
  const now = Date.now()
  await env.DB.prepare(
    'UPDATE sources SET probe_ok=?1, probe_ms=?2, probe_note=?3, probed_at=?4 WHERE id=?5'
  )
    .bind(result.ok ? 1 : 0, result.ms, result.note, now, source.id)
    .run()
  await env.DB.prepare(
    'INSERT INTO source_checks (id, source_id, ok, ms, note, trigger, checked_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)'
  )
    .bind(crypto.randomUUID(), source.id, result.ok ? 1 : 0, result.ms, clean(result.note, 200), clean(trigger, 20), now)
    .run()
  if (result.ok) {
    await resolveAlerts(env, 'source_fail', source.id)
    return false
  }
  const rows = await env.DB.prepare(
    'SELECT ok FROM source_checks WHERE source_id = ?1 ORDER BY checked_at DESC LIMIT ?2'
  )
    .bind(source.id, threshold)
    .all()
  const recent = rows.results || []
  if (recent.length >= threshold && recent.every((row) => !row.ok)) {
    return openAlert(env, {
      kind: 'source_fail',
      level: 'critical',
      title: `源不可用：${source.name}`,
      body: `连续 ${threshold} 次检测失败，最近一次：${result.note}`,
      sourceId: source.id,
      dedupe: `source_fail:${source.id}`
    })
  }
  return false
}

async function checkSourceExpiry(env) {
  const now = Date.now()
  const rows = await env.DB.prepare('SELECT id, name, expires_at FROM sources WHERE expires_at > 0').all()
  let created = 0
  for (const row of rows.results || []) {
    if (row.expires_at <= now) {
      const added = await openAlert(env, {
        kind: 'source_expire',
        level: 'critical',
        title: `源已过期：${row.name}`,
        body: `有效期已过（${new Date(row.expires_at).toISOString().slice(0, 10)}），请更新地址或续期`,
        sourceId: row.id,
        dedupe: `source_expire:${row.id}:${row.expires_at}`
      })
      if (added) created++
    } else if (row.expires_at - now <= 3 * 86400000) {
      const days = Math.max(1, Math.ceil((row.expires_at - now) / 86400000))
      const added = await openAlert(env, {
        kind: 'source_expire',
        level: 'warning',
        title: `源即将到期：${row.name}`,
        body: `${days} 天后到期（${new Date(row.expires_at).toISOString().slice(0, 10)}）`,
        sourceId: row.id,
        dedupe: `source_expire:${row.id}:${row.expires_at}`
      })
      if (added) created++
    } else {
      await resolveAlerts(env, 'source_expire', row.id)
    }
  }
  return created
}

async function runHealthSweep(env, trigger, limit = 4, since = 0) {
  const cutoff = since > 0 ? since : Date.now()
  const settings = await getSettings(env)
  const rows = await env.DB.prepare(
    'SELECT * FROM sources WHERE enabled = 1 AND probed_at < ?1 ORDER BY probed_at ASC, sort ASC LIMIT ?2'
  )
    .bind(cutoff, Math.min(20, Math.max(1, limit)))
    .all()
  const sources = rows.results || []
  const results = await Promise.all(
    sources.map(async (source) => ({ source, result: await probeSource(source) }))
  )
  let alerts = 0
  for (const { source, result } of results) {
    if (await recordSourceCheck(env, source, result, trigger, settings.failThreshold)) alerts++
  }
  alerts += await checkSourceExpiry(env)
  const remainingRow = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM sources WHERE enabled = 1 AND probed_at < ?1'
  )
    .bind(cutoff)
    .first()
  const remaining = remainingRow?.n || 0
  if (!remaining) {
    await env.DB.prepare('DELETE FROM source_checks WHERE checked_at < ?1')
      .bind(Date.now() - 30 * 86400000)
      .run()
    await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?1").bind(Date.now()).run()
  }
  return {
    since: cutoff,
    checked: sources.length,
    ok: results.filter((item) => item.result.ok).length,
    failed: results.filter((item) => !item.result.ok).length,
    alerts,
    remaining
  }
}

function userPayload(row) {
  return {
    id: row.id,
    username: row.username,
    status: row.status,
    device: row.device || '',
    createdAt: row.created_at,
    lastSeen: row.last_seen
  }
}

function stripJsonComments(text) {
  let out = ''
  let inString = false
  let escape = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      out += char
      if (escape) escape = false
      else if (char === '\\') escape = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index++
      out += '\n'
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      index = end < 0 ? text.length : end + 1
      continue
    }
    out += char
  }
  return out
}

function escapeControlsInStrings(text) {
  let out = ''
  let inString = false
  let escape = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (!inString) {
      if (char === '"') inString = true
      out += char
      continue
    }
    if (escape) {
      out += char
      escape = false
      continue
    }
    if (char === '\\') {
      out += char
      escape = true
      continue
    }
    if (char === '"') {
      inString = false
      out += char
      continue
    }
    const code = char.charCodeAt(0)
    if (code < 0x20) out += char === '\n' ? '\\n' : char === '\r' ? '\\r' : char === '\t' ? '\\t' : ' '
    else out += char
  }
  return out
}

function parseConfigObject(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  const body = text.slice(start, end + 1)
  const noComments = stripJsonComments(body)
  for (const variant of [body, noComments, escapeControlsInStrings(noComments)]) {
    try {
      const parsed = JSON.parse(variant)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      /* 下一种写法 */
    }
  }
  return null
}

/** TVBox 配置可能带注释、字符串内换行，或被 base64 包在图片里 */
function parseTvboxConfig(text) {
  const direct = parseConfigObject(text)
  if (direct) return direct
  const matches = text.match(/[A-Za-z0-9+/][A-Za-z0-9+/\r\n]{180,}={0,2}/g)
  if (!matches) return null
  for (const match of [...matches].sort((a, b) => b.length - a.length).slice(0, 3)) {
    try {
      const binary = atob(match.replace(/[\r\n]/g, ''))
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
      const parsed = parseConfigObject(new TextDecoder().decode(bytes))
      if (parsed) return parsed
    } catch {
      /* 不是可解码的配置 */
    }
  }
  return null
}

const NON_API_HOST_RE =
  /(?:^|\.)(?:example\.(?:com|org|net)|localhost|127\.0\.0\.1|api\.cloudflare\.com|api\.vercel\.com|api\.netlify\.com|huggingface\.co|github\.com|raw\.githubusercontent\.com|gitee\.com)$/i

function isUsableApiUrl(raw) {
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    if (!parsed.hostname || !parsed.hostname.includes('.')) return false
    return !NON_API_HOST_RE.test(parsed.hostname)
  } catch {
    return false
  }
}

function extractMacCmsFromJs(jsCode) {
  const apis = []
  const seen = new Set()

  const patterns = [
    /['"`](https?:\/\/[^'"`\s]+\/api\.php\/provide\/vod)[^'"`\s]*['"`]/gi,
    /['"`](https?:\/\/[^'"`\s]+\/mac_cms)[^'"`\s]*['"`]/gi,
    /['"`](https?:\/\/[^'"`\s]+\/index\.php\/vod)[^'"`\s]*['"`]/gi,
  ]

  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(jsCode)) !== null) {
      const url = match[1].replace(/\/+$/, '')
      if (!seen.has(url) && isUsableApiUrl(url)) {
        seen.add(url)
        apis.push({ url })
      }
    }
  }

  return apis.slice(0, 5)
}

function isPluginFileUrl(raw) {
  try {
    return /\.(?:js|js\.md5|md5)$/i.test(new URL(raw).pathname)
  } catch {
    return false
  }
}

/** .md5 文件只存一行哈希，需要去掉后缀再取真正的 JS 源码 */
async function fetchPluginText(rawUrl) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12000)
  const headers = { accept: '*/*', 'user-agent': 'KayTV-Hub/1.0 (+https://github.com/kaynai1/kaytv)' }
  const get = async (url) => {
    const response = await fetch(url, { headers, redirect: 'follow', signal: controller.signal })
    return response.ok ? response.text() : ''
  }
  try {
    let text = await get(rawUrl)
    if (!text) return ''
    let pathname = rawUrl
    try {
      pathname = new URL(rawUrl).pathname
    } catch {
      /* 保持原样 */
    }
    const hashOnly = /^[a-f0-9]{32}$/i.test(text.trim())
    if (/\.md5$/i.test(pathname) || hashOnly) {
      const jsUrl = rawUrl.replace(/\.md5$/i, '')
      if (jsUrl !== rawUrl) {
        const jsText = await get(jsUrl)
        if (jsText) text = jsText
      }
    }
    return text
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
  }
}

function isPlayableHttp(raw) {
  const value = String(raw || '')
  if (!/^https?:\/\//i.test(value)) return false
  const host = value.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0]
  if (/^(127\.|0\.0\.0\.0$|localhost$|\[::1\]$)/i.test(host)) return false
  if (/^192\.168\./.test(host) || /^10\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false
  return true
}

function resolvePlayableHttp(raw, base) {
  const value = String(raw || '')
  if (!value) return ''
  try {
    const resolved = new URL(value, base).href
    return isPlayableHttp(resolved) ? resolved : ''
  } catch {
    return ''
  }
}

function summarizeTvbox(config, base) {
  let vod = 0
  let live = 0
  let skipped = 0
  for (const item of Array.isArray(config.sites) ? config.sites : []) {
    if (Number(item?.type) === 1 && resolvePlayableHttp(item?.api, base)) vod++
    else if (item?.api || item?.name) skipped++
  }
  for (const item of Array.isArray(config.lives) ? config.lives : []) {
    if (resolvePlayableHttp(item?.url, base)) live++
    else {
      for (const channel of Array.isArray(item?.channels) ? item.channels : []) {
        if (resolvePlayableHttp((channel?.urls || [])[0], base)) live++
      }
    }
  }
  return { vod, live, skipped }
}

async function expandTvbox(text, base, signal, totals, seen, depth) {
  const config = parseTvboxConfig(text)
  if (!config) return
  if (Array.isArray(config.urls) && config.urls.length && !config.sites && !config.lives) {
    if (depth >= 2) return
    await Promise.all(
      config.urls.slice(0, 10).map(async (child) => {
        let childUrl = ''
        try {
          childUrl = new URL(String(child?.url || ''), base).href
        } catch {
          return
        }
        if (!/^https?:\/\//i.test(childUrl) || seen.has(childUrl)) return
        seen.add(childUrl)
        try {
          const response = await fetch(childUrl, {
            headers: {
              accept: '*/*',
              'user-agent': 'KayTV-Hub/1.0 (+https://github.com/kaynai1/kaytv)'
            },
            redirect: 'follow',
            signal
          })
          if (!response.ok) return
          await expandTvbox(await response.text(), childUrl, signal, totals, seen, depth + 1)
        } catch {
          /* 单个子订阅失败不影响整体 */
        }
      })
    )
    return
  }
  const summary = summarizeTvbox(config, base)
  totals.vod += summary.vod
  totals.live += summary.live
  totals.skipped += summary.skipped
}

async function probeSource(row) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT)
  const started = Date.now()
  try {
    let target = row.url
    if (row.kind === 'vod') {
      const url = new URL(target)
      url.searchParams.set('ac', 'list')
      target = url.toString()
    }
    const response = await fetch(target, {
      headers: {
        accept: '*/*',
        'user-agent': 'KayTV-Hub/1.0 (+https://github.com/kaynai1/kaytv)'
      },
      redirect: 'follow',
      signal: controller.signal
    })
    const ms = Date.now() - started
    if (!response.ok) return { ok: false, ms, note: `HTTP ${response.status}` }
    let text = await response.text()
    const trimmed = text.trim()
    let pathname = ''
    try {
      pathname = new URL(row.url).pathname
    } catch {
      /* 已在入库时校验过 http(s) */
    }
    // If it's a .md5 file or just an MD5 hash, fetch the actual .js file
    let actualUrl = row.url
    if (/\.md5$/i.test(pathname) || /^[a-f0-9]{32}$/i.test(trimmed)) {
      actualUrl = row.url.replace(/\.md5$/i, '')
      try {
        const jsResponse = await fetch(actualUrl, {
          headers: {
            accept: '*/*',
            'user-agent': 'KayTV-Hub/1.0 (+https://github.com/kaynai1/kaytv)'
          },
          redirect: 'follow',
          signal: controller.signal
        })
        if (jsResponse.ok) {
          text = await jsResponse.text()
        }
      } catch {
        /* 保持原文本 */
      }
    }
    if (/\.(?:js|js\.md5|md5)$/i.test(pathname) || /^[a-f0-9]{32}$/i.test(trimmed)) {
      const extracted = extractMacCmsFromJs(text)
      if (extracted.length > 0) {
        return {
          ok: false,
          ms,
          note: `JS 插件本身不能直接播放；删除本源并重新添加该地址会自动展开为 ${extracted.length} 个采集接口：${extracted.map((e) => e.url).join(', ')}`
        }
      }
      return { ok: false, ms, note: 'JS 插件里没有找到可用的采集接口，需要专用内核执行，无法直接展开' }
    }
    if (row.kind === 'vod') {
      let payload = null
      try {
        payload = JSON.parse(text)
      } catch {
        /* 也许填的是 TVBox 配置 */
      }
      if (!payload) {
        if (parseTvboxConfig(text)) return { ok: false, ms, note: '这是 TVBox 配置，请把源类型改成「TVBox 配置」' }
        return { ok: false, ms, note: '返回的不是 JSON' }
      }
      const list = Array.isArray(payload?.list) ? payload.list : []
      if (!list.length) return { ok: false, ms, note: '接口能访问，但列表为空' }
      return { ok: true, ms, note: `返回 ${list.length} 条` }
    }
    if (row.kind === 'live') {
      const body = text.slice(0, 200000)
      if (!body.trim()) return { ok: false, ms, note: '内容为空' }
      const playlist = /#EXTM3U|#EXTINF|#genre#/i.test(body)
      if (!playlist && parseTvboxConfig(body)) {
        return { ok: false, ms, note: '这是 TVBox 配置，请把源类型改成「TVBox 配置」' }
      }
      return { ok: playlist, ms, note: playlist ? '播放列表正常' : '能访问，但不像 m3u/txt 频道表' }
    }
    if (!text.trim()) return { ok: false, ms, note: '内容为空' }
    const config = parseTvboxConfig(text)
    if (!config) return { ok: false, ms, note: '能访问，但不是可识别的 TVBox 配置' }
    const totals = { vod: 0, live: 0, skipped: 0 }
    await expandTvbox(text, row.url, controller.signal, totals, new Set([row.url]), 0)
    const { vod, live, skipped } = totals
    if (!vod && !live) return { ok: false, ms, note: `配置里只有 ${skipped} 个爬虫站点，客户端无法展开` }
    return {
      ok: true,
      ms,
      note: `可展开 ${vod} 个影视源、${live} 个直播源${skipped ? `；${skipped} 个爬虫站点无法接入` : ''}`
    }
  } catch (error) {
    const ms = Date.now() - started
    const message = error?.name === 'AbortError' ? '超时' : String(error?.message || error)
    return { ok: false, ms, note: message.slice(0, 120) }
  } finally {
    clearTimeout(timer)
  }
}

async function handlePublic(segments, request, env) {
  const method = request.method.toUpperCase()
  if (!env.DB) return fail('还没有绑定 D1 数据库（变量名必须叫 DB）', 503)

  if (segments[0] === 'health' && method === 'GET') {
    return json({ ok: true, time: Date.now() })
  }

  if (segments[0] === 'config' && method === 'GET') {
    return json(await publicConfig(env))
  }

  if (segments[0] === 'kanju') {
    return await handleKanjuProxy(segments, request, env)
  }

  if (segments[0] === 'internal' && segments[1] === 'health-sweep' && method === 'POST') {
    if (!env.CRON_TOKEN) return fail('服务端还没有配置 CRON_TOKEN', 503)
    const header = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim()
    if (!header || !(await safeEqual(header, env.CRON_TOKEN))) return fail('无权访问', 401)
    let body = {}
    try {
      body = await readBody(request)
    } catch {
      body = {}
    }
    const result = await runHealthSweep(env, 'cron', 4, toInt(body.since, 0))
    await audit(env, null, 'sweep.run', '', `定时体检 ${result.checked} 个源，失败 ${result.failed} 个`, 'cron')
    return json({ ok: true, ...result })
  }

  if (segments[0] === 'register' && method === 'POST') {
    const settings = await getSettings(env)
    if (settings.registrationMode === 'closed') return fail('后台暂未开放注册', 403)
    let body
    try {
      body = await readBody(request)
    } catch (error) {
      return fail(error.message)
    }
    const username = clean(body.username, 24)
    const password = String(body.password || '')
    const device = clean(body.device, 80)
    if (!/^[A-Za-z0-9_\u4e00-\u9fa5-]{2,24}$/.test(username)) {
      return fail('用户名需要 2-24 位，支持中文、字母、数字、下划线')
    }
    if (password.length < 6 || password.length > 64) return fail('密码需要 6-64 位')
    const now = Date.now()
    let invite = null
    if (settings.registrationMode === 'invite') {
      const code = clean(body.inviteCode, 32).toUpperCase()
      if (!code) return fail('注册需要邀请码', 403)
      invite = await env.DB.prepare('SELECT * FROM invite_codes WHERE code = ?1').bind(code).first()
      if (
        !invite ||
        !invite.enabled ||
        invite.used_count >= invite.max_uses ||
        (invite.expires_at && invite.expires_at < now)
      ) {
        return fail('邀请码无效、已用完或已过期', 403)
      }
    }
    const exists = await env.DB.prepare('SELECT id FROM users WHERE username = ?1').bind(username).first()
    if (exists) return fail('这个用户名已经注册了', 409)
    if (invite) {
      const consumed = await env.DB.prepare(
        'UPDATE invite_codes SET used_count = used_count + 1 WHERE id = ?1 AND enabled = 1 AND used_count < max_uses'
      )
        .bind(invite.id)
        .run()
      if ((consumed.meta?.changes || 0) < 1) return fail('邀请码刚刚被用完了，请换一个', 409)
    }
    const id = crypto.randomUUID()
    const salt = randomToken(16)
    const passHash = await hashPassword(password, salt)
    const status = settings.autoApprove ? 'active' : 'pending'
    await env.DB.prepare(
      `INSERT INTO users (id, username, pass_hash, salt, status, device, note, created_at, last_seen)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', ?7, ?8)`
    )
      .bind(id, username, passHash, salt, status, device, now, now)
      .run()
    await audit(
      env,
      request,
      'user.register',
      username,
      invite ? `邀请码 ${invite.code} 注册` : '开放注册',
      'user'
    )
    if (status === 'pending') {
      return json({ ok: true, pending: true, message: '注册成功，等管理员审核通过后就能登录同步' })
    }
    const session = await createSession(env, id, request, device)
    return json({
      ok: true,
      token: session.token,
      expiresAt: session.expiresAt,
      user: { id, username, status, device, createdAt: now, lastSeen: now }
    })
  }

  if (segments[0] === 'login' && method === 'POST') {
    let body
    try {
      body = await readBody(request)
    } catch (error) {
      return fail(error.message)
    }
    const username = clean(body.username, 24)
    const password = String(body.password || '')
    if (!username || !password) return fail('请输入用户名和密码')
    const row = await env.DB.prepare('SELECT * FROM users WHERE username = ?1').bind(username).first()
    if (!row) return fail('用户名或密码不对', 401)
    const hash = await hashPassword(password, row.salt)
    if (!(await safeEqual(hash, row.pass_hash))) return fail('用户名或密码不对', 401)
    if (row.status === 'pending') return fail('账号还在等管理员审核', 403)
    if (row.status === 'blocked') return fail('账号已被管理员停用', 403)
    const now = Date.now()
    const device = clean(body.device, 80) || deviceFromUa(request.headers.get('user-agent') || '')
    await env.DB.prepare('UPDATE users SET last_seen = ?1, device = ?2 WHERE id = ?3').bind(now, device, row.id).run()
    const session = await createSession(env, row.id, request, device)
    return json({
      ok: true,
      token: session.token,
      expiresAt: session.expiresAt,
      user: { id: row.id, username: row.username, status: row.status, device, createdAt: row.created_at, lastSeen: now }
    })
  }

  if (segments[0] === 'logout' && method === 'POST') {
    const header = request.headers.get('authorization') || ''
    const token = header.replace(/^Bearer\s+/i, '').trim()
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token = ?1').bind(token).run()
    return json({ ok: true })
  }

  if (segments[0] === 'me' && method === 'GET') {
    const user = await currentUser(request, env)
    if (!user) return fail('登录已失效', 401)
    return json({ ok: true, user: userPayload(user) })
  }

  if (segments[0] === 'sessions') {
    const user = await currentUser(request, env)
    if (!user) return fail('登录已失效', 401)
    if (method === 'GET' && !segments[1]) {
      const rows = await env.DB.prepare(
        `SELECT id, device, ip, ua, created_at, last_seen FROM sessions
         WHERE user_id = ?1 AND expires_at > ?2 ORDER BY last_seen DESC LIMIT 30`
      )
        .bind(user.id, Date.now())
        .all()
      return json({
        ok: true,
        sessions: (rows.results || []).map((row) => ({
          id: row.id,
          device: row.device || '',
          ip: row.ip || '',
          ua: row.ua || '',
          createdAt: row.created_at,
          lastSeen: row.last_seen,
          current: row.id === user.session_id
        }))
      })
    }
    if (method === 'POST' && segments[1] === 'revoke') {
      let body
      try {
        body = await readBody(request)
      } catch (error) {
        return fail(error.message)
      }
      const target = clean(body.id, 40)
      if (!target) return fail('请选择要下线的设备')
      await env.DB.prepare('DELETE FROM sessions WHERE id = ?1 AND user_id = ?2').bind(target, user.id).run()
      await audit(env, request, 'session.revoke', user.username, `下线设备 ${target}`, 'user')
      return json({ ok: true, self: target === user.session_id })
    }
    if (method === 'POST' && segments[1] === 'revoke-others') {
      await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1 AND id != ?2').bind(user.id, user.session_id).run()
      await audit(env, request, 'session.revoke-others', user.username, '下线其他所有设备', 'user')
      return json({ ok: true })
    }
  }

  if (segments[0] === 'feedback') {
    const user = await currentUser(request, env)
    if (method === 'POST' && !segments[1]) {
      const ip = clientIp(request)
      const recent = ip
        ? await env.DB.prepare('SELECT created_at FROM feedback WHERE ip = ?1 ORDER BY created_at DESC LIMIT 1').bind(ip).first()
        : null
      if (recent && Date.now() - recent.created_at < 15000) return fail('提交太快了，15 秒后再试', 429)
      let body
      try {
        body = await readBody(request)
      } catch (error) {
        return fail(error.message)
      }
      const title = clean(body.title, 80)
      const content = clean(body.body, 1500)
      if (!title) return fail('请填写标题')
      if (content.length < 4) return fail('内容至少写几个字，方便我们处理')
      const kind = ['request', 'problem', 'other'].includes(body.kind) ? body.kind : 'feedback'
      const now = Date.now()
      const rowId = crypto.randomUUID()
      await env.DB.prepare(
        `INSERT INTO feedback (id, user_id, username, kind, title, body, contact, device, ip, status, admin_note, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'open', '', ?10, ?10)`
      )
        .bind(
          rowId,
          user?.id || '',
          user?.username || '',
          kind,
          title,
          content,
          clean(body.contact, 120),
          clean(body.device, 80) || deviceFromUa(request.headers.get('user-agent') || ''),
          ip,
          now
        )
        .run()
      return json({ ok: true, id: rowId, message: '已收到，管理员会尽快处理' })
    }
    if (method === 'GET' && !segments[1]) {
      if (!user) return fail('登录已失效', 401)
      const rows = await env.DB.prepare(
        `SELECT id, kind, title, body, status, admin_note, created_at, updated_at FROM feedback
         WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 20`
      )
        .bind(user.id)
        .all()
      return json({ ok: true, feedback: rows.results || [] })
    }
  }

  if (segments[0] === 'sync') {
    const user = await currentUser(request, env)
    if (!user) return fail('登录已失效', 401)
    if (method === 'GET') {
      const row = await env.DB.prepare('SELECT favorites, history, updated_at FROM user_data WHERE user_id = ?1')
        .bind(user.id)
        .first()
      let favorites = []
      let history = {}
      try {
        favorites = row ? JSON.parse(row.favorites) : []
        history = row ? JSON.parse(row.history) : {}
      } catch {
        favorites = []
        history = {}
      }
      return json({ ok: true, favorites, history, updatedAt: row?.updated_at || 0 })
    }
    if (method === 'PUT' || method === 'POST') {
      let body
      try {
        body = await readBody(request)
      } catch (error) {
        return fail(error.message)
      }
      const favorites = Array.isArray(body.favorites) ? body.favorites : []
      const history = body.history && typeof body.history === 'object' ? body.history : {}
      const favoritesText = JSON.stringify(favorites)
      const historyText = JSON.stringify(history)
      const total = favoritesText.length + historyText.length
      if (total > MAX_SYNC_BYTES) return fail('收藏和进度太大了，超过 512KB', 413)
      const now = Date.now()
      await env.DB.prepare(
        `INSERT INTO user_data (user_id, favorites, history, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(user_id) DO UPDATE SET favorites = excluded.favorites, history = excluded.history, updated_at = excluded.updated_at`
      )
        .bind(user.id, favoritesText, historyText, now)
        .run()
      await env.DB.prepare('UPDATE users SET last_seen = ?1 WHERE id = ?2').bind(now, user.id).run()
      return json({ ok: true, updatedAt: now, favorites: favorites.length, history: Object.keys(history).length })
    }
  }

  return fail('接口不存在', 404)
}

async function handleAdmin(segments, request, env) {
  const method = request.method.toUpperCase()
  if (!env.DB) return fail('还没有绑定 D1 数据库（变量名必须叫 DB）', 503)
  const auth = await requireAdmin(request, env)
  if (auth.error) return auth.error

  const area = segments[1]
  const id = segments[2]

  if (area === 'overview' && method === 'GET') {
    const counts = await env.DB.batch([
      env.DB.prepare("SELECT kind, COUNT(*) AS n FROM sources GROUP BY kind"),
      env.DB.prepare("SELECT status, COUNT(*) AS n FROM users GROUP BY status"),
      env.DB.prepare('SELECT COUNT(*) AS n FROM announcements'),
      env.DB.prepare('SELECT COUNT(*) AS n FROM user_data'),
      env.DB.prepare("SELECT COUNT(*) AS n FROM alerts WHERE status = 'open'"),
      env.DB.prepare("SELECT COUNT(*) AS n FROM feedback WHERE status = 'open'"),
      env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?1').bind(Date.now()),
      env.DB.prepare("SELECT COUNT(*) AS n FROM invite_codes WHERE enabled = 1 AND (expires_at = 0 OR expires_at > ?1)").bind(Date.now())
    ])
    const sourceMap = { vod: 0, live: 0, tvbox: 0 }
    for (const row of counts[0].results || []) sourceMap[row.kind] = row.n
    const userMap = { pending: 0, active: 0, blocked: 0 }
    for (const row of counts[1].results || []) userMap[row.status] = row.n
    const settings = await getSettings(env)
    const lastSweep = await env.DB.prepare('SELECT MAX(checked_at) AS at FROM source_checks').first()
    return json({
      ok: true,
      sources: sourceMap,
      users: userMap,
      announcements: counts[2].results?.[0]?.n || 0,
      syncUsers: counts[3].results?.[0]?.n || 0,
      openAlerts: counts[4].results?.[0]?.n || 0,
      openFeedback: counts[5].results?.[0]?.n || 0,
      activeSessions: counts[6].results?.[0]?.n || 0,
      activeInvites: counts[7].results?.[0]?.n || 0,
      lastCheckAt: lastSweep?.at || 0,
      settings
    })
  }

  if (area === 'sweep' && method === 'POST') {
    let body = {}
    try {
      body = await readBody(request)
    } catch {
      body = {}
    }
    const limit = Math.min(10, Math.max(1, toInt(body.limit, 6)))
    const result = await runHealthSweep(env, 'manual', limit, toInt(body.since, 0))
    await audit(env, request, 'sweep.run', '', `手动体检 ${result.checked} 个源，失败 ${result.failed} 个，剩余 ${result.remaining} 个`)
    return json({ ok: true, ...result })
  }

  if (area === 'alerts') {
    if (method === 'GET' && !id) {
      const status = clean(new URL(request.url).searchParams.get('status') || 'open', 12)
      const rows =
        status === 'all'
          ? await env.DB.prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 200').all()
          : await env.DB.prepare('SELECT * FROM alerts WHERE status = ?1 ORDER BY created_at DESC LIMIT 200')
              .bind(status)
              .all()
      return json({ ok: true, alerts: rows.results || [] })
    }
    if (method === 'PUT' && id) {
      const row = await env.DB.prepare('SELECT * FROM alerts WHERE id = ?1').bind(id).first()
      if (!row) return fail('告警不存在', 404)
      await env.DB.prepare("UPDATE alerts SET status = 'resolved', resolved_at = ?1 WHERE id = ?2")
        .bind(Date.now(), id)
        .run()
      await audit(env, request, 'alert.resolve', row.title, '手动标记已处理')
      return json({ ok: true })
    }
    if (method === 'POST' && id === 'resolve-all') {
      const result = await env.DB.prepare("UPDATE alerts SET status = 'resolved', resolved_at = ?1 WHERE status = 'open'")
        .bind(Date.now())
        .run()
      await audit(env, request, 'alert.resolve-all', '', `处理 ${result.meta?.changes || 0} 条告警`)
      return json({ ok: true })
    }
  }

  if (area === 'audit' && method === 'GET') {
    const params = new URL(request.url).searchParams
    const q = clean(params.get('q') || '', 40)
    const limit = Math.min(300, Math.max(20, toInt(params.get('limit'), 100)))
    const rows = q
      ? await env.DB.prepare(
          'SELECT * FROM audit_logs WHERE action LIKE ?1 OR target LIKE ?1 OR detail LIKE ?1 ORDER BY created_at DESC LIMIT ?2'
        )
          .bind(`%${q}%`, limit)
          .all()
      : await env.DB.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?1').bind(limit).all()
    return json({ ok: true, logs: rows.results || [] })
  }

  if (area === 'invites') {
    if (method === 'GET' && !id) {
      const rows = await env.DB.prepare('SELECT * FROM invite_codes ORDER BY created_at DESC LIMIT 200').all()
      return json({ ok: true, invites: rows.results || [] })
    }
    if (method === 'POST' && !id) {
      let body
      try {
        body = await readBody(request)
      } catch (error) {
        return fail(error.message)
      }
      const count = Math.min(50, Math.max(1, toInt(body.count, 1)))
      const maxUses = Math.min(999, Math.max(1, toInt(body.maxUses, 1)))
      const expiresAt = toInt(body.expiresAt, 0)
      const note = clean(body.note, 100)
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
      const now = Date.now()
      const codes = []
      for (let index = 0; index < count; index += 1) {
        let code = ''
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const bytes = crypto.getRandomValues(new Uint8Array(8))
          code = `KAY-${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('').slice(0, 4)}-${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('').slice(4, 8)}`
          const exists = await env.DB.prepare('SELECT id FROM invite_codes WHERE code = ?1').bind(code).first()
          if (!exists) break
          code = ''
        }
        if (!code) continue
        const rowId = crypto.randomUUID()
        await env.DB.prepare(
          `INSERT INTO invite_codes (id, code, max_uses, used_count, enabled, note, expires_at, created_at)
           VALUES (?1, ?2, ?3, 0, 1, ?4, ?5, ?6)`
        )
          .bind(rowId, code, maxUses, note, expiresAt, now)
          .run()
        codes.push(code)
      }
      await audit(env, request, 'invite.create', '', `生成 ${codes.length} 个邀请码，每个可用 ${maxUses} 次`)
      return json({ ok: true, codes })
    }
    if ((method === 'PUT' || method === 'PATCH') && id) {
      const row = await env.DB.prepare('SELECT * FROM invite_codes WHERE id = ?1').bind(id).first()
      if (!row) return fail('邀请码不存在', 404)
      let body
      try {
        body = await readBody(request)
      } catch (error) {
        return fail(error.message)
      }
      const enabled = body.enabled === undefined ? row.enabled : body.enabled ? 1 : 0
      await env.DB.prepare('UPDATE invite_codes SET enabled = ?1, note = ?2 WHERE id = ?3')
        .bind(enabled, body.note === undefined ? row.note : clean(body.note, 100), id)
        .run()
      await audit(env, request, 'invite.update', row.code, enabled ? '启用' : '停用')
      return json({ ok: true })
    }
    if (method === 'DELETE' && id) {
      const row = await env.DB.prepare('SELECT * FROM invite_codes WHERE id = ?1').bind(id).first()
      if (!row) return fail('邀请码不存在', 404)
      await env.DB.prepare('DELETE FROM invite_codes WHERE id = ?1').bind(id).run()
      await audit(env, request, 'invite.delete', row.code, `已用 ${row.used_count}/${row.max_uses}`)
      return json({ ok: true })
    }
  }

  if (area === 'feedback') {
    if (method === 'GET' && !id) {
      const params = new URL(request.url).searchParams
      const status = clean(params.get('status') || 'open', 12)
      const rows =
        status === 'all'
          ? await env.DB.prepare('SELECT * FROM feedback ORDER BY created_at DESC LIMIT 200').all()
          : await env.DB.prepare('SELECT * FROM feedback WHERE status = ?1 ORDER BY created_at DESC LIMIT 200')
              .bind(status)
              .all()
      return json({ ok: true, feedback: rows.results || [] })
    }
    if ((method === 'PUT' || method === 'PATCH') && id) {
      const row = await env.DB.prepare('SELECT * FROM feedback WHERE id = ?1').bind(id).first()
      if (!row) return fail('反馈不存在', 404)
      let body
      try {
        body = await readBody(request)
      } catch (error) {
        return fail(error.message)
      }
      const status = ['open', 'done', 'ignored'].includes(body.status) ? body.status : row.status
      await env.DB.prepare('UPDATE feedback SET status = ?1, admin_note = ?2, updated_at = ?3 WHERE id = ?4')
        .bind(status, body.adminNote === undefined ? row.admin_note : clean(body.adminNote, 300), Date.now(), id)
        .run()
      await audit(env, request, 'feedback.update', row.title, `标记为 ${status}`)
      return json({ ok: true })
    }
    if (method === 'DELETE' && id) {
      const row = await env.DB.prepare('SELECT * FROM feedback WHERE id = ?1').bind(id).first()
      if (!row) return fail('反馈不存在', 404)
      await env.DB.prepare('DELETE FROM feedback WHERE id = ?1').bind(id).run()
      await audit(env, request, 'feedback.delete', row.title, row.username || '匿名')
      return json({ ok: true })
    }
  }

  if (area === 'sources') {
    if (method === 'GET' && !id) {
      const weekAgo = Date.now() - 7 * 86400000
      const rows = await env.DB.prepare(
        `SELECT s.*,
                (SELECT COUNT(*) FROM source_checks c WHERE c.source_id = s.id AND c.checked_at > ?1) AS checks_7d,
                (SELECT COUNT(*) FROM source_checks c WHERE c.source_id = s.id AND c.ok = 1 AND c.checked_at > ?1) AS ok_7d,
                (SELECT COUNT(*) FROM alerts a WHERE a.source_id = s.id AND a.status = 'open') AS open_alerts
         FROM sources s ORDER BY s.kind, s.sort ASC, s.created_at DESC`
      )
        .bind(weekAgo)
        .all()
      return json({ ok: true, sources: rows.results || [] })
    }
    if (method === 'POST' && !id) {
      let body
      try {
        body = await readBody(request)
      } catch (error) {
        return fail(error.message)
      }
      const kind = clean(body.kind, 10)
      if (!['vod', 'live', 'tvbox'].includes(kind)) return fail('源类型只能是 vod / live / tvbox')
      const name = clean(body.name, 40)
      const url = clean(body.url, 600)
      if (!name) return fail('请填写源名称')
      if (!isHttpUrl(url)) return fail('请填写 http(s) 开头的地址')
      const type = clean(body.type, 20) || (kind === 'vod' ? 'maccms' : kind === 'live' ? 'auto' : 'config')
      const now = Date.now()
      const rowId = crypto.randomUUID()
      // JS 插件无法直接播放：入库时展开成其中的采集接口，否则这一行永远是死源
      if (isPluginFileUrl(url)) {
        const pluginText = await fetchPluginText(url)
        const extracted = pluginText ? extractMacCmsFromJs(pluginText) : []
        if (extracted.length) {
          const added = []
          for (const api of extracted) {
            const exists = await env.DB.prepare('SELECT id FROM sources WHERE url = ?1').bind(api.url).first()
            if (exists) continue
            await env.DB.prepare(
              `INSERT INTO sources (id, kind, name, url, type, note, enabled, sort, expires_at, created_at, updated_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
            )
              .bind(
                crypto.randomUUID(),
                'vod',
                name,
                api.url,
                'maccms',
                `从 JS 插件展开：${url}`,
                body.enabled === false ? 0 : 1,
                toInt(body.sort, 100),
                0,
                now,
                now
              )
              .run()
            added.push(api.url)
          }
          if (added.length) {
            await audit(env, request, 'source.create', name, `JS 插件展开 ${added.length} 个采集接口`)
            return json({ ok: true, expanded: true, added, message: `未直接保存 JS 插件，已展开为 ${added.length} 个采集接口` })
          }
          await audit(env, request, 'source.create', name, `JS 插件展开的 ${extracted.length} 个采集接口已存在`)
          return json({ ok: true, expanded: true, added: [], message: '该插件里的采集接口都已经在源列表里了' })
        }
      }
      await env.DB.prepare(
        `INSERT INTO sources (id, kind, name, url, type, note, enabled, sort, expires_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
      )
        .bind(
          rowId,
          kind,
          name,
          url,
          type,
          clean(body.note, 200),
          body.enabled === false ? 0 : 1,
          toInt(body.sort, 100),
          toInt(body.expiresAt, 0),
          now,
          now
        )
        .run()
      await audit(env, request, 'source.create', name, `${kind} · ${url}`)
      return json({ ok: true, id: rowId })
    }
    if ((method === 'PUT' || method === 'PATCH') && id) {
      const row = await env.DB.prepare('SELECT * FROM sources WHERE id = ?1').bind(id).first()
      if (!row) return fail('源不存在', 404)
      let body
      try {
        body = await readBody(request)
      } catch (error) {
        return fail(error.message)
      }
      const next = {
        kind: body.kind === undefined ? row.kind : clean(body.kind, 10),
        name: body.name === undefined ? row.name : clean(body.name, 40),
        url: body.url === undefined ? row.url : clean(body.url, 600),
        type: body.type === undefined ? row.type : clean(body.type, 20),
        note: body.note === undefined ? row.note : clean(body.note, 200),
        enabled: body.enabled === undefined ? row.enabled : body.enabled ? 1 : 0,
        sort: body.sort === undefined ? row.sort : toInt(body.sort, 100),
        expiresAt: body.expiresAt === undefined ? row.expires_at : toInt(body.expiresAt, 0)
      }
      if (!['vod', 'live', 'tvbox'].includes(next.kind)) return fail('源类型不合法')
      if (!next.name) return fail('请填写源名称')
      if (!isHttpUrl(next.url)) return fail('请填写 http(s) 开头的地址')
      await env.DB.prepare(
        `UPDATE sources SET kind=?1, name=?2, url=?3, type=?4, note=?5, enabled=?6, sort=?7, expires_at=?8, updated_at=?9 WHERE id=?10`
      )
        .bind(next.kind, next.name, next.url, next.type, next.note, next.enabled, next.sort, next.expiresAt, Date.now(), id)
        .run()
      await audit(
        env,
        request,
        'source.update',
        next.name,
        body.enabled !== undefined && next.enabled !== row.enabled ? (next.enabled ? '启用' : '停用') : `更新配置 ${next.url}`
      )
      if (body.expiresAt !== undefined) await resolveAlerts(env, 'source_expire', id)
      return json({ ok: true })
    }
    if (method === 'DELETE' && id) {
      const row = await env.DB.prepare('SELECT * FROM sources WHERE id = ?1').bind(id).first()
      if (!row) return fail('源不存在', 404)
      await env.DB.batch([
        env.DB.prepare('DELETE FROM source_checks WHERE source_id = ?1').bind(id),
        env.DB.prepare('DELETE FROM alerts WHERE source_id = ?1').bind(id),
        env.DB.prepare('DELETE FROM sources WHERE id = ?1').bind(id)
      ])
      await audit(env, request, 'source.delete', row.name, row.url)
      return json({ ok: true })
    }
    if (method === 'POST' && id && segments[3] === 'probe') {
      const row = await env.DB.prepare('SELECT * FROM sources WHERE id = ?1').bind(id).first()
      if (!row) return fail('源不存在', 404)
      const result = await probeSource(row)
      const settings = await getSettings(env)
      await recordSourceCheck(env, row, result, 'manual', settings.failThreshold)
      await audit(env, request, 'source.probe', row.name, result.ok ? `可用 ${result.ms}ms` : `失败：${result.note}`)
      return json({ ok: true, result })
    }
  }

  if (area === 'announcements') {
    if (method === 'GET' && !id) {
      const rows = await env.DB.prepare('SELECT * FROM announcements ORDER BY updated_at DESC').all()
      return json({ ok: true, announcements: rows.results || [] })
    }
    if (method === 'POST' && !id) {
      let body
      try {
        body = await readBody(request)
      } catch (error) {
        return fail(error.message)
      }
      const title = clean(body.title, 60)
      if (!title) return fail('请填写公告标题')
      const now = Date.now()
      const rowId = crypto.randomUUID()
      await env.DB.prepare(
        `INSERT INTO announcements (id, title, body, level, link, active, starts_at, ends_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
      )
        .bind(
          rowId,
          title,
          clean(body.body, 2000),
          ['info', 'warning', 'critical'].includes(body.level) ? body.level : 'info',
          isHttpUrl(body.link) ? clean(body.link, 600) : '',
          body.active === false ? 0 : 1,
          toInt(body.startsAt, 0),
          toInt(body.endsAt, 0),
          now,
          now
        )
        .run()
      await audit(env, request, 'announcement.create', title, '发布公告')
      return json({ ok: true, id: rowId })
    }
    if ((method === 'PUT' || method === 'PATCH') && id) {
      const row = await env.DB.prepare('SELECT * FROM announcements WHERE id = ?1').bind(id).first()
      if (!row) return fail('公告不存在', 404)
      let body
      try {
        body = await readBody(request)
      } catch (error) {
        return fail(error.message)
      }
      const title = body.title === undefined ? row.title : clean(body.title, 60)
      if (!title) return fail('请填写公告标题')
      await env.DB.prepare(
        `UPDATE announcements SET title=?1, body=?2, level=?3, link=?4, active=?5, starts_at=?6, ends_at=?7, updated_at=?8 WHERE id=?9`
      )
        .bind(
          title,
          body.body === undefined ? row.body : clean(body.body, 2000),
          body.level === undefined ? row.level : ['info', 'warning', 'critical'].includes(body.level) ? body.level : row.level,
          body.link === undefined ? row.link : isHttpUrl(body.link) ? clean(body.link, 600) : '',
          body.active === undefined ? row.active : body.active ? 1 : 0,
          body.startsAt === undefined ? row.starts_at : toInt(body.startsAt, 0),
          body.endsAt === undefined ? row.ends_at : toInt(body.endsAt, 0),
          Date.now(),
          id
        )
        .run()
      await audit(env, request, 'announcement.update', title, body.active === undefined ? '更新公告' : body.active ? '启用公告' : '停用公告')
      return json({ ok: true })
    }
    if (method === 'DELETE' && id) {
      const row = await env.DB.prepare('SELECT * FROM announcements WHERE id = ?1').bind(id).first()
      if (!row) return fail('公告不存在', 404)
      await env.DB.prepare('DELETE FROM announcements WHERE id = ?1').bind(id).run()
      await audit(env, request, 'announcement.delete', row.title, '删除公告')
      return json({ ok: true })
    }
  }

  if (area === 'users') {
    if (method === 'GET' && !id) {
      const q = clean(new URL(request.url).searchParams.get('q') || '', 40)
      const now = Date.now()
      const baseSql =
        `SELECT u.id, u.username, u.status, u.device, u.note, u.created_at, u.last_seen,
                d.updated_at AS sync_at,
                (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?1) AS session_count
         FROM users u LEFT JOIN user_data d ON d.user_id = u.id`
      const rows = q
        ? await env.DB.prepare(`${baseSql} WHERE u.username LIKE ?2 ORDER BY u.created_at DESC LIMIT 500`)
            .bind(now, `%${q}%`)
            .all()
        : await env.DB.prepare(`${baseSql} ORDER BY u.created_at DESC LIMIT 500`).bind(now).all()
      return json({ ok: true, users: rows.results || [] })
    }
    if (method === 'POST' && id && segments[3] === 'revoke-sessions') {
      const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(id).first()
      if (!row) return fail('用户不存在', 404)
      const result = await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(id).run()
      await audit(env, request, 'user.revoke-sessions', row.username, `强制下线 ${result.meta?.changes || 0} 个会话`)
      return json({ ok: true, removed: result.meta?.changes || 0 })
    }
    if ((method === 'PUT' || method === 'PATCH') && id) {
      const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(id).first()
      if (!row) return fail('用户不存在', 404)
      let body
      try {
        body = await readBody(request)
      } catch (error) {
        return fail(error.message)
      }
      const status = ['pending', 'active', 'blocked'].includes(body.status) ? body.status : row.status
      await env.DB.prepare('UPDATE users SET status = ?1, note = ?2 WHERE id = ?3')
        .bind(status, body.note === undefined ? row.note : clean(body.note, 200), id)
        .run()
      if (status !== 'active') {
        await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(id).run()
      }
      await audit(env, request, 'user.status', row.username, `状态 ${row.status} → ${status}`)
      return json({ ok: true })
    }
    if (method === 'DELETE' && id) {
      const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(id).first()
      if (!row) return fail('用户不存在', 404)
      await env.DB.batch([
        env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(id),
        env.DB.prepare('DELETE FROM user_data WHERE user_id = ?1').bind(id),
        env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(id)
      ])
      await audit(env, request, 'user.delete', row.username, '删除用户及其同步数据')
      return json({ ok: true })
    }
  }

  if (area === 'kanju') {
    if (method === 'GET') {
      return json({ ok: true, kanju: kanjuInfo(await getKanju(env)) })
    }
    if (method === 'POST' && !id) {
      let body
      try {
        body = await readBody(request)
      } catch (error) {
        return fail(error.message)
      }
      const target = clean(body.url, 300)
      if (!target) return fail('请填写看剧AI 官网地址')
      let found
      try {
        found = await discoverKanju(target)
      } catch (error) {
        await audit(env, request, 'kanju.discover', target, `失败：${String(error?.message || error).slice(0, 150)}`)
        return fail(String(error?.message || error).slice(0, 200))
      }
      const now = Date.now()
      await saveKanju(env, {
        ...found,
        enabled: 1,
        autoRefresh: body.autoRefresh === false ? 0 : 1,
        lastOkAt: now,
        lastCheckAt: now,
        lastError: '',
        updatedAt: now
      })
      await audit(
        env,
        request,
        'kanju.discover',
        found.baseUrl,
        `自动识别成功 · 密钥 ${found.secret.slice(0, 4)}…${found.secret.slice(-4)} · ${found.buildVersion || '默认构建标识'}`
      )
      return json({ ok: true, kanju: kanjuInfo(await getKanju(env)) })
    }
    if (method === 'POST' && id === 'refresh') {
      const row = await getKanju(env)
      if (!row?.base_url) return fail('还没有配置看剧AI 域名', 404)
      let found
      try {
        found = await discoverKanju(row.base_url)
      } catch (error) {
        await saveKanju(env, { lastCheckAt: Date.now(), lastError: String(error?.message || error).slice(0, 200) })
        await audit(env, request, 'kanju.refresh', row.base_url, `失败：${String(error?.message || error).slice(0, 150)}`)
        return fail(String(error?.message || error).slice(0, 200))
      }
      const now = Date.now()
      await saveKanju(env, {
        ...found,
        enabled: 1,
        lastOkAt: now,
        lastCheckAt: now,
        lastError: '',
        updatedAt: now
      })
      await audit(env, request, 'kanju.refresh', found.baseUrl, '重新识别签名成功')
      return json({ ok: true, kanju: kanjuInfo(await getKanju(env)) })
    }
    if (method === 'PUT') {
      const row = await getKanju(env)
      if (!row?.base_url) return fail('还没有配置看剧AI 域名', 404)
      let body
      try {
        body = await readBody(request)
      } catch (error) {
        return fail(error.message)
      }
      const patch = { updatedAt: Date.now() }
      if (body.enabled !== undefined) patch.enabled = body.enabled ? 1 : 0
      if (body.autoRefresh !== undefined) patch.autoRefresh = body.autoRefresh ? 1 : 0
      await saveKanju(env, patch)
      await audit(
        env,
        request,
        'kanju.update',
        row.base_url,
        [body.enabled !== undefined ? (body.enabled ? '启用' : '停用') : '', body.autoRefresh !== undefined ? `自动刷新 ${body.autoRefresh ? '开' : '关'}` : '']
          .filter(Boolean)
          .join(' ')
      )
      return json({ ok: true, kanju: kanjuInfo(await getKanju(env)) })
    }
  }

  if (area === 'settings') {
    if (method === 'GET') return json({ ok: true, settings: await getSettings(env) })
    if (method === 'PUT') {
      let body
      try {
        body = await readBody(request)
      } catch (error) {
        return fail(error.message)
      }
      const updates = []
      if (body.siteName !== undefined) updates.push(['site_name', clean(body.siteName, 40) || 'KayTV'])
      if (body.registrationMode !== undefined) {
        const mode = ['open', 'invite', 'closed'].includes(body.registrationMode) ? body.registrationMode : 'open'
        updates.push(['registration_mode', mode])
        updates.push(['registration_open', mode === 'closed' ? '0' : '1'])
      }
      if (body.registrationOpen !== undefined && body.registrationMode === undefined) {
        updates.push(['registration_open', body.registrationOpen ? '1' : '0'])
        updates.push(['registration_mode', body.registrationOpen ? 'open' : 'closed'])
      }
      if (body.autoApprove !== undefined) updates.push(['registration_auto_approve', body.autoApprove ? '1' : '0'])
      if (body.minVersion !== undefined) {
        const version = clean(body.minVersion, 20)
        if (version && !/^\d+\.\d+\.\d+$/.test(version)) return fail('最低版本格式应为 0.5.0')
        updates.push(['min_version', version])
      }
      if (body.updateUrl !== undefined) {
        const url = clean(body.updateUrl, 300)
        if (url && !isHttpUrl(url)) return fail('更新地址需要 http(s) 开头')
        updates.push(['update_url', url])
      }
      if (body.failThreshold !== undefined) {
        updates.push(['alert_fail_threshold', String(Math.min(5, Math.max(1, toInt(body.failThreshold, 2))))])
      }
      for (const [key, value] of updates) {
        await env.DB.prepare(
          'INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
        )
          .bind(key, value)
          .run()
      }
      await audit(env, request, 'settings.update', '', updates.map(([key, value]) => `${key}=${value}`).join(' '))
      return json({ ok: true, settings: await getSettings(env) })
    }
  }

  return fail('管理接口不存在', 404)
}

export async function onRequest(context) {
  const { request, env } = context
  const method = request.method.toUpperCase()
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

  const url = new URL(request.url)
  const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '')
  const segments = path.split('/').filter(Boolean)
  if (!segments.length) return fail('接口不存在', 404)

  try {
    if (segments[0] === 'admin') return await handleAdmin(segments, request, env)
    return await handlePublic(segments, request, env)
  } catch (error) {
    console.error('kaytv-hub error', error)
    return fail('服务器开小差了：' + String(error?.message || error).slice(0, 160), 500)
  }
}

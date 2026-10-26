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

async function getSettings(env) {
  const rows = await env.DB.prepare('SELECT key, value FROM settings').all()
  const map = {}
  for (const row of rows.results || []) map[row.key] = row.value
  return {
    siteName: map.site_name || 'KayTV',
    registrationOpen: map.registration_open !== '0',
    autoApprove: map.registration_auto_approve !== '0'
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
  return {
    ok: true,
    siteName: settings.siteName,
    version: now,
    registration: { open: settings.registrationOpen, autoApprove: settings.autoApprove },
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
    }))
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

async function currentUser(request, env) {
  const header = request.headers.get('authorization') || ''
  const token = header.replace(/^Bearer\s+/i, '').trim()
  if (!token) return null
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.status, u.device, u.created_at, u.last_seen, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ?1 AND s.expires_at > ?2`
  )
    .bind(token, Date.now())
    .first()
  if (!row || row.status !== 'active') return null
  return row
}

async function createSession(env, userId) {
  const token = randomToken()
  const now = Date.now()
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(now).run()
  await env.DB.prepare(
    'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)'
  )
    .bind(token, userId, now, now + SESSION_TTL)
    .run()
  return { token, expiresAt: now + SESSION_TTL }
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
    const text = await response.text()
    const trimmed = text.trim()
    let pathname = ''
    try {
      pathname = new URL(row.url).pathname
    } catch {
      /* 已在入库时校验过 http(s) */
    }
    if (/\.(?:js|js\.md5|md5)$/i.test(pathname) || /^[a-f0-9]{32}$/i.test(trimmed)) {
      return { ok: false, ms, note: '这是 XPTV/TVBox 的 JS 插件文件，需要专用内核，无法直接展开' }
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

  if (segments[0] === 'register' && method === 'POST') {
    const settings = await getSettings(env)
    if (!settings.registrationOpen) return fail('后台暂未开放注册', 403)
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
    const exists = await env.DB.prepare('SELECT id FROM users WHERE username = ?1').bind(username).first()
    if (exists) return fail('这个用户名已经注册了', 409)
    const id = crypto.randomUUID()
    const salt = randomToken(16)
    const passHash = await hashPassword(password, salt)
    const now = Date.now()
    const status = settings.autoApprove ? 'active' : 'pending'
    await env.DB.prepare(
      `INSERT INTO users (id, username, pass_hash, salt, status, device, note, created_at, last_seen)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', ?7, ?8)`
    )
      .bind(id, username, passHash, salt, status, device, now, now)
      .run()
    if (status === 'pending') {
      return json({ ok: true, pending: true, message: '注册成功，等管理员审核通过后就能登录同步' })
    }
    const session = await createSession(env, id)
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
    await env.DB.prepare('UPDATE users SET last_seen = ?1 WHERE id = ?2').bind(now, row.id).run()
    const session = await createSession(env, row.id)
    return json({
      ok: true,
      token: session.token,
      expiresAt: session.expiresAt,
      user: { id: row.id, username: row.username, status: row.status, device: row.device, createdAt: row.created_at, lastSeen: now }
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
      env.DB.prepare('SELECT COUNT(*) AS n FROM user_data')
    ])
    const sourceMap = { vod: 0, live: 0, tvbox: 0 }
    for (const row of counts[0].results || []) sourceMap[row.kind] = row.n
    const userMap = { pending: 0, active: 0, blocked: 0 }
    for (const row of counts[1].results || []) userMap[row.status] = row.n
    const settings = await getSettings(env)
    return json({
      ok: true,
      sources: sourceMap,
      users: userMap,
      announcements: counts[2].results?.[0]?.n || 0,
      syncUsers: counts[3].results?.[0]?.n || 0,
      settings
    })
  }

  if (area === 'sources') {
    if (method === 'GET' && !id) {
      const rows = await env.DB.prepare('SELECT * FROM sources ORDER BY kind, sort ASC, created_at DESC').all()
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
      await env.DB.prepare(
        `INSERT INTO sources (id, kind, name, url, type, note, enabled, sort, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
      )
        .bind(rowId, kind, name, url, type, clean(body.note, 200), body.enabled === false ? 0 : 1, toInt(body.sort, 100), now, now)
        .run()
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
        sort: body.sort === undefined ? row.sort : toInt(body.sort, 100)
      }
      if (!['vod', 'live', 'tvbox'].includes(next.kind)) return fail('源类型不合法')
      if (!next.name) return fail('请填写源名称')
      if (!isHttpUrl(next.url)) return fail('请填写 http(s) 开头的地址')
      await env.DB.prepare(
        `UPDATE sources SET kind=?1, name=?2, url=?3, type=?4, note=?5, enabled=?6, sort=?7, updated_at=?8 WHERE id=?9`
      )
        .bind(next.kind, next.name, next.url, next.type, next.note, next.enabled, next.sort, Date.now(), id)
        .run()
      return json({ ok: true })
    }
    if (method === 'DELETE' && id) {
      await env.DB.prepare('DELETE FROM sources WHERE id = ?1').bind(id).run()
      return json({ ok: true })
    }
    if (method === 'POST' && id && segments[3] === 'probe') {
      const row = await env.DB.prepare('SELECT * FROM sources WHERE id = ?1').bind(id).first()
      if (!row) return fail('源不存在', 404)
      const result = await probeSource(row)
      await env.DB.prepare(
        'UPDATE sources SET probe_ok=?1, probe_ms=?2, probe_note=?3, probed_at=?4 WHERE id=?5'
      )
        .bind(result.ok ? 1 : 0, result.ms, result.note, Date.now(), id)
        .run()
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
      return json({ ok: true })
    }
    if (method === 'DELETE' && id) {
      await env.DB.prepare('DELETE FROM announcements WHERE id = ?1').bind(id).run()
      return json({ ok: true })
    }
  }

  if (area === 'users') {
    if (method === 'GET' && !id) {
      const q = clean(new URL(request.url).searchParams.get('q') || '', 40)
      const rows = q
        ? await env.DB.prepare(
            `SELECT u.id, u.username, u.status, u.device, u.note, u.created_at, u.last_seen,
                    d.updated_at AS sync_at
             FROM users u LEFT JOIN user_data d ON d.user_id = u.id
             WHERE u.username LIKE ?1 ORDER BY u.created_at DESC LIMIT 500`
          )
            .bind(`%${q}%`)
            .all()
        : await env.DB.prepare(
            `SELECT u.id, u.username, u.status, u.device, u.note, u.created_at, u.last_seen,
                    d.updated_at AS sync_at
             FROM users u LEFT JOIN user_data d ON d.user_id = u.id
             ORDER BY u.created_at DESC LIMIT 500`
          ).all()
      return json({ ok: true, users: rows.results || [] })
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
      return json({ ok: true })
    }
    if (method === 'DELETE' && id) {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(id),
        env.DB.prepare('DELETE FROM user_data WHERE user_id = ?1').bind(id),
        env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(id)
      ])
      return json({ ok: true })
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
      if (body.registrationOpen !== undefined) updates.push(['registration_open', body.registrationOpen ? '1' : '0'])
      if (body.autoApprove !== undefined) updates.push(['registration_auto_approve', body.autoApprove ? '1' : '0'])
      for (const [key, value] of updates) {
        await env.DB.prepare(
          'INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
        )
          .bind(key, value)
          .run()
      }
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

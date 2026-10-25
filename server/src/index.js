import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getConfig, saveConfig } from './config.js'
import { fetchLiveChannels, getLive } from './live.js'
import {
  getCategories,
  getVodDetail,
  getVodList,
  resolveVodPlayback,
  searchVod,
  testVodSource
} from './vod.js'
import { registerProxy } from './proxy.js'
import { registerEpg } from './epg.js'
import {
  changePassword,
  createSession,
  createUser,
  deleteUser,
  destroySession,
  ensureAdmin,
  isAuthed,
  listUsers,
  readCookie,
  requiresAdmin,
  sessionInfo,
  updateUser,
  verifyCredentials
} from './auth.js'
import { checkAllSources, getHealthStatus, recordSourceCheck, startDailyCheck } from './health.js'
import { previewSubscription, syncSubscriptions } from './subscriptions.js'
import { getTaxonomy, getVodFeed } from './categories.js'
import { isHttpUrl } from './util.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT) || 8080
const HOST = process.env.HOST || '0.0.0.0'
const webDist = path.resolve(__dirname, '../../web/dist')
const hasWeb = fs.existsSync(path.join(webDist, 'index.html'))

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  bodyLimit: 256 * 1024,
  trustProxy: true
})

app.addHook('onRequest', async (req, reply) => {
  const origin = req.headers.origin
  if (origin) {
    reply.header('access-control-allow-origin', origin)
    reply.header('vary', 'Origin')
  }
  reply.header('access-control-expose-headers', 'content-range, content-length')
  reply.header('x-content-type-options', 'nosniff')
})

app.options('/*', async (req, reply) => {
  const requested = req.headers['access-control-request-headers']
  reply.header('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS')
  reply.header('access-control-allow-headers', requested || 'content-type, authorization, range')
  reply.header('access-control-max-age', '86400')
  reply.code(204).send()
})

app.addHook('preHandler', async (req, reply) => {
  if (req.method === 'OPTIONS') return
  const config = getConfig()
  if (config.access?.mode !== 'login') return
  const url = String(req.raw.url || '').split('?')[0]
  if (!url.startsWith('/api/')) return
  if (
    url.startsWith('/api/admin/') ||
    url.startsWith('/api/auth/') ||
    url === '/api/health' ||
    url === '/api/epg' ||
    url.startsWith('/api/p')
  ) {
    return
  }
  if (!isAuthed(req)) {
    reply.code(401).send({ error: 'unauthorized', message: '请先登录后再观看' })
  }
})

const loginAttempts = new Map()
function allowLogin(ip) {
  const now = Date.now()
  const record = loginAttempts.get(ip)
  if (!record || record.resetAt < now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 5 * 60 * 1000 })
    return true
  }
  if (record.count >= 10) return false
  record.count += 1
  return true
}

function recentFailedSources() {
  const status = getHealthStatus(getConfig())
  const cutoff = Date.now() - 24 * 3600 * 1000
  return new Set(
    status.items
      .filter((item) => !item.ok && !item.skipped && item.checkedAt > cutoff)
      .map((item) => item.id)
  )
}

app.get('/api/health', async () => {
  const config = getConfig()
  return {
    ok: true,
    siteName: config.siteName,
    time: Date.now(),
    liveSources: config.liveSources.filter((item) => item.enabled).length,
    vodSources: config.vodSources.filter((item) => item.enabled).length
  }
})

app.get('/api/config', async () => {
  const config = getConfig()
  return {
    siteName: config.siteName,
    access: config.access,
    accessMode: config.access?.mode === 'login' ? 'login' : 'public',
    liveSources: config.liveSources
      .filter((item) => item.enabled)
      .map(({ id, name, type, note }) => ({ id, name, type, note: note || '', enabled: true })),
    vodSources: config.vodSources
      .filter((item) => item.enabled)
      .map(({ id, name, note }) => ({ id, name, note: note || '', enabled: true })),
    server: true,
    version: config.version
  }
})

app.get('/api/live', async (req) => {
  const sourceId = String(req.query?.source || '')
  if (!sourceId) throw Object.assign(new Error('缺少直播源参数'), { statusCode: 400 })
  const fresh = req.query?.fresh === '1'
  return getLive(getConfig(), sourceId, { fresh })
})

app.get('/api/vod/categories', async (req) => {
  const sourceId = String(req.query?.source || '')
  if (!sourceId) throw Object.assign(new Error('缺少影视源参数'), { statusCode: 400 })
  return { sourceId, categories: await getCategories(getConfig(), sourceId) }
})

app.get('/api/vod/list', async (req) => {
  const sourceId = String(req.query?.source || '')
  if (!sourceId) throw Object.assign(new Error('缺少影视源参数'), { statusCode: 400 })
  const result = await getVodList(getConfig(), sourceId, {
    page: req.query?.page,
    type: req.query?.type
  })
  return { sourceId, ...result }
})

app.get('/api/vod/feed', async (req) => {
  return getVodFeed(getConfig(), {
    content: String(req.query?.content || ''),
    region: String(req.query?.region || 'all'),
    sourceId: String(req.query?.source || ''),
    page: req.query?.page,
    excludeIds: recentFailedSources()
  })
})

app.get('/api/vod/taxonomy', async () => getTaxonomy(getConfig()))

app.get('/api/vod/search', async (req) => {
  const keyword = String(req.query?.q || '')
  const sources = String(req.query?.sources || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  return searchVod(getConfig(), keyword, sources, recentFailedSources())
})

app.get('/api/vod/detail', async (req) => {
  const sourceId = String(req.query?.source || '')
  const vodId = String(req.query?.id || '')
  if (!sourceId || !vodId) throw Object.assign(new Error('缺少影视源或影片参数'), { statusCode: 400 })
  return getVodDetail(getConfig(), sourceId, vodId)
})

app.get('/api/vod/resolve', async (req) => {
  const sourceId = String(req.query?.source || '')
  const token = String(req.query?.token || '')
  if (!sourceId || !token) throw Object.assign(new Error('缺少影视源或播放参数'), { statusCode: 400 })
  return resolveVodPlayback(getConfig(), sourceId, token, Number(req.query?.attempt) || 0)
})

registerProxy(app)
registerEpg(app)

async function handleLogin(req, reply) {
  const ip = req.ip || 'unknown'
  if (!allowLogin(ip)) {
    return reply.code(429).send({ error: 'too_many_attempts', message: '尝试次数过多，请 5 分钟后再试' })
  }
  const identity = verifyCredentials(req.body?.username || 'admin', String(req.body?.password || ''))
  if (!identity) {
    return reply.code(401).send({ error: 'bad_password', message: '账号或密码错误' })
  }
  loginAttempts.delete(ip)
  const { token, maxAge } = createSession(identity)
  const secure = req.protocol === 'https' ? '; Secure' : ''
  reply.header(
    'set-cookie',
    `kaytv_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
  )
  return {
    ok: true,
    username: identity.username,
    displayName: identity.displayName,
    role: identity.role
  }
}

app.post('/api/admin/login', handleLogin)
app.post('/api/auth/login', handleLogin)

function handleLogout(req, reply) {
  destroySession(readCookie(req, 'kaytv_session'))
  reply.header('set-cookie', 'kaytv_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0')
  return { ok: true }
}

app.post('/api/admin/logout', handleLogout)
app.post('/api/auth/logout', handleLogout)

app.get('/api/auth/me', async (req) => {
  const session = sessionInfo(req)
  return {
    authed: Boolean(session),
    role: session?.role || '',
    username: session?.username || '',
    displayName: session?.displayName || '',
    accessMode: getConfig().access?.mode || 'public'
  }
})

app.get('/api/admin/session', async (req) => {
  const session = sessionInfo(req)
  return {
    authed: Boolean(session),
    role: session?.role || '',
    username: session?.username || '',
    displayName: session?.displayName || '',
    envPassword: Boolean(process.env.ADMIN_PASSWORD)
  }
})

app.get('/api/admin/config', async (req, reply) => {
  if (!requiresAdmin(req, reply)) return
  return getConfig()
})

app.put('/api/admin/config', async (req, reply) => {
  if (!requiresAdmin(req, reply)) return
  const config = saveConfig(req.body)
  req.log.info({ live: config.liveSources.length, vod: config.vodSources.length }, '配置已更新')
  return { ok: true, config }
})

app.get('/api/admin/users', async (req, reply) => {
  if (!requiresAdmin(req, reply)) return
  return { users: listUsers() }
})

app.post('/api/admin/users', async (req, reply) => {
  if (!requiresAdmin(req, reply)) return
  return { ok: true, user: createUser(req.body) }
})

app.put('/api/admin/users/:id', async (req, reply) => {
  if (!requiresAdmin(req, reply)) return
  return { ok: true, user: updateUser(req.params.id, req.body) }
})

app.delete('/api/admin/users/:id', async (req, reply) => {
  if (!requiresAdmin(req, reply)) return
  return deleteUser(req.params.id)
})

app.get('/api/admin/health', async (req, reply) => {
  if (!requiresAdmin(req, reply)) return
  return getHealthStatus(getConfig())
})

app.post('/api/admin/health/check', async (req, reply) => {
  if (!requiresAdmin(req, reply)) return
  await checkAllSources(getConfig())
  return getHealthStatus(getConfig())
})

app.post('/api/admin/subscriptions/preview', async (req, reply) => {
  if (!requiresAdmin(req, reply)) return
  const url = String(req.body?.url || '').trim()
  if (!isHttpUrl(url)) throw Object.assign(new Error('订阅地址无效'), { statusCode: 400 })
  return previewSubscription(url, '预览')
})

app.post('/api/admin/subscriptions/sync', async (req, reply) => {
  if (!requiresAdmin(req, reply)) return
  const onlyId = String(req.body?.id || '')
  const result = await syncSubscriptions(getConfig(), saveConfig, { onlyId })
  return { ok: true, ...result, config: getConfig() }
})

app.post('/api/admin/test/live', async (req, reply) => {
  if (!requiresAdmin(req, reply)) return
  const url = String(req.body?.url || '')
  if (!isHttpUrl(url)) throw Object.assign(new Error('直播源地址无效'), { statusCode: 400 })
  const started = Date.now()
  const { channels, groups } = await fetchLiveChannels({
    id: 'test',
    name: '测试',
    url,
    type: req.body?.type || 'auto',
    headers: req.body?.headers || {}
  })
  return {
    ok: true,
    took: Date.now() - started,
    count: channels.length,
    groups: groups.slice(0, 12),
    sample: channels.slice(0, 8).map((item) => item.name)
  }
})

app.post('/api/admin/test/vod', async (req, reply) => {
  if (!requiresAdmin(req, reply)) return
  const api = String(req.body?.api || '').trim().replace(/\/+$/, '')
  if (!isHttpUrl(api)) throw Object.assign(new Error('影视接口地址无效'), { statusCode: 400 })
  const result = await testVodSource({
    id: 'test',
    name: '测试源',
    api,
    type: req.body?.type === 'kanju' ? 'kanju' : 'maccms',
    headers: req.body?.headers || {}
  })
  return result
})

app.post('/api/admin/password', async (req, reply) => {
  if (!requiresAdmin(req, reply)) return
  changePassword(String(req.body?.password || ''))
  reply.header('set-cookie', 'kaytv_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0')
  return { ok: true }
})

if (hasWeb) {
  await app.register(fastifyStatic, {
    root: webDist,
    prefix: '/',
    index: ['index.html'],
    setHeaders(res, filePath) {
      if (/[\\/]assets[\\/]/.test(filePath)) {
        res.setHeader('cache-control', 'public, max-age=31536000, immutable')
      } else if (/index\.html$/.test(filePath)) {
        res.setHeader('cache-control', 'no-cache')
      }
    }
  })
}

app.setNotFoundHandler((req, reply) => {
  const url = req.raw.url || ''
  if (url.startsWith('/api/')) {
    return reply.code(404).send({ error: 'not_found', message: '接口不存在' })
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return reply.code(404).send({ error: 'not_found' })
  }
  if (hasWeb) {
    reply.header('cache-control', 'no-cache')
    return reply.type('text/html; charset=utf-8').send(fs.readFileSync(path.join(webDist, 'index.html')))
  }
  return reply
    .code(200)
    .type('text/plain; charset=utf-8')
    .send('KayTV API 已启动。请先运行 npm run build 生成前端，或开发时访问 http://localhost:5173')
})

app.setErrorHandler((error, req, reply) => {
  const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500
  if (status >= 500) req.log.error(error)
  reply.code(status).send({
    error: status === 500 ? 'server_error' : 'request_failed',
    message: error.message || '服务器错误'
  })
})

ensureAdmin()
const config = getConfig()
console.log(`[KayTV] 直播源 ${config.liveSources.length} 个，影视源 ${config.vodSources.length} 个，订阅 ${config.subscriptions.length} 个`)
if (config.access?.mode === 'login') console.log('[KayTV] 访问模式：仅登录用户可观看')
if (process.env.OUTBOUND_PROXY) console.log(`[KayTV] 出站代理: ${process.env.OUTBOUND_PROXY}`)

try {
  await app.listen({ port: PORT, host: HOST })
  console.log(`[KayTV] 服务已启动: http://localhost:${PORT}`)
  console.log(`[KayTV] 管理后台: http://localhost:${PORT}/admin`)
} catch (error) {
  app.log.error(error)
  process.exit(1)
}

startDailyCheck(getConfig, {
  onBeforeCheck: async () => {
    await syncSubscriptions(getConfig(), saveConfig)
  }
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await app.close()
    process.exit(0)
  })
}

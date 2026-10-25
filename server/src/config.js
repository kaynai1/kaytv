import fs from 'node:fs'
import { BUILTIN_LIVE, BUILTIN_VOD, defaultConfig } from '@kaytv/shared'
import { dataFile } from './paths.js'
import { clearCache } from './cache.js'
import { isHttpUrl } from './util.js'

const configPath = dataFile('config.json')
let current = null

const CONFIG_VERSION = 5
const ID_RE = /^[a-zA-Z0-9_-]{2,64}$/
const MAX_SOURCES = 120
const MAX_SUBSCRIPTIONS = 20

function normalizeHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return {}
  const out = {}
  let count = 0
  for (const [key, value] of Object.entries(headers)) {
    if (count++ >= 12) break
    if (!/^[a-zA-Z0-9-]{1,40}$/.test(key)) continue
    if (typeof value !== 'string') continue
    out[key.toLowerCase()] = value.slice(0, 500)
  }
  return out
}

function normalizeSource(source, kind) {
  const id = String(source?.id || '').trim()
  const name = String(source?.name || '').trim().slice(0, 40)
  const enabled = source?.enabled !== false
  const note = String(source?.note || '').trim().slice(0, 120)
  if (!ID_RE.test(id)) throw Object.assign(new Error('源 ID 不合法（2-64 位字母数字）'), { statusCode: 400 })
  if (!name) throw Object.assign(new Error('源名称不能为空'), { statusCode: 400 })
  if (kind === 'live') {
    const url = String(source?.url || '').trim()
    if (!isHttpUrl(url)) throw Object.assign(new Error(`直播源「${name}」的地址不是有效 http(s) 链接`), { statusCode: 400 })
    const type = ['auto', 'm3u', 'txt'].includes(source?.type) ? source.type : 'auto'
    const managedBy = String(source?.managedBy || '').trim()
    return {
      id,
      name,
      url,
      type,
      enabled,
      note,
      headers: normalizeHeaders(source?.headers),
      ...(managedBy ? { managedBy } : {})
    }
  }
  const api = String(source?.api || '').trim().replace(/\/+$/, '')
  if (!isHttpUrl(api)) throw Object.assign(new Error(`影视源「${name}」的接口不是有效 http(s) 链接`), { statusCode: 400 })
  const managedBy = String(source?.managedBy || '').trim()
  const type = source?.type === 'kanju' ? 'kanju' : 'maccms'
  return {
    id,
    name,
    api,
    type,
    enabled,
    note,
    searchable: source?.searchable !== false,
    headers: normalizeHeaders(source?.headers),
    ...(managedBy ? { managedBy } : {})
  }
}

function normalizeSubscription(item) {
  const id = String(item?.id || '').trim()
  const name = String(item?.name || '').trim().slice(0, 40)
  const url = String(item?.url || '').trim()
  if (!ID_RE.test(id)) throw Object.assign(new Error('订阅 ID 不合法'), { statusCode: 400 })
  if (!name) throw Object.assign(new Error('订阅名称不能为空'), { statusCode: 400 })
  if (!isHttpUrl(url)) throw Object.assign(new Error(`订阅「${name}」的地址无效`), { statusCode: 400 })
  return {
    id,
    name,
    url,
    enabled: item?.enabled !== false,
    note: String(item?.note || '').trim().slice(0, 120),
    lastSyncAt: Number(item?.lastSyncAt) || 0,
    lastError: String(item?.lastError || '').slice(0, 300),
    vodCount: Number(item?.vodCount) || 0,
    liveCount: Number(item?.liveCount) || 0
  }
}

export function validateConfig(input) {
  const base = defaultConfig()
  const siteName = String(input?.siteName || base.siteName).trim().slice(0, 24) || 'KayTV'
  const liveInput = Array.isArray(input?.liveSources) ? input.liveSources : base.liveSources
  const vodInput = Array.isArray(input?.vodSources) ? input.vodSources : base.vodSources
  const subInput = Array.isArray(input?.subscriptions) ? input.subscriptions : base.subscriptions
  if (liveInput.length > MAX_SOURCES || vodInput.length > MAX_SOURCES) {
    throw Object.assign(new Error(`单类源数量不能超过 ${MAX_SOURCES} 个`), { statusCode: 400 })
  }
  if (subInput.length > MAX_SUBSCRIPTIONS) {
    throw Object.assign(new Error(`订阅不能超过 ${MAX_SUBSCRIPTIONS} 个`), { statusCode: 400 })
  }
  const liveSources = liveInput.map((item) => normalizeSource(item, 'live'))
  const vodSources = vodInput.map((item) => normalizeSource(item, 'vod'))
  const subscriptions = subInput.map(normalizeSubscription)
  const ids = [...liveSources, ...vodSources].map((item) => item.id)
  if (new Set(ids).size !== ids.length) {
    throw Object.assign(new Error('源 ID 不能重复'), { statusCode: 400 })
  }
  const subIds = subscriptions.map((item) => item.id)
  if (new Set(subIds).size !== subIds.length) {
    throw Object.assign(new Error('订阅 ID 不能重复'), { statusCode: 400 })
  }
  return {
    version: CONFIG_VERSION,
    siteName,
    access: { mode: input?.access?.mode === 'login' ? 'login' : 'public' },
    autoCheck: input?.autoCheck !== false,
    liveSources,
    vodSources,
    subscriptions
  }
}

function mergeById(existing, builtins) {
  const map = new Map(existing.map((item) => [item.id, item]))
  for (const item of builtins) {
    if (!map.has(item.id)) map.set(item.id, { ...item, headers: {} })
  }
  return [...map.values()]
}

function upgradeConfig(raw) {
  if (!raw || typeof raw !== 'object') return defaultConfig()
  if (Number(raw.version) >= CONFIG_VERSION) return validateConfig(raw)
  const base = defaultConfig()
  return validateConfig({
    ...raw,
    version: CONFIG_VERSION,
    access: raw.access || base.access,
    autoCheck: raw.autoCheck !== false,
    liveSources: mergeById(Array.isArray(raw.liveSources) ? raw.liveSources : [], BUILTIN_LIVE),
    vodSources: mergeById(Array.isArray(raw.vodSources) ? raw.vodSources : [], BUILTIN_VOD),
    subscriptions: Array.isArray(raw.subscriptions) ? raw.subscriptions : base.subscriptions
  })
}

export function getConfig() {
  if (current) return current
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    current = upgradeConfig(raw)
    if (Number(raw.version) < CONFIG_VERSION) {
      fs.writeFileSync(configPath, JSON.stringify(current, null, 2))
      console.log(`[config] 已升级到 v${CONFIG_VERSION}，并补充内置源：直播 ${current.liveSources.length}，影视 ${current.vodSources.length}`)
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[config] 配置读取失败，使用默认源:', error.message)
    current = defaultConfig()
    fs.writeFileSync(configPath, JSON.stringify(current, null, 2))
  }
  return current
}

export function saveConfig(input) {
  const next = validateConfig(input)
  const tmp = `${configPath}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
  fs.renameSync(tmp, configPath)
  current = next
  clearCache()
  return next
}

export function reloadConfig() {
  current = null
  return getConfig()
}

export function findSource(config, sourceId) {
  return (
    config.liveSources.find((item) => item.id === sourceId) ||
    config.vodSources.find((item) => item.id === sourceId) ||
    null
  )
}

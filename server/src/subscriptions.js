import crypto from 'node:crypto'
import { fetchUpstream, isHttpUrl, mapLimit } from './util.js'

const MAX_VOD_PER_SUB = 40
const MAX_LIVE_PER_SUB = 8
const MAX_CHILD_CONFIGS = 16

function stableId(prefix, value) {
  return `${prefix}-${crypto.createHash('sha1').update(value).digest('hex').slice(0, 10)}`
}

function cleanName(value, fallback = '未命名') {
  const name = String(value || '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[┃|].*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return (name || fallback).slice(0, 24)
}

function normalizeVodApi(value) {
  let api = String(value || '').trim()
  if (!isHttpUrl(api)) return ''
  api = api.replace(/\/at\/xml\/?$/i, '').replace(/\/+$/, '')
  if (!/provide\/vod/i.test(api)) {
    if (/\/(?:api|provide)[^/]*$/i.test(api) || /\.php/i.test(api)) return api
    api = `${api}/api.php/provide/vod`
  }
  return isHttpUrl(api) ? api : ''
}

function liveCandidate(name, url, note = '') {
  const value = String(url || '').trim()
  if (!isHttpUrl(value)) return null
  if (/^(proxy|htmlplay|kdsvod|push|js):/i.test(value)) return null
  if (!/\.(?:m3u8?|txt)(?:[?#]|$)/i.test(value) && !/\/(?:tv|live)\/?$/i.test(value)) return null
  return { name: cleanName(name, '直播源'), url: value, type: 'auto', note }
}

function collectFromTvBox(payload, pool, note) {
  if (Array.isArray(payload?.sites)) {
    for (const site of payload.sites) {
      if (Number(site?.type) !== 1) continue
      const api = normalizeVodApi(site.api)
      if (!api) continue
      pool.vod.set(api, { name: cleanName(site.name || site.key), api, note })
    }
  }
  for (const live of Array.isArray(payload?.lives) ? payload.lives : []) {
    for (const channel of Array.isArray(live?.channels) ? live.channels : []) {
      for (const url of Array.isArray(channel?.urls) ? channel.urls : []) {
        const found = liveCandidate(channel.name || live.name, url, note)
        if (found) pool.live.set(found.url, found)
      }
    }
  }
}

function collectFromList(payload, pool, note) {
  for (const item of payload) {
    if (!item || typeof item !== 'object') continue
    const api = normalizeVodApi(item.api || item.url)
    if (api) {
      pool.vod.set(api, { name: cleanName(item.name || item.key), api, note })
      continue
    }
    if (isHttpUrl(item.url) && /\.json(?:[?#]|$)|[\s\S]/i.test(item.url)) {
      if (/\.(?:m3u8?|txt)(?:[?#]|$)/i.test(item.url) || /\/(?:tv|live)\/?$/i.test(item.url)) {
        const found = liveCandidate(item.name, item.url, note)
        if (found) pool.live.set(found.url, found)
      }
    }
  }
}

function githubMirror(url) {
  if (process.env.OUTBOUND_PROXY) return url
  if (/^https:\/\/raw\.githubusercontent\.com\//i.test(url)) return `https://gh-proxy.com/${url}`
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/raw\//i.test(url)) return `https://gh-proxy.com/${url}`
  return url
}

async function fetchJson(url) {
  const response = await fetchUpstream(githubMirror(url), {
    timeout: 25000,
    headers: { accept: 'application/json, text/plain, */*' }
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const text = await response.text()
  if (text.length > 3 * 1024 * 1024) throw new Error('配置文件过大')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('返回内容不是 JSON')
  }
}

async function collectSource(url, pool, note, seen, depth = 0) {
  if (depth > 2 || seen.has(url)) return
  seen.add(url)
  const payload = await fetchJson(url)
  if (Array.isArray(payload)) {
    collectFromList(payload, pool, note)
    return
  }
  if (Array.isArray(payload?.resources)) {
    const configs = payload.resources
      .filter((item) => item?.category === 'tvbox_config' && isHttpUrl(item.url))
      .slice(0, MAX_CHILD_CONFIGS)
    await mapLimit(configs, 4, async (item) => {
      try {
        await collectSource(item.url, pool, note, seen, depth + 1)
      } catch {
        /* single config failures are expected */
      }
    })
    return
  }
  if (Array.isArray(payload?.urls) && depth < 2) {
    const configs = payload.urls
      .map((item) => (typeof item === 'string' ? item : item?.url))
      .filter((item) => isHttpUrl(item))
      .slice(0, MAX_CHILD_CONFIGS)
    await mapLimit(configs, 4, async (item) => {
      try {
        await collectSource(item, pool, note, seen, depth + 1)
      } catch {
        /* ignore broken child configs */
      }
    })
    return
  }
  if (Array.isArray(payload?.sites) || Array.isArray(payload?.lives)) {
    collectFromTvBox(payload, pool, note)
  }
}

export async function previewSubscription(url, name = '订阅') {
  const pool = { vod: new Map(), live: new Map() }
  await collectSource(url, pool, name, new Set())
  return {
    vod: [...pool.vod.values()].slice(0, MAX_VOD_PER_SUB),
    live: [...pool.live.values()].slice(0, MAX_LIVE_PER_SUB)
  }
}

function sourceKey(item) {
  return item.kind === 'live' ? item.url : item.api
}

function syncPool(config, subscription, pool) {
  const prefix = `sub-${subscription.id}`
  const managed = `${subscription.id}`
  const existing = {
    live: config.liveSources.filter((item) => item.managedBy === managed),
    vod: config.vodSources.filter((item) => item.managedBy === managed)
  }
  const otherLive = new Set(config.liveSources.filter((item) => item.managedBy !== managed).map((item) => item.url))
  const otherVod = new Set(config.vodSources.filter((item) => item.managedBy !== managed).map((item) => item.api))

  const nextLive = []
  for (const item of pool.live.slice(0, MAX_LIVE_PER_SUB)) {
    if (otherLive.has(item.url)) continue
    const id = stableId(`${prefix}-live`, item.url)
    const previous = existing.live.find((source) => source.id === id)
    nextLive.push({
      id,
      name: item.name,
      url: item.url,
      type: 'auto',
      enabled: previous?.enabled !== false,
      note: item.note || subscription.name,
      headers: previous?.headers || {},
      managedBy: managed
    })
    otherLive.add(item.url)
  }
  const nextVod = []
  for (const item of pool.vod.slice(0, MAX_VOD_PER_SUB)) {
    if (otherVod.has(item.api)) continue
    const id = stableId(`${prefix}-vod`, item.api)
    const previous = existing.vod.find((source) => source.id === id)
    nextVod.push({
      id,
      name: item.name,
      api: item.api,
      enabled: previous?.enabled !== false,
      note: item.note || subscription.name,
      headers: previous?.headers || {},
      managedBy: managed
    })
    otherVod.add(item.api)
  }

  const freeLive = config.liveSources.filter((item) => item.managedBy !== managed)
  const freeVod = config.vodSources.filter((item) => item.managedBy !== managed)
  return {
    liveSources: [...freeLive, ...nextLive].slice(0, 120),
    vodSources: [...freeVod, ...nextVod].slice(0, 120),
    counts: { live: nextLive.length, vod: nextVod.length }
  }
}

export async function syncSubscriptions(config, saveConfig, { onlyId = '' } = {}) {
  const targets = config.subscriptions.filter(
    (item) => item.enabled && (!onlyId || item.id === onlyId)
  )
  if (!targets.length) return { synced: 0, results: [] }

  const results = []
  let liveSources = config.liveSources
  let vodSources = config.vodSources
  const subscriptions = config.subscriptions.map((item) => ({ ...item }))

  for (const subscription of targets) {
    const index = subscriptions.findIndex((item) => item.id === subscription.id)
    try {
      const pool = await previewSubscription(subscription.url, subscription.name)
      const synced = syncPool({ liveSources, vodSources }, subscription, pool)
      liveSources = synced.liveSources
      vodSources = synced.vodSources
      subscriptions[index] = {
        ...subscription,
        lastSyncAt: Date.now(),
        lastError: '',
        liveCount: synced.counts.live,
        vodCount: synced.counts.vod
      }
      results.push({ id: subscription.id, name: subscription.name, ok: true, ...synced.counts })
      console.log(`[subscriptions] ${subscription.name}: 直播 ${synced.counts.live}，影视 ${synced.counts.vod}`)
    } catch (error) {
      subscriptions[index] = {
        ...subscription,
        lastError: String(error?.message || '同步失败').slice(0, 300),
        lastSyncAt: Date.now()
      }
      results.push({ id: subscription.id, name: subscription.name, ok: false, error: error?.message })
      console.warn(`[subscriptions] ${subscription.name} 同步失败:`, error?.message)
    }
  }

  saveConfig({ ...config, liveSources, vodSources, subscriptions })
  return { synced: results.filter((item) => item.ok).length, results }
}

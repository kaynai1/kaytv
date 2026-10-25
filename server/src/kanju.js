import crypto from 'node:crypto'
import { cached } from './cache.js'
import { signUrl } from './proxy.js'
import { cleanText, fetchUpstream, httpError, mapLimit, toTimestamp } from './util.js'

/* 看剧AI 签名密钥来自环境变量 KANJU_SECRET（NAS 模式用），未配置时看剧AI 源不可用 */
const KANJU_SECRET = process.env.KANJU_SECRET || ''
const CLIENT_HEADERS = {
  'x-ai-movie-client-name': 'dianyingtiantang-frontend',
  'x-ai-movie-client-version': '1.0.0',
  'x-ai-movie-protocol-version': '2026-07-05.library-v2.playback-v1',
  'x-ai-movie-build-version':
    'dianyingtiantang-v2026.10.21.6-redis-lifecycle-b85b39a9cc04-web'
}

const LIST_TTL = 2 * 60 * 1000
const DETAIL_TTL = 10 * 60 * 1000
const PLAY_TTL = 30 * 60 * 1000
const PAGE_LIMIT = 24
const EPISODE_LIMIT = 200
const MAX_EPISODES = 600

const CONTENT_LABELS = {
  movie: '电影',
  series: '电视剧',
  variety: '综艺',
  short_drama: '红果短剧',
  anime: '动漫',
  documentary: '纪录片'
}

const KIND_BY_TYPE = {
  movie: 'movie',
  tv: 'series',
  variety: 'variety',
  short: 'short_drama',
  anime: 'anime',
  documentary: 'documentary'
}

const AREA_BY_REGION = {
  cn: ['中国大陆'],
  us: ['美国'],
  jpkr: ['日本', '韩国'],
  hk: ['中国香港'],
  tw: ['中国台湾']
}

export const KANJU_CATEGORIES = [
  { id: 'movie', name: '电影' },
  { id: 'tv', name: '电视剧' },
  { id: 'variety', name: '综艺' },
  { id: 'short', name: '红果短剧' },
  { id: 'anime', name: '动漫' },
  { id: 'documentary', name: '纪录片' }
]

export function isKanju(source) {
  return source?.type === 'kanju'
}

function baseOf(source) {
  const api = String(source?.api || '').trim()
  try {
    return new URL(api).origin
  } catch {
    throw httpError(400, `影视源「${source?.name || ''}」接口地址无效`)
  }
}

function sign(method, pathWithQuery, timestamp, nonce) {
  return crypto
    .createHmac('sha256', KANJU_SECRET)
    .update(`${method}\n${pathWithQuery}\n${timestamp}\n${nonce}`)
    .digest('hex')
}

async function requestJson(source, path, timeout = 15000, options = {}) {
  if (!KANJU_SECRET) throw httpError(503, '服务端未配置 KANJU_SECRET，看剧AI 源不可用')
  const method = String(options.method || 'GET').toUpperCase()
  const url = new URL(path, baseOf(source))
  const timestamp = String(Date.now())
  const nonce = crypto.randomBytes(16).toString('hex')
  const headers = {
    ...CLIENT_HEADERS,
    'x-ai-movie-timestamp': timestamp,
    'x-ai-movie-nonce': nonce,
    'x-ai-movie-signature': sign(method, `${url.pathname}${url.search}`, timestamp, nonce)
  }
  const init = { headers, timeout }
  if (method !== 'GET') {
    init.method = method
    init.headers = { ...headers, 'content-type': 'application/json' }
    init.body = JSON.stringify(options.body || {})
  }
  let response
  try {
    response = await fetchUpstream(url.href, init)
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? '请求超时' : '无法访问接口'
    throw httpError(502, `${source.name}: ${reason}`)
  }
  if (!response.ok) throw httpError(502, `${source.name}: HTTP ${response.status}`)
  const text = await response.text()
  if (text.length > 6 * 1024 * 1024) throw httpError(502, `${source.name}: 接口返回数据过大`)
  try {
    return JSON.parse(text)
  } catch {
    throw httpError(502, `${source.name}: 返回内容不是 JSON`)
  }
}

function mapCard(raw, source) {
  if (!raw || typeof raw.id !== 'string' || !raw.id) return null
  const genres = Array.isArray(raw.genres) ? raw.genres : []
  const pic = String(raw.poster_url || '')
  return {
    sourceId: source.id,
    sourceName: source.name,
    id: raw.id,
    name: cleanText(raw.title, 120) || '未命名',
    pic: pic ? signUrl(source.id, pic) : '',
    remarks:
      cleanText(raw.remarks, 60) ||
      (Number(raw.playback_count) > 0 ? `${Number(raw.playback_count)} 次播放` : ''),
    year: raw.year ? String(raw.year).slice(0, 4) : '',
    typeName: CONTENT_LABELS[raw.content_kind] || cleanText(genres[0], 30),
    area: cleanText(raw.area, 20),
    score: '',
    time: toTimestamp(raw.updated_at)
  }
}

async function browse(source, { page = 1, kind = '', area = '', query = '' } = {}) {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(PAGE_LIMIT),
    query_mode: 'fast_v3',
    search_fields: 'all'
  })
  if (kind) params.set('kind', kind)
  if (area) params.set('area', area)
  if (query) params.set('q', query)
  const payload = await requestJson(source, `/v1/browse/catalog?${params.toString()}`)
  return {
    cards: Array.isArray(payload?.cards) ? payload.cards : [],
    pagination: payload?.pagination || {}
  }
}

export function kanjuCategories() {
  return KANJU_CATEGORIES
}

export async function kanjuList(source, { page = 1, type = '', area = '' } = {}) {
  const safePage = Math.max(1, Math.min(Number(page) || 1, 200))
  const kind = KIND_BY_TYPE[type] || ''
  const region = area && AREA_BY_REGION[area] ? area : ''
  if (area && !region) {
    return { sourceId: source.id, items: [], page: safePage, pageCount: 1, total: 0 }
  }
  const key = `kanju:list:${source.id}:${kind || 'all'}:${region || 'all'}:${safePage}`
  return cached(key, LIST_TTL, async () => {
    const areas = region ? AREA_BY_REGION[region] : ['']
    const results = await mapLimit(areas, areas.length, (areaName) =>
      browse(source, { page: safePage, kind, area: areaName })
    )
    const seen = new Map()
    for (const result of results) {
      for (const card of result.cards) {
        const item = mapCard(card, source)
        if (item && !seen.has(item.id)) seen.set(item.id, item)
      }
    }
    const items = [...seen.values()].sort((a, b) => (b.time || 0) - (a.time || 0))
    const hasMore = results.some((result) => result.pagination?.has_more)
    return {
      sourceId: source.id,
      items,
      page: safePage,
      pageCount: hasMore ? safePage + 1 : safePage,
      total: items.length
    }
  })
}

async function loadEpisodes(source, id) {
  const list = []
  let offset = 0
  for (let round = 0; round < 8; round += 1) {
    const payload = await requestJson(
      source,
      `/v1/catalog/${encodeURIComponent(id)}/episodes?limit=${EPISODE_LIMIT}&offset=${offset}`
    )
    const page = Array.isArray(payload?.episodes) ? payload.episodes : []
    list.push(...page)
    const info = payload?.episode_pagination || {}
    if (!info.has_more || !page.length || list.length >= MAX_EPISODES) break
    offset += page.length
  }
  return list.filter((item) => typeof item?.token === 'string' && item.token.length > 8)
}

async function rankedLinesFor(source, token) {
  const payload = await requestJson(
    source,
    `/v1/playback/resolve/${encodeURIComponent(token)}?view=compact`
  )
  return rankLines(Array.isArray(payload?.line_options) ? payload.line_options : [])
}

export async function kanjuDetail(source, id) {
  const key = `kanju:detail:${source.id}:${id}`
  return cached(key, DETAIL_TTL, async () => {
    const payload = await requestJson(
      source,
      `/v1/catalog/${encodeURIComponent(id)}?view=compact`
    )
    if (payload?.object !== 'catalog.detail') throw httpError(404, '影片不存在或已下架')
    const base = mapCard(payload, source)
    if (!base) throw httpError(404, '影片不存在或已下架')
    const episodes = await loadEpisodes(source, id)
    const lines = []
    if (episodes.length) {
      let ranked = []
      try {
        ranked = await rankedLinesFor(source, episodes[0].token)
      } catch {
        ranked = []
      }
      if (ranked.length) {
        ranked.forEach((entry, index) => {
          const pin = `${index}|${encodeURIComponent(entry.key)}`
          lines.push({
            name: entry.label,
            official: entry.official,
            key: entry.key,
            episodes: episodes.map((item, position) => ({
              name: cleanText(item.title, 40) || `第${position + 1}集`,
              url: `kanju://${source.id}/${item.token}|${pin}`
            }))
          })
        })
      } else {
        lines.push({
          name: '看剧AI',
          episodes: episodes.map((item, index) => ({
            name: cleanText(item.title, 40) || `第${index + 1}集`,
            url: `kanju://${source.id}/${item.token}`
          }))
        })
      }
    }
    const actors = Array.isArray(payload.actors) ? payload.actors : []
    const directors = Array.isArray(payload.directors) ? payload.directors : []
    return {
      ...base,
      content: cleanText(payload.description, 3000),
      director: cleanText(directors.join(' / '), 100),
      actors: cleanText(actors.join(' / '), 200),
      lines,
      playable: lines.length > 0
    }
  })
}

export async function kanjuSearch(source, keyword) {
  const { cards } = await browse(source, { page: 1, query: keyword })
  return cards.map((card) => mapCard(card, source)).filter(Boolean)
}

function qualityScore(label) {
  const text = String(label || '').toLowerCase()
  if (/4k|2160|ai4k/.test(text)) return 500
  if (/1080/.test(text)) return 400
  if (/高清|蓝光|bluray|原画/.test(text)) return 320
  if (/720/.test(text)) return 200
  return 120
}

const STANDARD_LINE_LIMIT = 12

function lineKey(item, label) {
  const provider = cleanText(item.provider_id, 40) || cleanText(item.play_from, 40) || label
  const source = cleanText(item.source_vod_id, 40)
  return source ? `${provider}:${source}` : provider
}

function rankLines(options) {
  const seen = new Set()
  const scored = options
    .filter((item) => item && typeof item === 'object')
    .filter((item) => {
      const url = String(item.url || '')
      return /^https?:\/\//i.test(url) || url.startsWith('resolve://') || item.resolve_required
    })
    .map((item) => {
      const label = cleanText(item.label, 30) || '线路'
      const official =
        item.resolve_required === true ||
        item.resolve_mode === 'parse' ||
        String(item.url || '').startsWith('resolve://')
      let score = qualityScore(label)
      if (official) score += 1000
      if (item.selected === true) score += 60
      if (/官方/.test(label)) score += 25
      score += Math.max(0, Math.min(2, Number(item.preference_weight || 0) / 1000))
      if (Number(item.price_multiplier_bps || 0) > 10000) score -= 30
      if (item.probe_status === 'failed') score -= 500
      return { item, label, official, key: lineKey(item, label), score }
    })
    .sort((a, b) => b.score - a.score)
    .filter((entry) => {
      if (seen.has(entry.key)) return false
      seen.add(entry.key)
      return true
    })
  const official = scored.filter((entry) => entry.official)
  const standard = scored.filter((entry) => !entry.official).slice(0, STANDARD_LINE_LIMIT)
  return [...official, ...standard]
}

async function resolveLineTicket(source, ticket) {
  const payload = await requestJson(
    source,
    '/v1/playback/resolve-line?view=compact',
    20000,
    { method: 'POST', body: { ticket } }
  )
  const url = String(payload?.line?.url || '')
  if (!/^https?:\/\//i.test(url)) throw httpError(502, '官方线路暂时不可用')
  return url
}

export function splitKanjuToken(token) {
  const raw = String(token || '').trim()
  const parts = raw.split('|')
  if (parts.length === 1) return { token: raw, pinned: null, key: '' }
  const pinned = /^\d{1,3}$/.test(parts[1]) ? Number(parts[1]) : null
  let key = parts[2] || ''
  try {
    key = decodeURIComponent(key)
  } catch {
    /* keep raw key */
  }
  return { token: parts[0], pinned, key }
}

export async function kanjuResolve(source, token, attempt = 0) {
  const parsed = splitKanjuToken(token)
  token = parsed.token
  if (!/^[A-Za-z0-9_-]{10,300}$/.test(token)) throw httpError(400, '播放标识无效')
  const index =
    parsed.pinned !== null
      ? Math.max(0, Math.min(parsed.pinned, 60))
      : Math.max(0, Math.min(Number(attempt) || 0, 60))
  const selector = parsed.key || String(index)
  const key = `kanju:play:${source.id}:${token}:${selector}`
  return cached(key, PLAY_TTL, async () => {
    const payload = await requestJson(
      source,
      `/v1/playback/resolve/${encodeURIComponent(token)}?view=compact`
    )
    const ranked = rankLines(Array.isArray(payload?.line_options) ? payload.line_options : [])
    if (!ranked.length) throw httpError(404, '该集暂时没有可用播放地址')
    const chosen =
      (parsed.key ? ranked.find((entry) => entry.key === parsed.key) : null) || ranked[index] || null
    if (!chosen) throw httpError(404, '没有更多可用线路')
    const chosenIndex = ranked.indexOf(chosen)
    const raw = String(chosen.item.url || '')
    const direct = /^https?:\/\//i.test(raw)
      ? raw
      : await resolveLineTicket(source, raw.startsWith('resolve://') ? raw.slice(10) : String(chosen.item.resolve_ticket || ''))
    return {
      url: signUrl(source.id, direct),
      name: chosen.label,
      official: chosen.official,
      index: chosenIndex,
      total: ranked.length,
      fixed: parsed.pinned !== null || Boolean(parsed.key)
    }
  })
}

export async function testKanjuSource(source) {
  const started = Date.now()
  const { cards } = await browse(source, { page: 1 })
  if (!cards.length) throw httpError(502, `${source.name}: 接口没有返回内容`)
  return {
    ok: true,
    took: Date.now() - started,
    categoryCount: KANJU_CATEGORIES.length,
    categories: KANJU_CATEGORIES.map((item) => item.name),
    sample: cards.slice(0, 6).map((item) => item.title)
  }
}

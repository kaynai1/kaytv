import { cached, invalidate } from './cache.js'
import { isAdultContent, searchRelevance } from '@kaytv/shared'
import {
  isKanju,
  kanjuCategories,
  kanjuDetail,
  kanjuList,
  kanjuResolve,
  kanjuSearch,
  testKanjuSource
} from './kanju.js'
import { signUrl } from './proxy.js'
import {
  absoluteUrl,
  cleanText,
  fetchUpstream,
  httpError,
  mapLimit,
  toTimestamp
} from './util.js'

/* NAS 模式默认过滤成人内容；自建站点想放开就设 ADULT_FILTER=off */
const ADULT_FILTER = process.env.ADULT_FILTER !== 'off'

const CATEGORY_TTL = 60 * 60 * 1000
const LIST_TTL = 2 * 60 * 1000
const DETAIL_TTL = 10 * 60 * 1000
const SEARCH_TTL = 60 * 1000

function apiUrl(source, params = {}) {
  let url
  try {
    url = new URL(source.api)
  } catch {
    throw httpError(400, `影视源「${source.name}」接口地址无效`)
  }
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    url.searchParams.set(key, String(value))
  }
  return url.href
}

async function requestJson(source, params, timeout = 14000) {
  const url = apiUrl(source, params)
  let response
  try {
    response = await fetchUpstream(url, {
      headers: { accept: 'application/json, text/plain, */*', ...(source.headers || {}) },
      timeout
    })
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
    const match = text.match(/^[\s\w.]*\((.*)\)\s*;?\s*$/s)
    if (match) {
      try {
        return JSON.parse(match[1])
      } catch {
        /* fallthrough */
      }
    }
    throw httpError(502, `${source.name}: 返回内容不是 JSON`)
  }
}

function isShareLink(url) {
  return /\/share\//i.test(url) || /\/s\/[a-z0-9]{6,}/i.test(url)
}

function normalizeItem(raw, source) {
  if (!raw || raw.vod_id === undefined) return null
  if (ADULT_FILTER && (isAdultContent(raw.vod_name) || isAdultContent(raw.type_name) || isAdultContent(raw.vod_class))) {
    return null
  }
  const pic = absoluteUrl(raw.vod_pic, source.api)
  return {
    sourceId: source.id,
    sourceName: source.name,
    id: String(raw.vod_id),
    name: cleanText(raw.vod_name, 120) || '未命名',
    pic: pic ? signUrl(source.id, pic) : '',
    remarks: cleanText(raw.vod_remarks, 60),
    year: raw.vod_year ? String(raw.vod_year).slice(0, 10) : '',
    typeName: cleanText(raw.type_name, 30),
    area: cleanText(raw.vod_area, 20),
    score: raw.vod_score && Number(raw.vod_score) > 0 ? String(raw.vod_score) : '',
    time: toTimestamp(raw.vod_time)
  }
}

function normalizeList(payload, source) {
  const list = Array.isArray(payload?.list) ? payload.list : []
  const items = []
  for (const raw of list) {
    const item = normalizeItem(raw, source)
    if (item) items.push(item)
  }
  return {
    items,
    page: Number(payload?.page) || 1,
    pageCount: Number(payload?.pagecount) || 1,
    total: Number(payload?.total) || items.length
  }
}

function parseLines(raw, source) {
  const froms = String(raw?.vod_play_from || '').split('$$$')
  const groups = String(raw?.vod_play_url || '').split('$$$')
  const lines = []
  froms.forEach((lineName, index) => {
    const episodes = []
    for (const part of String(groups[index] || '').split('#')) {
      const splitAt = part.lastIndexOf('$')
      if (splitAt <= 0) continue
      const name = part.slice(0, splitAt).trim() || `第${episodes.length + 1}集`
      const url = part.slice(splitAt + 1).trim()
      if (!/^https?:\/\//i.test(url)) continue
      if (isShareLink(url)) continue
      episodes.push({ name: name.slice(0, 40), url: signUrl(source.id, url) })
      if (episodes.length >= 1000) break
    }
    if (episodes.length) {
      lines.push({ name: (lineName || `线路${index + 1}`).trim().slice(0, 20), episodes })
    }
  })
  return lines
}

function sourceForBrowse(config, sourceId) {
  const source = config.vodSources.find((item) => item.id === sourceId)
  if (!source) throw httpError(404, '影视源不存在')
  if (!source.enabled) throw httpError(403, '影视源已停用')
  return source
}

export async function getCategories(config, sourceId) {
  const source = sourceForBrowse(config, sourceId)
  if (isKanju(source)) return kanjuCategories()
  return cached(`vod:cat:${source.id}`, CATEGORY_TTL, async () => {
    let payload
    try {
      payload = await requestJson(source, { ac: 'list' })
    } catch (error) {
      payload = await requestJson(source, { ac: 'detail', pg: 1 })
    }
    const classes = Array.isArray(payload?.class) ? payload.class : []
    return classes
      .map((item) => ({
        id: String(item.type_id ?? ''),
        name: cleanText(item.type_name, 30)
      }))
      .filter((item) => item.id && item.name)
      .slice(0, 60)
  })
}

export async function getVodList(config, sourceId, { page = 1, type = '', area = '' } = {}) {
  const source = sourceForBrowse(config, sourceId)
  if (isKanju(source)) return kanjuList(source, { page, type, area })
  const safePage = Math.max(1, Math.min(Number(page) || 1, 200))
  const key = `vod:list:${source.id}:${safePage}:${type || 'all'}`
  return cached(key, LIST_TTL, async () => {
    let payload
    try {
      payload = await requestJson(source, { ac: 'detail', pg: safePage, t: type })
      const result = normalizeList(payload, source)
      if (result.items.length || Number(payload?.code) === 1) return result
    } catch {
      /* try legacy endpoint below */
    }
    payload = await requestJson(source, { ac: 'videolist', pg: safePage, t: type })
    return normalizeList(payload, source)
  })
}

async function searchOne(source, keyword) {
  const key = `vod:search:${source.id}:${keyword}`
  return cached(key, SEARCH_TTL, async () => {
    if (isKanju(source)) return kanjuSearch(source, keyword)
    let payload = await requestJson(source, { ac: 'detail', wd: keyword, pg: 1 }, 10000)
    let result = normalizeList(payload, source)
    if (!result.items.length && Number(payload?.code) !== 1) {
      payload = await requestJson(source, { ac: 'videolist', wd: keyword, pg: 1 }, 10000)
      result = normalizeList(payload, source)
    }
    return result.items
  })
}

export async function searchVod(config, keyword, sourceIds = null, excludeIds = null) {
  const query = String(keyword || '').trim().slice(0, 60)
  if (!query) return { query, items: [], errors: [], took: 0 }
  const excluded = excludeIds instanceof Set ? excludeIds : new Set()
  const enabled = config.vodSources.filter(
    (source) => source.enabled && !excluded.has(source.id)
  )
  const allowed = Array.isArray(sourceIds) && sourceIds.length
    ? enabled.filter((source) => sourceIds.includes(source.id))
    : enabled.filter((source) => source.searchable !== false)
  const started = Date.now()
  const results = await mapLimit(allowed, 10, async (source) => {
    try {
      return { sourceId: source.id, items: await searchOne(source, query), error: null }
    } catch (error) {
      return { sourceId: source.id, items: [], error: error.message || '搜索失败' }
    }
  })
  const items = rankByRelevance(
    results.flatMap((result) => result.items),
    query
  )
  return {
    query,
    items,
    errors: results.filter((result) => result.error).map(({ sourceId, error }) => ({ sourceId, message: error })),
    took: Date.now() - started
  }
}

function rankByRelevance(items, query) {
  return items
    .map((item) => ({ item, score: searchRelevance(item.name, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || (b.item.time || 0) - (a.item.time || 0))
    .map((entry) => entry.item)
}

export async function getVodDetail(config, sourceId, vodId) {
  const source = sourceForBrowse(config, sourceId)
  const id = String(vodId || '').trim()
  if (!id || id.length > 120) throw httpError(400, '影片 ID 无效')
  if (isKanju(source)) return kanjuDetail(source, id)
  if (id.length > 40) throw httpError(400, '影片 ID 无效')
  return cached(`vod:detail:${source.id}:${id}`, DETAIL_TTL, async () => {
    const payload = await requestJson(source, { ac: 'detail', ids: id })
    const raw = Array.isArray(payload?.list) ? payload.list[0] : null
    if (!raw) throw httpError(404, '影片不存在或已下架')
    const base = normalizeItem(raw, source)
    const lines = parseLines(raw, source)
    return {
      ...base,
      content: cleanText(raw.vod_content, 3000),
      director: cleanText(raw.vod_director, 100),
      actors: cleanText(raw.vod_actor, 200),
      lines,
      playable: lines.length > 0
    }
  })
}

export async function testVodSource(source) {
  if (isKanju(source)) return testKanjuSource(source)
  const started = Date.now()
  const payload = await requestJson(source, { ac: 'list' })
  const classes = Array.isArray(payload?.class) ? payload.class : []
  const list = Array.isArray(payload?.list) ? payload.list : []
  return {
    ok: true,
    took: Date.now() - started,
    categoryCount: classes.length,
    categories: classes.slice(0, 10).map((item) => item.type_name),
    sample: list.slice(0, 6).map((item) => item.vod_name)
  }
}

export async function resolveVodPlayback(config, sourceId, token, attempt = 0) {
  const source = sourceForBrowse(config, sourceId)
  if (!isKanju(source)) throw httpError(400, '该影视源不支持在线解析播放')
  return kanjuResolve(source, String(token || '').trim(), attempt)
}

export function invalidateVod(sourceId) {
  invalidate(`vod:${sourceId}:`)
  invalidate(`kanju:list:${sourceId}:`)
  invalidate(`kanju:detail:${sourceId}:`)
}

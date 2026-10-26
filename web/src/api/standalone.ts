import { BUILTIN_LIVE, BUILTIN_VOD, contentTypeOf, isAdultContent, searchRelevance } from '@kaytv/shared'
import type {
  Category,
  FeedResult,
  SearchResult,
  Taxonomy,
  VodDetail,
  VodItem,
  VodListResult
} from '../types'
import { findCustomLive, findCustomVod, listCustom } from './customSources'
import { logEvent } from './diagnostics'

interface LocalSource {
  id: string
  name: string
  api: string
  type?: string
  enabled?: boolean
  searchable?: boolean
}

/* 设置页的片源开关与成人过滤要真的作用到内置引擎，不能只管 chip 行 */
let sourceGate: (id: string) => boolean = () => true
let adultFilterOn = true

export function setEngineGates(gates: { sourceGate?: (id: string) => boolean; adultFilter?: boolean }) {
  if (typeof gates.sourceGate === 'function') sourceGate = gates.sourceGate
  if (typeof gates.adultFilter === 'boolean') adultFilterOn = gates.adultFilter
}

function adultBlocked(...texts: unknown[]): boolean {
  return adultFilterOn && texts.some((text) => isAdultContent(String(text || '')))
}

const CATEGORY_TTL = 60 * 60 * 1000
const LIST_TTL = 2 * 60 * 1000
const DETAIL_TTL = 10 * 60 * 1000
const SEARCH_TTL = 60 * 1000
const FEED_TTL = 2 * 60 * 1000
const TAXONOMY_TTL = 30 * 60 * 1000
const FAIL_TTL = 2 * 60 * 1000
const MAX_PAGE = 8
const REQUEST_TIMEOUT = 9000

const CONTENT_TYPES = [
  { id: 'movie', name: '电影' },
  { id: 'tv', name: '电视剧' },
  { id: 'variety', name: '综艺' },
  { id: 'short', name: '红果短剧' },
  { id: 'anime', name: '动漫' },
  { id: 'documentary', name: '纪录片' }
]

const REGIONS = [
  { id: 'cn', name: '中国' },
  { id: 'us', name: '美国' },
  { id: 'jpkr', name: '日韩' },
  { id: 'hk', name: '港台' },
  { id: 'tw', name: '台湾' },
  { id: 'other', name: '其他' }
]

const FAIL_STORE = 'kaytv.standalone.fail.v1'

const cache = new Map<string, { value: unknown; expires: number }>()
const failures = loadFailures()

/*
 * 落盘缓存：只有第一次安装才需要等源站把分类、片墙、详情跑出来，
 * 之后先拿本机旧数据铺界面，过期了就在后台悄悄刷新。
 * 播放地址（kanju:play）带时效，只留在内存里，不能隔天再发出去。
 */
const DB_NAME = 'kaytv-standalone'
const DB_STORE = 'cache'
const STALE_WINDOW = 12 * 60 * 60 * 1000
const MAX_ENTRIES = 400

interface DiskEntry {
  value: unknown
  expires: number
  storedAt: number
}

function persistable(key: string): boolean {
  return !key.startsWith('kanju:play:')
}

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const request = indexedDB.open(DB_NAME, 1)
        request.onupgradeneeded = () => {
          const db = request.result
          if (!db.objectStoreNames.contains(DB_STORE)) {
            db.createObjectStore(DB_STORE).createIndex('byStored', 'storedAt')
          }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => resolve(null)
        request.onblocked = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
  }
  return dbPromise
}

function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => Promise<T>): Promise<T | null> {
  return openDb().then(async (db) => {
    if (!db) return null
    try {
      return await run(db.transaction(DB_STORE, mode).objectStore(DB_STORE))
    } catch {
      return null
    }
  })
}

function ask<T>(request: IDBRequest): Promise<T | null> {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result as T)
    request.onerror = () => resolve(null)
  })
}

function diskGet(key: string): Promise<DiskEntry | null> {
  return withStore('readonly', async (store) => (await ask<DiskEntry>(store.get(key))) || null)
}

let writes = 0

function diskPut(key: string, entry: DiskEntry) {
  if (++writes % 25 !== 0) {
    void withStore('readwrite', (store) => {
      store.put(entry, key)
      return Promise.resolve(null)
    })
    return
  }
  void withStore('readwrite', async (store) => {
    store.put(entry, key)
    const total = await ask<number>(store.count())
    const excess = (total || 0) - MAX_ENTRIES
    if (excess <= 0) return null
    const cursorRequest = store.index('byStored').openCursor()
    let removed = 0
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result
      if (!cursor || removed >= excess) return
      removed += 1
      cursor.delete()
      cursor.continue()
    }
    return null
  })
}

const refreshing = new Set<string>()

async function revalidate<T>(key: string, ttl: number, producer: () => Promise<T>) {
  if (refreshing.has(key)) return
  refreshing.add(key)
  try {
    const value = await producer()
    if (value !== undefined) remember(key, value, ttl)
  } catch {
    /* 后台刷新失败就继续用旧数据，不用打扰用户 */
  } finally {
    refreshing.delete(key)
  }
}

function remember<T>(key: string, value: T, ttl: number) {
  const expires = Date.now() + ttl
  cache.set(key, { value, expires })
  if (cache.size > 300) {
    for (const [entryKey, entry] of cache) {
      if (entry.expires <= Date.now()) cache.delete(entryKey)
    }
  }
  if (persistable(key)) diskPut(key, { value, expires, storedAt: Date.now() })
}

async function cached<T>(key: string, ttl: number, producer: () => Promise<T>): Promise<T> {
  const now = Date.now()
  let hit = cache.get(key)
  if (!hit && persistable(key)) {
    const stored = await diskGet(key)
    if (stored) {
      hit = { value: stored.value, expires: stored.expires }
      cache.set(key, hit)
    }
  }
  if (hit && hit.expires > now) return hit.value as T
  if (hit && persistable(key) && now - hit.expires < STALE_WINDOW) {
    void revalidate(key, ttl, producer)
    return hit.value as T
  }
  const value = await producer()
  remember(key, value, ttl)
  return value
}

function loadFailures(): Map<string, number> {
  try {
    const raw = localStorage.getItem(FAIL_STORE)
    if (!raw) return new Map()
    const parsed = JSON.parse(raw) as Record<string, number>
    const now = Date.now()
    return new Map(
      Object.entries(parsed).filter(([, until]) => Number(until) > now)
    )
  } catch {
    return new Map()
  }
}

function saveFailures() {
  try {
    localStorage.setItem(FAIL_STORE, JSON.stringify(Object.fromEntries(failures)))
  } catch {
    /* storage may be unavailable */
  }
}

function markFailed(id: string, reason = '') {
  failures.set(id, Date.now() + FAIL_TTL)
  saveFailures()
  if (reason) {
    const name = allSources().find((item) => item.id === id)?.name || id
    logEvent('source', `${name}: ${reason}`)
  }
}

function failedRecently(id: string): boolean {
  const until = failures.get(id)
  if (!until) return false
  if (until <= Date.now()) {
    failures.delete(id)
    saveFailures()
    return false
  }
  return true
}

/* 最近一次源检测结果留在本机，聚合片墙优先问快且可用的源，冷启动不用等 30 多个源全跑完 */
interface HealthEntry {
  ok: boolean
  ms: number
  at: number
}

const HEALTH_KEY = 'kaytv.sourceHealth.v1'
const HEALTH_TTL = 24 * 60 * 60 * 1000
const AGGREGATE_SOURCES = 14

function loadHealth(): Record<string, HealthEntry> {
  try {
    const parsed = JSON.parse(localStorage.getItem(HEALTH_KEY) || '{}') as Record<string, HealthEntry>
    const fresh: Record<string, HealthEntry> = {}
    for (const [id, entry] of Object.entries(parsed)) {
      if (entry && typeof entry.ok === 'boolean' && Date.now() - (entry.at || 0) < HEALTH_TTL) fresh[id] = entry
    }
    return fresh
  } catch {
    return {}
  }
}

const health = loadHealth()

export function rememberHealth(id: string, ok: boolean, ms: number) {
  const previous = health[id]
  const rounded = Math.max(0, Math.round(ms || 0))
  /* 每次请求都会回报，只在状态翻转、耗时明显变化或记录过期时才落盘 */
  if (
    previous &&
    previous.ok === ok &&
    Math.abs(previous.ms - rounded) < 250 &&
    Date.now() - previous.at < 5 * 60 * 1000
  ) {
    return
  }
  health[id] = { ok, ms: rounded, at: Date.now() }
  try {
    localStorage.setItem(HEALTH_KEY, JSON.stringify(health))
  } catch {
    /* 记不住健康度只影响下次排序 */
  }
}

export function healthOf(id: string): HealthEntry | undefined {
  return health[id]
}

function preferHealthy(sources: LocalSource[], limit: number): LocalSource[] {
  const kanjuFirst = (item: LocalSource) => (item.type === 'kanju' ? 0 : 1)
  const rank = (item: LocalSource) => {
    const entry = health[item.id]
    if (!entry) return 1
    return entry.ok ? 0 : 2
  }
  const sorted = [...sources].sort((a, b) => {
    const byKanju = kanjuFirst(a) - kanjuFirst(b)
    if (byKanju) return byKanju
    const byRank = rank(a) - rank(b)
    if (byRank) return byRank
    return (health[a.id]?.ms || 0) - (health[b.id]?.ms || 0)
  })
  const chosen = sorted.slice(0, Math.max(1, limit))
  // 一个可用记录都没有时按原顺序全量并发，避免刚装机就被固定成同一小撮源
  return Object.keys(health).length ? chosen : sources
}

function absoluteUrl(value: unknown, base: string): string {
  if (!value) return ''
  try {
    return new URL(String(value), base).href
  } catch {
    return ''
  }
}

function cleanText(value: unknown, max = 4000): string {
  if (!value) return ''
  let text = String(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
  for (let pass = 0; pass < 3; pass += 1) {
    const next = text
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
    if (next === text) break
    text = next
  }
  text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  return text.slice(0, max)
}

function toTimestamp(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0
  const raw = String(value).trim()
  if (/^\d+$/.test(raw)) {
    const num = Number(raw)
    return num > 1e12 ? num : num * 1000
  }
  const parsed = Date.parse(raw.replace(' ', 'T'))
  return Number.isFinite(parsed) ? parsed : 0
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

function builtinSources(): LocalSource[] {
  const builtins = BUILTIN_VOD.filter(
    (item) => item.enabled !== false && sourceGate(item.id)
  ).map((item) => ({
    id: item.id,
    name: item.name,
    api: item.api,
    type: item.type,
    searchable: item.searchable
  }))
  const custom = listCustom('vod')
    .filter((item) => sourceGate(item.id))
    .map((item) => ({
      id: item.id,
      name: item.name,
      api: String('api' in item ? item.api : ''),
      type: item.type || 'cms',
      searchable: true
    }))
  return [...builtins, ...custom]
}

function allSources(): LocalSource[] {
  const builtins = BUILTIN_VOD.filter((item) => item.enabled !== false).map((item) => ({
    id: item.id,
    name: item.name,
    api: item.api,
    type: item.type,
    searchable: item.searchable
  }))
  const custom = listCustom('vod').map((item) => ({
    id: item.id,
    name: item.name,
    api: String('api' in item ? item.api : ''),
    type: item.type || 'cms',
    searchable: true
  }))
  return [...builtins, ...custom]
}

function sourceById(id: string): LocalSource {
  // 关掉的片源不再进片墙与搜索，但已有的收藏/历史仍要能打开详情
  const source = builtinSources().find((item) => item.id === id) || allSources().find((item) => item.id === id)
  if (!source) throw new Error('影视源不存在')
  return source
}

async function requestJson(
  source: LocalSource,
  params: Record<string, string | number | undefined>,
  timeout = REQUEST_TIMEOUT
): Promise<Record<string, unknown>> {
  const started = Date.now()
  let url: URL
  try {
    url = new URL(source.api)
  } catch {
    throw new Error(`${source.name}: 接口地址无效`)
  }
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    url.searchParams.set(key, String(value))
  }
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(url.href, {
      headers: { accept: 'application/json, text/plain, */*' },
      referrerPolicy: 'no-referrer',
      signal: controller.signal
    })
    if (!response.ok) {
      markFailed(source.id, `HTTP ${response.status}`)
      rememberHealth(source.id, false, Date.now() - started)
      throw new Error(`${source.name}: HTTP ${response.status}`)
    }
    const text = await response.text()
    if (text.length > 6 * 1024 * 1024) throw new Error(`${source.name}: 接口返回数据过大`)
    try {
      const payload = JSON.parse(text) as Record<string, unknown>
      rememberHealth(source.id, true, Date.now() - started)
      return payload
    } catch {
      const match = text.match(/^[\s\w.]*\((.*)\)\s*;?\s*$/s)
      if (match) {
        try {
          const payload = JSON.parse(match[1]) as Record<string, unknown>
          rememberHealth(source.id, true, Date.now() - started)
          return payload
        } catch {
          /* fallthrough */
        }
      }
      markFailed(source.id, '返回内容不是 JSON')
      rememberHealth(source.id, false, Date.now() - started)
      throw new Error(`${source.name}: 返回内容不是 JSON`)
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(source.name)) throw error
    markFailed(source.id, controller.signal.aborted ? '请求超时' : '无法访问接口')
    rememberHealth(source.id, false, Date.now() - started)
    throw new Error(`${source.name}: ${controller.signal.aborted ? '请求超时' : '无法访问接口'}`)
  } finally {
    window.clearTimeout(timer)
  }
}

/* 看剧AI 签名密钥由构建期注入（VITE_KANJU_SECRET）；缺失时该源自动跳过，其余源不受影响 */
const KANJU_SECRET = (import.meta.env.VITE_KANJU_SECRET as string | undefined) || ''
const KANJU_LABELS: Record<string, string> = {
  movie: '电影',
  series: '电视剧',
  variety: '综艺',
  short_drama: '红果短剧',
  anime: '动漫',
  documentary: '纪录片'
}
const KANJU_KINDS: Record<string, string> = {
  movie: 'movie',
  tv: 'series',
  variety: 'variety',
  short: 'short_drama',
  anime: 'anime',
  documentary: 'documentary'
}
const KANJU_AREAS: Record<string, string[]> = {
  cn: ['中国大陆'],
  us: ['美国'],
  jpkr: ['日本', '韩国'],
  hk: ['中国香港'],
  tw: ['中国台湾']
}
const KANJU_CATEGORIES: Category[] = [
  { id: 'movie', name: '电影' },
  { id: 'tv', name: '电视剧' },
  { id: 'variety', name: '综艺' },
  { id: 'short', name: '红果短剧' },
  { id: 'anime', name: '动漫' },
  { id: 'documentary', name: '纪录片' }
]

let kanjuKey: Promise<CryptoKey> | null = null
let kanjuProxyBase = ''

/** 云后台启用看剧AI 代签后，客户端走云端代理，密钥不再依赖构建期注入 */
export function setKanjuProxy(base: string) {
  kanjuProxyBase = String(base || '').replace(/\/+$/, '')
}

function kanjuProxyUrl(path: string): string {
  return `${kanjuProxyBase}${path}`
}

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function kanjuHeaders(url: URL, method = 'GET'): Promise<Record<string, string>> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('当前环境不支持加密签名')
  if (!KANJU_SECRET) throw new Error('看剧AI: 本机构建未注入接口密钥')
  if (!kanjuKey) {
    kanjuKey = subtle.importKey(
      'raw',
      new TextEncoder().encode(KANJU_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )
  }
  const key = await kanjuKey
  const timestamp = String(Date.now())
  const nonce = hexOf(crypto.getRandomValues(new Uint8Array(16)))
  const signature = await subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${method}\n${url.pathname}${url.search}\n${timestamp}\n${nonce}`)
  )
  return {
    accept: 'application/json, text/plain, */*',
    'x-ai-movie-timestamp': timestamp,
    'x-ai-movie-nonce': nonce,
    'x-ai-movie-signature': hexOf(new Uint8Array(signature)),
    'x-ai-movie-client-name': 'dianyingtiantang-frontend',
    'x-ai-movie-client-version': '1.0.0',
    'x-ai-movie-protocol-version': '2026-07-05.library-v2.playback-v1',
    'x-ai-movie-build-version':
      'dianyingtiantang-v2026.10.21.6-redis-lifecycle-b85b39a9cc04-web'
  }
}

interface KanjuAttempt {
  payload?: Record<string, unknown>
  error?: string
  retryable?: boolean
}

async function kanjuAttempt(
  source: LocalSource,
  path: string,
  timeout: number,
  method: string,
  body: unknown,
  mode: 'proxy' | 'direct'
): Promise<KanjuAttempt> {
  let href: string
  try {
    href = mode === 'proxy' ? kanjuProxyUrl(path) : new URL(path, source.api).href
  } catch {
    return { error: '接口地址无效' }
  }
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeout)
  try {
    const headers: Record<string, string> =
      mode === 'proxy'
        ? { accept: 'application/json, text/plain, */*' }
        : await kanjuHeaders(new URL(href), method)
    if (method !== 'GET') headers['content-type'] = 'application/json'
    const response = await fetch(href, {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
      referrerPolicy: 'no-referrer',
      signal: controller.signal
    })
    const text = await response.text()
    if (!response.ok) {
      let detail = ''
      try {
        const data = JSON.parse(text) as { error?: unknown }
        if (typeof data?.error === 'string') detail = data.error
      } catch {
        /* non-JSON error body */
      }
      return { error: detail || `HTTP ${response.status}`, retryable: mode === 'proxy' }
    }
    try {
      return { payload: JSON.parse(text) as Record<string, unknown> }
    } catch {
      return { error: '返回内容不是 JSON' }
    }
  } catch {
    return {
      error: controller.signal.aborted ? '请求超时' : '无法访问接口',
      retryable: mode === 'proxy'
    }
  } finally {
    window.clearTimeout(timer)
  }
}

async function kanjuJson(
  source: LocalSource,
  path: string,
  timeout = 12000,
  options: { method?: string; body?: unknown } = {}
): Promise<Record<string, unknown>> {
  const started = Date.now()
  const method = String(options.method || 'GET').toUpperCase()
  const modes: ('proxy' | 'direct')[] = []
  if (kanjuProxyBase) modes.push('proxy')
  if (KANJU_SECRET) modes.push('direct')
  if (!modes.length) throw new Error(`${source.name}: 云端未启用看剧AI 代签，本机构建也没有内置密钥`)
  let lastError = '无法访问接口'
  for (const mode of modes) {
    const attempt = await kanjuAttempt(
      source,
      path,
      mode === 'proxy' ? Math.min(timeout, 9000) : timeout,
      method,
      options.body,
      mode
    )
    if (attempt.payload) {
      rememberHealth(source.id, true, Date.now() - started)
      return attempt.payload
    }
    lastError = attempt.error || lastError
    if (!attempt.retryable) break
  }
  markFailed(source.id, lastError)
  rememberHealth(source.id, false, Date.now() - started)
  throw new Error(`${source.name}: ${lastError}`)
}

function kanjuCard(raw: Record<string, unknown>, source: LocalSource): VodItem | null {
  const id = String(raw?.id || '')
  if (!id) return null
  const genres = Array.isArray(raw?.genres) ? raw.genres : []
  const kind = String(raw?.content_kind || '')
  if (adultBlocked(raw?.title, KANJU_LABELS[kind] || genres[0])) return null
  return {
    sourceId: source.id,
    sourceName: source.name,
    id,
    name: cleanText(raw?.title, 120) || '未命名',
    pic: absoluteUrl(raw?.poster_url, source.api),
    remarks:
      cleanText(raw?.remarks, 60) ||
      (Number(raw?.playback_count) > 0 ? `${Number(raw.playback_count)} 次播放` : ''),
    year: raw?.year ? String(raw.year).slice(0, 4) : '',
    typeName: KANJU_LABELS[kind] || cleanText(genres[0], 30),
    area: cleanText(raw?.area, 20),
    score: '',
    time: toTimestamp(raw?.updated_at)
  }
}

async function kanjuBrowse(
  source: LocalSource,
  { page = 1, kind = '', area = '', query = '' }: { page?: number; kind?: string; area?: string; query?: string }
): Promise<{ cards: Record<string, unknown>[]; pagination: Record<string, unknown> }> {
  const params = new URLSearchParams({
    page: String(page),
    limit: '24',
    query_mode: 'fast_v3',
    search_fields: 'all'
  })
  if (kind) params.set('kind', kind)
  if (area) params.set('area', area)
  if (query) params.set('q', query)
  const payload = await kanjuJson(source, `/v1/browse/catalog?${params.toString()}`)
  return {
    cards: Array.isArray(payload?.cards) ? (payload.cards as Record<string, unknown>[]) : [],
    pagination: payload?.pagination && typeof payload.pagination === 'object'
      ? (payload.pagination as Record<string, unknown>)
      : {}
  }
}

async function kanjuList(
  source: LocalSource,
  page: number,
  type = '',
  area = ''
): Promise<VodListResult> {
  const safePage = Math.max(1, Math.min(Number(page) || 1, 200))
  const kind = KANJU_KINDS[type] || ''
  const region = area && KANJU_AREAS[area] ? area : ''
  if (area && !region) {
    return { sourceId: source.id, items: [], page: safePage, pageCount: 1, total: 0 }
  }
  const key = `kanju:list:${source.id}:${kind || 'all'}:${region || 'all'}:${safePage}`
  const list = await cached<VodListResult>(key, LIST_TTL, async () => {
    const areas = region ? KANJU_AREAS[region] : ['']
    const results = await mapLimit(areas, areas.length, (areaName) =>
      kanjuBrowse(source, { page: safePage, kind, area: areaName })
    )
    const seen = new Map<string, VodItem>()
    for (const result of results) {
      for (const card of result.cards) {
        const item = kanjuCard(card, source)
        if (item && !seen.has(item.id)) seen.set(item.id, item)
      }
    }
    const items = [...seen.values()].sort((a, b) => (b.time || 0) - (a.time || 0))
    const hasMore = results.some((result) => result.pagination.has_more)
    return {
      sourceId: source.id,
      items,
      page: safePage,
      pageCount: hasMore ? safePage + 1 : safePage,
      total: items.length
    }
  })
  if (!list.items.length) cache.delete(key)
  return list
}

async function kanjuEpisodes(source: LocalSource, id: string): Promise<Record<string, unknown>[]> {
  const list: Record<string, unknown>[] = []
  let offset = 0
  for (let round = 0; round < 8; round += 1) {
    const payload = await kanjuJson(
      source,
      `/v1/catalog/${encodeURIComponent(id)}/episodes?limit=200&offset=${offset}`,
      15000
    )
    const page = Array.isArray(payload?.episodes)
      ? (payload.episodes as Record<string, unknown>[])
      : []
    list.push(...page)
    const info = (payload?.episode_pagination || {}) as Record<string, unknown>
    if (!info.has_more || !page.length || list.length >= 600) break
    offset += page.length
  }
  return list.filter((item) => typeof item?.token === 'string' && String(item.token).length > 8)
}

async function kanjuRankedLines(source: LocalSource, token: string): Promise<RankedLine[]> {
  const payload = await kanjuJson(
    source,
    `/v1/playback/resolve/${encodeURIComponent(token)}?view=compact`,
    15000
  )
  return rankLines(
    Array.isArray(payload?.line_options) ? (payload.line_options as Record<string, unknown>[]) : []
  )
}

async function kanjuDetail(source: LocalSource, id: string): Promise<VodDetail> {
  return cached(`kanju:detail:${source.id}:${id}`, DETAIL_TTL, async () => {
    const payload = await kanjuJson(
      source,
      `/v1/catalog/${encodeURIComponent(id)}?view=compact`,
      15000
    )
    if (payload?.object !== 'catalog.detail') throw new Error('影片不存在或已下架')
    const base = kanjuCard(payload, source)
    if (!base) throw new Error('影片不存在或已下架')
    const episodes = await kanjuEpisodes(source, id)
    const lines: VodDetail['lines'] = []
    if (episodes.length) {
      let ranked: RankedLine[] = []
      try {
        ranked = await kanjuRankedLines(source, String(episodes[0].token))
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
              url: `kanju://${source.id}/${String(item.token)}|${pin}`
            }))
          })
        })
      } else {
        lines.push({
          name: '看剧AI',
          episodes: episodes.map((item, index) => ({
            name: cleanText(item.title, 40) || `第${index + 1}集`,
            url: `kanju://${source.id}/${String(item.token)}`
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

async function kanjuSearch(source: LocalSource, keyword: string): Promise<VodItem[]> {
  const { cards } = await kanjuBrowse(source, { page: 1, query: keyword })
  return cards
    .map((card) => kanjuCard(card, source))
    .filter((item): item is VodItem => Boolean(item))
}

function qualityScore(label: string): number {
  const text = String(label || '').toLowerCase()
  if (/4k|2160|ai4k/.test(text)) return 500
  if (/1080/.test(text)) return 400
  if (/高清|蓝光|bluray|原画/.test(text)) return 320
  if (/720/.test(text)) return 200
  return 120
}

interface RankedLine {
  item: Record<string, unknown>
  label: string
  official: boolean
  key: string
  score: number
}

const KANJU_STANDARD_LINE_LIMIT = 12

function lineKey(item: Record<string, unknown>, label: string): string {
  const provider = cleanText(item.provider_id, 40) || cleanText(item.play_from, 40) || label
  const source = cleanText(item.source_vod_id, 40)
  return source ? `${provider}:${source}` : provider
}

function rankLines(options: Record<string, unknown>[]): RankedLine[] {
  const seen = new Set<string>()
  const scored = options
    .filter((item) => item && typeof item === 'object')
    .filter((item) => {
      const raw = String(item.url || '')
      return /^https?:\/\//i.test(raw) || raw.startsWith('resolve://') || item.resolve_required === true
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
  const standard = scored.filter((entry) => !entry.official).slice(0, KANJU_STANDARD_LINE_LIMIT)
  return [...official, ...standard]
}

async function resolveLineTicket(source: LocalSource, ticket: string): Promise<string> {
  const payload = await kanjuJson(
    source,
    '/v1/playback/resolve-line?view=compact',
    20000,
    { method: 'POST', body: { ticket } }
  )
  const line = payload?.line as Record<string, unknown> | undefined
  const url = String(line?.url || '')
  if (!/^https?:\/\//i.test(url)) throw new Error('官方线路暂时不可用')
  return url
}

export interface PlaybackLine {
  url: string
  name: string
  official: boolean
  index: number
  total: number
  fixed?: boolean
}

export interface KanjuPin {
  token: string
  pinned: number | null
  key: string
}

export function splitKanjuToken(value: string): KanjuPin {
  const raw = String(value || '').trim()
  const parts = raw.split('|')
  const token = parts[0]
  if (parts.length === 1) return { token, pinned: null, key: '' }
  const pinned = /^\d{1,3}$/.test(parts[1]) ? Number(parts[1]) : null
  let key = parts[2] || ''
  try {
    key = decodeURIComponent(key)
  } catch {
    /* keep raw key */
  }
  return { token, pinned, key }
}

export async function resolveKanju(
  sourceId: string,
  token: string,
  attempt = 0
): Promise<PlaybackLine> {
  const source = sourceById(sourceId)
  if (source.type !== 'kanju') throw new Error('该影视源不支持在线解析播放')
  const parsed = splitKanjuToken(token)
  token = parsed.token
  if (!/^[A-Za-z0-9_-]{10,300}$/.test(token)) throw new Error('播放标识无效')
  const index =
    parsed.pinned !== null
      ? Math.max(0, Math.min(parsed.pinned, 60))
      : Math.max(0, Math.min(Number(attempt) || 0, 60))
  const selector = parsed.key || String(index)
  return cached(`kanju:play:${source.id}:${token}:${selector}`, 30 * 60 * 1000, async () => {
    const payload = await kanjuJson(
      source,
      `/v1/playback/resolve/${encodeURIComponent(token)}?view=compact`,
      15000
    )
    const ranked = rankLines(
      Array.isArray(payload?.line_options) ? (payload.line_options as Record<string, unknown>[]) : []
    )
    if (!ranked.length) throw new Error('该集暂时没有可用播放地址')
    const chosen =
      (parsed.key ? ranked.find((entry) => entry.key === parsed.key) : null) || ranked[index] || null
    if (!chosen) throw new Error('没有更多可用线路')
    const chosenIndex = ranked.indexOf(chosen)
    const raw = String(chosen.item.url || '')
    const url = /^https?:\/\//i.test(raw)
      ? raw
      : await resolveLineTicket(
          source,
          raw.startsWith('resolve://') ? raw.slice(10) : String(chosen.item.resolve_ticket || '')
        )
    return {
      url,
      name: chosen.label,
      official: chosen.official,
      index: chosenIndex,
      total: ranked.length,
      fixed: parsed.pinned !== null || Boolean(parsed.key)
    }
  })
}

function isShareLink(url: string): boolean {
  return /\/share\//i.test(url) || /\/s\/[a-z0-9]{6,}/i.test(url)
}

function normalizeItem(raw: Record<string, unknown>, source: LocalSource): VodItem | null {
  if (!raw || raw.vod_id === undefined) return null
  const pic = absoluteUrl(raw.vod_pic, source.api)
  if (adultBlocked(raw.vod_name, raw.type_name, raw.vod_class)) return null
  return {
    sourceId: source.id,
    sourceName: source.name,
    id: String(raw.vod_id),
    name: cleanText(raw.vod_name, 120) || '未命名',
    pic,
    remarks: cleanText(raw.vod_remarks, 60),
    year: raw.vod_year ? String(raw.vod_year).slice(0, 10) : '',
    typeName: cleanText(raw.type_name, 30),
    area: cleanText(raw.vod_area, 20),
    score: raw.vod_score && Number(raw.vod_score) > 0 ? String(raw.vod_score) : '',
    time: toTimestamp(raw.vod_time)
  }
}

function normalizeList(payload: Record<string, unknown>, source: LocalSource): VodListResult {
  const list = Array.isArray(payload?.list) ? (payload.list as Record<string, unknown>[]) : []
  const items: VodItem[] = []
  for (const raw of list) {
    const item = normalizeItem(raw, source)
    if (item) items.push(item)
  }
  return {
    sourceId: source.id,
    items,
    page: Number(payload?.page) || 1,
    pageCount: Number(payload?.pagecount) || 1,
    total: Number(payload?.total) || items.length
  }
}

function parseLines(raw: Record<string, unknown>) {
  const froms = String(raw?.vod_play_from || '').split('$$$')
  const groups = String(raw?.vod_play_url || '').split('$$$')
  const lines: VodDetail['lines'] = []
  froms.forEach((lineName, index) => {
    const episodes: VodDetail['lines'][number]['episodes'] = []
    for (const part of String(groups[index] || '').split('#')) {
      const splitAt = part.lastIndexOf('$')
      if (splitAt <= 0) continue
      const name = part.slice(0, splitAt).trim() || `第${episodes.length + 1}集`
      const url = part.slice(splitAt + 1).trim()
      if (!/^https?:\/\//i.test(url)) continue
      if (isShareLink(url)) continue
      episodes.push({ name: name.slice(0, 40), url })
      if (episodes.length >= 1000) break
    }
    if (episodes.length) {
      lines.push({ name: (lineName || `线路${index + 1}`).trim().slice(0, 20), episodes })
    }
  })
  return lines
}

async function getCategories(source: LocalSource): Promise<Category[]> {
  if (source.type === 'kanju') return KANJU_CATEGORIES
  return cached(`cat:${source.id}`, CATEGORY_TTL, async () => {
    let payload: Record<string, unknown>
    try {
      payload = await requestJson(source, { ac: 'list' }, 6000)
    } catch {
      payload = await requestJson(source, { ac: 'detail', pg: 1 }, 6000)
    }
    const classes = Array.isArray(payload?.class) ? (payload.class as Record<string, unknown>[]) : []
    return classes
      .map((item) => ({
        id: String(item.type_id ?? ''),
        name: cleanText(item.type_name, 30)
      }))
      .filter((item) => item.id && item.name)
      .slice(0, 60)
  })
}

function regionOf(name: string): string {
  if (/国产|大陆|内地|中国|华语/.test(name)) return 'cn'
  if (/美国|美剧|欧美|西方/.test(name)) return 'us'
  if (/日本|日剧|日韩|韩国|韩剧|马泰|泰国/.test(name)) return 'jpkr'
  if (/香港|港剧|港台|邵氏/.test(name)) return 'hk'
  if (/台湾|台剧/.test(name)) return 'tw'
  if (/海外|其他/.test(name)) return 'other'
  return 'all'
}

function classifyCategory(name: string): { content: string; region: string } {
  const clean = String(name || '').replace(/\s+/g, '')
  return { content: contentTypeOf(clean) || 'other', region: regionOf(clean) }
}

function matchRegion(area: string, region: string): boolean {
  if (!region || region === 'all') return true
  const text = String(area || '')
  if (!text) return false
  return regionOf(text) === region
}

function normalizeTitle(name: string): string {
  return String(name || '')
    .replace(/\[[^\]]*\]|【[^】]*】|\([^)]*\)|（[^）]*）/g, '')
    .replace(/[\s·:：,，。.、!！?？-]/g, '')
    .toLowerCase()
}

function mergeFeed(results: { items: VodItem[]; content?: string }[]): VodItem[] {
  const seen = new Map<string, VodItem>()
  for (const result of results) {
    for (const item of result.items) {
      const key = `${normalizeTitle(item.name)}|${String(item.year || '').slice(0, 4)}`
      const tagged = {
        ...item,
        contentType: contentTypeOf(item.typeName) || result.content || ''
      }
      const existing = seen.get(key)
      if (!existing) {
        seen.set(key, tagged)
        continue
      }
      if (Number(item.score) > Number(existing.score)) seen.set(key, tagged)
    }
  }
  return [...seen.values()].sort((a, b) => (b.time || 0) - (a.time || 0))
}

async function getList(
  source: LocalSource,
  page = 1,
  type = '',
  area = ''
): Promise<VodListResult> {
  if (source.type === 'kanju') return kanjuList(source, page, type, area)
  const safePage = Math.max(1, Math.min(Number(page) || 1, 200))
  const key = `list:${source.id}:${safePage}:${type || 'all'}`
  const result = await cached<VodListResult>(key, LIST_TTL, async () => {
    let payload: Record<string, unknown>
    try {
      payload = await requestJson(source, { ac: 'detail', pg: safePage, t: type }, 6000)
      const first = normalizeList(payload, source)
      if (first.items.length || Number(payload?.code) === 1) return first
    } catch {
      /* try legacy endpoint below */
    }
    payload = await requestJson(source, { ac: 'videolist', pg: safePage, t: type }, 6000)
    return normalizeList(payload, source)
  })
  if (!result.items.length) cache.delete(key)
  return result
}

interface IndexEntry {
  sourceId: string
  categories: { id: string; name: string; content: string; region: string }[]
  error: string | null
}

async function buildIndex(sources: LocalSource[]): Promise<IndexEntry[]> {
  return mapLimit(sources, 8, async (source): Promise<IndexEntry> => {
    try {
      const categories = await getCategories(source)
      return {
        sourceId: source.id,
        categories: categories
          .filter((item) => !(adultFilterOn && isAdultContent(item.name)))
          .map((item) => ({ ...item, ...classifyCategory(item.name) })),
        error: null
      }
    } catch (error) {
      return {
        sourceId: source.id,
        categories: [],
        error: error instanceof Error ? error.message : `${source.name}: 分类接口无响应`
      }
    }
  })
}

export async function feed(
  content = '',
  region = 'all',
  sourceId = '',
  page = 1
): Promise<FeedResult> {
  const safePage = Math.max(1, Math.min(Number(page) || 1, MAX_PAGE))
  const picked = builtinSources().filter((item) => !sourceId || item.id === sourceId)
  // 用户显式选中的片源必须真的去请求；聚合模式才跳过刚失败的源，若全被跳过则整体再试一次
  const sources = sourceId ? picked : picked.filter((item) => !failedRecently(item.id))
  const usable = sources.length ? sources : picked
  const roster = sourceId ? usable : preferHealthy(usable, AGGREGATE_SOURCES)
  if (!roster.length) {
    return { items: [], page: safePage, pageCount: 1, total: 0, sources: 0, errors: [] }
  }
  const contentId = CONTENT_TYPES.some((item) => item.id === content) ? content : ''
  const regionId = REGIONS.some((item) => item.id === region) ? region : 'all'
  const key = `feed:${sourceId || 'all'}:${contentId || 'latest'}:${regionId}:${safePage}`
  const result = await cached<FeedResult>(key, FEED_TTL, async () => {
    const categoryErrors: { sourceId: string; message: string }[] = []
    let index = new Map<string, IndexEntry['categories']>()
    if (contentId || regionId !== 'all') {
      const entries = await buildIndex(roster)
      index = new Map(entries.map((item) => [item.sourceId, item.categories]))
      for (const entry of entries) {
        if (entry.error) categoryErrors.push({ sourceId: entry.sourceId, message: entry.error })
      }
    }

    const jobs: { source: LocalSource; type: string; area: string; content: string }[] = []
    for (const source of roster) {
      if (source.type === 'kanju') {
        jobs.push({
          source,
          type: contentId,
          area: regionId !== 'all' ? regionId : '',
          content: contentId
        })
        continue
      }
      if (!contentId && regionId === 'all') {
        jobs.push({ source, type: '', area: '', content: '' })
        continue
      }
      const categories = index.get(source.id) || []
      if (contentId === 'movie' && regionId !== 'all') {
        const movie =
          categories.find((item) => item.content === 'movie' && item.region === 'all') ||
          categories.find((item) => item.content === 'movie')
        if (movie) jobs.push({ source, type: movie.id, area: regionId, content: 'movie' })
        continue
      }
      const matches = categories.filter(
        (item) =>
          (!contentId || item.content === contentId) &&
          (regionId === 'all' || item.region === regionId)
      )
      let chosen: (typeof categories)[number] | undefined =
        matches.find((item) => item.content === contentId) || matches[0]
      let area = ''
      if (!chosen && contentId && regionId !== 'all') {
        chosen = categories.find((item) => item.content === contentId && item.region === 'all')
        area = regionId
      }
      if (chosen) jobs.push({ source, type: chosen.id, area, content: chosen.content })
    }

    if (!jobs.length) {
      return { items: [], page: safePage, pageCount: 1, total: 0, sources: 0, errors: categoryErrors }
    }

    const results = await mapLimit(jobs, 8, async (job) => {
      try {
        const result = await getList(job.source, safePage, job.type, job.area)
        const items = job.area
          ? result.items.filter((item) => matchRegion(item.area, job.area))
          : result.items
        return {
          sourceId: job.source.id,
          items,
          content: job.content,
          pageCount: job.area ? safePage + 1 : Math.max(1, result.pageCount || 1),
          error: null as string | null
        }
      } catch (error) {
        return {
          sourceId: job.source.id,
          items: [] as VodItem[],
          content: job.content,
          pageCount: 1,
          error: error instanceof Error ? error.message : '加载失败'
        }
      }
    })

    const items = mergeFeed(results)
    const pageCount = Math.min(
      MAX_PAGE,
      Math.max(1, ...results.map((item) => item.pageCount || 1))
    )
    return {
      items,
      page: safePage,
      pageCount,
      total: items.length,
      sources: results.filter((item) => !item.error).length,
      errors: [
        ...results
          .filter((item) => item.error)
          .map((item) => ({ sourceId: item.sourceId, message: item.error as string })),
        ...categoryErrors
      ]
    }
  })
  // 空结果不留在缓存里，否则「重试」会拿到同一个空列表
  if (!result.items.length) cache.delete(key)
  return result
}

export async function taxonomy(): Promise<Taxonomy> {
  const sources = builtinSources()
  return cached('taxonomy', TAXONOMY_TTL, async () => {
    const entries = await buildIndex(sources)
    const content = new Map(CONTENT_TYPES.map((item) => [item.id, 0]))
    const regions = new Map(REGIONS.map((item) => [item.id, 0]))
    for (const entry of entries) {
      const seenContent = new Set<string>()
      const seenRegion = new Set<string>()
      for (const item of entry.categories) {
        if (item.content !== 'other' && !seenContent.has(item.content)) {
          seenContent.add(item.content)
          content.set(item.content, (content.get(item.content) || 0) + 1)
        }
        if (item.region !== 'all' && !seenRegion.has(item.region)) {
          seenRegion.add(item.region)
          regions.set(item.region, (regions.get(item.region) || 0) + 1)
        }
      }
    }
    const contentSources: Record<string, string[]> = Object.fromEntries(
      CONTENT_TYPES.map((item) => [item.id, [] as string[]])
    )
    for (const entry of entries) {
      for (const type of CONTENT_TYPES) {
        if (entry.categories.some((item) => item.content === type.id)) {
          contentSources[type.id].push(entry.sourceId)
        }
      }
    }
    return {
      content: CONTENT_TYPES.map((item) => ({ ...item, sources: content.get(item.id) || 0 })),
      regions: REGIONS.map((item) => ({ ...item, sources: regions.get(item.id) || 0 })),
      contentSources,
      shortDramaSources: contentSources.short || []
    }
  })
}

async function searchOne(source: LocalSource, keyword: string): Promise<VodItem[]> {
  return cached(`search:${source.id}:${keyword}`, SEARCH_TTL, async () => {
    if (source.type === 'kanju') return kanjuSearch(source, keyword)
    let payload = await requestJson(source, { ac: 'detail', wd: keyword, pg: 1 })
    let result = normalizeList(payload, source)
    if (!result.items.length && Number(payload?.code) !== 1) {
      const firstMessage = String(payload?.msg || '')
      payload = await requestJson(source, { ac: 'videolist', wd: keyword, pg: 1 })
      result = normalizeList(payload, source)
      if (!result.items.length && Number(payload?.code) !== 1) {
        throw new Error(`${source.name}: ${String(payload?.msg || firstMessage || '接口不支持搜索')}`)
      }
    }
    return result.items
  })
}

export async function search(keyword: string, sourceIds: string[] = []): Promise<SearchResult> {
  const query = String(keyword || '').trim().slice(0, 60)
  if (!query) return { query, items: [], errors: [], took: 0 }
  const all = builtinSources()
  // 用户显式勾选的片源必须真的去搜；聚合模式才跳过临时失败的源，若全被跳过则整体再试一次
  const picked = sourceIds.length
    ? all.filter((source) => sourceIds.includes(source.id))
    : all.filter((source) => source.searchable !== false)
  const healthy = picked.filter((source) => !failedRecently(source.id))
  const allowed = healthy.length ? healthy : picked
  const started = Date.now()
  const results = await mapLimit(allowed, 8, async (source) => {
    try {
      return { sourceId: source.id, items: await searchOne(source, query), error: null as string | null }
    } catch (error) {
      return {
        sourceId: source.id,
        items: [] as VodItem[],
        error: error instanceof Error ? error.message : '搜索失败'
      }
    }
  })
  return {
    query,
    items: rankByRelevance(
      results.flatMap((result) => result.items),
      query
    ),
    errors: results
      .filter((result) => result.error)
      .map((item) => ({ sourceId: item.sourceId, message: item.error as string })),
    took: Date.now() - started
  }
}

function rankByRelevance(items: VodItem[], query: string): VodItem[] {
  return items
    .map((item) => ({ item, score: searchRelevance(item.name, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || (b.item.time || 0) - (a.item.time || 0))
    .map((entry) => entry.item)
}

export async function detail(sourceId: string, vodId: string): Promise<VodDetail> {
  const source = sourceById(sourceId)
  const id = String(vodId || '').trim()
  if (!id || id.length > 120) throw new Error('影片 ID 无效')
  if (source.type === 'kanju') return kanjuDetail(source, id)
  if (id.length > 40) throw new Error('影片 ID 无效')
  return cached(`detail:${source.id}:${id}`, DETAIL_TTL, async () => {
    const payload = await requestJson(source, { ac: 'detail', ids: id })
    const raw = Array.isArray(payload?.list) ? (payload.list[0] as Record<string, unknown>) : null
    if (!raw) throw new Error('影片不存在或已下架')
    const item = normalizeItem(raw, source)
    if (!item) throw new Error('影片不存在或已下架')
    const lines = parseLines(raw)
    return {
      ...item,
      content: cleanText(raw.vod_content, 3000),
      director: cleanText(raw.vod_director, 100),
      actors: cleanText(raw.vod_actor, 200),
      lines,
      playable: lines.length > 0
    }
  })
}

export async function categories(sourceId: string): Promise<{ sourceId: string; categories: Category[] }> {
  const source = sourceById(sourceId)
  return { sourceId, categories: await getCategories(source) }
}

export async function list(sourceId: string, page: number, type = ''): Promise<VodListResult> {
  return getList(sourceById(sourceId), page, type)
}

export function clearCache() {
  cache.clear()
  failures.clear()
  saveFailures()
}

export interface SourceProbe {
  ok: boolean
  ms: number
  detail: string
}

function probeText(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    const match = text.match(/^[\s\w.]*\((.*)\)\s*;?\s*$/s)
    if (!match) return null
    try {
      return JSON.parse(match[1]) as Record<string, unknown>
    } catch {
      return null
    }
  }
}

async function fetchProbe(
  url: string,
  timeout: number,
  headers: Record<string, string> = { accept: 'application/json, text/plain, */*' }
): Promise<{ ok: boolean; status: number; text: string }> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(url, {
      headers,
      referrerPolicy: 'no-referrer',
      signal: controller.signal
    })
    const text = await response.text()
    return { ok: response.ok, status: response.status, text }
  } finally {
    window.clearTimeout(timer)
  }
}

function probeFailure(caught: unknown): string {
  if (caught instanceof Error) {
    if (caught.name === 'AbortError') return '请求超时'
    const message = caught.message.replace(/^.*?:\s*/, '')
    if (/Failed to fetch|NetworkError|load failed/i.test(message)) return 'CORS/网络不可达'
    return message || '无法访问'
  }
  return '无法访问'
}

export async function probeVodSource(id: string): Promise<SourceProbe> {
  const builtin = BUILTIN_VOD.find((item) => item.id === id)
  const custom = builtin ? null : findCustomVod(id)
  if (!builtin && !custom) return { ok: false, ms: 0, detail: '源不存在' }
  const source = builtin
    ? { id: builtin.id, name: builtin.name, api: builtin.api, type: builtin.type }
    : { id: custom!.id, name: custom!.name, api: String(custom!.api || ''), type: custom!.type || 'maccms' }
  const started = performance.now()
  try {
    if (source.type === 'kanju') {
      const path = '/v1/browse/catalog?page=1&limit=1'
      const modes: ('proxy' | 'direct')[] = []
      if (kanjuProxyBase) modes.push('proxy')
      if (KANJU_SECRET) modes.push('direct')
      if (!modes.length) {
        return {
          ok: false,
          ms: Math.round(performance.now() - started),
          detail: '云端未启用代签，本机构建也没有内置密钥'
        }
      }
      let detail = '无法访问'
      for (const mode of modes) {
        const attempt = await kanjuAttempt(source, path, mode === 'proxy' ? 9000 : 12000, 'GET', undefined, mode)
        if (!attempt.payload) {
          detail = attempt.error || detail
          continue
        }
        const cards = Array.isArray(attempt.payload.cards) ? attempt.payload.cards.length : 0
        return {
          ok: true,
          ms: Math.round(performance.now() - started),
          detail: `云端代签正常${cards ? ' · 含官方高清/4K 线路' : ''}`
        }
      }
      return {
        ok: false,
        ms: Math.round(performance.now() - started),
        detail: modes.length > 1 ? `${detail}（云端与直连都失败）` : detail
      }
    }
    const url = new URL(source.api)
    url.searchParams.set('ac', 'list')
    url.searchParams.set('pg', '1')
    const response = await fetchProbe(url.href, 12000)
    if (!response.ok) {
      return { ok: false, ms: Math.round(performance.now() - started), detail: `HTTP ${response.status}` }
    }
    const payload = probeText(response.text)
    if (!payload) {
      return { ok: false, ms: Math.round(performance.now() - started), detail: '返回内容不是 JSON' }
    }
    const total = Number(payload.total) || 0
    const list = Array.isArray(payload.list) ? payload.list.length : 0
    if (!total && !list) {
      return { ok: false, ms: Math.round(performance.now() - started), detail: '接口无数据' }
    }
    return {
      ok: true,
      ms: Math.round(performance.now() - started),
      detail: total ? `${total.toLocaleString('zh-CN')} 条资源` : `${list} 条资源`
    }
  } catch (caught) {
    return { ok: false, ms: Math.round(performance.now() - started), detail: probeFailure(caught) }
  }
}

export async function probeLiveSource(id: string): Promise<SourceProbe> {
  const builtin = BUILTIN_LIVE.find((item) => item.id === id)
  const custom = builtin ? null : findCustomLive(id)
  if (!builtin && !custom) return { ok: false, ms: 0, detail: '源不存在' }
  const url = builtin ? builtin.url : String(custom!.url || '')
  const started = performance.now()
  try {
    const response = await fetchProbe(url, 15000)
    if (!response.ok) {
      return { ok: false, ms: Math.round(performance.now() - started), detail: `HTTP ${response.status}` }
    }
    const extinf = (response.text.match(/#EXTINF/g) || []).length
    const lines = response.text
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith('#') && /https?:\/\//.test(line)).length
    const count = Math.max(extinf, lines)
    if (!count) {
      return { ok: false, ms: Math.round(performance.now() - started), detail: '未解析到频道' }
    }
    return {
      ok: true,
      ms: Math.round(performance.now() - started),
      detail: `${count.toLocaleString('zh-CN')} 个频道`
    }
  } catch (caught) {
    return { ok: false, ms: Math.round(performance.now() - started), detail: probeFailure(caught) }
  }
}

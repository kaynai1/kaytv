import { reactive, ref } from 'vue'

/* TMDB 密钥由构建期注入（VITE_TMDB_API_KEY），缺失时自动回落到片源自带海报 */
const TMDB_API_KEY = (import.meta.env.VITE_TMDB_API_KEY as string | undefined) || ''
/* api.themoviedb.org 与 image.tmdb.org 在国内常被 SNI 干扰，优先用官方备用域名与同源的 BunnyCDN 边缘节点 */
const API_HOSTS = ['https://api.tmdb.org/3', 'https://api.themoviedb.org/3']
const IMG_HOSTS = ['https://tmdb-image-prod.b-cdn.net/t/p', 'https://image.tmdb.org/t/p']
const CACHE_KEY = 'kaytv.tmdb.v1'
const MISS_TTL = 12 * 3600 * 1000
const MAX_PARALLEL = 6
const REQUEST_TIMEOUT = 9000
/* localStorage 配额约 5MB，缓存不设上限会写满并连带把收藏/历史一起卡死 */
const MAX_ENTRIES = 900

export type TmdbArt = { id: number; poster: string; backdrop: string }

type CacheEntry = { art: TmdbArt | null; at: number }

function loadCache(): Record<string, CacheEntry> {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') as Record<string, CacheEntry>
  } catch {
    return {}
  }
}

const cache: Record<string, CacheEntry> = loadCache()
let apiHostIndex = 0
let lastApiFailure = 0
const imgHost = ref(IMG_HOSTS[0])
let imgHostSwapped = false
let imgBadCount = 0
let saveTimer = 0

function pruneCache() {
  const keys = Object.keys(cache)
  if (keys.length <= MAX_ENTRIES) return
  keys
    .sort((a, b) => (cache[b]?.at || 0) - (cache[a]?.at || 0))
    .slice(MAX_ENTRIES)
    .forEach((key) => delete cache[key])
}

function saveCache() {
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    pruneCache()
    const write = () => localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
    try {
      write()
    } catch {
      /* 配额满时丢掉一半最旧的再试一次，避免整个持久层被卡住 */
      Object.keys(cache)
        .sort((a, b) => (cache[b]?.at || 0) - (cache[a]?.at || 0))
        .slice(Math.floor(MAX_ENTRIES / 2))
        .forEach((key) => delete cache[key])
      try {
        write()
      } catch {
        /* 仍然写不进就放弃本次缓存，不影响播放 */
      }
    }
  }, 800)
}

/** key -> 已确认的 TMDB 素材（null 表示查过但没有） */
export const tmdbArts = reactive<Record<string, TmdbArt | null>>({})

export function tmdbKey(name: string, year = ''): string {
  return `${name.trim().toLowerCase()}|${year || ''}`
}

let running = 0
const queue: Array<() => void> = []

function dequeue() {
  running -= 1
  const next = queue.shift()
  if (next) next()
}

function limited<T>(run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      running += 1
      run().then(
        (value) => {
          dequeue()
          resolve(value)
        },
        (error) => {
          dequeue()
          reject(error)
        }
      )
    }
    if (running < MAX_PARALLEL) start()
    else queue.push(start)
  })
}

function norm(text: string): string {
  return (text || '').toLowerCase().replace(/[\s·:：,，.!！'’"“”\-—_]/g, '')
}

type TmdbResult = {
  id: number
  media_type?: string
  title?: string
  name?: string
  original_title?: string
  original_name?: string
  release_date?: string
  first_air_date?: string
  poster_path?: string | null
  backdrop_path?: string | null
}

async function fetchJson(path: string): Promise<{ results?: TmdbResult[] }> {
  if (Date.now() - lastApiFailure < 60000) throw new Error('tmdb 暂时不可用')
  let lastError: unknown
  for (let offset = 0; offset < API_HOSTS.length; offset += 1) {
    const index = (apiHostIndex + offset) % API_HOSTS.length
    try {
      const res = await fetch(`${API_HOSTS[index]}${path}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT) })
      if (!res.ok) throw new Error(`tmdb ${res.status}`)
      apiHostIndex = index
      return (await res.json()) as { results?: TmdbResult[] }
    } catch (error) {
      lastError = error
    }
  }
  lastApiFailure = Date.now()
  throw lastError instanceof Error ? lastError : new Error('tmdb 无法访问')
}

/** 片源标题常带“_综艺 / 第二季 / 2026”这类后缀，逐个去后缀再试，提高匹配率 */
function queryCandidates(name: string): string[] {
  const raw = name.trim()
  const noSuffix = raw
    .replace(/[_\-|·,\s]*(综艺|短剧|电影|电视剧|动漫|纪录片|港台剧|国产剧|日韩剧|欧美剧)+$/g, '')
    .replace(/\s*第\s*[0-9一二三四五六七八九十百]+\s*[季集部篇].*$/g, '')
    .trim()
  const noYear = noSuffix.replace(/\s*(?:19|20)\d{2}$/, '').trim()
  return Array.from(new Set([raw, noSuffix, noYear].filter((value) => value.length > 1)))
}

async function searchArt(name: string, year: string, type: string): Promise<TmdbArt | null> {
  const wantMovie = type === 'movie'
  const yearOf = (item: TmdbResult) => String(item.release_date || item.first_air_date || '').slice(0, 4)
  for (const candidate of queryCandidates(name)) {
    const json = await fetchJson(
      `/search/multi?language=zh-CN&include_adult=false&api_key=${TMDB_API_KEY}&query=${encodeURIComponent(candidate)}`
    )
    const results = json.results || []
    const pool = results.filter((item) =>
      wantMovie ? item.media_type === 'movie' : item.media_type === 'tv' || item.media_type === 'movie'
    )
    const target = norm(candidate)
    const titlesOf = (item: TmdbResult) => [item.title, item.name, item.original_title, item.original_name]
    const exact = (item: TmdbResult) => titlesOf(item).some((title) => norm(title || '') === target)
    const close = (item: TmdbResult) =>
      titlesOf(item).some((title) => {
        const value = norm(title || '')
        return value.length > 1 && (target.includes(value) || value.includes(target))
      })
    const pick =
      pool.find((item) => exact(item) && (!year || yearOf(item) === year)) ||
      pool.find((item) => exact(item)) ||
      pool.find((item) => close(item) && (!year || yearOf(item) === year)) ||
      pool.find((item) => close(item)) ||
      null
    if (pick) return { id: pick.id, poster: pick.poster_path || '', backdrop: pick.backdrop_path || '' }
  }
  return null
}

/** 触发一次查询（带缓存与并发限制），结果写入 tmdbArts */
export function tmdbEnsure(name: string, year = '', type = ''): void {
  if (!TMDB_API_KEY || !name) return
  const key = tmdbKey(name, year)
  if (key in tmdbArts) return
  const hit = cache[key]
  if (hit && (hit.art !== null || Date.now() - hit.at < MISS_TTL)) {
    tmdbArts[key] = hit.art
    return
  }
  tmdbArts[key] = null
  void limited(() => searchArt(name, year, type))
    .then((art) => {
      tmdbArts[key] = art
      cache[key] = { art, at: Date.now() }
      saveCache()
    })
    .catch(() => {
      /* 网络不通保持 null，界面回落片源图 */
    })
}

export function tmdbPosterUrl(art: TmdbArt | null | undefined, size = 'w500'): string {
  return art?.poster ? `${imgHost.value}/${size}${art.poster}` : ''
}

export function tmdbBackdropUrl(art: TmdbArt | null | undefined, size = 'w1280'): string {
  return art?.backdrop ? `${imgHost.value}/${size}${art.backdrop}` : ''
}

/** 图片域名不可用时整体切到备用域名；个别 404 不触发，连续失败 3 次才切换 */
export function tmdbSwapImageHost(url: string): string {
  if (!url.startsWith(imgHost.value)) return ''
  imgBadCount += 1
  if (imgHostSwapped || imgBadCount < 3) return ''
  const next = IMG_HOSTS.find((host) => host !== imgHost.value)
  if (!next) return ''
  imgHostSwapped = true
  const alt = url.replace(imgHost.value, next)
  imgHost.value = next
  return alt
}

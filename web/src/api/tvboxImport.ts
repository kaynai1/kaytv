import { customId, hasCustomUrl } from './customSources'

export interface ImportCandidate {
  id: string
  kind: 'live' | 'vod'
  name: string
  url: string
  type: 'auto' | 'm3u' | 'txt' | 'maccms'
  note: string
  active: boolean
}

export interface ImportResult {
  label: string
  live: ImportCandidate[]
  vod: ImportCandidate[]
}

const FETCH_TIMEOUT = 14000
const MAX_BODY = 3 * 1024 * 1024
const MAX_LIVE_CANDIDATES = 16
const MAX_VOD_CANDIDATES = 24
const MAX_CHILD_CONFIGS = 10
const MAX_DEPTH = 2

const LIVE_PATH_RE = /\.(?:m3u8?|txt)(?:[?#]|$)|(?:^|\/)(?:live|tv)\/?(?:[?#]|$)/i
const PLAYLIST_SUFFIX_RE = /\.(m3u8?|txt)(?:[?#]|$)/i

function looksLikePlaylistText(text: string): boolean {
  const head = text.slice(0, 2000)
  return /#EXTM3U|#EXTINF|#genre#/i.test(head)
}

function githubMirror(url: string): string {
  if (!/^https?:\/\/(?:raw\.githubusercontent\.com|github\.com)\/.*\/raw\//.test(url) &&
      !/^https?:\/\/raw\.githubusercontent\.com\//.test(url)) return url
  const withoutProxy = url.replace(/^https?:\/\/(?:gh-proxy\.com|ghp\.city|ghproxy\.net|mirror\.ghproxy\.net)\//i, '')
  return `https://gh-proxy.com/${withoutProxy}`
}

function isInternal(raw: string): boolean {
  if (!raw) return true
  if (/^(proxy|js|file):/i.test(raw)) return true
  const host = raw.replace(/^https?:\/\//, '').split('/')[0]
  if (/^(127\.|0\.0\.0\.0|localhost|\[::1\])/i.test(host)) return true
  if (/^192\.168\./.test(host)) return true
  if (/^10\./.test(host)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true
  return false
}

async function fetchText(url: string, timeout = FETCH_TIMEOUT): Promise<string> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(url, {
      headers: { accept: 'text/plain, application/json, */*' },
      referrerPolicy: 'no-referrer',
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const text = await response.text()
    if (text.length > MAX_BODY) throw new Error('内容过大')
    return text
  } finally {
    window.clearTimeout(timer)
  }
}

function parseTolerantJson(text: string): Record<string, unknown> | null {
  let body = text.replace(/^\uFEFF/, '').trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start >= 0 && end > start) {
    body = body.slice(start, end + 1)
    try {
      return JSON.parse(body) as Record<string, unknown>
    } catch {
      /* continue */
    }
    const cleaned = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/,(\s*[}\]])/g, '$1')
    try {
      return JSON.parse(cleaned) as Record<string, unknown>
    } catch {
      /* continue */
    }
    try {
      return JSON.parse(stripCommentsOutsideStrings(cleaned)) as Record<string, unknown>
    } catch {
      /* fall through */
    }
  }
  return parseJsonAtBraces(text) || parseBase64Json(text)
}

function stripCommentsOutsideStrings(text: string): string {
  let out = ''
  let inString = false
  let inEscape = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      out += char
      if (inEscape) inEscape = false
      else if (char === '\\') inEscape = true
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

function parseJsonAtBraces(text: string): Record<string, unknown> | null {
  let from = 0
  for (let attempt = 0; attempt < 8; attempt++) {
    const start = text.indexOf('{', from)
    if (start < 0) return null
    const candidate = text.slice(start)
    for (const variant of [candidate, candidate.replace(/,(\s*[}\]])/g, '$1'), stripCommentsOutsideStrings(candidate)]) {
      try {
        const parsed = JSON.parse(variant) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
      } catch {
        /* next variant */
      }
    }
    from = start + 1
  }
  return null
}

function decodeBase64ToText(value: string): string {
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    return new TextDecoder('utf-8').decode(bytes)
  } catch {
    return ''
  }
}

function parseBase64Json(text: string): Record<string, unknown> | null {
  const matches = text.match(/[A-Za-z0-9+/][A-Za-z0-9+/\r\n]{180,}={0,2}/g)
  if (!matches) return null
  const sorted = [...matches].sort((a, b) => b.length - a.length).slice(0, 3)
  for (const match of sorted) {
    const compact = match.replace(/[\r\n]/g, '')
    const decoded = decodeBase64ToText(compact)
    if (!decoded.includes('{')) continue
    const parsed = parseJsonAtBraces(decoded) || tryPlainJson(decoded)
    if (parsed) return parsed
  }
  return null
}

function tryPlainJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function looksLikePlaylist(raw: string): boolean {
  return LIVE_PATH_RE.test(raw)
}

function playlistType(raw: string): 'auto' | 'm3u' | 'txt' {
  const match = PLAYLIST_SUFFIX_RE.exec(raw)
  if (!match) return 'auto'
  return match[1].toLowerCase().startsWith('m3u') ? 'm3u' : 'txt'
}

function normalizeVodApi(raw: string, base: string): string {
  let api = raw.trim()
  if (!api) return ''
  try {
    api = new URL(api, base).href
  } catch {
    return ''
  }
  if (/provide\/vod/i.test(api)) return api
  if (/\/\w*\.php$/i.test(api)) return `${api.replace(/\/\w*\.php$/i, '')}/provide/vod`
  if (/\/api\.php\/?$/i.test(api)) return `${api.replace(/\/?$/, '')}/provide/vod`
  return api.replace(/\/+$/, '')
}

function candidate(
  kind: 'live' | 'vod',
  name: string,
  url: string,
  type: 'auto' | 'm3u' | 'txt' | 'maccms',
  note: string,
  active: boolean
): ImportCandidate {
  return { id: customId(kind, url), kind, name: name.slice(0, 40), url, type, note, active }
}

function takeLive(list: ImportCandidate[], name: string, rawUrl: string, base: string, note: string): void {
  if (!rawUrl || isInternal(rawUrl) || /^(proxy|js):/i.test(rawUrl)) return
  let url = ''
  try {
    url = new URL(rawUrl, base).href
  } catch {
    return
  }
  if (!/^https?:\/\//i.test(url)) return
  if (list.some((item) => item.url === url)) return
  const label = name || `直播 ${list.length + 1}`
  const exists = hasCustomUrl('live', url)
  list.push(
    candidate('live', label, url, playlistType(url), exists ? '已添加过' : note, !exists && list.length < MAX_LIVE_CANDIDATES)
  )
}

function takeVod(list: ImportCandidate[], name: string, rawApi: string, base: string, note: string): void {
  if (!rawApi || isInternal(rawApi) || /^(proxy|js):/i.test(rawApi)) return
  const api = normalizeVodApi(rawApi, base)
  if (!/^https?:\/\//i.test(api)) return
  if (list.some((item) => item.url === api)) return
  const label = name || `影视 ${list.length + 1}`
  const exists = hasCustomUrl('vod', api)
  list.push(candidate('vod', label, api, 'maccms', exists ? '已添加过' : note, !exists && list.length < MAX_VOD_CANDIDATES))
}

function readArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
}

function str(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim()
}

function collectFromConfig(
  config: Record<string, unknown>,
  base: string,
  label: string,
  live: ImportCandidate[],
  vod: ImportCandidate[]
): void {
  for (const item of readArray(config.lives)) {
    const name = str(item.name)
    const url = str(item.url)
    if (url) {
      takeLive(live, name, url, base, label)
      continue
    }
    for (const channel of readArray(item.channels)) {
      const channelUrls = Array.isArray(channel.urls) ? channel.urls : []
      const first = str(channelUrls[0])
      if (first && /^https?:\/\//i.test(first)) takeLive(live, str(channel.name), first, base, label)
    }
  }
  for (const item of readArray(config.sites)) {
    if (Number(item.type) !== 1) continue
    takeVod(vod, str(item.name), str(item.api), base, label)
  }
}

async function expandChild(
  rawUrl: string,
  name: string,
  baseForResolve: string,
  live: ImportCandidate[],
  vod: ImportCandidate[],
  depth: number
): Promise<void> {
  let url = ''
  try {
    url = githubMirror(new URL(rawUrl, baseForResolve).href)
  } catch {
    return
  }
  if (isInternal(url)) return
  const label = name || url.split('/').pop() || '订阅'
  let text: string
  try {
    text = await fetchText(url)
  } catch {
    return
  }
  const playlistMatch = PLAYLIST_SUFFIX_RE.exec(url.split('?')[0])
  if (playlistMatch) {
    if (looksLikePlaylistText(text)) takeLive(live, label, url, url, `来自 ${label}`)
    return
  }
  const json = parseTolerantJson(text)
  if (!json) {
    if (looksLikePlaylistText(text)) takeLive(live, label, url, url, `来自 ${label}`)
    return
  }
  if (depth < MAX_DEPTH && Array.isArray(json.urls) && json.urls.length && !json.lives && !json.sites) {
    const children = readArray(json.urls).slice(0, MAX_CHILD_CONFIGS)
    await Promise.all(
      children.map((child) => expandChild(str(child.url), str(child.name), url, live, vod, depth + 1))
    )
    return
  }
  const beforeLive = live.length
  const beforeVod = vod.length
  collectFromConfig(json, url, `来自 ${label}`, live, vod)
  if (live.length === beforeLive && vod.length === beforeVod && looksLikePlaylistText(text)) {
    takeLive(live, label, url, url, `来自 ${label}`)
  }
}

export async function importTvboxSource(rawInput: string): Promise<ImportResult> {
  const input = String(rawInput || '').trim()
  if (!/^https?:\/\//i.test(input)) throw new Error('请输入 http(s) 接口地址')
  const url = githubMirror(input)
  const fileName = url.split('/').pop()?.split('?')[0] || '自定义源'
  const live: ImportCandidate[] = []
  const vod: ImportCandidate[] = []

  const text = await fetchText(url)

  if (looksLikePlaylist(url)) {
    const label = fileName.replace(/\.(m3u8?|txt)$/i, '')
    if (looksLikePlaylistText(text)) takeLive(live, label, url, url, '手动添加的直播列表')
    else throw new Error('该地址没有返回可解析的直播列表内容')
    return { label, live, vod }
  }

  const json = parseTolerantJson(text)
  if (!json) {
    if (looksLikePlaylistText(text)) {
      takeLive(live, fileName, url, url, '直播列表')
      return { label: fileName, live, vod }
    }
    if (/\.php|provide\/vod/i.test(url)) {
      const api = normalizeVodApi(url, url)
      takeVod(vod, fileName, api, url, '采集接口')
      if (!vod.length) throw new Error('无法识别该接口内容')
      return { label: fileName, live, vod }
    }
    throw new Error('无法识别：既不是 TVBox 配置/订阅，也不是直播列表或采集接口')
  }

  const label = str(json.name) || str(json.title) || fileName
  if (Array.isArray(json.urls) && json.urls.length && !json.lives && !json.sites) {
    const children = readArray(json.urls).slice(0, MAX_CHILD_CONFIGS)
    await Promise.all(children.map((child) => expandChild(str(child.url), str(child.name), url, live, vod, 1)))
    return { label, live, vod }
  }
  collectFromConfig(json, url, 'TVBox 配置', live, vod)
  if (!live.length && !vod.length) {
    if (Array.isArray(json.spider) || str(json.spider)) throw new Error('该配置只有爬虫，没有可用的直播/采集接口')
    throw new Error('配置里没有解析到直播源或采集接口')
  }
  return { label, live, vod }
}

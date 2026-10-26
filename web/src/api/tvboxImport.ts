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
  skipped: number
}

interface ImportStats {
  skipped: number
}

const FETCH_TIMEOUT = 14000
const MAX_BODY = 3 * 1024 * 1024
const MAX_LIVE_CANDIDATES = 16
const MAX_VOD_CANDIDATES = 24
const MAX_CHILD_CONFIGS = 10
const MAX_DEPTH = 2

const LIVE_PATH_RE = /\.(?:m3u8?|txt)(?:[?#]|$)|(?:^|\/)(?:live|tv)\/?(?:[?#]|$)/i
const PLAYLIST_SUFFIX_RE = /\.(m3u8?|txt)(?:[?#]|$)/i
const PLUGIN_PATH_RE = /\.(?:js|js\.md5|md5)$/i
const MD5_ONLY_RE = /^[a-f0-9]{32}$/i
const PLUGIN_BODY_RE = /module\.exports|globalThis\.__filename|js2p:\/\//i

const PLUGIN_HINT = '这是 XPTV/TVBox 的 JS 插件（或它的 .md5 版本文件），需要专用运行环境，KayTV 无法直接加载；请改填它的 TVBox 配置 JSON、m3u/txt 直播列表或苹果CMS 采集接口'

function looksLikePlaylistText(text: string): boolean {
  const head = text.slice(0, 2000)
  return /#EXTM3U|#EXTINF|#genre#/i.test(head)
}

function isPluginUrl(raw: string): boolean {
  if (/^js2p:/i.test(raw)) return true
  let pathname = raw
  try {
    pathname = new URL(raw).pathname
  } catch {
    /* 原样匹配 */
  }
  return PLUGIN_PATH_RE.test(pathname)
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
  const body = text.replace(/^\uFEFF/, '').trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start >= 0 && end > start) {
    const parsed = tryParseObject(body.slice(start, end + 1))
    if (parsed) return parsed
  }
  return parseJsonAtBraces(text) || parseBase64Json(text)
}

function tryParseObject(text: string): Record<string, unknown> | null {
  const noComments = stripCommentsOutsideStrings(text)
  const variants = [
    text,
    text.replace(/,(\s*[}\]])/g, '$1'),
    noComments,
    noComments.replace(/,(\s*[}\]])/g, '$1'),
    escapeControlCharsInStrings(text),
    escapeControlCharsInStrings(noComments),
    escapeControlCharsInStrings(noComments).replace(/,(\s*[}\]])/g, '$1')
  ]
  for (const variant of variants) {
    try {
      const parsed = JSON.parse(variant) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      /* 下一个写法 */
    }
  }
  return null
}

/** TVBox 配置里常见字符串内直接换行，严格 JSON 会报控制字符 */
function escapeControlCharsInStrings(text: string): string {
  let out = ''
  let inString = false
  let inEscape = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (!inString) {
      if (char === '"') inString = true
      out += char
      continue
    }
    if (inEscape) {
      out += char
      inEscape = false
      continue
    }
    if (char === '\\') {
      out += char
      inEscape = true
      continue
    }
    if (char === '"') {
      inString = false
      out += char
      continue
    }
    const code = char.charCodeAt(0)
    if (code < 0x20) {
      if (char === '\n') out += '\\n'
      else if (char === '\r') out += '\\r'
      else if (char === '\t') out += '\\t'
      else out += ' '
      continue
    }
    out += char
  }
  return out
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
    const parsed = tryParseObject(text.slice(start))
    if (parsed) return parsed
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
    const parsed = parseJsonAtBraces(decoded) || tryParseObject(decoded)
    if (parsed) return parsed
  }
  return null
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
  vod: ImportCandidate[],
  stats: ImportStats
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
    if (Number(item.type) !== 1) {
      if (str(item.api) || str(item.name)) stats.skipped++
      continue
    }
    takeVod(vod, str(item.name), str(item.api), base, label)
  }
}

async function expandChild(
  rawUrl: string,
  name: string,
  baseForResolve: string,
  live: ImportCandidate[],
  vod: ImportCandidate[],
  stats: ImportStats,
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
  if (looksLikePlaylistText(text)) {
    takeLive(live, label, url, url, `来自 ${label}`)
    return
  }
  const json = parseTolerantJson(text)
  if (!json) return
  if (depth < MAX_DEPTH && Array.isArray(json.urls) && json.urls.length && !json.lives && !json.sites) {
    const children = readArray(json.urls).slice(0, MAX_CHILD_CONFIGS)
    await Promise.all(
      children.map((child) => expandChild(str(child.url), str(child.name), url, live, vod, stats, depth + 1))
    )
    return
  }
  collectFromConfig(json, url, `来自 ${label}`, live, vod, stats)
}

export async function importTvboxSource(rawInput: string): Promise<ImportResult> {
  const input = String(rawInput || '').trim()
  if (isPluginUrl(input)) throw new Error(PLUGIN_HINT)
  if (!/^https?:\/\//i.test(input)) throw new Error('请输入 http(s) 接口地址')
  const url = githubMirror(input)
  const fileName = url.split('/').pop()?.split('?')[0] || '自定义源'
  const live: ImportCandidate[] = []
  const vod: ImportCandidate[] = []
  const stats: ImportStats = { skipped: 0 }

  const text = await fetchText(url)
  const trimmed = text.trim()
  if (MD5_ONLY_RE.test(trimmed)) {
    throw new Error('该地址只返回一个 MD5 校验值，是插件/订阅的版本文件，不是可用的源；请填真正的配置或接口地址')
  }
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[') && !looksLikePlaylistText(text) && PLUGIN_BODY_RE.test(text.slice(0, 4000))) {
    throw new Error(PLUGIN_HINT)
  }

  if (looksLikePlaylist(url)) {
    const label = fileName.replace(/\.(m3u8?|txt)$/i, '')
    if (looksLikePlaylistText(text)) {
      takeLive(live, label, url, url, '手动添加的直播列表')
      return { label, live, vod, skipped: 0 }
    }
    // 路径像直播表但内容是配置（例如饭太硬的 /tv），继续按 TVBox 配置解析
  }

  const json = parseTolerantJson(text)
  if (!json) {
    if (looksLikePlaylistText(text)) {
      takeLive(live, fileName, url, url, '直播列表')
      return { label: fileName, live, vod, skipped: 0 }
    }
    if (/api\.php|provide\/vod/i.test(url)) {
      const api = normalizeVodApi(url, url)
      takeVod(vod, fileName, api, url, '采集接口')
      if (!vod.length) throw new Error('无法识别该接口内容')
      return { label: fileName, live, vod, skipped: 0 }
    }
    if (looksLikePlaylist(url)) throw new Error('该地址没有返回可解析的直播列表内容')
    throw new Error('无法识别：既不是 TVBox 配置/订阅，也不是直播列表或采集接口')
  }

  const label = str(json.name) || str(json.title) || fileName
  if (Array.isArray(json.urls) && json.urls.length && !json.lives && !json.sites) {
    const children = readArray(json.urls).slice(0, MAX_CHILD_CONFIGS)
    await Promise.all(children.map((child) => expandChild(str(child.url), str(child.name), url, live, vod, stats, 1)))
    return { label, live, vod, skipped: stats.skipped }
  }
  collectFromConfig(json, url, 'TVBox 配置', live, vod, stats)
  if (!live.length && !vod.length) {
    if (stats.skipped) throw new Error(`该配置有 ${stats.skipped} 个爬虫/JS 站点，需要 TVBox 内核，KayTV 无法直接播放`)
    if (Array.isArray(json.spider) || str(json.spider)) throw new Error('该配置只有爬虫，没有可用的直播/采集接口')
    throw new Error('配置里没有解析到直播源或采集接口')
  }
  return { label, live, vod, skipped: stats.skipped }
}

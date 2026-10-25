import { apiUrl, runtime } from './runtime'

export interface EpgProgram {
  title: string
  start: number
  end: number
}

export interface EpgData {
  programs: EpgProgram[]
  provider: 'cntv' | 'diyp' | 'none'
  channelName: string
}

interface CacheEntry {
  at: number
  data: EpgData
}

const CNTV_BASE = 'https://api.cntv.cn/epg/epginfo'
const DIYP_BASE = 'http://epg.51zmt.top:8000/api/diyp/'
const TTL = 10 * 60 * 1000
const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<EpgData>>()

const SATELLITE: [RegExp, string][] = [
  [/北京/, 'btv1'],
  [/湖南/, 'hunan'],
  [/浙江/, 'zhejiang'],
  [/江苏/, 'jiangsu'],
  [/东方|上海/, 'dongfang'],
  [/广东|珠江/, 'guangdong'],
  [/深圳/, 'shenzhen'],
  [/山东/, 'shandong'],
  [/湖北/, 'hubei'],
  [/四川/, 'sichuan'],
  [/安徽/, 'anhui'],
  [/黑龙江/, 'heilongjiang'],
  [/贵州/, 'guizhou'],
  [/云南/, 'yunnan'],
  [/天津/, 'tianjin'],
  [/辽宁/, 'liaoning'],
  [/吉林/, 'jilin'],
  [/河北/, 'hebei'],
  [/青海/, 'qinghai'],
  [/甘肃/, 'gansu'],
  [/宁夏/, 'ningxia'],
  [/新疆/, 'xinjiang'],
  [/重庆/, 'chongqing'],
  [/河南/, 'henan'],
  [/江西/, 'jiangxi'],
  [/广西/, 'guangxi'],
  [/内蒙/, 'neimenggu'],
  [/西藏/, 'xizang'],
  [/陕西/, 'shan3xi'],
  [/兵团/, 'btv1']
]

const CCTV_NAMED: [RegExp, string][] = [
  [/5\s*\+/i, 'cctv5plus'],
  [/纪录|记录/, 'cctvjilu'],
  [/少儿|卡通|动画/, 'cctvchild'],
  [/奥林匹克|奥运/, 'cctv16'],
  [/农村|农业/, 'cctv17'],
  [/新闻/, 'cctv13'],
  [/体育/, 'cctv5'],
  [/电影/, 'cctv6'],
  [/戏曲/, 'cctv11'],
  [/社会与法|法治/, 'cctv12'],
  [/军事|国防/, 'cctv7'],
  [/中文国际|国际/, 'cctv4'],
  [/精品|综合/, '']
]

export function todayKey(date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

function compact(name: string): string {
  return name
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/\s+/g, '')
    .replace(/高清|标清|超清|蓝光|完整版|超时移|备用|副本/g, '')
    .replace(/HD|SD|FPS\d+|\d+帧/gi, '')
    .toUpperCase()
}

/** CCTV / 卫视频道名 → 央视官方 EPG 频道代码；无法映射时返回空串 */
export function cntvCode(name: string): string {
  const value = compact(name)
  if (!value) return ''
  if (/CCTV.*8\s*K/.test(value)) return 'cctv8k'
  if (/CCTV.*4\s*K/.test(value)) return 'cctv4k'
  const numbered = value.match(/^(?:CCTV|CCTV[-]?)\s?(\d{1,2})/) || value.match(/^C(\d{1,2})/)
  if (numbered) {
    const digits = numbered[1]
    for (const [pattern, code] of CCTV_NAMED) {
      if (code && pattern.test(value)) return code
    }
    if (value.includes('+')) return `cctv${digits}plus`
    return `cctv${Number(digits)}`
  }
  if (/^CCTV/.test(value) || /^CCTV/i.test(value)) {
    for (const [pattern, code] of CCTV_NAMED) {
      if (code && pattern.test(value)) return code
    }
  }
  for (const [pattern, code] of SATELLITE) {
    if (pattern.test(value)) return code
  }
  return ''
}

/** 频道名 → 老张 EPG 需要的 ch 参数（CCTV 不能带连字符） */
export function diypName(name: string): string {
  const value = compact(name)
  const numbered = value.match(/^(?:CCTV)[- ]?(\d{1,2})(.*)$/)
  if (numbered) {
    const digits = numbered[1]
    const tail = numbered[2] || ''
    if (tail.includes('+') || /5\s*\+/.test(value)) return `CCTV${digits}+`
    if (/纪录|记录/.test(tail)) return 'CCTV9'
    if (/少儿|卡通/.test(tail)) return 'CCTV14'
    if (/农业|农村/.test(tail)) return 'CCTV17'
    return `CCTV${Number(digits)}`
  }
  return value.replace(/HD|4K|8K/gi, '')
}

function emptyData(name: string): EpgData {
  return { programs: [], provider: 'none', channelName: name }
}

async function fetchJson(url: string, timeout = 12000): Promise<unknown> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`EPG 返回 ${response.status}`)
    const text = await response.text()
    return text ? JSON.parse(text) : null
  } finally {
    window.clearTimeout(timer)
  }
}

function parseCntvDate(key: string): number {
  const y = Number(key.slice(0, 4))
  const m = Number(key.slice(4, 6)) - 1
  const d = Number(key.slice(6, 8))
  return new Date(y, m, d).getTime()
}

function normalize(list: EpgProgram[]): EpgProgram[] {
  return list
    .filter((item) => item.title && item.end > item.start)
    .sort((a, b) => a.start - b.start)
}

async function loadCntvBatch(codes: string[], date: string): Promise<Map<string, EpgData>> {
  const out = new Map<string, EpgData>()
  if (!codes.length) return out
  const base = new Date(parseCntvDate(date))
  const chunks: string[][] = []
  for (let index = 0; index < codes.length; index += 12) chunks.push(codes.slice(index, index + 12))
  await Promise.all(
    chunks.map(async (chunk) => {
      const url = `${CNTV_BASE}?serviceId=tpbox&f=json&d=${date}&c=${encodeURIComponent(chunk.join(','))}`
      let payload: Record<string, { channelName?: string; program?: { t?: string; st?: number; et?: number }[] }> | null
      try {
        payload = (await fetchJson(url)) as typeof payload
      } catch {
        payload = null
      }
      if (!payload || typeof payload !== 'object') return
      for (const code of chunk) {
        const entry = payload[code]
        if (!entry || !Array.isArray(entry.program)) continue
        const programs = entry.program
          .map((item) => ({
            title: String(item.t || '').trim(),
            start: Math.round(Number(item.st || 0) * 1000),
            end: Math.round(Number(item.et || 0) * 1000)
          }))
          .filter((item) => item.title && item.start > base.getTime() - 30 * 86400000)
        out.set(code, {
          programs: normalize(programs),
          provider: 'cntv',
          channelName: String(entry.channelName || code)
        })
      }
    })
  )
  return out
}

function clockToMs(dayStart: number, clock: string, next: boolean): number {
  const parts = String(clock || '').split(':')
  const hours = Number(parts[0] || 0)
  const minutes = Number(parts[1] || 0)
  return dayStart + (hours * 3600 + minutes * 60) * 1000 + (next ? 86400000 : 0)
}

interface DiypRow {
  start?: string
  end?: string
  title?: string
}

interface DiypPayload {
  channel_name?: string
  epg_data?: DiypRow[]
}

async function loadDiyp(name: string, date: string): Promise<EpgData> {
  const dashed = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
  const ch = diypName(name)
  const query = `?ch=${encodeURIComponent(ch)}&date=${dashed}`
  let payload: DiypPayload | null = null
  try {
    if (runtime.standalone) {
      payload = (await fetchJson(`${DIYP_BASE}${query}`, 9000)) as DiypPayload
    } else {
      payload = (await fetchJson(`${apiUrl(`/api/epg${query}`)}`, 12000)) as DiypPayload
    }
  } catch {
    payload = null
  }
  const rows = payload?.epg_data
  const label = String(payload?.channel_name || '')
  if (!Array.isArray(rows) || !rows.length || label === '未提供') return emptyData(name)
  const dayStart = new Date(`${dashed}T00:00:00`).getTime()
  let previous = dayStart
  const programs = rows
    .map((row) => {
      const rollover = Number(String(row.start || '0').slice(0, 2)) === 0 && previous > dayStart + 20 * 3600000
      const start = clockToMs(dayStart, String(row.start || ''), rollover)
      const endRaw = String(row.end || '')
      const end =
        endRaw === '00:00' || /24:00/.test(endRaw)
          ? start + 3600000
          : clockToMs(dayStart, endRaw, Number(endRaw.slice(0, 2)) === 0 && start > dayStart + 20 * 3600000)
      previous = start
      const title = String(row.title || '').replace(/\s*--免费使用\s*/, '').trim()
      return { title, start, end: Math.max(end, start + 60000) }
    })
    .filter((item) => item.title && !/暂未提供|节目单暂无/.test(item.title))
  return { programs: normalize(programs), provider: 'diyp', channelName: label || ch }
}

function cached(key: string): EpgData | null {
  const hit = cache.get(key)
  if (!hit) return null
  if (hit.at + TTL < Date.now()) {
    cache.delete(key)
    return null
  }
  return hit.data
}

function store(key: string, data: EpgData): EpgData {
  cache.set(key, { at: Date.now(), data })
  return data
}

async function single(name: string, date: string): Promise<EpgData> {
  const key = `${date}|${name}`
  const hit = cached(key)
  if (hit) return hit
  const running = inflight.get(key)
  if (running) return running
  const task = (async () => {
    const code = cntvCode(name)
    if (code) {
      const batch = await loadCntvBatch([code], date)
      const data = batch.get(code)
      if (data && data.programs.length) return store(key, data)
    }
    return store(key, await loadDiyp(name, date))
  })().finally(() => inflight.delete(key))
  inflight.set(key, task)
  return task
}

/** 批量取节目单：央视官方源按代码合并请求，其余频道逐个回落到老张 EPG */
export async function loadEpg(
  names: string[],
  options: { date?: string; limit?: number } = {}
): Promise<Map<string, EpgData>> {
  const date = options.date || todayKey()
  const limit = options.limit ?? 24
  const unique = [...new Set(names.filter(Boolean))].slice(0, limit)
  const result = new Map<string, EpgData>()
  const missing: string[] = []
  const codes = new Map<string, string[]>()
  for (const name of unique) {
    const hit = cached(`${date}|${name}`)
    if (hit && hit.programs.length) {
      result.set(name, hit)
      continue
    }
    const code = cntvCode(name)
    if (code) {
      const bucket = codes.get(code)
      if (bucket) bucket.push(name)
      else codes.set(code, [name])
      continue
    }
    missing.push(name)
  }
  if (codes.size) {
    const batch = await loadCntvBatch([...codes.keys()], date)
    for (const [code, bucket] of codes) {
      const data = batch.get(code) || emptyData(code)
      for (const name of bucket) {
        if (data.programs.length) {
          result.set(name, store(`${date}|${name}`, data))
        } else {
          missing.push(name)
        }
      }
    }
  }
  await Promise.all(
    missing.slice(0, 8).map(async (name) => {
      const data = await single(name, date)
      if (data.programs.length) result.set(name, data)
      else result.set(name, data)
    })
  )
  return result
}

export function epgFor(
  data: EpgData | undefined,
  now = Date.now()
): { current: EpgProgram | null; upNext: EpgProgram[]; missing: boolean } {
  if (!data || !data.programs.length) return { current: null, upNext: [], missing: true }
  let index = -1
  for (let position = 0; position < data.programs.length; position += 1) {
    const program = data.programs[position]
    if (program.start <= now && program.end > now) {
      index = position
      break
    }
    if (program.start > now) break
  }
  if (index < 0) {
    for (let position = 0; position < data.programs.length; position += 1) {
      if (data.programs[position].start <= now && data.programs[position + 1]?.start > now) {
        index = position
        break
      }
    }
  }
  const current = index >= 0 ? data.programs[index] : null
  const upNext =
    index >= 0
      ? data.programs.slice(index + 1, index + 5)
      : data.programs.filter((item) => item.start >= now).slice(0, 5)
  return { current, upNext, missing: false }
}

export function progressOf(program: EpgProgram | null, now = Date.now()): number {
  if (!program) return 0
  const total = program.end - program.start
  if (total <= 0) return 0
  return Math.max(0, Math.min(1, (now - program.start) / total))
}

export function formatClock(value: number): string {
  const date = new Date(value)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

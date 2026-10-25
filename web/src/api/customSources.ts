export type CustomKind = 'live' | 'vod'
export type CustomLiveType = 'auto' | 'm3u' | 'txt'

export interface CustomLiveEntry {
  id: string
  name: string
  url: string
  type: CustomLiveType
  enabled: boolean
  note?: string
  addedAt: number
}

export interface CustomVodEntry {
  id: string
  name: string
  api: string
  type?: 'maccms' | 'kanju'
  enabled: boolean
  note?: string
  addedAt: number
}

export type CustomEntry = (CustomLiveEntry | CustomVodEntry) & { kind?: CustomKind }

const STORE_KEY = 'kaytv.customSources.v1'
const MAX_LIVE = 40
const MAX_VOD = 40

interface Bucket {
  live: CustomLiveEntry[]
  vod: CustomVodEntry[]
}

function readStore(): Bucket {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return { live: [], vod: [] }
    const parsed = JSON.parse(raw) as Partial<Bucket>
    return {
      live: Array.isArray(parsed.live) ? parsed.live : [],
      vod: Array.isArray(parsed.vod) ? parsed.vod : []
    }
  } catch {
    return { live: [], vod: [] }
  }
}

let entries = readStore()

function writeStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(entries))
  } catch {
    /* storage may be unavailable */
  }
}

function urlHash(value: string): string {
  let hash = 5381
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index)
  }
  return (hash >>> 0).toString(36)
}

export function customId(kind: CustomKind, url: string): string {
  return `custom-${kind}-${urlHash(url.toLowerCase().replace(/\/+$/, ''))}`
}

export function listCustom(kind: CustomKind): CustomEntry[] {
  return kind === 'live' ? [...entries.live] : [...entries.vod]
}

export function findCustomLive(id: string): CustomLiveEntry | undefined {
  return entries.live.find((item) => item.id === id)
}

export function findCustomVod(id: string): CustomVodEntry | undefined {
  return entries.vod.find((item) => item.id === id)
}

export function findCustomSource(id: string): CustomLiveEntry | CustomVodEntry | undefined {
  return findCustomLive(id) || findCustomVod(id)
}

export function hasCustomUrl(kind: CustomKind, url: string): boolean {
  const target = url.toLowerCase()
  return entries[kind].some((item) => String('url' in item ? item.url : item.api).toLowerCase() === target)
}

export interface AddInput {
  kind: CustomKind
  name: string
  url: string
  type?: CustomLiveType | 'maccms'
  note?: string
}

export function addCustom(inputs: AddInput[]): { added: number; skipped: number } {
  let added = 0
  let skipped = 0
  for (const input of inputs) {
    const url = String(input.url || '').trim()
    const name = String(input.name || '').trim().slice(0, 40)
    if (!/^https?:\/\//i.test(url) || !name) {
      skipped += 1
      continue
    }
    const id = customId(input.kind, url)
    if (input.kind === 'live') {
      if (entries.live.some((item) => item.id === id)) {
        skipped += 1
        continue
      }
      entries.live.unshift({
        id,
        name,
        url,
        type: input.type === 'm3u' || input.type === 'txt' ? input.type : 'auto',
        enabled: true,
        note: input.note || '自定义直播',
        addedAt: Date.now()
      })
      if (entries.live.length > MAX_LIVE) entries.live.length = MAX_LIVE
    } else {
      if (entries.vod.some((item) => item.id === id)) {
        skipped += 1
        continue
      }
      entries.vod.unshift({
        id,
        name,
        api: url,
        type: 'maccms',
        enabled: true,
        note: input.note || '自定义影视',
        addedAt: Date.now()
      })
      if (entries.vod.length > MAX_VOD) entries.vod.length = MAX_VOD
    }
    added += 1
  }
  if (added) writeStore()
  return { added, skipped }
}

export function removeCustom(id: string): boolean {
  const before = entries.live.length + entries.vod.length
  entries.live = entries.live.filter((item) => item.id !== id)
  entries.vod = entries.vod.filter((item) => item.id !== id)
  const removed = entries.live.length + entries.vod.length < before
  if (removed) writeStore()
  return removed
}

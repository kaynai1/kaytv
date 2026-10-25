import crypto from 'node:crypto'
import { ProxyAgent } from 'undici'

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const dispatcher = process.env.OUTBOUND_PROXY ? new ProxyAgent(process.env.OUTBOUND_PROXY) : undefined

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.statusCode = status
  }
}

export const httpError = (status, message) => new HttpError(status, message)

export async function fetchUpstream(url, { timeout = 15000, headers = {}, ...rest } = {}) {
  const merged = {
    'user-agent': DEFAULT_UA,
    accept: '*/*',
    ...headers
  }
  return fetch(url, {
    ...rest,
    headers: merged,
    signal: AbortSignal.timeout(timeout),
    ...(dispatcher ? { dispatcher } : {})
  })
}

export function hashId(input) {
  return crypto.createHash('sha1').update(String(input)).digest('hex')
}

export function isHttpUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function absoluteUrl(value, base) {
  if (!value) return ''
  try {
    return new URL(value, base).href
  } catch {
    return ''
  }
}

export function cleanText(value, max = 4000) {
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

export function toTimestamp(value) {
  if (value === undefined || value === null || value === '') return 0
  const raw = String(value).trim()
  if (/^\d+$/.test(raw)) {
    const num = Number(raw)
    return num > 1e12 ? num : num * 1000
  }
  const parsed = Date.parse(raw.replace(' ', 'T'))
  return Number.isFinite(parsed) ? parsed : 0
}

export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
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

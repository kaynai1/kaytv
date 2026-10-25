import { BUILTIN_LIVE, groupChannels, parsePlaylist, sanitizeChannels } from '@kaytv/shared'
import type { LiveSource } from '@kaytv/shared'
import type {
  AdminUser,
  AuthUser,
  Category,
  FeedResult,
  HealthInfo,
  HealthReport,
  LiveData,
  PublicConfig,
  SearchResult,
  Subscription,
  Taxonomy,
  VodDetail,
  VodListResult
} from '../types'
import { apiUrl, mediaUrl, runtime } from './runtime'
import { findCustomLive } from './customSources'
import * as local from './standalone'
import type { PlaybackLine } from './standalone'

export type { PlaybackLine }

export class ApiError extends Error {
  status: number

  constructor(message: string, status = 0) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(
  path: string,
  options: {
    params?: Record<string, string | number | boolean | undefined>
    method?: string
    body?: unknown
    timeout?: number
  } = {}
): Promise<T> {
  const url = new URL(apiUrl(path), window.location.href)
  if (options.params) {
    for (const [key, value] of Object.entries(options.params)) {
      if (value === undefined || value === '') continue
      url.searchParams.set(key, String(value))
    }
  }
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), options.timeout ?? 30000)
  let response: Response
  try {
    response = await fetch(url.toString(), {
      method: options.method || 'GET',
      headers: {
        accept: 'application/json',
        ...(options.body ? { 'content-type': 'application/json' } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: 'same-origin',
      signal: controller.signal
    })
  } catch {
    throw new ApiError(controller.signal.aborted ? '请求超时，请稍后重试' : '无法连接服务端，请检查 NAS 地址')
  } finally {
    window.clearTimeout(timer)
  }
  const text = await response.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  if (!response.ok) {
    const message =
      (data as { message?: string } | null)?.message ||
      (response.status === 401 ? '需要登录' : `服务端返回 ${response.status}`)
    throw new ApiError(message, response.status)
  }
  return data as T
}

export const api = {
  async health(baseUrl = ''): Promise<HealthInfo> {
    const base = baseUrl.replace(/\/+$/, '')
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 8000)
    try {
      const response = await fetch(`${base}/api/health`, {
        headers: { accept: 'application/json' },
        signal: controller.signal
      })
      if (!response.ok) throw new ApiError(`服务端返回 ${response.status}`, response.status)
      return (await response.json()) as HealthInfo
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(controller.signal.aborted ? '连接超时' : '无法连接该地址')
    } finally {
      window.clearTimeout(timer)
    }
  },
  publicConfig() {
    return request<PublicConfig>('/api/config', { timeout: 10000 })
  },
  live(sourceId: string, fresh = false) {
    if (runtime.standalone) {
      const source =
        BUILTIN_LIVE.find((item) => item.id === sourceId) ||
        (findCustomLive(sourceId) as unknown as LiveSource | undefined)
      if (!source) return Promise.reject(new ApiError('直播源不存在'))
      return directLive(source, fresh)
    }
    return request<LiveData>('/api/live', {
      params: { source: sourceId, fresh: fresh ? 1 : undefined },
      timeout: 35000
    })
  },
  categories(sourceId: string) {
    if (runtime.standalone) return local.categories(sourceId)
    return request<{ sourceId: string; categories: Category[] }>('/api/vod/categories', {
      params: { source: sourceId },
      timeout: 20000
    })
  },
  list(sourceId: string, page: number, type = '') {
    if (runtime.standalone) return local.list(sourceId, page, type)
    return request<VodListResult>('/api/vod/list', {
      params: { source: sourceId, page, type },
      timeout: 25000
    })
  },
  feed(content: string, region: string, source = '', page = 1) {
    if (runtime.standalone) return local.feed(content, region, source, page)
    return request<FeedResult>('/api/vod/feed', {
      params: { content, region, source, page },
      timeout: 60000
    })
  },
  taxonomy() {
    if (runtime.standalone) return local.taxonomy()
    return request<Taxonomy>('/api/vod/taxonomy', { timeout: 60000 })
  },
  search(keyword: string, sources: string[] = []) {
    if (runtime.standalone) return local.search(keyword, sources)
    return request<SearchResult>('/api/vod/search', {
      params: { q: keyword, sources: sources.join(',') || undefined },
      timeout: 45000
    })
  },
  detail(sourceId: string, id: string) {
    if (runtime.standalone) return local.detail(sourceId, id)
    return request<VodDetail>('/api/vod/detail', { params: { source: sourceId, id }, timeout: 25000 })
  },
  async resolvePlayback(link: string, attempt = 0): Promise<PlaybackLine> {
    const parsed = /^kanju:\/\/([^/]+)\/(.+)$/i.exec(link)
    if (!parsed) {
      return { url: mediaUrl(link), name: '', official: false, index: 0, total: 1 }
    }
    const [, sourceId, token] = parsed
    if (runtime.standalone) return local.resolveKanju(sourceId, token, attempt)
    const data = await request<Partial<PlaybackLine>>('/api/vod/resolve', {
      params: { source: sourceId, token, attempt: attempt || undefined },
      timeout: 25000
    })
    return {
      url: mediaUrl(String(data.url || '')),
      name: data.name || '',
      official: data.official === true,
      index: Number(data.index) || 0,
      total: Number(data.total) || 1,
      fixed: data.fixed === true
    }
  },
  me() {
    return request<{
      authed: boolean
      role: string
      username: string
      displayName: string
      accessMode: 'public' | 'login'
    }>('/api/auth/me', { timeout: 8000 })
  },
  login(username: string, password: string) {
    return request<{ ok: boolean; username: string; displayName: string; role: AuthUser['role'] }>(
      '/api/auth/login',
      { method: 'POST', body: { username, password }, timeout: 10000 }
    )
  },
  logout() {
    return request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' })
  },
  adminSession() {
    return request<{
      authed: boolean
      role: string
      username: string
      displayName: string
      envPassword: boolean
    }>('/api/admin/session', { timeout: 8000 })
  },
  adminLogin(username: string, password: string) {
    return request<{ ok: boolean; username: string; role: string }>('/api/admin/login', {
      method: 'POST',
      body: { username, password },
      timeout: 10000
    })
  },
  adminLogout() {
    return request<{ ok: boolean }>('/api/admin/logout', { method: 'POST' })
  },
  adminConfig() {
    return request<Record<string, unknown>>('/api/admin/config')
  },
  adminSaveConfig(config: unknown) {
    return request<{ ok: boolean }>('/api/admin/config', { method: 'PUT', body: config })
  },
  adminUsers() {
    return request<{ users: AdminUser[] }>('/api/admin/users')
  },
  adminCreateUser(input: {
    username: string
    password: string
    displayName: string
    role: 'admin' | 'viewer'
  }) {
    return request<{ ok: boolean; user: AdminUser }>('/api/admin/users', {
      method: 'POST',
      body: input
    })
  },
  adminUpdateUser(
    id: string,
    input: Partial<{ displayName: string; role: 'admin' | 'viewer'; enabled: boolean; password: string }>
  ) {
    return request<{ ok: boolean; user: AdminUser }>(`/api/admin/users/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: input
    })
  },
  adminDeleteUser(id: string) {
    return request<{ ok: boolean }>(`/api/admin/users/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    })
  },
  adminHealth() {
    return request<HealthReport>('/api/admin/health')
  },
  adminCheckHealth() {
    return request<HealthReport>('/api/admin/health/check', {
      method: 'POST',
      timeout: 300000
    })
  },
  adminPreviewSubscription(url: string) {
    return request<{ vod: { name: string; api: string }[]; live: { name: string; url: string }[] }>(
      '/api/admin/subscriptions/preview',
      { method: 'POST', body: { url }, timeout: 180000 }
    )
  },
  adminSyncSubscriptions(id: string) {
    return request<{
      ok: boolean
      synced: number
      results: { id: string; name: string; ok: boolean; live?: number; vod?: number; error?: string }[]
      config: Record<string, unknown>
    }>('/api/admin/subscriptions/sync', {
      method: 'POST',
      body: { id },
      timeout: 300000
    })
  },
  adminTestLive(url: string, type = 'auto', headers = {}) {
    return request<{
      ok: boolean
      took: number
      count: number
      groups: { name: string; count: number }[]
      sample: string[]
    }>('/api/admin/test/live', {
      method: 'POST',
      body: { url, type, headers },
      timeout: 40000
    })
  },
  adminTestVod(apiUrl: string, headers = {}, type = 'maccms') {
    return request<{
      ok: boolean
      took: number
      categoryCount: number
      categories: string[]
      sample: string[]
    }>('/api/admin/test/vod', {
      method: 'POST',
      body: { api: apiUrl, headers, type },
      timeout: 30000
    })
  },
  adminChangePassword(password: string) {
    return request<{ ok: boolean }>('/api/admin/password', { method: 'POST', body: { password } })
  }
}

function localHash(input: string): string {
  let hash = 5381
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 33) ^ input.charCodeAt(index)
  }
  return (hash >>> 0).toString(36)
}

const liveCache = new Map<string, LiveData>()
const LIVE_CACHE_TTL = 10 * 60 * 1000

export async function directLive(source: LiveSource, fresh = false): Promise<LiveData> {
  if (!fresh) {
    const hit = liveCache.get(source.id)
    if (hit && Date.now() - hit.updatedAt < LIVE_CACHE_TTL) return hit
  }
  let response: Response
  try {
    response = await fetch(source.url, { headers: source.headers })
  } catch {
    throw new ApiError('直播源访问失败，请检查网络或切换其他源')
  }
  if (!response.ok) throw new ApiError(`直播源返回 HTTP ${response.status}`)
  const text = await response.text()
  const parsed = sanitizeChannels(parsePlaylist(text, (source.type as 'auto' | 'm3u' | 'txt') || 'auto'))
  if (!parsed.length) throw new ApiError('没有解析到有效频道')
  const groups = groupChannels(parsed)
  const result: LiveData = {
    sourceId: source.id,
    sourceName: source.name,
    groups,
    channels: parsed.map((channel) => ({
      id: localHash(`${channel.name}|${channel.url}`),
      name: channel.name,
      group: channel.group,
      logo: channel.logo,
      url: channel.url,
      urls: channel.urls || [channel.url]
    })),
    count: parsed.length,
    updatedAt: Date.now()
  }
  liveCache.set(source.id, result)
  return result
}

import { defineStore } from 'pinia'
import { setCloudSources, type CloudInput } from '../api/customSources'
import { normalizeServerUrl, runtime } from '../api/runtime'
import { importTvboxSource } from '../api/tvboxImport'
import type { FavoriteItem, HistoryEntry } from '../types'
import { useLibraryStore } from './library'
import { useSettingsStore } from './settings'

const STORE_KEY = 'kaytv.cloud.v1'
const BUILD_URL = normalizeServerUrl(String(import.meta.env.VITE_CLOUD_URL || ''))
/** 正式云后台；换自己的部署时在设置里填地址，或用 VITE_CLOUD_URL 覆盖 */
const DEFAULT_URL = BUILD_URL || 'https://kaytv-hub.pages.dev'
const REQUEST_TIMEOUT = 12000
const PUSH_DELAY = 4000

export interface CloudAnnouncement {
  id: string
  title: string
  body: string
  level: 'info' | 'warning' | 'critical'
  link: string
  updatedAt: number
}

type CloudKind = 'vod' | 'live' | 'tvbox'

interface CloudRawSource {
  id: string
  kind: CloudKind
  name: string
  url: string
  type?: string
  note?: string
}

interface CloudConfig {
  ok?: boolean
  siteName?: string
  registration?: { open?: boolean; autoApprove?: boolean }
  announcement?: CloudAnnouncement | null
  sources?: CloudRawSource[]
}

export interface CloudAccount {
  id?: string
  username: string
  status?: string
  device?: string
  createdAt?: number
  lastSeen?: number
}

interface TvboxCache {
  sig: string
  live: { name: string; url: string; type: string }[]
  vod: { name: string; url: string; type: string }[]
}

interface Persisted {
  customUrl: string
  token: string
  account: CloudAccount | null
  tvbox: Record<string, TvboxCache>
  dismissed: string
  lastSyncAt: number
  lastPushAt: number
}

interface SyncPayload {
  favorites?: FavoriteItem[]
  history?: Record<string, HistoryEntry>
  updatedAt?: number
}

class CloudError extends Error {
  status: number

  constructor(message: string, status = 0) {
    super(message)
    this.name = 'CloudError'
    this.status = status
  }
}

function load(): Persisted {
  const fallback: Persisted = {
    customUrl: '',
    token: '',
    account: null,
    tvbox: {},
    dismissed: '',
    lastSyncAt: 0,
    lastPushAt: 0
  }
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<Persisted>
    return {
      customUrl: typeof parsed.customUrl === 'string' ? parsed.customUrl : '',
      token: typeof parsed.token === 'string' ? parsed.token : '',
      account: parsed.account && typeof parsed.account === 'object' ? parsed.account : null,
      tvbox: parsed.tvbox && typeof parsed.tvbox === 'object' ? parsed.tvbox : {},
      dismissed: typeof parsed.dismissed === 'string' ? parsed.dismissed : '',
      lastSyncAt: Number(parsed.lastSyncAt) || 0,
      lastPushAt: Number(parsed.lastPushAt) || 0
    }
  } catch {
    return fallback
  }
}

function deviceLabel(): string {
  const ua = navigator.userAgent
  if (/android/i.test(ua)) {
    return /tv|aft|bravia|googletv/i.test(ua) ? 'Android TV' : 'Android 手机'
  }
  if (/iphone|ipad|ipod/i.test(ua)) return 'iOS'
  if (/windows nt/i.test(ua)) return 'Windows'
  if (/mac os x/i.test(ua)) return 'macOS'
  return runtime.packaged ? '桌面端' : '浏览器'
}

async function cloudRequest<T>(
  base: string,
  path: string,
  options: { method?: string; body?: unknown; token?: string } = {}
): Promise<T> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT)
  let response: Response
  try {
    response = await fetch(`${base}${path}`, {
      method: options.method || 'GET',
      headers: {
        accept: 'application/json',
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
      cache: 'no-store'
    })
  } catch {
    throw new CloudError(controller.signal.aborted ? '连接云端超时' : '连不上云后台，请检查网络或地址')
  } finally {
    window.clearTimeout(timer)
  }
  let data: Record<string, unknown> | null = null
  try {
    data = (await response.json()) as Record<string, unknown>
  } catch {
    data = null
  }
  if (!response.ok) {
    throw new CloudError(String(data?.error || data?.message || `云端返回 ${response.status}`), response.status)
  }
  return (data || {}) as T
}

let initPromise: Promise<void> | null = null
let pushTimer = 0

export const useCloudStore = defineStore('cloud', {
  state: () => {
    const persisted = load()
    return {
      customUrl: persisted.customUrl,
      token: persisted.token,
      account: persisted.account as CloudAccount | null,
      tvbox: persisted.tvbox,
      dismissed: persisted.dismissed,
      lastSyncAt: persisted.lastSyncAt,
      lastPushAt: persisted.lastPushAt,
      siteName: 'KayTV',
      announcement: null as CloudAnnouncement | null,
      sources: [] as CloudRawSource[],
      registrationOpen: true,
      autoApprove: true,
      online: false,
      checked: false,
      loading: false,
      syncing: false,
      syncingData: false,
      error: '',
      sourceCount: 0,
      tvboxCount: 0,
      initialized: false
    }
  },
  getters: {
    endpoint(state): string {
      return normalizeServerUrl(state.customUrl || DEFAULT_URL)
    },
    configured(): boolean {
      return Boolean(this.endpoint)
    },
    banner(state): CloudAnnouncement | null {
      if (!state.announcement) return null
      const key = `${state.announcement.id}:${state.announcement.updatedAt || 0}`
      return state.dismissed === key ? null : state.announcement
    },
    loggedIn(state): boolean {
      return Boolean(state.token && state.account)
    }
  },
  actions: {
    persist() {
      try {
        localStorage.setItem(
          STORE_KEY,
          JSON.stringify({
            customUrl: this.customUrl,
            token: this.token,
            account: this.account,
            tvbox: this.tvbox,
            dismissed: this.dismissed,
            lastSyncAt: this.lastSyncAt,
            lastPushAt: this.lastPushAt
          })
        )
      } catch {
        /* storage may be unavailable */
      }
    },
    async init() {
      if (initPromise) return initPromise
      initPromise = (async () => {
        this.initialized = true
        await this.sync({ silent: true })
        await this.restoreAccount()
      })()
      return initPromise
    },
    async setEndpoint(input: string) {
      this.customUrl = normalizeServerUrl(input)
      this.persist()
      await this.sync()
    },
    async sync(options: { silent?: boolean } = {}) {
      if (!this.configured) return false
      this.syncing = true
      if (!options.silent) this.error = ''
      try {
        const config = await cloudRequest<CloudConfig>(this.endpoint, '/api/config')
        this.online = true
        this.checked = true
        this.error = ''
        this.siteName = String(config.siteName || 'KayTV')
        this.registrationOpen = config.registration?.open !== false
        this.autoApprove = config.registration?.autoApprove !== false
        this.announcement = config.announcement || null
        this.sources = Array.isArray(config.sources) ? config.sources : []
        const settings = useSettingsStore()
        const changed = settings.standalone ? await this.applySources(this.sources) : false
        if (changed) await settings.refresh()
        if (settings.online || settings.standalone) settings.siteName = this.siteName
        this.lastSyncAt = Date.now()
        this.persist()
        return true
      } catch (error) {
        this.online = false
        this.checked = true
        if (!options.silent) this.error = error instanceof Error ? error.message : '云后台同步失败'
        return false
      } finally {
        this.syncing = false
      }
    },
    async applySources(sources: CloudRawSource[]): Promise<boolean> {
      const inputs: CloudInput[] = []
      const activeTvbox = new Set<string>()
      let failed = ''
      for (const source of sources) {
        const url = String(source.url || '').trim()
        if (!/^https?:\/\//i.test(url) || !source.name) continue
        if (source.kind === 'tvbox') {
          activeTvbox.add(source.id)
          const sig = `${url}|${source.name}`
          let cached = this.tvbox[source.id]
          if (!cached || cached.sig !== sig) {
            try {
              const result = await importTvboxSource(url)
              cached = {
                sig,
                live: result.live.map((item) => ({ name: item.name, url: item.url, type: item.type })),
                vod: result.vod.map((item) => ({ name: item.name, url: item.url, type: item.type }))
              }
              this.tvbox[source.id] = cached
            } catch (error) {
              failed = `${source.name}: ${error instanceof Error ? error.message : 'TVBox 订阅解析失败'}`
            }
          }
          if (!cached) continue
          for (const item of cached.live) {
            inputs.push({
              kind: 'live',
              name: item.name,
              url: item.url,
              type: item.type,
              note: `云端 · ${source.name}`,
              cloudId: source.id
            })
          }
          for (const item of cached.vod) {
            inputs.push({
              kind: 'vod',
              name: item.name,
              url: item.url,
              type: 'maccms',
              note: `云端 · ${source.name}`,
              cloudId: source.id
            })
          }
          continue
        }
        if (source.kind !== 'live' && source.kind !== 'vod') continue
        inputs.push({
          kind: source.kind,
          name: source.name,
          url,
          type: source.kind === 'live' ? source.type : 'maccms',
          note: `云端 · ${source.note || '云后台'}`,
          cloudId: source.id
        })
      }
      for (const id of Object.keys(this.tvbox)) {
        if (!activeTvbox.has(id)) delete this.tvbox[id]
      }
      const changed = setCloudSources(inputs)
      this.sourceCount = inputs.length
      this.tvboxCount = activeTvbox.size
      if (failed) this.error = failed
      this.persist()
      return changed
    },
    dismissAnnouncement() {
      if (!this.announcement) return
      this.dismissed = `${this.announcement.id}:${this.announcement.updatedAt || 0}`
      this.persist()
    },
    async register(username: string, password: string): Promise<{ pending: boolean; message: string }> {
      this.loading = true
      try {
        const data = await cloudRequest<{
          ok: boolean
          pending?: boolean
          message?: string
          token?: string
          user?: CloudAccount
        }>(this.endpoint, '/api/register', {
          method: 'POST',
          body: { username, password, device: deviceLabel() }
        })
        if (data.pending) {
          this.persist()
          return { pending: true, message: data.message || '注册成功，等管理员审核' }
        }
        if (!data.token || !data.user) throw new CloudError('云端没有返回登录信息')
        this.token = data.token
        this.account = data.user
        this.persist()
        await this.pullAndPush()
        return { pending: false, message: `已登录 ${data.user.username}` }
      } finally {
        this.loading = false
      }
    },
    async login(username: string, password: string) {
      this.loading = true
      try {
        const data = await cloudRequest<{ ok: boolean; token?: string; user?: CloudAccount }>(
          this.endpoint,
          '/api/login',
          { method: 'POST', body: { username, password } }
        )
        if (!data.token || !data.user) throw new CloudError('云端没有返回登录信息')
        this.token = data.token
        this.account = data.user
        this.error = ''
        this.persist()
        await this.pullAndPush()
        return data.user
      } finally {
        this.loading = false
      }
    },
    async logout() {
      if (this.token) {
        try {
          await cloudRequest(this.endpoint, '/api/logout', { method: 'POST', token: this.token })
        } catch {
          /* 本地退出即可 */
        }
      }
      window.clearTimeout(pushTimer)
      this.token = ''
      this.account = null
      this.persist()
    },
    async restoreAccount() {
      if (!this.token) return
      try {
        const me = await cloudRequest<{ ok: boolean; user?: CloudAccount }>(this.endpoint, '/api/me', {
          token: this.token
        })
        if (me.user) {
          this.account = me.user
          this.persist()
        }
        const library = useLibraryStore()
        if (!library.favorites.length && !Object.keys(library.history).length) {
          const remote = await cloudRequest<SyncPayload>(this.endpoint, '/api/sync', { token: this.token })
          if (library.mergeCloud(remote)) {
            this.lastPushAt = Number(remote.updatedAt) || 0
            this.persist()
          }
        }
      } catch (error) {
        if (error instanceof CloudError && error.status === 401) {
          this.token = ''
          this.account = null
          this.persist()
        }
      }
    },
    async pullAndPush() {
      const library = useLibraryStore()
      const remote = await cloudRequest<SyncPayload>(this.endpoint, '/api/sync', { token: this.token })
      library.mergeCloud(remote)
      library.saveFavorites()
      library.saveHistory()
      const pushed = await cloudRequest<SyncPayload>(this.endpoint, '/api/sync', {
        method: 'PUT',
        token: this.token,
        body: { favorites: library.favorites, history: library.history }
      })
      this.lastPushAt = Number(pushed.updatedAt) || Date.now()
      this.lastSyncAt = this.lastPushAt
      this.persist()
    },
    /** 手动：先把云端合并到本机，再整体上传，适合换机或两端都存过收藏时对齐 */
    async syncNow() {
      if (!this.token) throw new CloudError('请先登录云端账号')
      this.syncingData = true
      try {
        await this.pullAndPush()
        this.error = ''
      } finally {
        this.syncingData = false
      }
    },
    async pushNow(silent = false) {
      if (!this.token) return false
      const library = useLibraryStore()
      try {
        const data = await cloudRequest<SyncPayload>(this.endpoint, '/api/sync', {
          method: 'PUT',
          token: this.token,
          body: { favorites: library.favorites, history: library.history }
        })
        this.lastPushAt = Number(data.updatedAt) || Date.now()
        this.persist()
        return true
      } catch (error) {
        if (!silent) this.error = error instanceof Error ? error.message : '同步失败'
        return false
      }
    },
    /** 收藏/进度变动后攒 4 秒再传，连着操作只发一次 */
    queuePush() {
      if (!this.token) return
      window.clearTimeout(pushTimer)
      pushTimer = window.setTimeout(() => {
        void this.pushNow(true)
      }, PUSH_DELAY)
    }
  }
})

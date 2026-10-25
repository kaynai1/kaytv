import { defineStore } from 'pinia'
import { BUILTIN_LIVE, BUILTIN_VOD } from '@kaytv/shared'
import type { AuthUser, SourceMeta } from '../types'
import { api, ApiError } from '../api/client'
import { normalizeServerUrl, runtime } from '../api/runtime'
import { listCustom } from '../api/customSources'
import { clearCache, setEngineGates } from '../api/standalone'

const STORAGE_KEY = 'kaytv.settings.v1'

type SourceMode = 'standalone' | 'server'

interface Persisted {
  serverUrl: string
  mode: SourceMode
  disabledLive: string[]
  disabledVod: string[]
  tvMode: boolean
  tvModeTouched: boolean
  adultFilter: boolean
}

function defaultMode(): SourceMode {
  return runtime.packaged ? 'standalone' : 'server'
}

function loadPersisted(): Persisted {
  const fallback: Persisted = {
    serverUrl: '',
    mode: defaultMode(),
    disabledLive: [],
    disabledVod: [],
    tvMode: false,
    tvModeTouched: false,
    adultFilter: true
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<Persisted>
    return {
      serverUrl: normalizeServerUrl(String(parsed.serverUrl || '')),
      mode: parsed.mode === 'standalone' || parsed.mode === 'server' ? parsed.mode : defaultMode(),
      disabledLive: Array.isArray(parsed.disabledLive) ? parsed.disabledLive : [],
      disabledVod: Array.isArray(parsed.disabledVod) ? parsed.disabledVod : [],
      tvMode: parsed.tvMode === true,
      tvModeTouched: parsed.tvModeTouched === true,
      adultFilter: parsed.adultFilter !== false
    }
  } catch {
    return fallback
  }
}

function customLive(): SourceMeta[] {
  return listCustom('live').map((item) => ({
    id: item.id,
    name: item.name,
    type: item.type || 'auto',
    note: item.note || '自定义直播',
    enabled: true
  }))
}

function customVod(): SourceMeta[] {
  return listCustom('vod').map((item) => ({
    id: item.id,
    name: item.name,
    type: item.type || 'maccms',
    note: item.note || '自定义影视',
    enabled: true
  }))
}

function builtinLive(): SourceMeta[] {
  const list: SourceMeta[] = BUILTIN_LIVE.map((item) => ({
    id: item.id,
    name: item.name,
    type: item.type,
    note: item.note,
    enabled: item.enabled !== false
  }))
  return list.concat(customLive())
}

function builtinVod(): SourceMeta[] {
  const list: SourceMeta[] = BUILTIN_VOD.map((item) => ({
    id: item.id,
    name: item.name,
    type: item.type,
    note: item.note,
    enabled: item.enabled !== false,
    searchable: item.searchable !== false
  }))
  return list.concat(customVod())
}

let initPromise: Promise<void> | null = null

export const useSettingsStore = defineStore('settings', {
  state: () => {
    const persisted = loadPersisted()
    return {
      serverUrl: persisted.serverUrl,
      mode: persisted.mode,
      standalone: persisted.mode === 'standalone' && runtime.packaged,
      disabledLive: persisted.disabledLive,
      disabledVod: persisted.disabledVod,
      tvMode: persisted.tvMode,
      tvModeTouched: persisted.tvModeTouched,
      adultFilter: persisted.adultFilter,
      siteName: 'KayTV',
      online: false,
      syncing: false,
      checked: false,
      error: '',
      initialized: false,
      accessMode: 'public' as 'public' | 'login',
      needsLogin: false,
      currentUser: null as AuthUser | null,
      liveSources: builtinLive() as SourceMeta[],
      vodSources: builtinVod() as SourceMeta[]
    }
  },
  getters: {
    activeLive(state): SourceMeta[] {
      return state.liveSources.filter(
        (source) => source.enabled !== false && !state.disabledLive.includes(source.id)
      )
    },
    activeVod(state): SourceMeta[] {
      return state.vodSources.filter(
        (source) => source.enabled !== false && !state.disabledVod.includes(source.id)
      )
    },
    displayServer(state): string {
      if (state.standalone) return '内置模式'
      if (state.serverUrl) return state.serverUrl
      return window.location.origin
    },
    sourceName() {
      return (sourceId: string): string =>
        this.activeLive.find((item) => item.id === sourceId)?.name ||
        this.activeVod.find((item) => item.id === sourceId)?.name ||
        '未知源'
    }
  },
  actions: {
    persist() {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            serverUrl: this.serverUrl,
            mode: this.mode,
            disabledLive: this.disabledLive,
            disabledVod: this.disabledVod,
            tvMode: this.tvMode,
            tvModeTouched: this.tvModeTouched,
            adultFilter: this.adultFilter
          })
        )
      } catch {
        /* storage may be unavailable */
      }
    },
    /** 内置引擎的片源开关与成人过滤从这里下发，保证「关了就不出现」 */
    applyGates() {
      setEngineGates({
        sourceGate: (id) => !this.disabledVod.includes(id),
        adultFilter: this.adultFilter
      })
    },
    async init() {
      if (initPromise) return initPromise
      initPromise = (async () => {
        this.initialized = true
        this.applyGates()
        const query = new URLSearchParams(window.location.search).get('server')
        if (query) {
          this.serverUrl = normalizeServerUrl(query)
          this.mode = 'server'
          this.standalone = false
          this.persist()
        }
        runtime.standalone = this.standalone
        runtime.serverUrl = this.standalone ? '' : this.serverUrl
        await this.refresh()
      })()
      return initPromise
    },
    async refresh() {
      this.syncing = true
      runtime.standalone = this.standalone
      runtime.serverUrl = this.standalone ? '' : this.serverUrl
      if (this.standalone) {
        this.online = true
        this.error = ''
        this.needsLogin = false
        this.accessMode = 'public'
        this.currentUser = null
        this.siteName = 'KayTV'
        this.liveSources = builtinLive()
        this.vodSources = builtinVod()
        this.syncing = false
        this.checked = true
        return
      }
      try {
        const me = await api.me()
        this.accessMode = me.accessMode
        this.currentUser = me.authed
          ? {
              username: me.username,
              displayName: me.displayName || me.username,
              role: me.role === 'admin' ? 'admin' : 'viewer'
            }
          : null
      } catch {
        /* server may be offline; checked below */
      }
      try {
        const health = await api.health(this.serverUrl)
        const config = await api.publicConfig()
        this.online = true
        this.error = ''
        this.needsLogin = false
        this.accessMode = config.accessMode || this.accessMode
        this.siteName = config.siteName || health.siteName || 'KayTV'
        this.liveSources = config.liveSources
        this.vodSources = config.vodSources
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          this.online = true
          this.needsLogin = true
          this.error = ''
          this.liveSources = []
          this.vodSources = []
        } else {
          this.online = false
          this.needsLogin = false
          this.error = error instanceof Error ? error.message : '无法连接服务端'
          this.liveSources = builtinLive()
          this.vodSources = builtinVod()
        }
      } finally {
        this.syncing = false
        this.checked = true
      }
    },
    async login(username: string, password: string) {
      const result = await api.login(username, password)
      this.currentUser = {
        username: result.username,
        displayName: result.displayName || result.username,
        role: result.role === 'admin' ? 'admin' : 'viewer'
      }
      this.needsLogin = false
      await this.refresh()
      return result
    },
    async logout() {
      try {
        await api.logout()
      } catch {
        /* ignore */
      }
      this.currentUser = null
      await this.refresh()
    },
    async testAndSave(input: string) {
      const candidate = normalizeServerUrl(input)
      const previousUrl = runtime.serverUrl
      const previousStandalone = runtime.standalone
      runtime.standalone = false
      runtime.serverUrl = candidate
      try {
        const health = await api.health(candidate)
        this.serverUrl = candidate
        this.mode = 'server'
        this.standalone = false
        runtime.serverUrl = candidate
        this.persist()
        await this.refresh()
        return health.siteName || 'KayTV'
      } catch (error) {
        runtime.serverUrl = previousUrl
        runtime.standalone = previousStandalone
        throw error
      }
    },
    async useSameOrigin() {
      this.serverUrl = ''
      this.mode = 'server'
      this.standalone = false
      runtime.standalone = false
      runtime.serverUrl = ''
      this.persist()
      await this.refresh()
    },
    async useStandalone() {
      if (!runtime.packaged) throw new Error('内置模式仅在桌面 / 手机客户端可用')
      this.mode = 'standalone'
      this.standalone = true
      runtime.standalone = true
      runtime.serverUrl = ''
      this.persist()
      await this.refresh()
    },
    toggleTvMode() {
      this.tvMode = !this.tvMode
      this.tvModeTouched = true
      this.persist()
    },
    /** 盒子/电视棒没有触屏，首次启动自动进大屏模式，用户手动改过之后不再干预 */
    autoTvMode() {
      if (this.tvModeTouched) return
      const coarse = typeof window.matchMedia === 'function' ? window.matchMedia('(pointer: coarse)').matches : false
      const noTouch = (navigator.maxTouchPoints || 0) === 0 && !coarse
      const wide = window.innerWidth >= 960
      if (noTouch && wide) this.tvMode = true
    },
    toggleLive(id: string, enabled: boolean) {
      const set = new Set(this.disabledLive)
      if (enabled) set.delete(id)
      else set.add(id)
      this.disabledLive = [...set]
      this.persist()
    },
    toggleVod(id: string, enabled: boolean) {
      const set = new Set(this.disabledVod)
      if (enabled) set.delete(id)
      else set.add(id)
      this.disabledVod = [...set]
      this.persist()
      this.applyGates()
      // 聚合片墙有 2 分钟缓存，不丢掉的话刚关的源还会继续出现
      clearCache()
    },
    /** 全部内置影视源恢复启用，避免用户把源关光之后面对空墙 */
    restoreDefaultVod() {
      this.disabledVod = []
      this.persist()
      this.applyGates()
      clearCache()
    },
    setAdultFilter(enabled: boolean) {
      if (this.adultFilter === enabled) return
      this.adultFilter = enabled
      this.persist()
      this.applyGates()
      clearCache()
    }
  }
})

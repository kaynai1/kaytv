import { defineStore } from 'pinia'
import type { FavoriteItem, HistoryEntry, VodItem } from '../types'

const FAVORITES_KEY = 'kaytv.favorites.v1'
const HISTORY_KEY = 'kaytv.history.v1'
const SEARCH_KEY = 'kaytv.search.v1'

export function itemKey(sourceId: string, id: string): string {
  return `${sourceId}:${id}`
}

function readArray<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function readMap<T>(key: string): Record<string, T> {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, T>) : {}
  } catch {
    return {}
  }
}

export const useLibraryStore = defineStore('library', {
  state: () => ({
    favorites: readArray<FavoriteItem>(FAVORITES_KEY),
    history: readMap<HistoryEntry>(HISTORY_KEY),
    searchHistory: readArray<string>(SEARCH_KEY)
  }),
  getters: {
    recentHistory(state): HistoryEntry[] {
      return Object.values(state.history)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 30)
    }
  },
  actions: {
    saveFavorites() {
      try {
        localStorage.setItem(FAVORITES_KEY, JSON.stringify(this.favorites))
      } catch {
        /* ignore */
      }
    },
    saveHistory() {
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(this.history))
      } catch {
        /* ignore */
      }
    },
    saveSearch() {
      try {
        localStorage.setItem(SEARCH_KEY, JSON.stringify(this.searchHistory))
      } catch {
        /* ignore */
      }
    },
    isFavorite(sourceId: string, id: string): boolean {
      return this.favorites.some((item) => item.sourceId === sourceId && item.id === id)
    },
    toggleFavorite(item: VodItem): boolean {
      const index = this.favorites.findIndex(
        (entry) => entry.sourceId === item.sourceId && entry.id === item.id
      )
      if (index >= 0) {
        this.favorites.splice(index, 1)
        this.saveFavorites()
        return false
      }
      this.favorites.unshift({
        sourceId: item.sourceId,
        sourceName: item.sourceName,
        id: item.id,
        name: item.name,
        pic: item.pic,
        remarks: item.remarks,
        addedAt: Date.now()
      })
      this.saveFavorites()
      return true
    },
    removeFavorite(sourceId: string, id: string) {
      this.favorites = this.favorites.filter(
        (entry) => !(entry.sourceId === sourceId && entry.id === id)
      )
      this.saveFavorites()
    },
    progressOf(sourceId: string, id: string): HistoryEntry | null {
      return this.history[itemKey(sourceId, id)] || null
    },
    saveProgress(entry: HistoryEntry) {
      this.history[itemKey(entry.sourceId, entry.id)] = {
        ...entry,
        updatedAt: Date.now()
      }
      this.saveHistory()
    },
    removeHistory(sourceId: string, id: string) {
      delete this.history[itemKey(sourceId, id)]
      this.saveHistory()
    },
    addSearch(keyword: string) {
      const value = keyword.trim()
      if (!value) return
      this.searchHistory = [value, ...this.searchHistory.filter((item) => item !== value)].slice(0, 12)
      this.saveSearch()
    },
    clearSearch() {
      this.searchHistory = []
      this.saveSearch()
    },
    clearHistory() {
      this.history = {}
      this.saveHistory()
    },
    clearFavorites() {
      this.favorites = []
      this.saveFavorites()
    },
    /** 并集合并云端收藏与进度，同一条取更新时间较新的；用于登录或换机拉取 */
    mergeCloud(remote: {
      favorites?: FavoriteItem[]
      history?: Record<string, HistoryEntry>
    }): boolean {
      let changed = false
      const known = new Map(this.favorites.map((item) => [itemKey(item.sourceId, item.id), item]))
      for (const item of remote.favorites || []) {
        if (!item || !item.sourceId || !item.id) continue
        const key = itemKey(item.sourceId, item.id)
        const local = known.get(key)
        if (!local) {
          this.favorites.push({ ...item })
          known.set(key, item)
          changed = true
        } else if (Number(item.addedAt) > Number(local.addedAt)) {
          Object.assign(local, item)
          changed = true
        }
      }
      if (changed) {
        this.favorites.sort((a, b) => Number(b.addedAt) - Number(a.addedAt))
        this.saveFavorites()
      }
      let historyChanged = false
      for (const [key, entry] of Object.entries(remote.history || {})) {
        if (!entry || !entry.sourceId || !entry.id) continue
        const local = this.history[key]
        if (!local || Number(entry.updatedAt) > Number(local.updatedAt)) {
          this.history[key] = { ...entry }
          historyChanged = true
        }
      }
      if (historyChanged) {
        this.saveHistory()
        changed = true
      }
      return changed
    }
  }
})

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
    }
  }
})

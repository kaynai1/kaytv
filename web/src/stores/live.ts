import { defineStore } from 'pinia'
import type { Channel } from '../types'
import { channelKey } from '../composables/liveChannels'

const FAVORITES_KEY = 'kaytv.liveFavorites.v1'
const RECENT_KEY = 'kaytv.liveRecent.v1'
const RECENT_LIMIT = 20

function readKeys(key: string): string[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

export interface LiveDownReport {
  key: string
  name: string
  reason: string
  seq: number
}

let downSeq = 0

export const useLiveStore = defineStore('live', {
  state: () => ({
    favorites: readKeys(FAVORITES_KEY),
    recent: readKeys(RECENT_KEY),
    failed: {} as Record<string, string>,
    down: null as LiveDownReport | null
  }),
  getters: {
    isFavorite(state): (channel: Channel) => boolean {
      return (channel) => state.favorites.includes(channelKey(channel))
    },
    isFailed(state): (channel: Channel) => boolean {
      return (channel) => Boolean(state.failed[channelKey(channel)])
    },
    failReason(state): (channel: Channel) => string {
      return (channel) => state.failed[channelKey(channel)] || ''
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
    saveRecent() {
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(this.recent))
      } catch {
        /* ignore */
      }
    },
    toggleFavorite(channel: Channel): boolean {
      const key = channelKey(channel)
      const index = this.favorites.indexOf(key)
      if (index >= 0) {
        this.favorites.splice(index, 1)
        this.saveFavorites()
        return false
      }
      this.favorites.unshift(key)
      this.saveFavorites()
      return true
    },
    noteWatched(channel: Channel) {
      const key = channelKey(channel)
      this.recent = [key, ...this.recent.filter((item) => item !== key)].slice(0, RECENT_LIMIT)
      this.saveRecent()
    },
    markFailed(channel: Channel, reason: string) {
      this.failed[channelKey(channel)] = reason || '无法播放'
    },
    clearFailed(channel: Channel) {
      delete this.failed[channelKey(channel)]
    },
    reportDown(channel: Channel, reason: string) {
      this.markFailed(channel, reason)
      downSeq += 1
      this.down = { key: channelKey(channel), name: channel.name, reason: reason || '无法播放', seq: downSeq }
    }
  }
})

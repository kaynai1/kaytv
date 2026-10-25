import { defineStore } from 'pinia'
import type { Channel, VodDetail } from '../types'

interface LiveState {
  channels: Channel[]
  index: number
  lineIndex: number
  sourceId: string
  sourceName: string
  groupName: string
}

interface VodState {
  detail: VodDetail
  lineIndex: number
  episodeIndex: number
  resume: number
}

export const usePlayerStore = defineStore('player', {
  state: () => ({
    open: false,
    kind: 'live' as 'live' | 'vod',
    live: null as LiveState | null,
    vod: null as VodState | null
  }),
  getters: {
    currentChannel(state): Channel | null {
      if (!state.live) return null
      return state.live.channels[state.live.index] || null
    },
    currentLine(state) {
      if (!state.vod) return null
      return state.vod.detail.lines[state.vod.lineIndex] || null
    },
    currentEpisode(state) {
      if (!state.vod) return null
      const line = state.vod.detail.lines[state.vod.lineIndex]
      if (!line) return null
      return line.episodes[state.vod.episodeIndex] || null
    },
    title(state): string {
      if (state.kind === 'live') return state.live?.channels[state.live.index]?.name || '直播'
      return state.vod?.detail.name || '影视'
    },
    subtitle(state): string {
      if (state.kind === 'live') {
        return `${state.live?.sourceName || ''} · ${state.live?.groupName || ''}`
      }
      if (!state.vod) return ''
      const episode = state.vod.detail.lines[state.vod.lineIndex]?.episodes[state.vod.episodeIndex]
      return `${state.vod.detail.name} · ${episode?.name || ''}`
    },
    poster(state): string {
      return state.kind === 'vod' ? state.vod?.detail.pic || '' : ''
    },
    currentUrl(state): string {
      if (state.kind === 'live') {
        const channel = state.live?.channels[state.live.index]
        if (!channel) return ''
        return channel.urls?.[state.live?.lineIndex || 0] || channel.url
      }
      const current = state.vod
      if (!current) return ''
      const line = current.detail.lines[current.lineIndex]
      return line?.episodes[current.episodeIndex]?.url || ''
    }
  },
  actions: {
    openLive(
      channels: Channel[],
      index: number,
      sourceName: string,
      groupName: string,
      sourceId = ''
    ) {
      this.kind = 'live'
      this.live = { channels, index, lineIndex: 0, sourceId, sourceName, groupName }
      this.vod = null
      this.open = true
    },
    openVod(detail: VodDetail, lineIndex = 0, episodeIndex = 0, resume = 0) {
      this.kind = 'vod'
      this.vod = { detail, lineIndex, episodeIndex, resume }
      this.live = null
      this.open = true
    },
    close() {
      this.open = false
      this.live = null
      this.vod = null
    },
    shiftChannel(delta: number) {
      if (!this.live) return
      const count = this.live.channels.length
      if (!count) return
      this.live.index = (this.live.index + delta + count) % count
      this.live.lineIndex = 0
      const channel = this.live.channels[this.live.index]
      this.live.groupName = channel?.group || ''
    },
    setChannel(index: number) {
      if (!this.live) return
      if (index < 0 || index >= this.live.channels.length) return
      this.live.index = index
      this.live.lineIndex = 0
      this.live.groupName = this.live.channels[index].group || ''
    },
    nextLine() {
      if (!this.live) return false
      const channel = this.live.channels[this.live.index]
      if (!channel?.urls || this.live.lineIndex + 1 >= channel.urls.length) return false
      this.live.lineIndex += 1
      return true
    },
    setLine(lineIndex: number) {
      if (!this.vod) return
      const line = this.vod.detail.lines[lineIndex]
      if (!line) return
      const clamped = Math.min(this.vod.episodeIndex, line.episodes.length - 1)
      this.vod.lineIndex = lineIndex
      this.vod.episodeIndex = Math.max(0, clamped)
      this.vod.resume = 0
    },
    setEpisode(lineIndex: number, episodeIndex: number) {
      if (!this.vod) return
      const line = this.vod.detail.lines[lineIndex]
      if (!line || !line.episodes[episodeIndex]) return
      this.vod.lineIndex = lineIndex
      this.vod.episodeIndex = episodeIndex
      this.vod.resume = 0
    },
    nextEpisode() {
      if (!this.vod) return false
      const line = this.vod.detail.lines[this.vod.lineIndex]
      if (!line) return false
      if (this.vod.episodeIndex + 1 >= line.episodes.length) return false
      this.vod.episodeIndex += 1
      this.vod.resume = 0
      return true
    },
    consumeResume() {
      if (!this.vod) return 0
      const value = this.vod.resume
      this.vod.resume = 0
      return value
    }
  }
})

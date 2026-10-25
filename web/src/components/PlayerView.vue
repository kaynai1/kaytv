<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type Hls from 'hls.js'
import { usePlayerStore } from '../stores/player'
import { useLibraryStore } from '../stores/library'
import { useSettingsStore } from '../stores/settings'
import { api } from '../api/client'
import { mediaUrl, runtime } from '../api/runtime'
import { copyText } from '../api/diagnostics'
import { toast } from '../composables/useToast'
import { useLiveStore } from '../stores/live'
import type { Channel, VodDetail } from '../types'
import AppIcon from './AppIcon.vue'

const player = usePlayerStore()
const library = useLibraryStore()
const settings = useSettingsStore()
const liveStore = useLiveStore()

const root = ref<HTMLElement | null>(null)
const video = ref<HTMLVideoElement | null>(null)
const playing = ref(false)
const waiting = ref(false)
const error = ref('')
const duration = ref(0)
const position = ref(0)
const muted = ref(false)
const volume = ref(1)
const isFullscreen = ref(false)
const controlsVisible = ref(true)
const drawerOpen = ref(false)
const drawerQuery = ref('')
const audioTracks = ref<string[]>([])
const audioIndex = ref(0)
const subtitleTracks = ref<string[]>([])
const subtitleIndex = ref(-1)

let hls: Hls | null = null
let hlsLib: typeof import('hls.js').default | null = null
let flv: any = null
let flvLib: any = null
let attachToken = 0
let resumeTarget = 0
let hideTimer = 0
let fallbackTimer = 0
let saveMark = 0
let pushedState = false
let resumeAfterHide = false
let lastFocused: HTMLElement | null = null

let lineAttempt = 0
let lineAttemptKey = ''
let kanjuExhausted = false
let recoveries = 0
let recovering = false
let switching = false
const triedSources = new Set<string>()
const resolveLine = ref<{ name: string; index: number; total: number; fixed: boolean } | null>(null)

const MAX_RECOVERIES = 8

const isLive = computed(() => player.kind === 'live' && !!player.live)
const currentChannel = computed(() => player.currentChannel)
const channels = computed(() => player.live?.channels || [])
const vod = computed(() => player.vod)
const line = computed(() => player.currentLine)
const episode = computed(() => player.currentEpisode)
const lines = computed(() => vod.value?.detail.lines || [])

const titleText = computed(() => player.title)
const subtitleText = computed(() => {
  if (isLive.value) {
    return `${player.live?.sourceName || ''} · ${player.live?.groupName || ''}`
  }
  const name = episode.value?.name || ''
  const lineName = resolveLine.value?.name || ''
  const total = resolveLine.value?.total || 0
  const lineText = lineName
    ? total > 1
      ? `${lineName}（${(resolveLine.value?.index || 0) + 1}/${total}）`
      : lineName
    : ''
  return [name ? `正在播放 · ${name}` : '', lineText].filter(Boolean).join(' · ')
})
const liveBadge = computed(() => (isLive.value ? '直播' : `第 ${(vod.value?.episodeIndex || 0) + 1} 集`))
const liveLineText = computed(() => {
  const total = currentChannel.value?.urls?.length || 1
  if (!isLive.value || total <= 1) return ''
  return `线路 ${(player.live?.lineIndex || 0) + 1}/${total}`
})
const clockText = computed(() => formatClock(position.value))
const durationText = computed(() => formatClock(duration.value))
const progressWidth = computed(() => {
  if (!duration.value) return 0
  return Math.min(100, (position.value / duration.value) * 100)
})

const drawerChannels = computed(() => {
  const keyword = drawerQuery.value.trim().toLowerCase()
  return channels.value
    .map((channel, index) => ({ channel, index }))
    .filter(({ channel }) => {
      if (!keyword) return true
      return (
        channel.name.toLowerCase().includes(keyword) ||
        channel.group.toLowerCase().includes(keyword)
      )
    })
})

const canNext = computed(() => {
  if (!vod.value) return false
  return (vod.value.episodeIndex || 0) + 1 < (line.value?.episodes.length || 0)
})

const lineGroups = computed(() => {
  const official: { item: (typeof lines.value)[number]; index: number }[] = []
  const standard: { item: (typeof lines.value)[number]; index: number }[] = []
  lines.value.forEach((item, index) => {
    if (item.official) official.push({ item, index })
    else standard.push({ item, index })
  })
  const groups: { label: string; entries: typeof official }[] = []
  if (official.length) groups.push({ label: `官方线路 ${official.length}`, entries: official })
  if (standard.length) groups.push({ label: `普通线路 ${standard.length}`, entries: standard })
  return groups
})

function formatClock(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds || 0))
  const hours = Math.floor(value / 3600)
  const minutes = Math.floor((value % 3600) / 60)
  const rest = value % 60
  if (hours) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
  }
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}

function lineLabel(name: string, index: number): string {
  if (/[\u4e00-\u9fa5]/.test(name)) return name
  return `线路 ${index + 1}`
}

function is4kLine(name: string): boolean {
  return /4k|2160|uhd/i.test(name)
}

function hostOf(url: string): string {
  if (/^kanju:\/\//i.test(url)) return '看剧AI'
  try {
    return new URL(url, window.location.href).host
  } catch {
    return ''
  }
}

function channelMeta(channel: Channel): string {
  const total = channel.urls?.length || 1
  return total > 1 ? `${channel.group} · ${total} 线路` : channel.group
}

function clearFallback() {
  window.clearTimeout(fallbackTimer)
}

function resetRecovery() {
  lineAttempt = 0
  lineAttemptKey = ''
  kanjuExhausted = false
  recoveries = 0
  recovering = false
  resolveLine.value = null
  triedSources.clear()
}

function tryNextLine(): boolean {
  if (!isLive.value) return false
  const channel = currentChannel.value
  const total = channel?.urls?.length || 1
  if (total <= 1 || !player.nextLine()) return false
  toast.info(`线路不可用，已切换备用线路 ${(player.live?.lineIndex || 0) + 1}/${total}`)
  wake()
  return true
}

function normalizeName(value: string): string {
  return String(value || '')
    .replace(/\[[^\]]*\]|【[^】]*】|\([^)]*\)|（[^）]*）/g, '')
    .replace(/[\s·:：,，。.、!！?？-]/g, '')
    .toLowerCase()
}

function sameTitle(a: string, b: string): boolean {
  const left = normalizeName(a)
  const right = normalizeName(b)
  if (!left || !right) return false
  return left === right || left.includes(right) || right.includes(left)
}

function currentPosition(): number {
  const element = video.value
  if (!element || !Number.isFinite(element.currentTime)) return 0
  return Math.max(0, element.currentTime)
}

function switchVodLine(index: number, position: number): boolean {
  const current = player.vod
  const target = lines.value[index]
  if (!current || !target || !target.episodes.length) return false
  const episodeName = episode.value?.name || ''
  let episodeIndex = Math.min(current.episodeIndex, target.episodes.length - 1)
  if (episodeName) {
    const found = target.episodes.findIndex((item) => item.name === episodeName)
    if (found >= 0) episodeIndex = found
  }
  player.setLine(index)
  current.episodeIndex = episodeIndex
  current.resume = position
  return true
}

function pickEpisode(detail: VodDetail, episodeName: string, fallback: number) {
  if (episodeName) {
    for (let index = 0; index < detail.lines.length; index += 1) {
      const found = detail.lines[index].episodes.findIndex((item) => item.name === episodeName)
      if (found >= 0) return { lineIndex: index, episodeIndex: found }
    }
  }
  let best = 0
  detail.lines.forEach((item, index) => {
    if (item.episodes.length > detail.lines[best].episodes.length) best = index
  })
  const count = detail.lines[best]?.episodes.length || 0
  return {
    lineIndex: best,
    episodeIndex: Math.max(0, Math.min(fallback, count - 1))
  }
}

async function switchToOtherSource(position: number): Promise<boolean> {
  const current = player.vod
  if (!current || switching) return false
  const title = current.detail.name
  if (!title) return false
  switching = true
  try {
    toast.info('当前片源不可用，正在搜索其他片源…')
    const result = await api.search(title)
    const seen = new Set<string>()
    const candidates = result.items.filter((item) => {
      if (item.sourceId === current.detail.sourceId) return false
      if (!sameTitle(item.name, title)) return false
      const key = `${item.sourceId}:${item.id}`
      if (seen.has(key) || triedSources.has(key)) return false
      seen.add(key)
      return true
    })
    const episodeName =
      current.detail.lines[current.lineIndex]?.episodes[current.episodeIndex]?.name || ''
    for (const item of candidates.slice(0, 4)) {
      const key = `${item.sourceId}:${item.id}`
      triedSources.add(key)
      try {
        const next = await api.detail(item.sourceId, item.id)
        if (!next.playable || !next.lines.length) continue
        const picked = pickEpisode(next, episodeName, current.episodeIndex)
        player.openVod(next, picked.lineIndex, picked.episodeIndex, position)
        toast.success(`已自动切换到其他片源：${next.sourceName}`)
        wake()
        return true
      } catch {
        continue
      }
    }
  } catch {
    return false
  } finally {
    switching = false
  }
  return false
}

async function switchToOtherLiveSource(): Promise<boolean> {
  const live = player.live
  if (!live || switching) return false
  const name = player.title
  switching = true
  try {
    const pool = settings.activeLive.filter((item) => item.id !== live.sourceId)
    for (const source of pool.slice(0, 4)) {
      try {
        const data = await api.live(source.id)
        const channel =
          data.channels.find((item) => item.name === name) ||
          data.channels.find((item) => item.name.includes(name) || name.includes(item.name))
        if (!channel) continue
        const index = data.channels.findIndex((item) => item.id === channel.id)
        player.openLive(data.channels, Math.max(0, index), data.sourceName, channel.group, source.id)
        toast.success(`已自动切换到「${source.name}」的同一频道`)
        wake()
        return true
      } catch {
        continue
      }
    }
  } finally {
    switching = false
  }
  return false
}

async function nextVodPlayback(position: number): Promise<boolean> {
  const raw = player.currentUrl
  const pinned = /^kanju:\/\/[^|]*\|/.test(raw)
  if (raw.startsWith('kanju://') && !pinned && !kanjuExhausted && !resolveLine.value?.fixed) {
    const total = resolveLine.value?.total || 0
    const canTry = total ? lineAttempt + 1 < total : lineAttempt < 6
    if (canTry) {
      lineAttempt += 1
      toast.info(
        total
          ? `当前线路不可用，切换到线路 ${lineAttempt + 1}/${total}`
          : '当前线路不可用，正在尝试备用线路'
      )
      void attach()
      return true
    }
  }
  if (player.vod && player.vod.lineIndex + 1 < lines.value.length) {
    if (switchVodLine(player.vod.lineIndex + 1, position)) {
      toast.info('当前线路不可用，已切换备用线路')
      wake()
      return true
    }
  }
  return switchToOtherSource(position)
}

async function handleFailure(): Promise<boolean> {
  if (!player.open || recovering || recoveries >= MAX_RECOVERIES) return false
  recoveries += 1
  recovering = true
  try {
    if (isLive.value) {
      if (tryNextLine()) return true
      return await switchToOtherLiveSource()
    }
    return await nextVodPlayback(currentPosition())
  } finally {
    recovering = false
  }
}

async function recoverOrShow(message: string) {
  if (await handleFailure()) return
  showError(message)
}

function armFallback() {
  clearFallback()
  if (!player.open) return
  fallbackTimer = window.setTimeout(() => {
    if (!player.open || error.value || drawerOpen.value) return
    const element = video.value
    if (element && element.readyState >= 2) return
    if (element && element.paused && element.currentTime > 0) return
    void (async () => {
      if (await handleFailure()) return
      showError(
        isLive.value
          ? '直播线路连接失败，可能已失效，换台或切换片源试试'
          : '视频加载超时，换一条线路或其他片源试试'
      )
    })()
  }, isLive.value ? 15000 : 20000)
}

function clearEngines() {
  clearFallback()
  audioTracks.value = []
  subtitleTracks.value = []
  audioIndex.value = 0
  subtitleIndex.value = -1
  if (hls) {
    hls.destroy()
    hls = null
  }
  if (flv) {
    try {
      flv.destroy()
    } catch {
      /* ignore */
    }
    flv = null
  }
}

function showError(message: string) {
  clearFallback()
  error.value = message
  waiting.value = false
  if (isLive.value) {
    const channel = player.currentChannel
    if (channel) liveStore.reportDown(channel, message)
  }
  wake()
}

function setAudioTrack(index: number) {
  audioIndex.value = index
  if (!hls) return
  hls.audioTrack = index
  toast.info(`已切换音轨：${audioTracks.value[index] || index + 1}`)
  wake()
}

function setSubtitleTrack(index: number) {
  subtitleIndex.value = index
  if (!hls) return
  hls.subtitleTrack = index
  toast.info(index < 0 ? '已关闭字幕' : `已切换字幕：${subtitleTracks.value[index] || index + 1}`)
  wake()
}

async function switchSourceNow() {
  resetRecovery()
  error.value = ''
  waiting.value = true
  if (await switchToOtherSource(currentPosition())) {
    wake()
    return
  }
  showError('其他片源也没能播起来，可以换个片源搜索同名作品')
}

async function copyPlaybackUrl() {
  const raw = player.currentUrl
  if (!raw) {
    toast.error('没有可复制的播放地址')
    return
  }
  const copied = await copyText(raw.startsWith('kanju://') ? raw : mediaUrl(raw))
  if (copied) toast.success('播放地址已复制，可在浏览器里直接打开验证')
  else toast.error('复制失败，请长按选中地址手动复制')
}

function retryPlayback() {
  resetRecovery()
  error.value = ''
  void attach()
}

async function startPlayback() {
  const element = video.value
  if (!element) return
  try {
    await element.play()
    return
  } catch {
    /* 浏览器可能拦截有声自动播放，静音后重试一次 */
  }
  if (!element.muted) {
    element.muted = true
    muted.value = true
    try {
      await element.play()
      toast.info('已自动静音播放，点击音量按钮或按 M 恢复声音')
      return
    } catch {
      /* 需要用户手动点击 */
    }
  }
  controlsVisible.value = true
  waiting.value = false
}

async function attach() {
  const element = video.value
  if (!element) return
  const token = ++attachToken
  clearEngines()
  element.volume = volume.value
  element.muted = muted.value || volume.value === 0
  error.value = ''
  waiting.value = true
  duration.value = 0
  position.value = 0
  saveMark = 0
  resumeTarget = player.kind === 'vod' ? player.consumeResume() : 0
  let networkRetries = 0

  const raw = player.currentUrl
  if (!raw) {
    showError('没有可播放的地址')
    return
  }
  if (raw !== lineAttemptKey) {
    lineAttemptKey = raw
    lineAttempt = 0
    kanjuExhausted = false
    resolveLine.value = null
  }
  let url = ''
  try {
    if (raw.startsWith('kanju://')) {
      const info = await api.resolvePlayback(raw, lineAttempt)
      url = info.url
      resolveLine.value = {
        name: info.name,
        index: info.index,
        total: info.total,
        fixed: info.fixed === true
      }
    } else {
      url = mediaUrl(raw)
    }
  } catch (caught) {
    if (token !== attachToken) return
    const message = caught instanceof Error ? caught.message : '播放地址解析失败，请稍后重试'
    if (message.includes('没有更多可用线路')) kanjuExhausted = true
    if (await handleFailure()) return
    showError(message)
    return
  }
  if (token !== attachToken || !player.open) return
  if (!url) {
    showError('播放地址无效')
    return
  }

  element.removeAttribute('src')
  element.load()
  armFallback()

  if (url.includes('.m3u8')) {
    if (element.canPlayType('application/vnd.apple.mpegurl')) {
      element.src = url
      void startPlayback()
    } else {
      try {
        hlsLib = hlsLib || (await import('hls.js')).default
      } catch {
        showError('播放组件加载失败，请检查网络后重试')
        return
      }
      if (token !== attachToken || !player.open) return
      const HlsCtor = hlsLib
      if (!HlsCtor.isSupported()) {
        showError('当前浏览器不支持 HLS 播放')
        return
      }
      const live = isLive.value
      const instance = new HlsCtor({
        lowLatencyMode: live,
        backBufferLength: live ? 30 : 90,
        maxBufferLength: live ? 20 : 40,
        // 原生壳里 XHR 走 CapacitorHttp 桥接，worker 内的请求无法被代理
        enableWorker: !runtime.native
      })
      hls = instance
      instance.loadSource(url)
      instance.attachMedia(element)
      instance.on(HlsCtor.Events.MANIFEST_PARSED, () => {
        audioTracks.value = instance.audioTracks.map(
          (track, index) => track.name || track.lang || `音轨 ${index + 1}`
        )
        subtitleTracks.value = instance.subtitleTracks.map(
          (track, index) => track.name || track.lang || `字幕 ${index + 1}`
        )
        audioIndex.value = instance.audioTrack >= 0 ? instance.audioTrack : 0
        subtitleIndex.value = instance.subtitleTrack
        void startPlayback()
      })
      instance.on(HlsCtor.Events.ERROR, (_event, data) => {
        if (!data.fatal) return
        if (data.type === HlsCtor.ErrorTypes.NETWORK_ERROR && networkRetries < 2) {
          networkRetries += 1
          instance.startLoad()
          return
        }
        if (data.type === HlsCtor.ErrorTypes.MEDIA_ERROR && networkRetries < 2) {
          networkRetries += 1
          instance.recoverMediaError()
          return
        }
        if (hls !== instance) return
        if (live && tryNextLine()) return
        void recoverOrShow(
          live
            ? '直播线路连接失败，可能已失效，换台或切换片源试试'
            : `视频加载失败（${data.details || '未知错误'}）`
        )
      })
    }
    return
  }

  if (url.includes('.flv')) {
    try {
      flvLib = flvLib || (await import('flv.js')).default
    } catch {
      showError('播放组件加载失败，请检查网络后重试')
      return
    }
    if (token !== attachToken || !player.open) return
    if (!flvLib.isSupported()) {
      showError('当前浏览器不支持 FLV 播放')
      return
    }
    flv = flvLib.createPlayer({
      type: 'flv',
      url,
      isLive: isLive.value,
      hasAudio: true,
      hasVideo: true
    })
    flv.attachMediaElement(element)
    const instance = flv
    flv.on(flvLib.Events.ERROR, () => {
      if (flv !== instance) return
      if (isLive.value && tryNextLine()) return
      void recoverOrShow('FLV 流加载失败，可能已失效')
    })
    flv.load()
    void startPlayback()
    return
  }

  element.src = url
  void startPlayback()
}

function onDurationChange() {
  if (isLive.value) {
    duration.value = 0
    return
  }
  duration.value = video.value?.duration || 0
}

function onLoadedMetadata() {
  const element = video.value
  if (!element) return
  waiting.value = false
  duration.value = isLive.value ? 0 : element.duration || 0
  if (resumeTarget > 0 && Number.isFinite(element.duration) && resumeTarget < element.duration - 3) {
    element.currentTime = resumeTarget
    position.value = resumeTarget
  }
  resumeTarget = 0
  if (element.paused && !error.value && player.open) void startPlayback()
}

function onNativeError() {
  if (hls || flv) return
  if (!player.open) return
  if (isLive.value && tryNextLine()) return
  void recoverOrShow(isLive.value ? '直播流加载失败，可能已失效' : '视频加载失败')
}

function onTimeUpdate() {
  const element = video.value
  if (!element) return
  position.value = element.currentTime || 0
  if (!isLive.value && element.duration) duration.value = element.duration
  if (!isLive.value && element.currentTime - saveMark >= 5) {
    saveMark = element.currentTime
    saveProgress(false)
  }
}

function saveProgress(force: boolean) {
  if (player.kind !== 'vod' || !vod.value) return
  const element = video.value
  if (!element || !Number.isFinite(element.duration) || element.duration <= 0) return
  const current = element.currentTime || 0
  if (!force && current < 5) return
  library.saveProgress({
    sourceId: vod.value.detail.sourceId,
    sourceName: vod.value.detail.sourceName,
    id: vod.value.detail.id,
    name: vod.value.detail.name,
    pic: vod.value.detail.pic,
    remarks: vod.value.detail.remarks,
    lineIndex: vod.value.lineIndex,
    episodeIndex: vod.value.episodeIndex,
    episodeName: episode.value?.name || '',
    position: Math.min(current, element.duration),
    duration: element.duration,
    updatedAt: Date.now()
  })
}

function togglePlay() {
  const element = video.value
  if (!element) return
  wake()
  if (element.paused) void startPlayback()
  else element.pause()
}

function seekBy(delta: number) {
  const element = video.value
  if (!element) return
  if (isLive.value) {
    switchChannel(delta > 0 ? 1 : -1)
    return
  }
  if (!Number.isFinite(element.duration)) return
  const next = Math.max(0, Math.min(element.duration - 0.3, element.currentTime + delta))
  element.currentTime = next
  position.value = next
  wake()
}

function seekTo(ratio: number) {
  const element = video.value
  if (!element || isLive.value || !Number.isFinite(element.duration)) return
  const next = Math.max(0, Math.min(element.duration, ratio * element.duration))
  element.currentTime = next
  position.value = next
  wake()
}

function onTimelineInput(event: Event) {
  const value = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(value)) return
  seekTo(value / 1000)
}

function onProgressClick(event: MouseEvent) {
  if (isLive.value) return
  const element = event.currentTarget as HTMLElement
  const rect = element.getBoundingClientRect()
  if (!rect.width) return
  seekTo((event.clientX - rect.left) / rect.width)
}

function switchChannel(delta: number) {
  if (!isLive.value || !channels.value.length) return
  player.shiftChannel(delta)
  const channel = player.currentChannel
  if (channel) toast.info(channel.name)
  wake()
}

function selectChannel(index: number) {
  if (index !== player.live?.index) {
    player.setChannel(index)
    const channel = player.currentChannel
    if (channel) toast.info(channel.name)
  }
  closeDrawer()
  wake()
}

function applyVolume() {
  const element = video.value
  if (!element) return
  element.volume = volume.value
  if (volume.value > 0 && element.muted) {
    element.muted = false
    muted.value = false
  }
}

function setVolume(value: number) {
  volume.value = Math.max(0, Math.min(1, Math.round(value * 100) / 100))
  try {
    window.localStorage.setItem('kaytv.volume', String(volume.value))
  } catch {
    /* ignore */
  }
  applyVolume()
  wake()
}

function stepVolume(delta: number) {
  setVolume(volume.value + delta)
}

function onVolumeInput(event: Event) {
  const value = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(value)) return
  setVolume(value / 100)
}

function restoreVolume() {
  let saved = 1
  try {
    const raw = window.localStorage.getItem('kaytv.volume')
    if (raw !== null) saved = Math.max(0, Math.min(1, Number(raw) || 0))
  } catch {
    /* ignore */
  }
  volume.value = saved
  void nextTick(applyVolume)
}

function toggleMute() {
  const element = video.value
  if (!element) return
  if (element.muted || volume.value === 0) {
    element.muted = false
    muted.value = false
    if (volume.value === 0) setVolume(0.5)
  } else {
    element.muted = true
    muted.value = true
  }
  wake()
}

const volumePercent = computed(() => Math.round(volume.value * 100))
const volumeIcon = computed(() => {
  if (muted.value || volume.value === 0) return 'mute'
  return volume.value <= 0.5 ? 'volume-low' : 'volume'
})

function nextEpisode() {
  if (!vod.value) return
  saveProgress(true)
  resetRecovery()
  if (!player.nextEpisode()) {
    toast.info('已经是最后一集')
    return
  }
  closeDrawer()
  toast.success('播放下一集')
  wake()
}

function selectLine(index: number) {
  if (index === player.vod?.lineIndex) return
  saveProgress(true)
  resetRecovery()
  player.setLine(index)
  void nextTick(() => {
    root.value?.querySelector<HTMLElement>('.drawer-item.is-current')?.focus({ preventScroll: true })
  })
  wake()
}

function selectEpisode(index: number) {
  if (!vod.value) return
  if (index !== vod.value.episodeIndex) {
    saveProgress(true)
    resetRecovery()
    player.setEpisode(vod.value.lineIndex, index)
  }
  closeDrawer()
  wake()
}

function onEnded() {
  if (isLive.value) {
    if (!tryNextLine()) showError('直播已结束')
    return
  }
  saveProgress(true)
  resetRecovery()
  if (player.nextEpisode()) {
    toast.success('播放下一集')
    wake()
  } else {
    toast.info('已经是最后一集')
    wake()
  }
}

function openDrawer() {
  if (drawerOpen.value) return
  drawerOpen.value = true
  drawerQuery.value = ''
  wake()
  void nextTick(() => {
    const current = root.value?.querySelector<HTMLElement>('.drawer-item.is-current')
    const first = root.value?.querySelector<HTMLElement>('.drawer-item')
    ;(current || first)?.focus({ preventScroll: true })
    current?.scrollIntoView({ block: 'center' })
  })
}

function closeDrawer() {
  if (!drawerOpen.value) return
  drawerOpen.value = false
  root.value?.focus({ preventScroll: true })
  wake()
}

function toggleDrawer() {
  if (drawerOpen.value) closeDrawer()
  else openDrawer()
}

function drawerFocus(delta: number) {
  const items = Array.from(
    root.value?.querySelectorAll<HTMLElement>('.drawer-item, .drawer-lines .chip') || []
  )
  if (!items.length) return
  const active = document.activeElement as HTMLElement | null
  let index = active ? items.indexOf(active) : -1
  if (index < 0) {
    const current = root.value?.querySelector<HTMLElement>('.drawer-item.is-current')
    index = current ? Math.max(0, items.indexOf(current)) : 0
  } else {
    index = Math.max(0, Math.min(items.length - 1, index + delta))
  }
  items[index]?.focus({ preventScroll: true })
  items[index]?.scrollIntoView({ block: 'nearest' })
}

function toggleFullscreen() {
  const element = root.value
  if (!element) return
  if (document.fullscreenElement) {
    void document.exitFullscreen()
  } else {
    void element.requestFullscreen?.().catch(() => {
      toast.error('当前设备不支持全屏')
    })
  }
}

function onFullscreenChange() {
  isFullscreen.value = Boolean(document.fullscreenElement)
}

function wake() {
  controlsVisible.value = true
  window.clearTimeout(hideTimer)
  if (!playing.value || drawerOpen.value || error.value) return
  hideTimer = window.setTimeout(() => {
    controlsVisible.value = false
  }, 3800)
}

function onKeydown(event: KeyboardEvent) {
  if (!player.open) return
  const target = event.target as HTMLElement | null
  const typing =
    !!target &&
    (target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT' ||
      target.isContentEditable)

  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    if (drawerOpen.value) closeDrawer()
    else closePlayer()
    return
  }
  if (event.key === 'BrowserBack') {
    event.preventDefault()
    event.stopPropagation()
    if (drawerOpen.value) closeDrawer()
    else closePlayer()
    return
  }
  if (event.key === 'Backspace' && !typing) {
    event.preventDefault()
    event.stopPropagation()
    if (drawerOpen.value) closeDrawer()
    else closePlayer()
    return
  }

  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    if (typing) {
      if (event.key === 'ArrowDown' && drawerOpen.value) {
        event.preventDefault()
        target?.blur()
        void nextTick(() => drawerFocus(1))
      }
      return
    }
    event.preventDefault()
    event.stopPropagation()
    if (!drawerOpen.value) {
      openDrawer()
      return
    }
    drawerFocus(event.key === 'ArrowDown' ? 1 : -1)
    return
  }

  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    if (typing) return
    const delta = event.key === 'ArrowRight' ? 1 : -1
    if (drawerOpen.value) {
      event.preventDefault()
      event.stopPropagation()
      if (isLive.value) switchChannel(delta)
      else drawerFocus(delta)
      return
    }
    event.preventDefault()
    event.stopPropagation()
    seekBy(delta * 15)
    return
  }

  if (event.key === 'Enter' || event.key === ' ') {
    const tag = target?.tagName || ''
    if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || drawerOpen.value) return
    event.preventDefault()
    event.stopPropagation()
    togglePlay()
    return
  }

  if (event.key === 'f' || event.key === 'F') {
    if (typing) return
    event.preventDefault()
    toggleFullscreen()
    return
  }

  if (event.key === '+' || event.key === '=' || event.key === '-' || event.key === '_') {
    if (typing) return
    event.preventDefault()
    stepVolume(event.key === '-' || event.key === '_' ? -0.05 : 0.05)
    return
  }

  if (event.key === 'm' || event.key === 'M') {
    if (typing) return
    event.preventDefault()
    toggleMute()
  }
}

function closePlayer() {
  saveProgress(true)
  const element = video.value
  if (element) element.pause()
  clearEngines()
  player.close()
}

function onPopState() {
  if (!player.open) return
  pushedState = false
  if (drawerOpen.value) closeDrawer()
  closePlayer()
}

function onBeforeUnload() {
  saveProgress(true)
}

function onVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    saveProgress(true)
    resumeAfterHide = playing.value
    return
  }
  wake()
  if (!resumeAfterHide || !player.open) return
  resumeAfterHide = false
  if (error.value) return
  if (isLive.value) {
    void attach()
    return
  }
  const element = video.value
  if (element) void element.play().catch(() => {})
}

watch(
  () => (player.open ? `${player.kind}:${player.vod?.lineIndex ?? 0}:${player.vod?.episodeIndex ?? 0}:${player.currentUrl}` : ''),
  () => {
    if (!player.open) return
    void nextTick(attach)
  }
)

watch(
  () => player.open,
  (open) => {
    if (open) {
      resetRecovery()
      lastFocused = document.activeElement as HTMLElement | null
      document.body.style.overflow = 'hidden'
      if (!pushedState) {
        window.history.pushState({ ...(window.history.state || {}), kaytvPlayer: true }, '')
        pushedState = true
      }
      drawerOpen.value = false
      drawerQuery.value = ''
      error.value = ''
      controlsVisible.value = true
      void nextTick(() => {
        root.value?.focus({ preventScroll: true })
        wake()
      })
    } else {
      window.clearTimeout(hideTimer)
      document.body.style.overflow = ''
      drawerOpen.value = false
      clearEngines()
      if (pushedState) {
        pushedState = false
        window.history.back()
      }
      const target = lastFocused
      lastFocused = null
      if (target && document.contains(target)) {
        void nextTick(() => target.focus({ preventScroll: true }))
      }
    }
  }
)

watch(playing, (value) => {
  if (!value) controlsVisible.value = true
  wake()
})

watch(drawerOpen, () => wake())

onMounted(() => {
  restoreVolume()
  window.addEventListener('popstate', onPopState)
  window.addEventListener('beforeunload', onBeforeUnload)
  document.addEventListener('visibilitychange', onVisibilityChange)
  document.addEventListener('fullscreenchange', onFullscreenChange)
})

onBeforeUnmount(() => {
  window.removeEventListener('popstate', onPopState)
  window.removeEventListener('beforeunload', onBeforeUnload)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  window.clearTimeout(hideTimer)
  clearEngines()
  document.body.style.overflow = ''
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="player.open"
      ref="root"
      class="player-overlay"
      :class="{ 'controls-idle': !controlsVisible || drawerOpen }"
      tabindex="-1"
      @keydown.capture="onKeydown"
      @mousemove="wake"
      @touchstart.passive="wake"
    >
      <video
        ref="video"
        class="player-video"
        playsinline
        webkit-playsinline
        preload="auto"
        :poster="player.poster ? mediaUrl(player.poster) : ''"
        @loadedmetadata="onLoadedMetadata"
        @timeupdate="onTimeUpdate"
        @durationchange="onDurationChange"
        @play="playing = true; waiting = false; clearFallback(); wake()"
        @pause="playing = false; wake()"
        @waiting="waiting = true"
        @playing="waiting = false; error = ''"
        @canplay="waiting = false; clearFallback()"
        @ended="onEnded"
        @error="onNativeError"
        @click="togglePlay"
        @dblclick="toggleFullscreen"
      />

      <div v-if="waiting && !error" class="player-spinner">
        <span class="spinner" />
        <span>{{ isLive ? '正在连接直播…' : '正在加载视频…' }}</span>
      </div>

      <div v-if="error" class="player-error">
        <div class="player-error-card">
          <AppIcon name="warn" :size="30" />
          <h3>播放失败</h3>
          <p>{{ error }}</p>
          <p class="player-error-meta">
            来源 {{ hostOf(player.currentUrl) || '未知地址' }} · 已自动重试 {{ recoveries }} 次
          </p>
          <div class="player-error-actions">
            <button class="btn primary" @click="retryPlayback">重试当前线路</button>
            <button class="btn" @click="openDrawer">{{ isLive ? '切换频道' : '换线路/选集' }}</button>
            <button v-if="!isLive" class="btn" @click="void switchSourceNow()">换个片源</button>
            <button class="btn ghost" @click="void copyPlaybackUrl()">复制播放地址</button>
            <button class="btn ghost" @click="closePlayer">关闭</button>
          </div>
        </div>
      </div>

      <div class="player-chrome player-top" :class="{ hidden: !controlsVisible || drawerOpen }">
        <button class="player-btn round" type="button" aria-label="返回" @click="closePlayer">
          <AppIcon name="back" :size="22" />
        </button>
        <div class="player-heading">
          <div class="player-title-line">
            <span v-if="isLive" class="badge live">直播</span>
            <span v-else class="badge accent">{{ liveBadge }}</span>
            <h2>{{ titleText }}</h2>
          </div>
          <p>{{ subtitleText }}</p>
        </div>
        <div class="player-top-right">
          <span class="player-host">{{ hostOf(player.currentUrl) }}</span>
          <button
            class="player-btn round"
            type="button"
            :aria-label="isFullscreen ? '退出全屏' : '全屏'"
            @click="toggleFullscreen"
          >
            <AppIcon name="fullscreen" :size="20" />
          </button>
          <button class="player-btn round" type="button" aria-label="关闭" @click="closePlayer">
            <AppIcon name="close" :size="22" />
          </button>
        </div>
      </div>

      <div class="player-chrome player-bottom" :class="{ hidden: !controlsVisible || drawerOpen }">
        <div class="player-progress" @click="onProgressClick">
          <div v-if="!isLive" class="progress-track">
            <div class="progress-fill" :style="{ width: `${progressWidth}%` }" />
            <div class="progress-knob" :style="{ left: `${progressWidth}%` }" />
            <input
              class="progress-input"
              type="range"
              min="0"
              max="1000"
              step="1"
              :value="duration ? Math.round((position / duration) * 1000) : 0"
              :disabled="!duration"
              aria-label="播放进度"
              @input="onTimelineInput"
            />
          </div>
          <div v-else class="live-track">
            <span class="live-dot" />
            <span class="live-text">LIVE · {{ currentChannel?.name || titleText }}</span>
            <span v-if="liveLineText" class="live-line">{{ liveLineText }}</span>
          </div>
        </div>

        <div class="player-controls">
          <div class="controls-left">
            <button class="player-btn round" type="button" :aria-label="playing ? '暂停' : '播放'" @click="togglePlay">
              <AppIcon :name="playing ? 'pause' : 'play'" :size="22" />
            </button>
            <template v-if="!isLive">
              <button
                class="player-btn round small"
                type="button"
                aria-label="后退 15 秒"
                @click="seekBy(-15)"
              >
                <span class="seek-label">-15</span>
              </button>
              <button
                class="player-btn round small"
                type="button"
                aria-label="前进 15 秒"
                @click="seekBy(15)"
              >
                <span class="seek-label">+15</span>
              </button>
            </template>
            <template v-else>
              <button
                class="player-btn round small"
                type="button"
                aria-label="上一个频道"
                @click="switchChannel(-1)"
              >
                <AppIcon name="back" :size="18" />
              </button>
              <button
                class="player-btn round small"
                type="button"
                aria-label="下一个频道"
                @click="switchChannel(1)"
              >
                <AppIcon name="right" :size="18" />
              </button>
            </template>
            <div class="volume-group">
              <button
                class="player-btn round small"
                type="button"
                :aria-label="muted || volume === 0 ? '取消静音' : '静音'"
                @click="toggleMute"
              >
                <AppIcon :name="volumeIcon" :size="18" />
              </button>
              <button
                class="player-btn round tiny"
                type="button"
                aria-label="音量减小"
                @click="stepVolume(-0.1)"
              >
                <AppIcon name="minus" :size="13" />
              </button>
              <div class="volume-track">
                <div class="volume-fill" :style="{ width: `${volumePercent}%` }" />
                <input
                  class="volume-input"
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  :value="volumePercent"
                  aria-label="音量"
                  @input="onVolumeInput"
                />
              </div>
              <button
                class="player-btn round tiny"
                type="button"
                aria-label="音量增大"
                @click="stepVolume(0.1)"
              >
                <AppIcon name="plus" :size="13" />
              </button>
              <span class="volume-value">{{ muted || volume === 0 ? '静音' : `${volumePercent}%` }}</span>
            </div>
            <span v-if="!isLive" class="player-clock">{{ clockText }} / {{ durationText }}</span>
          </div>
          <div class="controls-right">
            <button v-if="canNext" class="player-btn pill" type="button" @click="nextEpisode">
              <AppIcon name="right" :size="16" />
              下一集
            </button>
            <button class="player-btn pill" type="button" @click="toggleDrawer">
              <AppIcon :name="isLive ? 'tv' : 'film'" :size="16" />
              {{ isLive ? '频道' : '选集' }}
            </button>
          </div>
        </div>

        <p class="player-hint">
          <span>← → {{ isLive ? '切换频道' : '快退/快进 15 秒' }}</span>
          <span>↑ 打开{{ isLive ? '频道' : '选集' }}列表</span>
          <span>Enter 播放/暂停</span>
          <span>Esc 退出</span>
        </p>
      </div>

      <Transition name="drawer">
        <aside v-if="drawerOpen" class="player-drawer">
          <div class="drawer-head">
            <div>
              <h3>{{ isLive ? '切换频道' : '选集' }}</h3>
              <p>{{ isLive ? `${channels.length} 个频道` : `${lines.length} 条线路 · ${line?.episodes.length || 0} 集` }}</p>
            </div>
            <button class="player-btn round small" type="button" aria-label="关闭列表" @click="closeDrawer">
              <AppIcon name="close" :size="18" />
            </button>
          </div>

          <template v-if="isLive">
            <div class="search-field drawer-search">
              <AppIcon class="search-icon" name="search" :size="16" />
              <input v-model="drawerQuery" class="input" type="search" placeholder="搜索频道" autocomplete="off" />
            </div>
            <div class="drawer-scroll">
              <button
                v-for="entry in drawerChannels"
                :key="entry.channel.id"
                class="drawer-item"
                :class="{ 'is-current': entry.index === player.live?.index }"
                type="button"
                @click="selectChannel(entry.index)"
              >
                <span class="drawer-item-name">{{ entry.channel.name }}</span>
                <span class="drawer-item-meta">{{ channelMeta(entry.channel) }}</span>
              </button>
              <p v-if="!drawerChannels.length" class="drawer-empty">没有匹配的频道</p>
            </div>
          </template>

          <template v-else>
            <div class="drawer-lines">
              <div v-for="group in lineGroups" :key="group.label" class="line-group">
                <p class="line-group-head">
                  {{ group.label }}
                  <span class="line-group-hint">点击即可切换</span>
                </p>
                <div class="line-group-chips">
                  <button
                    v-for="entry in group.entries"
                    :key="`${entry.item.name}-${entry.index}`"
                    class="chip"
                    :class="{ active: entry.index === player.vod?.lineIndex, official: entry.item.official }"
                    :data-line="entry.index"
                    type="button"
                    @click="selectLine(entry.index)"
                  >
                    {{ lineLabel(entry.item.name, entry.index) }}
                    <span v-if="is4kLine(entry.item.name)" class="badge-4k">4K</span>
                    <span v-if="entry.index === player.vod?.lineIndex" class="count current">当前</span>
                    <span v-else class="count">{{ entry.item.episodes.length }} 集</span>
                  </button>
                </div>
              </div>
            </div>
            <div class="drawer-scroll drawer-episodes">
              <button
                v-for="(item, index) in line?.episodes || []"
                :key="`${index}-${item.url}`"
                class="drawer-item episode"
                :class="{ 'is-current': index === player.vod?.episodeIndex }"
                type="button"
                @click="selectEpisode(index)"
              >
                <span class="drawer-item-name">{{ item.name }}</span>
                <span v-if="index === player.vod?.episodeIndex" class="drawer-item-meta">播放中</span>
              </button>
            </div>
          </template>
          <div v-if="audioTracks.length > 1 || subtitleTracks.length" class="drawer-tracks">
            <div v-if="audioTracks.length > 1" class="track-row">
              <p class="track-label">音轨</p>
              <div class="track-chips">
                <button
                  v-for="(name, index) in audioTracks"
                  :key="`audio-${index}`"
                  class="chip"
                  :class="{ active: index === audioIndex }"
                  type="button"
                  @click="setAudioTrack(index)"
                >
                  {{ name }}
                </button>
              </div>
            </div>
            <div v-if="subtitleTracks.length" class="track-row">
              <p class="track-label">字幕</p>
              <div class="track-chips">
                <button
                  class="chip"
                  :class="{ active: subtitleIndex < 0 }"
                  type="button"
                  @click="setSubtitleTrack(-1)"
                >
                  关闭
                </button>
                <button
                  v-for="(name, index) in subtitleTracks"
                  :key="`sub-${index}`"
                  class="chip"
                  :class="{ active: index === subtitleIndex }"
                  type="button"
                  @click="setSubtitleTrack(index)"
                >
                  {{ name }}
                </button>
              </div>
            </div>
          </div>
        </aside>
      </Transition>
    </div>
  </Teleport>
</template>

<style scoped>
.player-overlay {
  position: fixed;
  inset: 0;
  z-index: 300;
  background: #000;
  outline: none;
  user-select: none;
  overflow: hidden;
}

.player-video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}

.player-spinner {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 20px;
  border-radius: 14px;
  background: rgba(10, 12, 16, 0.72);
  border: 1px solid var(--line);
  font-size: 13px;
  color: var(--muted);
  backdrop-filter: blur(10px);
  pointer-events: none;
}

.player-chrome {
  position: absolute;
  left: 0;
  right: 0;
  z-index: 3;
  transition: opacity 0.24s ease;
}
.player-chrome.hidden {
  opacity: 0;
  pointer-events: none;
}

.player-top {
  top: 0;
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 22px clamp(16px, 2.4vw, 36px) 64px;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.82), rgba(0, 0, 0, 0));
}

.player-heading {
  min-width: 0;
  padding-top: 2px;
}
.player-title-line {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.player-title-line h2 {
  margin: 0;
  font-size: clamp(18px, 1.8vw, 24px);
  font-weight: 650;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.player-heading p {
  margin: 6px 0 0;
  font-size: 12.5px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.player-top-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
.player-host {
  max-width: 220px;
  font-size: 11px;
  color: var(--muted-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.player-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  height: 44px;
  padding: 0 16px;
  border-radius: 12px;
  border: 1px solid var(--line-strong);
  background: rgba(18, 21, 28, 0.72);
  color: var(--text);
  font-size: 13px;
  font-weight: 550;
  cursor: pointer;
  outline: none;
  backdrop-filter: blur(12px);
  transition:
    background 0.15s ease,
    box-shadow 0.15s ease,
    transform 0.15s ease;
}
.player-btn:hover {
  background: rgba(40, 46, 60, 0.9);
}
.player-btn:focus {
  border-color: transparent;
  box-shadow: 0 0 0 3px var(--accent);
  transform: scale(1.04);
}
.player-btn.round {
  width: 44px;
  padding: 0;
  border-radius: 50%;
}
.player-btn.round.small {
  width: 38px;
  height: 38px;
}
.player-btn.pill {
  height: 40px;
  border-radius: 999px;
}
.seek-label {
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0;
}

.player-bottom {
  bottom: 0;
  padding: 64px clamp(16px, 2.4vw, 36px) 22px;
  background: linear-gradient(0deg, rgba(0, 0, 0, 0.88), rgba(0, 0, 0, 0));
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.player-progress {
  position: relative;
  height: 18px;
  display: flex;
  align-items: center;
  cursor: pointer;
}
.progress-track {
  position: relative;
  width: 100%;
  height: 5px;
  border-radius: 99px;
  background: rgba(255, 255, 255, 0.2);
}
.progress-fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 99px;
  background: var(--accent);
}
.progress-knob {
  position: absolute;
  top: 50%;
  width: 13px;
  height: 13px;
  margin-left: -6px;
  transform: translateY(-50%);
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 0 3px rgba(229, 9, 20, 0.3);
}
.progress-input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
}
.live-track {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.72);
  letter-spacing: 0.04em;
}
.live-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ff5f5f;
  box-shadow: 0 0 0 4px rgba(255, 95, 95, 0.18);
  animation: livePulse 1.8s ease-in-out infinite;
}
.live-line {
  padding: 2px 8px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.1);
  font-size: 11px;
  color: rgba(255, 255, 255, 0.8);
  letter-spacing: 0;
}
@keyframes livePulse {
  50% {
    opacity: 0.45;
  }
}

.player-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.controls-left,
.controls-right {
  display: flex;
  align-items: center;
  gap: 9px;
}
.player-clock {
  margin-left: 6px;
  font-size: 12.5px;
  color: var(--muted);
}

.volume-group {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px 3px 3px;
  border-radius: 999px;
  border: 1px solid var(--line-strong);
  background: rgba(18, 21, 28, 0.72);
  backdrop-filter: blur(12px);
}
.player-btn.round.tiny {
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--muted);
}
.player-btn.round.tiny:hover {
  color: var(--text);
  background: rgba(255, 255, 255, 0.08);
}
.player-btn.round.tiny:focus {
  color: var(--text);
  box-shadow: 0 0 0 2px var(--accent);
}
.volume-track {
  position: relative;
  width: 92px;
  height: 16px;
  display: flex;
  align-items: center;
  cursor: pointer;
}
.volume-fill {
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  height: 4px;
  border-radius: 99px;
  background: var(--accent);
  pointer-events: none;
}
.volume-track::before {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  height: 4px;
  border-radius: 99px;
  background: rgba(255, 255, 255, 0.22);
}
.volume-input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}
.volume-value {
  min-width: 34px;
  text-align: right;
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.player-hint {
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
  margin: 0;
  font-size: 11px;
  color: rgba(152, 161, 178, 0.72);
}

.player-error {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: grid;
  place-items: center;
  background: rgba(4, 5, 8, 0.82);
  backdrop-filter: blur(6px);
  padding: 20px;
}
.player-error-card {
  width: min(460px, 100%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 32px 28px;
  border-radius: 20px;
  border: 1px solid var(--line);
  background: var(--surface);
  text-align: center;
  color: var(--accent);
}
.player-error-card h3 {
  margin: 6px 0 0;
  font-size: 19px;
  color: var(--text);
}
.player-error-card p {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--muted);
}
.player-error-card .player-error-meta {
  margin-top: 6px;
  font-size: 11.5px;
  color: var(--muted-2);
}
.player-error-actions {
  display: flex;
  gap: 9px;
  flex-wrap: wrap;
  justify-content: center;
  margin-top: 14px;
}

.player-drawer {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 5;
  width: min(430px, 94vw);
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 22px 20px;
  background: rgba(11, 13, 18, 0.97);
  border-left: 1px solid var(--line);
  box-shadow: -20px 0 60px rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(18px);
}
.drawer-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.drawer-head h3 {
  margin: 0;
  font-size: 17px;
  font-weight: 650;
}
.drawer-head p {
  margin: 5px 0 0;
  font-size: 12px;
  color: var(--muted);
}
.drawer-search .input {
  height: 40px;
  padding-left: 40px;
  font-size: 13px;
}
.drawer-search .search-icon {
  left: 13px;
}
.drawer-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-right: 4px;
}
.drawer-lines {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 46vh;
  overflow-y: auto;
  padding-right: 2px;
}
.drawer-tracks {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 30vh;
  overflow-y: auto;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}
.track-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.track-label {
  margin: 0;
  font-size: 11px;
  font-weight: 650;
  color: var(--muted-2);
}
.track-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.track-chips .chip {
  max-width: 100%;
}
.line-group-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 650;
  color: var(--text);
}
.line-group-head .line-group-hint {
  font-size: 10.5px;
  font-weight: 400;
  color: var(--muted-2);
}
.line-group-chips {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
}
.drawer-lines .chip {
  padding: 7px 12px;
}
.drawer-lines .chip.official {
  border-color: rgba(229, 9, 20, 0.35);
}
.badge-4k {
  padding: 1px 5px;
  border-radius: 5px;
  background: rgba(120, 200, 255, 0.16);
  color: #8ecbff;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
}
.count.current {
  font-weight: 650;
  opacity: 0.9;
}
.drawer-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 42px;
  padding: 8px 13px;
  border-radius: 10px;
  border: 1px solid transparent;
  background: rgba(255, 255, 255, 0.035);
  color: var(--text);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  outline: none;
  transition:
    background 0.14s ease,
    box-shadow 0.14s ease;
}
.drawer-item:hover {
  background: rgba(255, 255, 255, 0.08);
}
.drawer-item:focus {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 2px var(--accent);
}
.drawer-item.is-current {
  border-color: rgba(229, 9, 20, 0.5);
  background: rgba(229, 9, 20, 0.1);
  color: var(--accent);
}
.drawer-item-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.drawer-item-meta {
  flex: none;
  font-size: 11px;
  color: var(--muted-2);
}
.drawer-item.is-current .drawer-item-meta {
  color: rgba(229, 9, 20, 0.8);
}
.drawer-episodes {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
  align-content: start;
  gap: 7px;
}
.drawer-episodes .drawer-item {
  min-height: 40px;
}
.drawer-empty {
  margin: 20px 0;
  text-align: center;
  font-size: 12.5px;
  color: var(--muted);
}

.drawer-enter-active,
.drawer-leave-active {
  transition:
    transform 0.22s ease,
    opacity 0.22s ease;
}
.drawer-enter-from,
.drawer-leave-to {
  transform: translateX(24px);
  opacity: 0;
}

@media (max-width: 720px) {
  .player-top {
    padding: 14px 12px 48px;
  }
  .player-top-right .player-host {
    display: none;
  }
  .player-bottom {
    padding: 48px 12px 16px;
  }
  .player-hint {
    display: none;
  }
  .player-btn {
    height: 40px;
    padding: 0 12px;
  }
  .player-btn.round {
    width: 40px;
    padding: 0;
  }
  .player-btn.round.small {
    width: 36px;
    height: 36px;
  }
  .controls-left,
  .controls-right {
    gap: 6px;
  }
  .player-clock {
    display: none;
  }
  .volume-track {
    width: 60px;
  }
  .volume-value {
    display: none;
  }
  .player-btn.round.tiny {
    width: 32px;
    height: 32px;
  }
  .player-drawer {
    width: 100%;
  }
}
</style>

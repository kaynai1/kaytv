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
import { nativeBridge } from '../composables/useNativeBridge'
import { useLiveStore } from '../stores/live'
import type { Channel, PosterItem, VodDetail } from '../types'
import AppIcon from './AppIcon.vue'
import VodInfoPanel from './VodInfoPanel.vue'

const player = usePlayerStore()
const library = useLibraryStore()
const settings = useSettingsStore()
const liveStore = useLiveStore()

const root = ref<HTMLElement | null>(null)
const stage = ref<HTMLElement | null>(null)
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
const menu = ref('')
const drawerTab = ref<'list' | 'sources' | 'info'>('list')
const sourceQuery = ref('')
const sourcePicking = ref('')
const immersive = ref(false)
const portrait = ref(window.innerHeight >= window.innerWidth)
const fillMode = ref<'contain' | 'cover'>('contain')
const rate = ref(1)
const skipIntro = ref(0)
const skipOutro = ref(0)
const gestureHint = ref('')
const brightness = ref(100)
const brightnessHint = ref(false)

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2, 3]
const SKIP_STEPS = [0, 5, 10, 15, 30, 60]
let introSkipped = false
let outroFired = false

let hls: Hls | null = null
let hlsLib: typeof import('hls.js').default | null = null
let flv: any = null
let flvLib: any = null
let attachToken = 0
let resumeTarget = 0
let hideTimer = 0
let fallbackTimer = 0
let stallTimer = 0
let saveMark = 0
let pushedState = false
let resumeAfterHide = false
let lastFocused: HTMLElement | null = null
let lastPlayKey = ''
let gestureStart = { x: 0, y: 0, at: 0 }
let longPressTimer = 0
let longPressActive = false
let swipeMoved = false
let controlsShownAtTouch = true
let lastTapAt = 0
let singleTapTimer = 0
let hintTimer = 0
let brightnessTimer = 0
let brightnessDrag: { y: number; value: number } | null = null
let brightnessMoved = false

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

/** 手机竖屏打开片子：画面缩到上面 16:9，下面走详情/线路/选集/推荐，和主流追剧 App 一致 */
const sheetMode = computed(
  () =>
    runtime.native &&
    !settings.tvMode &&
    !isLive.value &&
    !!vod.value &&
    portrait.value &&
    !isFullscreen.value
)

/** 手势只给手机/平板，TV 大屏模式和电脑端继续用进度条与方向键 */
const phoneGestures = computed(() => runtime.native && !settings.tvMode)

/** 暂停后只留中间的播放键，播放时它跟着控件一起淡出 */
const centerPlayVisible = computed(
  () =>
    !error.value &&
    !waiting.value &&
    !drawerOpen.value &&
    !menu.value &&
    (!playing.value || controlsVisible.value)
)

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

const drawerTitle = computed(() => {
  if (drawerTab.value === 'sources') return isLive.value ? '播放源' : '线路与片源'
  if (drawerTab.value === 'info') return '详情'
  return isLive.value ? '切换频道' : '选集'
})

const drawerMeta = computed(() => {
  if (drawerTab.value === 'sources') {
    if (isLive.value) return `${liveSources.value.length} 个直播源 · 当前「${player.live?.sourceName || '未知'}」`
    return `${lines.value.length} 条线路 · 当前片源「${vod.value?.detail.sourceName || '未知'}」`
  }
  if (drawerTab.value === 'info') return vod.value?.detail.name || ''
  if (isLive.value) return `${channels.value.length} 个频道`
  return `${line.value?.episodes.length || 0} 集 · 第 ${(vod.value?.episodeIndex || 0) + 1} 集`
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

/** 换线/换源时元素进度可能还没落到新地址上，待恢复的目标位置要一起带上 */
function pendingPosition(): number {
  return Math.max(currentPosition(), resumeTarget)
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
  current.resume = Math.max(position, resumeTarget)
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
    return await nextVodPlayback(pendingPosition())
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

/** 已经拿到元数据之后才会卡住：断流时不会再触发 error，只能靠有没有画面推进来判断 */
function clearStall() {
  if (!stallTimer) return
  window.clearTimeout(stallTimer)
  stallTimer = 0
}

function onWaiting() {
  waiting.value = true
  clearStall()
  if (!player.open) return
  stallTimer = window.setTimeout(() => {
    stallTimer = 0
    if (!player.open || error.value || drawerOpen.value || !waiting.value) return
    const element = video.value
    if (element && element.readyState >= 3 && !element.paused) return
    void (async () => {
      if (await handleFailure()) return
      showError(
        isLive.value
          ? '直播流卡住没有画面，换台或切换直播源试试'
          : '这条线路一直卡住，请在播放源里换个片源或线路'
      )
    })()
  }, isLive.value ? 12000 : 20000)
}

function clearEngines() {
  clearFallback()
  clearStall()
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
  if (await switchToOtherSource(pendingPosition())) {
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
    /* 自动播放被拦时不再退化成静音，露出控制条让用户点一下画面 */
  }
  waiting.value = false
  playing.value = false
  controlsVisible.value = true
  toast.info('浏览器拦住了有声自动播放，点一下画面即可继续，不会再自动静音')
}

async function attach() {
  const element = video.value
  if (!element) return
  const token = ++attachToken
  clearEngines()
  applyVolume()
  element.muted = muted.value || volume.value === 0
  element.playbackRate = rate.value
  element.defaultPlaybackRate = rate.value
  introSkipped = false
  outroFired = false
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
  applyRate()
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
  if (!isLive.value && element.duration) {
    duration.value = element.duration
    handleSkip(element)
  }
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
  if (element.paused) {
    void startPlayback()
    if (phoneGestures.value) flashHint('继续播放')
  } else {
    element.pause()
    if (phoneGestures.value) flashHint('已暂停')
  }
}

/* ---------- 手机手势：左右划 15 秒、长按 2 倍速、双击暂停、单击收放控件 ---------- */

function flashHint(text: string, hold = 900) {
  gestureHint.value = text
  window.clearTimeout(hintTimer)
  hintTimer = window.setTimeout(() => {
    gestureHint.value = ''
  }, hold)
}

function stopLongPress() {
  window.clearTimeout(longPressTimer)
  longPressTimer = 0
}

function releaseLongPress() {
  if (!longPressActive) return
  longPressActive = false
  applyRate()
  flashHint(rate.value === 1 ? '已恢复常速' : `已恢复 ${rate.value}x`, 700)
}

/* ---------- 亮度：左半屏竖划调本窗口亮度，退出播放交还系统 ---------- */

const useNativeBrightness = computed(
  () => typeof nativeBridge()?.setWindowBrightness === 'function'
)

function applyBrightness() {
  if (useNativeBrightness.value) nativeBridge()?.setWindowBrightness(brightness.value)
}

/** 退出播放交还系统亮度，否则整个 App 都被压在最后一档 */
function releaseBrightness() {
  if (useNativeBrightness.value) nativeBridge()?.setWindowBrightness(-1)
}

function setBrightness(value: number) {
  const next = Math.max(2, Math.min(100, Math.round(value)))
  if (next === brightness.value) return
  brightness.value = next
  applyBrightness()
}

function showBrightnessHint() {
  brightnessHint.value = true
  window.clearTimeout(brightnessTimer)
  brightnessTimer = window.setTimeout(() => {
    brightnessHint.value = false
  }, 900)
}

/** 进播放器先对齐系统亮度；自动亮度读不到就不接管窗口，等用户真去划再压暗 */
function syncBrightness() {
  if (!useNativeBrightness.value) return
  const system = nativeBridge()?.getSystemBrightness?.() ?? -1
  if (system < 0) {
    brightness.value = 100
    return
  }
  brightness.value = Math.max(2, Math.min(100, system))
  applyBrightness()
}

/** 左半屏竖划调亮度：上划更亮、下划更暗；接管后返回 true，免得 touchend 又当成快进 */
function tryBrightnessDrag(touch: Touch, dx: number, dy: number, event: TouchEvent): boolean {
  const rect = stage.value?.getBoundingClientRect()
  if (!rect) return false
  if (!brightnessDrag) {
    if (Math.abs(dy) < 14 || Math.abs(dy) <= Math.abs(dx) * 1.3) return false
    if (gestureStart.x - rect.left > rect.width * 0.45) return false
    stopLongPress()
    brightnessDrag = { y: gestureStart.y, value: brightness.value }
  }
  if (event.cancelable) event.preventDefault()
  const span = Math.max(200, rect.height * 0.8)
  setBrightness(brightnessDrag.value + ((brightnessDrag.y - touch.clientY) / span) * 100)
  brightnessMoved = true
  showBrightnessHint()
  return true
}

function onStageTouchStart(event: TouchEvent) {
  if (!phoneGestures.value || event.touches.length !== 1) return
  const target = event.target as HTMLElement | null
  if (target?.closest('button, input, .player-error, .player-spinner')) return
  const touch = event.touches[0]
  gestureStart = { x: touch.clientX, y: touch.clientY, at: Date.now() }
  controlsShownAtTouch = controlsVisible.value
  swipeMoved = false
  brightnessDrag = null
  brightnessMoved = false
  longPressActive = false
  stopLongPress()
  if (isLive.value || error.value) return
  longPressTimer = window.setTimeout(() => {
    const element = video.value
    if (!element || element.paused) return
    longPressActive = true
    element.playbackRate = 2
    flashHint('2 倍速播放中', 1400)
  }, 460)
}

function onStageTouchMove(event: TouchEvent) {
  if (!phoneGestures.value || event.touches.length !== 1) return
  const touch = event.touches[0]
  const dx = touch.clientX - gestureStart.x
  const dy = touch.clientY - gestureStart.y
  if (longPressActive) {
    if (Math.abs(dx) > 18 || Math.abs(dy) > 18) releaseLongPress()
    return
  }
  if (tryBrightnessDrag(touch, dx, dy, event)) return
  if (Math.abs(dx) < 12 || Math.abs(dx) <= Math.abs(dy) * 1.2) return
  stopLongPress()
  if (isLive.value) return
  swipeMoved = true
  if (event.cancelable) event.preventDefault()
  const base = video.value?.currentTime || position.value
  const target = Math.max(0, Math.min(Math.max(0, duration.value - 0.3), base + (dx > 0 ? 15 : -15)))
  flashHint(`${dx > 0 ? '快进' : '快退'} 15 秒 · ${formatClock(target)}`, 600)
}

function onStageTouchEnd(event: TouchEvent) {
  if (!phoneGestures.value) return
  stopLongPress()
  const touch = event.changedTouches[0]
  const dx = touch ? touch.clientX - gestureStart.x : 0
  const dy = touch ? touch.clientY - gestureStart.y : 0
  const elapsed = Date.now() - gestureStart.at
  if (longPressActive) {
    releaseLongPress()
    return
  }
  if (brightnessMoved) {
    brightnessDrag = null
    brightnessMoved = false
    showBrightnessHint()
    return
  }
  if (swipeMoved || Math.abs(dx) > 44) {
    swipeMoved = false
    if (!isLive.value) {
      const delta = dx > 0 ? 15 : -15
      seekBy(delta)
      flashHint(delta > 0 ? '快进 15 秒' : '快退 15 秒', 700)
    }
    return
  }
  if (Math.abs(dx) > 12 || Math.abs(dy) > 12 || elapsed > 650) return
  const now = Date.now()
  if (now - lastTapAt < 320) {
    window.clearTimeout(singleTapTimer)
    lastTapAt = 0
    togglePlay()
    return
  }
  lastTapAt = now
  singleTapTimer = window.setTimeout(() => {
    lastTapAt = 0
    if (drawerOpen.value || menu.value) return
    if (controlsShownAtTouch) {
      controlsVisible.value = false
      window.clearTimeout(hideTimer)
    } else {
      wake()
    }
  }, 280)
}

function onStageTouchCancel() {
  stopLongPress()
  releaseLongPress()
  swipeMoved = false
  brightnessDrag = null
  brightnessMoved = false
}

function onVideoClick() {
  if (phoneGestures.value) return
  togglePlay()
}

function onVideoDoubleClick() {
  if (phoneGestures.value) return
  toggleFullscreen()
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

/* ---------- 音量：手机与电视端直接读写系统媒体音量，音量键和界面里的条是同一个 ---------- */
const useSystemVolume = computed(
  () => runtime.native && typeof nativeBridge()?.getSystemVolume === 'function'
)

function applyVolume() {
  const element = video.value
  if (useSystemVolume.value) {
    // 元素音量顶满，响度只由系统决定，两级音量叠在一起会让每一格都越调越小
    if (element) element.volume = 1
    nativeBridge()?.setSystemVolume(Math.round(volume.value * 100))
  } else if (element) {
    element.volume = volume.value
  }
  if (volume.value > 0 && element?.muted) {
    element.muted = false
    muted.value = false
  }
}

function setVolume(value: number) {
  volume.value = Math.max(0, Math.min(1, Math.round(value * 100) / 100))
  if (!useSystemVolume.value) {
    try {
      window.localStorage.setItem('kaytv.volume', String(volume.value))
    } catch {
      /* ignore */
    }
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

/** 音量键、通知栏滑块改完之后系统回推，这里只跟着刷新，不再写回去 */
function onSystemVolume(event: Event) {
  const percent = (event as CustomEvent<number>).detail
  if (!Number.isFinite(percent)) return
  const next = Math.max(0, Math.min(1, Math.round(percent) / 100))
  if (Math.abs(next - volume.value) < 0.005) return
  volume.value = next
  const element = video.value
  if (next > 0) {
    muted.value = false
    if (element) element.muted = false
  }
}

function restoreVolume() {
  const systemPercent = useSystemVolume.value ? nativeBridge()?.getSystemVolume() ?? -1 : -1
  if (systemPercent >= 0) {
    volume.value = Math.max(0, Math.min(1, systemPercent / 100))
    muted.value = false
  } else {
    let saved = 1
    try {
      const raw = window.localStorage.getItem('kaytv.volume')
      if (raw !== null) saved = Math.max(0, Math.min(1, Number(raw) || 0))
    } catch {
      /* ignore */
    }
    volume.value = saved
  }
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

function readStored(key: string): string {
  try {
    return window.localStorage.getItem(key) || ''
  } catch {
    return ''
  }
}

function persist(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}

/* ---------- 倍速 ---------- */
function applyRate() {
  const element = video.value
  if (!element) return
  element.playbackRate = rate.value
  element.defaultPlaybackRate = rate.value
}

function setRate(value: number) {
  rate.value = value
  persist('kaytv.rate', String(value))
  applyRate()
  closeMenu()
  toast.info(value === 1 ? '已恢复常速播放' : `播放速度 ${value}x`)
  wake()
}

function restoreRate() {
  const saved = Number(readStored('kaytv.rate'))
  if (Number.isFinite(saved) && RATES.includes(saved)) rate.value = saved
}

const rateText = computed(() => (rate.value === 1 ? '倍速' : `${rate.value}x`))

/* ---------- 片头 / 片尾跳过 ---------- */
function setSkip(kind: 'intro' | 'outro', seconds: number) {
  if (kind === 'intro') skipIntro.value = seconds
  else skipOutro.value = seconds
  persist(
    'kaytv.skip',
    JSON.stringify({ intro: skipIntro.value, outro: skipOutro.value })
  )
  closeMenu()
  toast.info(
    seconds
      ? `已设置跳过${kind === 'intro' ? '片头' : '片尾'} ${seconds} 秒`
      : `已取消跳过${kind === 'intro' ? '片头' : '片尾'}`
  )
  wake()
}

function restoreSkip() {
  try {
    const saved = JSON.parse(readStored('kaytv.skip') || '{}') as {
      intro?: number
      outro?: number
    }
    skipIntro.value = Number(saved.intro) || 0
    skipOutro.value = Number(saved.outro) || 0
  } catch {
    /* ignore */
  }
}

function skipText(kind: 'intro' | 'outro'): string {
  const value = kind === 'intro' ? skipIntro.value : skipOutro.value
  return value ? `${kind === 'intro' ? '头' : '尾'} ${value}s` : '片头/尾'
}

function handleSkip(element: HTMLVideoElement) {
  const intro = skipIntro.value
  const outro = skipOutro.value
  if (!intro && !outro) return
  const current = element.currentTime
  if (intro > 0 && !introSkipped) {
    if (element.duration > intro * 2 && current < intro) {
      introSkipped = true
      element.currentTime = intro
      toast.info('已跳过片头')
    } else if (current >= intro) {
      introSkipped = true
    }
  }
  if (outro > 0 && !outroFired && current > intro && element.duration - current <= outro) {
    outroFired = true
    if (canNext.value) {
      toast.info('已跳过片尾，播放下一集')
      nextEpisode()
    } else {
      element.currentTime = Math.max(0, element.duration - 0.2)
      element.pause()
      toast.info('已跳到本片结尾')
    }
  }
}

/* ---------- 画面填充 ---------- */
function toggleFill() {
  fillMode.value = fillMode.value === 'contain' ? 'cover' : 'contain'
  persist('kaytv.fill', fillMode.value)
  closeMenu()
  toast.info(fillMode.value === 'cover' ? '画面已铺满（边缘会被裁掉）' : '画面按原始比例完整显示')
  wake()
}

function restoreFill() {
  fillMode.value = readStored('kaytv.fill') === 'cover' ? 'cover' : 'contain'
}

/* ---------- 小窗 / 投屏 ---------- */
const canPip = computed(() => Boolean((document as Document & { pictureInPictureEnabled?: boolean }).pictureInPictureEnabled))
const canCast = computed(
  () =>
    (runtime.native && !settings.tvMode) ||
    typeof (document as Document & { getAvailableMediaSinks?: unknown }).getAvailableMediaSinks ===
      'function'
)

function togglePip() {
  const element = video.value as
    | (HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> })
    | null
  if (!element) return
  if (document.pictureInPictureElement) {
    void document.exitPictureInPicture().catch(() => {})
    return
  }
  if (!element.requestPictureInPicture) {
    toast.error('当前设备不支持小窗播放')
    return
  }
  void element.requestPictureInPicture().catch(() => toast.error('小窗播放失败，先暂停再试一次'))
  wake()
}

function openCast() {
  const element = video.value as
    | (HTMLVideoElement & { remote?: { prompt?: () => Promise<unknown> } })
    | null
  if (element?.remote?.prompt) {
    void element.remote.prompt().catch(() => toast.error('没有发现可投屏设备'))
    wake()
    return
  }
  if (runtime.native && nativeBridge()?.openCastPanel?.()) {
    toast.info('已打开系统投屏面板，选中电视后镜像本屏幕；投屏期间请把 KayTV 留在前台播放')
    wake()
    return
  }
  toast.info(
    runtime.native
      ? '这台设备没有可用的系统投屏面板，可以「复制播放地址」用电视浏览器打开，或直接装电视端'
      : '当前设备没有可用的投屏通道，建议用电视端或 HDMI'
  )
  wake()
}

/* ---------- 菜单 ---------- */
function toggleMenu(name: string) {
  menu.value = menu.value === name ? '' : name
  wake()
}

function closeMenu() {
  menu.value = ''
}

/* ---------- 播放源 ---------- */
const vodSources = computed(() => settings.activeVod)
const liveSources = computed(() => settings.activeLive)
const currentSourceId = computed(
  () => (isLive.value ? player.live?.sourceId || '' : vod.value?.detail.sourceId || '') || ''
)

function filterSources(list: { id: string; name: string }[]) {
  const keyword = sourceQuery.value.trim().toLowerCase()
  if (!keyword) return list
  return list.filter((item) => item.name.toLowerCase().includes(keyword))
}

const sourceOptions = computed(() =>
  filterSources(isLive.value ? liveSources.value : vodSources.value)
)

async function pickVodSource(sourceId: string, sourceName: string) {
  const current = player.vod
  if (!current || sourcePicking.value) return
  if (sourceId === current.detail.sourceId) {
    toast.info(`当前就是「${sourceName}」在播`)
    return
  }
  const title = current.detail.name
  if (!title) return
  sourcePicking.value = sourceId
  const position = currentPosition()
  try {
    const result = await api.search(title, [sourceId])
    const hit = result.items.find((item) => sameTitle(item.name, title))
    if (!hit) {
      toast.error(`「${sourceName}」没有搜到这部片`)
      return
    }
    const next = await api.detail(hit.sourceId, hit.id)
    if (!next.playable || !next.lines.length) {
      toast.error(`「${sourceName}」搜到了但没有可播线路`)
      return
    }
    const episodeName =
      current.detail.lines[current.lineIndex]?.episodes[current.episodeIndex]?.name || ''
    const picked = pickEpisode(next, episodeName, current.episodeIndex)
    saveProgress(true)
    resetRecovery()
    error.value = ''
    player.openVod(next, picked.lineIndex, picked.episodeIndex, position)
    toast.success(`已切换到片源「${next.sourceName}」`)
    closeDrawer()
  } catch {
    toast.error(`「${sourceName}」连接失败，换一个试试`)
  } finally {
    sourcePicking.value = ''
  }
  wake()
}

async function pickLiveSource(sourceId: string, sourceName: string) {
  const live = player.live
  if (!live || sourcePicking.value) return
  if (sourceId === live.sourceId) {
    toast.info(`当前就是「${sourceName}」在播`)
    return
  }
  const name = player.title
  sourcePicking.value = sourceId
  try {
    const data = await api.live(sourceId)
    const channel =
      data.channels.find((item) => item.name === name) ||
      data.channels.find((item) => item.name.includes(name) || name.includes(item.name))
    if (!channel) {
      toast.error(`「${sourceName}」里没有这个频道`)
      return
    }
    const index = data.channels.findIndex((item) => item.id === channel.id)
    resetRecovery()
    error.value = ''
    player.openLive(data.channels, Math.max(0, index), data.sourceName, channel.group, sourceId)
    toast.success(`已切换到直播源「${data.sourceName}」`)
    closeDrawer()
  } catch {
    toast.error(`「${sourceName}」连接失败，换一个试试`)
  } finally {
    sourcePicking.value = ''
  }
  wake()
}

function selectSource(sourceId: string, sourceName: string) {
  if (isLive.value) void pickLiveSource(sourceId, sourceName)
  else void pickVodSource(sourceId, sourceName)
}

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

/** 详情面板里的「猜你喜欢」：先取详情再换片，取不到就退回提示，不打断当前播放 */
async function playRelated(item: PosterItem) {
  if (!item?.sourceId || !item?.id) return
  try {
    const detail = await api.detail(item.sourceId, item.id)
    if (!detail || !detail.playable) {
      toast.error('这部片暂时播不了，换个源试试')
      return
    }
    saveProgress(true)
    resetRecovery()
    player.openVod(detail, 0, 0, 0)
    closeDrawer()
  } catch {
    toast.error('详情加载失败，换个片源试试')
  }
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

function openDrawer(tab?: 'list' | 'sources' | 'info') {
  if (tab) drawerTab.value = tab
  closeMenu()
  if (drawerOpen.value) {
    wake()
    return
  }
  drawerOpen.value = true
  drawerQuery.value = ''
  wake()
  void nextTick(() => {
    const current = root.value?.querySelector<HTMLElement>('.drawer-item.is-current')
    const first = root.value?.querySelector<HTMLElement>('.drawer-item, .player-drawer .chip')
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

function toggleDrawer(tab: 'list' | 'sources' | 'info') {
  if (drawerOpen.value && drawerTab.value === tab) closeDrawer()
  else openDrawer(tab)
}

function drawerFocus(delta: number) {
  const items = Array.from(
    root.value?.querySelectorAll<HTMLElement>('.drawer-item, .player-drawer .chip') || []
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

interface SystemBarsPlugin {
  hide?: (options: { bar: string }) => Promise<unknown>
  show?: (options: { bar: string }) => Promise<unknown>
}

function setSystemBarsHidden(hidden: boolean) {
  const native = nativeBridge()
  if (native?.setImmersive) {
    try {
      native.setImmersive(hidden)
      return
    } catch {
      /* 老版本原生层没有这个方法时退回 Capacitor 插件 */
    }
  }
  const capacitor = (window as { Capacitor?: { Plugins?: Record<string, SystemBarsPlugin> } })
    .Capacitor
  const bars = capacitor?.Plugins?.SystemBars
  const action = bars?.[hidden ? 'hide' : 'show']
  if (!action) return
  try {
    void action.call(bars, { bar: '' }).catch(() => {})
  } catch {
    /* ignore */
  }
}

async function lockOrientation(value: 'landscape' | 'any') {
  // 原生方向锁最可靠：安卓 WebView 的 screen.orientation.lock 在非真全屏时经常被忽略
  const native = nativeBridge()
  if (native?.setOrientation) {
    try {
      native.setOrientation(value)
      return
    } catch {
      /* 老版本原生层没有这个方法时退回 Web API */
    }
  }
  const orientation = screen.orientation as
    | (ScreenOrientation & { lock?: (target: string) => Promise<void> })
    | undefined
  if (!orientation?.lock) return
  try {
    await orientation.lock.call(orientation, value)
  } catch {
    /* 系统未授权时保持当前方向 */
  }
}

function enterFullscreen(lock = true) {
  if (runtime.native) {
    immersive.value = true
    isFullscreen.value = true
    setSystemBarsHidden(true)
    if (lock) void lockOrientation('landscape')
    return
  }
  const element = root.value
  if (!element) return
  void element
    .requestFullscreen({ navigationUI: 'hide' })
    .catch(() => toast.error('当前设备不支持全屏'))
}

function exitFullscreen() {
  if (immersive.value) {
    immersive.value = false
    isFullscreen.value = false
    setSystemBarsHidden(false)
    void lockOrientation('any')
    return
  }
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
}

function toggleFullscreen() {
  if (immersive.value || document.fullscreenElement) exitFullscreen()
  else enterFullscreen()
  wake()
}

function onFullscreenChange() {
  if (!immersive.value) isFullscreen.value = Boolean(document.fullscreenElement)
}

function onResize() {
  portrait.value = window.innerHeight >= window.innerWidth
}

/* 手机上横过来就自动铺满，回到竖屏再看下面的选集和推荐 */
watch(portrait, (upright) => {
  if (upright || !player.open || isLive.value || isFullscreen.value) return
  if (runtime.native && !settings.tvMode) enterFullscreen(false)
})

function wake() {
  controlsVisible.value = true
  window.clearTimeout(hideTimer)
  if (drawerOpen.value || error.value || menu.value) return
  // 手机暂停后控件也要收起，只留中间的大播放键；电脑/TV 暂停时保持原来的常驻控件
  if (!playing.value && !phoneGestures.value) return
  hideTimer = window.setTimeout(() => {
    // 遥控器还停在控制条上时先别收，否则焦点会被一起藏掉
    if (controlsFocused()) {
      wake()
      return
    }
    controlsVisible.value = false
  }, 3800)
}

/** 焦点是否落在播放器内的按钮/列表上（视频画面本身不算） */
function controlsFocused(): boolean {
  const active = document.activeElement as HTMLElement | null
  return !!active && active !== root.value && !!active.closest('.player-overlay')
}

/** 电视遥控器向下键进入控制条，先落在播放/暂停上 */
function focusControls() {
  controlsVisible.value = true
  wake()
  void nextTick(() => {
    const first = root.value?.querySelector<HTMLElement>('.player-controls [data-nav]')
    first?.focus({ preventScroll: true })
  })
}

function goBack() {
  if (menu.value) {
    closeMenu()
    return
  }
  if (drawerOpen.value) {
    closeDrawer()
    return
  }
  closePlayer()
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
    goBack()
    return
  }
  if (event.key === 'BrowserBack') {
    event.preventDefault()
    event.stopPropagation()
    goBack()
    return
  }
  if (event.key === 'Backspace' && !typing) {
    event.preventDefault()
    event.stopPropagation()
    goBack()
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
    // 焦点已经在控制条/菜单上时交给空间导航，遥控器才能在按钮之间走
    if (!drawerOpen.value && controlsFocused()) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'ArrowDown' && settings.tvMode && !drawerOpen.value) {
      focusControls()
      return
    }
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
    if (controlsFocused()) return
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
    return
  }

  if (event.key === 'MediaPlayPause' || event.key === 'MediaPlay' || event.key === 'MediaPause') {
    event.preventDefault()
    if (event.key === 'MediaPlay' && !playing.value) togglePlay()
    else if (event.key === 'MediaPause' && playing.value) togglePlay()
    else if (event.key === 'MediaPlayPause') togglePlay()
  }
}

/** 遥控器上的播放/暂停/上下一曲由原生层转过来 */
function onMediaKey(event: Event) {
  if (!player.open) return
  const action = (event as CustomEvent<string>).detail
  if (action === 'play') {
    if (!playing.value) togglePlay()
    return
  }
  if (action === 'pause') {
    if (playing.value) togglePlay()
    return
  }
  if (action === 'play-pause') {
    togglePlay()
    return
  }
  if (action === 'next') {
    if (isLive.value) switchChannel(1)
    else if (canNext.value) nextEpisode()
    return
  }
  if (action === 'previous' && isLive.value) switchChannel(-1)
}

/** 原生返回键：先收起控制条/面板，再退出播放，别一按就退出去 */
function onPlayerBack(event: Event) {
  if (!player.open) return
  event.preventDefault()
  if (!drawerOpen.value && !menu.value && controlsFocused()) {
    const active = document.activeElement as HTMLElement | null
    active?.blur()
    controlsVisible.value = false
    return
  }
  goBack()
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
  if (menu.value || drawerOpen.value) {
    goBack()
    window.history.pushState({ ...(window.history.state || {}), kaytvPlayer: true }, '')
    pushedState = true
    return
  }
  pushedState = false
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
  if (immersive.value) setSystemBarsHidden(true)
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
      lastPlayKey = player.vod ? `${player.vod.detail.sourceId}:${player.vod.detail.id}` : ''
      document.body.style.overflow = 'hidden'
      if (!pushedState) {
        window.history.pushState({ ...(window.history.state || {}), kaytvPlayer: true }, '')
        pushedState = true
      }
      drawerOpen.value = false
      drawerQuery.value = ''
      error.value = ''
      controlsVisible.value = true
      syncBrightness()
      if (runtime.native && !settings.tvMode) {
        if (isLive.value) enterFullscreen()
        else if (!portrait.value) enterFullscreen(false)
      }
      void nextTick(() => {
        root.value?.focus({ preventScroll: true })
        wake()
      })
    } else {
      window.clearTimeout(hideTimer)
      window.clearTimeout(singleTapTimer)
      window.clearTimeout(hintTimer)
      window.clearTimeout(brightnessTimer)
      stopLongPress()
      longPressActive = false
      swipeMoved = false
      gestureHint.value = ''
      brightnessDrag = null
      brightnessMoved = false
      brightnessHint.value = false
      releaseBrightness()
      document.body.style.overflow = ''
      drawerOpen.value = false
      drawerTab.value = 'list'
      closeMenu()
      exitFullscreen()
      clearEngines()
      if (pushedState) {
        pushedState = false
        window.history.back()
      }
      const target = lastFocused
      lastFocused = null
      const fallbackKey = lastPlayKey
      lastPlayKey = ''
      void nextTick(() => {
        if (target && document.contains(target)) {
          target.focus({ preventScroll: true })
          return
        }
        // 从详情弹窗起播时弹窗随后卸载，原焦点失效，退回刚看的那张海报卡
        const cards = fallbackKey
          ? Array.from(document.querySelectorAll<HTMLElement>('[data-play-key]')).filter(
              (element) => element.dataset.playKey === fallbackKey
            )
          : []
        // 同一个片子可能同时出现在横幅和海报墙里，优先回屏幕上看得见的那张
        const card =
          cards.find((element) => {
            const rect = element.getBoundingClientRect()
            return rect.bottom > 0 && rect.top < window.innerHeight
          }) || cards[0]
        if (!card) return
        card.focus({ preventScroll: true })
        card.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      })
    }
  }
)

watch(playing, (value) => {
  if (!value && phoneGestures.value) {
    window.clearTimeout(hideTimer)
    controlsVisible.value = false
    return
  }
  if (!value) controlsVisible.value = true
  wake()
})

watch(drawerOpen, () => {
  // 手机关掉抽屉时如果仍处于暂停，只留中间播放键
  if (!drawerOpen.value && phoneGestures.value && !playing.value) {
    window.clearTimeout(hideTimer)
    controlsVisible.value = false
    return
  }
  wake()
})

function onOverlayMove() {
  if (!phoneGestures.value) wake()
}

onMounted(() => {
  restoreVolume()
  restoreRate()
  restoreSkip()
  restoreFill()
  window.addEventListener('kaytv:volume', onSystemVolume)
  window.addEventListener('kaytv:media', onMediaKey)
  window.addEventListener('kaytv:player-back', onPlayerBack)
  window.addEventListener('resize', onResize)
  window.addEventListener('popstate', onPopState)
  window.addEventListener('beforeunload', onBeforeUnload)
  document.addEventListener('visibilitychange', onVisibilityChange)
  document.addEventListener('fullscreenchange', onFullscreenChange)
})

onBeforeUnmount(() => {
  window.removeEventListener('kaytv:volume', onSystemVolume)
  window.removeEventListener('kaytv:media', onMediaKey)
  window.removeEventListener('kaytv:player-back', onPlayerBack)
  window.removeEventListener('resize', onResize)
  window.removeEventListener('popstate', onPopState)
  window.removeEventListener('beforeunload', onBeforeUnload)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  window.clearTimeout(hideTimer)
  clearEngines()
  exitFullscreen()
  document.body.style.overflow = ''
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="player.open"
      ref="root"
      class="player-overlay"
      :class="{ 'controls-idle': !controlsVisible || drawerOpen, sheet: sheetMode }"
      tabindex="-1"
      data-nav-scope
      @keydown.capture="onKeydown"
      @mousemove="onOverlayMove"
      @touchstart.passive="wake"
    >
      <div
        ref="stage"
        class="player-stage"
        @touchstart="onStageTouchStart"
        @touchmove="onStageTouchMove"
        @touchend="onStageTouchEnd"
        @touchcancel="onStageTouchCancel"
        @contextmenu.prevent
      >
      <video
        ref="video"
        class="player-video"
        playsinline
        webkit-playsinline
        preload="auto"
        :poster="player.poster ? mediaUrl(player.poster) : ''"
        :style="{ objectFit: fillMode }"
        @loadedmetadata="onLoadedMetadata"
        @timeupdate="onTimeUpdate"
        @durationchange="onDurationChange"
        @play="playing = true; waiting = false; clearFallback(); wake()"
        @pause="playing = false; wake()"
        @waiting="onWaiting"
        @playing="waiting = false; error = ''; clearStall()"
        @canplay="waiting = false; clearFallback(); clearStall()"
        @ended="onEnded"
        @error="onNativeError"
        @click="onVideoClick"
        @dblclick="onVideoDoubleClick"
      />

      <button
        v-if="phoneGestures && centerPlayVisible"
        class="player-center-btn"
        :class="{ paused: !playing }"
        type="button"
        :aria-label="playing ? '暂停' : '播放'"
        @click.stop="togglePlay"
      >
        <span class="player-center-ring">
          <AppIcon :name="playing ? 'pause' : 'play'" :size="34" />
        </span>
      </button>

      <div v-if="gestureHint" class="player-gesture-hint">
        <span>{{ gestureHint }}</span>
      </div>

      <div v-if="brightnessHint" class="player-brightness">
        <div class="brightness-row">
          <AppIcon name="sun" :size="15" />
          <span>屏幕亮度 {{ brightness }}%</span>
        </div>
        <div class="brightness-track">
          <span class="brightness-fill" :style="{ width: `${brightness}%` }" />
        </div>
      </div>

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
            <button class="btn" @click="openDrawer(isLive ? 'list' : 'sources')">{{ isLive ? '切换频道' : '线路与片源' }}</button>
            <button v-if="!isLive" class="btn" @click="void switchSourceNow()">换个片源</button>
            <button class="btn ghost" @click="void copyPlaybackUrl()">复制播放地址</button>
            <button class="btn ghost" @click="closePlayer">关闭</button>
          </div>
        </div>
      </div>

      <button
        v-if="menu"
        class="menu-scrim"
        type="button"
        aria-label="关闭菜单"
        @click="closeMenu"
      />

      <div class="player-chrome player-top" :class="{ hidden: !controlsVisible || drawerOpen }">
        <button class="player-btn round" type="button" aria-label="返回" data-nav @click="closePlayer">
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
          <span class="player-host sheet-hide">{{ hostOf(player.currentUrl) }}</span>
          <button
            v-if="canPip"
            class="player-btn round sheet-hide"
            type="button"
            aria-label="小窗播放"
            data-nav
            @click="togglePip"
          >
            <AppIcon name="pip" :size="20" />
          </button>
          <button
            v-if="canCast"
            class="player-btn round"
            type="button"
            aria-label="投屏"
            data-nav
            @click="openCast"
          >
            <AppIcon name="cast" :size="20" />
          </button>
          <div class="menu-anchor sheet-hide">
            <button
              class="player-btn round"
              type="button"
              :class="{ active: menu === 'more' }"
              aria-label="更多设置"
              data-nav
              @click="toggleMenu('more')"
            >
              <AppIcon name="more" :size="20" />
            </button>
            <div v-if="menu === 'more'" class="player-menu">
              <button class="menu-item" type="button" data-nav @click="toggleFill">
                画面填充<span class="menu-value">{{ fillMode === 'cover' ? '铺满' : '适应' }}</span>
              </button>
              <button class="menu-item" type="button" data-nav @click="closeMenu(); retryPlayback()">
                重新载入线路<span class="menu-value">重试</span>
              </button>
              <button v-if="!isLive" class="menu-item" type="button" data-nav @click="closeMenu(); void switchSourceNow()">
                换个片源试试<span class="menu-value">自动</span>
              </button>
              <button class="menu-item" type="button" data-nav @click="void copyPlaybackUrl()">
                复制播放地址<span class="menu-value">调试</span>
              </button>
            </div>
          </div>
          <button class="player-btn round sheet-hide" type="button" aria-label="关闭" data-nav @click="closePlayer">
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
            <button class="player-btn round" type="button" :aria-label="playing ? '暂停' : '播放'" data-nav @click="togglePlay">
              <AppIcon :name="playing ? 'pause' : 'play'" :size="22" />
            </button>
            <template v-if="!isLive">
              <button
                class="player-btn round small"
                type="button"
                aria-label="后退 15 秒"
                data-nav
                @click="seekBy(-15)"
              >
                <span class="seek-label">-15</span>
              </button>
              <button
                class="player-btn round small"
                type="button"
                aria-label="前进 15 秒"
                data-nav
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
                data-nav
                @click="switchChannel(-1)"
              >
                <AppIcon name="back" :size="18" />
              </button>
              <button
                class="player-btn round small"
                type="button"
                aria-label="下一个频道"
                data-nav
                @click="switchChannel(1)"
              >
                <AppIcon name="right" :size="18" />
              </button>
            </template>
            <div class="volume-group sheet-hide">
              <button
                class="player-btn round small"
                type="button"
                :aria-label="muted || volume === 0 ? '取消静音' : '静音'"
                data-nav
                @click="toggleMute"
              >
                <AppIcon :name="volumeIcon" :size="18" />
              </button>
              <button
                class="player-btn round tiny sheet-hide"
                type="button"
                aria-label="音量减小"
                data-nav
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
                class="player-btn round tiny sheet-hide"
                type="button"
                aria-label="音量增大"
                data-nav
                @click="stepVolume(0.1)"
              >
                <AppIcon name="plus" :size="13" />
              </button>
              <span class="volume-value sheet-hide">{{ muted || volume === 0 ? '静音' : `${volumePercent}%` }}</span>
            </div>
            <span v-if="!isLive" class="player-clock">{{ clockText }} / {{ durationText }}</span>
          </div>
          <div class="controls-right">
            <div v-if="!isLive" class="menu-anchor sheet-hide">
              <button
                class="player-btn pill"
                type="button"
                :class="{ active: menu === 'rate' || rate !== 1 }"
                data-nav
                @click="toggleMenu('rate')"
              >
                <AppIcon name="gauge" :size="16" />
                {{ rateText }}
              </button>
              <div v-if="menu === 'rate'" class="player-menu menu-row">
                <button
                  v-for="item in RATES"
                  :key="item"
                  class="menu-item"
                  :class="{ active: item === rate }"
                  type="button"
                  data-nav
                  @click="setRate(item)"
                >
                  {{ item === 1 ? '常速' : `${item}x` }}
                </button>
              </div>
            </div>
            <div v-if="!isLive" class="menu-anchor sheet-hide">
              <button
                class="player-btn pill"
                type="button"
                :class="{ active: menu === 'skip' || skipIntro > 0 || skipOutro > 0 }"
                data-nav
                @click="toggleMenu('skip')"
              >
                片头/尾
              </button>
              <div v-if="menu === 'skip'" class="player-menu menu-skip">
                <p class="menu-label">跳过片头</p>
                <div class="menu-chips">
                  <button
                    v-for="seconds in SKIP_STEPS"
                    :key="`intro-${seconds}`"
                    class="chip"
                    :class="{ active: seconds === skipIntro }"
                    type="button"
                    data-nav
                    @click="setSkip('intro', seconds)"
                  >
                    {{ seconds ? `${seconds} 秒` : '不跳' }}
                  </button>
                </div>
                <p class="menu-label">跳过片尾（自动下一集）</p>
                <div class="menu-chips">
                  <button
                    v-for="seconds in SKIP_STEPS"
                    :key="`outro-${seconds}`"
                    class="chip"
                    :class="{ active: seconds === skipOutro }"
                    type="button"
                    data-nav
                    @click="setSkip('outro', seconds)"
                  >
                    {{ seconds ? `${seconds} 秒` : '不跳' }}
                  </button>
                </div>
              </div>
            </div>
            <button class="player-btn pill sheet-hide" type="button" data-nav @click="toggleDrawer('sources')">
              <AppIcon name="server" :size="16" />
              播放源
            </button>
            <button class="player-btn pill sheet-hide" type="button" data-nav @click="toggleDrawer('list')">
              <AppIcon :name="isLive ? 'tv' : 'film'" :size="16" />
              {{ isLive ? '频道' : '选集' }}
            </button>
            <button v-if="canNext" class="player-btn pill sheet-hide" type="button" data-nav @click="nextEpisode">
              <AppIcon name="right" :size="16" />
              下一集
            </button>
            <button v-if="!isLive" class="player-btn pill sheet-hide" type="button" data-nav @click="toggleDrawer('info')">
              <AppIcon name="info" :size="16" />
              详情
            </button>
            <button
              v-if="!settings.tvMode"
              class="player-btn round"
              type="button"
              :aria-label="isFullscreen ? '退出全屏' : '全屏'"
              data-nav
              @click="toggleFullscreen"
            >
              <AppIcon :name="isFullscreen ? 'fullscreenExit' : 'fullscreen'" :size="20" />
            </button>
          </div>
        </div>

        <p v-if="!runtime.native || settings.tvMode" class="player-hint">
          <span>← → {{ isLive ? '切换频道' : '快退/快进 15 秒' }}</span>
          <span>↓ 播放/音量按钮</span>
          <span>↑ {{ isLive ? '频道列表' : '选集列表' }}</span>
          <span>Enter 播放/暂停</span>
          <span>Esc 退出</span>
        </p>
      </div>
      </div>

      <div v-if="sheetMode" class="player-sheet hide-scrollbar">
        <VodInfoPanel
          @line="selectLine"
          @episode="selectEpisode"
          @related="void playRelated($event)"
          @cast="openCast"
          @copy="void copyPlaybackUrl()"
          @fullscreen="enterFullscreen"
          @sources="openDrawer('sources')"
        />
      </div>

      <Transition name="drawer">
        <aside v-if="drawerOpen" class="player-drawer">
          <div class="drawer-head">
            <div>
              <h3>{{ drawerTitle }}</h3>
              <p>{{ drawerMeta }}</p>
            </div>
            <button class="player-btn round small" type="button" aria-label="关闭列表" @click="closeDrawer">
              <AppIcon name="close" :size="18" />
            </button>
          </div>

          <div class="drawer-tabs">
            <button
              class="drawer-tab"
              :class="{ active: drawerTab === 'list' }"
              type="button"
              @click="drawerTab = 'list'"
            >
              {{ isLive ? '频道' : '选集' }}
            </button>
            <button
              class="drawer-tab"
              :class="{ active: drawerTab === 'sources' }"
              type="button"
              @click="drawerTab = 'sources'"
            >
              播放源
            </button>
            <button
              v-if="!isLive"
              class="drawer-tab"
              :class="{ active: drawerTab === 'info' }"
              type="button"
              @click="drawerTab = 'info'"
            >
              详情
            </button>
          </div>

          <div v-if="drawerTab === 'info'" class="drawer-scroll info-scroll">
            <VodInfoPanel
              @line="selectLine"
              @episode="selectEpisode"
              @related="void playRelated($event)"
              @cast="openCast"
              @copy="void copyPlaybackUrl()"
              @fullscreen="enterFullscreen()"
              @sources="openDrawer('sources')"
            />
          </div>

          <template v-else-if="drawerTab === 'list'">
            <div v-if="isLive" class="search-field drawer-search">
              <AppIcon class="search-icon" name="search" :size="16" />
              <input v-model="drawerQuery" class="input" type="search" placeholder="搜索频道" autocomplete="off" />
            </div>
            <div v-if="isLive" class="drawer-scroll">
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
            <div v-else class="drawer-scroll drawer-episodes">
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

          <div v-else class="drawer-scroll sources-panel">
            <div v-if="!isLive" class="drawer-lines">
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

            <div class="source-block">
              <p class="line-group-head">
                {{ isLive ? '直播源' : '自定义选源' }}
                <span class="line-group-hint">{{ isLive ? '用当前频道名去其他源里找' : '用当前片名去该源里找' }}</span>
              </p>
              <div class="search-field source-search">
                <AppIcon class="search-icon" name="search" :size="16" />
                <input v-model="sourceQuery" class="input" type="search" placeholder="筛选片源名称" autocomplete="off" />
              </div>
              <div class="source-chips">
                <button
                  v-for="item in sourceOptions"
                  :key="item.id"
                  class="chip"
                  :class="{ active: item.id === currentSourceId }"
                  :disabled="!!sourcePicking && sourcePicking !== item.id"
                  type="button"
                  @click="selectSource(item.id, item.name)"
                >
                  {{ item.name }}
                  <span v-if="item.id === currentSourceId" class="count current">当前</span>
                  <span v-else-if="sourcePicking === item.id" class="count">查找中…</span>
                </button>
                <p v-if="!sourceOptions.length" class="drawer-empty">没有匹配的片源</p>
              </div>
            </div>

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

/* 画面区：默认铺满整屏，手机竖屏改成顶部 16:9，下面留给详情 */
.player-stage {
  position: absolute;
  inset: 0;
}

.player-overlay.sheet {
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

.player-overlay.sheet .player-stage {
  position: relative;
  inset: auto;
  flex: none;
  width: 100%;
  aspect-ratio: 16 / 9;
  background: #000;
}

.player-overlay.sheet .sheet-hide {
  display: none;
}

.player-overlay.sheet .player-top {
  padding: 10px 12px 30px;
}

.player-overlay.sheet .player-bottom {
  padding: 30px 12px 10px;
  gap: 8px;
}

.player-overlay.sheet .player-controls {
  flex-wrap: nowrap;
  gap: 8px;
}

.player-overlay.sheet .player-error {
  position: fixed;
}

.player-center-btn {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 2;
  transform: translate(-50%, -50%);
  width: 78px;
  height: 78px;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 50%;
  background: rgba(8, 10, 14, 0.48);
  color: #fff;
  cursor: pointer;
  backdrop-filter: blur(8px);
  transition:
    opacity 0.2s ease,
    transform 0.15s ease,
    background 0.15s ease;
}
.player-center-btn:active {
  transform: translate(-50%, -50%) scale(0.92);
  background: rgba(8, 10, 14, 0.7);
}
.player-center-btn.paused {
  width: 88px;
  height: 88px;
  border-color: rgba(255, 255, 255, 0.3);
  background: rgba(8, 10, 14, 0.62);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
}
.player-center-ring {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  padding-left: 0;
}
.player-center-btn .play-glyph {
  margin-left: 4px;
}

.player-gesture-hint {
  position: absolute;
  top: 16%;
  left: 50%;
  z-index: 4;
  transform: translateX(-50%);
  padding: 9px 16px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 999px;
  background: rgba(8, 10, 14, 0.72);
  font-size: 13px;
  font-weight: 600;
  color: #fff;
  white-space: nowrap;
  pointer-events: none;
  backdrop-filter: blur(10px);
}

.player-brightness {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 5;
  transform: translate(-50%, -50%);
  width: min(250px, 58%);
  padding: 12px 14px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 14px;
  background: rgba(8, 10, 14, 0.74);
  color: #fff;
  pointer-events: none;
  backdrop-filter: blur(10px);
}
.brightness-row {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums lining-nums;
}
.brightness-track {
  margin-top: 9px;
  height: 5px;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.22);
}
.brightness-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: #fff;
}

.player-overlay.sheet .player-center-btn {
  width: 62px;
  height: 62px;
}
.player-overlay.sheet .player-center-btn.paused {
  width: 68px;
  height: 68px;
}
.player-overlay.sheet .player-gesture-hint {
  top: 10px;
}

.player-sheet {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  padding: 2px 14px calc(26px + env(safe-area-inset-bottom));
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
  /* 横屏挖孔在左侧时按钮不能压在摄像头下面 */
  padding-left: max(clamp(16px, 2.4vw, 36px), calc(var(--kaytv-safe-left, env(safe-area-inset-left, 0px)) + 12px));
  padding-right: max(clamp(16px, 2.4vw, 36px), calc(var(--kaytv-safe-right, env(safe-area-inset-right, 0px)) + 12px));
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
  padding-left: max(clamp(16px, 2.4vw, 36px), calc(var(--kaytv-safe-left, env(safe-area-inset-left, 0px)) + 12px));
  padding-right: max(clamp(16px, 2.4vw, 36px), calc(var(--kaytv-safe-right, env(safe-area-inset-right, 0px)) + 12px));
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
.sources-panel .drawer-lines,
.sources-panel .drawer-tracks {
  max-height: none;
  overflow: visible;
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

.menu-scrim {
  position: absolute;
  inset: 0;
  z-index: 4;
  border: 0;
  padding: 0;
  background: transparent;
  cursor: default;
}

.menu-anchor {
  position: relative;
  display: inline-flex;
}

.player-menu {
  position: absolute;
  bottom: calc(100% + 10px);
  right: 0;
  z-index: 8;
  min-width: 176px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
  border-radius: 14px;
  border: 1px solid var(--line);
  background: rgba(14, 16, 22, 0.97);
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(16px);
}

.player-top-right .player-menu {
  top: calc(100% + 8px);
  bottom: auto;
}

.menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  min-height: 38px;
  padding: 0 10px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
}
.menu-item:hover,
.menu-item:focus {
  background: rgba(255, 255, 255, 0.08);
  outline: none;
}
.menu-item.active {
  color: var(--accent);
  background: rgba(255, 180, 84, 0.14);
}

.menu-value {
  font-size: 12px;
  color: var(--muted);
}

.menu-row {
  flex-direction: row;
  flex-wrap: wrap;
  min-width: 0;
  max-width: 320px;
}
.menu-row .menu-item {
  min-width: 58px;
  justify-content: center;
}

.menu-skip {
  min-width: 268px;
  gap: 6px;
}
.menu-label {
  margin: 4px 2px 0;
  font-size: 11px;
  font-weight: 650;
  color: var(--muted-2);
}
.menu-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.menu-chips .chip {
  min-width: 52px;
  justify-content: center;
}

.player-btn.active {
  color: var(--accent);
  border-color: rgba(255, 180, 84, 0.42);
  background: rgba(255, 180, 84, 0.16);
}

.drawer-tabs {
  display: flex;
  gap: 8px;
  padding: 4px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.05);
}
.drawer-tab {
  flex: 1;
  height: 36px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.drawer-tab.active {
  background: rgba(255, 255, 255, 0.12);
  color: var(--text);
}

.sources-panel {
  gap: 16px;
}
.source-block {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.source-search .input {
  height: 38px;
  padding-left: 38px;
  font-size: 13px;
}
.source-search .search-icon {
  left: 12px;
}
.source-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.source-chips .chip {
  max-width: 100%;
}
.source-chips .chip:disabled {
  opacity: 0.45;
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
  .player-controls {
    flex-wrap: wrap;
    gap: 8px;
  }
  .controls-right {
    flex-wrap: wrap;
    justify-content: flex-start;
  }
  .player-btn.pill {
    height: 34px;
    padding: 0 10px;
    font-size: 12px;
  }
  .player-btn.round {
    width: 36px;
    height: 36px;
  }
  .player-menu {
    max-width: calc(100vw - 28px);
  }
  .menu-skip {
    min-width: 0;
    width: 268px;
  }
  .drawer-scroll {
    gap: 8px;
  }
}
</style>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { BUILTIN_LIVE } from '@kaytv/shared'
import type { LiveSource } from '@kaytv/shared'
import { api, directLive } from '../api/client'
import { findCustomLive } from '../api/customSources'
import { mediaUrl } from '../api/runtime'
import { epgFor, formatClock, loadEpg, progressOf, todayKey } from '../api/epg'
import type { EpgData } from '../api/epg'
import { useSettingsStore } from '../stores/settings'
import { usePlayerStore } from '../stores/player'
import { useLiveStore } from '../stores/live'
import {
  ALL_GROUP,
  FAVORITE_GROUP,
  FOUR_K_GROUP,
  RECENT_GROUP,
  channelKey,
  digitFromKey,
  isTypingTarget,
  isVirtualGroup,
  joinChannels
} from '../composables/liveChannels'
import {
  SLOW_MS,
  channelProbeState,
  channelProbeOf,
  probeChannelGroup,
  probeLiveChannel
} from '../composables/liveChannelProbeState'
import { toast } from '../composables/useToast'
import type { Channel, LiveData } from '../types'
import AppIcon from '../components/AppIcon.vue'
import ChannelTile from '../components/ChannelTile.vue'
import EmptyState from '../components/EmptyState.vue'

const settings = useSettingsStore()
const player = usePlayerStore()
const live = useLiveStore()

const DIAL_TIMEOUT = 1200
const DIAL_NOTICE_TIMEOUT = 5000
const WATCHDOG_DELAY = 22000
const WATCHDOG_RETRY = 6000
const MAX_AUTO_ROLL = 5

const selectedSource = ref('')
const data = ref<LiveData | null>(null)
const loading = ref(false)
const error = ref('')
const group = ref('')
const query = ref('')
const mounted = ref(false)
const cache = new Map<string, LiveData>()

const epg = ref<Map<string, EpgData>>(new Map())
const epgLoading = ref(false)
const dayOffset = ref(0)
const focus = ref<Channel | null>(null)
const tick = ref(Date.now())
const logoFailed = ref(false)
const epgList = ref<HTMLElement | null>(null)
let clockTimer = 0
let epgTimer = 0
let epgRun = 0
let dialTimer = 0
let dialNoticeTimer = 0
let watchdogTimer = 0
let noticeTimer = 0
let recentApplied = ''
let active = true

const dial = ref('')
const dialNotice = ref('')
const rollNotice = ref('')
const rollBlocked = ref('')
const resumedNotice = ref('')
const rolling = ref(false)
const rollStreak = ref(0)

const sources = computed(() => settings.activeLive)

const fourKChannels = computed<Channel[]>(() =>
  (data.value?.channels || []).filter(
    (channel) => /4k|2160|uhd|超高清/i.test(channel.name) || /4k|2160|uhd|超高清/i.test(channel.group)
  )
)

const allChannels = computed<Channel[]>(() => data.value?.channels || [])
const favoriteChannels = computed(() => joinChannels(live.favorites, allChannels.value))
const recentChannels = computed(() => joinChannels(live.recent, allChannels.value))

const groups = computed(() => {
  const items = [
    { name: FAVORITE_GROUP, count: favoriteChannels.value.length },
    { name: RECENT_GROUP, count: recentChannels.value.length },
    { name: ALL_GROUP, count: data.value?.count || 0 }
  ]
  if (fourKChannels.value.length) {
    items.push({ name: FOUR_K_GROUP, count: fourKChannels.value.length })
  }
  for (const item of data.value?.groups || []) {
    if (!items.some((entry) => entry.name === item.name)) items.push({ ...item })
  }
  return items
})

const visibleChannels = computed<Channel[]>(() => {
  if (!data.value) return []
  const keyword = query.value.trim().toLowerCase()
  if (keyword) {
    return data.value.channels.filter(
      (channel) =>
        channel.name.toLowerCase().includes(keyword) ||
        channel.group.toLowerCase().includes(keyword)
    )
  }
  if (group.value === FAVORITE_GROUP) return favoriteChannels.value
  if (group.value === RECENT_GROUP) return recentChannels.value
  if (group.value === FOUR_K_GROUP) return fourKChannels.value
  if (group.value && group.value !== ALL_GROUP) {
    return data.value.channels.filter((channel) => channel.group === group.value)
  }
  return data.value.channels
})

const skippedCount = computed(
  () => visibleChannels.value.filter((channel) => live.isFailed(channel)).length
)

const groupNote = computed(() => {
  const parts: string[] = []
  const sameGroup = channelProbeState.group === group.value
  if (channelProbeState.running) {
    parts.push(
      sameGroup
        ? `正在检测本组 ${channelProbeState.done}/${channelProbeState.total} 个…`
        : `正在检测「${channelProbeState.group}」${channelProbeState.done}/${channelProbeState.total} 个…`
    )
  } else if (channelProbeState.total && sameGroup) {
    parts.push(`本组已检测 ${channelProbeState.ok}/${channelProbeState.total} 个可连通`)
  }
  if (skippedCount.value) parts.push(`已跳过 ${skippedCount.value} 个不可播`)
  return parts.join(' · ')
})

const detectLabel = computed(() => {
  if (!channelProbeState.running) return '检测本组'
  if (channelProbeState.group !== group.value) return '其他组检测中'
  return `检测中 ${channelProbeState.done}/${channelProbeState.total}`
})

const emptyTitle = computed(() => {
  if (query.value.trim()) return '没有匹配的频道'
  if (group.value === FAVORITE_GROUP) {
    return live.favorites.length ? '这个直播源里没有收藏的频道' : '还没有收藏的频道'
  }
  if (group.value === RECENT_GROUP) {
    return live.recent.length ? '这个直播源里没有看过的频道' : '最近还没有播过频道'
  }
  return '这个分组暂时没有频道'
})

const emptyMessage = computed(() => {
  if (query.value.trim()) return '换一个分组或清空搜索词试试。'
  if (group.value === FAVORITE_GROUP) {
    return live.favorites.length
      ? '收藏是按频道名和分组记的，换一个直播源或回到「全部」就能找到它们。'
      : '点频道右上角的星标收藏，之后在这里直接找到常看的台。'
  }
  if (group.value === RECENT_GROUP) {
    return live.recent.length
      ? '播过的频道会记在这里，换一个直播源或回到「全部」就能找到它们。'
      : '播过的频道会自动记在这里，电视端下次打开就能接着看。'
  }
  return '换一个分组或刷新频道试试。'
})

const dateKey = computed(() => todayKey(new Date(Date.now() + dayOffset.value * 86400000)))
const dayLabel = computed(() => (dayOffset.value === 0 ? '今天' : '明天'))

const focusData = computed<EpgData | undefined>(() => {
  if (!focus.value) return undefined
  return epg.value.get(focus.value.name)
})

const focusEpg = computed(() => epgFor(focusData.value, tick.value))

const focusProgress = computed(() => Math.round(progressOf(focusEpg.value.current, tick.value) * 100))

const focusRemaining = computed(() => {
  const current = focusEpg.value.current
  if (!current) return 0
  return Math.max(0, Math.round((current.end - tick.value) / 60000))
})

const focusHue = computed(() => {
  const name = focus.value?.name || ''
  let value = 0
  for (let index = 0; index < name.length; index += 1) {
    value = (value * 31 + name.charCodeAt(index)) % 360
  }
  return value
})

const focusInitial = computed(() => (focus.value?.name || '').replace(/^CCTV-?/i, 'C').slice(0, 2))

const providerLabel = computed(() => {
  const provider = focusData.value?.provider
  if (provider === 'cntv') return `央视影音节目单 · ${focusData.value?.channelName || ''}`
  if (provider === 'diyp') return `老张 EPG · ${focusData.value?.channelName || ''}`
  return '该频道暂无公开节目单，可正常观看'
})

const playingId = computed(() => {
  if (!player.open || player.kind !== 'live') return ''
  return player.currentChannel?.id || ''
})

const nowLabels = computed(() => {
  const out = new Map<string, string>()
  const at = tick.value
  for (const [name, entry] of epg.value) {
    out.set(name, epgFor(entry, at).current?.title || '')
  }
  return out
})

const updatedText = computed(() => {
  if (!data.value) return ''
  return new Date(data.value.updatedAt).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  })
})

const statusText = computed(() => {
  if (!settings.activeLive.length) return '未启用直播源'
  if (loading.value) return '正在加载频道…'
  if (data.value) {
    return `${data.value.sourceName} · ${data.value.count} 个频道 · ${updatedText.value} 更新`
  }
  return '选择上方直播源开始观看'
})

function pickSource() {
  const list = sources.value
  if (!list.length) {
    selectedSource.value = ''
    data.value = null
    return
  }
  if (!list.some((source) => source.id === selectedSource.value)) {
    selectedSource.value = list[0].id
    group.value = ''
    query.value = ''
  }
}

function applyGroup() {
  if (!data.value) return
  const known =
    isVirtualGroup(group.value) ||
    group.value === ALL_GROUP ||
    (group.value === FOUR_K_GROUP && fourKChannels.value.length > 0) ||
    data.value.groups.some((item) => item.name === group.value)
  if (group.value && !known) group.value = data.value.groups[0]?.name || ALL_GROUP
  if (!group.value) group.value = data.value.groups[0]?.name || ALL_GROUP
}

async function load(fresh = false) {
  const id = selectedSource.value
  if (!id) {
    data.value = null
    return
  }
  if (!fresh) {
    const cached = cache.get(id)
    if (cached) {
      data.value = cached
      applyGroup()
      syncFocus()
      scheduleEpg(0)
      restoreRecent()
      return
    }
  }
  loading.value = true
  error.value = ''
  try {
    let result: LiveData
    if (settings.online) {
      result = await api.live(id, fresh)
    } else {
      const source =
        BUILTIN_LIVE.find((item) => item.id === id) ||
        (findCustomLive(id) as LiveSource | undefined)
      if (!source) throw new Error('离线模式下无法加载该直播源')
      result = await directLive(source)
    }
    data.value = result
    cache.set(id, result)
    applyGroup()
    syncFocus()
    scheduleEpg(0)
    restoreRecent()
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '加载直播源失败'
    data.value = null
  } finally {
    loading.value = false
  }
}

function switchSource(id: string) {
  if (selectedSource.value === id) return
  selectedSource.value = id
  group.value = ''
  query.value = ''
}

function syncFocus() {
  const list = visibleChannels.value
  if (!list.length) {
    focus.value = null
    return
  }
  if (playingId.value) {
    const playing = list.find((channel) => channel.id === playingId.value)
    if (playing) {
      focus.value = playing
      return
    }
  }
  const current = focus.value ? list.find((channel) => channel.id === focus.value?.id) : null
  focus.value = current || list[0]
}

function clearWatchdog() {
  window.clearTimeout(watchdogTimer)
  watchdogTimer = 0
}

function clearDial() {
  window.clearTimeout(dialTimer)
  dialTimer = 0
  dial.value = ''
}

function scheduleNoticeClear() {
  window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => {
    rollNotice.value = ''
    resumedNotice.value = ''
  }, 9000)
}

function resetRoll() {
  clearWatchdog()
  window.clearTimeout(noticeTimer)
  rolling.value = false
  rollStreak.value = 0
  rollNotice.value = ''
  rollBlocked.value = ''
}

function startChannel(channel: Channel) {
  focus.value = channel
  logoFailed.value = false
  const list = visibleChannels.value
  const index = list.findIndex((item) => item.id === channel.id)
  player.openLive(
    list,
    Math.max(0, index),
    data.value?.sourceName || '',
    channel.group,
    selectedSource.value
  )
  live.noteWatched(channel)
  live.clearFailed(channel)
  clearWatchdog()
  watchdogTimer = window.setTimeout(() => {
    void watchdogCheck(channel)
  }, WATCHDOG_DELAY)
}

function play(channel: Channel | null) {
  if (!channel) return
  clearDial()
  window.clearTimeout(dialNoticeTimer)
  dialNotice.value = ''
  resumedNotice.value = ''
  resetRoll()
  startChannel(channel)
}

function toggleFavorite(channel: Channel) {
  const added = live.toggleFavorite(channel)
  toast.info(added ? `已收藏 ${channel.name}` : `已取消收藏 ${channel.name}`)
}

function restoreRecent() {
  if (!data.value || recentApplied === selectedSource.value) return
  recentApplied = selectedSource.value
  if (player.open) return
  const [last] = recentChannels.value
  if (!last) return
  if (!visibleChannels.value.some((item) => item.id === last.id)) {
    const known = data.value.groups.some((item) => item.name === last.group)
    group.value = known ? last.group : ALL_GROUP
  }
  startChannel(last)
  resumedNotice.value = `上次收看到 ${last.name}，已自动接上；想换台直接按数字键。`
  scheduleNoticeClear()
}

function commitDial() {
  const wanted = Number(dial.value)
  dial.value = ''
  const list = visibleChannels.value
  if (!wanted || !list.length) return
  const target = list[wanted - 1]
  if (target) {
    window.clearTimeout(dialNoticeTimer)
    dialNotice.value = ''
    play(target)
    return
  }
  showDialNotice(`没有第 ${wanted} 台，${group.value} 一共只有 ${list.length} 个频道`)
}

function pushDigit(digit: number) {
  if (!data.value) return
  if (!visibleChannels.value.length) {
    showDialNotice(`${group.value} 里没有频道，换一个分组或清空搜索词后再按数字键`)
    return
  }
  if (!dial.value && digit === 0) return
  const next = `${dial.value}${digit}`
  dial.value = next.length > 3 ? next.slice(-3) : next
  window.clearTimeout(dialTimer)
  dialTimer = window.setTimeout(commitDial, DIAL_TIMEOUT)
}

function showDialNotice(message: string) {
  dial.value = ''
  dialNotice.value = message
  toast.error(message)
  window.clearTimeout(dialNoticeTimer)
  dialNoticeTimer = window.setTimeout(() => {
    dialNotice.value = ''
  }, DIAL_NOTICE_TIMEOUT)
}

function onDigitKey(event: KeyboardEvent) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
  if (isTypingTarget(event.target)) return
  const digit = digitFromKey(event)
  if (digit === null) return
  event.preventDefault()
  pushDigit(digit)
}

const flashOn = computed(
  () =>
    Boolean(dial.value) ||
    Boolean(dialNotice.value) ||
    Boolean(rollBlocked.value) ||
    Boolean(rollNotice.value) ||
    Boolean(resumedNotice.value)
)

const flashTone = computed(() => {
  if (dial.value) return 'dial'
  if (dialNotice.value || rollBlocked.value) return 'bad'
  if (rollNotice.value) return 'warn'
  return 'info'
})

const flashText = computed(() => {
  if (dial.value) return `频道号 ${dial.value}`
  return rollBlocked.value || dialNotice.value || rollNotice.value || resumedNotice.value
})

const flashIcon = computed(() => {
  if (dial.value) return 'tv'
  if (dialNotice.value || rollNotice.value || rollBlocked.value) return 'warn'
  return 'clock'
})

function nextPlayable(current: Channel): Channel | null {
  const list = visibleChannels.value
  if (list.length < 2) return null
  const index = list.findIndex((item) => item.id === current.id)
  const start = index < 0 ? 0 : index
  const ordered: Channel[] = []
  for (let step = 1; step < list.length; step += 1) {
    ordered.push(list[(start + step) % list.length])
  }
  return (
    ordered.find((item) => item.id !== current.id && !live.isFailed(item)) ||
    null
  )
}

async function rollToNext(current: Channel, reason: string) {
  if (!active || rolling.value) return
  rolling.value = true
  try {
    live.markFailed(current, reason)
    rollStreak.value += 1
    if (rollStreak.value >= MAX_AUTO_ROLL) {
      clearWatchdog()
      rollBlocked.value = `本组连续 ${rollStreak.value} 个频道都无法播放，可能是网络或源站问题（最后失败原因：${reason}）`
      toast.error(rollBlocked.value)
      return
    }
    const next = nextPlayable(current)
    if (!next) {
      clearWatchdog()
      rollBlocked.value = `${current.name} 播不了（${reason}），本组已经没有可切的台，换一个分组试试`
      toast.error(rollBlocked.value)
      return
    }
    rollNotice.value = `${current.name} 播不了（${reason}），已切到 ${next.name}`
    toast.info(rollNotice.value)
    scheduleNoticeClear()
    startChannel(next)
  } finally {
    rolling.value = false
  }
}

async function watchdogCheck(channel: Channel) {
  if (!active || rolling.value || !player.open || player.kind !== 'live') return
  const state = player.live
  if (!state || state.sourceId !== selectedSource.value) return
  const current = player.currentChannel
  if (!current || channelKey(current) !== channelKey(channel)) return
  const total = current.urls?.length || 1
  if ((state.lineIndex || 0) < total - 1) {
    clearWatchdog()
    watchdogTimer = window.setTimeout(() => {
      void watchdogCheck(channel)
    }, WATCHDOG_RETRY)
    return
  }
  const result = await probeLiveChannel(current, state.lineIndex || 0)
  if (!result.ok) await rollToNext(current, result.detail)
}

function retryRoll() {
  resetRoll()
  window.clearTimeout(dialNoticeTimer)
  dialNotice.value = ''
  if (focus.value) {
    live.clearFailed(focus.value)
    startChannel(focus.value)
    toast.info(`重新尝试播放 ${focus.value.name}`)
    return
  }
  const [first] = visibleChannels.value
  if (first) startChannel(first)
}

function switchRollGroup() {
  resetRoll()
  const options = groups.value.filter(
    (item) => item.name !== group.value && !isVirtualGroup(item.name) && item.count > 0
  )
  const fallback = options.length
    ? options
    : groups.value.filter((item) => item.name !== group.value && item.count > 0)
  const target = fallback[0]
  if (!target) {
    toast.info('没有其他分组可以切换，试试刷新频道或切换直播源')
    return
  }
  group.value = target.name
  toast.info(`已切到「${target.name}」分组，选台后点立即播放`)
}

async function detectGroup() {
  if (channelProbeState.running || !selectedSource.value) return
  const list = visibleChannels.value
  if (!list.length) {
    toast.info('本组没有频道，先换一个分组或直播源')
    return
  }
  const name = group.value
  await probeChannelGroup(selectedSource.value, name, list)
  if (channelProbeState.ok) {
    toast.info(`「${name}」检测完成：${channelProbeState.ok}/${channelProbeState.total} 个可连通`)
  } else {
    toast.error(`「${name}」${channelProbeState.total} 个频道都没连上，可能是网络或源站问题`)
  }
}

function probeLabel(channel: Channel): string {
  const result = channelProbeOf(channel)
  if (result) {
    if (!result.ok) return `不可用 ${result.detail}`
    return result.ms > SLOW_MS ? `延迟 ${result.ms}ms` : `可用 ${result.ms}ms`
  }
  if (live.isFailed(channel)) return `播不了 ${live.failReason(channel)}`
  return ''
}

function probeIsBad(channel: Channel): boolean {
  const result = channelProbeOf(channel)
  if (result) return !result.ok
  return live.isFailed(channel)
}

async function syncEpg() {
  if (!data.value) {
    epg.value = new Map()
    return
  }
  const names = [...visibleChannels.value.map((channel) => channel.name)]
  if (focus.value) names.unshift(focus.value.name)
  const run = ++epgRun
  epgLoading.value = true
  try {
    const result = await loadEpg(names, { date: dateKey.value, limit: 26 })
    if (run !== epgRun) return
    const merged = new Map(epg.value)
    for (const [name, value] of result) merged.set(name, value)
    epg.value = merged
    scrollToCurrent()
  } finally {
    if (run === epgRun) epgLoading.value = false
  }
}

function scheduleEpg(delay = 260) {
  window.clearTimeout(epgTimer)
  epgTimer = window.setTimeout(() => {
    void syncEpg()
  }, delay)
}

function scrollToCurrent() {
  if (!focusEpg.value.current) return
  void nextTick(() => {
    const list = epgList.value
    const item = list?.querySelector<HTMLElement>('.epg-item.now')
    if (!list || !item) return
    const listBox = list.getBoundingClientRect()
    const itemBox = item.getBoundingClientRect()
    list.scrollTop += itemBox.top - listBox.top - listBox.height / 2 + itemBox.height / 2
  })
}

function setDay(offset: number) {
  if (dayOffset.value === offset) return
  dayOffset.value = offset
  epg.value = new Map()
  scheduleEpg(0)
}

onMounted(async () => {
  window.addEventListener('keydown', onDigitKey)
  await settings.init()
  mounted.value = true
  const before = selectedSource.value
  pickSource()
  if (before === selectedSource.value && selectedSource.value) load()
  clockTimer = window.setInterval(() => {
    tick.value = Date.now()
  }, 30000)
})

onBeforeUnmount(() => {
  active = false
  window.clearInterval(clockTimer)
  window.clearTimeout(epgTimer)
  window.clearTimeout(dialTimer)
  window.clearTimeout(dialNoticeTimer)
  window.clearTimeout(watchdogTimer)
  window.clearTimeout(noticeTimer)
  window.removeEventListener('keydown', onDigitKey)
})

watch(selectedSource, (id, previous) => {
  if (!mounted.value || !id || id === previous) return
  load()
})

watch(
  () => sources.value.map((source) => source.id).join('|'),
  () => {
    if (!mounted.value) return
    const before = selectedSource.value
    pickSource()
    if (before === selectedSource.value && selectedSource.value) load()
  }
)

watch([group, query, dateKey], () => {
  syncFocus()
  scheduleEpg()
})

watch(
  () => focus.value?.name,
  () => {
    logoFailed.value = false
    if (focus.value && !epg.value.has(focus.value.name)) scheduleEpg(80)
    scrollToCurrent()
  }
)

watch(playingId, (id) => {
  if (!id) return
  syncFocus()
})

watch(
  () => player.live?.index,
  () => {
    if (!player.open || player.kind !== 'live') return
    const channel = player.currentChannel
    // 播放器里用方向台/清单换台时也要记进最近看过，否则下次进来接不回上一个台
    if (channel && player.live?.sourceId === selectedSource.value) live.noteWatched(channel)
    syncFocus()
  }
)

watch(
  () => player.open,
  (open) => {
    if (!open) clearWatchdog()
  }
)

// 播放器确认「这个频道所有线路都试过」后调用 live.reportDown 时，这里立刻接手切台
watch(
  () => live.down?.seq,
  () => {
    const down = live.down
    if (!down) return
    if (!player.open || player.kind !== 'live') return
    if (player.live?.sourceId !== selectedSource.value) return
    const current = player.currentChannel
    if (!current || channelKey(current) !== down.key) return
    clearWatchdog()
    void rollToNext(current, down.reason)
  }
)
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 class="page-title"><span class="bar live" />直播频道</h1>
        <p class="page-desc">{{ statusText }}</p>
      </div>
      <div class="page-actions">
        <button
          class="btn"
          data-nav
          :disabled="loading || !selectedSource || !visibleChannels.length"
          @click="detectGroup"
        >
          <AppIcon name="search" :size="17" />
          {{ detectLabel }}
        </button>
        <button class="btn" data-nav :disabled="loading || !selectedSource" @click="load(true)">
          <AppIcon name="refresh" :size="17" />
          刷新频道
        </button>
      </div>
    </div>

    <template v-if="settings.activeLive.length">
      <div class="chip-row source-row hide-scrollbar">
        <button
          v-for="source in settings.activeLive"
          :key="source.id"
          class="chip"
          :class="{ active: selectedSource === source.id }"
          data-nav
          type="button"
          @click="switchSource(source.id)"
        >
          {{ source.name }}
        </button>
      </div>

      <div class="live-tools">
        <div class="search-field channel-search">
          <AppIcon class="search-icon" name="search" :size="18" />
          <input
            v-model="query"
            class="input"
            type="search"
            placeholder="搜索频道名或分组"
            autocomplete="off"
          />
        </div>
        <span v-if="query" class="search-hint">正在全部频道中筛选</span>
      </div>

      <div class="group-bar">
        <div class="chip-row hide-scrollbar">
          <button
            v-for="item in groups"
            :key="item.name"
            class="chip"
            :class="{ 'active-live': group === item.name, 'virtual-chip': isVirtualGroup(item.name) }"
            data-nav
            type="button"
            @click="group = item.name"
          >
            {{ item.name }}
            <span class="count">{{ item.count }} 个频道</span>
          </button>
        </div>
        <p v-if="groupNote" class="group-note">{{ groupNote }}</p>
      </div>

      <div v-if="loading" class="channel-grid section-gap">
        <div v-for="index in 24" :key="index" class="skeleton channel-skeleton" />
      </div>

      <EmptyState
        v-else-if="error"
        :title="settings.online ? '直播源加载失败' : '直播源需要跨域访问'"
        :message="error"
        icon="warn"
      >
        <button class="btn red" data-nav @click="load(true)">
          <AppIcon name="refresh" :size="16" />
          重试
        </button>
      </EmptyState>

      <EmptyState
        v-else-if="!visibleChannels.length"
        :title="emptyTitle"
        :message="emptyMessage"
        icon="search"
      />

      <div v-else class="live-layout section-gap">
        <section class="live-stage">
            <span
              v-if="dial"
              class="stage-dial"
            >频道号 {{ dial }}<span class="dial-hint">继续输入，1.2 秒后跳转</span></span>

            <span
              class="stage-logo"
              :style="{ background: `hsl(${focusHue} 32% 20%)`, color: `hsl(${focusHue} 60% 78%)` }"
            >
              <span class="stage-initial">{{ focusInitial }}</span>
              <img
                v-if="focus?.logo && !logoFailed"
                :src="mediaUrl(focus.logo)"
                :alt="focus.name"
                loading="lazy"
                decoding="async"
                referrerpolicy="no-referrer"
                @error="logoFailed = true"
              />
            </span>

            <div class="stage-info">
              <div class="stage-head">
                <span class="stage-tag">LIVE</span>
                <strong class="stage-name">{{ focus?.name || '未选择频道' }}</strong>
                <span v-if="focus?.group" class="stage-group">{{ focus.group }}</span>
              </div>

              <template v-if="focusEpg.current">
                <div class="stage-program">
                  <span class="stage-time">
                    {{ formatClock(focusEpg.current.start) }}-{{ formatClock(focusEpg.current.end) }}
                  </span>
                  <span class="stage-title">{{ focusEpg.current.title }}</span>
                </div>
                <div class="stage-bar">
                  <span :style="{ width: `${focusProgress}%` }" />
                </div>
                <p class="stage-next">
                  <span v-if="focusRemaining">剩余约 {{ focusRemaining }} 分钟</span>
                  <span v-if="focusEpg.upNext.length">
                    · 接下来 {{ formatClock(focusEpg.upNext[0].start) }} {{ focusEpg.upNext[0].title }}
                  </span>
                </p>
              </template>
              <p v-else-if="focusEpg.missing" class="stage-next">
                节目单暂缺：该频道没有公开 EPG，可直接播放。
              </p>
              <p v-else class="stage-next">
                {{ dayOffset ? '明天此时还没有节目信息。' : '现在没有正在播出的节目。' }}
              </p>

              <p v-if="dialNotice" class="stage-alert bad">
                <AppIcon name="warn" :size="14" />
                <span>{{ dialNotice }}</span>
              </p>
              <p v-else-if="rollNotice" class="stage-alert">
                <AppIcon name="warn" :size="14" />
                <span>{{ rollNotice }}</span>
              </p>
              <p v-else-if="resumedNotice" class="stage-alert">
                <AppIcon name="clock" :size="14" />
                <span>{{ resumedNotice }}</span>
              </p>
              <div v-if="rollBlocked" class="stage-alert bad">
                <AppIcon name="warn" :size="14" />
                <span>{{ rollBlocked }}</span>
                <span class="alert-actions">
                  <button class="btn sm ghost" data-nav type="button" @click="switchRollGroup">
                    换分组
                  </button>
                  <button class="btn sm ghost" data-nav type="button" @click="retryRoll">
                    <AppIcon name="refresh" :size="14" />
                    重试
                  </button>
                </span>
              </div>
            </div>

            <div class="stage-actions">
              <button
                class="btn play"
                data-nav
                data-tv-primary
                type="button"
                :disabled="!focus"
                @click="play(focus)"
              >
                <AppIcon name="play" :size="16" />
                {{ playingId && playingId === focus?.id ? '正在播放' : '立即播放' }}
              </button>
              <button
                class="btn"
                data-nav
                type="button"
                :disabled="!focus"
                @click="focus && toggleFavorite(focus)"
              >
                <AppIcon name="star" :size="16" />
                {{ focus && live.isFavorite(focus) ? '已收藏' : '收藏' }}
              </button>
            </div>
        </section>

        <div class="channel-grid">
          <div v-for="channel in visibleChannels" :key="channel.id" class="channel-cell">
            <ChannelTile
              :channel="channel"
              :active="channel.id === playingId"
              :now="nowLabels.get(channel.name) || ''"
              @select="play"
            />
            <button
              class="cell-fav"
              :class="{ on: live.isFavorite(channel) }"
              data-nav
              type="button"
              :title="live.isFavorite(channel) ? '取消收藏' : '收藏频道'"
              @click.stop="toggleFavorite(channel)"
            >
              <AppIcon name="star" :size="13" />
            </button>
            <span
              v-if="probeLabel(channel)"
              class="cell-state"
              :class="{ bad: probeIsBad(channel) }"
              >{{ probeLabel(channel) }}</span
            >
          </div>
        </div>

        <aside class="epg-panel">
          <div class="epg-head">
            <div class="epg-channel">
              <strong>{{ focus?.name || '今日节目单' }}</strong>
              <span>
                {{ dayLabel }} ·
                {{ focusData?.programs.length ? `${focusData.programs.length} 个节目` : '暂无节目' }}
              </span>
            </div>
            <div class="epg-days">
              <button
                class="epg-day"
                :class="{ on: dayOffset === 0 }"
                data-nav
                type="button"
                @click="setDay(0)"
              >
                今天
              </button>
              <button
                class="epg-day"
                :class="{ on: dayOffset === 1 }"
                data-nav
                type="button"
                @click="setDay(1)"
              >
                明天
              </button>
            </div>
          </div>

          <div v-if="epgLoading && !focusData?.programs.length" class="epg-list">
            <div v-for="index in 8" :key="index" class="skeleton epg-skeleton" />
          </div>

          <div v-else-if="focusEpg.missing" class="epg-note epg-missing">
            <AppIcon name="info" :size="14" />
            <span>节目单暂缺：央视 EPG 与老张 EPG 都没有该频道{{ dayLabel }}的数据。</span>
          </div>

          <div v-else ref="epgList" class="epg-list">
            <div
              v-for="(program, index) in focusData?.programs || []"
              :key="`${program.start}-${index}`"
              class="epg-item"
              :class="{ now: program === focusEpg.current, past: program.end <= tick }"
            >
              <span class="epg-item-time">{{ formatClock(program.start) }}</span>
              <span class="epg-item-name">{{ program.title }}</span>
              <span v-if="program === focusEpg.current" class="epg-progress">
                <span :style="{ width: `${focusProgress}%` }" />
              </span>
            </div>
          </div>

          <p class="epg-note">{{ providerLabel }}</p>
        </aside>
      </div>
    </template>

    <EmptyState
      v-else
      title="没有可用的直播源"
      message="在设置中启用直播源，或连接服务端后在管理后台统一维护源。"
      icon="tv"
    >
      <RouterLink class="btn primary" to="/settings" data-nav>前往设置</RouterLink>
    </EmptyState>

    <!-- 播放器铺满整屏时页面里的播放台看不到，同样的提示用浮层再发一次 -->
    <Teleport to="body">
      <div v-if="flashOn && player.open" class="live-flash" :class="flashTone">
        <AppIcon :name="flashIcon" :size="16" />
        <span class="flash-text">{{ flashText }}</span>
        <span v-if="dial" class="dial-hint">继续输入，1.2 秒后跳转</span>
        <span v-if="rollBlocked" class="alert-actions">
          <button class="btn sm ghost" data-nav type="button" @click="switchRollGroup">
            换分组
          </button>
          <button class="btn sm ghost" data-nav type="button" @click="retryRoll">
            <AppIcon name="refresh" :size="14" />
            重试
          </button>
        </span>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.live-layout > .channel-grid {
  grid-area: wall;
  min-width: 0;
}
.live-layout > .epg-panel {
  grid-area: epg;
}
.source-row {
  margin-top: -2px;
}
.virtual-chip {
  border-color: rgba(255, 255, 255, 0.16);
}
.group-note {
  margin: -2px 0 4px;
  font-size: 11.5px;
  color: var(--muted-2);
}
.channel-cell {
  position: relative;
  min-width: 0;
}
.cell-fav {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  padding: 0;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: rgba(10, 10, 14, 0.72);
  color: var(--muted-2);
  cursor: pointer;
  outline: none;
  transition:
    color 0.18s ease,
    border-color 0.18s ease,
    background 0.18s ease;
}
.cell-fav:hover,
.cell-fav:focus-visible {
  color: #fff;
  border-color: var(--accent);
  background: var(--accent-soft);
}
.cell-fav.on {
  color: #ffd479;
  border-color: rgba(255, 212, 121, 0.5);
  background: rgba(255, 212, 121, 0.14);
}
.cell-state {
  position: absolute;
  left: 6px;
  bottom: 8px;
  max-width: calc(100% - 34px);
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(16, 185, 129, 0.16);
  border: 1px solid rgba(16, 185, 129, 0.36);
  color: #4ed0a5;
  font-size: 9.5px;
  font-weight: 700;
  line-height: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  pointer-events: none;
}
.cell-state.bad {
  background: rgba(229, 83, 75, 0.16);
  border-color: rgba(229, 83, 75, 0.42);
  color: #ef8080;
}
.live-stage {
  position: relative;
}
.stage-dial {
  position: absolute;
  top: -10px;
  right: 18px;
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 12px;
  border-radius: 4px;
  border: 1px solid var(--line-strong);
  background: rgba(10, 10, 14, 0.94);
  color: #fff;
  font-size: 15px;
  font-weight: 700;
  font-variant-numeric: tabular-nums lining-nums;
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.45);
  pointer-events: none;
  z-index: 5;
}
.dial-hint {
  font-size: 10.5px;
  font-weight: 500;
  color: var(--muted-2);
}
.stage-alert {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 0;
  padding: 7px 10px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--line);
  color: #e8e8ec;
  font-size: 12px;
  line-height: 1.5;
}
.stage-alert svg {
  flex: none;
  color: #ffd479;
}
.stage-alert.bad {
  background: rgba(229, 83, 75, 0.12);
  border-color: rgba(229, 83, 75, 0.4);
  color: #f2a6a1;
}
.stage-alert.bad svg {
  color: var(--danger);
}
.alert-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}
.live-flash {
  position: fixed;
  left: 50%;
  top: calc(var(--header-h) + 10px);
  transform: translateX(-50%);
  z-index: 400;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: min(94vw, 860px);
  padding: 9px 15px;
  border-radius: 999px;
  border: 1px solid var(--line-strong);
  background: rgba(20, 23, 30, 0.96);
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.5);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
}
.live-flash.dial {
  border-color: var(--accent);
  font-variant-numeric: tabular-nums lining-nums;
}
.live-flash.warn {
  border-color: rgba(255, 212, 121, 0.45);
}
.live-flash.warn svg {
  color: #ffd479;
}
.live-flash.bad {
  border-color: rgba(229, 83, 75, 0.5);
  background: rgba(38, 18, 20, 0.96);
}
.live-flash.bad svg {
  color: var(--danger);
}
.live-flash.info svg {
  color: #4ed0a5;
}
.flash-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.live-tools {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  margin: 2px 0 6px;
}
.channel-search {
  width: min(420px, 100%);
}
.channel-search .input {
  height: 44px;
  padding-left: 44px;
  padding-right: 14px;
  font-size: 13.5px;
}
.search-hint {
  font-size: 11.5px;
  color: var(--muted-2);
}
.group-bar {
  position: sticky;
  top: calc(var(--header-h) - 1px);
  z-index: 20;
  padding-top: 4px;
  margin: 2px 0 6px;
  background: linear-gradient(180deg, rgba(11, 11, 15, 0.96) 72%, rgba(11, 11, 15, 0));
}
.channel-skeleton {
  height: 124px;
  border-radius: 6px;
}
.epg-skeleton {
  height: 34px;
  border-radius: 4px;
  margin-bottom: 8px;
}
.epg-missing {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  border-top: 0;
  padding-top: 0;
  line-height: 1.6;
}
.epg-missing svg {
  flex: none;
  margin-top: 2px;
  color: var(--muted-2);
}
.stage-tag {
  letter-spacing: 1px;
}
</style>

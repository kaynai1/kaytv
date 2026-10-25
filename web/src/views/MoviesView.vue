<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { contentTypeName } from '@kaytv/shared'
import { api } from '../api/client'
import { mediaUrl } from '../api/runtime'
import {
  tmdbArts,
  tmdbBackdropUrl,
  tmdbEnsure,
  tmdbKey,
  tmdbPosterUrl,
  tmdbSwapImageHost
} from '../api/tmdb'
import { useSettingsStore } from '../stores/settings'
import { useLibraryStore, itemKey } from '../stores/library'
import { usePlayerStore } from '../stores/player'
import { toast } from '../composables/useToast'
import type { PosterItem, VodDetail, VodItem } from '../types'
import AppIcon from '../components/AppIcon.vue'
import EmptyState from '../components/EmptyState.vue'
import PosterCard from '../components/PosterCard.vue'
import DetailModal from '../components/DetailModal.vue'

const settings = useSettingsStore()
const library = useLibraryStore()
const player = usePlayerStore()
const route = useRoute()
const router = useRouter()

const content = ref('')
const region = ref('all')
const sourceId = ref('')
const items = ref<VodItem[]>([])
const page = ref(0)
const pageCount = ref(1)
const loading = ref(false)
const loadingMore = ref(false)
const error = ref('')
const feedErrors = ref(0)
const mounted = ref(false)
const sentinel = ref<HTMLElement | null>(null)
const modalTarget = ref<{ sourceId: string; id: string } | null>(null)

const heroIndex = ref(0)
const heroInfo = ref<VodDetail | null>(null)
const heroFading = ref(false)
const detailCache = new Map<string, VodDetail>()
let heroTimer = 0

const CONTENT_TABS = [
  { id: '', name: '推荐' },
  { id: 'movie', name: '电影' },
  { id: 'tv', name: '电视剧' },
  { id: 'short', name: '短剧' },
  { id: 'variety', name: '综艺' },
  { id: 'anime', name: '动漫' },
  { id: 'documentary', name: '纪录片' },
  { id: 'all', name: '全部影视' }
]

const SHELF_TYPES = [
  { id: 'movie', name: '热门电影' },
  { id: 'tv', name: '热门剧集' },
  { id: 'short', name: '短剧精选' },
  { id: 'variety', name: '综艺热播' },
  { id: 'anime', name: '动漫新番' }
]

const REGIONS = [
  { id: 'all', name: '全部地区' },
  { id: 'cn', name: '中国' },
  { id: 'us', name: '美国' },
  { id: 'jpkr', name: '日韩' },
  { id: 'hk', name: '港台' },
  { id: 'tw', name: '台湾' },
  { id: 'other', name: '其他' }
]

const TYPE_NOTES: Record<string, { mark: string; text: string }> = {
  movie: {
    mark: '影',
    text: '只显示识别为「电影」的条目：源站分类里带电影、影片、片名的都算，剧集和短剧不会混进来。'
  },
  tv: {
    mark: '剧',
    text: '只显示识别为「电视剧」的条目：短剧、综艺、动漫都单独归类，不会混进来。'
  },
  short: {
    mark: '短',
    text: '只显示识别为「短剧」的条目：源站标注短剧 / 爽文短剧 / 红果短剧的都算，竖屏短剧与电影、剧集完全分开。'
  },
  variety: { mark: '综', text: '只显示识别为「综艺」的条目。' },
  anime: { mark: '漫', text: '只显示识别为「动漫」的条目。' },
  documentary: { mark: '纪', text: '只显示识别为「纪录片」的条目。' }
}

const sourceRow = ref<HTMLElement | null>(null)
const canScrollLeft = ref(false)
const canScrollRight = ref(false)
const contentSources = ref<Record<string, string[]>>({})
const taxonomyReady = ref(false)

let observer: IntersectionObserver | null = null
let rowObserver: ResizeObserver | null = null

const onlineSources = computed(() => {
  const all = settings.activeVod
  if (!content.value || !taxonomyReady.value) return all
  const allowed = contentSources.value[content.value]
  if (!Array.isArray(allowed) || !allowed.length) return all
  return all.filter((item) => allowed.includes(item.id))
})
const source = computed(() => onlineSources.value.find((item) => item.id === sourceId.value))
const contentName = computed(
  () => CONTENT_TABS.find((item) => item.id === content.value)?.name || '全部影视'
)
const isTypeView = computed(() =>
  ['movie', 'tv', 'short', 'variety', 'anime', 'documentary'].includes(content.value)
)
const typeNote = computed(() => (isTypeView.value ? TYPE_NOTES[content.value] : null))
const regionName = computed(
  () => REGIONS.find((item) => item.id === region.value)?.name || '全部地区'
)

const description = computed(() => {
  if (!settings.checked) return '正在连接服务端…'
  if (!settings.online) return '影视点播由 NAS 服务端提供，连接后即可聚合搜索与播放'
  const parts = [source.value?.name || `${onlineSources.value.length} 个源聚合`]
  if (content.value) parts.push(contentName.value)
  if (content.value && content.value !== 'short' && region.value !== 'all') parts.push(regionName.value)
  if (loading.value) parts.push('正在加载')
  else if (items.value.length) parts.push(`${items.value.length} 部已加载`)
  return parts.join(' · ')
})

const continueList = computed(() => library.recentHistory.slice(0, 14))

interface Shelf {
  id: string
  name: string
  items: VodItem[]
}

const shelves = ref<Shelf[]>([])
const shelfLoading = ref(false)
const shelfError = ref('')
/** 全量片单里按类型归类的补充条目，用来覆盖被拆成多个分类的短剧题材 */
const extraByType = ref<Record<string, VodItem[]>>({})

/** 分类页严格按识别到的类型过滤，短剧不会再混进电影和剧集 */
const visibleItems = computed(() => {
  if (!content.value || content.value === 'all') return items.value
  const base = items.value.filter((item) => item.contentType === content.value)
  const extra = extraByType.value[content.value] || []
  const seen = new Set(base.map((item) => `${item.sourceId}:${item.id}`))
  return [...base, ...extra.filter((item) => !seen.has(`${item.sourceId}:${item.id}`))]
})

/** 卡片副标题统一显示归一后的类型（电影 / 电视剧 / 短剧…） */
function displayItem(item: VodItem): PosterItem {
  const label = contentTypeName(item.contentType || '')
  return label ? { ...item, typeName: label } : item
}

/** 同一行里限制单个片源的数量，避免一个源刷屏 */
function balanceShelf(list: VodItem[]): VodItem[] {
  const picked: VodItem[] = []
  const rest: VodItem[] = []
  const counts = new Map<string, number>()
  for (const item of [...list].sort(byHot)) {
    const used = counts.get(item.sourceId) || 0
    if (used < 2) {
      counts.set(item.sourceId, used + 1)
      picked.push(item)
    } else {
      rest.push(item)
    }
  }
  return [...picked, ...rest]
}

/** 拉一份全量片单，按识别到的类型分桶，用来补齐被拆成多个分类的短剧题材 */
async function loadExtra(): Promise<Record<string, VodItem[]>> {
  try {
    const result = await api.feed('', 'all', sourceId.value, 1)
    const extras: Record<string, VodItem[]> = {}
    for (const item of result.items) {
      if (!item.contentType) continue
      const bucket = extras[item.contentType] || (extras[item.contentType] = [])
      bucket.push(item)
    }
    extraByType.value = extras
    return extras
  } catch {
    return {}
  }
}

async function loadShelves() {
  if (!settings.online || settings.needsLogin) return
  shelfLoading.value = true
  shelfError.value = ''
  /** 分类片单要一条一条冒出来，不能等 5 个分类的全部片源都跑完才第一次上屏 */
  const pools = new Map<string, { items: VodItem[]; errors: { sourceId: string; message: string }[] }>()
  let extras: Record<string, VodItem[]> = {}
  const render = () => {
    const next: Shelf[] = []
    for (const shelf of SHELF_TYPES) {
      const pool = pools.get(shelf.id)
      if (!pool) continue
      const merged = [...pool.items, ...(extras[shelf.id] || [])]
      const seen = new Set<string>()
      const matched = merged.filter((item) => {
        if (item.contentType !== shelf.id) return false
        const key = `${item.sourceId}:${item.id}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      if (!matched.length) continue
      next.push({ ...shelf, items: balanceShelf(matched).slice(0, 14) })
    }
    if (next.length || pools.size === SHELF_TYPES.length) shelves.value = next
    return next.length
  }

  const extrasPromise = loadExtra()
  await Promise.all(
    SHELF_TYPES.map(async (shelf) => {
      try {
        const result = await api.feed(shelf.id, 'all', sourceId.value, 1)
        pools.set(shelf.id, { items: result.items, errors: result.errors || [] })
      } catch (error) {
        pools.set(shelf.id, {
          items: [],
          errors: [{ sourceId: '', message: error instanceof Error ? error.message : '分类加载失败' }]
        })
      }
      render()
    })
  )
  extras = await extrasPromise
  const shown = render()

  if (!shown) {
    const reasons = [
      ...new Set(
        [...pools.values()].flatMap((pool) => pool.errors.map((entry) => entry.message)).filter(Boolean)
      )
    ]
    shelfError.value = reasons.length
      ? reasons.slice(0, 3).join('；')
      : '没有识别到可分类的影视内容，刷新或更换片源再试。'
  }
  shelfLoading.value = false
}

function scoreOf(item: VodItem): number {
  const value = Number(item.score)
  return Number.isFinite(value) ? value : 0
}

function byHot(a: VodItem, b: VodItem): number {
  const diff = scoreOf(b) - scoreOf(a)
  if (diff) return diff
  return (b.time || 0) - (a.time || 0)
}

const ranked = computed(() => [...items.value].sort(byHot))

const HERO_TYPE_RE = /电影|电视剧|连续剧|剧集|国产剧|港剧|美剧|韩剧|日剧|动漫|综艺|纪录片|短剧/
const SPORTS_RE =
  /赛事|NBA|CBA|英超|西甲|德甲|意甲|法甲|中超|足球|篮球|排球|乒乓球|羽毛球|网球|WTA|ATP|电竞|直播/i

function heroRank(item: VodItem): number {
  let value = scoreOf(item)
  if (HERO_TYPE_RE.test(item.typeName || '')) value += 3
  if (/\d{4}/.test(item.year || '')) value += 1
  if (item.contentType === 'short') value -= 8
  if (SPORTS_RE.test(item.name)) value -= 30
  return value
}

const heroItems = computed(() => {
  const pool = items.value
    .filter((item) => !!item.pic)
    .sort((a, b) => heroRank(b) - heroRank(a))
  const counts = new Map<string, number>()
  const out: VodItem[] = []
  for (const item of pool) {
    const used = counts.get(item.sourceId) || 0
    if (used >= 2) continue
    counts.set(item.sourceId, used + 1)
    out.push(item)
    if (out.length === 5) break
  }
  return out
})
const heroItem = computed<VodItem | null>(() => {
  const list = heroItems.value
  if (!list.length) return null
  return list[Math.min(heroIndex.value, list.length - 1)] || null
})
const heroPicFailed = ref(false)
const heroBackdropFailed = ref(false)
const heroPosterFailed = ref(false)
const heroKey = computed(() => tmdbKey(heroItem.value?.name || '', heroItem.value?.year || ''))
const heroBackdrop = computed(() =>
  heroBackdropFailed.value ? '' : tmdbBackdropUrl(tmdbArts[heroKey.value], 'w1280')
)
const heroPoster = computed(() =>
  heroPosterFailed.value ? '' : tmdbPosterUrl(tmdbArts[heroKey.value], 'w780')
)
const heroSrc = computed(
  () => heroBackdrop.value || heroPoster.value || mediaUrl(heroItem.value?.pic || '')
)
const heroInitial = computed(() => (heroItem.value?.name || '').trim().slice(0, 2) || '影')
const heroHue = computed(() => {
  const name = heroItem.value?.name || ''
  let value = 0
  for (let index = 0; index < name.length; index += 1) {
    value = (value * 31 + name.charCodeAt(index)) % 360
  }
  return value
})
const heroScore = computed(() => {
  const raw = (heroInfo.value?.score || heroItem.value?.score || '').toString().trim()
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? raw : ''
})
const heroType = computed(
  () => contentTypeName(heroItem.value?.contentType || '') || heroItem.value?.typeName || ''
)
const heroDesc = computed(() => {
  const text = (heroInfo.value?.content || '').replace(/\s+/g, ' ').trim()
  if (!text || text === heroItem.value?.name?.trim()) return ''
  return text
})
const heroFavorited = computed(() => {
  const item = heroItem.value
  if (!item) return false
  return library.isFavorite(item.sourceId, item.id)
})

async function loadPage(next: number) {
  if (!settings.online || settings.needsLogin) return
  if (next === 1) {
    loading.value = true
    error.value = ''
    feedErrors.value = 0
  } else {
    loadingMore.value = true
  }
  try {
    const result = await api.feed(
      content.value,
      content.value ? region.value : 'all',
      sourceId.value,
      next
    )
    if (next === 1) {
      items.value = result.items
    } else {
      const seen = new Set(items.value.map((item) => `${item.sourceId}:${item.id}`))
      items.value = [
        ...items.value,
        ...result.items.filter((item) => !seen.has(`${item.sourceId}:${item.id}`))
      ]
    }
    feedErrors.value = result.errors?.length || 0
    page.value = next
    pageCount.value = Math.max(1, result.pageCount || 1)
    if (!result.items.length && next > 1) pageCount.value = next
    if (next === 1 && !result.items.length && result.errors?.length) {
      const reasons = [...new Set(result.errors.map((item) => item.message))]
      error.value = reasons.slice(0, 3).join('；')
      extraByType.value = {}
    }
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '加载影视列表失败'
    if (next === 1) items.value = []
    pageCount.value = next
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

function reload() {
  items.value = []
  page.value = 0
  pageCount.value = 1
  heroIndex.value = 0
  return loadPage(1)
}

function loadMore() {
  if (loading.value || loadingMore.value || page.value >= pageCount.value) return
  loadPage(page.value + 1)
}

function pickSource() {
  if (sourceId.value && !onlineSources.value.some((item) => item.id === sourceId.value)) {
    sourceId.value = ''
  }
}

function chooseContent(id: string) {
  content.value = id
  if (!id || id === 'short') region.value = 'all'
}

async function loadTaxonomy() {
  if (!settings.online || settings.needsLogin) return
  try {
    const data = await api.taxonomy()
    contentSources.value = data.contentSources || {}
  } catch {
    /* 分类索引失败时保留全部片源 */
  } finally {
    taxonomyReady.value = true
    void nextTick(updateScrollState)
  }
}

function updateScrollState() {
  const element = sourceRow.value
  if (!element) return
  canScrollLeft.value = element.scrollLeft > 4
  canScrollRight.value = element.scrollLeft + element.clientWidth < element.scrollWidth - 4
}

function scrollSourceRow(delta: number) {
  const element = sourceRow.value
  if (!element) return
  const max = Math.max(0, element.scrollWidth - element.clientWidth)
  element.scrollLeft = Math.max(0, Math.min(max, element.scrollLeft + delta))
  updateScrollState()
}

function onSourceWheel(event: WheelEvent) {
  const element = sourceRow.value
  if (!element || element.scrollWidth <= element.clientWidth) return
  const delta = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX
  if (!delta) return
  event.preventDefault()
  element.scrollLeft += delta
}

function openDetail(item: PosterItem) {
  modalTarget.value = { sourceId: item.sourceId, id: item.id }
}

function openHistory(source: string, id: string) {
  modalTarget.value = { sourceId: source, id }
}

function progressOf(source: string, id: string): number {
  const entry = library.progressOf(source, id)
  if (!entry || !entry.duration) return 0
  return entry.position / entry.duration
}

function historyItem(entry: (typeof library.recentHistory)[number]): VodItem {
  return {
    sourceId: entry.sourceId,
    sourceName: entry.sourceName,
    id: entry.id,
    name: entry.name,
    pic: entry.pic,
    remarks: entry.episodeName || '',
    year: '',
    typeName: entry.episodeName || '',
    area: '',
    score: '',
    time: entry.updatedAt
  }
}

async function heroPlay() {
  const item = heroItem.value
  if (!item) return
  if (heroInfo.value) {
    player.openVod(heroInfo.value, 0, 0, 0)
    return
  }
  try {
    const detail = await api.detail(item.sourceId, item.id)
    if (detail && `${detail.sourceId}:${detail.id}` === `${item.sourceId}:${item.id}`) {
      detailCache.set(`${item.sourceId}:${item.id}`, detail)
      heroInfo.value = detail
      player.openVod(detail, 0, 0, 0)
      return
    }
  } catch {
    /* 详情加载失败时退回弹窗，让用户手动选线路 */
  }
  openDetail(item)
}

function heroFavorite() {
  const item = heroItem.value
  if (!item) return
  const added = library.toggleFavorite({ ...item })
  toast.success(added ? '已加入清单' : '已移出清单')
}

function setHeroIndex(index: number) {
  const list = heroItems.value
  if (!list.length) return
  heroFading.value = true
  heroIndex.value = ((index % list.length) + list.length) % list.length
  window.setTimeout(() => {
    heroFading.value = false
  }, 260)
}

let heroFailures = 0
function onHeroPicError() {
  if (tmdbSwapImageHost(heroSrc.value)) return
  if (heroBackdrop.value) {
    heroBackdropFailed.value = true
    return
  }
  if (heroPoster.value) {
    heroPosterFailed.value = true
    return
  }
  heroPicFailed.value = true
  heroFailures += 1
  if (heroFailures > 3 || heroItems.value.length < 2) return
  window.setTimeout(() => {
    if (document.hidden || player.open || modalTarget.value) return
    setHeroIndex(heroIndex.value + 1)
  }, 1200)
}

async function loadHeroInfo() {
  const item = heroItem.value
  if (!item) {
    heroInfo.value = null
    return
  }
  const key = `${item.sourceId}:${item.id}`
  const cached = detailCache.get(key)
  if (cached) {
    heroInfo.value = cached
    return
  }
  heroInfo.value = null
  try {
    const detail = await api.detail(item.sourceId, item.id)
    if (detail && `${detail.sourceId}:${detail.id}` === key) {
      detailCache.set(key, detail)
      heroInfo.value = detail
    }
  } catch {
    /* 简介加载失败时保留海报与片名 */
  }
}

function startHeroTimer() {
  stopHeroTimer()
  heroTimer = window.setInterval(() => {
    if (document.hidden || player.open || modalTarget.value) return
    if (heroItems.value.length < 2) return
    setHeroIndex(heroIndex.value + 1)
  }, 8000)
}

function stopHeroTimer() {
  if (heroTimer) window.clearInterval(heroTimer)
  heroTimer = 0
}

onMounted(async () => {
  await settings.init()
  mounted.value = true
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore()
    },
    { rootMargin: '480px 0px' }
  )
  if (sentinel.value) observer.observe(sentinel.value)
  pickSource()
  if (!settings.needsLogin) reload()
  void loadTaxonomy()
  if (content.value === '') void loadShelves()
  startHeroTimer()
  window.addEventListener('resize', updateScrollState)
  if (typeof ResizeObserver !== 'undefined' && sourceRow.value) {
    rowObserver = new ResizeObserver(() => updateScrollState())
    rowObserver.observe(sourceRow.value)
  }
  void nextTick(updateScrollState)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  rowObserver?.disconnect()
  window.removeEventListener('resize', updateScrollState)
  stopHeroTimer()
})

watch([content, region, sourceId], () => {
  if (!mounted.value) return
  reload()
  if (content.value === '') void loadShelves()
  else if (isTypeView.value) void loadExtra()
})

watch(
  () => onlineSources.value.map((item) => item.id).join('|'),
  () => {
    if (!mounted.value) return
    pickSource()
    reload()
    if (content.value === '') void loadShelves()
    void nextTick(updateScrollState)
  }
)

watch(sourceRow, (element) => {
  rowObserver?.disconnect()
  if (typeof ResizeObserver !== 'undefined' && element) {
    rowObserver = new ResizeObserver(() => updateScrollState())
    rowObserver.observe(element)
  }
  void nextTick(updateScrollState)
})

watch(sentinel, (element) => {
  if (!observer) return
  observer.disconnect()
  if (element) observer.observe(element)
})

watch(
  () => settings.needsLogin,
  (needed) => {
    if (needed) {
      items.value = []
      error.value = ''
    }
  }
)

watch(
  () => heroItem.value && `${heroItem.value.sourceId}:${heroItem.value.id}`,
  () => {
    heroPicFailed.value = false
    heroBackdropFailed.value = false
    heroPosterFailed.value = false
    void loadHeroInfo()
  },
  { immediate: true }
)

watch(heroItems, (list) => {
  heroFailures = 0
  for (const item of list) tmdbEnsure(item.name, item.year, item.contentType || '')
  if (!list.length) return
  if (heroIndex.value > list.length - 1) heroIndex.value = 0
})

watch(
  () => route.fullPath,
  () => {
    if (route.name === 'movies') startHeroTimer()
    else stopHeroTimer()
  }
)
</script>

<template>
  <div class="movies-wrap">
    <section
      v-if="heroItem"
      class="hero"
      :class="{ fading: heroFading }"
      aria-label="本月主打"
    >
      <div class="hero-art">
        <div
          class="hero-fallback"
          :style="{
            background: `linear-gradient(135deg, hsl(${heroHue} 42% 24%), #0d0d11 72%)`
          }"
        >
          <span>{{ heroInitial }}</span>
        </div>
        <img
          v-if="!heroPicFailed && !heroBackdrop && heroItem.pic"
          class="hero-ambient"
          :src="mediaUrl(heroItem.pic)"
          alt=""
          aria-hidden="true"
          referrerpolicy="no-referrer"
        />
        <img
          v-if="!heroPicFailed"
          :key="`${heroItem.sourceId}:${heroItem.id}:${heroBackdrop ? 'tmdb' : 'src'}`"
          :class="{ 'is-poster': !heroBackdrop }"
          :src="heroSrc"
          :alt="heroItem.name"
          loading="eager"
          decoding="async"
          referrerpolicy="no-referrer"
          @error="onHeroPicError()"
        />
        <span class="fade-y" />
        <span class="fade-x" />
      </div>
      <div class="hero-body">
        <div class="hero-meta">
          <span class="hero-brand">K</span>
          <span v-if="heroType" class="hero-type">{{ heroType }}</span>
          <span v-if="heroScore" class="hero-score">{{ heroScore }} 分</span>
          <span v-if="heroItem.year">{{ heroItem.year }}</span>
          <span v-if="heroItem.area">{{ heroItem.area }}</span>
          <span class="hero-hd">HD</span>
        </div>
        <h1 class="hero-title">{{ heroItem.name }}</h1>
        <p v-if="heroDesc" class="hero-desc">{{ heroDesc }}</p>
        <div class="hero-cta">
          <button class="btn play" data-nav type="button" @click="heroPlay">
            <AppIcon name="play" :size="19" />
            播放
          </button>
          <button class="btn info" data-nav type="button" @click="openDetail(heroItem)">
            <AppIcon name="info" :size="18" />
            更多信息
          </button>
          <button
            class="btn round"
            :class="{ favored: heroFavorited }"
            data-nav
            type="button"
            :title="heroFavorited ? '从清单移除' : '加入清单'"
            @click="heroFavorite"
          >
            <AppIcon name="bookmark" :size="17" />
          </button>
          <RouterLink class="btn round live-cta" to="/live" data-nav title="看电视直播">
            <AppIcon name="live" :size="17" />
          </RouterLink>
        </div>
        <div v-if="heroItems.length > 1" class="hero-dots">
          <button
            v-for="(item, index) in heroItems"
            :key="`${item.sourceId}:${item.id}`"
            class="hero-dot"
            :class="{ on: index === heroIndex }"
            type="button"
            :aria-label="`切换到 ${item.name}`"
            @click="setHeroIndex(index)"
          />
        </div>
      </div>
    </section>

    <div class="movies-body">
      <div class="page-head">
        <div>
          <h1 class="page-title"><span class="bar" />影视专区</h1>
          <p class="page-desc">{{ description }}</p>
        </div>
        <div class="page-actions">
          <RouterLink class="btn" to="/search" data-nav>
            <AppIcon name="search" :size="16" />
            聚合搜索
          </RouterLink>
          <RouterLink class="btn" to="/hot" data-nav>
            <AppIcon name="flame" :size="16" />
            热门榜
          </RouterLink>
        </div>
      </div>

      <template v-if="settings.online && !settings.needsLogin">
        <section class="section-block filter-block">
          <div class="chip-row hide-scrollbar">
            <button
              v-for="tab in CONTENT_TABS"
              :key="tab.id"
              class="chip"
              :class="{ active: content === tab.id }"
              data-nav
              type="button"
              @click="chooseContent(tab.id)"
            >
              {{ tab.name }}
            </button>
          </div>
          <div v-if="isTypeView" class="chip-row hide-scrollbar">
            <button
              v-for="item in REGIONS"
              :key="item.id"
              class="chip"
              :class="{ active: region === item.id }"
              data-nav
              type="button"
              @click="region = item.id"
            >
              {{ item.name }}
            </button>
          </div>
          <div v-if="typeNote" class="short-note">
            <span class="short-mark">{{ typeNote.mark }}</span>
            {{ typeNote.text }}
          </div>

          <div class="source-row">
            <span class="source-label">
              片源
              <em v-if="content">{{ onlineSources.length }}</em>
            </span>
            <div class="chip-shell">
              <button
                v-show="canScrollLeft"
                class="chip-arrow left"
                type="button"
                tabindex="-1"
                aria-label="向左滚动片源"
                @click="scrollSourceRow(-260)"
              >
                <AppIcon name="back" :size="15" />
              </button>
              <div
                ref="sourceRow"
                class="chip-row hide-scrollbar"
                @wheel="onSourceWheel"
                @scroll.passive="updateScrollState"
              >
                <button
                  class="chip"
                  :class="{ active: sourceId === '' }"
                  data-nav
                  type="button"
                  @click="sourceId = ''"
                >
                  全部源
                </button>
                <button
                  v-for="item in onlineSources"
                  :key="item.id"
                  class="chip"
                  :class="{ active: sourceId === item.id }"
                  data-nav
                  type="button"
                  @click="sourceId = item.id"
                >
                  {{ item.name }}
                </button>
              </div>
              <button
                v-show="canScrollRight"
                class="chip-arrow right"
                type="button"
                tabindex="-1"
                aria-label="向右滚动片源"
                @click="scrollSourceRow(260)"
              >
                <AppIcon name="right" :size="15" />
              </button>
            </div>
          </div>
        </section>
      </template>

      <section v-if="continueList.length" class="section-block">
        <h2 class="section-title">
          <span class="mark" />
          继续观看
          <span class="hint">按最近播放排序</span>
        </h2>
        <div class="row-scroll hide-scrollbar">
          <PosterCard
            v-for="entry in continueList"
            :key="itemKey(entry.sourceId, entry.id)"
            :item="historyItem(entry)"
            :progress="progressOf(entry.sourceId, entry.id)"
            compact
            @select="openHistory(entry.sourceId, entry.id)"
          />
        </div>
      </section>

      <template v-if="settings.online && !settings.needsLogin">
        <template v-if="content === ''">
          <section v-if="shelfLoading && !shelves.length" class="section-block">
            <h2 class="section-title">
              <span class="mark" />
              正在按类型整理
            </h2>
            <div class="row-scroll hide-scrollbar">
              <div v-for="index in 8" :key="index" class="skeleton poster-skeleton" />
            </div>
          </section>

          <EmptyState
            v-else-if="shelfError"
            title="暂时没能整理出分类片单"
            :message="shelfError"
            icon="film"
          >
            <div class="state-actions">
              <button class="btn" data-nav type="button" @click="loadShelves">重试</button>
              <button v-if="sourceId" class="btn" data-nav type="button" @click="sourceId = ''">
                改回全部片源
              </button>
            </div>
          </EmptyState>

          <section v-for="shelf in shelves" v-else :key="shelf.id" class="section-block">
            <h2 class="section-title">
              <span class="mark" />
              {{ shelf.name }}
              <span class="hint">{{ shelf.items.length }} 部</span>
              <button class="section-more" data-nav type="button" @click="chooseContent(shelf.id)">
                查看全部
                <AppIcon name="right" :size="14" />
              </button>
            </h2>
            <div class="row-scroll hide-scrollbar">
              <PosterCard
                v-for="item in shelf.items"
                :key="`${item.sourceId}:${item.id}`"
                :item="displayItem(item)"
                :progress="progressOf(item.sourceId, item.id)"
                compact
                @select="openDetail"
              />
            </div>
          </section>
        </template>

        <section v-else class="section-block">
          <h2 class="section-title">
            <span class="mark" />
            {{ contentName }}
            <span v-if="!error" class="hint">{{ visibleItems.length }} 部已加载</span>
          </h2>

          <div v-if="loading" class="poster-grid">
            <div v-for="index in 22" :key="index" class="skeleton poster-skeleton" />
          </div>

          <EmptyState v-else-if="error" title="列表加载失败" :message="error" icon="warn">
            <div class="state-actions">
              <button class="btn" data-nav @click="loadPage(1)">重试</button>
              <button v-if="sourceId" class="btn" data-nav @click="sourceId = ''">
                改回全部片源
              </button>
            </div>
          </EmptyState>

          <EmptyState
            v-else-if="!visibleItems.length"
            title="这个分类暂时没有内容"
            :message="
              sourceId
                ? `${source?.name || '所选片源'} 没有返回${contentName}内容，可以重试或改回全部片源。`
                : '换一个分类、地区或片源试试。分类按源站标注逐条识别，识别不出的条目只会出现在「全部影视」里。'
            "
            icon="film"
          >
            <div class="state-actions">
              <button class="btn" data-nav @click="loadPage(1)">重试</button>
              <button v-if="sourceId" class="btn" data-nav @click="sourceId = ''">
                改回全部片源
              </button>
            </div>
          </EmptyState>

          <template v-else>
            <div class="poster-grid">
              <PosterCard
                v-for="item in visibleItems"
                :key="`${item.sourceId}:${item.id}`"
                :item="displayItem(item)"
                :progress="progressOf(item.sourceId, item.id)"
                @select="openDetail"
              />
            </div>
            <div ref="sentinel" class="load-more">
              <button
                v-if="page < pageCount"
                class="btn"
                data-nav
                :disabled="loadingMore"
                @click="loadMore"
              >
                <span v-if="loadingMore" class="spinner small" />
                <AppIcon v-else name="down" :size="16" />
                {{ loadingMore ? '正在加载' : '加载更多' }}
              </button>
              <span v-else class="end-note">
                已经到底了
                <template v-if="feedErrors"> · {{ feedErrors }} 个源暂时不可用</template>
              </span>
            </div>
          </template>
        </section>
      </template>

      <EmptyState
        v-else-if="settings.needsLogin"
        title="需要登录后观看"
        message="站点已开启仅登录用户访问，请使用管理员创建的账号登录。"
        icon="server"
      >
        <RouterLink class="btn red" to="/login" data-nav>去登录</RouterLink>
      </EmptyState>

      <EmptyState
        v-else-if="settings.checked"
        title="影视点播需要连接 NAS 服务"
        message="直播可直接播放；影视源的搜索、分类和代理播放由服务端完成。启动 KayTV 服务端后填入地址即可。"
        icon="server"
      >
        <RouterLink class="btn red" to="/settings" data-nav>连接服务端</RouterLink>
      </EmptyState>

      <div v-else class="loading-row">
        <span class="spinner" />
        正在连接服务端…
      </div>
    </div>

    <DetailModal
      v-if="modalTarget"
      :source-id="modalTarget.sourceId"
      :vod-id="modalTarget.id"
      @close="modalTarget = null"
    />
  </div>
</template>

<style scoped>
.movies-wrap {
  width: 100%;
  max-width: 1880px;
  margin: 0 auto;
}
/* 空态里的操作按钮横向排布，避免两个宽度不同的按钮上下堆叠 */
.state-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
  margin-top: 6px;
}
.movies-body {
  padding: 0 clamp(16px, 3.4vw, 56px) 96px;
}
.hero .hero-art img {
  animation: hero-in 0.5s ease;
}
/* 无 TMDB 背景图时：竖海报不再裁切铺满，改为环境光糊底 + 海报靠右 */
.hero .hero-ambient {
  position: absolute;
  inset: -48px;
  width: calc(100% + 96px);
  height: calc(100% + 96px);
  object-fit: cover;
  filter: blur(46px) brightness(0.4) saturate(1.12);
}
.hero .hero-art img.is-poster {
  object-fit: contain;
  object-position: 84% 62%;
  filter: brightness(0.94) drop-shadow(0 20px 46px rgba(0, 0, 0, 0.6));
}
.hero.fading .hero-body {
  opacity: 0.35;
}
.hero-body {
  transition: opacity 0.24s ease;
}
@keyframes hero-in {
  from {
    opacity: 0.2;
    transform: scale(1.04);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.btn.round.favored {
  border-color: #fff;
  background: rgba(255, 255, 255, 0.9);
  color: #000;
}
.filter-block {
  margin-top: 10px;
}
.short-note {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 2px 0 12px;
  padding: 11px 15px;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.6;
}
.short-mark {
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: 4px;
  background: var(--accent);
  color: #fff;
  font-weight: 800;
  font-size: 14px;
}
.source-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
}
.source-label {
  flex: 0 0 auto;
  display: flex;
  align-items: baseline;
  gap: 4px;
  font-size: 12px;
  color: var(--muted-2);
  letter-spacing: 0.08em;
}
.source-label em {
  font-style: normal;
  font-size: 11px;
  letter-spacing: 0;
  color: var(--accent);
}
.chip-shell {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
}
.source-row .chip-row {
  flex: 1;
  min-width: 0;
  overscroll-behavior-x: contain;
  -webkit-overflow-scrolling: touch;
}
.source-row .chip {
  font-size: 12.5px;
  padding: 6px 11px;
}
.chip-arrow {
  position: absolute;
  top: 50%;
  z-index: 2;
  display: grid;
  place-items: center;
  width: 27px;
  height: 27px;
  padding: 0;
  transform: translateY(-50%);
  border-radius: 50%;
  border: 1px solid var(--line-strong);
  background: rgba(14, 14, 18, 0.94);
  color: var(--text);
  cursor: pointer;
  box-shadow: 0 5px 14px rgba(0, 0, 0, 0.45);
}
.chip-arrow:hover {
  background: var(--surface-2);
  color: var(--accent);
}
.chip-arrow.left {
  left: -8px;
}
.chip-arrow.right {
  right: -8px;
}
.poster-skeleton {
  aspect-ratio: 2 / 3;
  border-radius: 4px;
}
.load-more {
  display: flex;
  justify-content: center;
  padding: 30px 0 10px;
}
.end-note {
  font-size: 12.5px;
  color: var(--muted-2);
}
.spinner.small {
  width: 15px;
  height: 15px;
  border-width: 2px;
}
@media (max-width: 720px) {
  .movies-body {
    padding: 4px 14px calc(var(--tabbar-h) + env(safe-area-inset-bottom) + 26px);
  }
  .hero .hero-ambient {
    display: none;
  }
  .hero .hero-art img.is-poster {
    object-fit: cover;
    object-position: center 30%;
    filter: brightness(0.8) saturate(1.03);
  }
  .hero {
    border-radius: 0;
    border-left: 0;
    border-right: 0;
    border-top: 0;
    height: 330px;
  }
  .hero-cta {
    gap: 8px;
  }
  .hero-cta .btn {
    min-height: 38px;
    font-size: 12px;
    padding: 0 12px;
  }
  .hero-cta .btn.round {
    width: 38px;
    min-height: 38px;
    padding: 0;
  }
  .live-cta {
    display: none;
  }
  .source-row {
    align-items: center;
  }
  .source-label {
    width: 30px;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
  }
  .source-label em {
    font-size: 10px;
  }
  .chip-arrow {
    display: none;
  }
}
</style>

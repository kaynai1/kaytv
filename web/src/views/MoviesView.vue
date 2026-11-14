<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { contentTypeName } from '@kaytv/shared'
import { api } from '../api/client'
import { mediaUrl } from '../api/runtime'
import { tmdbArts, tmdbEnsure, tmdbKey, tmdbPosterUrl, tmdbSwapImageHost } from '../api/tmdb'
import { useSettingsStore } from '../stores/settings'
import { useLibraryStore, itemKey } from '../stores/library'
import { usePlayerStore } from '../stores/player'
import { toast } from '../composables/useToast'
import type { PosterItem, VodItem } from '../types'
import AppIcon from '../components/AppIcon.vue'
import EmptyState from '../components/EmptyState.vue'
import PosterCard from '../components/PosterCard.vue'

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
const filterOpen = ref(false)

const CONTENT_TABS = [
  { id: '', name: '推荐' },
  { id: 'movie', name: '电影' },
  { id: 'tv', name: '电视剧' },
  { id: 'short', name: '短剧' },
  { id: 'variety', name: '综艺' },
  { id: 'anime', name: '动漫' },
  { id: 'documentary', name: '纪录片' },
  { id: 'all', name: '全部' }
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

const TYPE_NOTES: Record<string, string> = {
  movie: '只显示识别为「电影」的条目，剧集和短剧不会混进来。',
  tv: '只显示识别为「电视剧」的条目，短剧、综艺、动漫单独归类。',
  short: '只显示识别为「短剧」的条目，与电影、剧集完全分开。',
  variety: '只显示识别为「综艺」的条目。',
  anime: '只显示识别为「动漫」的条目。',
  documentary: '只显示识别为「纪录片」的条目。'
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
const typeNote = computed(() => (isTypeView.value ? TYPE_NOTES[content.value] : ''))
const regionName = computed(
  () => REGIONS.find((item) => item.id === region.value)?.name || '全部地区'
)

const siteLabel = computed(() => {
  if (settings.standalone) return '内置模式'
  if (!settings.checked) return '连接中…'
  if (!settings.online) return '未连接'
  try {
    return new URL(settings.displayServer).host
  } catch {
    return '已连接'
  }
})

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

/** 全量片单里按类型归类的补充条目，用来覆盖被拆成多个分类的短剧题材 */
const extraByType = ref<Record<string, VodItem[]>>({})

const RECOMMEND_TYPES = new Set(['movie', 'tv'])
const CURRENT_YEAR = new Date().getFullYear()

function yearOf(item: VodItem): number {
  const match = /(19|20)\d{2}/.exec(item.year || '')
  return match ? Number(match[0]) : 0
}

/** 源站常把未上映的项目标成未来年份，推荐只认已经发行的年份 */
function releaseYear(item: VodItem): number {
  const year = yearOf(item)
  return year > 1900 && year <= CURRENT_YEAR ? year : 0
}

/** 推荐位只收电影和电视剧，按最新年份、最近更新排，老片和综艺动漫不占首屏 */
const recommendItems = computed(() => {
  const pool = items.value.filter((item) => RECOMMEND_TYPES.has(item.contentType || ''))
  if (!pool.length) return items.value
  return [...pool].sort(
    (a, b) =>
      releaseYear(b) - releaseYear(a) || (b.time || 0) - (a.time || 0) || scoreOf(b) - scoreOf(a)
  )
})

/** 分类页严格按识别到的类型过滤，短剧不会再混进电影和剧集 */
const visibleItems = computed(() => {
  if (!content.value) return recommendItems.value
  if (content.value === 'all') return items.value
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

/** 拉一份全量片单，按识别到的类型分桶，用来补齐被拆成多个分类的短剧题材 */
let extraToken = 0

async function loadExtra(): Promise<Record<string, VodItem[]>> {
  const token = ++extraToken
  try {
    const result = await api.feed('', 'all', sourceId.value, 1)
    const extras: Record<string, VodItem[]> = {}
    for (const item of result.items) {
      if (!item.contentType) continue
      const bucket = extras[item.contentType] || (extras[item.contentType] = [])
      bucket.push(item)
    }
    // 切分类时旧请求晚到，别把新分类的补充片单覆盖掉
    if (token === extraToken) extraByType.value = extras
    return extras
  } catch {
    return {}
  }
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

/** 精选位跟着最新发布走：先锁定最新发行年份，再在同一年里挑评分和热度最高的 */
const featured = computed<VodItem | null>(() => {
  const pool = recommendItems.value.filter((item) => !!item.pic)
  if (!pool.length) return ranked.value[0] || null
  const newestYear = Math.max(...pool.map(releaseYear))
  const newest = pool.filter((item) => releaseYear(item) === newestYear)
  return newest.sort(
    (a, b) => scoreOf(b) - scoreOf(a) || (b.time || 0) - (a.time || 0)
  )[0]
})
const featuredType = computed(
  () => contentTypeName(featured.value?.contentType || '') || featured.value?.typeName || ''
)
const featuredMeta = computed(() =>
  [featured.value?.year, featuredType.value, featured.value?.area].filter(Boolean).join(' · ')
)
const featuredKey = computed(() => tmdbKey(featured.value?.name || '', featured.value?.year || ''))
const featuredFailed = ref(false)
const featuredSrc = computed(() => {
  if (!featuredFailed.value) {
    const tmdb = tmdbPosterUrl(tmdbArts[featuredKey.value], 'w500')
    if (tmdb) return tmdb
  }
  return mediaUrl(featured.value?.pic || '')
})
/** TV / 桌面端首推卡用同一张海报做模糊背景 */
const heroStyle = computed(() =>
  featuredSrc.value ? { '--hero-art': `url(${JSON.stringify(featuredSrc.value)})` } : undefined
)
const featuredFavorited = computed(() => {
  const item = featured.value
  if (!item) return false
  return library.isFavorite(item.sourceId, item.id)
})

function onFeaturedError() {
  if (featuredFailed.value) return
  const tmdb = tmdbPosterUrl(tmdbArts[featuredKey.value], 'w500')
  if (tmdb && tmdbSwapImageHost(tmdb)) return
  featuredFailed.value = true
}

let featuredToken = 0
async function featuredPlay() {
  const item = featured.value
  if (!item) return
  const token = ++featuredToken
  try {
    const detail = await api.detail(item.sourceId, item.id)
    if (token !== featuredToken) return
    if (detail && `${detail.sourceId}:${detail.id}` === `${item.sourceId}:${item.id}`) {
      player.openVod(detail, 0, 0, 0)
      return
    }
  } catch {
    /* 详情加载失败时退回弹窗，让用户手动选线路 */
  }
  if (token === featuredToken) openDetail(item)
}

function featuredFavorite() {
  const item = featured.value
  if (!item) return
  const added = library.toggleFavorite({ ...item })
  toast.success(added ? '已加入清单' : '已移出清单')
}

let feedToken = 0

async function loadPage(next: number) {
  if (!settings.online || settings.needsLogin) return
  const token = next === 1 ? ++feedToken : feedToken
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
      next,
      next === 1
        ? (partial) => {
            // 先到先上屏：不等最慢的片源，首屏能早几秒看到海报
            if (token !== feedToken || !partial.items.length) return
            items.value = partial.items
            loading.value = false
            error.value = ''
          }
        : undefined
    )
    if (token !== feedToken) return
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
    if (token !== feedToken) return
    // 首屏已经先到先上屏了，别用错误页把看得见的卡片盖掉
    if (next === 1 && items.value.length) {
      pageCount.value = next
      return
    }
    error.value = caught instanceof Error ? caught.message : '加载影视列表失败'
    if (next === 1) items.value = []
    pageCount.value = next
  } finally {
    // 旧请求收尾时别把新请求的加载状态一起关掉
    if (token === feedToken) {
      loading.value = false
      loadingMore.value = false
    }
  }
}

function reload() {
  items.value = []
  page.value = 0
  pageCount.value = 1
  featuredFailed.value = false
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
  void router.push({ name: 'detail', params: { source: item.sourceId, id: item.id } })
}

function openHistory(source: string, id: string) {
  void router.push({ name: 'detail', params: { source, id } })
}

function progressOf(source: string, id: string): number {
  const entry = library.progressOf(source, id)
  if (!entry || !entry.duration) return 0
  return entry.position / entry.duration
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
  // 首屏先让主片单抢带宽，分类索引晚一点再补
  window.setTimeout(() => {
    if (mounted.value) void loadTaxonomy()
  }, 1500)
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
})

watch(featured, (item) => {
  featuredFailed.value = false
  if (item) tmdbEnsure(item.name, item.year, item.contentType || '')
})

watch([content, region, sourceId], () => {
  if (!mounted.value) return
  reload()
  if (isTypeView.value) void loadExtra()
})

watch(
  () => onlineSources.value.map((item) => item.id).join('|'),
  () => {
    if (!mounted.value) return
    pickSource()
    reload()
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
  () => route.fullPath,
  () => {
    if (route.name === 'movies') updateScrollState()
  }
)
</script>

<template>
  <div class="movies-wrap">
    <header class="mm-head">
      <RouterLink class="mm-brand" to="/" data-nav>
        <span class="mm-logo"><AppIcon name="play" :size="16" /></span>
        <span class="mm-wordmark">{{ settings.siteName }}</span>
      </RouterLink>
      <RouterLink class="mm-site" to="/settings" data-nav :title="settings.displayServer">
        <span class="mm-site-dot" :class="{ online: settings.online }" />
        <span class="mm-site-name">{{ siteLabel }}</span>
        <AppIcon name="down" :size="12" />
      </RouterLink>
      <div class="mm-head-actions">
        <RouterLink class="mm-round" to="/search" data-nav title="搜索">
          <AppIcon name="search" :size="16" />
        </RouterLink>
      </div>
    </header>

    <div class="mm-body">
      <template v-if="settings.online && !settings.needsLogin">
        <div class="mm-tvhead">
          <span class="mm-tvlogo"><AppIcon name="play" :size="18" /></span>
          <h1>发现</h1>
          <button class="mm-site" type="button" data-nav @click="filterOpen = true">
            <span class="mm-site-dot" :class="{ online: settings.online }" />
            <span class="mm-site-name">{{ source?.name || '全部片源' }}</span>
            <AppIcon name="down" :size="12" />
          </button>
        </div>

        <section v-if="continueList.length" class="mm-history">
          <div class="mm-sec-head">
            <h2>历史记录</h2>
            <RouterLink class="mm-more" to="/favorites" data-nav>查看全部</RouterLink>
          </div>
          <div class="mm-history-row hide-scrollbar">
            <button
              v-for="entry in continueList"
              :key="itemKey(entry.sourceId, entry.id)"
              class="mm-history-card"
              data-nav
              type="button"
              @click="openHistory(entry.sourceId, entry.id)"
            >
              <span class="mm-history-art">
                <img
                  v-if="entry.pic"
                  :src="mediaUrl(entry.pic)"
                  alt=""
                  loading="lazy"
                  referrerpolicy="no-referrer"
                />
                <span v-else class="mm-history-fallback">{{ entry.name.slice(0, 1) }}</span>
              </span>
              <span class="mm-history-info">
                <strong>{{ entry.name }}</strong>
                <span>{{ entry.episodeName || '上次看到这里' }}</span>
                <span class="mm-history-bar">
                  <span :style="{ width: `${Math.min(100, progressOf(entry.sourceId, entry.id) * 100)}%` }" />
                </span>
              </span>
            </button>
          </div>
        </section>

        <section v-if="featured" class="mm-hero" :style="heroStyle">
          <button class="mm-hero-poster" type="button" data-nav @click="openDetail(featured)">
            <img
              v-if="featuredSrc && !featuredFailed"
              :key="featuredKey"
              :src="featuredSrc"
              :alt="featured.name"
              loading="eager"
              decoding="async"
              referrerpolicy="no-referrer"
              @error="onFeaturedError"
            />
            <span v-else class="mm-hero-fallback">{{ featured.name.slice(0, 1) }}</span>
          </button>
          <div class="mm-hero-info">
            <span class="mm-hero-kicker">
              ✦ 今日首推<template v-if="featured.sourceName"> · {{ featured.sourceName }}</template>
            </span>
            <h2 class="mm-hero-title">{{ featured.name }}</h2>
            <div class="mm-hero-chips">
              <span v-if="scoreOf(featured) > 0" class="mm-hero-score">{{ featured.score }}</span>
              <span v-if="featured.year">{{ featured.year }}</span>
              <span v-if="featuredType">{{ featuredType }}</span>
              <span v-if="featured.area">{{ featured.area }}</span>
            </div>
            <button class="mm-hero-play" type="button" data-nav @click="featuredPlay">
              <AppIcon name="play" :size="13" />
              立即观看
            </button>
          </div>
        </section>

        <div class="mm-catrow">
          <div class="chip-row hide-scrollbar mm-tabs">
            <button
              v-for="tab in CONTENT_TABS"
              :key="tab.id"
              class="mm-pill"
              :class="{ on: content === tab.id }"
              data-nav
              type="button"
              @click="chooseContent(tab.id)"
            >
              {{ tab.name }}
            </button>
          </div>
          <button class="mm-filter-btn" type="button" data-nav @click="filterOpen = true">
            <AppIcon name="filter" :size="14" />
            筛选
          </button>
        </div>

        <section class="mm-feed">
          <div v-if="loading" class="poster-grid">
            <div v-for="index in 18" :key="index" class="skeleton poster-skeleton" />
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
                : '换一个分类、地区或片源试试。分类按源站标注逐条识别，识别不出的条目只会出现在「全部」里。'
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

    <transition name="sheet">
      <div v-if="filterOpen" class="mm-sheet-mask" @click.self="filterOpen = false">
        <div class="mm-sheet">
          <span class="mm-sheet-grab" />
          <div class="mm-sheet-head">
            <h3>筛选</h3>
            <button class="mm-sheet-close" type="button" @click="filterOpen = false">
              <AppIcon name="close" :size="16" />
            </button>
          </div>
          <div class="mm-sheet-body">
            <p class="mm-sheet-label">地区</p>
            <div class="mm-sheet-chips">
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
            <p class="mm-sheet-label">片源</p>
            <div class="mm-sheet-chips">
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
            <p v-if="typeNote" class="mm-sheet-note">{{ typeNote }}</p>
          </div>
          <button class="mm-sheet-done" type="button" data-nav @click="filterOpen = false">
            完成
          </button>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.movies-wrap {
  width: 100%;
  max-width: 1880px;
  margin: 0 auto;
}

/* ---------- 首页头部：品牌 + 站点胶囊 + 搜索圆钮 ---------- */
.mm-head {
  position: sticky;
  top: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px clamp(16px, 3vw, 48px) 12px;
  background: linear-gradient(180deg, rgba(7, 11, 9, 0.94) 0%, rgba(7, 11, 9, 0.72) 62%, transparent 100%);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
}

.mm-brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--text);
  text-decoration: none;
}

.mm-logo {
  flex: none;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 9px;
  color: #101013;
  background: linear-gradient(160deg, #ffffff, #d3d8d6);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.32);
}

.mm-wordmark {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.01em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mm-site {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  min-width: 0;
  max-width: 168px;
  padding: 0 11px;
  border-radius: 999px;
  border: 1px solid var(--glass-border);
  background: rgba(255, 255, 255, 0.07);
  color: #d4d4d8;
  font-size: 12.5px;
  font-weight: 600;
  text-decoration: none;
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
}

.mm-site-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mm-site-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--danger);
}

.mm-site-dot.online {
  background: var(--live);
  box-shadow: 0 0 8px rgba(52, 211, 153, 0.6);
}

.mm-head-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}

.mm-round {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 1px solid var(--glass-border);
  background: rgba(255, 255, 255, 0.08);
  color: #e5e7eb;
  text-decoration: none;
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  transition:
    background 0.16s ease,
    color 0.16s ease;
}

.mm-round:hover {
  background: rgba(255, 255, 255, 0.16);
  color: #fff;
}

.mm-body {
  padding: 4px clamp(16px, 3vw, 48px) 96px;
}

/* ---------- 继续观看 ---------- */
.mm-sec-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin: 10px 0 12px;
}

.mm-sec-head h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
  letter-spacing: 0;
}

.mm-sec-head span {
  font-size: 11.5px;
  color: var(--muted-2);
}

.mm-continue-row {
  display: flex;
  gap: 12px;
  overflow-x: auto;
  padding: 2px 2px 8px;
  margin: 0 -2px;
}

.mm-continue-card {
  flex: 0 0 clamp(208px, 30vw, 252px);
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 8px 10px;
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 18px;
  background: linear-gradient(180deg, rgba(38, 45, 42, 0.82), rgba(22, 27, 25, 0.86));
  color: var(--text);
  text-align: left;
  cursor: pointer;
  outline: none;
  transition:
    transform 0.18s ease,
    border-color 0.18s ease;
}

.mm-continue-card:hover {
  transform: translateY(-2px);
  border-color: rgba(255, 255, 255, 0.2);
}

.mm-continue-art {
  position: relative;
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 12px;
  overflow: hidden;
  background: #232b28;
}

.mm-continue-art img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.mm-continue-fallback {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  font-size: 26px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.35);
}

.mm-continue-play {
  position: absolute;
  inset: 0;
  margin: auto;
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: rgba(8, 12, 10, 0.55);
  border: 1px solid rgba(255, 255, 255, 0.28);
  color: #fff;
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}

.mm-continue-bar {
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: 7px;
  height: 3px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.28);
  overflow: hidden;
}

.mm-continue-bar span {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
}

.mm-continue-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 0 4px;
}

.mm-continue-meta strong {
  font-size: 13.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mm-continue-meta span {
  font-size: 11px;
  color: var(--muted-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- 精选卡 ---------- */
.mm-featured {
  position: relative;
  display: grid;
  grid-template-columns: 104px minmax(0, 1fr);
  gap: 16px;
  align-items: center;
  margin-top: 18px;
  padding: 14px;
  border-radius: 24px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background:
    radial-gradient(120% 140% at 100% 0%, rgba(52, 211, 153, 0.14), transparent 58%),
    linear-gradient(120deg, rgba(23, 38, 32, 0.92), rgba(11, 18, 15, 0.94));
  box-shadow:
    0 22px 54px rgba(0, 0, 0, 0.42),
    inset 0 1px 0 rgba(255, 255, 255, 0.16);
  overflow: hidden;
}

.mm-featured-glow {
  position: absolute;
  inset: 0 0 0 auto;
  width: 56%;
  height: 100%;
  object-fit: cover;
  opacity: 0.2;
  filter: blur(6px) saturate(1.1);
  -webkit-mask-image: linear-gradient(90deg, transparent 0%, #000 62%);
  mask-image: linear-gradient(90deg, transparent 0%, #000 62%);
  pointer-events: none;
}

.mm-featured-art,
.mm-featured-info {
  position: relative;
  z-index: 1;
}

.mm-featured-art {
  position: relative;
  aspect-ratio: 2 / 3;
  border-radius: 14px;
  overflow: hidden;
  background: #1e2623;
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.42);
}

.mm-featured-art img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.mm-featured-fallback {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  background:
    radial-gradient(90% 70% at 70% 8%, rgba(52, 211, 153, 0.18), transparent 60%),
    linear-gradient(165deg, #26312d 0%, #171d1b 60%, #101412 100%);
  font-size: 34px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.3);
}

.mm-featured-info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}

.mm-kicker {
  padding: 3px 9px;
  border-radius: 999px;
  background: rgba(52, 211, 153, 0.14);
  border: 1px solid rgba(52, 211, 153, 0.28);
  color: #6ee7b7;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.mm-featured-title {
  margin: 0;
  max-width: 100%;
  font-size: clamp(19px, 2.4vw, 26px);
  font-weight: 700;
  letter-spacing: 0;
  line-height: 1.16;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.mm-featured-meta {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}

.mm-featured-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.mm-play {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 16px;
  border: 0;
  border-radius: 999px;
  background: #f5f5f7;
  color: #101013;
  font-size: 12.5px;
  font-weight: 700;
  cursor: pointer;
  outline: none;
  box-shadow: 0 10px 22px rgba(0, 0, 0, 0.38);
  transition: background 0.16s ease;
}

.mm-play:hover {
  background: #ffffff;
}

.mm-glass-btn {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 1px solid var(--glass-border);
  background: rgba(255, 255, 255, 0.1);
  color: var(--text);
  cursor: pointer;
  outline: none;
}

.mm-glass-btn.on {
  background: rgba(255, 255, 255, 0.92);
  color: #101013;
  border-color: transparent;
}

/* ---------- 分类 / 地区 / 片源 ---------- */
.mm-filter {
  margin-top: 20px;
}

.mm-tabs {
  gap: 8px;
  padding: 2px 2px 10px;
}

.mm-pill {
  flex: 0 0 auto;
  height: 34px;
  padding: 0 15px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.06);
  color: #c7c7cf;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  outline: none;
  transition:
    background 0.16s ease,
    color 0.16s ease,
    border-color 0.16s ease;
}

.mm-pill:hover {
  background: rgba(255, 255, 255, 0.12);
  color: var(--text);
}

.mm-pill.on {
  background: #f5f5f7;
  border-color: transparent;
  color: #101013;
  font-weight: 700;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.32);
}

.mm-pill:focus-visible {
  outline: 2px solid #f5f5f7;
  outline-offset: 3px;
}

.mm-headline {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin: 8px 0 12px;
}

.mm-headline h2 {
  margin: 0;
  font-size: 19px;
  font-weight: 700;
  letter-spacing: 0;
}

.mm-headline span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  color: var(--muted-2);
}

.mm-regions {
  padding-bottom: 6px;
}

.mm-regions .chip {
  height: 30px;
  padding: 0 12px;
  font-size: 12px;
}

.mm-note {
  margin: 0 0 10px;
  padding: 10px 14px;
  border-radius: 14px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.04);
  color: var(--muted);
  font-size: 12px;
  line-height: 1.6;
}

.mm-source-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 2px;
}

.mm-source-label {
  flex: 0 0 auto;
  font-size: 11.5px;
  color: var(--muted-2);
  letter-spacing: 0.08em;
}

.chip-shell {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
}

.mm-source-chips {
  flex: 1;
  min-width: 0;
  gap: 7px;
  padding: 2px 2px 8px;
  overscroll-behavior-x: contain;
  -webkit-overflow-scrolling: touch;
}

.mm-source-chips .chip {
  height: 30px;
  padding: 0 12px;
  font-size: 12px;
}

.mm-arrow {
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
  background: rgba(14, 18, 16, 0.94);
  color: var(--text);
  cursor: pointer;
  box-shadow: 0 5px 14px rgba(0, 0, 0, 0.45);
}

.mm-arrow.left {
  left: -8px;
}

.mm-arrow.right {
  right: -8px;
}

/* ---------- 片单 ---------- */
.mm-feed {
  margin-top: 8px;
}

.state-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
  margin-top: 6px;
}

.poster-skeleton {
  aspect-ratio: 2 / 3;
  border-radius: 10px;
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

@media (min-width: 900px) {
  .mm-featured {
    grid-template-columns: 132px minmax(0, 1fr);
    gap: 22px;
    padding: 18px;
    max-width: 760px;
  }
  .mm-featured-title {
    font-size: 28px;
  }
  .mm-headline h2 {
    font-size: 21px;
  }
}

.tv-mode .mm-head {
  padding-top: 26px;
}

.tv-mode .mm-wordmark {
  font-size: 18px;
}

.tv-mode .mm-featured {
  grid-template-columns: 168px minmax(0, 1fr);
  max-width: 880px;
  padding: 22px;
}

.tv-mode .mm-featured-title {
  font-size: 34px;
}

.tv-mode .mm-pill {
  height: 44px;
  padding: 0 20px;
  font-size: 15px;
}

.tv-mode .mm-continue-card {
  flex-basis: 300px;
}

@media (max-width: 899px) {
  .mm-body {
    padding-bottom: calc(var(--tabbar-h) + env(safe-area-inset-bottom, 0px) + 18px);
  }
}

@media (max-width: 720px) {
  .mm-head {
    gap: 8px;
    padding: 14px 16px 10px;
  }
  .mm-wordmark {
    font-size: 14px;
    max-width: 96px;
  }
  .mm-site {
    max-width: 124px;
    height: 30px;
    padding: 0 9px;
    font-size: 11.5px;
  }
  .mm-head-actions {
    gap: 6px;
  }
  .mm-round {
    width: 32px;
    height: 32px;
  }
  .mm-body {
    padding: 0 14px calc(var(--tabbar-h) + env(safe-area-inset-bottom, 0px) + 16px);
  }
  .mm-featured {
    grid-template-columns: 86px minmax(0, 1fr);
    gap: 12px;
    padding: 11px;
    border-radius: 20px;
    margin-top: 14px;
  }
  .mm-featured-glow {
    display: none;
  }
  .mm-featured-title {
    font-size: 18px;
  }
  .mm-play {
    height: 34px;
    padding: 0 13px;
    font-size: 12px;
  }
  .mm-glass-btn {
    width: 34px;
    height: 34px;
  }
  .mm-continue-card {
    flex-basis: 208px;
  }
  .mm-headline h2 {
    font-size: 17px;
  }
  .mm-pill {
    height: 33px;
    padding: 0 14px;
    font-size: 12.5px;
  }
}

/* ================= MarcoMovie phone layout ================= */
.mm-tvhead {
  display: none;
}

.mm-head {
  gap: 8px;
  padding: 14px 16px 10px;
  background: linear-gradient(180deg, rgba(9, 18, 15, 0.94) 0%, rgba(9, 18, 15, 0.56) 64%, transparent 100%);
}

.mm-wordmark {
  font-size: 14px;
  font-weight: 800;
}

.mm-logo {
  width: 28px;
  height: 28px;
  border-radius: 9px;
}

.mm-site {
  height: 34px;
  padding: 0 12px;
  font-size: 12px;
}

.mm-head-actions {
  margin-left: auto;
}

.mm-round {
  width: 34px;
  height: 34px;
  border-color: rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.08);
}

.mm-site-name {
  font-weight: 600;
}

.mm-body {
  padding: 2px 16px calc(var(--tabbar-h) + env(safe-area-inset-bottom, 0px) + 8px);
}

.mm-sec-head {
  align-items: center;
  margin: 4px 0 10px;
}

.mm-sec-head h2 {
  font-size: 18px;
  font-weight: 700;
  color: #f5f5f7;
}

.mm-more {
  margin-left: auto;
  padding: 4px 2px;
  color: var(--accent);
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
}

.mm-history-row {
  display: flex;
  gap: 10px;
  margin: 0 -16px;
  padding: 0 16px 6px;
  overflow-x: auto;
}

.mm-history-card {
  flex: 0 0 212px;
  height: 84px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 18px;
  background: linear-gradient(180deg, rgba(24, 34, 30, 0.86), rgba(13, 20, 17, 0.92));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12);
  color: var(--text);
  text-align: left;
  cursor: pointer;
  outline: none;
}

.mm-history-art {
  flex: none;
  display: grid;
  place-items: center;
  width: 46px;
  height: 64px;
  border-radius: 10px;
  overflow: hidden;
  background: #1c2823;
}

.mm-history-art img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.mm-history-fallback {
  font-size: 18px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.32);
}

.mm-history-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  height: 100%;
  padding: 2px 0;
}

.mm-history-info strong {
  font-size: 13.5px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mm-history-info > span:not(.mm-history-bar) {
  font-size: 11px;
  color: #8e959e;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mm-history-bar {
  margin-top: auto;
  height: 3px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.22);
  overflow: hidden;
}

.mm-history-bar > span {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: #6ee7b7;
}

.mm-hero {
  height: 198px;
  display: flex;
  gap: 16px;
  margin-top: 16px;
  padding: 14px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 24px;
  background: linear-gradient(180deg, rgba(20, 28, 25, 0.95), rgba(13, 19, 17, 0.97));
  box-shadow:
    0 18px 42px rgba(0, 0, 0, 0.4),
    inset 0 1px 0 rgba(255, 255, 255, 0.14);
}

.mm-hero-poster {
  flex: none;
  width: 110px;
  height: 166px;
  padding: 0;
  border: 0;
  border-radius: 14px;
  overflow: hidden;
  background: #1b2622;
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.42);
  cursor: pointer;
  outline: none;
}

.mm-hero-poster img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.mm-hero-fallback {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  background:
    radial-gradient(90% 70% at 70% 8%, rgba(52, 211, 153, 0.16), transparent 60%),
    linear-gradient(165deg, #26312d 0%, #171d1b 60%, #101412 100%);
  font-size: 32px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.3);
}

.mm-hero-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}

.mm-hero-kicker {
  align-self: flex-start;
  max-width: 100%;
  padding: 4px 10px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  font-size: 10.5px;
  font-weight: 700;
  color: #6ee7b7;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mm-hero-title {
  margin: 6px 0 0;
  font-size: 20px;
  font-weight: 800;
  line-height: 1.2;
  color: #f5f5f7;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.mm-hero-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 8px;
  max-height: 22px;
  overflow: hidden;
}

.mm-hero-chips span {
  padding: 3px 7px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.09);
  color: #d4d8d6;
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
}

.mm-hero-chips .mm-hero-score {
  color: #ffd479;
}

.mm-hero-play {
  align-self: flex-end;
  margin-top: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 15px;
  border: 0;
  border-radius: 999px;
  background: #f5f5f7;
  color: #0b0f0d;
  font-size: 12.5px;
  font-weight: 800;
  cursor: pointer;
  outline: none;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.36);
}

.mm-catrow {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
}

.mm-catrow .mm-tabs {
  flex: 1;
  min-width: 0;
  gap: 8px;
  padding: 2px 2px 8px;
}

.mm-filter-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.07);
  color: #e5e7eb;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  outline: none;
}

.mm-pill {
  height: 32px;
  padding: 0 14px;
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(255, 255, 255, 0.1);
  color: #c7c7cf;
  font-size: 13px;
}

.mm-pill.on {
  background: #f5f5f7;
  color: #101013;
}

.mm-feed {
  margin-top: 8px;
}

.movies-wrap .poster-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

@media (min-width: 520px) {
  .movies-wrap .poster-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

@media (min-width: 720px) {
  .movies-wrap .poster-grid {
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }
}

@media (min-width: 1100px) {
  .movies-wrap .poster-grid {
    grid-template-columns: repeat(6, minmax(0, 1fr));
  }
}

@media (min-width: 1500px) {
  .movies-wrap .poster-grid {
    grid-template-columns: repeat(7, minmax(0, 1fr));
  }
}

/* 筛选面板 */
.mm-sheet-mask {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  background: rgba(2, 6, 5, 0.58);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}

.mm-sheet {
  position: relative;
  width: 100%;
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  padding: 8px 18px calc(18px + env(safe-area-inset-bottom, 0px));
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-bottom: 0;
  border-radius: 28px 28px 0 0;
  background: linear-gradient(180deg, #16201d 0%, #0b120f 100%);
  box-shadow: 0 -22px 60px rgba(0, 0, 0, 0.6);
}

.mm-sheet-grab {
  align-self: center;
  width: 38px;
  height: 4px;
  margin: 2px 0 8px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.22);
}

.mm-sheet-head {
  display: flex;
  align-items: center;
  padding: 2px 0 10px;
}

.mm-sheet-head h3 {
  margin: 0;
  font-size: 19px;
  font-weight: 700;
}

.mm-sheet-close {
  margin-left: auto;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.08);
  color: #e5e7eb;
  cursor: pointer;
}

.mm-sheet-body {
  overflow-y: auto;
  padding-bottom: 6px;
}

.mm-sheet-label {
  margin: 10px 0 8px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: #8e959e;
}

.mm-sheet-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}

.mm-sheet-chips .chip {
  height: 31px;
  padding: 0 13px;
  font-size: 12.5px;
}

.mm-sheet-note {
  margin: 14px 0 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: #8e959e;
}

.mm-sheet-done {
  flex: none;
  height: 46px;
  margin-top: 14px;
  border: 0;
  border-radius: 999px;
  background: #f5f5f7;
  color: #101013;
  font-size: 14.5px;
  font-weight: 800;
  cursor: pointer;
}

.sheet-enter-active,
.sheet-leave-active {
  transition: opacity 0.18s ease;
}

.sheet-enter-active .mm-sheet,
.sheet-leave-active .mm-sheet {
  transition: transform 0.2s ease;
}

.sheet-enter-from,
.sheet-leave-to {
  opacity: 0;
}

.sheet-enter-from .mm-sheet,
.sheet-leave-to .mm-sheet {
  transform: translateY(28px);
}

/* TV：发现标题 + 右侧片源胶囊、平铺历史卡、五列海报 */
.tv-mode .mm-head {
  display: none;
}

.tv-mode .mm-tvhead {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 6px 0 16px;
}

.tv-mode .mm-tvhead h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 0;
}

.tv-mode .mm-tvlogo {
  flex: none;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 11px;
  color: #101013;
  background: linear-gradient(160deg, #ffffff, #d3d8d6);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.32);
}

.tv-mode .mm-tvhead .mm-site {
  height: 34px;
  margin-left: auto;
  background: rgba(255, 255, 255, 0.06);
  font-size: 12.5px;
}

.tv-mode .mm-body {
  padding: 22px 120px 90px 34px;
}

.tv-mode .mm-sec-head h2 {
  font-size: 17px;
  font-weight: 600;
}

.tv-mode .mm-history-card {
  flex: 0 0 244px;
  height: 72px;
  padding: 6px 10px;
  border-radius: 14px;
  border-color: transparent;
  background: #222228;
  box-shadow: none;
}

.tv-mode .mm-history-art {
  width: 40px;
  height: 60px;
  border-radius: 8px;
}

.tv-mode .mm-history-row {
  margin: 0;
  padding: 0 0 6px;
  gap: 12px;
}

.tv-mode .mm-hero {
  position: relative;
  height: 236px;
  margin-top: 18px;
  padding: 18px;
  gap: 20px;
  overflow: hidden;
  border-color: rgba(255, 255, 255, 0.16);
  border-radius: 22px;
  background: linear-gradient(180deg, rgba(20, 26, 24, 0.9), rgba(11, 15, 14, 0.96));
}

.tv-mode .mm-hero::before {
  content: '';
  position: absolute;
  inset: -34px;
  background-image: var(--hero-art);
  background-size: cover;
  background-position: center 32%;
  filter: blur(30px) saturate(1.25);
  opacity: 0.5;
  pointer-events: none;
}

.tv-mode .mm-hero::after {
  content: '';
  position: absolute;
  inset: 0;
  background:
    linear-gradient(90deg, rgba(8, 12, 11, 0.16) 0%, rgba(8, 12, 11, 0.52) 54%, rgba(8, 12, 11, 0.92) 100%),
    linear-gradient(180deg, rgba(8, 12, 11, 0.08), rgba(8, 12, 11, 0.42));
  pointer-events: none;
}

.tv-mode .mm-hero > * {
  position: relative;
  z-index: 1;
}

.tv-mode .mm-hero-poster {
  width: 148px;
  height: 200px;
  border-radius: 14px;
}

.tv-mode .mm-hero-info {
  justify-content: center;
}

.tv-mode .mm-hero-kicker {
  padding: 6px 13px;
  font-size: 12px;
  color: #9fe8c8;
}

.tv-mode .mm-hero-title {
  margin-top: 8px;
  font-size: 30px;
  -webkit-line-clamp: 1;
}

.tv-mode .mm-hero-chips {
  margin-top: 10px;
  max-height: none;
  gap: 6px;
}

.tv-mode .mm-hero-chips span {
  padding: 5px 10px;
  font-size: 12px;
}

.tv-mode .mm-hero-play {
  align-self: flex-end;
  height: 44px;
  padding: 0 22px;
  font-size: 14px;
}

.tv-mode .mm-catrow {
  margin-top: 8px;
}

.tv-mode .mm-pill {
  height: 40px;
  padding: 0 18px;
  font-size: 14.5px;
}

.tv-mode .mm-filter-btn {
  height: 40px;
  font-size: 14px;
}

.tv-mode .movies-wrap .poster-grid {
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 14px;
}

@media (min-width: 1600px) {
  .tv-mode .movies-wrap .poster-grid {
    grid-template-columns: repeat(6, minmax(0, 1fr));
  }
}

.tv-mode .mm-sheet {
  max-width: 620px;
  margin: auto;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 26px;
}

.tv-mode .mm-sheet-mask {
  align-items: center;
}
</style>

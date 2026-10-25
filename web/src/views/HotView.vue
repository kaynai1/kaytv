<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { contentTypeName } from '@kaytv/shared'
import { api } from '../api/client'
import { mediaUrl } from '../api/runtime'
import { tmdbArts, tmdbEnsure, tmdbKey, tmdbPosterUrl, tmdbSwapImageHost } from '../api/tmdb'
import { useSettingsStore } from '../stores/settings'
import { useLibraryStore } from '../stores/library'
import type { VodItem } from '../types'
import AppIcon from '../components/AppIcon.vue'
import EmptyState from '../components/EmptyState.vue'
import DetailModal from '../components/DetailModal.vue'

const settings = useSettingsStore()
const library = useLibraryStore()

const TABS = [
  { id: '', name: '综合榜' },
  { id: 'movie', name: '电影' },
  { id: 'tv', name: '电视剧' },
  { id: 'short', name: '短剧' },
  { id: 'anime', name: '动漫' },
  { id: 'variety', name: '综艺' },
  { id: 'documentary', name: '纪录片' }
]

const tab = ref('')
const pool = ref<Record<string, VodItem[]>>({})
const loading = ref(false)
const error = ref('')
const failedSources = ref(0)
const updatedAt = ref(0)
const mounted = ref(false)
const modalTarget = ref<{ sourceId: string; id: string } | null>(null)

const TYPE_PRIORITY = ['movie', 'tv', 'anime', 'variety', 'short', 'documentary', 'sports']

const list = computed<VodItem[]>(() => {
  if (!tab.value) return balancedRank(Object.values(pool.value).flat())
  return rank(dedupe((pool.value[tab.value] || []).filter((item) => item.contentType === tab.value)))
})

const top = computed(() => list.value.slice(0, 40))
const top10 = computed(() => top.value.slice(0, 10))
const rest = computed(() => top.value.slice(10))

const tmdbOff = ref<Record<string, boolean>>({})
function artSrc(item: VodItem): string {
  const key = tmdbKey(item.name, item.year)
  if (!tmdbOff.value[key]) {
    const url = tmdbPosterUrl(tmdbArts[key], 'w500')
    if (url) return url
  }
  return mediaUrl(item.pic)
}
function artError(item: VodItem) {
  const key = tmdbKey(item.name, item.year)
  const url = tmdbPosterUrl(tmdbArts[key], 'w500')
  if (tmdbOff.value[key] || !url) return
  if (tmdbSwapImageHost(url)) return
  tmdbOff.value = { ...tmdbOff.value, [key]: true }
}
watch(
  top,
  (items) => {
    for (const item of items) tmdbEnsure(item.name, item.year, item.contentType || '')
  },
  { immediate: true }
)
const boardName = computed(() => TABS.find((item) => item.id === tab.value)?.name || '综合榜')

function scoreOf(item: VodItem): number {
  const value = Number(item.score)
  return Number.isFinite(value) ? value : 0
}

function rank(items: VodItem[]): VodItem[] {
  return [...items].sort((a, b) => {
    const diff = scoreOf(b) - scoreOf(a)
    if (diff) return diff
    return (b.time || 0) - (a.time || 0)
  })
}

/** 同一部片在多个片源重复出现时，只保留评分最高、更新时间最新的那条 */
function dedupe(items: VodItem[]): VodItem[] {
  const picked = new Map<string, VodItem>()
  for (const item of items) {
    const key = `${item.name.trim().toLowerCase()}|${item.year || ''}`
    const current = picked.get(key)
    if (!current) {
      picked.set(key, item)
      continue
    }
    const diff = scoreOf(item) - scoreOf(current)
    if (diff > 0 || (diff === 0 && (item.time || 0) > (current.time || 0))) {
      picked.set(key, item)
    }
  }
  return [...picked.values()]
}

/**
 * 综合榜：先按评分分档，档内按分类轮流取样。
 * 片源普遍给 10 分时，短剧源更新最勤，单纯按时间会整屏短剧，所以同分时强制轮播分类。
 */
function balancedRank(items: VodItem[]): VodItem[] {
  const ranked = rank(dedupe(items))
  const out: VodItem[] = []
  let band: VodItem[] = []
  let bandScore: number | null = null

  const flush = () => {
    if (!band.length) return
    const buckets = new Map<string, VodItem[]>()
    for (const item of band) {
      const key = item.contentType && TYPE_PRIORITY.includes(item.contentType) ? item.contentType : 'other'
      const bucket = buckets.get(key)
      if (bucket) bucket.push(item)
      else buckets.set(key, [item])
    }
    const keys = TYPE_PRIORITY.filter((key) => buckets.has(key))
    for (let cursor = 0, added = true; added; cursor += 1) {
      added = false
      for (const key of keys) {
        const bucket = buckets.get(key)!
        if (bucket.length > cursor) {
          out.push(bucket[cursor])
          added = true
        }
      }
    }
    if (buckets.has('other')) out.push(...buckets.get('other')!)
    band = []
  }

  for (const item of ranked) {
    const score = scoreOf(item)
    if (bandScore !== null && Math.abs(score - bandScore) > 0.01) flush()
    bandScore = score
    band.push(item)
  }
  flush()
  return out
}

function typeLabel(item: VodItem): string {
  return contentTypeName(item.contentType || '') || item.typeName || ''
}

async function load() {
  if (!settings.online || settings.needsLogin) return
  loading.value = true
  error.value = ''
  try {
    const types = ['movie', 'tv', 'short', 'anime', 'variety', 'documentary']
    const results = await Promise.allSettled(
      types.map((type) => api.feed(type, 'all', '', 1))
    )
    const next: Record<string, VodItem[]> = {}
    let errors = 0
    results.forEach((result, index) => {
      const type = types[index]
      if (result.status === 'fulfilled') {
        next[type] = result.value.items
        errors += result.value.errors?.length || 0
      } else {
        next[type] = []
      }
    })
    pool.value = next
    failedSources.value = errors
    updatedAt.value = Date.now()
    if (!Object.values(next).some((items) => items.length)) {
      error.value = '所有片源都没有返回榜单数据，请稍后重试或更换片源。'
    }
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '加载榜单失败'
  } finally {
    loading.value = false
  }
}

function open(item: VodItem) {
  modalTarget.value = { sourceId: item.sourceId, id: item.id }
}

function watched(item: VodItem): boolean {
  const entry = library.progressOf(item.sourceId, item.id)
  return !!entry && entry.position > 30
}

const updatedText = computed(() => {
  if (!updatedAt.value) return ''
  return new Date(updatedAt.value).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  })
})

onMounted(async () => {
  await settings.init()
  mounted.value = true
  load()
})

watch(tab, () => {
  if (mounted.value) window.scrollTo({ top: 0 })
})
</script>

<template>
  <div class="page hot-page">
    <div class="page-head">
      <div>
        <h1 class="page-title">最新热门</h1>
        <p class="page-desc">
          聚合电影 / 电视剧 / 动漫 / 综艺 / 短剧五个分类，综合榜按分类轮流上榜，同一部片只保留一条
          <template v-if="updatedText"> · {{ updatedText }} 刷新</template>
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" data-nav :disabled="loading" type="button" @click="load">
          <AppIcon name="refresh" :size="16" />
          重新统计
        </button>
        <RouterLink class="btn" to="/search" data-nav>
          <AppIcon name="search" :size="16" />
          搜索片名
        </RouterLink>
      </div>
    </div>

    <div class="chip-row hide-scrollbar hot-tabs">
      <button
        v-for="item in TABS"
        :key="item.id"
        class="chip"
        :class="{ active: tab === item.id }"
        data-nav
        type="button"
        @click="tab = item.id"
      >
        {{ item.name }}
      </button>
    </div>

    <div v-if="loading" class="top10-skeletons">
      <div v-for="index in 10" :key="index" class="skeleton top10-skeleton" />
    </div>

    <EmptyState v-else-if="error" title="榜单加载失败" :message="error" icon="warn">
      <button class="btn" data-nav type="button" @click="load">重试</button>
    </EmptyState>

    <EmptyState
      v-else-if="!top.length"
      title="暂时没有榜单数据"
      message="热门榜依赖片源返回的分类数据；未连接服务端或片源全部离线时无法统计。"
      icon="flame"
    >
      <RouterLink class="btn red" to="/settings" data-nav>检查片源与连接</RouterLink>
    </EmptyState>

    <template v-else>
      <section class="top10-block">
        <h2 class="section-title top10-title">
          <span class="top-label">TOP 10</span>
          {{ boardName }}
          <span class="hint">同分按分类轮播</span>
        </h2>
        <div class="top10-rail hide-scrollbar">
          <button
            v-for="(item, index) in top10"
            :key="`${item.sourceId}:${item.id}`"
            class="top10-item"
            data-nav
            type="button"
            :aria-label="`第 ${index + 1} 名 ${item.name}`"
            @click="open(item)"
          >
            <span class="top10-rank" :class="{ wide: index === 9 }">
              {{ index + 1 }}
            </span>
            <span class="top10-art">
              <img
                v-if="artSrc(item)"
                :src="artSrc(item)"
                :alt="item.name"
                loading="lazy"
                decoding="async"
                referrerpolicy="no-referrer"
                @error="artError(item)"
              />
              <span v-else class="top10-fallback">{{ item.name.slice(0, 1) }}</span>
              <span class="top10-play">
                <span class="top10-play-dot"><AppIcon name="play" :size="20" /></span>
              </span>
            </span>
          </button>
        </div>
      </section>

      <section v-if="rest.length" class="section-block rest-block">
        <h2 class="section-title">
          完整榜单
          <span class="hint">11 – {{ top.length }}</span>
        </h2>
        <div class="rest-grid">
          <button
            v-for="(item, index) in rest"
            :key="`${item.sourceId}:${item.id}`"
            class="rest-row"
            data-nav
            type="button"
            @click="open(item)"
          >
            <span class="rest-rank">{{ index + 11 }}</span>
            <span class="rest-art">
              <img
                v-if="artSrc(item)"
                :src="artSrc(item)"
                :alt="item.name"
                loading="lazy"
                decoding="async"
                referrerpolicy="no-referrer"
                @error="artError(item)"
              />
              <span v-else class="rest-fallback">{{ item.name.slice(0, 1) }}</span>
            </span>
            <span class="rest-info">
              <span class="rest-name">
                {{ item.name }}
                <span v-if="item.remarks" class="rest-remarks">{{ item.remarks }}</span>
              </span>
              <span class="rest-meta">
                <span v-if="typeLabel(item)" class="rest-type">{{ typeLabel(item) }}</span>
                <span v-if="item.year">{{ item.year }}</span>
                <span>{{ item.sourceName }}</span>
                <span v-if="watched(item)" class="seen">看过</span>
              </span>
            </span>
            <span class="rest-score">{{ item.score || '—' }}</span>
          </button>
        </div>
      </section>

      <p class="hot-foot">
        榜单来自片源自报的评分与更新时间，KayTV 不做热度加权；综合榜在评分同档内按分类轮播，避免单一类型霸榜。{{ failedSources }} 个源本次未返回数据。
      </p>
    </template>

    <DetailModal
      v-if="modalTarget"
      :source-id="modalTarget.sourceId"
      :vod-id="modalTarget.id"
      @close="modalTarget = null"
    />
  </div>
</template>

<style scoped>
.hot-page {
  padding-bottom: 48px;
}

.hot-tabs {
  margin: 4px 0 20px;
}

/* ---------- Top 10 rail ---------- */
.top10-block {
  margin: 0 0 34px;
}

.top10-title {
  margin-bottom: 14px;
}

.top-label {
  color: var(--accent);
  font-size: 12px;
  font-weight: 900;
  letter-spacing: 0.14em;
}

.top10-rail {
  display: flex;
  align-items: flex-end;
  gap: clamp(6px, 0.9vw, 14px);
  overflow-x: auto;
  padding: 8px 4px 18px;
  scroll-snap-type: x proximity;
  scrollbar-width: none;
}
.top10-rail::-webkit-scrollbar {
  display: none;
}

.top10-item {
  position: relative;
  flex: 0 0 auto;
  display: flex;
  align-items: flex-end;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  outline: none;
  scroll-snap-align: start;
}

.top10-rank {
  flex: 0 0 auto;
  width: clamp(44px, 4.2vw, 68px);
  margin-right: -10px;
  font-size: clamp(84px, 8.8vw, 142px);
  font-weight: 900;
  line-height: 0.76;
  text-align: center;
  color: #111;
  -webkit-text-stroke: 3px #4a4a4a;
  paint-order: stroke fill;
  font-variant-numeric: lining-nums tabular-nums;
  z-index: 1;
  transition: color 0.2s ease, -webkit-text-stroke-color 0.2s ease;
}

.top10-rank.wide {
  width: clamp(70px, 6.6vw, 108px);
  font-size: clamp(74px, 7.6vw, 122px);
}

.top10-item:hover .top10-rank,
.top10-item:focus .top10-rank {
  color: #1c1c1c;
  -webkit-text-stroke-color: #e5e5e5;
}

.top10-art {
  position: relative;
  display: block;
  width: clamp(120px, 10.6vw, 168px);
  aspect-ratio: 2 / 3;
  border-radius: 4px;
  overflow: hidden;
  background: var(--surface-2);
  z-index: 2;
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}

.top10-art img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.top10-fallback {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  font-size: 26px;
  font-weight: 800;
  color: rgba(255, 255, 255, 0.28);
}

.top10-play {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0) 35%, rgba(0, 0, 0, 0.72));
  opacity: 0;
  transition: opacity 0.18s ease;
}

.top10-play-dot {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.94);
  color: #000;
}

.top10-item:hover .top10-play,
.top10-item:focus .top10-play {
  opacity: 1;
}

@media (hover: hover) {
  .top10-item:hover .top10-art {
    transform: scale(1.045);
    box-shadow: 0 16px 38px rgba(0, 0, 0, 0.72);
  }
}

.top10-item:focus .top10-art {
  box-shadow: 0 0 0 3px var(--accent), 0 16px 38px rgba(0, 0, 0, 0.72);
}

.top10-skeletons {
  display: flex;
  gap: 14px;
  overflow: hidden;
  padding-bottom: 10px;
}

.top10-skeleton {
  flex: 0 0 auto;
  width: clamp(120px, 10.6vw, 168px);
  aspect-ratio: 2 / 3;
  border-radius: 4px;
}

/* ---------- 11-40 list ---------- */
.rest-block {
  margin-top: 6px;
}

.rest-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(330px, 1fr));
  gap: 2px clamp(16px, 2.2vw, 40px);
}

.rest-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 9px 10px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
  outline: none;
  transition: background 0.16s ease, border-color 0.16s ease;
}

.rest-row:hover {
  background: var(--surface);
  border-color: var(--line);
}

.rest-row:focus {
  background: var(--surface);
  border-color: transparent;
  outline: 3px solid var(--accent);
  outline-offset: 1px;
}

.rest-rank {
  flex: 0 0 auto;
  width: 26px;
  text-align: center;
  font-size: 15px;
  font-weight: 800;
  color: var(--muted-2);
  font-variant-numeric: lining-nums tabular-nums;
}

.rest-art {
  position: relative;
  flex: 0 0 auto;
  width: 44px;
  aspect-ratio: 2 / 3;
  border-radius: 4px;
  overflow: hidden;
  background: var(--surface-2);
}

.rest-art img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.rest-fallback {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  font-size: 16px;
  font-weight: 800;
  color: rgba(255, 255, 255, 0.28);
}

.rest-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.rest-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13.5px;
  font-weight: 600;
  color: #dedede;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rest-remarks {
  padding: 1px 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--muted);
  font-size: 10.5px;
  font-weight: 500;
  white-space: nowrap;
}

.rest-meta {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
  font-size: 11.5px;
  color: var(--muted-2);
}

.rest-meta .seen {
  color: var(--live);
  font-weight: 700;
}

.rest-type {
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-weight: 600;
}

.rest-score {
  flex: 0 0 auto;
  min-width: 40px;
  text-align: right;
  font-size: 14px;
  font-weight: 800;
  color: #46d369;
  font-variant-numeric: lining-nums tabular-nums;
}

.hot-foot {
  margin: 26px 0 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--muted-2);
}

@media (max-width: 720px) {
  .hot-tabs {
    margin-bottom: 16px;
  }
  .top10-rail {
    gap: 2px;
    padding: 6px 2px 14px;
  }
  .top10-rank {
    width: 30px;
    margin-right: -6px;
    font-size: 62px;
    -webkit-text-stroke-width: 2px;
  }
  .top10-rank.wide {
    width: 52px;
    font-size: 54px;
  }
  .top10-art {
    width: clamp(96px, 27vw, 118px);
  }
  .top10-play-dot {
    width: 38px;
    height: 38px;
  }
  .top10-skeleton {
    width: clamp(96px, 27vw, 118px);
  }
  .rest-grid {
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
  }
  .rest-row {
    gap: 10px;
    padding: 8px 6px;
  }
  .rest-name {
    font-size: 13px;
  }
  .rest-score {
    min-width: 30px;
    font-size: 13px;
  }
}
</style>

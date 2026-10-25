<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { api } from '../api/client'
import { runtime } from '../api/runtime'
import type { PosterItem } from '../types'
import { useLibraryStore } from '../stores/library'
import { usePlayerStore } from '../stores/player'
import { useSettingsStore } from '../stores/settings'
import AppIcon from './AppIcon.vue'
import PosterCard from './PosterCard.vue'

const emit = defineEmits<{
  (e: 'line', index: number): void
  (e: 'episode', index: number): void
  (e: 'related', item: PosterItem): void
  (e: 'cast'): void
  (e: 'copy'): void
  (e: 'fullscreen'): void
}>()

const player = usePlayerStore()
const library = useLibraryStore()
const settings = useSettingsStore()

const expanded = ref(false)
const related = ref<PosterItem[]>([])
const relatedLoading = ref(false)

const detail = computed(() => player.vod?.detail || null)
const lines = computed(() => detail.value?.lines || [])
const episodes = computed(() => player.currentLine?.episodes || [])
const canCast = computed(() => (runtime.native && !settings.tvMode) || !runtime.native)

/** 线路按官方优先排，和参考图里「专属线路」排第一的效果一致 */
const sortedLines = computed(() =>
  lines.value
    .map((item, index) => ({ item, index }))
    .sort((a, b) => Number(Boolean(b.item.official)) - Number(Boolean(a.item.official)))
)

const metaChips = computed(() => {
  const value = detail.value
  if (!value) return []
  return [
    value.year ? `${value.year} 年` : '',
    value.area,
    value.typeName,
    value.score && value.score !== '' ? `评分 ${value.score}` : ''
  ].filter(Boolean)
})

const synopsis = computed(() => {
  const raw = String(detail.value?.content || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return raw
})

const castText = computed(() => {
  const value = detail.value
  if (!value) return ''
  const actors = String(value.actors || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return actors ? `主演：${actors}` : ''
})

const favorite = computed(() => {
  const value = detail.value
  return value ? library.isFavorite(value.sourceId, value.id) : false
})

function toggleFavorite() {
  const value = detail.value
  if (!value) return
  library.toggleFavorite({ ...value })
}

function lineLabel(name: string, index: number): string {
  return /[\u4e00-\u9fa5]/.test(name) ? name : `线路 ${index + 1}`
}

async function loadRelated() {
  const value = detail.value
  if (!value) {
    related.value = []
    return
  }
  relatedLoading.value = true
  try {
    const feed = await api.feed(value.contentType || '', 'all', '', 1)
    related.value = feed.items
      .filter((item) => item.id !== value.id && item.name !== value.name)
      .slice(0, 12)
  } catch {
    related.value = []
  } finally {
    relatedLoading.value = false
  }
}

watch(
  () => `${detail.value?.sourceId || ''}:${detail.value?.id || ''}`,
  (key) => {
    expanded.value = false
    related.value = []
    if (key) void loadRelated()
  },
  { immediate: true }
)
</script>

<template>
  <div v-if="detail" class="vod-info">
    <div class="info-head">
      <div class="info-title">
        <span class="badge accent">第 {{ (player.vod?.episodeIndex || 0) + 1 }} 集</span>
        <h3>{{ detail.name }}</h3>
      </div>
      <button class="info-more" type="button" @click="expanded = !expanded">
        {{ expanded ? '收起' : '简介' }}
        <AppIcon :name="expanded ? 'up' : 'down'" :size="14" />
      </button>
    </div>

    <div class="info-chips">
      <span v-for="chip in metaChips" :key="chip" class="info-chip">{{ chip }}</span>
      <span class="info-chip source">{{ detail.sourceName }}</span>
    </div>

    <p v-if="expanded && synopsis" class="info-synopsis">{{ synopsis }}</p>
    <p v-if="expanded && castText" class="info-cast">{{ castText }}</p>

    <div class="info-actions">
      <button class="info-action" :class="{ on: favorite }" type="button" data-nav @click="toggleFavorite">
        <AppIcon name="heart" :size="20" />
        <span>{{ favorite ? '已收藏' : '收藏' }}</span>
      </button>
      <button class="info-action" type="button" data-nav @click="emit('fullscreen')">
        <AppIcon name="fullscreen" :size="20" />
        <span>全屏</span>
      </button>
      <button v-if="canCast" class="info-action" type="button" data-nav @click="emit('cast')">
        <AppIcon name="cast" :size="20" />
        <span>投屏</span>
      </button>
      <button class="info-action" type="button" data-nav @click="emit('copy')">
        <AppIcon name="link" :size="20" />
        <span>复制地址</span>
      </button>
    </div>

    <section v-if="sortedLines.length > 1" class="info-block">
      <h4 class="info-block-head">
        线路
        <span class="info-block-hint">{{ sortedLines.length }} 条 · 卡了就换一条</span>
      </h4>
      <div class="info-lines hide-scrollbar">
        <button
          v-for="entry in sortedLines"
          :key="`${entry.item.name}-${entry.index}`"
          class="chip"
          :class="{ active: entry.index === player.vod?.lineIndex, official: entry.item.official }"
          type="button"
          data-nav
          @click="emit('line', entry.index)"
        >
          {{ lineLabel(entry.item.name, entry.index) }}
          <span class="count">{{ entry.item.episodes.length }} 集</span>
        </button>
      </div>
    </section>

    <section v-if="episodes.length" class="info-block">
      <h4 class="info-block-head">
        选集
        <span class="info-block-hint">{{ episodes.length }} 集全</span>
      </h4>
      <div class="info-episodes">
        <button
          v-for="(item, index) in episodes"
          :key="`${index}-${item.url}`"
          class="episode-cell"
          :class="{ current: index === player.vod?.episodeIndex }"
          type="button"
          data-nav
          @click="emit('episode', index)"
        >
          {{ index + 1 }}
        </button>
      </div>
    </section>

    <section v-if="related.length || relatedLoading" class="info-block">
      <h4 class="info-block-head">猜你喜欢<span class="info-block-hint">同分类在播</span></h4>
      <div class="info-related hide-scrollbar">
        <PosterCard
          v-for="item in related"
          :key="`${item.sourceId}:${item.id}`"
          :item="item"
          :show-source="false"
          compact
          @select="emit('related', item)"
        />
        <p v-if="relatedLoading && !related.length" class="info-loading">正在加载推荐…</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.vod-info {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-top: 12px;
}

.info-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.info-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.info-title h3 {
  margin: 0;
  font-size: 17px;
  font-weight: 800;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.info-more {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 4px 2px;
  border: 0;
  background: none;
  color: var(--muted);
  font-size: 12.5px;
  cursor: pointer;
}

.info-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.info-chip {
  padding: 3px 9px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  font-size: 11.5px;
  color: var(--muted);
}

.info-chip.source {
  border-color: rgba(229, 9, 20, 0.4);
  background: var(--accent-soft);
  color: #ff9b9e;
}

.info-synopsis,
.info-cast {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.75;
  color: var(--muted);
}

.info-cast {
  color: var(--muted-2);
}

.info-actions {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
  padding: 12px 0;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}

.info-action {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 4px 0;
  border: 0;
  background: none;
  color: var(--muted);
  font-size: 11.5px;
  cursor: pointer;
}

.info-action.on {
  color: var(--accent-strong);
}

.info-action:active {
  color: var(--text);
}

.info-block-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0 0 10px;
  font-size: 14px;
  font-weight: 700;
}

.info-block-hint {
  font-size: 11.5px;
  font-weight: 400;
  color: var(--muted-2);
}

.info-lines {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 2px;
}

.info-lines .chip {
  flex: 0 0 auto;
}

.info-episodes {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(48px, 1fr));
  gap: 8px;
}

.episode-cell {
  height: 38px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--muted);
  font-size: 13px;
  cursor: pointer;
}

.episode-cell.current {
  border-color: transparent;
  background: var(--text);
  color: #000;
  font-weight: 800;
}

.info-related {
  display: flex;
  gap: 10px;
  overflow-x: auto;
  padding-bottom: 4px;
}

.info-related :deep(.poster-card) {
  flex: 0 0 100px;
  width: 100px;
}

.info-loading {
  margin: 0;
  font-size: 12px;
  color: var(--muted-2);
}
</style>

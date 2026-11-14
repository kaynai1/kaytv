<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { PosterItem } from '../types'
import { mediaUrl } from '../api/runtime'
import { tmdbArts, tmdbEnsure, tmdbKey, tmdbPosterUrl, tmdbSwapImageHost } from '../api/tmdb'
import AppIcon from './AppIcon.vue'

const props = withDefaults(
  defineProps<{
    item: PosterItem & { area?: string; score?: string }
    progress?: number
    showSource?: boolean
    compact?: boolean
    /** 首推位：标题下展示评分、年份、类型、地区四类信息 */
    info?: boolean
  }>(),
  { progress: 0, showSource: false, compact: false, info: false }
)

defineEmits<{ select: [item: PosterItem] }>()

const failed = ref(false)
const tmdbFailed = ref(false)
const initial = computed(() => props.item.name.trim().slice(0, 1) || '影')
const scoreText = computed(() => {
  const value = Number.parseFloat(String(props.item.score || ''))
  return Number.isFinite(value) && value > 0 ? String(props.item.score).trim() : ''
})
// 采集源的地区字段常带前导冒号，如 ": 中国大陆"
const areaText = computed(() => String(props.item.area || '').replace(/^[\s:：·,，.-]+/, '').trim())
const key = computed(() => tmdbKey(props.item.name, props.item.year))
const tmdbSrc = computed(() => (tmdbFailed.value ? '' : tmdbPosterUrl(tmdbArts[key.value], 'w500')))
const src = computed(() => tmdbSrc.value || mediaUrl(props.item.pic))

const cardEl = ref<HTMLElement | null>(null)
let artObserver: IntersectionObserver | null = null

function ensureArt() {
  tmdbEnsure(props.item.name, props.item.year, props.item.contentType || '')
}

onMounted(() => {
  // 一屏上百张卡同时查 TMDB 会堵住首屏，滚到附近再查
  if (typeof IntersectionObserver === 'undefined' || !cardEl.value) {
    ensureArt()
    return
  }
  artObserver = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      artObserver?.disconnect()
      artObserver = null
      ensureArt()
    },
    { rootMargin: '600px 0px' }
  )
  artObserver.observe(cardEl.value)
})

onBeforeUnmount(() => {
  artObserver?.disconnect()
  artObserver = null
})

function onError() {
  if (!tmdbSrc.value) {
    failed.value = true
    return
  }
  if (tmdbSwapImageHost(tmdbSrc.value)) return
  tmdbFailed.value = true
}
</script>

<template>
  <button
    ref="cardEl"
    class="poster-card"
    :class="{ compact: props.compact }"
    :data-play-key="`${props.item.sourceId}:${props.item.id}`"
    data-nav
    type="button"
    @click="$emit('select', props.item)"
  >
    <div class="poster-art">
      <div class="poster-fallback">{{ initial }}</div>
      <img
        v-if="(props.item.pic || tmdbSrc) && !failed"
        :src="src"
        :alt="props.item.name"
        loading="lazy"
        decoding="async"
        referrerpolicy="no-referrer"
        @error="onError"
      />
      <span v-if="props.showSource" class="poster-source">{{ props.item.sourceName }}</span>
      <span v-if="props.item.remarks" class="poster-scrim" />
      <span v-if="props.item.remarks" class="poster-remarks">{{ props.item.remarks }}</span>
      <span v-if="props.progress > 0.02" class="poster-progress">
        <span :style="{ width: `${Math.min(100, props.progress * 100)}%` }" />
      </span>
      <span class="poster-overlay">
        <span class="play-dot"><AppIcon name="play" :size="15" /></span>
      </span>
    </div>
    <div class="poster-meta">
      <span class="poster-title">{{ props.item.name }}</span>
      <span v-if="props.info" class="poster-chips">
        <span v-if="scoreText" class="poster-chip score">{{ scoreText }}</span>
        <span v-if="props.item.year" class="poster-chip">{{ props.item.year }}</span>
        <span v-if="props.item.typeName" class="poster-chip">{{ props.item.typeName }}</span>
        <span v-if="areaText" class="poster-chip">{{ areaText }}</span>
      </span>
      <span v-else class="poster-sub">
        <template v-if="props.item.year">{{ props.item.year }} · </template>
        {{ props.item.typeName || props.item.remarks || '影视' }}
      </span>
    </div>
  </button>
</template>

<style scoped>
.poster-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 7px;
  width: 100%;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  text-align: left;
  color: var(--text);
  border-radius: 12px;
  outline: none;
  transition: transform 0.18s ease;
}
.poster-art {
  position: relative;
  width: 100%;
  aspect-ratio: 2 / 3;
  border-radius: 12px;
  overflow: hidden;
  background: #1c2421;
  border: 1px solid rgba(255, 255, 255, 0.07);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.28);
  transition:
    box-shadow 0.18s ease,
    border-color 0.18s ease;
}
@media (hover: hover) {
  .poster-card:hover {
    transform: translateY(-3px);
    z-index: 20;
  }
  .poster-card:hover .poster-art {
    border-color: rgba(255, 255, 255, 0.18);
    box-shadow: 0 18px 40px rgba(0, 0, 0, 0.5);
  }
}
.poster-art img {
  position: absolute;
  inset: 0;
  z-index: 1;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 0.35s ease;
}
.poster-fallback {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  background:
    radial-gradient(90% 70% at 70% 8%, rgba(52, 211, 153, 0.14), transparent 60%),
    linear-gradient(165deg, #242d29 0%, #171d1b 58%, #101412 100%);
  font-size: clamp(24px, 3vw, 32px);
  font-weight: 700;
  color: rgba(255, 255, 255, 0.32);
}
.poster-source,
.poster-remarks {
  position: absolute;
  z-index: 2;
  top: 7px;
  font-size: 9.5px;
  font-weight: 600;
  line-height: 1;
  padding: 4px 6px;
  border-radius: 999px;
  background: rgba(10, 14, 12, 0.62);
  border: 1px solid rgba(255, 255, 255, 0.16);
  color: rgba(255, 255, 255, 0.92);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  max-width: calc(100% - 16px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.poster-source {
  left: 7px;
}
/* MarcoMovie：角标落在封面右下角，压在渐变蒙层上 */
.poster-remarks {
  top: auto;
  right: 8px;
  bottom: 7px;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.01em;
  color: #fff;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.9);
}
.poster-scrim {
  position: absolute;
  z-index: 1;
  left: 0;
  right: 0;
  bottom: 0;
  height: 42%;
  background: linear-gradient(180deg, transparent 0%, rgba(0, 0, 0, 0.66) 100%);
  pointer-events: none;
}
.poster-progress {
  position: absolute;
  z-index: 2;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: rgba(255, 255, 255, 0.24);
}
.poster-progress span {
  display: block;
  height: 100%;
  background: var(--accent);
}
.poster-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 3px;
  min-width: 0;
}
.poster-title {
  min-width: 0;
  max-width: 100%;
  font-size: 13px;
  font-weight: 700;
  line-height: 1.35;
  color: #f5f7fa;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.poster-sub {
  min-width: 0;
  max-width: 100%;
  font-size: 11px;
  color: #8e959e;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.poster-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 3px;
}
.poster-chip {
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
.poster-chip.score {
  color: #ffd479;
}
/* 横滑行里只留片名，副标题在 hover 层里显示 */
.poster-card.compact .poster-sub {
  display: none;
}
.poster-overlay {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0) 42%, rgba(0, 0, 0, 0.6));
  opacity: 0;
  transition: opacity 0.18s ease;
}
.play-dot {
  width: 42px;
  height: 42px;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.94);
  color: #000;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.45);
  transform: scale(0.86);
  transition: transform 0.18s ease;
}
.poster-card:hover .poster-overlay {
  opacity: 1;
}
.poster-card:hover .play-dot {
  transform: scale(1);
}
.poster-card:hover .poster-art img {
  transform: scale(1.04);
}
.poster-card:focus {
  outline: none;
}
.poster-card:focus .poster-art {
  border-color: rgba(245, 245, 247, 0.9);
  box-shadow:
    0 16px 36px rgba(0, 0, 0, 0.55),
    0 0 0 2px rgba(245, 245, 247, 0.9);
}
.poster-card:focus .poster-overlay {
  opacity: 1;
}
.poster-card:focus .play-dot {
  transform: scale(1);
}
.poster-card.compact .poster-title {
  font-size: 12.5px;
}

.tv-mode .poster-title {
  font-size: 14px;
  color: #c8c8d0;
}

.tv-mode .poster-sub {
  font-size: 12px;
}

.tv-mode .poster-art {
  border-radius: 10px;
  background: #25252d;
}

@media (max-width: 720px) {
  .poster-art {
    border-radius: 10px;
  }
  .poster-title {
    font-size: 12.5px;
  }
  .poster-meta {
    padding: 0 2px;
  }
  .poster-source {
    font-size: 9px;
    padding: 3px 5px;
    top: 5px;
    left: 5px;
  }
  .poster-remarks {
    right: 6px;
    bottom: 6px;
    font-size: 9.5px;
  }
}
</style>

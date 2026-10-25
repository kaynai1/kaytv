<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { PosterItem } from '../types'
import { mediaUrl } from '../api/runtime'
import { tmdbArts, tmdbEnsure, tmdbKey, tmdbPosterUrl, tmdbSwapImageHost } from '../api/tmdb'
import AppIcon from './AppIcon.vue'

const props = withDefaults(
  defineProps<{
    item: PosterItem
    progress?: number
    showSource?: boolean
    compact?: boolean
  }>(),
  { progress: 0, showSource: true, compact: false }
)

defineEmits<{ select: [item: PosterItem] }>()

const failed = ref(false)
const tmdbFailed = ref(false)
const initial = computed(() => props.item.name.trim().slice(0, 1) || '影')
const key = computed(() => tmdbKey(props.item.name, props.item.year))
const tmdbSrc = computed(() => (tmdbFailed.value ? '' : tmdbPosterUrl(tmdbArts[key.value], 'w500')))
const src = computed(() => tmdbSrc.value || mediaUrl(props.item.pic))

onMounted(() => tmdbEnsure(props.item.name, props.item.year, props.item.contentType || ''))

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
    class="poster-card"
    :class="{ compact: props.compact }"
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
      <span class="poster-sub">
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
  gap: 6px;
  width: 100%;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  text-align: left;
  color: var(--text);
  border-radius: 4px;
  outline: none;
  transition: transform 0.2s ease;
}
.poster-art {
  position: relative;
  width: 100%;
  aspect-ratio: 2 / 3;
  border-radius: 4px;
  overflow: hidden;
  background: var(--surface-2);
  border: 0;
  box-shadow: none;
  transition:
    box-shadow 0.2s ease,
    border-radius 0.2s ease;
}
@media (hover: hover) {
  .poster-card:hover {
    transform: scale(1.055);
    z-index: 20;
  }
  .poster-card:hover .poster-art {
    border-radius: 5px;
    box-shadow:
      0 14px 34px rgba(0, 0, 0, 0.7),
      0 0 0 1px rgba(255, 255, 255, 0.12);
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
  transition: transform 0.4s ease;
}
.poster-fallback {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  font-size: clamp(26px, 3.6vw, 40px);
  font-weight: 600;
  color: rgba(255, 255, 255, 0.35);
}
.poster-source,
.poster-remarks {
  position: absolute;
  z-index: 2;
  top: 6px;
  font-size: 10px;
  line-height: 1;
  padding: 3px 5px;
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.7);
  color: rgba(255, 255, 255, 0.9);
  max-width: calc(100% - 16px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.poster-source {
  left: 6px;
}
.poster-remarks {
  right: 6px;
  color: #fff;
  background: rgba(229, 9, 20, 0.9);
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
  gap: 1px;
  padding: 0 1px;
  min-width: 0;
}
.poster-title {
  min-width: 0;
  max-width: 100%;
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1.35;
  color: #d6d6d6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.poster-sub {
  min-width: 0;
  max-width: 100%;
  font-size: 11px;
  color: var(--muted-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  background: linear-gradient(180deg, rgba(0, 0, 0, 0) 42%, rgba(0, 0, 0, 0.66));
  opacity: 0;
  transition: opacity 0.2s ease;
}
.play-dot {
  width: 42px;
  height: 42px;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.92);
  color: #000;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.45);
  transform: scale(0.86);
  transition: transform 0.2s ease;
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
  box-shadow:
    0 14px 34px rgba(0, 0, 0, 0.7),
    0 0 0 3px var(--accent);
}
.poster-card:focus .poster-overlay {
  opacity: 1;
}
.poster-card:focus .play-dot {
  transform: scale(1);
}
.poster-card.compact .poster-title {
  font-size: 12px;
}
</style>

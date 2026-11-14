<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { PosterItem } from '../types'
import { mediaUrl } from '../api/runtime'
import { tmdbArts, tmdbEnsure, tmdbKey, tmdbPosterUrl, tmdbSwapImageHost } from '../api/tmdb'
import AppIcon from './AppIcon.vue'

const props = defineProps<{
  item: PosterItem & { area?: string; score?: string }
}>()

const emit = defineEmits<{ select: [item: PosterItem]; play: [item: PosterItem] }>()

const failed = ref(false)
const tmdbFailed = ref(false)
const scoreText = computed(() => {
  const value = Number.parseFloat(String(props.item.score || ''))
  return Number.isFinite(value) && value > 0 ? String(props.item.score).trim() : ''
})
// 采集源的地区字段常带前导冒号，如 ": 中国大陆"
const areaText = computed(() => String(props.item.area || '').replace(/^[\s:：·,，.-]+/, '').trim())
const key = computed(() => tmdbKey(props.item.name, props.item.year))
const tmdbSrc = computed(() => (tmdbFailed.value ? '' : tmdbPosterUrl(tmdbArts[key.value], 'w342')))
const src = computed(() => tmdbSrc.value || mediaUrl(props.item.pic))

onMounted(() => {
  tmdbEnsure(props.item.name, props.item.year, props.item.contentType || '')
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
  <div
    class="pick-card"
    :data-play-key="`${props.item.sourceId}:${props.item.id}`"
    role="button"
    tabindex="0"
    @click="emit('select', props.item)"
    @keydown.enter.prevent="emit('select', props.item)"
  >
    <span class="pick-poster">
      <img
        v-if="src && !failed"
        :src="src"
        :alt="props.item.name"
        loading="eager"
        decoding="async"
        referrerpolicy="no-referrer"
        @error="onError"
      />
      <span v-else class="pick-fallback">{{ props.item.name.slice(0, 1) || '影' }}</span>
    </span>
    <span class="pick-info">
      <span class="pick-title">{{ props.item.name }}</span>
      <span class="pick-chips">
        <span v-if="scoreText" class="pick-chip score">{{ scoreText }}</span>
        <span v-if="props.item.year" class="pick-chip">{{ props.item.year }}</span>
        <span v-if="props.item.typeName" class="pick-chip">{{ props.item.typeName }}</span>
        <span v-if="areaText" class="pick-chip">{{ areaText }}</span>
      </span>
      <button class="pick-play" type="button" @click.stop="emit('play', props.item)">
        <AppIcon name="play" :size="10" />
        立即观看
      </button>
    </span>
  </div>
</template>

<style scoped>
.pick-card {
  display: flex;
  gap: 10px;
  padding: 10px;
  height: 140px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 18px;
  background: linear-gradient(180deg, rgba(20, 28, 25, 0.95), rgba(13, 19, 17, 0.97));
  box-shadow:
    0 12px 28px rgba(0, 0, 0, 0.34),
    inset 0 1px 0 rgba(255, 255, 255, 0.1);
  cursor: pointer;
  outline: none;
  transition: border-color 0.16s ease, transform 0.16s ease;
}

.pick-card:hover {
  border-color: rgba(255, 255, 255, 0.3);
}

.pick-card:focus-visible {
  border-color: rgba(255, 255, 255, 0.55);
}

.pick-poster {
  flex: none;
  width: 80px;
  height: 120px;
  border-radius: 12px;
  overflow: hidden;
  background: #1b2622;
  box-shadow: 0 8px 18px rgba(0, 0, 0, 0.36);
}

.pick-poster img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.pick-fallback {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  background:
    radial-gradient(90% 70% at 70% 8%, rgba(52, 211, 153, 0.16), transparent 60%),
    linear-gradient(165deg, #26312d 0%, #171d1b 60%, #101412 100%);
  font-size: 24px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.3);
}

.pick-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}

.pick-title {
  max-width: 100%;
  font-size: 13.5px;
  font-weight: 700;
  line-height: 1.25;
  color: #f5f5f7;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.pick-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 5px;
  max-height: 42px;
  overflow: hidden;
}

.pick-chip {
  padding: 3px 6px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.09);
  color: #d4d8d6;
  font-size: 9.5px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
}

.pick-chip.score {
  color: #ffd479;
}

.pick-play {
  align-self: flex-end;
  margin-top: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 10px;
  border: 0;
  border-radius: 999px;
  background: #f5f5f7;
  color: #0b0f0d;
  font-size: 10.5px;
  font-weight: 800;
  cursor: pointer;
  outline: none;
  box-shadow: 0 6px 14px rgba(0, 0, 0, 0.3);
}

@media (max-width: 639px) {
  .pick-card {
    height: 128px;
  }

  .pick-poster {
    width: 72px;
    height: 108px;
  }

  .pick-title {
    font-size: 14px;
  }
}
</style>

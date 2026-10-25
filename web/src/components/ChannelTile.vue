<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Channel } from '../types'
import { mediaUrl } from '../api/runtime'

const props = withDefaults(
  defineProps<{ channel: Channel; active?: boolean; now?: string }>(),
  { active: false, now: '' }
)
defineEmits<{ select: [channel: Channel] }>()

const failed = ref(false)
const hue = computed(() => {
  let value = 0
  for (let index = 0; index < props.channel.name.length; index += 1) {
    value = (value * 31 + props.channel.name.charCodeAt(index)) % 360
  }
  return value
})
const initial = computed(() => props.channel.name.replace(/^CCTV-?/i, 'C').slice(0, 2))
const is4k = computed(() => /4k|2160|uhd|超高清/i.test(props.channel.name))
</script>

<template>
  <button
    class="channel-tile"
    :class="{ active: props.active }"
    data-nav
    type="button"
    @click="$emit('select', props.channel)"
  >
    <span class="channel-logo">
      <span
        class="channel-initial"
        :style="{ background: `hsl(${hue} 32% 20%)`, color: `hsl(${hue} 60% 78%)` }"
      >
        {{ initial }}
      </span>
      <img
        v-if="props.channel.logo && !failed"
        :src="mediaUrl(props.channel.logo)"
        :alt="props.channel.name"
        loading="lazy"
        decoding="async"
        referrerpolicy="no-referrer"
        @error="failed = true"
      />
      <span v-if="is4k" class="channel-4k">4K</span>
    </span>
    <span class="channel-name">{{ props.channel.name }}</span>
    <span v-if="props.now" class="channel-now">{{ props.now }}</span>
    <span v-else class="channel-group">{{ props.channel.group }}</span>
  </button>
</template>

<style scoped>
.channel-tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 14px 10px 11px;
  border-radius: 4px;
  border: 1px solid transparent;
  background: var(--surface);
  color: var(--text);
  transition:
    transform 0.18s ease,
    background 0.18s ease,
    border-color 0.18s ease;
  outline: none;
}
@media (hover: hover) {
  .channel-tile:hover {
    transform: translateY(-2px);
    background: var(--surface-2);
    border-color: var(--line);
  }
}
.channel-logo {
  position: relative;
  width: 58px;
  height: 58px;
  display: grid;
  place-items: center;
  border-radius: 4px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.04);
}
.channel-logo img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.channel-initial {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  font-size: 18px;
  font-weight: 600;
}
.channel-4k {
  position: absolute;
  right: 3px;
  bottom: 3px;
  padding: 0 4px;
  border-radius: 3px;
  background: rgba(8, 16, 28, 0.9);
  border: 1px solid rgba(154, 215, 255, 0.55);
  color: #9ad7ff;
  font-size: 8.5px;
  font-weight: 800;
  line-height: 13px;
  letter-spacing: 0.3px;
}
.channel-name {
  width: 100%;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.25;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.channel-group {
  width: 100%;
  font-size: 10.5px;
  color: var(--muted);
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.channel-tile.active {
  border-color: var(--accent);
  background: rgba(229, 9, 20, 0.08);
}
.channel-tile.active .channel-name {
  color: #fff;
  font-weight: 700;
}
.channel-tile:focus {
  transform: translateY(-2px) scale(1.02);
  background: var(--surface-2);
  border-color: transparent;
  outline: 3px solid var(--accent);
  outline-offset: 2px;
}
.channel-now {
  width: 100%;
  font-size: 10.5px;
  color: #d2d2d2;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

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
    <span class="channel-meta">
      <span class="channel-name">{{ props.channel.name }}</span>
      <span v-if="props.now" class="channel-now">{{ props.now }}</span>
      <span v-else class="channel-group">{{ props.channel.group }}</span>
    </span>
  </button>
</template>

<style scoped>
.channel-tile {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 10px;
  min-width: 0;
  /* button 默认按内容收缩，节目名一长就会盖住旁边的台 */
  width: 100%;
  overflow: hidden;
  padding: 10px;
  border-radius: 14px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: linear-gradient(180deg, rgba(24, 33, 29, 0.82), rgba(13, 20, 17, 0.9));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
  color: var(--text);
  text-align: left;
  transition:
    transform 0.18s ease,
    background 0.18s ease,
    border-color 0.18s ease;
  outline: none;
}
@media (hover: hover) {
  .channel-tile:hover {
    transform: translateY(-1px);
    background: rgba(255, 255, 255, 0.1);
    border-color: rgba(255, 255, 255, 0.18);
  }
}
.channel-logo {
  position: relative;
  flex: none;
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border-radius: 11px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.05);
}
.channel-logo img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  padding: 4px;
}
.channel-initial {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  font-size: 14px;
  font-weight: 700;
}
.channel-4k {
  position: absolute;
  right: 1px;
  bottom: 1px;
  padding: 0 3px;
  border-radius: 3px;
  background: rgba(8, 16, 28, 0.9);
  border: 1px solid rgba(154, 215, 255, 0.55);
  color: #9ad7ff;
  font-size: 7.5px;
  font-weight: 800;
  line-height: 11px;
  letter-spacing: 0.3px;
}
.channel-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.channel-name {
  width: 100%;
  font-size: 13px;
  font-weight: 700;
  line-height: 1.25;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.channel-group,
.channel-now {
  width: 100%;
  font-size: 11px;
  color: #8e959e;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.channel-tile.active {
  border-color: rgba(255, 255, 255, 0.5);
  background: rgba(255, 255, 255, 0.1);
}
.channel-tile.active .channel-name {
  color: #fff;
  font-weight: 700;
}
.channel-tile:focus {
  transform: translateY(-1px) scale(1.01);
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.7);
  outline: 3px solid var(--accent);
  outline-offset: 2px;
}
.tv-mode .channel-tile {
  padding: 12px;
  border-radius: 16px;
  gap: 12px;
}
.tv-mode .channel-logo {
  width: 48px;
  height: 48px;
  border-radius: 13px;
}
.tv-mode .channel-name {
  font-size: 15px;
}
.tv-mode .channel-group,
.tv-mode .channel-now {
  font-size: 12px;
}
</style>

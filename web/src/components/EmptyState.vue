<script setup lang="ts">
import AppIcon from './AppIcon.vue'

withDefaults(
  defineProps<{
    title: string
    message?: string
    icon?: string
  }>(),
  { message: '', icon: 'info' }
)
</script>

<template>
  <div class="state">
    <span class="state-icon"><AppIcon :name="icon" :size="26" /></span>
    <p class="state-title">{{ title }}</p>
    <p v-if="message" class="state-message">{{ message }}</p>
    <slot />
  </div>
</template>

<style scoped>
.state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 64px 20px;
  text-align: center;
  color: var(--muted);
}
.state-icon {
  width: 56px;
  height: 56px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.045);
  color: var(--muted);
  margin-bottom: 4px;
}
.state-title {
  margin: 0;
  font-size: 15.5px;
  font-weight: 600;
  color: var(--text);
}
.state-message {
  margin: 0;
  max-width: 460px;
  font-size: 13px;
  line-height: 1.65;
}
</style>

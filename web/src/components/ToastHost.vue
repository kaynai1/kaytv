<script setup lang="ts">
import { toast } from '../composables/useToast'
import AppIcon from './AppIcon.vue'
</script>

<template>
  <Teleport to="body">
    <div class="toast-host">
      <TransitionGroup name="toast">
        <div v-for="item in toast.state.items" :key="item.id" class="toast" :class="item.type">
          <AppIcon :name="item.type === 'error' ? 'warn' : item.type === 'success' ? 'check' : 'info'" :size="17" />
          <span>{{ item.message }}</span>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-host {
  position: fixed;
  left: 50%;
  bottom: 34px;
  transform: translateX(-50%);
  z-index: 200;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  pointer-events: none;
}
.toast {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px 16px;
  border-radius: 11px;
  background: rgba(20, 23, 30, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.5);
  font-size: 13px;
  color: var(--text);
  backdrop-filter: blur(12px);
  max-width: min(520px, calc(100vw - 40px));
}
.toast.success {
  border-color: rgba(87, 214, 138, 0.35);
  color: #b9f3cf;
}
.toast.error {
  border-color: rgba(255, 102, 102, 0.4);
  color: #ffc0c0;
}
.toast-enter-active,
.toast-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>

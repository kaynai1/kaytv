import { reactive } from 'vue'

export interface ToastItem {
  id: number
  type: 'info' | 'success' | 'error'
  message: string
}

const state = reactive<{ items: ToastItem[] }>({ items: [] })
let seq = 0

function show(message: string, type: ToastItem['type'] = 'info', duration = 2800) {
  const id = ++seq
  state.items.push({ id, type, message })
  window.setTimeout(() => {
    const index = state.items.findIndex((item) => item.id === id)
    if (index >= 0) state.items.splice(index, 1)
  }, duration)
}

export const toast = {
  state,
  show,
  info: (message: string, duration?: number) => show(message, 'info', duration),
  success: (message: string) => show(message, 'success'),
  error: (message: string) => show(message, 'error', 4200)
}

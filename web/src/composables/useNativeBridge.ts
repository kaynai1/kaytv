import { watch } from 'vue'
import router from '../router'
import { usePlayerStore } from '../stores/player'
import { useSettingsStore } from '../stores/settings'
import { consumeBack } from './backStack'

interface NativeBridge {
  setBackHandled(handled: boolean): void
  setKeepAwake(keep: boolean): void
  minimize(): void
}

function nativeBridge(): NativeBridge | undefined {
  return (window as { kaytvNative?: NativeBridge }).kaytvNative
}

/** Android 返回键与屏幕常亮；桌面与浏览器没有 kaytvNative，直接跳过 */
export function initNativeBridge() {
  const native = nativeBridge()
  if (!native) return

  const player = usePlayerStore()
  const settings = useSettingsStore()

  native.setBackHandled(true)
  window.addEventListener('kaytv:back', () => {
    if (consumeBack()) return
    if (player.open) {
      player.close()
      return
    }
    const route = router.currentRoute.value
    const previous = (history.state as { back?: unknown } | null)?.back
    if (typeof previous === 'string' && previous && previous !== route.fullPath) {
      void router.back()
      return
    }
    native.minimize()
  })

  watch(
    () => player.open || settings.tvMode,
    (keep) => native.setKeepAwake(Boolean(keep)),
    { immediate: true }
  )
}

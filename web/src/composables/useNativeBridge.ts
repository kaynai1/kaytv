import { watch } from 'vue'
import router from '../router'
import { usePlayerStore } from '../stores/player'
import { useSettingsStore } from '../stores/settings'
import { consumeBack } from './backStack'

interface NativeBridge {
  setBackHandled(handled: boolean): void
  setKeepAwake(keep: boolean): void
  minimize(): void
  /** 系统媒体音量：0-100，-1 表示拿不到 */
  getSystemVolume(): number
  setSystemVolume(percent: number): void
  /** 播放窗口的屏幕亮度：0-100，-1 交还系统控制 */
  setWindowBrightness(percent: number): void
  /** 系统屏幕亮度：0-100，-1 表示自动亮度或拿不到 */
  getSystemBrightness(): number
  /** 拉起系统的无线投屏 / 多屏互动面板，返回是否成功 */
  openCastPanel(): boolean
  /** Android Activity 级方向锁：全屏播放强制横屏，退出后恢复重力感应 */
  setOrientation(value: 'landscape' | 'portrait' | 'any'): void
}

export function nativeBridge(): NativeBridge | undefined {
  return (window as { kaytvNative?: NativeBridge }).kaytvNative
}

/** Android 返回键、屏幕常亮、系统音量与投屏面板；桌面与浏览器没有 kaytvNative，直接跳过 */
export function initNativeBridge() {
  const native = nativeBridge()
  if (!native) return

  const player = usePlayerStore()
  const settings = useSettingsStore()

  native.setBackHandled(true)
  window.addEventListener('kaytv:back', () => {
    if (consumeBack()) return
    if (player.open) {
      // 播放器先处理：收起控制条/菜单，最后才真正退出；没人处理就直接关
      const handled = !window.dispatchEvent(new CustomEvent('kaytv:player-back', { cancelable: true }))
      if (!handled) player.close()
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

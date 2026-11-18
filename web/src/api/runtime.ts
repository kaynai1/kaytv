function detectNative(): boolean {
  if (typeof window === 'undefined') return false
  const capacitor = (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  return Boolean(capacitor?.isNativePlatform?.())
}

function detectPackaged(): boolean {
  if (typeof window === 'undefined') return false
  if (window.location.protocol === 'file:') return true
  return detectNative()
}

/** 打包脚本 patch-android.mjs 会往 index.html 里写设备形态，电视盒子不用再靠触摸能力去猜 */
function detectDevice(): 'tv' | 'phone' | 'desktop' {
  if (typeof document !== 'undefined') {
    const value = (document.querySelector('meta[name="kaytv-device"]')?.getAttribute('content') || '').toLowerCase()
    if (value === 'tv' || value === 'phone') return value
  }
  return detectNative() ? 'phone' : 'desktop'
}

export const runtime = {
  serverUrl: '',
  standalone: false,
  native: detectNative(),
  packaged: detectPackaged(),
  device: detectDevice()
}

let hevcSupport: boolean | null = null

/** 4K 官方线路多为 H.265，解码不支持的设备上会出现只有声音没有画面 */
export function deviceSupportsHevc(): boolean {
  if (hevcSupport !== null) return hevcSupport
  hevcSupport = false
  try {
    const probe = document.createElement('video')
    const native = probe.canPlayType('video/mp4; codecs="hvc1.1.6.L120.90"')
    const mse =
      typeof MediaSource !== 'undefined'
        ? MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L120.90"')
        : false
    hevcSupport = native === 'probably' || native === 'maybe' || mse
  } catch {
    hevcSupport = false
  }
  return hevcSupport
}

export function apiUrl(path: string): string {
  const base = runtime.serverUrl.replace(/\/+$/, '')
  if (!base) return path
  return `${base}${path.startsWith('/') ? path : `/${path}`}`
}

export function mediaUrl(url?: string): string {
  if (!url) return ''
  if (/^(https?:|data:|blob:)/i.test(url)) return url
  const base = runtime.serverUrl.replace(/\/+$/, '')
  return `${base}${url.startsWith('/') ? url : `/${url}`}`
}

export function normalizeServerUrl(input: string): string {
  const value = input.trim()
  if (!value) return ''
  const withScheme = /^https?:\/\//i.test(value) ? value : `http://${value}`
  return withScheme.replace(/\/+$/, '')
}

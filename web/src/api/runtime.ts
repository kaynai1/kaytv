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

export const runtime = {
  serverUrl: '',
  standalone: false,
  native: detectNative(),
  packaged: detectPackaged()
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

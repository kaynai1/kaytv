import { reactive } from 'vue'
import { appVersion, logEvent } from './diagnostics'

const REPO = 'kaynai1/kaytv'
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`
const RELEASE_PAGE = `https://github.com/${REPO}/releases/latest`
export const latestReleaseUrl = RELEASE_PAGE
const REQUEST_TIMEOUT = 9000

export type UpdateAsset = { name: string; url: string; size: number }

export interface UpdateInfo {
  version: string
  page: string
  note: string
  publishedAt: string
  assets: UpdateAsset[]
}

export const updateState = reactive<{
  checking: boolean
  checkedAt: number
  current: string
  info: UpdateInfo | null
  error: string
  checkedOnce: boolean
}>({
  checking: false,
  checkedAt: 0,
  current: appVersion(),
  info: null,
  error: '',
  checkedOnce: false
})

function parseVersion(tag: string): number[] {
  return String(tag || '')
    .replace(/^v/i, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0)
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index] || 0
    const right = b[index] || 0
    if (left !== right) return left > right
  }
  return false
}

/** 按当前平台挑最合适的产物直链：Windows 优先安装包，安卓按是否电视设备选包 */
export function preferredAsset(assets: UpdateAsset[], androidTv: boolean): UpdateAsset | null {
  if (!assets.length) return null
  const os = navigator.userAgent
  const windows = /Windows/i.test(os)
  const android = /Android/i.test(os)
  const pick = (pattern: RegExp) => assets.find((asset) => pattern.test(asset.name)) || null
  if (windows) return pick(/windows-setup/i) || pick(/windows.*portable/i) || pick(/\.exe$/i)
  if (android) return pick(androidTv ? /(^|-)tv(-|\.)/i : /phone/i) || pick(/\.apk$/i)
  return pick(/\.apk$/i) || pick(/windows-setup/i) || pick(/\.exe$/i) || assets[0]
}

export async function checkForUpdate(options: { silent?: boolean } = {}): Promise<UpdateInfo | null> {
  if (updateState.checking) return updateState.info
  updateState.checking = true
  if (!options.silent) updateState.error = ''
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT)
  try {
    const response = await fetch(LATEST_API, {
      headers: { accept: 'application/vnd.github+json' },
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}`)
    const payload = (await response.json()) as {
      tag_name?: string
      html_url?: string
      body?: string
      published_at?: string
      assets?: { name?: string; browser_download_url?: string; size?: number }[]
    }
    const info: UpdateInfo = {
      version: String(payload.tag_name || '').replace(/^v/i, ''),
      page: payload.html_url || RELEASE_PAGE,
      note: String(payload.body || '').slice(0, 600),
      publishedAt: String(payload.published_at || ''),
      assets: (payload.assets || [])
        .filter((asset) => asset.browser_download_url)
        .map((asset) => ({
          name: String(asset.name || 'asset'),
          url: String(asset.browser_download_url),
          size: Number(asset.size) || 0
        }))
    }
    updateState.info = info
    updateState.error = ''
    updateState.checkedAt = Date.now()
    if (isNewer(info.version, updateState.current)) {
      logEvent('update', `发现新版本 v${info.version}（当前 v${updateState.current}）`)
    }
    return info
  } catch (error) {
    /* 静默检查失败不打扰用户，只在设置页里留原因 */
    const message =
      error instanceof DOMException && error.name === 'AbortError' ? '检查更新超时' : String((error as Error).message || error)
    if (!options.silent) updateState.error = message
    logEvent('update', `检查更新失败：${message}`)
    return null
  } finally {
    window.clearTimeout(timer)
    updateState.checking = false
    updateState.checkedOnce = true
  }
}

export function hasUpdate(): boolean {
  return Boolean(updateState.info && isNewer(updateState.info.version, updateState.current))
}

export function openExternal(url: string) {
  const target = window.open(url, '_blank', 'noopener,noreferrer')
  if (!target) window.location.href = url
}

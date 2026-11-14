import { reactive } from 'vue'
import { appVersion, logEvent } from './diagnostics'

const REPO = 'kaynai1/kaytv'
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`
const RELEASE_PAGE = `https://github.com/${REPO}/releases/latest`
export const latestReleaseUrl = RELEASE_PAGE
const REQUEST_TIMEOUT = 8000
// GitHub 接口在国内偶尔直接 403/超时，加速线路走代理服务器自己的配额
const API_SOURCES = [LATEST_API, `https://gh-proxy.com/${LATEST_API}`]

export type UpdateAsset = { name: string; url: string; size: number }

export interface UpdateInfo {
  version: string
  page: string
  note: string
  publishedAt: string
  assets: UpdateAsset[]
}

interface GithubRelease {
  tag_name?: string
  html_url?: string
  body?: string
  published_at?: string
  assets?: { name?: string; browser_download_url?: string; size?: number }[]
}

async function fetchLatestRelease(): Promise<GithubRelease> {
  let lastMessage = ''
  for (const source of API_SOURCES) {
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT)
    try {
      const response = await fetch(source, {
        headers: { accept: 'application/vnd.github+json' },
        signal: controller.signal,
        cache: 'no-store'
      })
      if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}`)
      return (await response.json()) as GithubRelease
    } catch (error) {
      lastMessage =
        error instanceof DOMException && error.name === 'AbortError' ? '检查更新超时' : String((error as Error).message || error)
    } finally {
      window.clearTimeout(timer)
    }
  }
  throw new Error(`检查更新失败，GitHub 接口和加速线路都没连上（${lastMessage || '网络异常'}）`)
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
  try {
    const payload = await fetchLatestRelease()
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
    const message = String((error as Error).message || error)
    if (!options.silent) updateState.error = message
    logEvent('update', `检查更新失败：${message}`)
    return null
  } finally {
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

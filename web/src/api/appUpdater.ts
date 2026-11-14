import { reactive } from 'vue'
import { openExternal } from './updateCheck'

export type UpdatePhase = 'idle' | 'downloading' | 'ready' | 'installing' | 'error'

interface DesktopUpdaterBridge {
  download(payload: { url: string; fileName: string; total?: number }): Promise<{ filePath: string; size: number }>
  install(): Promise<boolean>
  onProgress(callback: (data: { received: number; total: number; speed: number; reset?: boolean }) => void): () => void
}

interface AndroidUpdaterBridge {
  downloadUpdate(url: string, fileName: string): string
  updateProgress(): string
  installUpdate(): string
}

interface AndroidProgress {
  status?: string
  received?: number
  total?: number
  error?: string
}

export const updateDownload = reactive({
  phase: 'idle' as UpdatePhase,
  received: 0,
  total: 0,
  speed: 0,
  error: '',
  fileName: ''
})

const desktop = () => (window as { kaytvUpdater?: DesktopUpdaterBridge }).kaytvUpdater
const android = () => (window as { kaytvNative?: Partial<AndroidUpdaterBridge> }).kaytvNative

/** 桌面壳和安卓原生桥都能自己下包并调起安装；浏览器只能交给外部下载 */
export function canInAppInstall(): boolean {
  return Boolean(desktop()?.download || android()?.downloadUpdate)
}

export function formatSize(bytes: number): string {
  const value = Math.max(0, Number(bytes) || 0)
  if (value < 1024) return `${Math.round(value)} B`
  if (value < 1024 ** 2) return `${Math.round(value / 1024)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(2)} GB`
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${formatSize(bytesPerSecond)}/s`
}

let subscribed = false
let pollTimer = 0

function subscribeDesktop(bridge: DesktopUpdaterBridge) {
  if (subscribed) return
  subscribed = true
  bridge.onProgress(({ received, total, speed, reset }) => {
    if (updateDownload.phase !== 'downloading') return
    if (reset) {
      updateDownload.received = 0
      updateDownload.total = total > 0 ? total : updateDownload.total
    }
    if (received > updateDownload.received) updateDownload.received = received
    if (total > 0) updateDownload.total = total
    updateDownload.speed = speed
  })
}

// IPC 错误会带上 "Error invoking remote method '...'" 前缀，界面里只留真正的原因
function cleanMessage(raw: string): string {
  return String(raw || '')
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
}

function failDownload(message: string) {
  window.clearInterval(pollTimer)
  pollTimer = 0
  updateDownload.speed = 0
  updateDownload.phase = 'error'
  updateDownload.error = cleanMessage(message) || '下载失败'
}

function pollAndroid(onFailure: (reason: string) => boolean) {
  window.clearInterval(pollTimer)
  let lastBytes = 0
  let lastAt = Date.now()
  pollTimer = window.setInterval(() => {
    const bridge = android()
    if (!bridge?.updateProgress) {
      failDownload('原生下载器不可用')
      return
    }
    let progress: AndroidProgress
    try {
      progress = JSON.parse(bridge.updateProgress()) as AndroidProgress
    } catch {
      return
    }
    const received = Math.max(0, Number(progress.received) || 0)
    const total = Math.max(0, Number(progress.total) || 0)
    if (received > updateDownload.received) updateDownload.received = received
    if (total > 0) updateDownload.total = total
    const now = Date.now()
    const span = (now - lastAt) / 1000
    if (span >= 0.4) {
      updateDownload.speed = Math.max(0, (received - lastBytes) / span)
      lastBytes = received
      lastAt = now
    }
    if (progress.status === 'successful') {
      window.clearInterval(pollTimer)
      pollTimer = 0
      updateDownload.speed = 0
      if (!updateDownload.total) updateDownload.total = received
      updateDownload.phase = 'ready'
    } else if (progress.status === 'failed') {
      window.clearInterval(pollTimer)
      pollTimer = 0
      const reason = progress.error || '系统下载器报告下载失败'
      if (!onFailure(reason)) failDownload(`下载失败，GitHub 和加速线路都连不上（${cleanMessage(reason)}）`)
    } else if (progress.status === 'idle') {
      failDownload('下载任务丢失，请重新下载')
    }
  }, 600)
}

// 安卓系统下载器自己处理重定向，但直连 GitHub 超时后不会换线路，这里由页面重试
const ANDROID_MIRRORS = ['https://gh-proxy.com/', 'https://ghproxy.net/']

function androidSources(url: string): string[] {
  const list = [url]
  if (/^https:\/\/github\.com\//i.test(url)) {
    for (const prefix of ANDROID_MIRRORS) list.push(prefix + url)
  }
  return list
}

function startAndroidDownload(url: string, fileName: string, totalHint: number): void {
  const bridge = android()
  if (!bridge?.downloadUpdate) {
    openExternal(url)
    return
  }
  const sources = androidSources(url)
  let sourceIndex = 0

  const handleFailure = (reason: string): boolean => {
    if (sourceIndex + 1 >= sources.length) return false
    sourceIndex += 1
    updateDownload.received = 0
    updateDownload.total = Math.max(0, totalHint)
    updateDownload.speed = 0
    return beginSource()
  }

  const beginSource = (): boolean => {
    try {
      const parsed = JSON.parse(bridge.downloadUpdate!(sources[sourceIndex], fileName)) as AndroidProgress
      if (parsed.status === 'failed' || parsed.error) {
        return handleFailure(parsed.error || '下载启动失败')
      }
      updateDownload.phase = 'downloading'
      pollAndroid(handleFailure)
      return true
    } catch (error) {
      return handleFailure(String((error as Error).message || error))
    }
  }

  if (!beginSource()) {
    failDownload('下载启动失败，请检查网络后重试')
  }
}

export async function startUpdateDownload(url: string, fileName: string, totalHint = 0): Promise<void> {
  if (updateDownload.phase === 'downloading' || updateDownload.phase === 'installing') return
  updateDownload.received = 0
  updateDownload.total = Math.max(0, totalHint)
  updateDownload.speed = 0
  updateDownload.error = ''
  updateDownload.fileName = fileName

  const desktopBridge = desktop()
  if (desktopBridge) {
    subscribeDesktop(desktopBridge)
    updateDownload.phase = 'downloading'
    try {
      const result = await desktopBridge.download({ url, fileName, total: totalHint })
      updateDownload.received = Number(result?.size) || updateDownload.received
      if (!updateDownload.total) updateDownload.total = updateDownload.received
      updateDownload.speed = 0
      updateDownload.phase = 'ready'
    } catch (error) {
      failDownload(String((error as Error).message || error))
    }
    return
  }

  const androidBridge = android()
  if (androidBridge?.downloadUpdate) {
    startAndroidDownload(url, fileName, totalHint)
    return
  }

  openExternal(url)
}

export async function installUpdate(): Promise<'installing' | 'permission' | 'failed'> {
  updateDownload.error = ''
  const desktopBridge = desktop()
  if (desktopBridge) {
    updateDownload.phase = 'installing'
    try {
      await desktopBridge.install()
      return 'installing'
    } catch (error) {
      updateDownload.phase = 'ready'
      updateDownload.error = String((error as Error).message || error)
      return 'failed'
    }
  }

  const androidBridge = android()
  if (androidBridge?.installUpdate) {
    let result = ''
    try {
      result = androidBridge.installUpdate()
    } catch (error) {
      updateDownload.error = String((error as Error).message || error)
    }
    if (result === 'permission') {
      updateDownload.error = '请在系统设置里允许 KayTV 安装应用，然后回来再点一次安装'
      return 'permission'
    }
    if (result === 'installing') {
      updateDownload.phase = 'installing'
      // 安卓安装器盖在应用上面，用户取消回来后按钮要能再点
      window.setTimeout(() => {
        if (updateDownload.phase === 'installing') updateDownload.phase = 'ready'
      }, 4000)
      return 'installing'
    }
    updateDownload.phase = 'ready'
    if (!updateDownload.error) updateDownload.error = '安装器没有启动，可以到发布页手动下载'
    return 'failed'
  }

  return 'failed'
}

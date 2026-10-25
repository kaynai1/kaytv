import { reactive } from 'vue'
import { runtime } from './runtime'

export interface DiagEvent {
  at: number
  scope: string
  message: string
}

const STORAGE_KEY = 'kaytv.diagnostics.v1'
const MAX_EVENTS = 120

function load(): DiagEvent[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') as DiagEvent[]
    return Array.isArray(parsed) ? parsed.slice(-MAX_EVENTS) : []
  } catch {
    return []
  }
}

const events = reactive<DiagEvent[]>(load())

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(events.slice(-MAX_EVENTS)))
  } catch {
    /* 诊断日志写不进不影响使用 */
  }
}

/** 记录一条排障事件；连续相同的同 scope 事件只保留时间更新 */
export function logEvent(scope: string, message: string) {
  const text = String(message || '').slice(0, 200)
  if (!text) return
  const last = events[events.length - 1]
  if (last && last.scope === scope && last.message === text) {
    last.at = Date.now()
    return
  }
  events.push({ at: Date.now(), scope, message: text })
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
  persist()
}

export function recentEvents(limit = 40): DiagEvent[] {
  return events.slice(-limit).reverse()
}

export function clearEvents() {
  events.splice(0, events.length)
  persist()
}

function pad(value: number) {
  return String(value).padStart(2, '0')
}

function stamp(at: number) {
  const date = new Date(at)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}:${pad(date.getSeconds())}`
}

/** 供「一键复制给开发者」的纯文本摘要 */
export function diagnosticsText(extra: Record<string, string> = {}): string {
  const lines = [
    `KayTV ${appVersion()}`,
    `运行环境：${runtime.native ? '手机/电视客户端' : runtime.packaged ? '桌面客户端' : '浏览器'}`,
    `取数模式：${runtime.standalone ? '内置模式' : runtime.serverUrl || '同源服务端'}`,
    `网络：${navigator.onLine ? '在线' : '离线'} · ${new Date().toLocaleString('zh-CN')}`,
    ...Object.entries(extra).map(([key, value]) => `${key}：${value}`),
    '',
    '最近事件：'
  ]
  const list = recentEvents(30)
  if (!list.length) lines.push('（暂无记录）')
  for (const event of list) lines.push(`${stamp(event.at)} [${event.scope}] ${event.message}`)
  return lines.join('\n')
}

export function appVersion(): string {
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0'
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 剪贴板权限被拒时走兜底 */
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}

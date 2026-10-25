import { reactive } from 'vue'
import type { SourceProbe } from '../api/standalone'
import { probeLiveSource } from '../api/standalone'
import { mediaUrl } from '../api/runtime'
import type { Channel } from '../types'
import { channelKey } from './liveChannels'

const PROBE_LIMIT = 60
const PROBE_CONCURRENCY = 6
const PROBE_TIMEOUT = 9000
export const SLOW_MS = 2500

export const channelProbes = reactive<Record<string, SourceProbe>>({})
export const channelProbeState = reactive({
  running: false,
  group: '',
  done: 0,
  total: 0,
  ok: 0
})

export function channelProbeOf(channel: Channel | null | undefined): SourceProbe | undefined {
  if (!channel) return undefined
  return channelProbes[channelKey(channel)]
}

export function clearChannelProbes() {
  for (const key of Object.keys(channelProbes)) delete channelProbes[key]
}

function channelProbeError(caught: unknown): string {
  if (caught instanceof Error) {
    if (caught.name === 'AbortError') return '请求超时'
    const message = caught.message.replace(/^.*?:\s*/, '')
    if (/Failed to fetch|NetworkError|load failed/i.test(message)) return 'CORS/网络不可达'
    return message || '无法访问'
  }
  return '无法访问'
}

function remember(channel: Channel, result: SourceProbe): SourceProbe {
  channelProbes[channelKey(channel)] = result
  return result
}

export async function probeLiveChannel(
  channel: Channel,
  lineIndex = 0
): Promise<SourceProbe> {
  const urls = channel.urls?.length ? channel.urls : [channel.url]
  const raw = urls[Math.min(Math.max(0, lineIndex), urls.length - 1)] || ''
  const target = mediaUrl(raw)
  if (!target) return remember(channel, { ok: false, ms: 0, detail: '没有播放地址' })
  const started = performance.now()
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT)
  try {
    // 只取头部一小段，m3u8 能拿到播放列表、ts/mp4 不会整段下载
    const response = await fetch(target, {
      method: 'GET',
      headers: { accept: '*/*', range: 'bytes=0-16383' },
      referrerPolicy: 'no-referrer',
      signal: controller.signal
    })
    const ms = Math.round(performance.now() - started)
    if (!response.ok) {
      return remember(channel, { ok: false, ms, detail: `HTTP ${response.status}` })
    }
    return remember(channel, {
      ok: true,
      ms,
      detail: ms > SLOW_MS ? '可连通，但延迟偏高' : '可连通'
    })
  } catch (caught) {
    return remember(channel, {
      ok: false,
      ms: Math.round(performance.now() - started),
      detail: channelProbeError(caught)
    })
  } finally {
    window.clearTimeout(timer)
  }
}

export async function probeChannelGroup(
  sourceId: string,
  groupName: string,
  channels: Channel[]
): Promise<void> {
  if (channelProbeState.running || !channels.length) return
  const picked = channels.slice(0, PROBE_LIMIT)
  Object.assign(channelProbeState, {
    running: true,
    group: groupName,
    done: 0,
    total: picked.length,
    ok: 0
  })
  try {
    const source = await probeLiveSource(sourceId)
    // 源级探测依赖内置/自定义源表，NAS 模式下源不在表里时会报「源不存在」，此时跳过预检直接查频道
    if (!source.ok && source.detail !== '源不存在') {
      for (const channel of picked) {
        remember(channel, { ok: false, ms: 0, detail: `直播源不可用：${source.detail}` })
      }
      channelProbeState.done = picked.length
      return
    }
    const queue = [...picked]
    const worker = async () => {
      while (queue.length) {
        const channel = queue.shift() as Channel
        const result = await probeLiveChannel(channel)
        channelProbeState.done += 1
        if (result.ok) channelProbeState.ok += 1
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length) }, worker)
    )
  } finally {
    channelProbeState.running = false
  }
}

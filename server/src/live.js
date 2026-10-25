import { parsePlaylist, sanitizeChannels, groupChannels } from '@kaytv/shared'
import { cached, invalidate } from './cache.js'
import { fetchUpstream, hashId, httpError } from './util.js'
import { signUrl } from './proxy.js'

const LIVE_TTL = 5 * 60 * 1000
const PREFERRED_GROUPS = ['央视频道', '央视', '卫视频道', '卫视', '地方频道', '港澳台', '影视', '少儿', '体育', '新闻']

function groupRank(name) {
  const cleaned = name.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\s]+/u, '').trim()
  const index = PREFERRED_GROUPS.findIndex((item) => cleaned.includes(item))
  return index === -1 ? PREFERRED_GROUPS.length : index
}

export async function fetchLiveChannels(source) {
  let response
  try {
    response = await fetchUpstream(source.url, { headers: source.headers, timeout: 22000 })
  } catch {
    throw httpError(502, '直播源无法访问，请检查地址或网络')
  }
  if (!response.ok) throw httpError(502, `直播源返回 HTTP ${response.status}`)
  const text = await response.text()
  if (text.length > 8 * 1024 * 1024) throw httpError(502, '直播列表过大')
  const channels = sanitizeChannels(parsePlaylist(text, source.type || 'auto'))
  if (!channels.length) throw httpError(502, '没有解析到有效频道')
  const groups = groupChannels(channels).sort((a, b) => {
    const diff = groupRank(a.name) - groupRank(b.name)
    return diff !== 0 ? diff : b.count - a.count
  })
  return { channels, groups }
}

export async function getLive(config, sourceId, { fresh = false } = {}) {
  const source = config.liveSources.find((item) => item.id === sourceId)
  if (!source) throw httpError(404, '直播源不存在')
  if (!source.enabled) throw httpError(403, '直播源已停用')
  if (fresh) invalidate(`live:${source.id}`)

  return cached(`live:${source.id}`, LIVE_TTL, async () => {
    const { channels, groups } = await fetchLiveChannels(source)
    const items = channels.map((channel) => {
      const urls = (channel.urls?.length ? channel.urls : [channel.url]).map((url) =>
        signUrl(source.id, url)
      )
      return {
        id: hashId(`${source.id}|${channel.name}|${channel.url}`).slice(0, 12),
        name: channel.name,
        group: channel.group,
        logo: channel.logo ? signUrl(source.id, channel.logo) : '',
        url: urls[0],
        urls
      }
    })
    const groupCounts = new Map(groups.map((group) => [group.name, group.count]))
    return {
      sourceId: source.id,
      sourceName: source.name,
      groups: groups.map((group) => ({ ...group, count: groupCounts.get(group.name) })),
      channels: items,
      count: items.length,
      updatedAt: Date.now()
    }
  })
}

import type { Channel } from '../types'

const KEY_SEPARATOR = '\u001F'

export const FAVORITE_GROUP = '★ 收藏'
export const RECENT_GROUP = '最近看过'
export const ALL_GROUP = '全部'
export const FOUR_K_GROUP = '4K 超清'

// 频道 id 是按名称+地址哈希出来的，源站换地址就会变，所以收藏/最近看过用 name+group 作稳定标识
export function channelKey(channel: Pick<Channel, 'name' | 'group'>): string {
  return `${channel.name}${KEY_SEPARATOR}${channel.group}`
}

export function isVirtualGroup(name: string): boolean {
  return name === FAVORITE_GROUP || name === RECENT_GROUP
}

export function joinChannels(keys: string[], channels: Channel[]): Channel[] {
  const byKey = new Map<string, Channel>()
  for (const channel of channels) {
    const key = channelKey(channel)
    if (!byKey.has(key)) byKey.set(key, channel)
  }
  const picked: Channel[] = []
  const seen = new Set<string>()
  for (const key of keys) {
    const channel = byKey.get(key)
    if (!channel || seen.has(key)) continue
    seen.add(key)
    picked.push(channel)
  }
  return picked
}

export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element) return false
  const tag = element.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable
}

export function digitFromKey(event: KeyboardEvent): number | null {
  const fromCode = /^(?:Digit|Numpad)([0-9])$/.exec(event.code || '')
  if (fromCode) return Number(fromCode[1])
  if (/^[0-9]$/.test(event.key)) return Number(event.key)
  return null
}

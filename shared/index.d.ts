export interface LiveSource {
  id: string
  name: string
  url: string
  type?: 'auto' | 'm3u' | 'txt'
  enabled: boolean
  note?: string
  headers?: Record<string, string>
  managedBy?: string
}

export interface VodSource {
  id: string
  name: string
  api: string
  type?: 'maccms' | 'kanju'
  enabled: boolean
  note?: string
  searchable?: boolean
  headers?: Record<string, string>
  managedBy?: string
}

export interface Subscription {
  id: string
  name: string
  url: string
  enabled: boolean
  note?: string
  lastSyncAt?: number
  lastError?: string
  vodCount?: number
  liveCount?: number
}

export interface AccessConfig {
  mode: 'public' | 'login'
}

export interface PlaylistItem {
  name: string
  url: string
  urls?: string[]
  group: string
  logo: string
}

export interface SiteConfig {
  version: number
  siteName: string
  access: AccessConfig
  autoCheck: boolean
  liveSources: LiveSource[]
  vodSources: VodSource[]
  subscriptions: Subscription[]
}

export declare const BUILTIN_LIVE: LiveSource[]
export declare const BUILTIN_VOD: VodSource[]
export declare const BUILTIN_SUBSCRIPTIONS: Subscription[]
export declare function parsePlaylist(text: string, type?: 'auto' | 'm3u' | 'txt'): PlaylistItem[]
export declare function sanitizeChannels(list: PlaylistItem[]): PlaylistItem[]
export declare function groupChannels(channels: PlaylistItem[]): { name: string; count: number }[]
export declare function searchRelevance(name: string, query: string): number
export declare const CONTENT_TYPE_NAMES: Record<string, string>
export declare function contentTypeOf(typeName: string): string
export declare function contentTypeName(type: string): string
export declare function isAdultContent(text: string): boolean
export declare function defaultConfig(): SiteConfig

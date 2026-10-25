export interface SourceMeta {
  id: string
  name: string
  type?: string
  note?: string
  enabled: boolean
  searchable?: boolean
}

export interface Channel {
  id: string
  name: string
  group: string
  logo: string
  url: string
  urls?: string[]
}

export interface LiveGroup {
  name: string
  count: number
}

export interface LiveData {
  sourceId: string
  sourceName: string
  groups: LiveGroup[]
  channels: Channel[]
  count: number
  updatedAt: number
}

export interface PosterItem {
  sourceId: string
  sourceName: string
  id: string
  name: string
  pic: string
  remarks: string
  year?: string
  typeName?: string
  contentType?: string
}

export interface VodItem extends PosterItem {
  year: string
  typeName: string
  area: string
  score: string
  time: number
  contentType?: string
}

export interface Episode {
  name: string
  url: string
}

export interface PlayLine {
  name: string
  episodes: Episode[]
  official?: boolean
  key?: string
}

export interface VodDetail extends VodItem {
  content: string
  director: string
  actors: string
  lines: PlayLine[]
  playable: boolean
}

export interface VodListResult {
  sourceId: string
  items: VodItem[]
  page: number
  pageCount: number
  total: number
}

export interface SearchResult {
  query: string
  items: VodItem[]
  errors: { sourceId: string; message: string }[]
  took: number
}

export interface Category {
  id: string
  name: string
}

export interface PublicConfig {
  siteName: string
  accessMode: 'public' | 'login'
  liveSources: SourceMeta[]
  vodSources: SourceMeta[]
  server: boolean
  version: number
}

export interface FeedResult {
  items: VodItem[]
  page: number
  pageCount: number
  total: number
  sources: number
  errors: { sourceId: string; message: string }[]
}

export interface TaxonomyItem {
  id: string
  name: string
  sources: number
}

export interface Taxonomy {
  content: TaxonomyItem[]
  regions: TaxonomyItem[]
  contentSources?: Record<string, string[]>
  shortDramaSources: string[]
}

export interface AuthUser {
  username: string
  displayName: string
  role: 'admin' | 'viewer'
}

export interface AdminUser extends AuthUser {
  id: string
  enabled: boolean
  builtin?: boolean
  createdAt: string
  lastLoginAt: number
}

export interface SourceHealth {
  id: string
  kind: 'live' | 'vod'
  name: string
  ok: boolean
  skipped?: boolean
  latency: number
  checkedAt: number
  detail: string
  channels?: number
  groups?: number
  categories?: number
  traits?: { shortDrama?: boolean; variety?: boolean }
}

export interface HealthReport {
  updatedAt: number
  nextRunAt: number
  checked: number
  enabled: number
  healthy: number
  items: SourceHealth[]
}

export interface Subscription {
  id: string
  name: string
  url: string
  enabled: boolean
  note: string
  lastSyncAt: number
  lastError: string
  vodCount: number
  liveCount: number
}

export interface HealthInfo {
  ok: boolean
  siteName: string
  time: number
  liveSources: number
  vodSources: number
}

export interface FavoriteItem extends PosterItem {
  addedAt: number
}

export interface HistoryEntry {
  sourceId: string
  sourceName: string
  id: string
  name: string
  pic: string
  remarks: string
  lineIndex: number
  episodeIndex: number
  episodeName: string
  position: number
  duration: number
  updatedAt: number
}

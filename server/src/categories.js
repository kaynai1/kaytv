import { cached } from './cache.js'
import { contentTypeOf } from '@kaytv/shared'
import { getCategories, getVodList } from './vod.js'
import { mapLimit } from './util.js'

const INDEX_TTL = 30 * 60 * 1000
const FEED_TTL = 2 * 60 * 1000
const MAX_PAGE = 8

export const CONTENT_TYPES = [
  { id: 'movie', name: '电影' },
  { id: 'tv', name: '电视剧' },
  { id: 'variety', name: '综艺' },
  { id: 'short', name: '红果短剧' },
  { id: 'anime', name: '动漫' },
  { id: 'documentary', name: '纪录片' }
]

export const REGIONS = [
  { id: 'cn', name: '中国' },
  { id: 'us', name: '美国' },
  { id: 'jpkr', name: '日韩' },
  { id: 'hk', name: '港台' },
  { id: 'tw', name: '台湾' },
  { id: 'other', name: '其他' }
]

function regionOf(name) {
  if (/国产|大陆|内地|中国|华语/.test(name)) return 'cn'
  if (/美国|美剧|欧美|西方/.test(name)) return 'us'
  if (/日本|日剧|日韩|韩国|韩剧|马泰|泰国/.test(name)) return 'jpkr'
  if (/香港|港剧|港台|邵氏/.test(name)) return 'hk'
  if (/台湾|台剧/.test(name)) return 'tw'
  if (/海外|其他/.test(name)) return 'other'
  return 'all'
}

export function classifyCategory(name) {
  const clean = String(name || '').replace(/\s+/g, '')
  return { content: contentTypeOf(clean) || 'other', region: regionOf(clean) }
}

export function matchRegion(area, region) {
  if (!region || region === 'all') return true
  const text = String(area || '')
  if (!text) return false
  return regionOf(text) === region
}

async function buildIndex(config, sources) {
  const entries = await mapLimit(sources, 5, async (source) => {
    try {
      const categories = await getCategories(config, source.id)
      return {
        sourceId: source.id,
        categories: categories.map((item) => ({ ...item, ...classifyCategory(item.name) }))
      }
    } catch {
      return { sourceId: source.id, categories: [] }
    }
  })
  const index = new Map(entries.map((item) => [item.sourceId, item.categories]))
  return index
}

async function getIndex(config, sources) {
  const sourceIds = sources.map((item) => item.id).sort()
  const key = `taxonomy:${sourceIds.join(',')}`
  return cached(key, INDEX_TTL, () => buildIndex(config, sources))
}

function normalizeTitle(name) {
  return String(name || '')
    .replace(/\[[^\]]*\]|【[^】]*】|\([^)]*\)|（[^）]*）/g, '')
    .replace(/[\s·:：,，。.、!！?？-]/g, '')
    .toLowerCase()
}

function mergeFeed(results) {
  const seen = new Map()
  for (const result of results) {
    for (const item of result.items) {
      const key = `${normalizeTitle(item.name)}|${String(item.year || '').slice(0, 4)}`
      const tagged = {
        ...item,
        contentType: contentTypeOf(item.typeName) || result.content || ''
      }
      const existing = seen.get(key)
      if (!existing) {
        seen.set(key, tagged)
        continue
      }
      if (Number(item.score) > Number(existing.score)) seen.set(key, tagged)
    }
  }
  return [...seen.values()].sort((a, b) => (b.time || 0) - (a.time || 0))
}

export async function getVodFeed(
  config,
  { content = '', region = 'all', sourceId = '', page = 1, excludeIds = null } = {}
) {
  const safePage = Math.max(1, Math.min(Number(page) || 1, MAX_PAGE))
  const excluded = excludeIds instanceof Set ? excludeIds : new Set()
  const sources = config.vodSources.filter(
    (item) => item.enabled && !excluded.has(item.id) && (!sourceId || item.id === sourceId)
  )
  if (!sources.length) {
    return { items: [], page: safePage, pageCount: 1, total: 0, sources: 0, errors: [] }
  }
  const contentId = CONTENT_TYPES.some((item) => item.id === content) ? content : ''
  const regionId = REGIONS.some((item) => item.id === region) ? region : 'all'
  const key = `feed:${sourceId || 'all'}:${contentId || 'latest'}:${regionId}:${safePage}`
  return cached(key, FEED_TTL, async () => {
    let index = new Map()
    if (contentId || regionId !== 'all') {
      index = await getIndex(config, sources)
    }

    const jobs = []
    for (const source of sources) {
      if (source.type === 'kanju') {
        jobs.push({
          source,
          type: contentId,
          area: regionId !== 'all' ? regionId : '',
          content: contentId
        })
        continue
      }
      if (!contentId && regionId === 'all') {
        jobs.push({ source, type: '', area: '', content: '' })
        continue
      }
      const categories = index.get(source.id) || []
      if (contentId === 'movie' && regionId !== 'all') {
        const movie = categories.find((item) => item.content === 'movie' && item.region === 'all') ||
          categories.find((item) => item.content === 'movie')
        if (movie) jobs.push({ source, type: movie.id, area: regionId, content: 'movie' })
        continue
      }
      const matches = categories.filter(
        (item) =>
          (!contentId || item.content === contentId) &&
          (regionId === 'all' || item.region === regionId)
      )
      let chosen = matches.find((item) => item.content === contentId) || matches[0]
      let area = ''
      if (!chosen && contentId && regionId !== 'all') {
        chosen = categories.find((item) => item.content === contentId && item.region === 'all')
        area = regionId
      }
      if (chosen) jobs.push({ source, type: chosen.id, area, content: chosen.content })
    }

    const results = await mapLimit(jobs, 5, async (job) => {
      try {
        const result = await getVodList(config, job.source.id, {
          page: safePage,
          type: job.type,
          area: job.area
        })
        const items = job.area
          ? result.items.filter((item) => matchRegion(item.area, job.area))
          : result.items
        return {
          sourceId: job.source.id,
          items,
          content: job.content,
          pageCount: job.area ? safePage + 1 : Math.max(1, result.pageCount || 1),
          error: null
        }
      } catch (error) {
        return {
          sourceId: job.source.id,
          items: [],
          content: job.content,
          pageCount: 1,
          error: error.message
        }
      }
    })

    const items = mergeFeed(results)
    const pageCount = Math.min(
      MAX_PAGE,
      Math.max(1, ...results.map((item) => item.pageCount || 1))
    )
    return {
      items,
      page: safePage,
      pageCount,
      total: items.length,
      sources: results.filter((item) => !item.error).length,
      errors: results
        .filter((item) => item.error)
        .map((item) => ({ sourceId: item.sourceId, message: item.error }))
    }
  })
}

export async function getTaxonomy(config) {
  const sources = config.vodSources.filter((item) => item.enabled)
  const key = `taxonomy:meta:${sources.map((item) => item.id).sort().join(',')}`
  return cached(key, INDEX_TTL, async () => {
    const index = await getIndex(config, sources)
    const content = new Map(CONTENT_TYPES.map((item) => [item.id, 0]))
    const regions = new Map(REGIONS.map((item) => [item.id, 0]))
    for (const categories of index.values()) {
      const seenContent = new Set()
      const seenRegion = new Set()
      for (const item of categories) {
        if (item.content !== 'other' && !seenContent.has(item.content)) {
          seenContent.add(item.content)
          content.set(item.content, (content.get(item.content) || 0) + 1)
        }
        if (item.region !== 'all' && !seenRegion.has(item.region)) {
          seenRegion.add(item.region)
          regions.set(item.region, (regions.get(item.region) || 0) + 1)
        }
      }
    }
    const contentSources = Object.fromEntries(CONTENT_TYPES.map((item) => [item.id, []]))
    for (const [sourceId, categories] of index.entries()) {
      for (const type of CONTENT_TYPES) {
        if (categories.some((item) => item.content === type.id)) {
          contentSources[type.id].push(sourceId)
        }
      }
    }
    return {
      content: CONTENT_TYPES.map((item) => ({ ...item, sources: content.get(item.id) || 0 })),
      regions: REGIONS.map((item) => ({ ...item, sources: regions.get(item.id) || 0 })),
      contentSources,
      shortDramaSources: contentSources.short || []
    }
  })
}

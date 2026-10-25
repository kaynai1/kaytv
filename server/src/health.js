import fs from 'node:fs'
import { dataFile } from './paths.js'
import { fetchLiveChannels } from './live.js'
import { testVodSource } from './vod.js'
import { mapLimit } from './util.js'

const statusPath = dataFile('source-status.json')
const CHECK_CONCURRENCY = 4
const CHECK_HOUR = Number(process.env.AUTO_CHECK_HOUR) || 4
const CHECK_MINUTE = Number(process.env.AUTO_CHECK_MINUTE) || 10

let memory = null
let running = null
let timer = null

function readStatusFile() {
  if (memory) return memory
  try {
    const raw = JSON.parse(fs.readFileSync(statusPath, 'utf8'))
    memory = {
      updatedAt: Number(raw.updatedAt) || 0,
      items: raw.items && typeof raw.items === 'object' ? raw.items : {},
      nextRunAt: Number(raw.nextRunAt) || 0
    }
  } catch {
    memory = { updatedAt: 0, items: {}, nextRunAt: 0 }
  }
  return memory
}

function writeStatus() {
  const tmp = `${statusPath}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(memory, null, 2))
  fs.renameSync(tmp, statusPath)
}

function nextRunTime(from = Date.now()) {
  const next = new Date(from)
  next.setHours(CHECK_HOUR, CHECK_MINUTE, 0, 0)
  if (next.getTime() <= from) next.setDate(next.getDate() + 1)
  return next.getTime()
}

function updateNextRun() {
  const status = readStatusFile()
  status.nextRunAt = nextRunTime()
  writeStatus()
}

async function checkOne(source, kind) {
  const started = Date.now()
  const base = {
    id: source.id,
    kind,
    name: source.name,
    checkedAt: Date.now(),
    latency: 0,
    ok: false,
    detail: '',
    traits: {}
  }
  try {
    if (kind === 'live') {
      const { channels, groups } = await fetchLiveChannels(source)
      return {
        ...base,
        ok: true,
        latency: Date.now() - started,
        detail: `${channels.length} 个频道 · ${groups.length} 个分组`,
        channels: channels.length,
        groups: groups.length
      }
    }
    const result = await testVodSource(source)
    const categories = result.categories || []
    return {
      ...base,
      ok: true,
      latency: Date.now() - started,
      detail: `${result.categoryCount} 个分类 · ${categories.slice(0, 3).join(' / ')}`,
      categories: result.categoryCount,
      categoryNames: categories,
      sample: result.sample,
      traits: {
        shortDrama: categories.some((name) => /短剧|爽剧|漫剧/.test(name)),
        variety: categories.some((name) => /综艺/.test(name))
      }
    }
  } catch (error) {
    return {
      ...base,
      latency: Date.now() - started,
      detail: error?.message || '检测失败'
    }
  }
}

export async function checkAllSources(config) {
  if (running) return running
  running = (async () => {
    const status = readStatusFile()
    const jobs = [
      ...config.liveSources.map((source) => ({ source, kind: 'live' })),
      ...config.vodSources.map((source) => ({ source, kind: 'vod' }))
    ]
    const results = await mapLimit(jobs, CHECK_CONCURRENCY, async ({ source, kind }) => {
      if (!source.enabled) {
        return {
          id: source.id,
          kind,
          name: source.name,
          ok: false,
          skipped: true,
          latency: 0,
          checkedAt: Date.now(),
          detail: '已停用，未检测',
          traits: {}
        }
      }
      return checkOne(source, kind)
    })
    const items = {}
    for (const item of results) items[`${item.kind}:${item.id}`] = item
    memory = { updatedAt: Date.now(), items, nextRunAt: nextRunTime() }
    writeStatus()
    return { updatedAt: memory.updatedAt, nextRunAt: memory.nextRunAt, items: results }
  })()
  try {
    return await running
  } finally {
    running = null
  }
}

export function getHealthStatus(config = null) {
  const status = readStatusFile()
  let items = Object.values(status.items)
  if (config) {
    const liveIds = new Set(config.liveSources.map((item) => `live:${item.id}`))
    const vodIds = new Set(config.vodSources.map((item) => `vod:${item.id}`))
    items = items.filter((item) => liveIds.has(`${item.kind}:${item.id}`) || vodIds.has(`${item.kind}:${item.id}`))
  }
  const enabled = config
    ? [...config.liveSources, ...config.vodSources].filter((item) => item.enabled).length
    : items.length
  return {
    updatedAt: status.updatedAt,
    nextRunAt: status.nextRunAt,
    checked: items.filter((item) => !item.skipped).length,
    enabled,
    healthy: items.filter((item) => item.ok).length,
    items
  }
}

export function recordSourceCheck(result) {
  if (!result?.id || !result?.kind) return
  const status = readStatusFile()
  status.items[`${result.kind}:${result.id}`] = { ...result, checkedAt: Date.now() }
  if (!status.updatedAt) status.updatedAt = Date.now()
  writeStatus()
}

export function startDailyCheck(getConfig, { onBeforeCheck } = {}) {
  const run = async () => {
    const config = getConfig()
    if (config.autoCheck !== false) {
      try {
        if (onBeforeCheck) await onBeforeCheck(config)
        console.log('[health] 开始每日源检测')
        const result = await checkAllSources(getConfig())
        console.log(`[health] 检测完成：${result.items.filter((item) => item.ok).length}/${result.items.filter((item) => !item.skipped).length} 可用`)
      } catch (error) {
        console.error('[health] 每日检测失败:', error.message)
      }
    }
    schedule()
  }

  const schedule = () => {
    if (timer) clearTimeout(timer)
    updateNextRun()
    const delay = Math.max(60_000, nextRunTime() - Date.now())
    timer = setTimeout(run, delay)
    timer.unref?.()
  }

  const status = readStatusFile()
  const stale = !status.updatedAt || Date.now() - status.updatedAt > 24 * 3600 * 1000
  if (stale) {
    const warmup = setTimeout(() => {
      run().catch((error) => console.error('[health] 首次检测失败:', error.message))
    }, 45_000)
    warmup.unref?.()
  }
  schedule()
  return { stop: () => timer && clearTimeout(timer) }
}

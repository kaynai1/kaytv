import { cached } from './cache.js'
import { fetchUpstream, httpError } from './util.js'

const DIYP_BASE = 'http://epg.51zmt.top:8000/api/diyp/'
const CHANNEL_RE = /^[\w\u4e00-\u9fa5 -]{1,40}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function registerEpg(app) {
  app.get('/api/epg', async (req) => {
    const channel = String(req.query?.ch || '').trim()
    const date = String(req.query?.date || '').trim()
    if (!CHANNEL_RE.test(channel)) throw httpError(400, '频道名无效')
    if (!DATE_RE.test(date)) throw httpError(400, '日期格式应为 YYYY-MM-DD')
    const query = new URLSearchParams({ ch: channel, date }).toString()
    return cached(`epg:${channel}:${date}`, 10 * 60 * 1000, async () => {
      const response = await fetchUpstream(`${DIYP_BASE}?${query}`, { timeout: 12000 })
      if (!response.ok) throw httpError(502, `EPG 源返回 ${response.status}`)
      return await response.json()
    })
  })
}

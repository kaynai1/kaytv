/**
 * KayTV 定时源体检 Worker
 * 每 30 分钟分批调用云后台 /api/internal/health-sweep，直到所有启用源都检查过。
 * 部署：wrangler deploy，再 wrangler secret put CRON_TOKEN
 */

const MAX_ROUNDS = 12

async function sweep(env) {
  const base = String(env.HUB_URL || 'https://tv.9ky.us.ci').replace(/\/+$/, '')
  let checked = 0
  let failed = 0
  let alerts = 0
  let remaining = 0
  let since = 0
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const response = await fetch(`${base}/api/internal/health-sweep`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.CRON_TOKEN || ''}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ limit: 4, since })
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`体检接口返回 ${response.status}: ${text.slice(0, 160)}`)
    let data = {}
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(`体检接口响应不是 JSON：${text.slice(0, 160)}`)
    }
    since = Number(data.since) || since
    checked += Number(data.checked) || 0
    failed += Number(data.failed) || 0
    alerts += Number(data.alerts) || 0
    remaining = Number(data.remaining) || 0
    if (!remaining) break
  }
  return { checked, failed, alerts, remaining }
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      sweep(env)
        .then((result) => console.log('kaytv sweep', JSON.stringify(result)))
        .catch((error) => console.error('kaytv sweep failed', error?.message || error))
    )
  },
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname !== '/run') {
      return new Response('KayTV health sweep worker. POST /run with CRON_TOKEN to trigger.', { status: 200 })
    }
    const header = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim()
    if (!env.CRON_TOKEN || header !== env.CRON_TOKEN) return new Response('unauthorized', { status: 401 })
    try {
      const result = await sweep(env)
      return Response.json({ ok: true, ...result })
    } catch (error) {
      return Response.json({ ok: false, error: String(error?.message || error) }, { status: 500 })
    }
  }
}

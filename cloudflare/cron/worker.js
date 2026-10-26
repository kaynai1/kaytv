/**
 * KayTV 定时源体检 Worker
 * 每 30 分钟分批调用云后台 /api/internal/health-sweep，直到所有启用源都检查过。
 * 部署：wrangler deploy，再 wrangler secret put CRON_TOKEN
 */

const MAX_ROUNDS = 12
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function safeEqual(left, right) {
  const encoder = new TextEncoder()
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(String(left))),
    crypto.subtle.digest('SHA-256', encoder.encode(String(right)))
  ])
  const av = new Uint8Array(a)
  const bv = new Uint8Array(b)
  let diff = 0
  for (let index = 0; index < av.length; index += 1) diff |= av[index] ^ bv[index]
  return diff === 0
}

async function requestSweep(env, base, body) {
  let lastError = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await sleep(600 * attempt)
    let response
    try {
      response = await fetch(`${base}/api/internal/health-sweep`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.CRON_TOKEN || ''}`,
          'content-type': 'application/json'
        },
        body
      })
    } catch (error) {
      lastError = error
      continue
    }
    const text = await response.text()
    if (response.ok) return text
    const error = new Error(`体检接口返回 ${response.status}: ${text.slice(0, 160)}`)
    // 429/5xx 是暂时性故障，重试；4xx 直接失败，重试也没用
    if (response.status !== 429 && response.status < 500) throw error
    lastError = error
  }
  throw lastError || new Error('体检接口请求失败')
}

async function sweep(env) {
  const base = String(env.HUB_URL || 'https://tv.9ky.us.ci').replace(/\/+$/, '')
  let checked = 0
  let failed = 0
  let alerts = 0
  let remaining = 0
  let since = 0
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const text = await requestSweep(env, base, JSON.stringify({ limit: 4, since }))
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
    const expected = String(env.CRON_TOKEN || '')
    if (!expected || !header || !(await safeEqual(header, expected))) {
      return new Response('unauthorized', { status: 401 })
    }
    try {
      const result = await sweep(env)
      return Response.json({ ok: true, ...result })
    } catch (error) {
      return Response.json({ ok: false, error: String(error?.message || error) }, { status: 500 })
    }
  }
}

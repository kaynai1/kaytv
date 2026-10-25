import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { getSecret } from './secret.js'
import { getConfig, findSource } from './config.js'
import { fetchUpstream, isHttpUrl } from './util.js'

export function signValue(sourceId, url) {
  return crypto
    .createHmac('sha256', getSecret())
    .update(`${sourceId}\n${url}`)
    .digest('base64url')
    .slice(0, 24)
}

export function signUrl(sourceId, url) {
  if (!url) return ''
  const encoded = Buffer.from(url, 'utf8').toString('base64url')
  return `/api/p?src=${encodeURIComponent(sourceId)}&u=${encoded}&s=${signValue(sourceId, url)}`
}

export function verifySignature(sourceId, url, signature) {
  if (typeof signature !== 'string' || signature.length !== 24) return false
  const expected = signValue(sourceId, url)
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export function rewritePlaylist(text, baseUrl, sourceId) {
  const lines = text.split(/\r?\n/)
  const output = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) {
      output.push('')
      continue
    }
    if (line.startsWith('#')) {
      output.push(
        line.replace(/URI="([^"]+)"/g, (match, uri) => {
          try {
            return `URI="${signUrl(sourceId, new URL(uri, baseUrl).href)}"`
          } catch {
            return match
          }
        })
      )
      continue
    }
    try {
      output.push(signUrl(sourceId, new URL(line, baseUrl).href))
    } catch {
      output.push(line)
    }
  }
  return output.join('\n')
}

export function registerProxy(app) {
  app.get('/api/p', async (req, reply) => {
    const { src, u, s } = req.query || {}
    if (typeof src !== 'string' || typeof u !== 'string' || typeof s !== 'string') {
      return reply.code(400).send({ error: 'bad_request', message: '缺少代理参数' })
    }
    let target = ''
    try {
      target = Buffer.from(u, 'base64url').toString('utf8')
    } catch {
      return reply.code(400).send({ error: 'bad_url' })
    }
    if (!isHttpUrl(target)) return reply.code(400).send({ error: 'bad_url' })
    if (!verifySignature(src, target, s)) return reply.code(403).send({ error: 'bad_signature' })

    const config = getConfig()
    const source = findSource(config, src)
    if (!source) return reply.code(404).send({ error: 'source_missing', message: '源已被删除' })

    const headers = { ...(source.headers || {}) }
    if (req.headers.range) headers.range = req.headers.range
    if (req.headers['if-none-match']) headers['if-none-match'] = req.headers['if-none-match']
    if (req.headers['if-modified-since']) headers['if-modified-since'] = req.headers['if-modified-since']

    let upstream
    try {
      upstream = await fetchUpstream(target, { headers, timeout: 25000, redirect: 'follow' })
    } catch (error) {
      return reply.code(502).send({ error: 'upstream_unreachable', message: '上游地址无法访问' })
    }

    const finalUrl = upstream.url || target
    const contentType = upstream.headers.get('content-type') || ''
    const isPlaylist =
      /mpegurl/i.test(contentType) || /\.m3u8(?:$|[?#])/i.test(finalUrl) || /\.m3u8(?:$|[?#])/i.test(target)

    if (isPlaylist && upstream.ok) {
      const text = await upstream.text()
      if (text.length > 4 * 1024 * 1024) {
        return reply.code(502).send({ error: 'playlist_too_large' })
      }
      reply.header('content-type', 'application/vnd.apple.mpegurl; charset=utf-8')
      reply.header('cache-control', 'no-store')
      return reply.send(rewritePlaylist(text, finalUrl, src))
    }

    reply.code(upstream.status)
    const passThrough = [
      'content-type',
      'content-range',
      'accept-ranges',
      'etag',
      'last-modified',
      'content-length',
      'content-disposition'
    ]
    for (const name of passThrough) {
      const value = upstream.headers.get(name)
      if (value) reply.header(name, value)
    }
    const encoding = upstream.headers.get('content-encoding')
    if (encoding && encoding !== 'identity') {
      reply.removeHeader('content-encoding')
      reply.removeHeader('content-length')
    }
    const isImage = /^image\//i.test(contentType)
    reply.header('cache-control', isImage ? 'public, max-age=604800' : 'no-store')

    if (!upstream.body || upstream.status === 204 || upstream.status === 304) {
      return reply.send()
    }
    return reply.send(Readable.fromWeb(upstream.body))
  })
}

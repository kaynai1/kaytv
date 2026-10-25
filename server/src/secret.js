import crypto from 'node:crypto'
import fs from 'node:fs'
import { dataFile } from './paths.js'

let secret = ''

export function getSecret() {
  if (secret) return secret
  if (process.env.PROXY_SECRET) {
    secret = process.env.PROXY_SECRET
    return secret
  }
  const file = dataFile('secret.key')
  try {
    secret = fs.readFileSync(file, 'utf8').trim()
  } catch {
    secret = ''
  }
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex')
    fs.writeFileSync(file, secret, { mode: 0o600 })
  }
  return secret
}

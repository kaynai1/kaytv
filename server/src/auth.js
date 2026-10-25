import crypto from 'node:crypto'
import fs from 'node:fs'
import { dataFile } from './paths.js'

const adminPath = dataFile('admin.json')
const usersPath = dataFile('users.json')
const envPassword = String(process.env.ADMIN_PASSWORD || '')
const sessions = new Map()
const SESSION_TTL = 7 * 24 * 3600 * 1000
const USER_RE = /^[a-zA-Z0-9_.-]{2,32}$/

const SESSION_COOKIE = 'kaytv_session'

let cachedRecord = null
let cachedUsers = null

function scrypt(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex')
}

function safeEqual(a, b) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function readRecord() {
  if (cachedRecord) return cachedRecord
  try {
    cachedRecord = JSON.parse(fs.readFileSync(adminPath, 'utf8'))
  } catch {
    cachedRecord = null
  }
  return cachedRecord
}

function makePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  return Array.from(crypto.randomBytes(10), (byte) => alphabet[byte % alphabet.length]).join('')
}

function readUsers() {
  if (cachedUsers) return cachedUsers
  try {
    const raw = JSON.parse(fs.readFileSync(usersPath, 'utf8'))
    cachedUsers = Array.isArray(raw) ? raw : []
  } catch {
    cachedUsers = []
  }
  return cachedUsers
}

function writeUsers(users) {
  const tmp = `${usersPath}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, usersPath)
  cachedUsers = users
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName || user.username,
    role: user.role,
    enabled: user.enabled !== false,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt || 0
  }
}

export function ensureAdmin() {
  if (envPassword) return { source: 'env' }
  const record = readRecord()
  if (record?.salt && record?.hash) return { source: 'file' }
  const password = makePassword()
  const salt = crypto.randomBytes(16).toString('hex')
  const next = { salt, hash: scrypt(password, salt), createdAt: new Date().toISOString() }
  fs.writeFileSync(adminPath, JSON.stringify(next, null, 2), { mode: 0o600 })
  cachedRecord = next
  console.log('\n' + '='.repeat(52))
  console.log('  KayTV 管理后台初始密码:', password)
  console.log('  管理员账号: admin')
  console.log('  管理地址: http://<NAS地址>:' + (process.env.PORT || 8080) + '/admin')
  console.log('  可用环境变量 ADMIN_PASSWORD 覆盖，删除 data/admin.json 可重置')
  console.log('='.repeat(52) + '\n')
  return { source: 'generated', password }
}

export function verifyPassword(input) {
  if (typeof input !== 'string' || !input || input.length > 200) return false
  const salt = 'kaytv-fixed-salt'
  if (envPassword) {
    return safeEqual(scrypt(input, salt), scrypt(envPassword, salt))
  }
  const record = readRecord()
  if (!record?.salt || !record?.hash) return false
  return safeEqual(scrypt(input, record.salt), record.hash)
}

export function changePassword(nextPassword) {
  if (envPassword) {
    throw Object.assign(new Error('已通过 ADMIN_PASSWORD 环境变量固定密码，请修改环境变量后重启'), {
      statusCode: 400
    })
  }
  if (typeof nextPassword !== 'string' || nextPassword.length < 6 || nextPassword.length > 100) {
    throw Object.assign(new Error('新密码至少 6 位'), { statusCode: 400 })
  }
  const salt = crypto.randomBytes(16).toString('hex')
  const next = { salt, hash: scrypt(nextPassword, salt), createdAt: new Date().toISOString() }
  fs.writeFileSync(adminPath, JSON.stringify(next, null, 2), { mode: 0o600 })
  cachedRecord = next
  clearUserSessions('admin')
}

export function verifyCredentials(username, password) {
  const name = String(username || 'admin').trim().toLowerCase()
  if (typeof password !== 'string' || !password || password.length > 200) return null
  if (name === 'admin') {
    if (!verifyPassword(password)) return null
    return { username: 'admin', role: 'admin', displayName: '管理员' }
  }
  const user = readUsers().find((item) => String(item.username).toLowerCase() === name)
  if (!user || user.enabled === false || !user.salt || !user.hash) return null
  if (!safeEqual(scrypt(password, user.salt), user.hash)) return null
  user.lastLoginAt = Date.now()
  writeUsers(readUsers())
  return { username: user.username, role: user.role || 'viewer', displayName: user.displayName || user.username }
}

export function createSession(identity) {
  const token = crypto.randomBytes(24).toString('base64url')
  sessions.set(token, {
    expires: Date.now() + SESSION_TTL,
    username: identity.username,
    role: identity.role,
    displayName: identity.displayName || identity.username
  })
  return { token, maxAge: Math.floor(SESSION_TTL / 1000) }
}

export function destroySession(token) {
  if (token) sessions.delete(token)
}

export function clearUserSessions(username) {
  for (const [token, session] of sessions) {
    if (session.username === username) sessions.delete(token)
  }
}

export function readCookie(req, name) {
  const raw = req.headers.cookie
  if (!raw) return ''
  for (const part of raw.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim())
  }
  return ''
}

export function sessionInfo(req) {
  const bearer = String(req.headers.authorization || '')
  const token = bearer.startsWith('Bearer ') ? bearer.slice(7).trim() : readCookie(req, SESSION_COOKIE)
  if (!token) return null
  const session = sessions.get(token)
  if (!session) return null
  if (session.expires < Date.now()) {
    sessions.delete(token)
    return null
  }
  return { token, ...session }
}

export function isAuthed(req) {
  return Boolean(sessionInfo(req))
}

export function requiresAdmin(req, reply) {
  const session = sessionInfo(req)
  if (session?.role === 'admin') return true
  reply.code(session ? 403 : 401).send({
    error: session ? 'forbidden' : 'unauthorized',
    message: session ? '该账号没有管理权限' : '请先登录'
  })
  return false
}

export function requiresUser(req, reply) {
  if (sessionInfo(req)) return true
  reply.code(401).send({ error: 'unauthorized', message: '请先登录' })
  return false
}

export function listUsers() {
  const virtualAdmin = {
    id: 'admin',
    username: 'admin',
    displayName: '主管理员',
    role: 'admin',
    enabled: true,
    builtin: true,
    createdAt: readRecord()?.createdAt || '',
    lastLoginAt: 0
  }
  return [virtualAdmin, ...readUsers().map(publicUser)]
}

function validateNewPassword(password) {
  if (typeof password !== 'string' || password.length < 6 || password.length > 100) {
    throw Object.assign(new Error('密码至少 6 位'), { statusCode: 400 })
  }
}

export function createUser(input) {
  const username = String(input?.username || '').trim()
  const password = String(input?.password || '')
  const role = input?.role === 'admin' ? 'admin' : 'viewer'
  if (!USER_RE.test(username)) {
    throw Object.assign(new Error('账号需为 2-32 位字母、数字、下划线、点或横线'), { statusCode: 400 })
  }
  if (username.toLowerCase() === 'admin') {
    throw Object.assign(new Error('admin 为内置管理员账号'), { statusCode: 400 })
  }
  validateNewPassword(password)
  const users = readUsers()
  if (users.some((item) => String(item.username).toLowerCase() === username.toLowerCase())) {
    throw Object.assign(new Error('该账号已存在'), { statusCode: 400 })
  }
  const salt = crypto.randomBytes(16).toString('hex')
  const user = {
    id: crypto.randomBytes(6).toString('hex'),
    username,
    displayName: String(input?.displayName || username).trim().slice(0, 24) || username,
    role,
    enabled: true,
    salt,
    hash: scrypt(password, salt),
    createdAt: new Date().toISOString(),
    lastLoginAt: 0
  }
  writeUsers([...users, user])
  return publicUser(user)
}

export function updateUser(id, input) {
  const users = readUsers()
  const index = users.findIndex((item) => item.id === id)
  if (index < 0) throw Object.assign(new Error('用户不存在'), { statusCode: 404 })
  const user = users[index]
  if (input?.displayName !== undefined) {
    user.displayName = String(input.displayName).trim().slice(0, 24) || user.username
  }
  if (input?.role !== undefined) {
    const role = input.role === 'admin' ? 'admin' : 'viewer'
    if (user.role === 'admin' && role !== 'admin') {
      const admins = users.filter((item) => item.role === 'admin' && item.enabled !== false)
      if (admins.length <= 1) throw Object.assign(new Error('至少保留一个管理员'), { statusCode: 400 })
    }
    user.role = role
  }
  if (input?.enabled !== undefined) {
    if (user.role === 'admin' && input.enabled === false) {
      const admins = users.filter((item) => item.role === 'admin' && item.enabled !== false && item.id !== id)
      if (!admins.length) throw Object.assign(new Error('至少保留一个管理员'), { statusCode: 400 })
    }
    user.enabled = input.enabled !== false
  }
  if (input?.password !== undefined && String(input.password)) {
    validateNewPassword(String(input.password))
    user.salt = crypto.randomBytes(16).toString('hex')
    user.hash = scrypt(String(input.password), user.salt)
    clearUserSessions(user.username)
  }
  if (user.enabled === false) clearUserSessions(user.username)
  writeUsers(users)
  return publicUser(user)
}

export function deleteUser(id) {
  const users = readUsers()
  const index = users.findIndex((item) => item.id === id)
  if (index < 0) throw Object.assign(new Error('用户不存在'), { statusCode: 404 })
  const user = users[index]
  if (user.role === 'admin') {
    const admins = users.filter((item) => item.role === 'admin' && item.enabled !== false && item.id !== id)
    if (!admins.length) throw Object.assign(new Error('至少保留一个管理员'), { statusCode: 400 })
  }
  clearUserSessions(user.username)
  writeUsers(users.filter((item) => item.id !== id))
  return { ok: true }
}

setInterval(() => {
  const now = Date.now()
  for (const [token, session] of sessions) if (session.expires < now) sessions.delete(token)
}, 3600_000).unref()

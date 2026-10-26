const TOKEN_KEY = 'kaytv.hub.token.v1'
const KIND_LABEL = { vod: '影视源', live: '直播源', tvbox: 'TVBox' }
const LEVEL_LABEL = { info: '普通', warning: '提醒', critical: '重要' }
const STATUS_LABEL = { pending: '待审核', active: '正常', blocked: '已停用' }

const el = (id) => document.getElementById(id)
let token = localStorage.getItem(TOKEN_KEY) || ''
let state = {
  overview: null,
  sources: [],
  announcements: [],
  users: [],
  settings: null,
  editingSource: '',
  editingAnnouncement: ''
}
let toastTimer = 0

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
  })
}

function fmtTime(ms, fallback = '—') {
  if (!ms) return fallback
  const date = new Date(Number(ms))
  if (Number.isNaN(date.getTime())) return fallback
  return date.toLocaleString('zh-CN', { hour12: false })
}

function fmtDateInput(ms) {
  if (!ms) return ''
  const date = new Date(Number(ms))
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function toast(message, bad = false) {
  const node = el('toast')
  node.textContent = message
  node.classList.toggle('bad', bad)
  node.classList.add('show')
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => node.classList.remove('show'), 2600)
}

async function api(path, options = {}) {
  const headers = {
    'content-type': 'application/json',
    ...(options.headers || {})
  }
  if (token) headers.authorization = `Bearer ${token}`
  let response
  try {
    response = await fetch(`/api${path}`, { ...options, headers })
  } catch (error) {
    throw new Error(`网络错误：${error?.message || error}`)
  }
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    if (response.status === 401 && path.startsWith('/admin')) {
      showLogin('管理员口令已失效，请重新输入')
    }
    throw new Error(data.error || `HTTP ${response.status}`)
  }
  return data
}

function showLogin(message = '') {
  el('app').classList.add('hidden')
  el('login').classList.remove('hidden')
  el('login-error').textContent = message
  el('token-input').value = ''
  el('token-input').focus()
}

function showApp() {
  el('login').classList.add('hidden')
  el('app').classList.remove('hidden')
  el('hub-url').textContent = location.origin
  el('config-url').textContent = `${location.origin}/api/config`
}

async function login(candidate) {
  const value = String(candidate || '').trim()
  if (!value) {
    el('login-error').textContent = '请输入管理员口令'
    return
  }
  token = value
  try {
    await api('/admin/overview')
    localStorage.setItem(TOKEN_KEY, value)
    showApp()
    await loadAll()
    toast('已进入云后台')
  } catch (error) {
    token = ''
    localStorage.removeItem(TOKEN_KEY)
    el('login-error').textContent = error.message
  }
}

function logout() {
  token = ''
  localStorage.removeItem(TOKEN_KEY)
  state = { ...state, overview: null, sources: [], announcements: [], users: [] }
  showLogin('')
}

async function loadAll() {
  try {
    const [overview, sources, announcements, users, settings] = await Promise.all([
      api('/admin/overview'),
      api('/admin/sources'),
      api('/admin/announcements'),
      api('/admin/users'),
      api('/admin/settings')
    ])
    state.overview = overview
    state.sources = sources.sources || []
    state.announcements = announcements.announcements || []
    state.users = users.users || []
    state.settings = settings.settings || null
    renderAll()
  } catch (error) {
    toast(error.message, true)
  }
}

function renderAll() {
  renderOverview()
  renderSources()
  renderAnnouncements()
  renderUsers()
  renderSettings()
}

/* ---------- 概览 ---------- */
function renderOverview() {
  const overview = state.overview
  if (!overview) return
  const cards = [
    { label: '影视源', value: overview.sources.vod || 0 },
    { label: '直播源', value: overview.sources.live || 0 },
    { label: 'TVBox 配置', value: overview.sources.tvbox || 0 },
    { label: '云账号', value: overview.users.active || 0 },
    { label: '待审核', value: overview.users.pending || 0, hot: overview.users.pending > 0 }
  ]
  el('overview-cards').innerHTML = cards
    .map(
      (card) => `<div class="stat${card.hot ? ' hot' : ''}">
        <b>${card.value}</b><span>${card.label}</span>
      </div>`
    )
    .join('')

  const recent = state.users.slice(0, 6)
  el('recent-users').innerHTML = recent.length
    ? recent
        .map(
          (user) => `<div class="row">
            <div class="row-main">
              <div class="row-title">${esc(user.username)}
                <span class="tag ${user.status === 'active' ? 'ok' : user.status === 'pending' ? 'warn' : 'bad'}">${STATUS_LABEL[user.status] || user.status}</span>
              </div>
              <div class="row-sub">注册于 ${fmtTime(user.created_at)} · 最近活跃 ${fmtTime(user.last_seen, '从未')}</div>
            </div>
          </div>`
        )
        .join('')
    : '<div class="empty">还没有用户注册。三端不登录也能正常看片，注册只用于收藏和进度云同步。</div>'
}

/* ---------- 源管理 ---------- */
function sourceRow(row) {
  const probe =
    row.probed_at > 0
      ? `<span class="tag ${row.probe_ok ? 'ok' : 'bad'}" title="${esc(row.probe_note || '')}">${row.probe_ok ? '可用' : '不可用'} · ${row.probe_ms || 0}ms</span>`
      : '<span class="tag">未检测</span>'
  return `<div class="row">
    <div class="row-main">
      <div class="row-title">
        ${esc(row.name)}
        <span class="tag ${row.kind === 'vod' ? 'accent' : ''}">${KIND_LABEL[row.kind] || row.kind}</span>
        ${row.enabled ? '' : '<span class="tag off">已停用</span>'}
        ${probe}
      </div>
      <div class="row-sub">${esc(row.url)}</div>
      <div class="row-sub">${row.note ? esc(row.note) + ' · ' : ''}排序 ${row.sort} · 更新 ${fmtTime(row.updated_at)}${row.probed_at ? ' · 检测 ' + fmtTime(row.probed_at) : ''}</div>
    </div>
    <div class="row-side">
      <label class="switch"><input type="checkbox" data-action="source-toggle" data-id="${row.id}" ${row.enabled ? 'checked' : ''} /> 启用</label>
      <button class="btn sm" data-action="source-probe" data-id="${row.id}" type="button">检测</button>
      <button class="btn sm" data-action="source-edit" data-id="${row.id}" type="button">编辑</button>
      <button class="btn sm danger" data-action="source-delete" data-id="${row.id}" type="button">删除</button>
    </div>
  </div>`
}

function renderSources() {
  const filter = el('source-filter').value
  const rows = state.sources.filter((row) => !filter || row.kind === filter)
  el('source-list').innerHTML = rows.length
    ? rows.map(sourceRow).join('')
    : '<div class="empty">还没有配置源。先添加一个影视源，三端同步后就能用它搜索播放。</div>'
}

function resetSourceForm() {
  state.editingSource = ''
  el('source-form-title').textContent = '添加源'
  el('source-reset').classList.add('hidden')
  el('source-kind').value = 'vod'
  el('source-name').value = ''
  el('source-url').value = ''
  el('source-type').value = ''
  el('source-sort').value = '100'
  el('source-note').value = ''
  el('source-enabled').checked = true
  el('source-error').textContent = ''
}

function editSource(id) {
  const row = state.sources.find((item) => item.id === id)
  if (!row) return
  state.editingSource = id
  el('source-form-title').textContent = `编辑「${row.name}」`
  el('source-reset').classList.remove('hidden')
  el('source-kind').value = row.kind
  el('source-name').value = row.name
  el('source-url').value = row.url
  el('source-type').value = row.type || ''
  el('source-sort').value = String(row.sort ?? 100)
  el('source-note').value = row.note || ''
  el('source-enabled').checked = Boolean(row.enabled)
  el('source-error').textContent = ''
  el('panel-sources').scrollIntoView({ behavior: 'smooth', block: 'start' })
}

async function submitSource(event) {
  event.preventDefault()
  const payload = {
    kind: el('source-kind').value,
    name: el('source-name').value.trim(),
    url: el('source-url').value.trim(),
    type: el('source-type').value.trim(),
    sort: Number(el('source-sort').value) || 100,
    note: el('source-note').value.trim(),
    enabled: el('source-enabled').checked
  }
  if (!payload.name || !payload.url) {
    el('source-error').textContent = '名称和接口地址都要填'
    return
  }
  try {
    if (state.editingSource) await api(`/admin/sources/${state.editingSource}`, { method: 'PUT', body: JSON.stringify(payload) })
    else await api('/admin/sources', { method: 'POST', body: JSON.stringify(payload) })
    toast(state.editingSource ? '源已更新' : '源已添加')
    resetSourceForm()
    await loadAll()
  } catch (error) {
    el('source-error').textContent = error.message
  }
}

async function toggleSource(id, enabled) {
  try {
    await api(`/admin/sources/${id}`, { method: 'PUT', body: JSON.stringify({ enabled }) })
    const row = state.sources.find((item) => item.id === id)
    if (row) row.enabled = enabled ? 1 : 0
    renderSources()
    toast(enabled ? '已启用，客户端下次同步生效' : '已停用')
  } catch (error) {
    toast(error.message, true)
    renderSources()
  }
}

async function probeSource(id, button) {
  button.disabled = true
  button.textContent = '检测中…'
  try {
    const result = await api(`/admin/sources/${id}/probe`, { method: 'POST' })
    toast(result.result.ok ? `可用 · ${result.result.ms}ms · ${result.result.note}` : `不可用：${result.result.note}`, !result.result.ok)
    await loadAll()
  } catch (error) {
    toast(error.message, true)
    button.disabled = false
    button.textContent = '检测'
  }
}

async function deleteSource(id) {
  const row = state.sources.find((item) => item.id === id)
  if (!row || !window.confirm(`确定删除「${row.name}」？三端同步后这个源会消失。`)) return
  try {
    await api(`/admin/sources/${id}`, { method: 'DELETE' })
    toast('源已删除')
    await loadAll()
  } catch (error) {
    toast(error.message, true)
  }
}

function splitBulkLine(line) {
  const value = line.trim()
  if (!value) return null
  const match = value.match(/^(.{1,40}?)[,，\t]\s*(https?:\/\/.+)$/i)
  if (match) return { name: match[1].trim(), url: match[2].trim() }
  try {
    return { name: new URL(value).hostname, url: value }
  } catch {
    return null
  }
}

async function bulkAdd() {
  const kind = el('bulk-kind').value
  const lines = el('bulk-text').value.split(/\r?\n/).map(splitBulkLine).filter(Boolean)
  if (!lines.length) {
    el('bulk-result').textContent = '没有识别到地址，每行一个 http(s) 链接'
    return
  }
  const button = el('bulk-add')
  button.disabled = true
  let added = 0
  let failed = 0
  for (const item of lines) {
    try {
      await api('/admin/sources', {
        method: 'POST',
        body: JSON.stringify({ kind, name: item.name, url: item.url, enabled: true })
      })
      added += 1
    } catch {
      failed += 1
    }
  }
  button.disabled = false
  el('bulk-result').textContent = `添加完成：成功 ${added} 个${failed ? `，失败 ${failed} 个` : ''}`
  if (added) {
    el('bulk-text').value = ''
    await loadAll()
  }
}

/* ---------- 公告 ---------- */
function annRow(row) {
  const active = row.active
    ? '<span class="tag ok">启用中</span>'
    : '<span class="tag off">未启用</span>'
  const schedule =
    row.starts_at || row.ends_at
      ? ` · ${row.starts_at ? '开始 ' + fmtTime(row.starts_at) : ''}${row.ends_at ? ' 结束 ' + fmtTime(row.ends_at) : ''}`
      : ''
  return `<div class="row">
    <div class="row-main">
      <div class="row-title">${esc(row.title)}
        <span class="tag ${row.level === 'critical' ? 'bad' : row.level === 'warning' ? 'warn' : ''}">${LEVEL_LABEL[row.level] || row.level}</span>
        ${active}
      </div>
      <div class="row-sub">${esc(row.body || '（无正文）')}</div>
      <div class="row-sub">更新 ${fmtTime(row.updated_at)}${schedule}${row.link ? ' · ' + esc(row.link) : ''}</div>
    </div>
    <div class="row-side">
      <button class="btn sm" data-action="ann-edit" data-id="${row.id}" type="button">编辑</button>
      <button class="btn sm danger" data-action="ann-delete" data-id="${row.id}" type="button">删除</button>
    </div>
  </div>`
}

function renderAnnouncements() {
  el('ann-list').innerHTML = state.announcements.length
    ? state.announcements.map(annRow).join('')
    : '<div class="empty">还没有公告。</div>'
}

function resetAnnForm() {
  state.editingAnnouncement = ''
  el('ann-form-title').textContent = '发布公告'
  el('ann-reset').classList.add('hidden')
  el('ann-title').value = ''
  el('ann-body').value = ''
  el('ann-level').value = 'info'
  el('ann-link').value = ''
  el('ann-start').value = ''
  el('ann-end').value = ''
  el('ann-active').checked = true
  el('ann-error').textContent = ''
}

function editAnnouncement(id) {
  const row = state.announcements.find((item) => item.id === id)
  if (!row) return
  state.editingAnnouncement = id
  el('ann-form-title').textContent = '编辑公告'
  el('ann-reset').classList.remove('hidden')
  el('ann-title').value = row.title
  el('ann-body').value = row.body || ''
  el('ann-level').value = row.level || 'info'
  el('ann-link').value = row.link || ''
  el('ann-start').value = fmtDateInput(row.starts_at)
  el('ann-end').value = fmtDateInput(row.ends_at)
  el('ann-active').checked = Boolean(row.active)
  el('ann-error').textContent = ''
  el('panel-announcements').scrollIntoView({ behavior: 'smooth', block: 'start' })
}

async function submitAnnouncement(event) {
  event.preventDefault()
  const payload = {
    title: el('ann-title').value.trim(),
    body: el('ann-body').value.trim(),
    level: el('ann-level').value,
    link: el('ann-link').value.trim(),
    startsAt: el('ann-start').value ? new Date(el('ann-start').value).getTime() : 0,
    endsAt: el('ann-end').value ? new Date(el('ann-end').value).getTime() : 0,
    active: el('ann-active').checked
  }
  if (!payload.title) {
    el('ann-error').textContent = '请填写公告标题'
    return
  }
  try {
    if (state.editingAnnouncement) {
      await api(`/admin/announcements/${state.editingAnnouncement}`, { method: 'PUT', body: JSON.stringify(payload) })
    } else {
      await api('/admin/announcements', { method: 'POST', body: JSON.stringify(payload) })
    }
    toast(state.editingAnnouncement ? '公告已更新' : '公告已发布，三端同步后可见')
    resetAnnForm()
    await loadAll()
  } catch (error) {
    el('ann-error').textContent = error.message
  }
}

async function deleteAnnouncement(id) {
  const row = state.announcements.find((item) => item.id === id)
  if (!row || !window.confirm(`确定删除公告「${row.title}」？`)) return
  try {
    await api(`/admin/announcements/${id}`, { method: 'DELETE' })
    toast('公告已删除')
    await loadAll()
  } catch (error) {
    toast(error.message, true)
  }
}

/* ---------- 用户 ---------- */
function userRow(row) {
  const actions = []
  if (row.status === 'pending') {
    actions.push(`<button class="btn sm primary" data-action="user-status" data-id="${row.id}" data-status="active" type="button">通过</button>`)
    actions.push(`<button class="btn sm" data-action="user-status" data-id="${row.id}" data-status="blocked" type="button">拒绝</button>`)
  } else if (row.status === 'active') {
    actions.push(`<button class="btn sm" data-action="user-status" data-id="${row.id}" data-status="blocked" type="button">停用</button>`)
  } else {
    actions.push(`<button class="btn sm" data-action="user-status" data-id="${row.id}" data-status="active" type="button">恢复</button>`)
  }
  actions.push(`<button class="btn sm danger" data-action="user-delete" data-id="${row.id}" type="button">删除</button>`)
  return `<div class="row">
    <div class="row-main">
      <div class="row-title">${esc(row.username)}
        <span class="tag ${row.status === 'active' ? 'ok' : row.status === 'pending' ? 'warn' : 'bad'}">${STATUS_LABEL[row.status] || row.status}</span>
      </div>
      <div class="row-sub">注册 ${fmtTime(row.created_at)} · 最近登录 ${fmtTime(row.last_seen, '从未')}${row.device ? ' · ' + esc(row.device) : ''}</div>
      <div class="row-sub">云同步 ${row.sync_at ? fmtTime(row.sync_at) : '还没同步过'}${row.note ? ' · 备注：' + esc(row.note) : ''}</div>
    </div>
    <div class="row-side">${actions.join('')}</div>
  </div>`
}

function renderUsers() {
  el('user-list').innerHTML = state.users.length
    ? state.users.map(userRow).join('')
    : '<div class="empty">还没有用户注册。</div>'
}

async function loadUsers() {
  const keyword = el('user-search').value.trim()
  try {
    const data = await api(`/admin/users${keyword ? `?q=${encodeURIComponent(keyword)}` : ''}`)
    state.users = data.users || []
    renderUsers()
  } catch (error) {
    toast(error.message, true)
  }
}

async function setUserStatus(id, status) {
  const row = state.users.find((item) => item.id === id)
  if (!row) return
  try {
    await api(`/admin/users/${id}`, { method: 'PUT', body: JSON.stringify({ status }) })
    toast(status === 'active' ? '账号已启用' : status === 'blocked' ? '账号已停用' : '状态已更新')
    await loadAll()
  } catch (error) {
    toast(error.message, true)
  }
}

async function deleteUser(id) {
  const row = state.users.find((item) => item.id === id)
  if (!row || !window.confirm(`确定删除用户「${row.username}」？收藏和观看进度也会一起删除。`)) return
  try {
    await api(`/admin/users/${id}`, { method: 'DELETE' })
    toast('用户已删除')
    await loadAll()
  } catch (error) {
    toast(error.message, true)
  }
}

/* ---------- 设置 ---------- */
function renderSettings() {
  if (!state.settings) return
  el('set-site-name').value = state.settings.siteName || 'KayTV'
  el('set-reg-open').checked = Boolean(state.settings.registrationOpen)
  el('set-auto-approve').checked = Boolean(state.settings.autoApprove)
}

async function submitSettings(event) {
  event.preventDefault()
  try {
    const data = await api('/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({
        siteName: el('set-site-name').value.trim(),
        registrationOpen: el('set-reg-open').checked,
        autoApprove: el('set-auto-approve').checked
      })
    })
    state.settings = data.settings || state.settings
    el('settings-result').textContent = '设置已保存，客户端下次同步生效'
    toast('设置已保存')
  } catch (error) {
    toast(error.message, true)
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  }
}

/* ---------- 事件 ---------- */
function bindEvents() {
  el('login-form').addEventListener('submit', (event) => {
    event.preventDefault()
    void login(el('token-input').value)
  })
  el('logout').addEventListener('click', logout)
  el('tabs').addEventListener('click', (event) => {
    const button = event.target.closest('.tab')
    if (!button) return
    document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab === button))
    document.querySelectorAll('.panel-page').forEach((panel) => panel.classList.add('hidden'))
    el(`panel-${button.dataset.tab}`).classList.remove('hidden')
  })
  document.addEventListener('click', (event) => {
    const goto = event.target.closest('[data-goto]')
    if (goto) {
      const button = document.querySelector(`.tab[data-tab="${goto.dataset.goto}"]`)
      button?.click()
      return
    }
    const copy = event.target.closest('[data-copy]')
    if (copy) {
      const text = copy.dataset.copy === 'config' ? `${location.origin}/api/config` : location.origin
      void copyText(text).then((ok) => toast(ok ? '已复制' : '复制失败，请手动选中', !ok))
      return
    }
    const action = event.target.closest('[data-action]')
    if (!action) return
    const id = action.dataset.id
    switch (action.dataset.action) {
      case 'source-edit':
        editSource(id)
        break
      case 'source-probe':
        void probeSource(id, action)
        break
      case 'source-delete':
        void deleteSource(id)
        break
      case 'ann-edit':
        editAnnouncement(id)
        break
      case 'ann-delete':
        void deleteAnnouncement(id)
        break
      case 'user-status':
        void setUserStatus(id, action.dataset.status)
        break
      case 'user-delete':
        void deleteUser(id)
        break
    }
  })
  document.addEventListener('change', (event) => {
    const toggle = event.target.closest('[data-action="source-toggle"]')
    if (toggle) void toggleSource(toggle.dataset.id, toggle.checked)
  })
  el('source-form').addEventListener('submit', (event) => void submitSource(event))
  el('source-reset').addEventListener('click', resetSourceForm)
  el('source-refresh').addEventListener('click', () => void loadAll())
  el('source-filter').addEventListener('change', renderSources)
  el('bulk-add').addEventListener('click', () => void bulkAdd())
  el('ann-form').addEventListener('submit', (event) => void submitAnnouncement(event))
  el('ann-reset').addEventListener('click', resetAnnForm)
  el('user-refresh').addEventListener('click', () => void loadUsers())
  el('user-search').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void loadUsers()
    }
  })
  el('settings-form').addEventListener('submit', (event) => void submitSettings(event))
}

bindEvents()
if (token) {
  showApp()
  loadAll().catch(() => {})
} else {
  showLogin('')
}

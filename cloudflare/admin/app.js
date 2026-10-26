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
  alerts: [],
  invites: [],
  feedback: [],
  audit: [],
  settings: null,
  kanju: null,
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
    const [overview, sources, announcements, users, settings, alerts, invites, feedback, audit, kanju] = await Promise.all([
      api('/admin/overview'),
      api('/admin/sources'),
      api('/admin/announcements'),
      api('/admin/users'),
      api('/admin/settings'),
      api('/admin/alerts'),
      api('/admin/invites'),
      api(`/admin/feedback?status=${el('feedback-filter')?.value || 'open'}`),
      api('/admin/audit?limit=80'),
      api('/admin/kanju')
    ])
    state.overview = overview
    state.sources = sources.sources || []
    state.announcements = announcements.announcements || []
    state.users = users.users || []
    state.settings = settings.settings || null
    state.alerts = alerts.alerts || []
    state.invites = invites.invites || []
    state.feedback = feedback.feedback || []
    state.audit = audit.logs || []
    state.kanju = kanju.kanju || null
    renderAll()
  } catch (error) {
    toast(error.message, true)
  }
}

function renderAll() {
  renderOverview()
  renderSources()
  renderKanju()
  renderAnnouncements()
  renderUsers()
  renderInvites()
  renderFeedback()
  renderAudit()
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
    { label: '在线设备', value: overview.activeSessions || 0 },
    { label: '待审核', value: overview.users.pending || 0, hot: overview.users.pending > 0 },
    { label: '待处理告警', value: overview.openAlerts || 0, hot: overview.openAlerts > 0 },
    { label: '待处理反馈', value: overview.openFeedback || 0, hot: overview.openFeedback > 0 },
    { label: '可用邀请码', value: overview.activeInvites || 0 },
    { label: '上次体检', value: overview.lastCheckAt ? fmtTime(overview.lastCheckAt, '—') : '未体检', small: true }
  ]
  const overviewCards = el('overview-cards')
  const sweepStatus = el('sweep-status')
  if (overviewCards) {
    overviewCards.innerHTML = cards
      .map(
        (card) => `<div class="stat${card.hot ? ' hot' : ''}">
          <b${card.small ? ' class="small-stat"' : ''}>${card.value}</b><span>${card.label}</span>
        </div>`
      )
      .join('')
  }
  if (sweepStatus) sweepStatus.textContent = overview.lastCheckAt ? `上次体检 ${fmtTime(overview.lastCheckAt)}` : '还没有体检记录'

  renderAlerts()

  const recent = state.users.slice(0, 6)
  const recentUsers = el('recent-users')
  if (recentUsers) {
    recentUsers.innerHTML = recent.length
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
}

function renderAlerts() {
  const rows = state.alerts || []
  const alertList = el('alert-list')
  if (!alertList) return
  alertList.innerHTML = rows.length
    ? rows
        .map(
          (row) => `<div class="row">
            <div class="row-main">
              <div class="row-title">
                ${esc(row.title)}
                <span class="tag ${row.level === 'critical' ? 'bad' : row.level === 'warning' ? 'warn' : ''}">${row.level === 'critical' ? '严重' : row.level === 'warning' ? '提醒' : '提示'}</span>
                <span class="tag">${row.kind === 'source_fail' ? '体检失败' : row.kind === 'source_expire' ? '有效期' : esc(row.kind)}</span>
              </div>
              <div class="row-sub">${esc(row.body || '')}</div>
              <div class="row-sub">${fmtTime(row.created_at)}${row.source_id ? ' · 源 ' + esc(row.source_id.slice(0, 8)) : ''}</div>
            </div>
            <div class="row-side">
              <button class="btn sm" data-action="alert-resolve" data-id="${row.id}" type="button">标记已处理</button>
            </div>
          </div>`
        )
        .join('')
    : '<div class="empty">没有待处理告警，源的体检结果正常。</div>'
}

/* ---------- 源管理 ---------- */
function expiryTag(expiresAt) {
  if (!expiresAt) return ''
  const days = Math.ceil((Number(expiresAt) - Date.now()) / 86400000)
  if (days < 0) return '<span class="tag bad">已过期</span>'
  if (days <= 3) return `<span class="tag warn">${Math.max(1, days)} 天后到期</span>`
  return `<span class="tag">有效期至 ${new Date(Number(expiresAt)).toLocaleDateString('zh-CN')}</span>`
}

function sourceRow(row) {
  const probe =
    row.probed_at > 0
      ? `<span class="tag ${row.probe_ok ? 'ok' : 'bad'}" title="${esc(row.probe_note || '')}">${row.probe_ok ? '可用' : '不可用'} · ${row.probe_ms || 0}ms</span>`
      : '<span class="tag">未检测</span>'
  const checks = Number(row.checks_7d) || 0
  const health = checks
    ? `<span class="tag ${row.ok_7d / checks >= 0.8 ? 'ok' : row.ok_7d / checks >= 0.5 ? 'warn' : 'bad'}">7天 ${row.ok_7d || 0}/${checks} 可用</span>`
    : ''
  const alerts = Number(row.open_alerts) > 0 ? `<span class="tag bad">${row.open_alerts} 条告警</span>` : ''
  return `<div class="row">
    <div class="row-main">
      <div class="row-title">
        ${esc(row.name)}
        <span class="tag ${row.kind === 'vod' ? 'accent' : ''}">${KIND_LABEL[row.kind] || row.kind}</span>
        ${row.enabled ? '' : '<span class="tag off">已停用</span>'}
        ${probe}
        ${health}
        ${expiryTag(row.expires_at)}
        ${alerts}
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
  const filterEl = el('source-filter')
  const filter = filterEl ? filterEl.value : ''
  const rows = state.sources.filter((row) => !filter || row.kind === filter)
  const sourceList = el('source-list')
  if (!sourceList) return
  sourceList.innerHTML = rows.length
    ? rows.map(sourceRow).join('')
    : '<div class="empty">还没有配置源。先添加一个影视源，三端同步后就能用它搜索播放。</div>'
}

function resetSourceForm() {
  state.editingSource = ''
  const formTitle = el('source-form-title')
  const resetBtn = el('source-reset')
  const kindSelect = el('source-kind')
  const nameInput = el('source-name')
  const urlInput = el('source-url')
  const typeInput = el('source-type')
  const sortInput = el('source-sort')
  const expiresInput = el('source-expires')
  const noteInput = el('source-note')
  const enabledCheck = el('source-enabled')
  const errorEl = el('source-error')
  if (!formTitle || !kindSelect || !nameInput || !urlInput || !enabledCheck) return
  formTitle.textContent = '添加源'
  if (resetBtn) resetBtn.classList.add('hidden')
  kindSelect.value = 'vod'
  nameInput.value = ''
  urlInput.value = ''
  typeInput.value = ''
  sortInput.value = '100'
  expiresInput.value = ''
  noteInput.value = ''
  enabledCheck.checked = true
  if (errorEl) errorEl.textContent = ''
}

function editSource(id) {
  const row = state.sources.find((item) => item.id === id)
  if (!row) return
  state.editingSource = id
  const formTitle = el('source-form-title')
  const resetBtn = el('source-reset')
  const kindSelect = el('source-kind')
  const nameInput = el('source-name')
  const urlInput = el('source-url')
  const typeInput = el('source-type')
  const sortInput = el('source-sort')
  const expiresInput = el('source-expires')
  const noteInput = el('source-note')
  const enabledCheck = el('source-enabled')
  const errorEl = el('source-error')
  if (!formTitle || !kindSelect || !nameInput || !urlInput || !enabledCheck) return
  formTitle.textContent = `编辑「${row.name}」`
  if (resetBtn) resetBtn.classList.remove('hidden')
  kindSelect.value = row.kind
  nameInput.value = row.name
  urlInput.value = row.url
  typeInput.value = row.type || ''
  sortInput.value = String(row.sort ?? 100)
  expiresInput.value = fmtDateInput(row.expires_at)
  noteInput.value = row.note || ''
  enabledCheck.checked = Boolean(row.enabled)
  if (errorEl) errorEl.textContent = ''
  el('panel-sources').scrollIntoView({ behavior: 'smooth', block: 'start' })
}

async function submitSource(event) {
  event.preventDefault()
  const kindEl = el('source-kind')
  const nameEl = el('source-name')
  const urlEl = el('source-url')
  const typeEl = el('source-type')
  const sortEl = el('source-sort')
  const expiresEl = el('source-expires')
  const noteEl = el('source-note')
  const enabledEl = el('source-enabled')
  const errorEl = el('source-error')
  if (!kindEl || !nameEl || !urlEl || !enabledEl) return
  const payload = {
    kind: kindEl.value,
    name: nameEl.value.trim(),
    url: urlEl.value.trim(),
    type: typeEl.value.trim(),
    sort: Number(sortEl.value) || 100,
    expiresAt: expiresEl.value ? new Date(expiresEl.value).getTime() : 0,
    note: noteEl.value.trim(),
    enabled: enabledEl.checked
  }
  if (!payload.name || !payload.url) {
    if (errorEl) errorEl.textContent = '名称和接口地址都要填'
    return
  }
  try {
    if (state.editingSource) {
      await api(`/admin/sources/${state.editingSource}`, { method: 'PUT', body: JSON.stringify(payload) })
      toast('源已更新')
    } else {
      const data = await api('/admin/sources', { method: 'POST', body: JSON.stringify(payload) })
      toast(data.expanded ? `JS 插件已展开为 ${data.added.length} 个采集接口` : '源已添加')
    }
    resetSourceForm()
    await loadAll()
  } catch (error) {
    if (errorEl) errorEl.textContent = error.message
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
  let expanded = 0
  let failed = 0
  for (const item of lines) {
    try {
      const data = await api('/admin/sources', {
        method: 'POST',
        body: JSON.stringify({ kind, name: item.name, url: item.url, enabled: true })
      })
      if (data.expanded) expanded += (data.added || []).length
      else added += 1
    } catch {
      failed += 1
    }
  }
  button.disabled = false
  el('bulk-result').textContent = `添加完成：成功 ${added} 个${expanded ? `，JS 插件另展开 ${expanded} 个采集接口` : ''}${failed ? `，失败 ${failed} 个` : ''}`
  if (added || expanded) {
    el('bulk-text').value = ''
    await loadAll()
  }
}

/* ---------- 看剧AI ---------- */
function renderKanju() {
  const info = state.kanju
  const badge = el('kanju-badge')
  const toggle = el('kanju-toggle')
  const refresh = el('kanju-refresh')
  const auto = el('kanju-auto-refresh')
  if (!badge || !toggle || !refresh || !auto) return
  if (!info) {
    badge.className = 'tag'
    badge.textContent = '未配置'
    toggle.disabled = true
    refresh.disabled = true
    return
  }
  if (!info.configured) {
    badge.className = 'tag warn'
    badge.textContent = '未配置'
  } else if (info.enabled) {
    badge.className = 'tag ok'
    badge.textContent = '云端代理启用中'
  } else {
    badge.className = 'tag off'
    badge.textContent = '已停用'
  }
  toggle.disabled = !info.configured
  toggle.textContent = info.enabled ? '停用云端代理' : '启用云端代理'
  refresh.disabled = !info.configured
  auto.checked = Boolean(info.autoRefresh)
  auto.disabled = !info.configured
  const rows = [
    ['域名', info.baseUrl || '未填写', ''],
    ['接口密钥', info.secretMasked || '未保存', '只显示首尾 4 位'],
    ['客户端标识', [info.clientName, info.clientVersion].filter(Boolean).join(' · ') || '—', ''],
    ['构建标识', info.buildVersion || '—', ''],
    ['协议版本', info.protocolVersion || '—', ''],
    ['最近成功', fmtTime(info.lastOkAt), ''],
    ['最近检查', fmtTime(info.lastCheckAt), ''],
    ['最近错误', info.lastError || '无', info.lastError ? 'bad' : '']
  ]
  el('kanju-status').innerHTML = rows
    .map(
      ([label, value, kind]) => `<div class="row">
        <div class="row-main">
          <div class="row-title">${esc(label)}</div>
          <div class="row-sub"${kind === 'bad' ? ' style="color: var(--bad, #ff6b6b)"' : ''}>${esc(value)}</div>
        </div>
      </div>`
    )
    .join('')
  el('kanju-error').textContent = ''
  if (info.baseUrl && document.activeElement !== el('kanju-url')) el('kanju-url').value = info.baseUrl
}

async function submitKanju(event) {
  event.preventDefault()
  const button = event.target.querySelector('button[type="submit"]')
  const url = el('kanju-url').value.trim()
  if (!url) {
    toast('请填写看剧AI 官网地址', true)
    return
  }
  const label = button.textContent
  button.disabled = true
  button.textContent = '识别中…'
  el('kanju-message').textContent = '正在打开官网、抓取脚本并实测官方接口，最长约 60 秒…'
  try {
    const data = await api('/admin/kanju', { method: 'POST', body: JSON.stringify({ url }) })
    state.kanju = data.kanju || state.kanju
    renderKanju()
    el('kanju-message').textContent = '识别成功，云端代理已启用。0.5.1 起的三端会在下次同步后自动走云端，无需重装。'
    toast('看剧AI 已自动识别并启用')
  } catch (error) {
    el('kanju-error').textContent = error.message
    el('kanju-message').textContent = '识别失败，原有配置未改动。'
    toast(error.message, true)
  } finally {
    button.disabled = false
    button.textContent = label
  }
}

async function refreshKanjuConfig() {
  const button = el('kanju-refresh')
  const label = button.textContent
  button.disabled = true
  button.textContent = '识别中…'
  el('kanju-message').textContent = '正在重新抓取签名并实测…'
  try {
    const data = await api('/admin/kanju/refresh', { method: 'POST' })
    state.kanju = data.kanju || state.kanju
    renderKanju()
    el('kanju-message').textContent = '已重新识别签名，云端代理继续可用。'
    toast('签名已刷新')
  } catch (error) {
    el('kanju-error').textContent = error.message
    toast(error.message, true)
  } finally {
    button.disabled = false
    button.textContent = label
  }
}

async function updateKanju(patch) {
  try {
    const data = await api('/admin/kanju', { method: 'PUT', body: JSON.stringify(patch) })
    state.kanju = data.kanju || state.kanju
    renderKanju()
    toast('看剧AI 设置已保存')
  } catch (error) {
    toast(error.message, true)
    renderKanju()
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
  const annList = el('ann-list')
  if (!annList) return
  annList.innerHTML = state.announcements.length
    ? state.announcements.map(annRow).join('')
    : '<div class="empty">还没有公告。</div>'
}

function resetAnnForm() {
  state.editingAnnouncement = ''
  const formTitle = el('ann-form-title')
  const resetBtn = el('ann-reset')
  const titleInput = el('ann-title')
  const bodyInput = el('ann-body')
  const levelSelect = el('ann-level')
  const linkInput = el('ann-link')
  const startInput = el('ann-start')
  const endInput = el('ann-end')
  const activeCheck = el('ann-active')
  const errorEl = el('ann-error')
  if (!formTitle || !titleInput || !bodyInput || !activeCheck) return
  formTitle.textContent = '发布公告'
  if (resetBtn) resetBtn.classList.add('hidden')
  titleInput.value = ''
  bodyInput.value = ''
  levelSelect.value = 'info'
  linkInput.value = ''
  startInput.value = ''
  endInput.value = ''
  activeCheck.checked = true
  if (errorEl) errorEl.textContent = ''
}

function editAnnouncement(id) {
  const row = state.announcements.find((item) => item.id === id)
  if (!row) return
  state.editingAnnouncement = id
  const formTitle = el('ann-form-title')
  const resetBtn = el('ann-reset')
  const titleInput = el('ann-title')
  const bodyInput = el('ann-body')
  const levelSelect = el('ann-level')
  const linkInput = el('ann-link')
  const startInput = el('ann-start')
  const endInput = el('ann-end')
  const activeCheck = el('ann-active')
  const errorEl = el('ann-error')
  if (!formTitle || !titleInput || !bodyInput || !activeCheck) return
  formTitle.textContent = '编辑公告'
  if (resetBtn) resetBtn.classList.remove('hidden')
  titleInput.value = row.title
  bodyInput.value = row.body || ''
  levelSelect.value = row.level || 'info'
  linkInput.value = row.link || ''
  startInput.value = fmtDateInput(row.starts_at)
  endInput.value = fmtDateInput(row.ends_at)
  activeCheck.checked = Boolean(row.active)
  if (errorEl) errorEl.textContent = ''
  el('panel-announcements').scrollIntoView({ behavior: 'smooth', block: 'start' })
}

async function submitAnnouncement(event) {
  event.preventDefault()
  const titleEl = el('ann-title')
  const bodyEl = el('ann-body')
  const levelEl = el('ann-level')
  const linkEl = el('ann-link')
  const startEl = el('ann-start')
  const endEl = el('ann-end')
  const activeEl = el('ann-active')
  const errorEl = el('ann-error')
  if (!titleEl || !bodyEl || !activeEl) return
  const payload = {
    title: titleEl.value.trim(),
    body: bodyEl.value.trim(),
    level: levelEl.value,
    link: linkEl.value.trim(),
    startsAt: startEl.value ? new Date(startEl.value).getTime() : 0,
    endsAt: endEl.value ? new Date(endEl.value).getTime() : 0,
    active: activeEl.checked
  }
  if (!payload.title) {
    if (errorEl) errorEl.textContent = '请填写公告标题'
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
  const sessions = Number(row.session_count) || 0
  if (sessions > 0) {
    actions.unshift(`<button class="btn sm" data-action="user-revoke" data-id="${row.id}" type="button">下线设备 ${sessions}</button>`)
  }
  return `<div class="row">
    <div class="row-main">
      <div class="row-title">${esc(row.username)}
        <span class="tag ${row.status === 'active' ? 'ok' : row.status === 'pending' ? 'warn' : 'bad'}">${STATUS_LABEL[row.status] || row.status}</span>
        ${sessions > 0 ? `<span class="tag ok">${sessions} 台在线</span>` : ''}
      </div>
      <div class="row-sub">注册 ${fmtTime(row.created_at)} · 最近登录 ${fmtTime(row.last_seen, '从未')}${row.device ? ' · ' + esc(row.device) : ''}</div>
      <div class="row-sub">云同步 ${row.sync_at ? fmtTime(row.sync_at) : '还没同步过'}${row.note ? ' · 备注：' + esc(row.note) : ''}</div>
    </div>
    <div class="row-side">${actions.join('')}</div>
  </div>`
}

function renderUsers() {
  const userList = el('user-list')
  if (!userList) return
  userList.innerHTML = state.users.length
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

async function revokeUserSessions(id) {
  const row = state.users.find((item) => item.id === id)
  if (!row || !window.confirm(`让「${row.username}」在所有设备上退出登录？`)) return
  try {
    const data = await api(`/admin/users/${id}/revoke-sessions`, { method: 'POST' })
    toast(`已下线 ${data.removed || 0} 个会话`)
    await loadAll()
  } catch (error) {
    toast(error.message, true)
  }
}

/* ---------- 邀请码 ---------- */
function inviteRow(row) {
  const expired = row.expires_at && row.expires_at < Date.now()
  const usedUp = row.used_count >= row.max_uses
  const stateTag = !row.enabled
    ? '<span class="tag off">已停用</span>'
    : expired
      ? '<span class="tag bad">已过期</span>'
      : usedUp
        ? '<span class="tag warn">已用完</span>'
        : '<span class="tag ok">可用</span>'
  return `<div class="row">
    <div class="row-main">
      <div class="row-title"><code>${esc(row.code)}</code> ${stateTag}</div>
      <div class="row-sub">已用 ${row.used_count}/${row.max_uses} 次${row.expires_at ? ' · 到期 ' + fmtTime(row.expires_at) : ' · 长期有效'}${row.note ? ' · ' + esc(row.note) : ''}</div>
      <div class="row-sub">创建 ${fmtTime(row.created_at)}</div>
    </div>
    <div class="row-side">
      <button class="btn sm" data-action="invite-copy" data-code="${esc(row.code)}" type="button">复制</button>
      <button class="btn sm" data-action="invite-toggle" data-id="${row.id}" data-enabled="${row.enabled ? '0' : '1'}" type="button">${row.enabled ? '停用' : '启用'}</button>
      <button class="btn sm danger" data-action="invite-delete" data-id="${row.id}" type="button">删除</button>
    </div>
  </div>`
}

function renderInvites() {
  const inviteList = el('invite-list')
  if (!inviteList) return
  inviteList.innerHTML = state.invites.length
    ? state.invites.map(inviteRow).join('')
    : '<div class="empty">还没有邀请码。上方填数量生成，注册模式切到「需要邀请码」后生效。</div>'
}

async function submitInvite(event) {
  event.preventDefault()
  try {
    const data = await api('/admin/invites', {
      method: 'POST',
      body: JSON.stringify({
        count: Number(el('invite-count').value) || 1,
        maxUses: Number(el('invite-uses').value) || 1,
        expiresAt: el('invite-expires').value ? new Date(el('invite-expires').value).getTime() : 0,
        note: el('invite-note').value.trim()
      })
    })
    el('invite-result').textContent = `已生成：${(data.codes || []).join('  ')}`
    el('invite-note').value = ''
    toast('邀请码已生成')
    await loadAll()
  } catch (error) {
    el('invite-result').textContent = error.message
  }
}

async function toggleInvite(id, enabled) {
  try {
    await api(`/admin/invites/${id}`, { method: 'PUT', body: JSON.stringify({ enabled }) })
    toast(enabled ? '邀请码已启用' : '邀请码已停用')
    await loadAll()
  } catch (error) {
    toast(error.message, true)
  }
}

async function deleteInvite(id) {
  if (!window.confirm('确定删除这个邀请码？已用它注册的账号不受影响。')) return
  try {
    await api(`/admin/invites/${id}`, { method: 'DELETE' })
    toast('邀请码已删除')
    await loadAll()
  } catch (error) {
    toast(error.message, true)
  }
}

/* ---------- 反馈 ---------- */
const FEEDBACK_KIND = { request: '求片', problem: '问题', other: '建议', feedback: '反馈' }
const FEEDBACK_STATUS = { open: '待处理', done: '已完成', ignored: '已忽略' }

function feedbackRow(row) {
  const actions = []
  if (row.status !== 'done') actions.push(`<button class="btn sm primary" data-action="feedback-status" data-id="${row.id}" data-status="done" type="button">完成</button>`)
  if (row.status !== 'ignored') actions.push(`<button class="btn sm" data-action="feedback-status" data-id="${row.id}" data-status="ignored" type="button">忽略</button>`)
  if (row.status !== 'open') actions.push(`<button class="btn sm" data-action="feedback-status" data-id="${row.id}" data-status="open" type="button">重新打开</button>`)
  actions.push(`<button class="btn sm danger" data-action="feedback-delete" data-id="${row.id}" type="button">删除</button>`)
  return `<div class="row">
    <div class="row-main">
      <div class="row-title">${esc(row.title)}
        <span class="tag ${row.status === 'open' ? 'warn' : row.status === 'done' ? 'ok' : 'off'}">${FEEDBACK_STATUS[row.status] || row.status}</span>
        <span class="tag">${FEEDBACK_KIND[row.kind] || esc(row.kind)}</span>
      </div>
      <div class="row-sub">${esc(row.body || '')}</div>
      <div class="row-sub">${row.username ? '用户 ' + esc(row.username) : '匿名'}${row.contact ? ' · 联系 ' + esc(row.contact) : ''}${row.device ? ' · ' + esc(row.device) : ''} · ${fmtTime(row.created_at)}</div>
      ${row.admin_note ? `<div class="row-sub">备注：${esc(row.admin_note)}</div>` : ''}
    </div>
    <div class="row-side">${actions.join('')}</div>
  </div>`
}

function renderFeedback() {
  const feedbackList = el('feedback-list')
  if (!feedbackList) return
  feedbackList.innerHTML = state.feedback.length
    ? state.feedback.map(feedbackRow).join('')
    : '<div class="empty">这个筛选下没有反馈。</div>'
}

async function setFeedbackStatus(id, status) {
  const note = window.prompt('处理备注（可留空）', '')
  if (note === null) return
  try {
    await api(`/admin/feedback/${id}`, { method: 'PUT', body: JSON.stringify({ status, adminNote: note.trim() }) })
    toast('反馈状态已更新')
    await loadFeedback()
  } catch (error) {
    toast(error.message, true)
  }
}

async function deleteFeedback(id) {
  if (!window.confirm('确定删除这条反馈？')) return
  try {
    await api(`/admin/feedback/${id}`, { method: 'DELETE' })
    toast('反馈已删除')
    await loadFeedback()
  } catch (error) {
    toast(error.message, true)
  }
}

async function loadFeedback() {
  try {
    const data = await api(`/admin/feedback?status=${el('feedback-filter').value}`)
    state.feedback = data.feedback || []
    renderFeedback()
  } catch (error) {
    toast(error.message, true)
  }
}

/* ---------- 审计 ---------- */
const AUDIT_LABEL = {
  'source.create': '新增源',
  'source.update': '更新源',
  'source.delete': '删除源',
  'source.probe': '检测源',
  'sweep.run': '运行体检',
  'alert.resolve': '处理告警',
  'alert.resolve-all': '批量处理告警',
  'announcement.create': '发布公告',
  'announcement.update': '更新公告',
  'announcement.delete': '删除公告',
  'user.register': '用户注册',
  'user.status': '修改用户状态',
  'user.delete': '删除用户',
  'user.revoke-sessions': '强制下线',
  'session.revoke': '下线设备',
  'session.revoke-others': '下线其他设备',
  'settings.update': '修改设置',
  'invite.create': '生成邀请码',
  'invite.update': '修改邀请码',
  'invite.delete': '删除邀请码',
  'feedback.update': '处理反馈',
  'feedback.delete': '删除反馈'
}

function renderAudit() {
  const auditList = el('audit-list')
  if (!auditList) return
  auditList.innerHTML = state.audit.length
    ? state.audit
        .map(
          (row) => `<div class="row">
            <div class="row-main">
              <div class="row-title">${esc(AUDIT_LABEL[row.action] || row.action)}
                <span class="tag">${esc(row.actor || 'admin')}</span>
              </div>
              <div class="row-sub">${row.target ? esc(row.target) + ' · ' : ''}${esc(row.detail || '')}</div>
              <div class="row-sub">${fmtTime(row.created_at)}${row.ip ? ' · ' + esc(row.ip) : ''}</div>
            </div>
          </div>`
        )
        .join('')
    : '<div class="empty">还没有操作记录。</div>'
}

async function loadAudit() {
  const keyword = el('audit-search').value.trim()
  try {
    const data = await api(`/admin/audit?limit=120${keyword ? `&q=${encodeURIComponent(keyword)}` : ''}`)
    state.audit = data.logs || []
    renderAudit()
  } catch (error) {
    toast(error.message, true)
  }
}

/* ---------- 体检 ---------- */
async function runSweep(button) {
  button.disabled = true
  const original = button.textContent
  let checked = 0
  let failed = 0
  let since = 0
  try {
    for (let round = 0; round < 30; round += 1) {
      button.textContent = `体检中… 已查 ${checked}`
      const data = await api('/admin/sweep', { method: 'POST', body: JSON.stringify({ limit: 6, since }) })
      since = Number(data.since) || since
      checked += data.checked || 0
      failed += data.failed || 0
      if (!data.remaining) break
    }
    toast(`体检完成：${checked} 个源，失败 ${failed} 个`)
  } catch (error) {
    toast(error.message, true)
  } finally {
    button.disabled = false
    button.textContent = original
    await loadAll()
  }
}

async function resolveAlert(id) {
  try {
    await api(`/admin/alerts/${id}`, { method: 'PUT' })
    toast('告警已处理')
    await loadAll()
  } catch (error) {
    toast(error.message, true)
  }
}

async function resolveAllAlerts() {
  if (!window.confirm('把所有待处理告警标记为已处理？')) return
  try {
    await api('/admin/alerts/resolve-all', { method: 'POST' })
    toast('已全部处理')
    await loadAll()
  } catch (error) {
    toast(error.message, true)
  }
}

/* ---------- 设置 ---------- */
function renderSettings() {
  if (!state.settings) return
  const siteNameInput = el('set-site-name')
  const regModeSelect = el('set-reg-mode')
  const autoApproveCheck = el('set-auto-approve')
  const minVersionInput = el('set-min-version')
  const updateUrlInput = el('set-update-url')
  const failThresholdInput = el('set-fail-threshold')
  if (!siteNameInput || !regModeSelect || !autoApproveCheck) return
  siteNameInput.value = state.settings.siteName || 'KayTV'
  regModeSelect.value = state.settings.registrationMode || (state.settings.registrationOpen ? 'open' : 'closed')
  autoApproveCheck.checked = Boolean(state.settings.autoApprove)
  minVersionInput.value = state.settings.minVersion || ''
  updateUrlInput.value = state.settings.updateUrl || ''
  failThresholdInput.value = String(state.settings.failThreshold || 2)
}

async function submitSettings(event) {
  event.preventDefault()
  const siteNameEl = el('set-site-name')
  const regModeEl = el('set-reg-mode')
  const autoApproveEl = el('set-auto-approve')
  const minVersionEl = el('set-min-version')
  const updateUrlEl = el('set-update-url')
  const failThresholdEl = el('set-fail-threshold')
  if (!siteNameEl || !regModeEl || !autoApproveEl) return
  try {
    const data = await api('/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({
        siteName: siteNameEl.value.trim(),
        registrationMode: regModeEl.value,
        autoApprove: autoApproveEl.checked,
        minVersion: minVersionEl.value.trim(),
        updateUrl: updateUrlEl.value.trim(),
        failThreshold: Number(failThresholdEl.value) || 2
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
      case 'user-revoke':
        void revokeUserSessions(id)
        break
      case 'alert-resolve':
        void resolveAlert(id)
        break
      case 'invite-copy':
        void copyText(action.dataset.code || '').then((ok) => toast(ok ? '邀请码已复制' : '复制失败', !ok))
        break
      case 'invite-toggle':
        void toggleInvite(id, action.dataset.enabled === '1')
        break
      case 'invite-delete':
        void deleteInvite(id)
        break
      case 'feedback-status':
        void setFeedbackStatus(id, action.dataset.status)
        break
      case 'feedback-delete':
        void deleteFeedback(id)
        break
    }
  })
  document.addEventListener('change', (event) => {
    const toggle = event.target.closest('[data-action="source-toggle"]')
    if (toggle) void toggleSource(toggle.dataset.id, toggle.checked)
  })
  const sourceForm = el('source-form')
  const sourceReset = el('source-reset')
  const sourceRefresh = el('source-refresh')
  const sourceFilter = el('source-filter')
  const bulkAddBtn = el('bulk-add')
  const sweepRun = el('sweep-run')
  const alertsResolve = el('alerts-resolve')
  const annForm = el('ann-form')
  const annReset = el('ann-reset')
  const userRefresh = el('user-refresh')
  if (sourceForm) sourceForm.addEventListener('submit', (event) => void submitSource(event))
  if (sourceReset) sourceReset.addEventListener('click', resetSourceForm)
  if (sourceRefresh) sourceRefresh.addEventListener('click', () => void loadAll())
  if (sourceFilter) sourceFilter.addEventListener('change', renderSources)
  if (bulkAddBtn) bulkAddBtn.addEventListener('click', () => void bulkAdd())
  if (sweepRun) sweepRun.addEventListener('click', (event) => void runSweep(event.currentTarget))
  if (alertsResolve) alertsResolve.addEventListener('click', () => void resolveAllAlerts())
  if (annForm) annForm.addEventListener('submit', (event) => void submitAnnouncement(event))
  if (annReset) annReset.addEventListener('click', resetAnnForm)
  if (userRefresh) userRefresh.addEventListener('click', () => void loadUsers())
  const userSearch = el('user-search')
  const inviteForm = el('invite-form')
  const inviteRefresh = el('invite-refresh')
  const feedbackFilter = el('feedback-filter')
  const feedbackRefresh = el('feedback-refresh')
  const auditRefresh = el('audit-refresh')
  const auditSearch = el('audit-search')
  const kanjuForm = el('kanju-form')
  const kanjuRefresh = el('kanju-refresh')
  const kanjuToggle = el('kanju-toggle')
  const kanjuAutoRefresh = el('kanju-auto-refresh')
  const settingsForm = el('settings-form')
  if (userSearch) userSearch.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void loadUsers()
    }
  })
  if (inviteForm) inviteForm.addEventListener('submit', (event) => void submitInvite(event))
  if (inviteRefresh) inviteRefresh.addEventListener('click', () => void loadAll())
  if (feedbackFilter) feedbackFilter.addEventListener('change', () => void loadFeedback())
  if (feedbackRefresh) feedbackRefresh.addEventListener('click', () => void loadFeedback())
  if (auditRefresh) auditRefresh.addEventListener('click', () => void loadAudit())
  if (auditSearch) auditSearch.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void loadAudit()
    }
  })
  if (kanjuForm) kanjuForm.addEventListener('submit', (event) => void submitKanju(event))
  if (kanjuRefresh) kanjuRefresh.addEventListener('click', () => void refreshKanjuConfig())
  if (kanjuToggle) kanjuToggle.addEventListener('click', () => {
    const info = state.kanju
    if (!info?.configured) return
    void updateKanju({ enabled: !info.enabled })
  })
  if (kanjuAutoRefresh) kanjuAutoRefresh.addEventListener('change', (event) => {
    void updateKanju({ autoRefresh: event.target.checked })
  })
  if (settingsForm) settingsForm.addEventListener('submit', (event) => void submitSettings(event))
}

bindEvents()
if (token) {
  showApp()
  loadAll().catch(() => {})
} else {
  showLogin('')
}

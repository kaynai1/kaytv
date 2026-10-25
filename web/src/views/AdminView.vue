<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { api } from '../api/client'
import { toast } from '../composables/useToast'
import AppIcon from '../components/AppIcon.vue'
import type { AdminUser, HealthReport, Subscription } from '../types'

interface LiveSourceEdit {
  id: string
  name: string
  url: string
  type: 'auto' | 'm3u' | 'txt'
  enabled: boolean
  note: string
  managedBy?: string
  headers: Record<string, string>
}

interface VodSourceEdit {
  id: string
  name: string
  api: string
  type: 'maccms' | 'kanju'
  enabled: boolean
  note: string
  managedBy?: string
  headers: Record<string, string>
}

type Tab = 'live' | 'vod' | 'health' | 'subscriptions' | 'users' | 'site' | 'access'

const authed = ref(false)
const checking = ref(true)
const loginLoading = ref(false)
const username = ref('admin')
const password = ref('')
const loginError = ref('')
const envPassword = ref(false)
const sessionRole = ref('')
const sessionName = ref('')
const saving = ref(false)
const loadingConfig = ref(false)
const tab = ref<Tab>('live')
const siteName = ref('KayTV')
const accessMode = ref<'public' | 'login'>('public')
const autoCheck = ref(true)
const liveSources = ref<LiveSourceEdit[]>([])
const vodSources = ref<VodSourceEdit[]>([])
const subscriptions = ref<Subscription[]>([])
const headersText = reactive<Record<string, string>>({})
const testResults = reactive<Record<string, string>>({})
const testingId = ref('')
const snapshot = ref('')
const newPassword = ref('')
const newPassword2 = ref('')
const passwordLoading = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

const health = ref<HealthReport | null>(null)
const healthLoading = ref(false)
const healthChecking = ref(false)
const healthFilter = ref<'all' | 'failed'>('all')

const users = ref<AdminUser[]>([])
const usersLoading = ref(false)
const userSaving = ref(false)
const userForm = reactive({
  username: '',
  password: '',
  displayName: '',
  role: 'viewer' as 'admin' | 'viewer'
})

const subForm = reactive({ name: '', url: '' })
const previewing = ref('')
const previewResults = reactive<Record<string, string>>({})
const syncingId = ref('')

const isAdmin = computed(() => sessionRole.value === 'admin')

const signature = computed(() =>
  JSON.stringify({
    siteName: siteName.value,
    accessMode: accessMode.value,
    autoCheck: autoCheck.value,
    liveSources: liveSources.value,
    vodSources: vodSources.value,
    subscriptions: subscriptions.value,
    headers: headersText
  })
)

const dirty = computed(() => authed.value && snapshot.value !== '' && signature.value !== snapshot.value)

const origin = window.location.origin

function normalizeLive(source: Partial<LiveSourceEdit>): LiveSourceEdit {
  return {
    id: String(source.id || ''),
    name: String(source.name || ''),
    url: String(source.url || ''),
    type: source.type === 'm3u' || source.type === 'txt' ? source.type : 'auto',
    enabled: source.enabled !== false,
    note: String(source.note || ''),
    ...(source.managedBy ? { managedBy: String(source.managedBy) } : {}),
    headers: (source.headers as Record<string, string>) || {}
  }
}

function normalizeVod(source: Partial<VodSourceEdit>): VodSourceEdit {
  return {
    id: String(source.id || ''),
    name: String(source.name || ''),
    api: String(source.api || ''),
    type: source.type === 'kanju' ? 'kanju' : 'maccms',
    enabled: source.enabled !== false,
    note: String(source.note || ''),
    ...(source.managedBy ? { managedBy: String(source.managedBy) } : {}),
    headers: (source.headers as Record<string, string>) || {}
  }
}

function normalizeSubscription(source: Partial<Subscription>): Subscription {
  return {
    id: String(source.id || ''),
    name: String(source.name || ''),
    url: String(source.url || ''),
    enabled: source.enabled !== false,
    note: String(source.note || ''),
    lastSyncAt: Number(source.lastSyncAt) || 0,
    lastError: String(source.lastError || ''),
    vodCount: Number(source.vodCount) || 0,
    liveCount: Number(source.liveCount) || 0
  }
}

async function loadConfig() {
  loadingConfig.value = true
  try {
    const raw = (await api.adminConfig()) as unknown as {
      siteName: string
      access?: { mode?: string }
      autoCheck?: boolean
      liveSources: LiveSourceEdit[]
      vodSources: VodSourceEdit[]
      subscriptions?: Subscription[]
    }
    siteName.value = raw.siteName || 'KayTV'
    accessMode.value = raw.access?.mode === 'login' ? 'login' : 'public'
    autoCheck.value = raw.autoCheck !== false
    liveSources.value = (raw.liveSources || []).map(normalizeLive)
    vodSources.value = (raw.vodSources || []).map(normalizeVod)
    subscriptions.value = (raw.subscriptions || []).map(normalizeSubscription)
    for (const key of Object.keys(headersText)) delete headersText[key]
    for (const source of [...liveSources.value, ...vodSources.value]) {
      const headers = source.headers && Object.keys(source.headers).length ? source.headers : null
      headersText[source.id] = headers ? JSON.stringify(headers) : ''
    }
    snapshot.value = signature.value
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : '读取配置失败')
  } finally {
    loadingConfig.value = false
  }
}

async function checkSession() {
  checking.value = true
  try {
    const session = await api.adminSession()
    authed.value = session.authed
    sessionRole.value = session.role || ''
    sessionName.value = session.displayName || session.username || ''
    envPassword.value = session.envPassword
    if (session.authed && session.role === 'admin') await loadConfig()
  } catch (caught) {
    loginError.value = caught instanceof Error ? caught.message : '无法连接服务端'
  } finally {
    checking.value = false
  }
}

async function login() {
  if (!password.value) return
  loginLoading.value = true
  loginError.value = ''
  try {
    const result = await api.adminLogin(username.value.trim() || 'admin', password.value)
    password.value = ''
    authed.value = true
    sessionRole.value = result.role || ''
    const session = await api.adminSession()
    envPassword.value = session.envPassword
    sessionName.value = session.displayName || session.username || username.value
    if (session.role !== 'admin') {
      toast.error('该账号没有管理权限')
      return
    }
    await loadConfig()
    await loadHealth()
  } catch (caught) {
    loginError.value = caught instanceof Error ? caught.message : '登录失败'
  } finally {
    loginLoading.value = false
  }
}

async function logout() {
  try {
    await api.adminLogout()
  } catch {
    /* ignore */
  }
  authed.value = false
  sessionRole.value = ''
  sessionName.value = ''
  snapshot.value = ''
  liveSources.value = []
  vodSources.value = []
  subscriptions.value = []
  health.value = null
  users.value = []
}

function parseHeaders(id: string, required = true): Record<string, string> {
  const text = (headersText[id] || '').trim()
  if (!text) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    if (required) throw new Error('请求头不是合法 JSON')
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    if (required) throw new Error('请求头需要是 JSON 对象，例如 {"Referer":"https://..."}')
    return {}
  }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string' || typeof value === 'number') out[key] = String(value)
  }
  return out
}

function validate(): string | null {
  if (!siteName.value.trim()) return '站点名称不能为空'
  const ids = new Set<string>()
  for (const source of liveSources.value) {
    if (!source.name.trim()) return '直播源名称不能为空'
    if (!/^https?:\/\//i.test(source.url.trim())) return `直播源「${source.name}」地址无效`
    if (ids.has(source.id)) return '源 ID 重复，请删除后重建'
    ids.add(source.id)
    try {
      parseHeaders(source.id)
    } catch (error) {
      return `直播源「${source.name}」：${(error as Error).message}`
    }
  }
  for (const source of vodSources.value) {
    if (!source.name.trim()) return '影视源名称不能为空'
    if (!/^https?:\/\//i.test(source.api.trim())) return `影视源「${source.name}」接口地址无效`
    if (ids.has(source.id)) return '源 ID 重复，请删除后重建'
    ids.add(source.id)
    try {
      parseHeaders(source.id)
    } catch (error) {
      return `影视源「${source.name}」：${(error as Error).message}`
    }
  }
  const subIds = new Set<string>()
  for (const item of subscriptions.value) {
    if (!item.name.trim()) return '订阅名称不能为空'
    if (!/^https?:\/\//i.test(item.url.trim())) return `订阅「${item.name}」地址无效`
    if (subIds.has(item.id)) return '订阅 ID 重复，请删除后重建'
    subIds.add(item.id)
  }
  return null
}

function buildPayload() {
  return {
    version: 4,
    siteName: siteName.value.trim() || 'KayTV',
    access: { mode: accessMode.value },
    autoCheck: autoCheck.value,
    liveSources: liveSources.value.map((source) => ({
      id: source.id,
      name: source.name.trim(),
      url: source.url.trim(),
      type: source.type,
      enabled: source.enabled,
      note: source.note,
      ...(source.managedBy ? { managedBy: source.managedBy } : {}),
      headers: parseHeaders(source.id)
    })),
    vodSources: vodSources.value.map((source) => ({
      id: source.id,
      name: source.name.trim(),
      api: source.api.trim(),
      type: source.type,
      enabled: source.enabled,
      note: source.note,
      ...(source.managedBy ? { managedBy: source.managedBy } : {}),
      headers: parseHeaders(source.id)
    })),
    subscriptions: subscriptions.value.map((item) => ({
      id: item.id,
      name: item.name.trim(),
      url: item.url.trim(),
      enabled: item.enabled,
      note: item.note,
      lastSyncAt: item.lastSyncAt,
      lastError: item.lastError,
      vodCount: item.vodCount,
      liveCount: item.liveCount
    }))
  }
}

async function save(): Promise<boolean> {
  const problem = validate()
  if (problem) {
    toast.error(problem)
    return false
  }
  saving.value = true
  try {
    await api.adminSaveConfig(buildPayload())
    snapshot.value = signature.value
    toast.success('配置已保存，客户端刷新后生效')
    return true
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : '保存失败')
    return false
  } finally {
    saving.value = false
  }
}

async function ensureSaved(): Promise<boolean> {
  if (!dirty.value) return true
  const ok = await save()
  return ok && !dirty.value
}

function uniqueId(prefix: string): string {
  const base = `${prefix}-${Date.now().toString(36)}`
  const ids = new Set([...liveSources.value, ...vodSources.value].map((item) => item.id))
  let candidate = base
  let index = 1
  while (ids.has(candidate)) candidate = `${base}${index++}`
  return candidate
}

function addLive() {
  const id = uniqueId('live')
  liveSources.value.push({
    id,
    name: '新直播源',
    url: '',
    type: 'auto',
    enabled: true,
    note: '',
    headers: {}
  })
  headersText[id] = ''
}

function addVod() {
  const id = uniqueId('vod')
  vodSources.value.push({
    id,
    name: '新影视源',
    api: '',
    type: 'maccms',
    enabled: true,
    note: '',
    headers: {}
  })
  headersText[id] = ''
}

function removeLive(index: number) {
  const source = liveSources.value[index]
  if (!window.confirm(`确定删除直播源「${source.name}」吗？`)) return
  liveSources.value.splice(index, 1)
  delete headersText[source.id]
}

function removeVod(index: number) {
  const source = vodSources.value[index]
  if (!window.confirm(`确定删除影视源「${source.name}」吗？`)) return
  vodSources.value.splice(index, 1)
  delete headersText[source.id]
}

function move(list: { id: string }[], index: number, delta: number) {
  const target = index + delta
  if (target < 0 || target >= list.length) return
  const [item] = list.splice(index, 1)
  list.splice(target, 0, item)
}

async function testLive(source: LiveSourceEdit) {
  if (!/^https?:\/\//i.test(source.url.trim())) {
    toast.error('请先填写有效的直播源地址')
    return
  }
  testingId.value = source.id
  testResults[source.id] = ''
  try {
    const result = await api.adminTestLive(
      source.url.trim(),
      source.type,
      parseHeaders(source.id, false)
    )
    testResults[source.id] = `解析到 ${result.count} 个频道 · ${result.groups
      .slice(0, 4)
      .map((group) => `${group.name}(${group.count})`)
      .join('，')}`
    toast.success('直播源可用')
  } catch (caught) {
    testResults[source.id] = caught instanceof Error ? caught.message : '测试失败'
    toast.error('直播源测试失败')
  } finally {
    testingId.value = ''
  }
}

async function testVod(source: VodSourceEdit) {
  if (!/^https?:\/\//i.test(source.api.trim())) {
    toast.error('请先填写有效的接口地址')
    return
  }
  testingId.value = source.id
  testResults[source.id] = ''
  try {
    const result = await api.adminTestVod(
      source.api.trim(),
      parseHeaders(source.id, false),
      source.type
    )
    testResults[source.id] = `接口正常 · ${result.categoryCount} 个分类 · ${result.sample
      .slice(0, 3)
      .join(' / ')}`
    toast.success('影视接口可用')
  } catch (caught) {
    testResults[source.id] = caught instanceof Error ? caught.message : '测试失败'
    toast.error('影视接口测试失败')
  } finally {
    testingId.value = ''
  }
}

async function changePassword() {
  if (newPassword.value.length < 6) {
    toast.error('新密码至少 6 位')
    return
  }
  if (newPassword.value !== newPassword2.value) {
    toast.error('两次输入的新密码不一致')
    return
  }
  passwordLoading.value = true
  try {
    await api.adminChangePassword(newPassword.value)
    newPassword.value = ''
    newPassword2.value = ''
    toast.success('密码已更新，请重新登录')
    authed.value = false
    snapshot.value = ''
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : '修改密码失败')
  } finally {
    passwordLoading.value = false
  }
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success('已复制')
  } catch {
    toast.info(text)
  }
}

function exportConfig() {
  const problem = validate()
  if (problem) {
    toast.error(problem)
    return
  }
  const blob = new Blob([JSON.stringify(buildPayload(), null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'kaytv-sources.json'
  link.click()
  URL.revokeObjectURL(url)
}

function triggerImport() {
  fileInput.value?.click()
}

async function importConfig(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    const text = await file.text()
    const parsed = JSON.parse(text) as {
      siteName?: string
      liveSources?: LiveSourceEdit[]
      vodSources?: VodSourceEdit[]
    }
    if (!Array.isArray(parsed.liveSources) || !Array.isArray(parsed.vodSources)) {
      throw new Error('文件缺少 liveSources 或 vodSources')
    }
    siteName.value = parsed.siteName || siteName.value
    liveSources.value = parsed.liveSources.map(normalizeLive)
    vodSources.value = parsed.vodSources.map(normalizeVod)
    for (const key of Object.keys(headersText)) delete headersText[key]
    for (const source of [...liveSources.value, ...vodSources.value]) {
      headersText[source.id] = source.headers && Object.keys(source.headers).length
        ? JSON.stringify(source.headers)
        : ''
    }
    toast.success('已导入到编辑区，点击保存后生效')
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : '导入失败')
  }
}

const healthItems = computed(() => {
  const items = health.value?.items || []
  const filtered =
    healthFilter.value === 'failed' ? items.filter((item) => !item.ok && !item.skipped) : items
  return [...filtered].sort(
    (a, b) => Number(a.skipped) - Number(b.skipped) || Number(a.ok) - Number(b.ok) || b.checkedAt - a.checkedAt
  )
})

function formatTime(ts: number): string {
  if (!ts) return '尚未检测'
  const date = new Date(ts)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

async function loadHealth() {
  if (!isAdmin.value) return
  healthLoading.value = true
  try {
    health.value = await api.adminHealth()
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : '读取源状态失败')
  } finally {
    healthLoading.value = false
  }
}

async function runHealthCheck() {
  healthChecking.value = true
  try {
    health.value = await api.adminCheckHealth()
    toast.success(`检测完成：${health.value.healthy}/${health.value.checked} 个源可用`)
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : '检测失败')
  } finally {
    healthChecking.value = false
  }
}

async function loadUsers() {
  if (!isAdmin.value) return
  usersLoading.value = true
  try {
    const result = await api.adminUsers()
    users.value = result.users
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : '读取用户失败')
  } finally {
    usersLoading.value = false
  }
}

async function createUser() {
  const name = userForm.username.trim()
  if (!/^[a-zA-Z0-9_.-]{2,32}$/.test(name)) {
    toast.error('账号需为 2-32 位字母、数字、下划线、点或横线')
    return
  }
  if (userForm.password.length < 6) {
    toast.error('初始密码至少 6 位')
    return
  }
  userSaving.value = true
  try {
    await api.adminCreateUser({
      username: name,
      password: userForm.password,
      displayName: userForm.displayName.trim() || name,
      role: userForm.role
    })
    userForm.username = ''
    userForm.password = ''
    userForm.displayName = ''
    userForm.role = 'viewer'
    await loadUsers()
    toast.success('用户已创建')
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : '创建用户失败')
  } finally {
    userSaving.value = false
  }
}

async function toggleUser(user: AdminUser, enabled: boolean) {
  try {
    await api.adminUpdateUser(user.id, { enabled })
    await loadUsers()
    toast.success(enabled ? '用户已启用' : '用户已停用')
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : '修改失败')
  }
}

async function changeRole(user: AdminUser, role: string) {
  try {
    await api.adminUpdateUser(user.id, { role: role === 'admin' ? 'admin' : 'viewer' })
    await loadUsers()
    toast.success('角色已更新')
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : '修改失败')
  }
}

async function resetUserPassword(user: AdminUser) {
  const next = window.prompt(`为「${user.displayName || user.username}」设置新密码（至少 6 位）`)
  if (next === null) return
  if (next.length < 6) {
    toast.error('密码至少 6 位')
    return
  }
  try {
    await api.adminUpdateUser(user.id, { password: next })
    toast.success('密码已重置，该用户的登录状态已失效')
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : '重置密码失败')
  }
}

async function removeUser(user: AdminUser) {
  if (!window.confirm(`确定删除用户「${user.displayName || user.username}」吗？`)) return
  try {
    await api.adminDeleteUser(user.id)
    await loadUsers()
    toast.success('用户已删除')
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : '删除失败')
  }
}

function addSubscription() {
  const name = subForm.name.trim()
  const url = subForm.url.trim()
  if (!name) {
    toast.error('请填写订阅名称')
    return
  }
  if (!/^https?:\/\//i.test(url)) {
    toast.error('订阅地址需要是 http(s) 链接')
    return
  }
  subscriptions.value.push(
    normalizeSubscription({
      id: `sub-custom-${Date.now().toString(36)}`,
      name,
      url,
      enabled: true,
      note: '自定义订阅'
    })
  )
  subForm.name = ''
  subForm.url = ''
  toast.info('订阅已添加，保存后可立即同步')
}

function removeSubscription(index: number) {
  const item = subscriptions.value[index]
  const managed = [liveSources.value, vodSources.value].reduce(
    (sum, list) => sum + list.filter((source) => source.managedBy === item.id).length,
    0
  )
  const extra = managed ? `，同时移除其导入的 ${managed} 个源` : ''
  if (!window.confirm(`确定删除订阅「${item.name}」${extra}？`)) return
  subscriptions.value.splice(index, 1)
  liveSources.value = liveSources.value.filter((source) => source.managedBy !== item.id)
  vodSources.value = vodSources.value.filter((source) => source.managedBy !== item.id)
  delete previewResults[item.id]
}

async function previewSubscription(item: Subscription) {
  previewing.value = item.id
  previewResults[item.id] = ''
  try {
    const result = await api.adminPreviewSubscription(item.url.trim())
    previewResults[item.id] =
      `可导入影视 ${result.vod.length} 个、直播 ${result.live.length} 个。` +
      (result.vod.length
        ? ` 影视：${result.vod.slice(0, 4).map((entry) => entry.name).join(' / ')}`
        : '')
    toast.success(`订阅可导入 ${result.vod.length + result.live.length} 个源`)
  } catch (caught) {
    previewResults[item.id] = caught instanceof Error ? caught.message : '预览失败'
    toast.error('订阅预览失败')
  } finally {
    previewing.value = ''
  }
}

async function syncSubscription(item: Subscription | null) {
  if (!(await ensureSaved())) return
  const id = item?.id || ''
  syncingId.value = id || 'all'
  try {
    const result = await api.adminSyncSubscriptions(id)
    const okResults = result.results.filter((entry) => entry.ok)
    const vod = okResults.reduce((sum, entry) => sum + (entry.vod || 0), 0)
    const live = okResults.reduce((sum, entry) => sum + (entry.live || 0), 0)
    const failed = result.results.filter((entry) => !entry.ok)
    await loadConfig()
    if (health.value) void loadHealth()
    if (failed.length) {
      toast.error(`${failed.length} 个订阅同步失败：${failed[0].name} ${failed[0].error || ''}`)
    } else {
      toast.success(`同步完成：影视 ${vod} 个、直播 ${live} 个`)
    }
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : '同步失败')
  } finally {
    syncingId.value = ''
  }
}

watch(tab, (value) => {
  if (!isAdmin.value) return
  if (value === 'health') void loadHealth()
  if (value === 'users') void loadUsers()
})

onMounted(checkSession)
</script>

<template>
  <div class="admin-shell">
    <header class="admin-header">
      <RouterLink class="brand" to="/">
        <span class="brand-mark"><AppIcon name="play" :size="20" /></span>
        <span class="brand-text">
          <span class="brand-name">KayTV</span>
          <span class="brand-sub">管理后台</span>
        </span>
      </RouterLink>

      <div v-if="authed" class="admin-header-right">
        <span v-if="sessionName" class="session-chip">{{ sessionName }}<template v-if="!isAdmin"> · 普通用户</template></span>
        <span v-if="dirty && isAdmin" class="dirty-dot">有未保存的修改</span>
        <button v-if="isAdmin" class="btn primary" data-nav :disabled="!dirty || saving" @click="save">
          {{ saving ? '保存中…' : '保存更改' }}
        </button>
        <RouterLink class="btn ghost" to="/" data-nav>返回前台</RouterLink>
        <button class="btn ghost" data-nav @click="logout">退出登录</button>
      </div>
    </header>

    <div v-if="checking" class="admin-center">
      <span class="spinner" />
      正在检查登录状态…
    </div>

    <div v-else-if="!authed" class="login-wrap">
      <form class="panel login-card" @submit.prevent="login">
        <h1 class="login-title">登录管理后台</h1>
        <p class="login-desc">
          主管理员账号为 <code>admin</code>，密码在服务端首次启动时打印在容器日志中，也可通过环境变量
          <code>ADMIN_PASSWORD</code> 指定。
        </p>
        <input
          v-model="username"
          class="input"
          type="text"
          placeholder="账号"
          autocomplete="username"
          spellcheck="false"
        />
        <input
          v-model="password"
          class="input"
          type="password"
          placeholder="密码"
          autocomplete="current-password"
        />
        <p v-if="loginError" class="login-error">{{ loginError }}</p>
        <button class="btn primary login-btn" data-nav type="submit" :disabled="loginLoading">
          {{ loginLoading ? '登录中…' : '登录' }}
        </button>
      </form>
    </div>

    <div v-else-if="!isAdmin" class="admin-center viewer-wrap">
      <div class="panel viewer-card">
        <h2 class="admin-title">当前账号没有管理权限</h2>
        <p class="admin-desc">
          {{ sessionName }} 是普通用户，可以回到前台观看直播与影视。需要管理源、用户或订阅，请使用管理员账号登录。
        </p>
        <div class="backup-actions">
          <RouterLink class="btn primary" to="/" data-nav>返回前台观看</RouterLink>
          <button class="btn ghost" data-nav @click="logout">退出登录</button>
        </div>
      </div>
    </div>

    <template v-else>
      <nav class="admin-tabs">
        <button class="admin-tab" :class="{ active: tab === 'live' }" data-nav @click="tab = 'live'">
          <AppIcon name="tv" :size="16" />
          直播源
          <span class="tab-count">{{ liveSources.length }}</span>
        </button>
        <button class="admin-tab" :class="{ active: tab === 'vod' }" data-nav @click="tab = 'vod'">
          <AppIcon name="film" :size="16" />
          影视源
          <span class="tab-count">{{ vodSources.length }}</span>
        </button>
        <button class="admin-tab" :class="{ active: tab === 'health' }" data-nav @click="tab = 'health'">
          <AppIcon name="refresh" :size="16" />
          源检测
          <span class="tab-count">{{ health ? `${health.healthy}/${health.checked}` : '—' }}</span>
        </button>
        <button class="admin-tab" :class="{ active: tab === 'subscriptions' }" data-nav @click="tab = 'subscriptions'">
          <AppIcon name="rss" :size="16" />
          订阅同步
          <span class="tab-count">{{ subscriptions.length }}</span>
        </button>
        <button class="admin-tab" :class="{ active: tab === 'users' }" data-nav @click="tab = 'users'">
          <AppIcon name="users" :size="16" />
          用户
        </button>
        <button class="admin-tab" :class="{ active: tab === 'site' }" data-nav @click="tab = 'site'">
          <AppIcon name="settings" :size="16" />
          站点设置
        </button>
        <button class="admin-tab" :class="{ active: tab === 'access' }" data-nav @click="tab = 'access'">
          <AppIcon name="server" :size="16" />
          接入与备份
        </button>
      </nav>

      <div class="admin-content">
        <div v-if="loadingConfig" class="admin-center">
          <span class="spinner" />
          正在读取配置…
        </div>

        <template v-else>
          <section v-if="tab === 'live'" class="admin-section">
            <div class="admin-section-head">
              <div>
                <h2 class="admin-title">直播源</h2>
                <p class="admin-desc">
                  支持 m3u / txt 直播列表，服务端解析后统一走签名代理，播放器无需处理跨域。
                </p>
              </div>
              <button class="btn" data-nav @click="addLive">
                <AppIcon name="plus" :size="16" />
                添加直播源
              </button>
            </div>

            <div v-for="(source, index) in liveSources" :key="source.id" class="admin-card">
              <div class="admin-card-head">
                <div class="admin-card-title">
                  <input v-model="source.name" class="input name-input" placeholder="源名称" />
                  <span class="badge">{{ source.id }}</span>
                  <span v-if="source.note" class="badge note-badge">{{ source.note }}</span>
                  <span v-if="source.managedBy" class="badge managed-badge">订阅导入</span>
                </div>
                <div class="admin-card-actions">
                  <button
                    class="switch"
                    :class="{ on: source.enabled }"
                    data-nav
                    role="switch"
                    :aria-checked="source.enabled"
                    @click="source.enabled = !source.enabled"
                  >
                    <span class="knob" />
                  </button>
                  <button class="btn sm ghost" data-nav :disabled="index === 0" @click="move(liveSources, index, -1)">上移</button>
                  <button class="btn sm ghost" data-nav :disabled="index === liveSources.length - 1" @click="move(liveSources, index, 1)">下移</button>
                  <button class="btn sm danger" data-nav @click="removeLive(index)">删除</button>
                </div>
              </div>

              <div class="admin-fields">
                <label class="field">
                  <span>列表地址</span>
                  <input v-model="source.url" class="input" placeholder="https://example.com/iptv.m3u" spellcheck="false" />
                </label>
                <label class="field small">
                  <span>格式</span>
                  <select v-model="source.type" class="input">
                    <option value="auto">自动识别</option>
                    <option value="m3u">M3U</option>
                    <option value="txt">TXT</option>
                  </select>
                </label>
                <label class="field">
                  <span>请求头（可选 JSON）</span>
                  <input v-model="headersText[source.id]" class="input" placeholder='{"Referer":"https://example.com/"}' spellcheck="false" />
                </label>
              </div>

              <div class="admin-card-foot">
                <button class="btn sm" data-nav :disabled="testingId === source.id" @click="testLive(source)">
                  {{ testingId === source.id ? '测试中…' : '测试连通' }}
                </button>
                <span class="test-result">{{ testResults[source.id] }}</span>
              </div>
            </div>

            <p v-if="!liveSources.length" class="admin-empty">还没有直播源，点击右上角添加。</p>
          </section>

          <section v-else-if="tab === 'vod'" class="admin-section">
            <div class="admin-section-head">
              <div>
                <h2 class="admin-title">影视源</h2>
                <p class="admin-desc">
                  苹果CMS v10 采集接口或看剧AI 直连接口。支持多源并行搜索、分类浏览与签名代理播放。
                </p>
              </div>
              <button class="btn" data-nav @click="addVod">
                <AppIcon name="plus" :size="16" />
                添加影视源
              </button>
            </div>

            <div v-for="(source, index) in vodSources" :key="source.id" class="admin-card">
              <div class="admin-card-head">
                <div class="admin-card-title">
                  <input v-model="source.name" class="input name-input" placeholder="源名称" />
                  <span class="badge">{{ source.id }}</span>
                  <span v-if="source.note" class="badge note-badge">{{ source.note }}</span>
                  <span v-if="source.managedBy" class="badge managed-badge">订阅导入</span>
                </div>
                <div class="admin-card-actions">
                  <button
                    class="switch"
                    :class="{ on: source.enabled }"
                    data-nav
                    role="switch"
                    :aria-checked="source.enabled"
                    @click="source.enabled = !source.enabled"
                  >
                    <span class="knob" />
                  </button>
                  <button class="btn sm ghost" data-nav :disabled="index === 0" @click="move(vodSources, index, -1)">上移</button>
                  <button class="btn sm ghost" data-nav :disabled="index === vodSources.length - 1" @click="move(vodSources, index, 1)">下移</button>
                  <button class="btn sm danger" data-nav @click="removeVod(index)">删除</button>
                </div>
              </div>

              <div class="admin-fields">
                <label class="field">
                  <span>接口类型</span>
                  <select v-model="source.type" class="input">
                    <option value="maccms">苹果CMS v10</option>
                    <option value="kanju">看剧AI</option>
                  </select>
                </label>
                <label class="field">
                  <span>接口地址</span>
                  <input v-model="source.api" class="input" placeholder="https://example.com/api.php/provide/vod" spellcheck="false" />
                </label>
                <label class="field">
                  <span>请求头（可选 JSON）</span>
                  <input v-model="headersText[source.id]" class="input" placeholder='{"User-Agent":"...","Referer":"..."}' spellcheck="false" />
                </label>
              </div>

              <div class="admin-card-foot">
                <button class="btn sm" data-nav :disabled="testingId === source.id" @click="testVod(source)">
                  {{ testingId === source.id ? '测试中…' : '测试连通' }}
                </button>
                <span class="test-result">{{ testResults[source.id] }}</span>
              </div>
            </div>

            <p v-if="!vodSources.length" class="admin-empty">还没有影视源，点击右上角添加。</p>
          </section>

          <section v-else-if="tab === 'health'" class="admin-section">
            <div class="admin-section-head">
              <div>
                <h2 class="admin-title">源检测</h2>
                <p class="admin-desc">
                  每天 04:10 自动检测全部启用的直播源与影视源，并先同步订阅。检测失败的源会在 24 小时内从分类、搜索与海报墙中暂时排除，避免拖慢加载。
                </p>
              </div>
              <div class="head-actions">
                <button class="btn" data-nav :disabled="healthLoading || healthChecking" @click="loadHealth">
                  刷新
                </button>
                <button class="btn primary" data-nav :disabled="healthChecking" @click="runHealthCheck">
                  {{ healthChecking ? '检测中，最多几分钟…' : '立即检测全部' }}
                </button>
              </div>
            </div>

            <div v-if="health" class="stat-row">
              <div class="stat-card">
                <span class="stat-value">{{ health.healthy }}<small>/{{ health.checked }}</small></span>
                <span class="stat-label">可用源</span>
              </div>
              <div class="stat-card">
                <span class="stat-value">{{ health.enabled }}</span>
                <span class="stat-label">启用源</span>
              </div>
              <div class="stat-card">
                <span class="stat-value small">{{ formatTime(health.updatedAt) }}</span>
                <span class="stat-label">上次检测</span>
              </div>
              <div class="stat-card">
                <span class="stat-value small">{{ formatTime(health.nextRunAt) }}</span>
                <span class="stat-label">下次自动检测</span>
              </div>
            </div>

            <div class="filter-row">
              <button
                class="chip"
                :class="{ active: healthFilter === 'all' }"
                data-nav
                @click="healthFilter = 'all'"
              >
                全部源
              </button>
              <button
                class="chip"
                :class="{ active: healthFilter === 'failed' }"
                data-nav
                @click="healthFilter = 'failed'"
              >
                仅看失败
              </button>
            </div>

            <div v-if="healthLoading && !health" class="admin-center">
              <span class="spinner" />
              正在读取检测结果…
            </div>
            <p v-else-if="!healthItems.length" class="admin-empty">
              {{ healthFilter === 'failed' ? '没有检测失败的源。' : '还没有检测记录，点击「立即检测全部」开始。' }}
            </p>
            <div v-else class="health-list">
              <div v-for="item in healthItems" :key="`${item.kind}:${item.id}`" class="health-row">
                <span class="status-dot" :class="{ online: item.ok }" />
                <div class="health-main">
                  <div class="health-name">
                    {{ item.name }}
                    <span class="badge">{{ item.kind === 'live' ? '直播' : '影视' }}</span>
                    <span class="badge id-badge">{{ item.id }}</span>
                    <span v-if="item.traits?.shortDrama" class="badge note-badge">短剧</span>
                    <span v-if="item.traits?.variety" class="badge note-badge">综艺</span>
                  </div>
                  <div class="health-detail">{{ item.detail || '—' }}</div>
                </div>
                <div class="health-meta">
                  <span v-if="item.skipped" class="health-badge skip">已停用</span>
                  <span v-else class="health-badge" :class="item.ok ? 'ok' : 'fail'">
                    {{ item.ok ? '可用' : '失败' }}
                  </span>
                  <span v-if="!item.skipped && item.latency" class="health-latency">{{ item.latency }} ms</span>
                </div>
              </div>
            </div>
          </section>

          <section v-else-if="tab === 'subscriptions'" class="admin-section">
            <div class="admin-section-head">
              <div>
                <h2 class="admin-title">订阅同步</h2>
                <p class="admin-desc">
                  支持 TVBox 配置、资源合集 JSON 与采集接口数组，自动抽取可直连的苹果CMS源。每天 04:10 会自动同步；导入的源会标记为「订阅导入」，同步不会覆盖你手动改过的开关。
                </p>
              </div>
              <button
                class="btn primary"
                data-nav
                :disabled="!!syncingId || !subscriptions.length"
                @click="syncSubscription(null)"
              >
                {{ syncingId === 'all' ? '同步中…' : '同步全部' }}
              </button>
            </div>

            <div class="panel">
              <h3 class="panel-title">添加订阅</h3>
              <p class="panel-desc">添加后点击「保存更改」，再点「立即同步」即可导入源。</p>
              <div class="sub-form">
                <input v-model="subForm.name" class="input" maxlength="40" placeholder="订阅名称，例如 追剧合集" />
                <input
                  v-model="subForm.url"
                  class="input"
                  placeholder="https://example.com/tvbox.json"
                  spellcheck="false"
                />
                <button class="btn" data-nav @click="addSubscription">
                  <AppIcon name="plus" :size="16" />
                  添加订阅
                </button>
              </div>
            </div>

            <div v-for="(item, index) in subscriptions" :key="item.id" class="admin-card">
              <div class="admin-card-head">
                <div class="admin-card-title">
                  <input v-model="item.name" class="input name-input" placeholder="订阅名称" />
                  <span class="badge">{{ item.id }}</span>
                  <span v-if="item.note" class="badge note-badge">{{ item.note }}</span>
                </div>
                <div class="admin-card-actions">
                  <button
                    class="switch"
                    :class="{ on: item.enabled }"
                    data-nav
                    role="switch"
                    :aria-checked="item.enabled"
                    @click="item.enabled = !item.enabled"
                  >
                    <span class="knob" />
                  </button>
                  <button
                    class="btn sm ghost"
                    data-nav
                    :disabled="previewing === item.id"
                    @click="previewSubscription(item)"
                  >
                    {{ previewing === item.id ? '预览中…' : '预览' }}
                  </button>
                  <button
                    class="btn sm"
                    data-nav
                    :disabled="!!syncingId"
                    @click="syncSubscription(item)"
                  >
                    {{ syncingId === item.id ? '同步中…' : '立即同步' }}
                  </button>
                  <button class="btn sm danger" data-nav @click="removeSubscription(index)">删除</button>
                </div>
              </div>

              <label class="field sub-url">
                <span>订阅地址</span>
                <input v-model="item.url" class="input" spellcheck="false" />
              </label>

              <div class="sub-meta">
                <span>上次同步：{{ formatTime(item.lastSyncAt) }}</span>
                <span>导入影视 {{ item.vodCount }} 个 · 直播 {{ item.liveCount }} 个</span>
              </div>
              <p v-if="item.lastError" class="sub-error">{{ item.lastError }}</p>
              <p v-if="previewResults[item.id]" class="test-result">{{ previewResults[item.id] }}</p>
            </div>

            <p v-if="!subscriptions.length" class="admin-empty">还没有订阅，先在上方添加一个。</p>
          </section>

          <section v-else-if="tab === 'users'" class="admin-section">
            <div class="admin-section-head">
              <div>
                <h2 class="admin-title">用户</h2>
                <p class="admin-desc">
                  「普通用户」只能观看；「管理员」可以进入本后台。把站点访问模式切换为「登录观看」后，只有登录账号才能播放。
                </p>
              </div>
            </div>

            <div class="panel">
              <h3 class="panel-title">新建用户</h3>
              <div class="user-form">
                <label class="field">
                  <span>账号</span>
                  <input v-model="userForm.username" class="input" placeholder="2-32 位字母数字" spellcheck="false" />
                </label>
                <label class="field">
                  <span>显示名称</span>
                  <input v-model="userForm.displayName" class="input" maxlength="24" placeholder="例如 客厅电视" />
                </label>
                <label class="field">
                  <span>初始密码</span>
                  <input v-model="userForm.password" class="input" type="password" autocomplete="new-password" placeholder="至少 6 位" />
                </label>
                <label class="field small">
                  <span>角色</span>
                  <select v-model="userForm.role" class="input">
                    <option value="viewer">普通用户</option>
                    <option value="admin">管理员</option>
                  </select>
                </label>
                <button class="btn primary" data-nav :disabled="userSaving" @click="createUser">
                  {{ userSaving ? '创建中…' : '创建用户' }}
                </button>
              </div>
            </div>

            <div class="panel">
              <h3 class="panel-title">账号列表</h3>
              <div v-if="usersLoading" class="admin-center">
                <span class="spinner" />
                正在读取用户…
              </div>
              <div v-else class="user-list">
                <div v-for="user in users" :key="user.id" class="user-row">
                  <span class="status-dot" :class="{ online: user.enabled }" />
                  <div class="user-main">
                    <span class="user-name">{{ user.displayName }}</span>
                    <span class="badge">{{ user.username }}</span>
                    <span class="badge role-badge">{{ user.role === 'admin' ? '管理员' : '普通用户' }}</span>
                    <span v-if="user.builtin" class="badge">内置</span>
                    <span v-if="!user.enabled" class="badge">已停用</span>
                  </div>
                  <span class="user-last">登录：{{ formatTime(user.lastLoginAt) }}</span>
                  <div v-if="!user.builtin" class="user-actions">
                    <button
                      class="switch"
                      :class="{ on: user.enabled }"
                      data-nav
                      role="switch"
                      :aria-checked="user.enabled"
                      @click="toggleUser(user, !user.enabled)"
                    >
                      <span class="knob" />
                    </button>
                    <button
                      class="btn sm ghost"
                      data-nav
                      @click="changeRole(user, user.role === 'admin' ? 'viewer' : 'admin')"
                    >
                      {{ user.role === 'admin' ? '降为普通用户' : '设为管理员' }}
                    </button>
                    <button class="btn sm ghost" data-nav @click="resetUserPassword(user)">重置密码</button>
                    <button class="btn sm danger" data-nav @click="removeUser(user)">删除</button>
                  </div>
                  <span v-else class="user-last">密码在「站点设置」修改</span>
                </div>
              </div>
            </div>
          </section>

          <section v-else-if="tab === 'site'" class="admin-section">
            <div class="admin-section-head">
              <div>
                <h2 class="admin-title">站点设置</h2>
                <p class="admin-desc">站点名称会显示在电视与手机客户端顶部。</p>
              </div>
            </div>

            <div class="panel site-panel">
              <label class="field">
                <span>站点名称</span>
                <input v-model="siteName" class="input" maxlength="24" placeholder="KayTV" />
              </label>
            </div>

            <div class="panel site-panel">
              <h3 class="panel-title">访问控制</h3>
              <p class="panel-desc">
                公开观看：任何人打开地址即可播放；登录观看：需要账号密码，适合分享给家人或朋友。
              </p>
              <div class="seg-row">
                <button
                  class="seg"
                  :class="{ active: accessMode === 'public' }"
                  data-nav
                  @click="accessMode = 'public'"
                >
                  公开观看
                </button>
                <button
                  class="seg"
                  :class="{ active: accessMode === 'login' }"
                  data-nav
                  @click="accessMode = 'login'"
                >
                  登录观看
                </button>
              </div>
              <p v-if="accessMode === 'login'" class="tip">
                开启前请先在「用户」页创建观看账号；修改后点击右上角「保存更改」生效，已登录的账号不受影响。
              </p>
            </div>

            <div class="panel site-panel">
              <div class="setting-head">
                <div>
                  <h3 class="panel-title">每日自动更新</h3>
                  <p class="panel-desc">
                    每天 04:10 自动同步全部订阅并检测源可用性，无需手动维护。关闭后只保留手动「同步全部」和「立即检测」。
                  </p>
                </div>
                <button
                  class="switch"
                  :class="{ on: autoCheck }"
                  data-nav
                  role="switch"
                  :aria-checked="autoCheck"
                  @click="autoCheck = !autoCheck"
                >
                  <span class="knob" />
                </button>
              </div>
            </div>

            <div class="panel site-panel">
              <h3 class="panel-title">修改管理密码</h3>
              <p class="panel-desc">
                {{ envPassword ? '当前密码由 ADMIN_PASSWORD 环境变量固定，请修改环境变量后重启容器。' : '修改后会退出所有已登录会话。' }}
              </p>
              <div class="password-row">
                <input
                  v-model="newPassword"
                  class="input"
                  type="password"
                  placeholder="新密码（至少 6 位）"
                  autocomplete="new-password"
                  :disabled="envPassword"
                />
                <input
                  v-model="newPassword2"
                  class="input"
                  type="password"
                  placeholder="再次输入"
                  autocomplete="new-password"
                  :disabled="envPassword"
                />
                <button class="btn" data-nav :disabled="envPassword || passwordLoading" @click="changePassword">
                  {{ passwordLoading ? '提交中…' : '修改密码' }}
                </button>
              </div>
            </div>
          </section>

          <section v-else class="admin-section">
            <div class="admin-section-head">
              <div>
                <h2 class="admin-title">接入与备份</h2>
                <p class="admin-desc">把服务地址填进客户端，或在多台 NAS 之间迁移源配置。</p>
              </div>
            </div>

            <div class="panel access-panel">
              <h3 class="panel-title">客户端服务地址</h3>
              <p class="panel-desc">电视、手机、Windows 客户端在「设置 → 服务端连接」填入该地址。</p>
              <div class="copy-row">
                <code>{{ origin }}</code>
                <button class="btn sm" data-nav @click="copy(origin)">复制</button>
              </div>
              <div class="copy-row">
                <code>{{ origin }}/api/config</code>
                <button class="btn sm" data-nav @click="copy(`${origin}/api/config`)">复制配置地址</button>
              </div>
              <p class="tip">
                客户端内置默认源；连上服务端后以本页启用的源为准。修改源后客户端进入设置点「同步源列表」即可。
              </p>
            </div>

            <div class="panel access-panel">
              <h3 class="panel-title">部署提示</h3>
              <p class="panel-desc">
                在 NAS 上用 Docker Compose 启动本服务，数据保存在容器的 <code>/data</code> 目录。
                管理密码首次启动时打印在 <code>docker logs kaytv</code> 中。
              </p>
              <pre class="code-block">services:
  kaytv:
    image: ghcr.io/&lt;你的仓库&gt;/kaytv:latest
    container_name: kaytv
    ports:
      - "8080:8080"
    volumes:
      - ./data:/data
    environment:
      - DATA_DIR=/data
    restart: unless-stopped</pre>
            </div>

            <div class="panel access-panel">
              <h3 class="panel-title">导入 / 导出</h3>
              <p class="panel-desc">导出当前源配置为 JSON 备份；导入后需要点击右上角「保存更改」才会生效。</p>
              <div class="backup-actions">
                <button class="btn" data-nav @click="exportConfig">导出配置</button>
                <button class="btn" data-nav @click="triggerImport">导入配置</button>
                <input ref="fileInput" class="hidden-input" type="file" accept="application/json,.json" @change="importConfig" />
              </div>
            </div>
          </section>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.admin-shell {
  min-height: 100vh;
  position: relative;
  z-index: 1;
}
.admin-header {
  position: sticky;
  top: 0;
  z-index: 40;
  height: var(--header-h);
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 0 clamp(18px, 3vw, 44px);
  background: rgba(8, 9, 12, 0.82);
  border-bottom: 1px solid var(--line);
  backdrop-filter: blur(20px);
}
.admin-header-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
}
.dirty-dot {
  font-size: 11.5px;
  color: var(--accent);
  margin-right: 2px;
}
.admin-center {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 90px 20px;
  color: var(--muted);
  font-size: 13px;
}
.login-wrap {
  display: flex;
  justify-content: center;
  padding: clamp(40px, 9vh, 100px) 20px;
}
.login-card {
  width: min(440px, 100%);
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 30px;
}
.login-title {
  margin: 0;
  font-size: 22px;
  font-weight: 680;
}
.login-desc {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--muted);
}
.login-desc code,
.admin-desc code,
.panel-desc code,
.tip code {
  padding: 1px 5px;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.07);
  font-size: 11.5px;
}
.login-btn {
  margin-top: 4px;
  min-height: 46px;
}
.login-error {
  margin: 0;
  font-size: 12.5px;
  color: #ffb3b3;
}
.admin-tabs {
  display: flex;
  gap: 6px;
  padding: 14px clamp(18px, 3vw, 44px) 0;
  overflow-x: auto;
  border-bottom: 1px solid var(--line);
  background: rgba(8, 9, 12, 0.4);
}
.admin-tab {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--muted);
  font-size: 13.5px;
  font-weight: 500;
  cursor: pointer;
  outline: none;
  white-space: nowrap;
  margin-bottom: -1px;
}
.admin-tab.active {
  color: var(--text);
  border-bottom-color: var(--accent);
}
.admin-tab:focus {
  color: var(--text);
  box-shadow: inset 0 0 0 2px var(--accent);
  border-radius: 8px 8px 0 0;
}
.tab-count {
  padding: 1px 7px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.07);
  font-size: 10.5px;
  color: var(--muted);
}
.admin-content {
  max-width: 1280px;
  margin: 0 auto;
  padding: 26px clamp(18px, 3vw, 44px) 90px;
}
.admin-section {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.admin-section-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 6px;
}
.admin-title {
  margin: 0;
  font-size: 22px;
  font-weight: 660;
}
.admin-desc {
  margin: 5px 0 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--muted);
  max-width: 760px;
}
.admin-card {
  border: 1px solid var(--line);
  border-radius: 16px;
  padding: 18px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.038), rgba(255, 255, 255, 0.012));
}
.admin-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
}
.admin-card-title {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 240px;
  flex: 1;
}
.name-input {
  max-width: 260px;
  height: 38px;
  font-size: 14px;
  font-weight: 600;
}
.admin-card-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.admin-fields {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr);
  gap: 12px;
  margin-top: 14px;
}
.admin-fields .field.small {
  max-width: 180px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.field > span {
  font-size: 11.5px;
  color: var(--muted);
}
.field .input {
  height: 40px;
  font-size: 13px;
}
select.input {
  appearance: none;
  cursor: pointer;
}
.admin-card-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 13px;
  flex-wrap: wrap;
}
.test-result {
  font-size: 11.5px;
  color: var(--muted);
  line-height: 1.5;
  min-width: 0;
  word-break: break-word;
}
.admin-empty {
  padding: 40px;
  text-align: center;
  color: var(--muted);
  font-size: 13px;
  border: 1px dashed var(--line-strong);
  border-radius: 16px;
}
.switch {
  position: relative;
  width: 44px;
  height: 26px;
  flex: none;
  border-radius: 999px;
  border: 1px solid var(--line-strong);
  background: rgba(255, 255, 255, 0.07);
  cursor: pointer;
  outline: none;
}
.switch .knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #aab2c0;
  transition: transform 0.18s ease;
}
.switch.on {
  background: rgba(229, 9, 20, 0.22);
  border-color: rgba(229, 9, 20, 0.45);
}
.switch.on .knob {
  transform: translateX(18px);
  background: var(--accent);
}
.switch:focus {
  box-shadow: 0 0 0 3px var(--accent);
}
.site-panel {
  margin-bottom: 14px;
}
.password-row {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 14px;
}
.password-row .input {
  flex: 1;
  min-width: 180px;
}
.access-panel {
  margin-bottom: 14px;
}
.copy-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.copy-row code {
  padding: 8px 12px;
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.055);
  font-size: 12.5px;
  color: rgba(242, 244, 248, 0.86);
  word-break: break-all;
}
.tip {
  margin: 14px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--muted);
}
.code-block {
  margin: 14px 0 0;
  padding: 16px;
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid var(--line);
  font-family: var(--font);
  font-size: 12px;
  line-height: 1.7;
  color: rgba(242, 244, 248, 0.82);
  overflow-x: auto;
  white-space: pre;
}
.backup-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.hidden-input {
  display: none;
}
.session-chip {
  font-size: 12px;
  color: var(--muted);
  margin-right: 4px;
}
.viewer-wrap {
  padding: 80px 20px;
}
.viewer-card {
  width: min(520px, 100%);
  padding: 28px;
}
.viewer-card .admin-desc {
  margin-top: 10px;
}
.head-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.stat-row {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.stat-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 16px 18px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.012));
}
.stat-value {
  font-size: 24px;
  font-weight: 640;
  font-variant-numeric: tabular-nums;
}
.stat-value small {
  font-size: 13px;
  font-weight: 500;
  color: var(--muted);
}
.stat-value.small {
  font-size: 15px;
  font-weight: 560;
}
.stat-label {
  font-size: 11.5px;
  color: var(--muted);
}
.filter-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.chip {
  padding: 7px 14px;
  border-radius: 999px;
  border: 1px solid var(--line-strong);
  background: rgba(255, 255, 255, 0.03);
  color: var(--muted);
  font-size: 12.5px;
  cursor: pointer;
}
.chip.active {
  color: var(--text);
  border-color: rgba(229, 9, 20, 0.55);
  background: rgba(229, 9, 20, 0.14);
}
.chip:focus-visible {
  outline: 2px solid var(--accent);
}
.health-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: 14px;
  overflow: hidden;
}
.health-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
}
.health-row:last-child {
  border-bottom: 0;
}
.health-main {
  flex: 1;
  min-width: 0;
}
.health-name {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 13.5px;
  font-weight: 560;
}
.health-detail {
  margin-top: 3px;
  font-size: 11.5px;
  color: var(--muted);
  word-break: break-word;
}
.health-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
}
.health-badge {
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 11px;
  border: 1px solid var(--line-strong);
  color: var(--muted);
}
.health-badge.ok {
  color: #9be7b7;
  border-color: rgba(110, 220, 160, 0.35);
  background: rgba(70, 180, 120, 0.12);
}
.health-badge.fail {
  color: #ffb3b3;
  border-color: rgba(255, 120, 120, 0.35);
  background: rgba(220, 80, 80, 0.12);
}
.health-badge.skip {
  color: var(--muted);
  background: rgba(255, 255, 255, 0.04);
}
.health-latency {
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  min-width: 52px;
  text-align: right;
}
.note-badge {
  color: rgba(242, 244, 248, 0.7);
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.managed-badge {
  color: #9be7b7;
  border-color: rgba(110, 220, 160, 0.3);
}
.id-badge {
  font-size: 10px;
  color: var(--muted);
}
.role-badge {
  color: rgba(255, 200, 130, 0.85);
}
.user-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr)) minmax(0, 1fr) 130px auto;
  gap: 12px;
  align-items: end;
  margin-top: 14px;
}
.user-form .field.small {
  min-width: 0;
}
.user-list {
  display: flex;
  flex-direction: column;
  margin-top: 12px;
  border: 1px solid var(--line);
  border-radius: 14px;
  overflow: hidden;
}
.user-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 16px;
  border-bottom: 1px solid var(--line);
  flex-wrap: wrap;
}
.user-row:last-child {
  border-bottom: 0;
}
.user-main {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  flex: 1;
  min-width: 220px;
}
.user-name {
  font-size: 13.5px;
  font-weight: 560;
}
.user-last {
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
}
.user-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.sub-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.8fr) auto;
  gap: 10px;
  margin-top: 14px;
}
.sub-form .input {
  height: 42px;
}
.sub-url {
  margin-top: 14px;
}
.sub-meta {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  margin-top: 12px;
  font-size: 11.5px;
  color: var(--muted);
}
.sub-error {
  margin: 8px 0 0;
  font-size: 11.5px;
  color: #ffb3b3;
  word-break: break-word;
}
.seg-row {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}
.seg {
  padding: 11px 20px;
  border-radius: 11px;
  border: 1px solid var(--line-strong);
  background: rgba(255, 255, 255, 0.03);
  color: var(--muted);
  font-size: 13px;
  cursor: pointer;
}
.seg.active {
  color: var(--text);
  border-color: rgba(229, 9, 20, 0.55);
  background: rgba(229, 9, 20, 0.14);
}
.seg:focus-visible {
  outline: 2px solid var(--accent);
}
.setting-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}
.setting-head .panel-desc {
  margin-bottom: 0;
}
@media (max-width: 980px) {
  .stat-row {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .user-form {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .sub-form {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 760px) {
  .admin-header {
    height: auto;
    min-height: 64px;
    flex-wrap: wrap;
    padding: 10px 14px;
    gap: 10px;
  }
  .admin-header-right {
    width: 100%;
    flex-wrap: wrap;
  }
  .admin-fields {
    grid-template-columns: 1fr;
  }
  .admin-fields .field.small {
    max-width: none;
  }
  .admin-section-head {
    flex-direction: column;
    align-items: flex-start;
  }
  .user-form {
    grid-template-columns: 1fr;
  }
}
</style>

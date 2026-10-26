<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useSettingsStore } from '../stores/settings'
import { useLibraryStore } from '../stores/library'
import { useCloudStore } from '../stores/cloud'
import { toast } from '../composables/useToast'
import AppIcon from '../components/AppIcon.vue'
import { runtime } from '../api/runtime'
import { probeLiveSource, probeVodSource, rememberHealth } from '../api/standalone'
import { copyText, diagnosticsText, recentEvents } from '../api/diagnostics'
import { checkForUpdate, hasUpdate, latestReleaseUrl, openExternal, preferredAsset, updateState } from '../api/updateCheck'
import { qrDataUrl } from '../api/qr'
import { addCustom, isCloudSource, removeCustom, type AddInput } from '../api/customSources'
import { importTvboxSource, type ImportResult } from '../api/tvboxImport'
import { liveProbes, probeOf, probeState, vodProbes, type ProbeKind } from '../composables/sourceProbeState'

const settings = useSettingsStore()
const library = useLibraryStore()
const cloud = useCloudStore()

const serverInput = ref(settings.serverUrl)
const testing = ref(false)
const syncing = ref(false)
const showServerForm = ref(false)

const importName = ref('')
const importUrl = ref('')
const importing = ref(false)
const importError = ref('')
const importResult = ref<ImportResult | null>(null)

const adminUrl = computed(() => `${settings.displayServer.replace(/\/+$/, '')}/admin`)
const favoriteCount = computed(() => library.favorites.length)
const historyCount = computed(() => Object.keys(library.history).length)
const selectedCount = computed(
  () => (importResult.value?.live.filter((item) => item.active).length || 0) +
    (importResult.value?.vod.filter((item) => item.active).length || 0)
)

const cloudInput = ref(cloud.endpoint)
const cloudSaving = ref(false)
const cloudAccountOpen = ref(false)
const cloudAuthing = ref(false)
const cloudUsername = ref('')
const cloudPassword = ref('')
const cloudInviteCode = ref('')
const cloudSessionsOpen = ref(false)
const cloudSessionsLoading = ref(false)

const cloudHost = computed(() => {
  try {
    return new URL(cloud.endpoint).host
  } catch {
    return cloud.endpoint || '未配置'
  }
})
const cloudSyncLabel = computed(() => {
  if (!cloud.lastSyncAt) return ''
  const date = new Date(cloud.lastSyncAt)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
})

async function saveCloud() {
  cloudSaving.value = true
  try {
    await cloud.setEndpoint(cloudInput.value)
    if (cloud.online) {
      toast.success(`已连接 ${cloud.siteName}：${cloud.sourceCount} 个云源，${cloud.banner ? '有 1 条公告' : '暂无公告'}`)
    } else {
      toast.error(cloud.error || '云后台连接失败')
    }
  } finally {
    cloudSaving.value = false
  }
}

async function syncCloud() {
  cloudSaving.value = true
  try {
    const ok = await cloud.sync()
    if (ok) toast.success(`云端已同步：${cloud.sourceCount} 个源${cloud.banner ? ' · 有新公告' : ''}`)
    else toast.error(cloud.error || '云端同步失败')
  } finally {
    cloudSaving.value = false
  }
}

function openCloudAdmin() {
  openExternal(cloud.endpoint)
}

async function cloudLogin() {
  const username = cloudUsername.value.trim()
  if (!username || !cloudPassword.value) {
    toast.info('请输入云端账号和密码')
    return
  }
  cloudAuthing.value = true
  try {
    await cloud.login(username, cloudPassword.value)
    cloudPassword.value = ''
    cloudAccountOpen.value = false
    toast.success(`已登录云端账号 ${cloud.account?.username || username}，收藏与进度已合并`)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '登录失败')
  } finally {
    cloudAuthing.value = false
  }
}

async function cloudRegister() {
  const username = cloudUsername.value.trim()
  if (!username || cloudPassword.value.length < 6) {
    toast.info('用户名必填，密码至少 6 位')
    return
  }
  if (cloud.registrationMode === 'invite' && !cloudInviteCode.value.trim()) {
    toast.info('这个云后台需要邀请码才能注册')
    return
  }
  cloudAuthing.value = true
  try {
    const result = await cloud.register(username, cloudPassword.value, cloudInviteCode.value.trim())
    cloudPassword.value = ''
    cloudInviteCode.value = ''
    if (result.pending) {
      toast.info(result.message)
    } else {
      cloudAccountOpen.value = false
      toast.success(result.message)
    }
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '注册失败')
  } finally {
    cloudAuthing.value = false
  }
}

async function cloudSyncData() {
  try {
    await cloud.syncNow()
    toast.success('收藏和观看进度已与云端对齐')
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '同步失败')
  }
}

async function toggleCloudSessions() {
  cloudSessionsOpen.value = !cloudSessionsOpen.value
  if (!cloudSessionsOpen.value) return
  cloudSessionsLoading.value = true
  try {
    await cloud.loadSessions()
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '读取登录设备失败')
  } finally {
    cloudSessionsLoading.value = false
  }
}

async function revokeCloudSession(id: string, current: boolean) {
  if (current) {
    if (!window.confirm('这是当前设备，下线后需要重新登录，确定继续？')) return
  }
  try {
    const self = await cloud.revokeSession(id)
    toast.success(self ? '当前设备已退出云端账号' : '设备已下线')
    if (self) {
      cloudSessionsOpen.value = false
      cloudAccountOpen.value = false
    }
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '下线失败')
  }
}

async function revokeOtherDevices() {
  if (!window.confirm('让除当前设备外的所有设备退出云端账号？')) return
  try {
    await cloud.revokeOtherSessions()
    toast.success('其他设备已全部下线')
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '操作失败')
  }
}

async function cloudLogout() {
  await cloud.logout()
  toast.success('已退出云端账号，本机收藏与进度保留')
}

function enabledSources(kind: ProbeKind) {
  const list = kind === 'live' ? settings.liveSources : settings.vodSources
  const disabled = kind === 'live' ? settings.disabledLive : settings.disabledVod
  return list.filter((source) => source.enabled !== false && !disabled.includes(source.id))
}

const adultPending = ref(false)

function restoreVodSources() {
  settings.restoreDefaultVod()
  toast.info(`已恢复 ${enabledSources('vod').length} 个内置影视源`)
}

function switchAdultFilter() {
  if (settings.adultFilter) {
    if (!adultPending.value) {
      adultPending.value = true
      window.setTimeout(() => {
        if (adultPending.value) adultPending.value = false
      }, 6000)
      return
    }
    adultPending.value = false
    settings.setAdultFilter(false)
    toast.info('已关闭成人内容过滤，片源里的成人分类会重新出现')
    return
  }
  settings.setAdultFilter(true)
  toast.info('已开启成人内容过滤')
}

const diagCopied = ref(false)
const releaseQr = ref('')
const updateAsset = computed(() =>
  updateState.info ? preferredAsset(updateState.info.assets, settings.tvMode) : null
)
const platformLabel = computed(() => {
  const os = navigator.userAgent
  if (settings.tvMode || /smarttv|braviatv|googletv|hbbtv|aft/i.test(os)) return 'Android TV'
  if (/android/i.test(os)) return 'Android 手机'
  if (/iphone|ipad|ipod/i.test(os)) return 'iOS'
  if (/windows nt/i.test(os)) return 'Windows'
  if (/mac os x/i.test(os)) return 'macOS'
  return runtime.packaged ? '桌面端' : '浏览器'
})
const checkedLabel = computed(() => {
  if (!updateState.checkedAt) return '尚未检查'
  const date = new Date(updateState.checkedAt)
  return `检查于 ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`
})

async function runUpdateCheck() {
  const info = await checkForUpdate()
  if (!info) {
    toast.error(updateState.error || '检查更新失败，当前网络可能访问不了 GitHub')
    return
  }
  if (hasUpdate()) toast.info(`发现新版本 v${info.version}`)
  else toast.info(`已经是最新版本 v${updateState.current}`)
}

function downloadUpdate() {
  const info = updateState.info
  if (!info) return
  openExternal(updateAsset.value?.url || info.page)
}

async function copyDiag() {
  const text = diagnosticsText({
    影视源: `${enabledSources('vod').length}/${settings.vodSources.length} 个启用`,
    直播源: `${enabledSources('live').length}/${settings.liveSources.length} 个启用`,
    大屏模式: settings.tvMode ? '开' : '关',
    成人过滤: settings.adultFilter ? '开' : '关'
  })
  diagCopied.value = await copyText(text)
  if (!diagCopied.value) toast.error('复制失败，可以直接选中下面的文字手动复制')
}

async function runProbes(kind: ProbeKind) {
  const state = probeState[kind]
  if (state.running) return
  if (!settings.standalone) {
    toast.info('NAS 模式请到管理后台的「源检测」标签页检测')
    return
  }
  const list = enabledSources(kind)
  const store = kind === 'live' ? liveProbes : vodProbes
  for (const id of Object.keys(store)) delete store[id]
  Object.assign(state, { running: true, done: 0, total: list.length, ok: 0 })
  const queue = list.map((source) => source.id)
  const label = kind === 'live' ? '直播源' : '影视源'
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift() as string
      const result = await (kind === 'live' ? probeLiveSource(id) : probeVodSource(id))
      if (kind === 'vod') rememberHealth(id, result.ok, result.ms)
      store[id] = result
      state.done += 1
      if (result.ok) state.ok += 1
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker))
  state.running = false
  if (state.ok === state.total) toast.success(`${label}全部可用（${state.total} 个）`)
  else toast.info(`${label}检测完成：${state.ok}/${state.total} 个可用`)
}

async function refineProbes() {
  await runProbes('live')
  await runProbes('vod')
}

function isCustom(id: string): boolean {
  return id.startsWith('custom-')
}

function disabledIn(kind: ProbeKind, id: string): boolean {
  return (kind === 'live' ? settings.disabledLive : settings.disabledVod).includes(id)
}

function toggleSource(kind: ProbeKind, id: string, enabled: boolean) {
  if (kind === 'live') settings.toggleLive(id, enabled)
  else settings.toggleVod(id, enabled)
}

function removeCustomSource(id: string) {
  if (!window.confirm('确定删除该自定义源吗？')) return
  removeCustom(id)
  delete liveProbes[id]
  delete vodProbes[id]
  void settings.refresh()
  toast.success('自定义源已删除')
}

async function runImport() {
  if (importing.value) return
  const url = importUrl.value.trim()
  if (!/^https?:\/\//i.test(url)) {
    importError.value = '请输入 http(s) 开头的接口地址'
    return
  }
  importing.value = true
  importError.value = ''
  importResult.value = null
  try {
    const result = await importTvboxSource(url)
    if (!result.live.length && !result.vod.length) throw new Error('没有解析到可用的直播/影视源')
    importResult.value = result
  } catch (caught) {
    importError.value = caught instanceof Error ? caught.message : '解析失败'
  } finally {
    importing.value = false
  }
}

async function addSelected() {
  if (!importResult.value) return
  const preset = importName.value.trim()
  const inputs: AddInput[] = []
  for (const item of importResult.value.live.filter((entry) => entry.active)) {
    inputs.push({
      kind: 'live',
      name: preset || item.name,
      url: item.url,
      type: item.type === 'm3u' || item.type === 'txt' ? item.type : 'auto',
      note: item.note
    })
  }
  for (const item of importResult.value.vod.filter((entry) => entry.active)) {
    inputs.push({ kind: 'vod', name: preset || item.name, url: item.url, type: 'maccms', note: item.note })
  }
  if (!inputs.length) {
    toast.info('请先勾选要添加的源')
    return
  }
  const { added, skipped } = addCustom(inputs)
  await settings.refresh()
  importResult.value = null
  importName.value = ''
  importUrl.value = ''
  if (added) {
    toast.success(`已添加 ${added} 个自定义源${skipped ? `，跳过 ${skipped} 个重复` : ''}`)
    void refineProbes()
  } else {
    toast.info('这些源已经添加过了')
  }
}

async function testAndSave() {
  testing.value = true
  try {
    const site = await settings.testAndSave(serverInput.value)
    serverInput.value = settings.serverUrl
    toast.success(`已连接 ${site}`)
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : '连接失败')
  } finally {
    testing.value = false
  }
}

async function useStandalone() {
  testing.value = true
  try {
    await settings.useStandalone()
    toast.success('已切换为内置模式，无需 NAS')
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : '切换失败')
  } finally {
    testing.value = false
    showServerForm.value = false
  }
}

function showServer() {
  showServerForm.value = true
  if (!serverInput.value) serverInput.value = settings.serverUrl
}

async function useSameOrigin() {
  testing.value = true
  try {
    await settings.useSameOrigin()
    serverInput.value = ''
    toast.success(`已连接本站 ${settings.siteName}`)
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : '连接失败')
  } finally {
    testing.value = false
  }
}

async function syncSources() {
  syncing.value = true
  try {
    await settings.refresh()
    toast.success(settings.online ? '源列表已同步' : '无法连接服务端')
  } finally {
    syncing.value = false
  }
}

function clearHistory() {
  if (!window.confirm('确定清空观看记录吗？收藏不会受影响。')) return
  library.clearHistory()
  toast.success('观看记录已清空')
}

function clearFavorites() {
  if (!window.confirm('确定清空全部收藏吗？')) return
  library.clearFavorites()
  toast.success('收藏已清空')
}

function clearSearch() {
  library.clearSearch()
  toast.success('搜索记录已清空')
}

async function logoutAccount() {
  await settings.logout()
  toast.success('已退出登录')
}

onMounted(async () => {
  await settings.init()
  void cloud.init()
  if (!serverInput.value) serverInput.value = settings.serverUrl
  void qrDataUrl(latestReleaseUrl).then((value) => {
    releaseQr.value = value
  })
})
</script>

<template>
  <div class="page settings-page">
    <div class="page-head">
      <div>
        <h1 class="page-title">设置</h1>
        <p class="page-desc">
          {{ settings.standalone ? '内置模式：直接使用内置源，无需 NAS' : '连接 NAS 服务端、管理源开关和本地数据' }}
        </p>
      </div>
    </div>

    <div class="settings-grid">
      <section class="panel span-2">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">数据来源</h2>
            <p class="panel-desc">
              内置模式直接读取内置影视源，打开即可搜索和播放，可在下方一键检测源可用性；连接 NAS 后可同步后台源、每日自动检测和多用户。
            </p>
          </div>
          <span class="connection" :class="{ online: settings.online }">
            <span class="status-dot" :class="{ online: settings.online }" />
            {{ settings.standalone ? '内置模式 · 直接播放' : settings.online ? `已连接 · ${settings.siteName}` : '未连接' }}
          </span>
        </div>

        <div class="mode-row">
          <button
            v-if="runtime.packaged"
            class="mode-card"
            :class="{ active: settings.standalone }"
            data-nav
            type="button"
            :disabled="testing"
            @click="useStandalone"
          >
            <span class="mode-name">内置模式</span>
            <span class="mode-desc">无需 NAS，直接使用内置源</span>
          </button>
          <button
            class="mode-card"
            :class="{ active: !settings.standalone }"
            data-nav
            type="button"
            @click="showServer"
          >
            <span class="mode-name">NAS 服务端</span>
            <span class="mode-desc">同步后台源、源检测与多用户</span>
          </button>
        </div>

        <template v-if="!settings.standalone || showServerForm">
          <label class="field">
            <span class="field-label">服务端地址</span>
            <div class="server-row">
              <input
                v-model="serverInput"
                class="input"
                type="url"
                inputmode="url"
                autocomplete="off"
                spellcheck="false"
                placeholder="http://192.168.1.10:8080"
              />
              <button class="btn primary" data-nav type="button" :disabled="testing" @click="testAndSave">
                {{ testing ? '测试中…' : '测试并保存' }}
              </button>
            </div>
          </label>

          <div class="server-actions">
            <button class="btn" data-nav type="button" :disabled="testing" @click="useSameOrigin">
              <AppIcon name="server" :size="16" />
              使用当前站点
            </button>
            <button class="btn" data-nav type="button" :disabled="syncing || !settings.online" @click="syncSources">
              <AppIcon name="refresh" :size="16" />
              {{ syncing ? '同步中…' : '同步源列表' }}
            </button>
            <a class="btn" :href="adminUrl" target="_blank" rel="noopener" data-nav>
              <AppIcon name="external" :size="16" />
              管理后台
            </a>
            <button class="btn" data-nav type="button" :disabled="testing" @click="useStandalone">
              改用内置源
            </button>
          </div>
        </template>

        <p v-if="settings.standalone" class="hint">
          当前直接使用内置源，不需要连接 NAS。下方的「检测源」会逐个请求接口并显示可用状态；需要后台源同步、每日自动检测或多用户时，再切换到「NAS 服务端」。
        </p>
        <p v-else class="hint">
          在 NAS 上运行 <strong>kaytv</strong> Docker 容器后，这里填 <strong>http://NAS地址:8080</strong>。
        </p>
      </section>

      <section class="panel span-2 cloud-panel">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">云后台</h2>
            <p class="panel-desc">
              在云端添加影视源、直播源、TVBox 订阅和公告，三端打开后自动同步；云后台挂在 Cloudflare Pages，不需要自己再买服务器。
            </p>
          </div>
          <span class="connection" :class="{ online: cloud.online }">
            <span class="status-dot" :class="{ online: cloud.online }" />
            {{ cloud.online ? `已连接 · ${cloud.siteName}` : cloud.syncing ? '同步中…' : '未连接' }}
          </span>
        </div>

        <div class="cloud-stats">
          <span class="cloud-host">{{ cloudHost }}</span>
          <span>云源 {{ cloud.sourceCount }} 个</span>
          <span v-if="cloud.tvboxCount">TVBox 订阅 {{ cloud.tvboxCount }} 个</span>
          <span>{{ cloud.banner ? '有新公告' : '无公告' }}</span>
          <span v-if="cloudSyncLabel">上次同步 {{ cloudSyncLabel }}</span>
        </div>

        <label class="field">
          <span class="field-label">云后台地址</span>
          <div class="server-row">
            <input
              v-model="cloudInput"
              class="input"
              type="url"
              inputmode="url"
              autocomplete="off"
              spellcheck="false"
              placeholder="https://tv.9ky.us.ci"
            />
            <button class="btn primary" data-nav type="button" :disabled="cloudSaving" @click="saveCloud">
              {{ cloudSaving ? '同步中…' : '保存并同步' }}
            </button>
          </div>
        </label>

        <div class="server-actions">
          <button class="btn" data-nav type="button" :disabled="cloudSaving" @click="syncCloud">
            <AppIcon name="refresh" :size="16" />
            重新同步
          </button>
          <button class="btn" data-nav type="button" @click="openCloudAdmin">
            <AppIcon name="external" :size="16" />
            打开云管理后台
          </button>
          <button
            v-if="!cloud.account"
            class="btn"
            data-nav
            type="button"
            @click="cloudAccountOpen = !cloudAccountOpen"
          >
            <AppIcon name="users" :size="16" />
            {{ cloudAccountOpen ? '收起账号' : '登录 / 注册云端账号' }}
          </button>
          <template v-else>
            <button class="btn" data-nav type="button" :disabled="cloud.syncingData" @click="cloudSyncData">
              <AppIcon name="refresh" :size="16" />
              {{ cloud.syncingData ? '对齐中…' : '对齐收藏与进度' }}
            </button>
            <button class="btn" data-nav type="button" @click="toggleCloudSessions">
              <AppIcon name="users" :size="16" />
              {{ cloudSessionsOpen ? '收起登录设备' : '登录设备' }}
            </button>
            <button class="btn ghost" data-nav type="button" @click="cloudLogout">退出云端账号</button>
          </template>
        </div>

        <p v-if="cloud.error" class="cloud-error">{{ cloud.error }}</p>
        <p class="hint">
          云源只在「内置模式」生效，公告三端通用。地址留空会用默认云后台；收藏与进度同步是可选项，不登录也能正常看。
        </p>

        <div v-if="cloudAccountOpen && !cloud.account" class="cloud-auth">
          <input
            v-model="cloudUsername"
            class="input"
            type="text"
            autocomplete="username"
            placeholder="用户名（2-24 位）"
          />
          <input
            v-model="cloudPassword"
            class="input"
            type="password"
            autocomplete="current-password"
            placeholder="密码（至少 6 位）"
          />
          <input
            v-if="cloud.registrationMode === 'invite'"
            v-model="cloudInviteCode"
            class="input"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="邀请码（KAY-XXXX-XXXX）"
          />
          <button class="btn primary" data-nav type="button" :disabled="cloudAuthing" @click="cloudLogin">
            {{ cloudAuthing ? '处理中…' : '登录' }}
          </button>
          <button
            class="btn"
            data-nav
            type="button"
            :disabled="cloudAuthing || !cloud.registrationOpen"
            @click="cloudRegister"
          >
            注册
          </button>
        </div>
        <p v-if="cloud.account" class="hint">
          已登录云端账号 <strong>{{ cloud.account.username }}</strong>
          {{ cloud.account.device ? ` · ${cloud.account.device}` : '' }}。换设备登录后会自动合并收藏与观看进度。
        </p>
        <p v-else-if="!cloud.registrationOpen && cloudAccountOpen" class="hint">
          云后台当前关闭了注册，需要让管理员在「用户」里手动开通。
        </p>
        <p v-else-if="cloud.registrationMode === 'invite' && cloudAccountOpen" class="hint">
          云后台开启了邀请码注册：登录不受影响，新注册需要管理员提供的邀请码。
        </p>

        <div v-if="cloud.account && cloudSessionsOpen" class="cloud-sessions">
          <div class="cloud-sessions-head">
            <strong>登录设备</strong>
            <button class="btn sm ghost" data-nav type="button" @click="revokeOtherDevices">
              下线其他设备
            </button>
          </div>
          <p v-if="cloudSessionsLoading" class="hint">读取中…</p>
          <ul v-else class="session-list">
            <li v-for="session in cloud.sessions" :key="session.id" class="session-item">
              <div>
                <span class="session-device">
                  {{ session.device || '未知设备' }}
                  <span v-if="session.current" class="cloud-src-tag">当前设备</span>
                </span>
                <span class="session-meta">
                  最近活跃 {{ new Date(session.lastSeen).toLocaleString('zh-CN', { hour12: false }) }}
                  <template v-if="session.ip"> · {{ session.ip }}</template>
                </span>
              </div>
              <button class="btn sm ghost" data-nav type="button" @click="revokeCloudSession(session.id, session.current)">
                下线
              </button>
            </li>
            <li v-if="!cloud.sessions.length" class="session-item">没有有效的登录设备。</li>
          </ul>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">直播源</h2>
            <p class="panel-desc">
              {{
                probeState.live.running
                  ? `检测中 ${probeState.live.done}/${probeState.live.total} 个…`
                  : probeState.live.done
                    ? `上次检测 ${probeState.live.ok}/${probeState.live.total} 个可用`
                    : '关闭后该源不会出现在直播页'
              }}
            </p>
          </div>
          <button
            v-if="settings.standalone"
            class="btn sm"
            data-nav
            type="button"
            :disabled="probeState.live.running || !enabledSources('live').length"
            @click="runProbes('live')"
          >
            <AppIcon name="refresh" :size="15" />
            {{ probeState.live.running ? `${probeState.live.done}/${probeState.live.total}` : '检测源' }}
          </button>
          <RouterLink v-else class="btn sm ghost" to="/admin" data-nav>管理后台 · 源检测</RouterLink>
        </div>
        <ul class="source-list">
          <li v-for="source in settings.liveSources" :key="source.id" class="source-item">
            <div class="source-info">
              <div class="source-line">
                <span class="source-name">{{ source.name }}</span>
                <span v-if="isCloudSource(source.id)" class="cloud-src-tag">云端</span>
                <span
                  v-if="probeOf('live', source.id)"
                  class="probe-badge"
                  :class="probeOf('live', source.id)!.ok ? 'ok' : 'bad'"
                >
                  {{ probeOf('live', source.id)!.ok ? '可用' : '不可用' }}
                </span>
              </div>
              <span class="source-note">{{ source.note || '直播源' }}</span>
              <span
                v-if="probeOf('live', source.id)"
                class="probe-detail"
                :class="probeOf('live', source.id)!.ok ? 'ok' : 'bad'"
              >
                {{ probeOf('live', source.id)!.detail }}
                <template v-if="probeOf('live', source.id)!.ms">· {{ probeOf('live', source.id)!.ms }} ms</template>
              </span>
            </div>
            <div class="source-actions">
              <button
                v-if="isCustom(source.id) && !isCloudSource(source.id)"
                class="btn sm ghost"
                data-nav
                type="button"
                @click="removeCustomSource(source.id)"
              >
                删除
              </button>
              <button
                class="switch"
                :class="{ on: !disabledIn('live', source.id) }"
                data-nav
                type="button"
                role="switch"
                :aria-checked="!disabledIn('live', source.id)"
                @click="toggleSource('live', source.id, !disabledIn('live', source.id))"
              >
                <span class="knob" />
              </button>
            </div>
          </li>
          <li v-if="!settings.liveSources.length" class="source-empty">暂无直播源</li>
        </ul>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">影视源</h2>
            <p class="panel-desc">
              {{
                probeState.vod.running
                  ? `检测中 ${probeState.vod.done}/${probeState.vod.total} 个…`
                  : probeState.vod.done
                    ? `上次检测 ${probeState.vod.ok}/${probeState.vod.total} 个可用`
                    : '苹果CMS 采集接口，搜索时并行查询'
              }}
            </p>
          </div>
          <button
            v-if="settings.standalone"
            class="btn sm"
            data-nav
            type="button"
            :disabled="probeState.vod.running || !enabledSources('vod').length"
            @click="runProbes('vod')"
          >
            <AppIcon name="refresh" :size="15" />
            {{ probeState.vod.running ? `${probeState.vod.done}/${probeState.vod.total}` : '检测源' }}
          </button>
          <button
            v-if="settings.disabledVod.length"
            class="btn sm ghost"
            data-nav
            type="button"
            @click="restoreVodSources"
          >
            恢复默认片源（已关 {{ settings.disabledVod.length }}）
          </button>
          <RouterLink v-else-if="!settings.standalone" class="btn sm ghost" to="/admin" data-nav>管理后台 · 源检测</RouterLink>
        </div>
        <ul class="source-list">
          <li v-for="source in settings.vodSources" :key="source.id" class="source-item">
            <div class="source-info">
              <div class="source-line">
                <span class="source-name">{{ source.name }}</span>
                <span v-if="isCloudSource(source.id)" class="cloud-src-tag">云端</span>
                <span
                  v-if="probeOf('vod', source.id)"
                  class="probe-badge"
                  :class="probeOf('vod', source.id)!.ok ? 'ok' : 'bad'"
                >
                  {{ probeOf('vod', source.id)!.ok ? '可用' : '不可用' }}
                </span>
              </div>
              <span class="source-note">{{ source.type === 'm3u' ? '直播源' : source.type === 'kanju' ? '官方直连 · 1080P/4K' : '采集接口' }}</span>
              <span
                v-if="probeOf('vod', source.id)"
                class="probe-detail"
                :class="probeOf('vod', source.id)!.ok ? 'ok' : 'bad'"
              >
                {{ probeOf('vod', source.id)!.detail }}
                <template v-if="probeOf('vod', source.id)!.ms">· {{ probeOf('vod', source.id)!.ms }} ms</template>
              </span>
            </div>
            <div class="source-actions">
              <button
                v-if="isCustom(source.id) && !isCloudSource(source.id)"
                class="btn sm ghost"
                data-nav
                type="button"
                @click="removeCustomSource(source.id)"
              >
                删除
              </button>
              <button
                class="switch"
                :class="{ on: !disabledIn('vod', source.id) }"
                data-nav
                type="button"
                role="switch"
                :aria-checked="!disabledIn('vod', source.id)"
                @click="toggleSource('vod', source.id, !disabledIn('vod', source.id))"
              >
                <span class="knob" />
              </button>
            </div>
          </li>
          <li v-if="!settings.vodSources.length" class="source-empty">暂无影视源</li>
        </ul>
      </section>

      <section class="panel span-2">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">自定义 TVBox 接口</h2>
            <p class="panel-desc">
              粘贴 TVBox 订阅集合（tv.json）、TVBox 配置、m3u/txt 直播列表或苹果CMS 采集接口地址，解析后可挑选添加；添加的源出现在直播页/搜索页并可用「检测源」验证。XPTV/TVBox 的 JS 插件脚本（.js / .js.md5）需要专用运行环境，无法直接接入。
            </p>
          </div>
        </div>
        <div class="import-row">
          <label class="field import-name">
            <span class="field-label">名称（可选，留空用解析到的名字）</span>
            <input v-model="importName" class="input" type="text" maxlength="20" placeholder="例如：小马接口" />
          </label>
          <label class="field import-url">
            <span class="field-label">接口地址</span>
            <div class="server-row">
              <input
                v-model="importUrl"
                class="input"
                type="url"
                inputmode="url"
                autocomplete="off"
                spellcheck="false"
                placeholder="https://gh-proxy.com/…/tv.json"
                @keyup.enter="runImport"
              />
              <button class="btn primary" data-nav type="button" :disabled="importing" @click="runImport">
                {{ importing ? '解析中…' : '解析并预览' }}
              </button>
            </div>
          </label>
        </div>
        <p class="hint import-actions">
          <button class="btn sm" data-nav type="button" :disabled="probeState.live.running || probeState.vod.running" @click="refineProbes">
            <AppIcon name="refresh" :size="15" />
            {{ probeState.live.running || probeState.vod.running ? '检测中…' : '检测全部源' }}
          </button>
          <span>一次检测所有开启的直播源与影视源，结果显示在每个源后面。</span>
        </p>
        <p v-if="importError" class="import-error">{{ importError }}</p>
        <template v-if="importResult">
          <div class="import-preview">
            <template v-if="importResult.live.length">
              <h3 class="import-group-title">直播接口（{{ importResult.live.length }}）</h3>
              <label v-for="item in importResult.live" :key="item.id" class="candidate">
                <input v-model="item.active" type="checkbox" class="candidate-check" />
                <span class="candidate-main">
                  <span class="candidate-name">{{ item.name }}</span>
                  <span class="candidate-url">{{ item.url }}</span>
                </span>
                <span class="candidate-kind">{{ item.note === '已添加过' ? '已添加' : item.type === 'm3u' ? 'm3u' : item.type === 'txt' ? 'txt' : '列表' }}</span>
              </label>
            </template>
            <template v-if="importResult.vod.length">
              <h3 class="import-group-title">采集接口（{{ importResult.vod.length }}）</h3>
              <label v-for="item in importResult.vod" :key="item.id" class="candidate">
                <input v-model="item.active" type="checkbox" class="candidate-check" />
                <span class="candidate-main">
                  <span class="candidate-name">{{ item.name }}</span>
                  <span class="candidate-url">{{ item.url }}</span>
                </span>
                <span class="candidate-kind">{{ item.note === '已添加过' ? '已添加' : 'CMS' }}</span>
              </label>
            </template>
          </div>
          <p v-if="importResult.skipped" class="hint">
            另有 {{ importResult.skipped }} 个站点是 TVBox 爬虫/JS 源，需要 TVBox 内核，KayTV 已跳过。
          </p>
          <div class="server-actions">
            <button class="btn primary" data-nav type="button" @click="addSelected">添加选中的 {{ selectedCount }} 个</button>
            <button class="btn" data-nav type="button" @click="importResult = null">取消</button>
          </div>
        </template>
      </section>

      <section v-if="settings.accessMode === 'login' || settings.currentUser" class="panel span-2">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">观看账号</h2>
            <p class="panel-desc">
              {{ settings.currentUser ? '当前已登录，直播与影视均通过服务端播放' : '本服务已开启登录观看，请先登录账号' }}
            </p>
          </div>
          <span v-if="settings.currentUser" class="connection online">
            <span class="status-dot online" />
            {{ settings.currentUser.displayName }}（{{ settings.currentUser.role === 'admin' ? '管理员' : '普通用户' }}）
          </span>
        </div>
        <div class="server-actions">
          <RouterLink v-if="!settings.currentUser" class="btn primary" to="/login" data-nav>去登录</RouterLink>
          <button v-else class="btn" data-nav type="button" @click="logoutAccount">退出登录</button>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">本机数据</h2>
            <p class="panel-desc">收藏 {{ favoriteCount }} 部 · 观看记录 {{ historyCount }} 条</p>
          </div>
        </div>
        <div class="data-actions">
          <button class="btn" data-nav type="button" :disabled="!historyCount" @click="clearHistory">
            清空观看记录
          </button>
          <button class="btn" data-nav type="button" :disabled="!favoriteCount" @click="clearFavorites">
            清空收藏
          </button>
          <button class="btn" data-nav type="button" :disabled="!library.searchHistory.length" @click="clearSearch">
            清空搜索记录
          </button>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">内容分级</h2>
            <p class="panel-desc">默认过滤片源里的成人分类与命名，收藏和历史里的内容不受影响</p>
          </div>
        </div>
        <div class="switch-row">
          <div>
            <span class="switch-label">过滤成人内容</span>
            <span class="switch-note">
              {{ settings.adultFilter ? '已开启，海报墙与搜索不会出现成人分类' : '已关闭，所有分类都会显示' }}
            </span>
          </div>
          <button
            class="switch"
            :class="{ on: settings.adultFilter }"
            data-nav
            type="button"
            role="switch"
            :aria-checked="settings.adultFilter"
            @click="switchAdultFilter"
          >
            <span class="knob" />
          </button>
        </div>
        <p v-if="adultPending" class="switch-warn">
          关闭后成人片单会出现在海报墙与搜索里，适合成年人自用；再点一次确认关闭。
        </p>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">版本更新</h2>
            <p class="panel-desc">
              当前 v{{ updateState.current }} ·
              {{ updateState.checking ? '检查中…' : hasUpdate() ? `发现新版本 v${updateState.info?.version}` : checkedLabel }}
            </p>
          </div>
          <button class="btn sm" data-nav type="button" :disabled="updateState.checking" @click="runUpdateCheck">
            <AppIcon name="refresh" :size="15" />
            {{ updateState.checking ? '检查中' : '检查更新' }}
          </button>
        </div>
        <p v-if="updateState.error" class="update-note bad">{{ updateState.error }}</p>
        <p v-else-if="hasUpdate() && updateState.info" class="update-note">
          {{ updateState.info.publishedAt ? `${updateState.info.publishedAt.slice(0, 10)} 发布 · ` : '' }}{{
            updateAsset ? `将下载 ${updateAsset.name}` : '该版本没有匹配当前设备的安装包'
          }}
        </p>
        <div class="data-actions">
          <button v-if="hasUpdate()" class="btn" data-nav type="button" @click="downloadUpdate">
            {{ updateAsset ? '下载新版本' : '打开发布页' }}
          </button>
          <button v-if="updateState.info" class="btn ghost" data-nav type="button" @click="openExternal(updateState.info.page)">
            查看更新说明
          </button>
        </div>
        <div v-if="releaseQr" class="update-qr">
          <img
            class="update-qr-img"
            :src="releaseQr"
            width="126"
            height="126"
            alt="最新版下载页二维码"
          />
          <div class="update-qr-text">
            <p class="update-note">
              手机扫码直接打开下载页{{
                settings.tvMode ? '，电视端没有输入法，扫码是最快的拿包方式' : '，也可以把链接发给电视端浏览器'
              }}
            </p>
            <p class="update-note">{{ latestReleaseUrl }}</p>
          </div>
        </div>
        <p v-if="!runtime.packaged" class="update-note">
          网页版请改用 NAS 镜像更新；桌面与手机客户端可以直接下载新包覆盖安装，收藏和观看记录不会丢。
        </p>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">故障诊断</h2>
            <p class="panel-desc">片源打不开、海报加载失败时会留在这里，反馈问题时把它一起发出来</p>
          </div>
          <button class="btn sm" data-nav type="button" @click="copyDiag">
            {{ diagCopied ? '已复制' : '复制诊断信息' }}
          </button>
        </div>
        <ul class="diag-list">
          <li v-for="event in recentEvents(8)" :key="`${event.at}-${event.scope}-${event.message}`">
            <span class="diag-scope">{{ event.scope }}</span>
            <span class="diag-message">{{ event.message }}</span>
          </li>
          <li v-if="!recentEvents(1).length" class="source-empty">暂无异常记录</li>
        </ul>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">关于 KayTV</h2>
            <p class="panel-desc">
              v{{ updateState.current }} · {{ settings.standalone ? '内置片源引擎，开箱即播' : '连接自建服务端' }} ·
              {{ platformLabel }}
            </p>
          </div>
        </div>
        <p class="about-text">
          KayTV 只做播放与聚合，不存储、不转卖任何影视内容；片源来自公开的直播列表与采集接口，
          可用性取决于上游站点。请遵守当地法律法规与源站使用条款。
        </p>
        <RouterLink v-if="!settings.standalone" class="btn sm ghost about-link" to="/admin" data-nav>
          管理入口
        </RouterLink>
      </section>
    </div>
  </div>
</template>

<style scoped>
.settings-page {
  max-width: 1320px;
}
.settings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.span-2 {
  grid-column: span 2;
}
.mode-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 16px;
}
.mode-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 5px;
  padding: 14px 16px;
  border-radius: 6px;
  border: 1px solid var(--line-strong);
  background: rgba(255, 255, 255, 0.04);
  color: inherit;
  text-align: left;
  cursor: pointer;
  outline: none;
  transition:
    border-color 0.18s ease,
    background 0.18s ease;
}
.mode-card.active {
  border-color: rgba(229, 9, 20, 0.55);
  background: rgba(229, 9, 20, 0.12);
}
.mode-card:disabled {
  opacity: 0.6;
  cursor: default;
}
.mode-card:focus-visible {
  box-shadow: 0 0 0 3px var(--accent);
}
.mode-name {
  font-size: 14px;
  font-weight: 650;
}
.mode-desc {
  font-size: 12px;
  color: var(--muted);
}
.connection {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}
.connection.online {
  color: #9be7b7;
}
.field {
  display: block;
}
.field-label {
  display: block;
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 8px;
}
.server-row {
  display: flex;
  gap: 10px;
}
.server-row .input {
  flex: 1;
  min-width: 0;
}
.server-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 14px;
}
a.btn {
  text-decoration: none;
}
.hint {
  margin: 14px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--muted);
}
.hint strong {
  color: rgba(242, 244, 248, 0.86);
  font-weight: 600;
}
.source-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.source-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 0;
  border-bottom: 1px solid var(--line);
}
.source-item:last-child {
  border-bottom: 0;
}
.source-info {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.source-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.probe-badge {
  flex: none;
  padding: 0 7px;
  border-radius: 999px;
  border: 1px solid transparent;
  font-size: 10.5px;
  line-height: 17px;
  font-weight: 600;
}
.probe-badge.ok {
  color: #9be7b7;
  border-color: rgba(126, 231, 167, 0.35);
  background: rgba(126, 231, 167, 0.1);
}
.probe-badge.bad {
  color: #ff9a9a;
  border-color: rgba(255, 154, 154, 0.35);
  background: rgba(255, 154, 154, 0.1);
}
.probe-detail {
  font-size: 11px;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.probe-detail.ok {
  color: rgba(155, 231, 183, 0.82);
}
.probe-detail.bad {
  color: rgba(255, 154, 154, 0.85);
}
.source-name {
  font-size: 13.5px;
  font-weight: 550;
}
.source-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
}
.import-row {
  display: grid;
  grid-template-columns: minmax(180px, 260px) minmax(0, 1fr);
  gap: 12px;
  align-items: end;
}
.import-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.import-error {
  margin: 12px 0 0;
  font-size: 12.5px;
  color: #ff9a9a;
}
.import-preview {
  margin-top: 14px;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 6px 14px 12px;
  max-height: 420px;
  overflow-y: auto;
}
.import-group-title {
  margin: 12px 0 4px;
  font-size: 12px;
  color: var(--muted);
  font-weight: 600;
}
.candidate {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid var(--line);
  cursor: pointer;
}
.candidate:last-child {
  border-bottom: 0;
}
.candidate-check {
  flex: none;
  width: 15px;
  height: 15px;
  accent-color: var(--accent);
}
.candidate-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.candidate-name {
  font-size: 13px;
  font-weight: 550;
}
.candidate-url {
  font-size: 11px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.candidate-kind {
  flex: none;
  font-size: 10.5px;
  color: var(--muted);
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  padding: 1px 8px;
}
.source-note {
  font-size: 11.5px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.source-empty {
  padding: 14px 0;
  font-size: 12.5px;
  color: var(--muted);
}
.switch {
  position: relative;
  width: 46px;
  height: 27px;
  flex: none;
  border-radius: 999px;
  border: 1px solid var(--line-strong);
  background: rgba(255, 255, 255, 0.07);
  cursor: pointer;
  outline: none;
  transition: background 0.18s ease;
}
.switch .knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 19px;
  height: 19px;
  border-radius: 50%;
  background: #aab2c0;
  transition:
    transform 0.18s ease,
    background 0.18s ease;
}
.switch.on {
  background: rgba(229, 9, 20, 0.22);
  border-color: rgba(229, 9, 20, 0.45);
}
.switch.on .knob {
  transform: translateX(19px);
  background: var(--accent);
}
.switch:focus {
  box-shadow: 0 0 0 3px var(--accent);
}
.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.switch-label {
  display: block;
  font-size: 13.5px;
  color: var(--text);
}
.switch-note {
  display: block;
  margin-top: 3px;
  font-size: 12px;
  color: var(--muted);
}
.switch-warn {
  margin: 12px 0 0;
  padding: 9px 12px;
  border-radius: 6px;
  background: rgba(229, 9, 20, 0.1);
  border: 1px solid rgba(229, 9, 20, 0.3);
  font-size: 12px;
  line-height: 1.6;
  color: var(--text);
}
.update-note {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--muted);
}
.update-note.bad {
  color: #ff8a8a;
}
.update-qr {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px;
  margin-bottom: 12px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
}
.update-qr-img {
  flex: none;
  width: 126px;
  height: 126px;
  border-radius: 8px;
  background: #fff;
}
.update-qr-text {
  min-width: 0;
}
.update-qr-text .update-note {
  margin-bottom: 6px;
  word-break: break-all;
}
.update-qr-text .update-note:last-child {
  margin-bottom: 0;
  color: var(--muted-2);
}
.diag-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.diag-list li {
  display: flex;
  gap: 10px;
  align-items: baseline;
  font-size: 12px;
  line-height: 1.55;
}
.diag-scope {
  flex: none;
  padding: 1px 7px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--muted);
  font-size: 11px;
}
.diag-message {
  color: var(--text);
  word-break: break-all;
}
.data-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.about-text {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.75;
  color: var(--muted);
}
.about-link {
  margin-top: 14px;
}
.cloud-panel {
  border-color: rgba(96, 165, 250, 0.26);
  background:
    linear-gradient(120deg, rgba(37, 99, 235, 0.1), transparent 46%),
    var(--panel, rgba(18, 18, 18, 0.92));
}
.cloud-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin: 2px 0 14px;
  font-size: 12px;
  color: var(--muted);
}
.cloud-host {
  color: #8ec5ff;
  font-weight: 600;
}
.cloud-auth {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
}
.cloud-auth .input {
  flex: 1 1 180px;
}
.cloud-sessions {
  margin-top: 14px;
  padding: 12px 14px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.18);
}
.cloud-sessions-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
  font-size: 13px;
}
.session-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.session-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  font-size: 12.5px;
}
.session-item:first-child {
  padding-top: 0;
  border-top: 0;
}
.session-device {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.session-meta {
  display: block;
  margin-top: 2px;
  font-size: 11.5px;
  color: var(--muted);
}
.cloud-error {
  margin: 10px 0 0;
  font-size: 12.5px;
  color: var(--bad, #ff8a8a);
}
.cloud-src-tag {
  flex: none;
  padding: 1px 6px;
  border: 1px solid rgba(96, 165, 250, 0.35);
  border-radius: 4px;
  background: rgba(37, 99, 235, 0.14);
  color: #9fcbff;
  font-size: 10.5px;
  line-height: 1.5;
}
@media (max-width: 860px) {
  .settings-grid {
    grid-template-columns: 1fr;
  }
  .span-2 {
    grid-column: span 1;
  }
  .mode-row {
    grid-template-columns: 1fr;
  }
  .server-row {
    flex-direction: column;
  }
  .import-row {
    grid-template-columns: 1fr;
  }
  .import-actions {
    flex-wrap: wrap;
  }
}
</style>

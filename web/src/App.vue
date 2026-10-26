<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import AppIcon from './components/AppIcon.vue'
import PlayerView from './components/PlayerView.vue'
import ToastHost from './components/ToastHost.vue'
import { useSettingsStore } from './stores/settings'
import { usePlayerStore } from './stores/player'
import { useLibraryStore } from './stores/library'
import { useCloudStore } from './stores/cloud'
import { focusFirstNav, useSpatialNav } from './composables/useSpatialNav'
import { runtime } from './api/runtime'
import { checkForUpdate, hasUpdate } from './api/updateCheck'
import { toast } from './composables/useToast'

const settings = useSettingsStore()
const player = usePlayerStore()
const library = useLibraryStore()
const cloud = useCloudStore()
const route = useRoute()
const router = useRouter()

const clock = ref('')
let clockTimer = 0
let cloudTimer = 0

const appVersion = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0'
function versionParts(value: string): number[] {
  return String(value)
    .split('.')
    .map((part) => Number(part.replace(/\D.*$/, '')) || 0)
}
function compareVersion(left: string, right: string): number {
  const a = versionParts(left)
  const b = versionParts(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0)
    if (diff !== 0) return diff
  }
  return 0
}
const forcedUpdate = computed(() => {
  if (!cloud.online || !cloud.minVersion) return false
  return compareVersion(appVersion, cloud.minVersion) < 0
})
const forcedUpdateUrl = computed(
  () => cloud.updateUrl || 'https://github.com/kaynai1/kaytv/releases/latest'
)

/* Netflix 导航：只在首页顶部悬浮透明，其余情况或滚动后转实心 */
const scrolled = ref(false)
const heroPage = computed(() => route.name === 'movies')
const transparentNav = computed(() => heroPage.value && !scrolled.value)

function onScroll() {
  scrolled.value = window.scrollY > 24
}

const navItems = [
  { to: '/', label: '影视专区', icon: 'film' },
  { to: '/live', label: '直播频道', icon: 'live' },
  { to: '/hot', label: '最新热门', icon: 'flame' },
  { to: '/favorites', label: '我的清单', icon: 'bookmark' }
]

const ROOT_PAGES = new Set(['movies', 'live', 'hot', 'favorites'])

const isAdmin = computed(() => route.meta.admin === true)
const isAuthPage = computed(() => route.meta.auth === true)
const showOffline = computed(
  () =>
    settings.checked &&
    !settings.online &&
    !settings.syncing &&
    !settings.standalone &&
    !isAdmin.value &&
    !isAuthPage.value
)
const serverLabel = computed(() => {
  if (settings.standalone) return '内置模式'
  if (!settings.checked) return '连接中…'
  if (!settings.online) return '未连接服务端'
  try {
    return new URL(settings.displayServer).host
  } catch {
    return '服务端在线'
  }
})

function updateClock() {
  const now = new Date()
  clock.value = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
}

function isTypingTarget(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null
  if (!target) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

function onKeydown(event: KeyboardEvent) {
  if (player.open) return
  if (event.key !== 'Escape' && event.key !== 'Backspace') return
  if (isTypingTarget(event)) return
  if (ROOT_PAGES.has(String(route.name))) return
  event.preventDefault()
  if (window.history.length > 1) router.back()
  else void router.push('/')
}

watch(
  () => [settings.needsLogin, settings.checked, route.fullPath] as const,
  () => {
    if (!settings.checked) return
    if (settings.needsLogin && route.name !== 'login' && !isAdmin.value) {
      void router.replace({ name: 'login', query: { redirect: route.fullPath } })
    } else if (!settings.needsLogin && route.name === 'login') {
      void router.replace('/')
    }
  }
)

watch(
  () => route.fullPath,
  async () => {
    if (player.open) return
    await nextTick()
    onScroll()
    const active = document.activeElement as HTMLElement | null
    if (settings.tvMode && (!active || active === document.body || active === document.documentElement)) {
      focusFirstNav()
    }
  }
)

/* 登录云端账号后，收藏和进度改动延迟合并上传，避免每点一次就发请求 */
watch(
  () => [library.favorites, library.history],
  () => {
    if (cloud.loggedIn) cloud.queuePush()
  },
  { deep: true }
)

useSpatialNav()

onMounted(async () => {
  updateClock()
  clockTimer = window.setInterval(updateClock, 15000)
  cloudTimer = window.setInterval(() => {
    if (cloud.configured) void cloud.sync({ silent: true })
  }, 30 * 60 * 1000)
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('scroll', onScroll, { passive: true })
  onScroll()
  settings.autoTvMode()
  await settings.init()
  void cloud.init()
  await nextTick()
  if (!player.open && settings.tvMode) focusFirstNav()
  if (runtime.packaged) {
    const info = await checkForUpdate({ silent: true })
    if (info && hasUpdate()) {
      toast.info(`发现新版本 v${info.version}，可在「设置 · 版本更新」里下载`, 8000)
    }
  }
})

onBeforeUnmount(() => {
  window.clearInterval(clockTimer)
  window.clearInterval(cloudTimer)
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('scroll', onScroll)
})
</script>

<template>
  <div class="app-shell" :class="{ 'tv-mode': settings.tvMode }">
    <header
      class="app-header"
      :class="{ 'admin-mode': isAdmin, solid: !transparentNav }"
    >
      <RouterLink class="brand" to="/" data-nav>
        <span class="brand-mark"><AppIcon name="play" :size="18" /></span>
        <span class="brand-text">
          <span class="brand-name">{{ settings.siteName }}</span>
          <span class="brand-sub">影视 · 直播 · 清单</span>
        </span>
      </RouterLink>

      <nav v-if="!isAdmin && !isAuthPage" class="nav">
        <RouterLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="nav-link"
          :class="{ 'nav-live': item.to === '/live' }"
          data-nav
        >
          <AppIcon class="nav-icon" :name="item.icon" :size="19" />
          <span class="nav-label">{{ item.label }}</span>
          <span v-if="item.to === '/live'" class="nav-badge">LIVE</span>
          <span v-else-if="item.to === '/favorites' && library.favorites.length" class="nav-count">
            {{ library.favorites.length }}
          </span>
        </RouterLink>
      </nav>
      <span v-else class="badge accent admin-badge">管理后台</span>

      <div class="header-right">
        <RouterLink
          v-if="!isAdmin && !isAuthPage"
          class="server-chip"
          to="/settings"
          data-nav
          :title="settings.displayServer"
        >
          <span class="status-dot" :class="{ online: settings.online }" />
          <span>{{ serverLabel }}</span>
        </RouterLink>
        <span v-if="!isAdmin && !isAuthPage" class="clock">{{ clock }}</span>
        <template v-if="!isAdmin && !isAuthPage">
          <RouterLink class="header-icon-btn" to="/feedback" data-nav title="求片与反馈">
            <AppIcon name="message" :size="17" />
          </RouterLink>
          <RouterLink class="header-icon-btn" to="/search" data-nav title="聚合搜索">
            <AppIcon name="search" :size="17" />
          </RouterLink>
          <button
            class="header-icon-btn"
            :class="{ 'tv-on': settings.tvMode }"
            data-nav
            type="button"
            :title="settings.tvMode ? '退出 TV 大屏模式' : 'TV 大屏模式：更大字号与红色焦点框'"
            @click="settings.toggleTvMode()"
          >
            <AppIcon name="tv" :size="17" />
          </button>
          <RouterLink class="header-icon-btn" to="/settings" data-nav title="设置">
            <AppIcon name="settings" :size="17" />
          </RouterLink>
        </template>
        <RouterLink v-else class="btn sm" to="/" data-nav>
          <AppIcon name="back" :size="16" />
          返回观看
        </RouterLink>
      </div>
    </header>

    <div v-if="cloud.banner" class="cloud-banner" :class="cloud.banner.level">
      <AppIcon :name="cloud.banner.level === 'info' ? 'info' : 'warn'" :size="17" />
      <div class="cloud-banner-body">
        <strong>{{ cloud.banner.title }}</strong>
        <span v-if="cloud.banner.body">{{ cloud.banner.body }}</span>
        <a v-if="cloud.banner.link" :href="cloud.banner.link" target="_blank" rel="noopener" data-nav>查看详情</a>
      </div>
      <button class="cloud-banner-close" type="button" title="关闭公告" data-nav @click="cloud.dismissAnnouncement()">
        <AppIcon name="close" :size="15" />
      </button>
    </div>

    <div v-if="showOffline" class="offline-bar">
      <AppIcon name="warn" :size="15" />
      <span>未连接 NAS 服务端：直播可尝试直连，影视与搜索需要服务端代理。</span>
      <RouterLink to="/settings" data-nav>去设置地址</RouterLink>
    </div>

    <main class="app-main">
      <RouterView />
    </main>

    <PlayerView />
    <ToastHost />

    <div v-if="forcedUpdate" class="force-update">
      <div class="force-card">
        <span class="force-icon"><AppIcon name="warn" :size="26" /></span>
        <h2>需要更新后才能继续使用</h2>
        <p>
          当前版本 v{{ appVersion }}，云后台要求至少 v{{ cloud.minVersion }}。
          更新后收藏与观看进度会保留，不会丢失。
        </p>
        <div class="force-actions">
          <a class="btn primary" :href="forcedUpdateUrl" target="_blank" rel="noopener" data-nav>
            去下载新版
          </a>
          <button class="btn ghost" data-nav type="button" @click="cloud.sync()">重新检查</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.admin-badge {
  margin-left: 4px;
}
.admin-mode .brand-mark {
  opacity: 0.75;
}

.cloud-banner {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: 0 auto;
  padding: 10px 22px;
  width: 100%;
  max-width: 1480px;
  color: #cfe7ff;
  background: linear-gradient(90deg, rgba(40, 108, 180, 0.24), transparent 70%);
  border-bottom: 1px solid rgba(96, 165, 250, 0.22);
}

.cloud-banner.warning,
.cloud-banner.critical {
  color: #ffd8b5;
  background: linear-gradient(90deg, rgba(180, 100, 40, 0.26), transparent 70%);
  border-bottom-color: rgba(251, 146, 60, 0.24);
}

.cloud-banner > :first-child {
  flex: none;
  margin-top: 2px;
  color: #8ec5ff;
}

.cloud-banner.warning > :first-child,
.cloud-banner.critical > :first-child {
  color: #fdba74;
}

.cloud-banner-body {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 12px;
  min-width: 0;
  font-size: 12.5px;
  line-height: 1.6;
}

.cloud-banner-body strong {
  font-weight: 700;
}

.cloud-banner-body span {
  color: var(--muted);
}

.cloud-banner-body a {
  color: inherit;
  font-weight: 600;
  text-underline-offset: 3px;
}

.cloud-banner-close {
  flex: none;
  margin-left: auto;
  padding: 2px;
  border: 0;
  background: none;
  color: var(--muted);
  cursor: pointer;
}

.force-update {
  position: fixed;
  inset: 0;
  z-index: 900;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(5, 6, 9, 0.86);
  backdrop-filter: blur(14px);
}
.force-card {
  width: min(460px, 100%);
  padding: 30px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 14px;
  background: #14171d;
  text-align: center;
}
.force-icon {
  display: inline-grid;
  place-items: center;
  width: 52px;
  height: 52px;
  margin-bottom: 14px;
  border-radius: 50%;
  background: rgba(229, 9, 20, 0.14);
  color: var(--accent);
}
.force-card h2 {
  margin: 0 0 10px;
  font-size: 21px;
}
.force-card p {
  margin: 0 0 20px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.8;
}
.force-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
}

@media (max-width: 720px) {
  .cloud-banner {
    padding: 9px 14px;
  }
  .cloud-banner-body {
    flex-direction: column;
    gap: 2px;
  }
}
</style>

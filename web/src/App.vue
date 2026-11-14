<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, watch } from 'vue'
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

/* MarcoMovie 导航：桌面/TV 用右侧竖向玻璃 Dock，手机用底部悬浮四栏 */
const railItems = [
  { to: '/', label: '首页', icon: 'home' },
  { to: '/search', label: '搜索', icon: 'search' },
  { to: '/hot', label: '热门', icon: 'flame' },
  { to: '/live', label: '直播', icon: 'live' },
  { to: '/favorites', label: '片库', icon: 'bookmark' },
  { to: '/settings', label: '设置', icon: 'settings' }
]

const dockItems = [
  { to: '/', label: '首页', icon: 'home' },
  { to: '/live', label: '直播', icon: 'live' },
  { to: '/favorites', label: '片库', icon: 'bookmark' },
  { to: '/settings', label: '设置', icon: 'settings' }
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
  cloudTimer = window.setInterval(() => {
    if (cloud.configured) void cloud.sync({ silent: true })
  }, 30 * 60 * 1000)
  window.addEventListener('keydown', onKeydown)
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
  window.clearInterval(cloudTimer)
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="app-shell" :class="{ 'tv-mode': settings.tvMode }">
    <header v-if="isAdmin || isAuthPage" class="app-header minimal">
      <RouterLink class="brand" to="/" data-nav>
        <span class="brand-mark"><AppIcon name="play" :size="18" /></span>
        <span class="brand-text">
          <span class="brand-name">{{ settings.siteName }}</span>
        </span>
      </RouterLink>
      <span v-if="isAdmin" class="admin-badge">管理后台</span>
      <div class="header-right">
        <RouterLink class="btn sm" to="/" data-nav>
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

    <nav
      v-if="!isAdmin && !isAuthPage"
      class="mm-rail"
      aria-label="主导航"
    >
      <RouterLink class="mm-rail-logo" to="/" data-nav aria-label="首页">
        <AppIcon name="play" :size="20" />
      </RouterLink>
      <span class="mm-rail-line" />
      <RouterLink
        v-for="item in railItems"
        :key="item.to"
        :to="item.to"
        class="mm-rail-link"
        active-class="on"
        exact-active-class="on"
        data-nav
      >
        <span class="mm-rail-glyph">
          <AppIcon :name="item.icon" :size="21" />
          <span v-if="item.to === '/live'" class="mm-live-dot" />
          <span v-else-if="item.to === '/favorites' && library.favorites.length" class="mm-count-dot" />
        </span>
        <span class="mm-rail-label">{{ item.label }}</span>
      </RouterLink>
    </nav>

    <nav
      v-if="!isAdmin && !isAuthPage"
      class="mm-dock"
      aria-label="主导航"
    >
      <RouterLink
        v-for="item in dockItems"
        :key="item.to"
        :to="item.to"
        class="mm-dock-link"
        active-class="on"
        exact-active-class="on"
        data-nav
      >
        <AppIcon :name="item.icon" :size="22" />
        <span>{{ item.label }}</span>
      </RouterLink>
    </nav>

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
/* ---------- 管理后台 / 登录的极简顶栏 ---------- */
.app-header.minimal {
  position: sticky;
  top: 0;
  z-index: 40;
  height: 62px;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 clamp(16px, 3vw, 40px);
  background: rgba(12, 14, 13, 0.78);
  border-bottom: 1px solid var(--line);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
}

.admin-badge {
  margin-left: 4px;
  padding: 4px 11px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid var(--glass-border);
  color: var(--muted);
  font-size: 11.5px;
  font-weight: 600;
}

/* ---------- 右侧玻璃 Dock（桌面 / TV） ---------- */
.mm-rail {
  position: fixed;
  right: 16px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 60;
  display: none;
  flex-direction: column;
  align-items: stretch;
  gap: 3px;
  width: 78px;
  padding: 10px 8px;
  border-radius: var(--radius-dock);
  background: linear-gradient(180deg, rgba(30, 36, 33, 0.72), rgba(14, 18, 17, 0.74));
  border: 1px solid var(--glass-border);
  box-shadow:
    0 26px 64px rgba(0, 0, 0, 0.55),
    inset 0 1px 0 rgba(255, 255, 255, 0.22);
  backdrop-filter: blur(26px) saturate(1.5);
  -webkit-backdrop-filter: blur(26px) saturate(1.5);
}

@media (min-width: 900px) {
  .mm-rail {
    display: flex;
  }
}

.mm-rail-logo {
  display: grid;
  place-items: center;
  width: 100%;
  height: 44px;
  margin-bottom: 2px;
  border-radius: 16px;
  color: #101013;
  background: linear-gradient(160deg, #ffffff, #cfd4d2);
  box-shadow: 0 8px 18px rgba(0, 0, 0, 0.36);
  outline: none;
  text-decoration: none;
}

.mm-rail-line {
  height: 1px;
  margin: 4px 6px 6px;
  background: rgba(255, 255, 255, 0.12);
}

.mm-rail-link {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  min-height: 54px;
  border-radius: 17px;
  color: #a1a1aa;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-decoration: none;
  outline: none;
  transition:
    background 0.16s ease,
    color 0.16s ease,
    transform 0.16s ease;
}

.mm-rail-link:hover {
  color: var(--text);
  background: rgba(255, 255, 255, 0.07);
}

.mm-rail-link.on {
  color: var(--text);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.2), rgba(255, 255, 255, 0.1));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.28);
}

.mm-rail-link.on .mm-rail-glyph {
  color: var(--accent);
}

.mm-rail-glyph {
  position: relative;
  display: grid;
  place-items: center;
}

.mm-rail-label {
  line-height: 1.1;
}

.mm-live-dot,
.mm-count-dot {
  position: absolute;
  top: -2px;
  right: -6px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--live);
  box-shadow: 0 0 0 2px rgba(10, 15, 13, 0.8);
}

.mm-count-dot {
  background: var(--accent);
}

.tv-mode .mm-rail {
  width: 92px;
  padding: 12px 9px;
  border-radius: 30px;
}

.tv-mode .mm-rail-logo {
  height: 52px;
  border-radius: 18px;
}

.tv-mode .mm-rail-link {
  min-height: 66px;
  border-radius: 20px;
  font-size: 12px;
}

.tv-mode .mm-rail-link:focus {
  background: #f5f5f7;
  color: #101013;
  outline: 2px solid #fff;
  outline-offset: 3px;
}

.tv-mode .mm-rail-link:focus .mm-rail-glyph {
  color: #0a84ff;
}

/* ---------- 手机底部悬浮玻璃 Dock ---------- */
.mm-dock {
  position: fixed;
  left: 50%;
  bottom: calc(14px + env(safe-area-inset-bottom, 0px));
  transform: translateX(-50%);
  z-index: 60;
  display: flex;
  align-items: center;
  gap: 2px;
  width: min(288px, calc(100vw - 32px));
  height: 64px;
  padding: 6px;
  border-radius: var(--radius-dock);
  background: linear-gradient(180deg, rgba(27, 33, 30, 0.88), rgba(12, 17, 15, 0.86));
  border: 1px solid var(--glass-border);
  box-shadow:
    0 22px 54px rgba(0, 0, 0, 0.58),
    inset 0 1px 0 rgba(255, 255, 255, 0.2);
  backdrop-filter: blur(26px) saturate(1.55);
  -webkit-backdrop-filter: blur(26px) saturate(1.55);
}

@media (min-width: 900px) {
  .mm-dock {
    display: none;
  }
}

.mm-dock-link {
  flex: 1;
  height: 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  border-radius: 20px;
  color: #e5e7eb;
  font-size: 10.5px;
  font-weight: 500;
  text-decoration: none;
  outline: none;
  transition:
    background 0.16s ease,
    color 0.16s ease;
}

.mm-dock-link.on {
  color: var(--accent);
  font-weight: 700;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.22), rgba(255, 255, 255, 0.1));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.3);
}

.mm-dock-link:focus-visible {
  outline: 2px solid #f5f5f7;
  outline-offset: 2px;
}

/* ---------- 公告 / 离线提示 ---------- */
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
  background: rgba(4, 6, 5, 0.7);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
}
.force-card {
  width: min(460px, 100%);
  padding: 30px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  background: var(--glass-bg-strong);
  box-shadow: 0 28px 70px rgba(0, 0, 0, 0.5);
  text-align: center;
}
.force-icon {
  display: inline-grid;
  place-items: center;
  width: 52px;
  height: 52px;
  margin-bottom: 14px;
  border-radius: 50%;
  background: rgba(10, 132, 255, 0.16);
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

@media (max-width: 899px) {
  .cloud-banner {
    padding: 9px 14px;
  }
  .cloud-banner-body {
    flex-direction: column;
    gap: 2px;
  }
}
</style>

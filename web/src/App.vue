<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import AppIcon from './components/AppIcon.vue'
import PlayerView from './components/PlayerView.vue'
import ToastHost from './components/ToastHost.vue'
import { useSettingsStore } from './stores/settings'
import { usePlayerStore } from './stores/player'
import { useLibraryStore } from './stores/library'
import { focusFirstNav, useSpatialNav } from './composables/useSpatialNav'
import { runtime } from './api/runtime'
import { checkForUpdate, hasUpdate } from './api/updateCheck'
import { toast } from './composables/useToast'

const settings = useSettingsStore()
const player = usePlayerStore()
const library = useLibraryStore()
const route = useRoute()
const router = useRouter()

const clock = ref('')
let clockTimer = 0

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

useSpatialNav()

onMounted(async () => {
  updateClock()
  clockTimer = window.setInterval(updateClock, 15000)
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('scroll', onScroll, { passive: true })
  onScroll()
  settings.autoTvMode()
  await settings.init()
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
  </div>
</template>

<style scoped>
.admin-badge {
  margin-left: 4px;
}
.admin-mode .brand-mark {
  opacity: 0.75;
}
</style>

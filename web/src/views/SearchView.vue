<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { api } from '../api/client'
import { mediaUrl } from '../api/runtime'
import { useSettingsStore } from '../stores/settings'
import { useLibraryStore } from '../stores/library'
import type { PosterItem, SearchResult, VodItem } from '../types'
import AppIcon from '../components/AppIcon.vue'
import EmptyState from '../components/EmptyState.vue'

const settings = useSettingsStore()
const library = useLibraryStore()
const router = useRouter()

const query = ref('')
const input = ref<HTMLInputElement | null>(null)
const selectedSource = ref('')
const loading = ref(false)
const error = ref('')
const result = ref<SearchResult | null>(null)
const lastQuery = ref('')

const sources = computed(() => settings.activeVod)
const searchableCount = computed(
  () => sources.value.filter((item) => item.searchable !== false).length
)

const sourceName = (sourceId: string) =>
  sources.value.find((item) => item.id === sourceId)?.name || sourceId

function errorText(item: { sourceId: string; message: string }) {
  const name = sourceName(item.sourceId)
  for (const separator of ['：', ': ', ':']) {
    if (item.message.startsWith(name + separator)) {
      return `${name}：${item.message.slice((name + separator).length)}`
    }
  }
  return `${name}：${item.message}`
}

const results = computed(() => {
  const seen = new Set<string>()
  return (result.value?.items || []).filter((item) => {
    const key = `${sourceName(item.sourceId)}:${item.name}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
})

const metaText = computed(() => {
  if (!result.value) return ''
  const seconds = (result.value.took / 1000).toFixed(1)
  return `“${result.value.query}” 找到 ${results.value.length} 个结果 · ${seconds}s`
})

let searchToken = 0

async function submit(value?: string) {
  const keyword = (value ?? query.value).trim()
  if (!keyword) {
    input.value?.focus()
    return
  }
  query.value = keyword
  selectedSource.value = selectedSource.value || ''
  const token = ++searchToken
  loading.value = true
  error.value = ''
  try {
    const data = await api.search(
      keyword,
      selectedSource.value ? [selectedSource.value] : []
    )
    if (token !== searchToken) return
    result.value = data
    lastQuery.value = keyword
    library.addSearch(keyword)
  } catch (caught) {
    if (token !== searchToken) return
    error.value = caught instanceof Error ? caught.message : '搜索失败'
    result.value = null
  } finally {
    // 换源或连按搜索时，旧请求收尾不能把新请求的加载状态关掉
    if (token === searchToken) loading.value = false
  }
}

function openDetail(item: PosterItem) {
  router.push(`/detail/${encodeURIComponent(item.sourceId)}/${encodeURIComponent(item.id)}`)
}

function useHistory(keyword: string) {
  query.value = keyword
  submit(keyword)
}

function goBack() {
  if (window.history.length > 1) router.back()
  else router.push('/')
}

onMounted(async () => {
  await settings.init()
  await nextTick()
  if (settings.online) input.value?.focus()
})

watch(selectedSource, () => {
  if (result.value && query.value.trim()) submit()
})
</script>

<template>
  <div class="page search-page">
    <div class="mm-search-top">
      <button class="mm-back" type="button" aria-label="返回" data-nav @click="goBack">
        <AppIcon name="back" :size="19" />
      </button>
      <form class="mm-search-pill" @submit.prevent="submit()">
        <AppIcon class="mm-search-icon" name="search" :size="16" />
        <input
          ref="input"
          v-model="query"
          type="search"
          placeholder="搜索电影、剧集、综艺…"
          autocomplete="off"
          enterkeyhint="search"
        />
      </form>
      <button class="mm-search-go" type="submit" data-nav :disabled="loading" @click="submit()">
        {{ loading ? '搜索中' : '搜索' }}
      </button>
    </div>

    <p class="mm-search-hint">
      {{ settings.online ? `一次搜索 ${searchableCount} 个影视源` : '搜索需要连接 NAS 服务端' }}
    </p>

    <div v-if="sources.length > 1" class="chip-row source-row hide-scrollbar">
      <button
        class="chip"
        :class="{ active: selectedSource === '' }"
        data-nav
        type="button"
        @click="selectedSource = ''"
      >
        全部源
      </button>
      <button
        v-for="source in sources"
        :key="source.id"
        class="chip"
        :class="{ active: selectedSource === source.id }"
        data-nav
        type="button"
        @click="selectedSource = source.id"
      >
        {{ source.name }}
      </button>
    </div>

    <template v-if="settings.online">
      <section v-if="!result && !loading && library.searchHistory.length" class="recent">
        <div class="section-head">
          <h2 class="section-title">最近搜索</h2>
          <button class="btn sm ghost" data-nav @click="library.clearSearch()">清空</button>
        </div>
        <div class="chip-row hide-scrollbar">
          <button
            v-for="keyword in library.searchHistory"
            :key="keyword"
            class="chip"
            data-nav
            type="button"
            @click="useHistory(keyword)"
          >
            <AppIcon name="clock" :size="13" />
            {{ keyword }}
          </button>
        </div>
      </section>

      <div v-if="loading" class="loading-row">
        <span class="spinner" />
        正在并行搜索 {{ selectedSource ? 1 : searchableCount }} 个源…
      </div>

      <EmptyState v-else-if="error" title="搜索失败" :message="error" icon="warn">
        <button class="btn" data-nav @click="submit()">重试</button>
      </EmptyState>

      <template v-else-if="result">
        <div class="result-head">
          <span class="result-meta">{{ metaText }}</span>
          <span v-if="result.errors.length" class="badge live">
            {{ result.errors.length }} 个源暂不可用
          </span>
        </div>

        <div v-if="result.errors.length" class="error-strip">
          <AppIcon name="warn" :size="15" />
          <span>
            {{ result.errors.map(errorText).join('；') }}
          </span>
        </div>

        <EmptyState
          v-if="!results.length"
          title="没有找到相关影视"
          message="换个关键词，或切换全部源再试。部分采集站的关键词检索需要完整片名。"
          icon="search"
        />

        <div v-else class="mm-result-list">
          <button
            v-for="item in results"
            :key="`${item.sourceId}:${item.id}`"
            class="mm-result"
            data-nav
            type="button"
            @click="openDetail(item)"
          >
            <span class="mm-result-poster">
              <img
                v-if="item.pic"
                :src="mediaUrl(item.pic)"
                alt=""
                loading="lazy"
                referrerpolicy="no-referrer"
              />
              <span v-else class="mm-result-fallback">{{ item.name.slice(0, 1) }}</span>
            </span>
            <span class="mm-result-info">
              <strong>{{ item.name }}</strong>
              <span class="mm-result-source">{{ sourceName(item.sourceId) }}</span>
              <span class="mm-result-sub">
                {{ [item.year, item.typeName, item.remarks].filter(Boolean).join(' · ') || '影视' }}
              </span>
            </span>
            <AppIcon class="mm-result-arrow" name="right" :size="15" />
          </button>
        </div>
      </template>

      <EmptyState
        v-else-if="!library.searchHistory.length"
        title="搜索全站影视"
        message="输入片名后回车，KayTV 会同时查询所有已启用的采集接口。"
        icon="search"
      />
    </template>

    <EmptyState
      v-else-if="settings.checked"
      title="搜索需要连接 NAS 服务"
      message="浏览器无法直接访问采集接口（跨域限制），由 KayTV 服务端统一发起搜索和播放代理。"
      icon="server"
    >
      <RouterLink class="btn primary" to="/settings" data-nav>连接服务端</RouterLink>
    </EmptyState>

    <div v-else class="loading-row">
      <span class="spinner" />
      正在连接服务端…
    </div>
  </div>
</template>

<style scoped>
.search-hero {
  max-width: 860px;
}
.search-hero .input {
  height: 58px;
  font-size: 16px;
}
.source-row {
  margin: 14px 0 4px;
}
.recent {
  margin-top: 22px;
}
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.result-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 20px 0 12px;
}
.result-meta {
  font-size: 12.5px;
  color: var(--muted);
}
.error-strip {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 13px;
  margin-bottom: 16px;
  border-radius: 6px;
  border: 1px solid rgba(248, 113, 113, 0.22);
  background: rgba(248, 113, 113, 0.08);
  color: #e8c68f;
  font-size: 12px;
  line-height: 1.6;
}

/* ================= MarcoMovie phone search ================= */
.search-page {
  padding: 14px 16px calc(96px + env(safe-area-inset-bottom, 0px));
}

.mm-search-top {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mm-back {
  flex: none;
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 50%;
  background: rgba(10, 14, 12, 0.42);
  color: #f5f5f7;
  cursor: pointer;
  outline: none;
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
}

.mm-search-pill {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 44px;
  padding: 0 14px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
}

.mm-search-icon {
  flex: none;
  color: #8e959e;
}

.mm-search-pill input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  color: #f5f5f7;
  font-size: 14px;
  outline: none;
}

.mm-search-pill input::placeholder {
  color: #8e959e;
}

.mm-search-pill input::-webkit-search-cancel-button {
  display: none;
}

.mm-search-go {
  flex: none;
  height: 44px;
  padding: 0 16px;
  border: 0;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-size: 13.5px;
  font-weight: 700;
  cursor: pointer;
  outline: none;
}

.mm-search-go:disabled {
  opacity: 0.6;
}

.mm-search-hint {
  margin: 10px 2px 0;
  font-size: 11.5px;
  color: #8e959e;
}

.source-row {
  margin: 12px 0 2px;
}

.result-head {
  margin: 18px 0 10px;
}

.mm-result-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}

.mm-result {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 18px;
  background: linear-gradient(180deg, rgba(24, 33, 29, 0.8), rgba(13, 20, 17, 0.88));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
  color: var(--text);
  text-align: left;
  cursor: pointer;
  outline: none;
}

.mm-result-poster {
  flex: none;
  display: grid;
  place-items: center;
  width: 60px;
  height: 86px;
  border-radius: 15px;
  overflow: hidden;
  background: #1c2823;
}

.mm-result-poster img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.mm-result-fallback {
  font-size: 21px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.3);
}

.mm-result-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.mm-result-info strong {
  font-size: 15px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mm-result-source {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mm-result-sub {
  font-size: 12px;
  color: #8e959e;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mm-result-arrow {
  flex: none;
  color: #5d6462;
}

.search-page .section-title {
  font-size: 15px;
}

.tv-mode .mm-search-top,
.tv-mode .mm-search-hint,
.tv-mode .source-row,
.tv-mode .mm-result-list,
.tv-mode .recent {
  max-width: 980px;
}

.tv-mode .mm-result-poster {
  width: 64px;
  height: 92px;
}

.tv-mode .mm-search-go {
  height: 48px;
  font-size: 15px;
}

.tv-mode .mm-search-pill {
  height: 48px;
}
</style>

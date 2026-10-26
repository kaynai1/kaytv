<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { api } from '../api/client'
import { useSettingsStore } from '../stores/settings'
import { useLibraryStore } from '../stores/library'
import type { PosterItem, SearchResult, VodItem } from '../types'
import AppIcon from '../components/AppIcon.vue'
import EmptyState from '../components/EmptyState.vue'
import PosterCard from '../components/PosterCard.vue'

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

const metaText = computed(() => {
  if (!result.value) return ''
  const seconds = (result.value.took / 1000).toFixed(1)
  return `“${result.value.query}” 找到 ${result.value.items.length} 个结果 · ${seconds}s`
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
  <div class="page">
    <div class="page-head">
      <div>
        <h1 class="page-title">聚合搜索</h1>
        <p class="page-desc">
          {{ settings.online ? `一次搜索 ${searchableCount} 个影视源，按更新时间排序` : '搜索需要连接 NAS 服务端' }}
        </p>
      </div>
    </div>

    <form class="search-field search-hero" @submit.prevent="submit()">
      <AppIcon class="search-icon" name="search" :size="20" />
      <input
        ref="input"
        v-model="query"
        class="input"
        type="search"
        placeholder="搜索电影、剧集、综艺、动漫…"
        autocomplete="off"
        enterkeyhint="search"
      />
      <button class="btn primary search-submit" data-nav type="submit" :disabled="loading">
        {{ loading ? '搜索中' : '搜索' }}
      </button>
    </form>

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
          v-if="!result.items.length"
          title="没有找到相关影视"
          message="换个关键词，或切换全部源再试。部分采集站的关键词检索需要完整片名。"
          icon="search"
        />

        <div v-else class="poster-grid">
          <PosterCard
            v-for="item in result.items"
            :key="`${item.sourceId}:${item.id}`"
            :item="item"
            @select="openDetail"
          />
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
  border: 1px solid rgba(229, 9, 20, 0.18);
  background: rgba(229, 9, 20, 0.06);
  color: #e8c68f;
  font-size: 12px;
  line-height: 1.6;
}
</style>

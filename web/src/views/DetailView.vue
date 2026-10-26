<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { api } from '../api/client'
import { mediaUrl } from '../api/runtime'
import { tmdbArts, tmdbEnsure, tmdbKey, tmdbPosterUrl, tmdbSwapImageHost } from '../api/tmdb'
import { useSettingsStore } from '../stores/settings'
import { useLibraryStore } from '../stores/library'
import { usePlayerStore } from '../stores/player'
import { toast } from '../composables/useToast'
import type { VodDetail } from '../types'
import AppIcon from '../components/AppIcon.vue'
import EmptyState from '../components/EmptyState.vue'

const route = useRoute()
const router = useRouter()
const settings = useSettingsStore()
const library = useLibraryStore()
const player = usePlayerStore()

const detail = ref<VodDetail | null>(null)
const loading = ref(true)
const error = ref('')
const activeLine = ref(0)
const showFull = ref(false)
const posterFailed = ref(false)
const tmdbFailed = ref(false)
const tmdbArt = computed(() => tmdbArts[tmdbKey(detail.value?.name || '', detail.value?.year || '')])
const posterUrl = computed(() => {
  if (tmdbFailed.value) return mediaUrl(detail.value?.pic || '')
  return tmdbPosterUrl(tmdbArt.value, 'w780') || mediaUrl(detail.value?.pic || '')
})

const sourceId = computed(() => String(route.params.source || ''))
const vodId = computed(() => String(route.params.id || ''))
const history = computed(() =>
  detail.value ? library.progressOf(detail.value.sourceId, detail.value.id) : null
)
const isFavorite = computed(() =>
  detail.value ? library.isFavorite(detail.value.sourceId, detail.value.id) : false
)
const line = computed(() => detail.value?.lines[activeLine.value] || null)
const lineGroups = computed(() => {
  const all = detail.value?.lines || []
  const official: { item: (typeof all)[number]; index: number }[] = []
  const standard: { item: (typeof all)[number]; index: number }[] = []
  all.forEach((item, index) => {
    if (item.official) official.push({ item, index })
    else standard.push({ item, index })
  })
  const groups: { label: string; entries: typeof official }[] = []
  if (official.length) groups.push({ label: `官方线路 ${official.length}`, entries: official })
  if (standard.length) groups.push({ label: `普通线路 ${standard.length}`, entries: standard })
  return groups
})
const content = computed(() => detail.value?.content || '')
const canExpand = computed(() => content.value.length > 180)
const resumeText = computed(() => {
  const entry = history.value
  if (!entry || entry.position < 10) return ''
  return `上次看到 ${entry.episodeName || `第 ${entry.episodeIndex + 1} 集`} · ${formatClock(entry.position)}`
})

function formatClock(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds || 0))
  const minutes = Math.floor(value / 60)
  const rest = value % 60
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}

function lineLabel(name: string, index: number): string {
  if (/[\u4e00-\u9fa5]/.test(name)) return name
  return `线路 ${index + 1}`
}

function is4kLine(name: string): boolean {
  return /4k|2160|uhd/i.test(name)
}

function onPosterError() {
  const url = tmdbPosterUrl(tmdbArt.value, 'w780')
  if (url && !tmdbFailed.value) {
    if (tmdbSwapImageHost(url)) return
    tmdbFailed.value = true
  } else posterFailed.value = true
}

let loadToken = 0

async function load() {
  const token = ++loadToken
  loading.value = true
  error.value = ''
  detail.value = null
  posterFailed.value = false
  tmdbFailed.value = false
  try {
    await settings.init()
    if (!settings.online) throw new Error('影视详情暂时不可用，请检查网络或切换数据来源')
    const result = await api.detail(sourceId.value, vodId.value)
    if (token !== loadToken) return
    detail.value = result
    tmdbEnsure(result.name, result.year, result.contentType || '')
    const entry = library.progressOf(result.sourceId, result.id)
    const initialLine =
      entry && entry.lineIndex >= 0 && entry.lineIndex < result.lines.length
        ? entry.lineIndex
        : 0
    activeLine.value = initialLine
  } catch (caught) {
    if (token !== loadToken) return
    error.value = caught instanceof Error ? caught.message : '加载详情失败'
  } finally {
    // 快速切换到另一部片时，旧请求不能结束新详情的加载态
    if (token === loadToken) loading.value = false
  }
}

function currentEpisodeIndex(): number {
  const entry = history.value
  if (!entry || !detail.value) return 0
  if (entry.lineIndex !== activeLine.value) return 0
  const total = detail.value.lines[activeLine.value]?.episodes.length || 0
  return Math.max(0, Math.min(entry.episodeIndex, total - 1))
}

function play(resume = true) {
  if (!detail.value) return
  const selected = detail.value.lines[activeLine.value]
  if (!selected || !selected.episodes.length) {
    toast.error('该线路没有可播放的剧集')
    return
  }
  const episodeIndex = currentEpisodeIndex()
  const position = resume && history.value ? history.value.position : 0
  player.openVod(detail.value, activeLine.value, episodeIndex, position)
}

function playEpisode(index: number) {
  if (!detail.value) return
  player.openVod(detail.value, activeLine.value, index, 0)
}

function switchLine(index: number) {
  if (activeLine.value === index) return
  activeLine.value = index
}

function toggleFavorite() {
  if (!detail.value) return
  const added = library.toggleFavorite(detail.value)
  toast.success(added ? '已加入收藏' : '已取消收藏')
}

function goBack() {
  if (window.history.length > 1) router.back()
  else router.push('/movies')
}

onMounted(load)
watch(() => [sourceId.value, vodId.value].join('/'), load)
</script>

<template>
  <div class="page detail-page">
    <div v-if="loading" class="detail-loading">
      <span class="spinner" />
      正在读取影片信息…
    </div>

    <EmptyState v-else-if="error" title="影片加载失败" :message="error" icon="warn">
      <button class="btn" data-nav @click="load">重试</button>
      <button class="btn ghost" data-nav @click="goBack">返回</button>
    </EmptyState>

    <template v-else-if="detail">
      <div class="detail-hero">
        <div class="hero-poster">
          <img
            v-if="(detail.pic || posterUrl) && !posterFailed"
            :src="posterUrl"
            :alt="detail.name"
            referrerpolicy="no-referrer"
            @error="onPosterError"
          />
          <div v-else class="hero-fallback">
            {{ detail.name.slice(0, 1) }}
          </div>
        </div>

        <div class="hero-info">
          <div class="hero-top">
            <button class="btn sm ghost back-btn" data-nav type="button" @click="goBack">
              <AppIcon name="back" :size="16" />
              返回
            </button>
            <span class="badge accent">{{ detail.sourceName }}</span>
          </div>
          <h1 class="detail-title">{{ detail.name }}</h1>
          <div class="detail-meta">
            <span v-if="detail.year">{{ detail.year }}</span>
            <span v-if="detail.area">{{ detail.area }}</span>
            <span v-if="detail.typeName">{{ detail.typeName }}</span>
            <span v-if="detail.score" class="score">{{ detail.score }} 分</span>
            <span v-if="detail.remarks" class="badge">{{ detail.remarks }}</span>
          </div>
          <p class="detail-credits">
            <span v-if="detail.director">导演：{{ detail.director }}</span>
            <span v-if="detail.actors">主演：{{ detail.actors }}</span>
          </p>
          <p class="detail-content" :class="{ expanded: showFull }">
            {{ content || '暂无简介' }}
          </p>
          <button
            v-if="canExpand"
            class="btn sm ghost expand-btn"
            data-nav
            type="button"
            @click="showFull = !showFull"
          >
            {{ showFull ? '收起' : '展开全部' }}
          </button>

          <div class="hero-actions">
            <button class="btn primary play-btn" data-nav type="button" @click="play(true)">
              <AppIcon name="play" :size="18" />
              {{ resumeText ? '继续播放' : '立即播放' }}
            </button>
            <button class="btn" data-nav type="button" @click="toggleFavorite">
              <AppIcon name="heart" :size="17" />
              {{ isFavorite ? '已收藏' : '收藏' }}
            </button>
            <span v-if="resumeText" class="resume-hint">{{ resumeText }}</span>
          </div>
        </div>
      </div>

      <section class="episodes-section">
        <div class="episodes-head">
          <h2 class="section-title">选集 <span class="hint">共 {{ line?.episodes.length || 0 }} 集</span></h2>
          <div v-if="detail.lines.length > 1" class="line-groups">
            <div v-for="group in lineGroups" :key="group.label" class="line-group">
              <span class="line-group-title">{{ group.label }}</span>
              <div class="chip-row line-row hide-scrollbar">
                <button
                  v-for="entry in group.entries"
                  :key="`${entry.item.name}-${entry.index}`"
                  class="chip"
                  :class="{ active: activeLine === entry.index, official: entry.item.official }"
                  data-nav
                  type="button"
                  @click="switchLine(entry.index)"
                >
                  {{ lineLabel(entry.item.name, entry.index) }}
                  <span v-if="is4kLine(entry.item.name)" class="badge-4k">4K</span>
                  <span class="count">{{ entry.item.episodes.length }}</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        <div v-if="line?.episodes.length" class="episode-grid">
          <button
            v-for="(episode, index) in line.episodes"
            :key="`${index}-${episode.url}`"
            class="episode-btn"
            :class="{
              watched:
                history &&
                history.lineIndex === activeLine &&
                history.episodeIndex === index
            }"
            data-nav
            type="button"
            @click="playEpisode(index)"
          >
            {{ episode.name }}
          </button>
        </div>

        <EmptyState
          v-else
          title="该源没有可直接播放的线路"
          message="这个采集站只提供了分享页或网盘链接，KayTV 暂不支持解析。可以换一个影视源搜索同名影片。"
          icon="warn"
        >
          <RouterLink class="btn" to="/search" data-nav>换源搜索</RouterLink>
        </EmptyState>
      </section>

      <p class="detail-foot">
        片源由 {{ detail.sourceName }} 提供{{ settings.standalone ? '' : '，播放地址经服务端代理' }}；片源可用性取决于上游站点。
      </p>
    </template>
  </div>
</template>

<style scoped>
.detail-page {
  max-width: 1500px;
}
.detail-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 100px 20px;
  color: var(--muted);
  font-size: 13px;
}
.detail-hero {
  position: relative;
  display: grid;
  grid-template-columns: 236px minmax(0, 1fr);
  gap: clamp(22px, 3vw, 40px);
  padding: clamp(20px, 2.4vw, 34px);
  border-radius: 6px;
  border: 1px solid var(--line);
  background: var(--surface);
  overflow: hidden;
}
.hero-poster {
  position: relative;
  z-index: 1;
  aspect-ratio: 2 / 3;
  border-radius: 4px;
  overflow: hidden;
  background: var(--surface-2);
  border: 1px solid var(--line);
}
.hero-poster img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.hero-fallback {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  background: var(--surface-3);
  font-size: 64px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.4);
}
.hero-info {
  position: relative;
  z-index: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}
.hero-top {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.back-btn {
  margin-left: -10px;
}
.detail-title {
  margin: 12px 0 10px;
  font-size: clamp(26px, 2.6vw, 38px);
  line-height: 1.14;
  font-weight: 800;
  letter-spacing: 0;
}
.detail-meta {
  display: flex;
  align-items: center;
  gap: 8px 14px;
  flex-wrap: wrap;
  font-size: 12.5px;
  color: var(--muted);
}
.detail-meta .score {
  color: #46d369;
  font-weight: 700;
}
.detail-credits {
  margin: 12px 0 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.6;
}
.detail-content {
  margin: 13px 0 0;
  font-size: 13.5px;
  line-height: 1.8;
  color: #d2d2d2;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
  max-width: 780px;
  white-space: pre-line;
}
.detail-content.expanded {
  display: block;
  overflow: visible;
}
.expand-btn {
  margin-top: 6px;
  padding-left: 0;
  padding-right: 0;
  min-height: 28px;
  color: var(--accent);
  border: 0;
}
.hero-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 20px;
}
.play-btn {
  min-width: 148px;
  min-height: 48px;
  font-size: 15px;
  border-radius: 4px;
}
.resume-hint {
  font-size: 12px;
  color: var(--muted);
}
.episodes-section {
  margin-top: 30px;
}
.episodes-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.episodes-head .section-title {
  margin: 0;
}
.line-groups {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 100%;
}
.line-group {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}
.line-group-title {
  flex: none;
  font-size: 11.5px;
  font-weight: 650;
  color: var(--muted);
  white-space: nowrap;
}
.line-row {
  padding-bottom: 2px;
  max-width: 100%;
}
.line-groups .chip.official {
  border-color: rgba(229, 9, 20, 0.35);
}
.badge-4k {
  padding: 0 5px;
  border-radius: 4px;
  border: 1px solid rgba(154, 215, 255, 0.55);
  background: rgba(8, 16, 28, 0.85);
  color: #9ad7ff;
  font-size: 9px;
  font-weight: 800;
  line-height: 14px;
  letter-spacing: 0.4px;
}
.episode-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(94px, 1fr));
  gap: 9px;
}
.episode-btn {
  min-height: 42px;
  padding: 8px 10px;
  border-radius: 4px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.04);
  color: var(--text);
  font-size: 12.5px;
  cursor: pointer;
  outline: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition:
    background 0.15s ease,
    border-color 0.15s ease;
}
.episode-btn:hover {
  background: rgba(255, 255, 255, 0.08);
}
.episode-btn.watched {
  border-color: rgba(229, 9, 20, 0.55);
  color: var(--accent);
  background: rgba(229, 9, 20, 0.08);
}
.episode-btn:focus {
  background: var(--accent);
  border-color: transparent;
  color: #171106;
  font-weight: 600;
  box-shadow: 0 0 0 3px rgba(229, 9, 20, 0.4);
}
.detail-foot {
  margin: 30px 0 0;
  font-size: 11.5px;
  color: var(--muted-2);
}
@media (max-width: 760px) {
  .detail-hero {
    grid-template-columns: 1fr;
  }
  .hero-poster {
    width: min(190px, 46vw);
  }
}
</style>

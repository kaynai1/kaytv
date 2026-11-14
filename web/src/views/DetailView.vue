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
const canExpand = computed(() => content.value.length > 54)
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
  <div class="detail-page">
    <div v-if="loading" class="detail-loading">
      <span class="spinner" />
      正在读取影片信息…
    </div>

    <EmptyState v-else-if="error" title="影片加载失败" :message="error" icon="warn">
      <button class="btn" data-nav @click="load">重试</button>
      <button class="btn ghost" data-nav @click="goBack">返回</button>
    </EmptyState>

    <template v-else-if="detail">
      <section class="dd-hero">
        <div class="dd-backdrop">
          <img
            v-if="posterUrl && !posterFailed"
            :src="posterUrl"
            alt=""
            aria-hidden="true"
            referrerpolicy="no-referrer"
            @error="onPosterError"
          />
          <span class="dd-fade" />
        </div>

        <div class="dd-topbar">
          <button class="dd-circle" data-nav type="button" aria-label="返回" @click="goBack">
            <AppIcon name="back" :size="20" />
          </button>
          <div class="dd-top-actions">
            <span class="dd-source">⇄ {{ detail.sourceName }}</span>
            <button
              class="dd-circle"
              :class="{ on: isFavorite }"
              data-nav
              type="button"
              :title="isFavorite ? '取消收藏' : '收藏'"
              @click="toggleFavorite"
            >
              <AppIcon name="heart" :size="18" />
            </button>
          </div>
        </div>

        <div class="dd-hero-info">
          <h1 class="dd-title">{{ detail.name }}</h1>

          <div class="dd-meta">
            <span v-if="detail.score" class="dd-score">{{ detail.score }}</span>
            <span v-if="detail.year" class="dd-pill">{{ detail.year }}</span>
            <span v-if="detail.typeName" class="dd-pill">{{ detail.typeName }}</span>
            <span v-if="detail.area" class="dd-pill">{{ detail.area }}</span>
            <span v-if="detail.remarks" class="dd-pill">{{ detail.remarks }}</span>
          </div>

          <p class="dd-desc" :class="{ expanded: showFull }">
            {{ content || '暂无简介' }}
          </p>
          <button
            v-if="canExpand"
            class="dd-expand"
            data-nav
            type="button"
            @click="showFull = !showFull"
          >
            {{ showFull ? '收起' : '展开全部' }}
            <AppIcon :name="showFull ? 'up' : 'down'" :size="14" />
          </button>
        </div>
      </section>

      <div class="dd-body">
        <div class="dd-play-row">
          <button class="dd-play" data-nav type="button" @click="play(true)">
            <AppIcon name="play" :size="18" />
            {{ resumeText ? '继续播放' : '立即播放' }}
          </button>
          <span v-if="resumeText" class="dd-resume">{{ resumeText }}</span>
        </div>

        <p v-if="detail.director || detail.actors" class="dd-credits">
          <span v-if="detail.director">导演 {{ detail.director }}</span>
          <span v-if="detail.actors">主演 {{ detail.actors }}</span>
        </p>

        <section class="dd-episodes">
          <div class="dd-ep-head">
            <h2>选集</h2>
            <span>共 {{ line?.episodes.length || 0 }} 集</span>
          </div>

          <div v-if="detail.lines.length > 1" class="dd-lines hide-scrollbar">
            <button
              v-for="(entry, index) in detail.lines"
              :key="`${entry.name}-${index}`"
              class="dd-line-card"
              :class="{ on: activeLine === index, official: entry.official }"
              data-nav
              type="button"
              @click="switchLine(index)"
            >
              <span class="dd-line-top">
                <span class="dd-line-name">{{ lineLabel(entry.name, index) }}</span>
                <span v-if="is4kLine(entry.name)" class="badge-4k">4K</span>
              </span>
              <span class="dd-line-count">{{ entry.episodes.length }} 集</span>
              <span class="dd-line-state">
                <AppIcon :name="activeLine === index ? 'check' : 'play'" :size="13" />
                {{ activeLine === index ? '当前线路' : '切换线路' }}
              </span>
            </button>
          </div>

          <div v-if="line?.episodes.length" class="dd-ep-grid">
            <button
              v-for="(episode, index) in line.episodes"
              :key="`${index}-${episode.url}`"
              class="dd-ep"
              :class="{
                watched:
                  history &&
                  history.lineIndex === activeLine &&
                  history.episodeIndex === index
              }"
              :title="episode.name"
              data-nav
              type="button"
              @click="playEpisode(index)"
            >
              <span class="dd-ep-num">{{ index + 1 }}</span>
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

        <p class="dd-foot">
          片源由 {{ detail.sourceName }} 提供{{ settings.standalone ? '' : '，播放地址经服务端代理' }}；片源可用性取决于上游站点。
        </p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.detail-page {
  width: 100%;
  padding-bottom: 90px;
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

/* ---------- 全幅海报头 ---------- */
.dd-hero {
  position: relative;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  min-height: clamp(400px, 62vh, 660px);
  padding: 68px 20px 0;
  overflow: hidden;
}

.dd-backdrop {
  position: absolute;
  inset: 0;
}

.dd-backdrop img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  filter: blur(42px) brightness(0.46) saturate(1.2);
  transform: scale(1.22);
}

.dd-fade {
  position: absolute;
  inset: 0;
  background:
    linear-gradient(180deg, rgba(7, 11, 9, 0.5) 0%, rgba(7, 11, 9, 0.06) 34%, rgba(7, 11, 9, 0.86) 84%, var(--bg) 100%),
    radial-gradient(80% 60% at 50% 20%, transparent 30%, rgba(6, 10, 8, 0.55) 100%);
}

.dd-topbar {
  position: absolute;
  top: calc(14px + var(--kaytv-safe-top, env(safe-area-inset-top, 0px)));
  left: 16px;
  right: 16px;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.dd-top-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dd-circle {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(10, 14, 12, 0.42);
  color: var(--text);
  cursor: pointer;
  outline: none;
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  transition:
    background 0.16s ease,
    color 0.16s ease;
}

.dd-circle:hover {
  background: rgba(255, 255, 255, 0.16);
}

.dd-circle.on {
  background: #f5f5f7;
  border-color: transparent;
  color: #101013;
}

.dd-source {
  display: inline-flex;
  align-items: center;
  height: 32px;
  max-width: 46vw;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(10, 14, 12, 0.42);
  color: #e5e7eb;
  font-size: 12px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
}

.dd-poster {
  position: relative;
  z-index: 2;
  width: min(232px, 52vw);
  aspect-ratio: 2 / 3;
  border-radius: 20px;
  overflow: hidden;
  background: #1e2623;
  border: 1px solid rgba(255, 255, 255, 0.16);
  box-shadow:
    0 34px 80px rgba(0, 0, 0, 0.62),
    0 0 0 1px rgba(0, 0, 0, 0.2);
}

.dd-poster img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.dd-poster-fallback {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  font-size: 72px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.4);
}

/* ---------- 正文 ---------- */
.dd-body {
  position: relative;
  z-index: 2;
  width: min(820px, 100%);
  margin: 22px auto 0;
  padding: 0 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.dd-title {
  margin: 0;
  max-width: 100%;
  font-size: clamp(26px, 3.4vw, 38px);
  line-height: 1.16;
  font-weight: 700;
  letter-spacing: 0;
  text-shadow: 0 6px 30px rgba(0, 0, 0, 0.55);
}

.dd-meta {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  flex-wrap: wrap;
  margin-top: 12px;
}

.dd-score {
  display: inline-flex;
  align-items: center;
  height: 26px;
  padding: 0 10px;
  border-radius: 999px;
  background: rgba(52, 211, 153, 0.14);
  border: 1px solid rgba(52, 211, 153, 0.3);
  color: #6ee7b7;
  font-size: 11.5px;
  font-weight: 700;
}

.dd-pill {
  display: inline-flex;
  align-items: center;
  height: 26px;
  max-width: 60vw;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--glass-border);
  background: rgba(255, 255, 255, 0.07);
  color: #d4d4d8;
  font-size: 11.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dd-pill.accent {
  background: rgba(255, 255, 255, 0.9);
  border-color: transparent;
  color: #101013;
}

.dd-credits {
  margin: 14px 0 0;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 4px 16px;
  font-size: 12px;
  color: var(--muted-2);
  line-height: 1.6;
}

.dd-play-row {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin-top: 20px;
}

.dd-play {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-width: 190px;
  height: 50px;
  padding: 0 30px;
  border: 0;
  border-radius: 999px;
  background: #f5f5f7;
  color: #101013;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.01em;
  cursor: pointer;
  outline: none;
  box-shadow: 0 16px 38px rgba(0, 0, 0, 0.45);
  transition:
    background 0.16s ease,
    transform 0.16s ease;
}

.dd-play:hover {
  background: #ffffff;
  transform: translateY(-1px);
}

.dd-resume {
  font-size: 11.5px;
  color: var(--muted-2);
}

.dd-desc {
  margin: 20px 0 0;
  width: 100%;
  padding: 16px 18px;
  border-radius: 20px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.04);
  font-size: 13.5px;
  line-height: 1.85;
  color: #d7d7db;
  text-align: left;
  white-space: pre-line;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.dd-desc.expanded {
  display: block;
  overflow: visible;
}

.dd-expand {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 8px;
  padding: 4px 10px;
  border: 0;
  background: transparent;
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  outline: none;
}

/* ---------- 选集 ---------- */
.dd-episodes {
  width: 100%;
  margin-top: 32px;
  text-align: left;
}

.dd-ep-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 13px;
}

.dd-ep-head h2 {
  margin: 0;
  font-size: 19px;
  font-weight: 700;
  letter-spacing: 0;
}

.dd-ep-head span {
  font-size: 11.5px;
  color: var(--muted-2);
}

.dd-lines {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 16px;
}

.dd-line-group {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.dd-line-label {
  flex: none;
  font-size: 11px;
  font-weight: 600;
  color: var(--muted-2);
  white-space: nowrap;
  letter-spacing: 0.04em;
}

.line-row {
  padding-bottom: 2px;
  max-width: 100%;
}

.dd-lines .chip.official {
  border-color: rgba(52, 211, 153, 0.35);
}

.badge-4k {
  padding: 0 5px;
  border-radius: 999px;
  border: 1px solid rgba(154, 215, 255, 0.5);
  background: rgba(8, 16, 28, 0.7);
  color: #9ad7ff;
  font-size: 9px;
  font-weight: 800;
  line-height: 14px;
  letter-spacing: 0.4px;
}

.dd-ep-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
  gap: 10px;
}

.dd-ep {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 3px;
  aspect-ratio: 16 / 9;
  padding: 10px 12px;
  border-radius: 14px;
  border: 1px solid rgba(255, 255, 255, 0.09);
  background: linear-gradient(160deg, rgba(38, 45, 42, 0.72), rgba(18, 23, 21, 0.86));
  color: var(--text);
  text-align: left;
  cursor: pointer;
  outline: none;
  overflow: hidden;
  transition:
    border-color 0.16s ease,
    background 0.16s ease,
    transform 0.16s ease;
}

.dd-ep:hover {
  border-color: rgba(255, 255, 255, 0.2);
  transform: translateY(-2px);
}

.dd-ep-num {
  font-size: 11px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.42);
  font-variant-numeric: tabular-nums lining-nums;
}

.dd-ep-name {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dd-ep.watched {
  border-color: rgba(10, 132, 255, 0.6);
  background: linear-gradient(160deg, rgba(16, 46, 78, 0.8), rgba(10, 22, 36, 0.9));
}

.dd-ep.watched .dd-ep-num {
  color: var(--accent);
}

.dd-ep:focus {
  border-color: rgba(245, 245, 247, 0.9);
  box-shadow: 0 0 0 2px rgba(245, 245, 247, 0.9);
}

.dd-foot {
  margin: 30px 0 0;
  font-size: 11px;
  color: var(--muted-2);
  text-align: center;
}

@media (min-width: 900px) {
  .dd-hero {
    min-height: clamp(460px, 64vh, 700px);
    padding-top: 84px;
  }
  .dd-poster {
    width: 264px;
  }
  .dd-body {
    margin-top: 26px;
  }
  .dd-topbar {
    left: clamp(20px, 3vw, 40px);
    right: clamp(20px, 3vw, 40px);
  }
  .dd-ep-grid {
    grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
  }
}

.tv-mode .dd-hero {
  min-height: 74vh;
}

.tv-mode .dd-poster {
  width: 340px;
}

.tv-mode .dd-title {
  font-size: 46px;
}

.tv-mode .dd-play {
  height: 58px;
  min-width: 230px;
  font-size: 18px;
}

.tv-mode .dd-ep-grid {
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
}

@media (max-width: 899px) {
  .detail-page {
    padding-bottom: calc(var(--tabbar-h) + env(safe-area-inset-bottom, 0px) + 20px);
  }
}

@media (max-width: 720px) {
  .dd-hero {
    min-height: 58vh;
    padding: 64px 16px 0;
  }
  .dd-body {
    margin-top: 18px;
    padding: 0 16px;
  }
  .dd-title {
    font-size: 25px;
  }
  .dd-desc {
    font-size: 13px;
    padding: 14px 15px;
  }
  .dd-ep-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
  .dd-ep {
    padding: 8px 10px;
    border-radius: 12px;
  }
  .dd-play {
    min-width: 176px;
    height: 46px;
    font-size: 14px;
  }
}

/* ================= MarcoMovie full-bleed detail ================= */
.detail-page {
  width: 100%;
  padding-bottom: calc(32px + env(safe-area-inset-bottom, 0px));
}

.dd-hero {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  min-height: 0;
  height: clamp(500px, 80vh, 720px);
  padding: calc(56px + var(--kaytv-safe-top, env(safe-area-inset-top, 0px))) 18px 22px;
  overflow: hidden;
}

.dd-backdrop img {
  filter: none;
  transform: none;
  object-position: center 18%;
}

.dd-fade {
  background:
    linear-gradient(180deg, rgba(6, 10, 8, 0.58) 0%, transparent 18%, rgba(6, 10, 8, 0.3) 40%, rgba(6, 10, 8, 0.9) 74%, #070c0a 100%),
    radial-gradient(130% 78% at 50% 44%, transparent 34%, rgba(5, 9, 7, 0.62) 100%);
}

.dd-topbar {
  top: calc(12px + var(--kaytv-safe-top, env(safe-area-inset-top, 0px)));
  left: 16px;
  right: 16px;
  align-items: center;
}

.dd-source {
  height: 40px;
  padding: 0 14px;
  background: rgba(10, 14, 12, 0.46);
  font-size: 12.5px;
  gap: 4px;
}

.dd-circle {
  width: 40px;
  height: 40px;
}

.dd-hero-info {
  position: relative;
  z-index: 2;
  width: min(680px, 100%);
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.dd-title {
  margin: 0;
  font-size: 28px;
  line-height: 1.16;
  font-weight: 800;
  letter-spacing: 0;
  text-shadow: 0 6px 30px rgba(0, 0, 0, 0.6);
}

.dd-meta {
  gap: 6px;
  margin-top: 12px;
}

.dd-score {
  height: 25px;
  padding: 0 10px;
  font-size: 11px;
}

.dd-pill {
  height: 25px;
  padding: 0 9px;
  font-size: 11px;
  background: rgba(10, 14, 12, 0.42);
}

.dd-desc {
  margin: 12px 0 0;
  width: 100%;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: none;
  color: #d8dcda;
  font-size: 13.5px;
  line-height: 1.72;
  text-align: center;
  text-shadow: 0 2px 12px rgba(0, 0, 0, 0.6);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.dd-desc.expanded {
  display: block;
  overflow: visible;
}

.dd-expand {
  margin-top: 4px;
  color: #d8dcda;
  font-size: 11.5px;
  opacity: 0.8;
}

.dd-body {
  width: min(760px, 100%);
  margin: 0 auto;
  padding: 14px 16px 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  text-align: left;
}

.dd-play-row {
  width: 100%;
  margin-top: 0;
  gap: 8px;
}

.dd-play {
  width: 100%;
  height: 48px;
  min-width: 0;
  border-radius: 999px;
  font-size: 14.5px;
  font-weight: 800;
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.42);
}

.dd-resume {
  text-align: center;
  font-size: 11px;
}

.dd-credits {
  margin: 14px 0 0;
  justify-content: flex-start;
  gap: 2px 14px;
  font-size: 11.5px;
  color: #8e959e;
}

.dd-episodes {
  margin-top: 24px;
}

.dd-ep-head {
  margin-bottom: 12px;
}

.dd-ep-head h2 {
  font-size: 18px;
  font-weight: 700;
}

.dd-lines {
  display: flex;
  gap: 10px;
  margin: 0 -16px;
  padding: 2px 16px 12px;
  overflow-x: auto;
}

.dd-line-card {
  position: relative;
  flex: 0 0 224px;
  height: 126px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: space-between;
  padding: 14px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 14px;
  background: linear-gradient(160deg, rgba(32, 42, 37, 0.9), rgba(15, 22, 19, 0.94));
  color: var(--text);
  text-align: left;
  cursor: pointer;
  outline: none;
}

.dd-line-card.on {
  border-color: rgba(255, 255, 255, 0.92);
  background: linear-gradient(160deg, rgba(52, 64, 58, 0.9), rgba(20, 28, 24, 0.95));
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.4);
}

.dd-line-top {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
}

.dd-line-name {
  min-width: 0;
  font-size: 15px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dd-line-count {
  font-size: 12px;
  color: #8e959e;
}

.dd-line-state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  font-weight: 600;
  color: #c7c7cf;
}

.dd-line-card.on .dd-line-state {
  color: #fff;
}

.dd-ep-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(44px, 1fr));
  gap: 8px;
}

.dd-ep {
  aspect-ratio: auto;
  height: 32px;
  padding: 0;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.07);
}

.dd-ep:hover {
  transform: none;
  background: rgba(255, 255, 255, 0.14);
  border-color: rgba(255, 255, 255, 0.2);
}

.dd-ep-num {
  font-size: 12.5px;
  font-weight: 700;
  color: #d8dcda;
}

.dd-ep.watched {
  background: #f5f5f7;
  border-color: transparent;
}

.dd-ep.watched .dd-ep-num {
  color: #101013;
}

.dd-foot {
  margin: 26px 0 0;
  text-align: left;
}

@media (min-width: 900px) {
  .dd-hero {
    height: clamp(520px, 78vh, 760px);
    padding-top: 78px;
  }
  .dd-title {
    font-size: 34px;
  }
  .dd-desc {
    font-size: 14px;
  }
  .dd-body {
    padding: 18px 20px 0;
  }
  .dd-line-card {
    flex-basis: 244px;
  }
}

.tv-mode .detail-page {
  width: calc(100% + var(--rail-w));
  max-width: none;
  margin-right: calc(-1 * var(--rail-w));
}

.tv-mode .dd-hero {
  height: 76vh;
  align-items: flex-start;
  padding: 90px calc(var(--rail-w) + 48px) 40px 48px;
}

.tv-mode .dd-topbar {
  right: calc(var(--rail-w) + 24px);
}

.tv-mode .dd-hero-info {
  align-items: flex-start;
  text-align: left;
  width: min(900px, 100%);
}

.tv-mode .dd-title {
  font-size: 42px;
}

.tv-mode .dd-meta {
  justify-content: flex-start;
}

.tv-mode .dd-desc {
  text-align: left;
  -webkit-line-clamp: 3;
  font-size: 14.5px;
  width: min(760px, 100%);
}

.tv-mode .dd-body {
  width: min(1100px, 100%);
  padding: 24px calc(var(--rail-w) + 48px) 0 48px;
}

.tv-mode .dd-play {
  width: auto;
  min-width: 240px;
  height: 46px;
  font-size: 15px;
}

.tv-mode .dd-play-row {
  align-items: flex-start;
}

.tv-mode .dd-line-card {
  flex-basis: 260px;
  height: 138px;
}

.tv-mode .dd-ep-grid {
  grid-template-columns: repeat(auto-fill, minmax(48px, 1fr));
  gap: 10px;
}

.tv-mode .dd-ep {
  height: 40px;
}
</style>

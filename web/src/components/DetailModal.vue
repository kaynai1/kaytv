<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api/client'
import { mediaUrl } from '../api/runtime'
import { tmdbArts, tmdbBackdropUrl, tmdbEnsure, tmdbKey, tmdbPosterUrl, tmdbSwapImageHost } from '../api/tmdb'
import { useLibraryStore } from '../stores/library'
import { usePlayerStore } from '../stores/player'
import { useSettingsStore } from '../stores/settings'
import { toast } from '../composables/useToast'
import { pushBack } from '../composables/backStack'
import type { VodDetail } from '../types'
import AppIcon from './AppIcon.vue'

const props = defineProps<{ sourceId: string; vodId: string }>()
const emit = defineEmits<{ close: [] }>()

const settings = useSettingsStore()
const library = useLibraryStore()
const player = usePlayerStore()
const router = useRouter()

const detail = ref<VodDetail | null>(null)
const loading = ref(true)
const error = ref('')
const activeLine = ref(0)
const showFull = ref(false)
const posterFailed = ref(false)
const tmdbFailed = ref(false)
const tmdbArtKey = computed(() => tmdbKey(detail.value?.name || '', detail.value?.year || ''))
const tmdbArt = computed(() => tmdbArts[tmdbArtKey.value])
const glowUrl = computed(
  () => tmdbBackdropUrl(tmdbArt.value, 'w1280') || mediaUrl(detail.value?.pic || '')
)
const posterUrl = computed(() => {
  if (tmdbFailed.value) return mediaUrl(detail.value?.pic || '')
  return tmdbPosterUrl(tmdbArt.value, 'w780') || mediaUrl(detail.value?.pic || '')
})
const primaryBtn = ref<HTMLElement | null>(null)
const panelEl = ref<HTMLElement | null>(null)

const line = computed(() => detail.value?.lines[activeLine.value] || null)
const isFavorite = computed(() =>
  detail.value ? library.isFavorite(detail.value.sourceId, detail.value.id) : false
)
const history = computed(() =>
  detail.value ? library.progressOf(detail.value.sourceId, detail.value.id) : null
)
const resumeText = computed(() => {
  const entry = history.value
  if (!entry || entry.position < 10) return ''
  return `上次看到 ${entry.episodeName || `第 ${entry.episodeIndex + 1} 集`} · ${formatClock(entry.position)}`
})
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

function onPosterError() {
  const url = tmdbPosterUrl(tmdbArt.value, 'w780')
  if (url && !tmdbFailed.value) {
    if (tmdbSwapImageHost(url)) return
    tmdbFailed.value = true
  } else posterFailed.value = true
}

function formatClock(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds || 0))
  const minutes = Math.floor(value / 60)
  const rest = value % 60
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}

function lineLabel(name: string, index: number): string {
  if (/[一-龥]/.test(name)) return name
  return `线路 ${index + 1}`
}

function is4kLine(name: string): boolean {
  return /4k|2160|uhd/i.test(name)
}

function currentEpisodeIndex(): number {
  const entry = history.value
  if (!entry || !detail.value) return 0
  if (entry.lineIndex !== activeLine.value) return 0
  const total = detail.value.lines[activeLine.value]?.episodes.length || 0
  return Math.max(0, Math.min(entry.episodeIndex, total - 1))
}

async function load() {
  loading.value = true
  error.value = ''
  detail.value = null
  activeLine.value = 0
  showFull.value = false
  posterFailed.value = false
  tmdbFailed.value = false
  try {
    const result = await api.detail(props.sourceId, props.vodId)
    detail.value = result
    tmdbEnsure(result.name, result.year, result.contentType || '')
    const entry = library.progressOf(result.sourceId, result.id)
    if (entry && entry.lineIndex >= 0 && entry.lineIndex < result.lines.length) {
      activeLine.value = entry.lineIndex
    }
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '加载详情失败'
  } finally {
    loading.value = false
    // 详情区是 v-else-if，要等 loading 落下再取按钮，否则遥控器焦点还留在弹窗后面的卡片上
    await nextTick()
    const target =
      primaryBtn.value ||
      panelEl.value?.querySelector<HTMLElement>('.modal-error-actions [data-nav]')
    target?.focus({ preventScroll: false })
  }
}

function play(resume = true) {
  if (!detail.value) return
  const selected = detail.value.lines[activeLine.value]
  if (!selected || !selected.episodes.length) {
    toast.error('该线路没有可播放的剧集')
    return
  }
  const position = resume && history.value ? history.value.position : 0
  player.openVod(detail.value, activeLine.value, currentEpisodeIndex(), position)
  emit('close')
}

function playEpisode(index: number) {
  if (!detail.value) return
  player.openVod(detail.value, activeLine.value, index, 0)
  emit('close')
}

function toggleFavorite() {
  if (!detail.value) return
  const added = library.toggleFavorite(detail.value)
  toast.success(added ? '已加入清单' : '已移出清单')
}

function openFullPage() {
  emit('close')
  router.push(`/detail/${encodeURIComponent(props.sourceId)}/${encodeURIComponent(props.vodId)}`)
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  event.stopPropagation()
  emit('close')
}

let releaseBack: (() => void) | null = null
let returnFocus: HTMLElement | null = null

onMounted(() => {
  const active = document.activeElement as HTMLElement | null
  if (active && active !== document.body) returnFocus = active
  window.addEventListener('keydown', onKeydown, true)
  releaseBack = pushBack(() => {
    emit('close')
    return true
  })
  void load()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
  releaseBack?.()
  releaseBack = null
  // 遥控器关掉弹窗后焦点要回到原来那张卡，不然下一次按键又从导航栏开始
  returnFocus?.focus?.({ preventScroll: true })
  returnFocus = null
})

watch(
  () => [props.sourceId, props.vodId].join('/'),
  () => void load()
)
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div
      ref="panelEl"
      class="modal-panel"
      role="dialog"
      aria-modal="true"
      :aria-label="detail?.name || '影片详情'"
      data-nav-scope
    >
      <button class="modal-close" type="button" aria-label="关闭" data-nav @click="emit('close')">
        <AppIcon name="close" :size="17" />
      </button>

      <div v-if="loading" class="modal-loading">
        <span class="spinner" />
        正在读取影片信息…
      </div>

      <div v-else-if="error" class="modal-error">
        <AppIcon name="warn" :size="26" />
        <h3>影片加载失败</h3>
        <p>{{ error }}</p>
        <div class="modal-error-actions">
          <button class="btn" data-nav type="button" @click="load">重试</button>
          <button class="btn ghost" data-nav type="button" @click="emit('close')">返回</button>
        </div>
      </div>

      <template v-else-if="detail">
        <div class="detail-top">
          <div
            v-if="(detail.pic || glowUrl) && !posterFailed"
            class="detail-glow"
            :style="{ backgroundImage: `url(${glowUrl})` }"
          />
          <div class="detail-art">
            <div class="art-fallback">{{ detail.name.slice(0, 1) }}</div>
            <img
              v-if="(detail.pic || posterUrl) && !posterFailed"
              :src="posterUrl"
              :alt="detail.name"
              referrerpolicy="no-referrer"
              @error="onPosterError"
            />
          </div>

          <div class="detail-info">
            <div class="detail-tags">
              <span class="badge accent">{{ detail.sourceName }}</span>
              <span v-if="detail.remarks" class="badge">{{ detail.remarks }}</span>
              <span v-if="!detail.playable" class="badge">仅分享页</span>
            </div>
            <h2 class="detail-name">{{ detail.name }}</h2>
            <div class="detail-meta">
              <span v-if="detail.year">{{ detail.year }}</span>
              <span v-if="detail.area">{{ detail.area }}</span>
              <span v-if="detail.typeName">{{ detail.typeName }}</span>
              <span v-if="detail.score" class="score">{{ detail.score }} 分</span>
            </div>
            <p v-if="detail.director || detail.actors" class="detail-credits">
              <span v-if="detail.director">导演：{{ detail.director }}</span>
              <span v-if="detail.actors">主演：{{ detail.actors }}</span>
            </p>
            <p class="detail-content" :class="{ expanded: showFull }">
              {{ detail.content || '暂无简介' }}
            </p>
            <button
              v-if="detail.content.length > 120"
              class="expand-btn"
              data-nav
              type="button"
              @click="showFull = !showFull"
            >
              {{ showFull ? '收起' : '展开全部' }}
            </button>

            <div class="detail-actions">
              <button
                ref="primaryBtn"
                class="btn play"
                data-nav
                data-tv-primary
                type="button"
                @click="play(true)"
              >
                <AppIcon name="play" :size="18" />
                {{ resumeText ? '继续播放' : '立即播放' }}
              </button>
              <button
                class="btn"
                :class="isFavorite ? 'faved' : 'info'"
                data-nav
                type="button"
                @click="toggleFavorite"
              >
                <AppIcon name="bookmark" :size="17" />
                {{ isFavorite ? '已在清单' : '加入清单' }}
              </button>
              <button v-if="resumeText" class="btn ghost" data-nav type="button" @click="play(false)">
                <AppIcon name="refresh" :size="16" />
                从头播放
              </button>
              <button class="btn ghost page-link" data-nav type="button" @click="openFullPage">
                整页查看
              </button>
            </div>
            <p v-if="resumeText" class="resume-hint">{{ resumeText }}</p>
          </div>
        </div>

        <div v-if="detail.lines.length > 1" class="lines-block">
          <div v-for="group in lineGroups" :key="group.label" class="line-group">
            <span class="line-group-title">{{ group.label }}</span>
            <div class="chip-row hide-scrollbar">
              <button
                v-for="entry in group.entries"
                :key="`${entry.item.name}-${entry.index}`"
                class="chip"
                :class="{ active: activeLine === entry.index }"
                data-nav
                type="button"
                @click="activeLine = entry.index"
              >
                {{ lineLabel(entry.item.name, entry.index) }}
                <span v-if="is4kLine(entry.item.name)" class="badge-4k">4K</span>
                <span class="count">{{ entry.item.episodes.length }}</span>
              </button>
            </div>
          </div>
        </div>

        <div v-if="line?.episodes.length" class="episodes-block">
          <h3 class="section-title">
            <span class="mark"></span>
            选集
            <span class="hint">共 {{ line.episodes.length }} 集 · {{ lineLabel(line.name, activeLine) }}</span>
          </h3>
          <div class="episode-grid">
            <button
              v-for="(episode, index) in line.episodes"
              :key="`${index}-${episode.url}`"
              class="ep-chip"
              :class="{
                watched:
                  history && history.lineIndex === activeLine && history.episodeIndex === index
              }"
              data-nav
              type="button"
              @click="playEpisode(index)"
            >
              {{ episode.name }}
            </button>
          </div>
        </div>

        <div v-else class="episodes-empty">
          <AppIcon name="warn" :size="20" />
          <span>该源没有可直接播放的线路，只有分享页或网盘链接。可以换一个影视源搜索同名影片。</span>
        </div>

        <p class="detail-foot">
          片源由 {{ detail.sourceName }} 提供{{ settings.standalone ? '' : '，播放地址经服务端代理' }}。
        </p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.modal-loading,
.modal-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 70px 24px;
  color: var(--muted);
  font-size: 13px;
  text-align: center;
}
.modal-error h3 {
  margin: 0;
  font-size: 17px;
  color: var(--text);
}
.modal-error p {
  margin: 0;
  max-width: 460px;
  line-height: 1.6;
}
.modal-error-actions {
  display: flex;
  gap: 10px;
  margin-top: 6px;
}
.detail-top {
  position: relative;
  display: grid;
  grid-template-columns: 230px minmax(0, 1fr);
  gap: 26px;
  padding: 30px clamp(20px, 2.6vw, 36px) 8px;
  overflow: hidden;
}
.detail-glow {
  position: absolute;
  inset: -60px -40px auto;
  height: 300px;
  background-size: cover;
  background-position: center 28%;
  filter: blur(42px) saturate(1.15) brightness(0.5);
  opacity: 0.55;
  z-index: 0;
  pointer-events: none;
  -webkit-mask-image: linear-gradient(180deg, #000 0%, transparent 92%);
  mask-image: linear-gradient(180deg, #000 0%, transparent 92%);
}
.detail-top > .detail-art,
.detail-top > .detail-info {
  position: relative;
  z-index: 1;
}
.detail-art {
  position: relative;
  aspect-ratio: 2 / 3;
  border-radius: 4px;
  overflow: hidden;
  border: 0;
  background: var(--surface-2);
  box-shadow: 0 16px 44px rgba(0, 0, 0, 0.6);
}
.detail-art img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.art-fallback {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  font-size: 56px;
  font-weight: 800;
  color: rgba(255, 255, 255, 0.32);
}
.detail-info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}
.detail-tags {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.detail-tags .badge {
  padding: 1px 8px;
  border-radius: 2px;
  border: 1px solid rgba(255, 255, 255, 0.24);
  background: transparent;
  color: #d2d2d2;
  font-size: 10.5px;
  font-weight: 600;
}
.detail-tags .badge.accent {
  border-color: rgba(229, 9, 20, 0.6);
  background: transparent;
  color: #ff5a63;
}
.detail-name {
  margin: 12px 0 10px;
  font-size: clamp(24px, 2.6vw, 36px);
  font-weight: 800;
  line-height: 1.15;
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
  font-weight: 800;
}
.detail-credits {
  margin: 10px 0 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 12.5px;
  color: var(--muted-2);
}
.detail-content {
  margin: 14px 0 0;
  max-width: 720px;
  font-size: 13.5px;
  line-height: 1.75;
  color: #d2d2d2;
  white-space: pre-line;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.detail-content.expanded {
  display: block;
  overflow: visible;
  -webkit-line-clamp: unset;
}
.expand-btn {
  margin-top: 6px;
  padding: 2px 0;
  border: 0;
  background: transparent;
  color: #b3b3b3;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}
.expand-btn:hover {
  color: #fff;
}
.detail-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 18px;
}
.detail-actions .btn {
  min-height: 44px;
  font-size: 14px;
}
.detail-actions .btn.faved {
  background: rgba(255, 255, 255, 0.16);
  border-color: rgba(255, 255, 255, 0.65);
  color: #fff;
}
.page-link {
  color: var(--muted);
}
.resume-hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--muted-2);
}
.lines-block {
  padding: 10px clamp(20px, 2.6vw, 36px) 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
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
  font-weight: 700;
  color: var(--muted);
  white-space: nowrap;
}
.line-group .chip-row {
  padding-bottom: 2px;
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
}
.episodes-block {
  padding: 18px clamp(20px, 2.6vw, 36px) 0;
}
.episodes-block .section-title {
  font-size: 15px;
}
.episode-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
  gap: 9px;
}
.ep-chip {
  min-height: 40px;
  padding: 8px 10px;
  border-radius: 4px;
  border: 1px solid transparent;
  background: rgba(255, 255, 255, 0.09);
  color: #d8d8d8;
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  outline: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition:
    background 0.16s ease,
    color 0.16s ease,
    border-color 0.16s ease;
}
.ep-chip:hover {
  background: #fff;
  border-color: transparent;
  color: #000;
}
.ep-chip:focus {
  outline: 3px solid var(--accent);
  outline-offset: 2px;
  background: #fff;
  border-color: transparent;
  color: #000;
}
.ep-chip.watched {
  border-color: rgba(229, 9, 20, 0.55);
  color: #ff8089;
  background: var(--accent-soft);
}
.episodes-empty {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 18px clamp(20px, 2.6vw, 36px) 0;
  padding: 14px 16px;
  border-radius: 6px;
  border: 1px solid rgba(229, 9, 20, 0.28);
  background: rgba(229, 9, 20, 0.07);
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.6;
}
.detail-foot {
  margin: 20px clamp(20px, 2.6vw, 36px) 24px;
  font-size: 11.5px;
  color: var(--muted-2);
}
@media (max-width: 760px) {
  .detail-top {
    grid-template-columns: 1fr;
    gap: 16px;
    padding-top: 24px;
  }
  .detail-art {
    width: min(152px, 42vw);
  }
  .detail-actions .btn {
    flex: 1 1 auto;
  }
  .page-link {
    display: none;
  }
}
</style>

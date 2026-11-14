<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { useLibraryStore, itemKey } from '../stores/library'
import { mediaUrl } from '../api/runtime'
import { toast } from '../composables/useToast'
import type { HistoryEntry, PosterItem } from '../types'
import AppIcon from '../components/AppIcon.vue'

const library = useLibraryStore()
const router = useRouter()
const tab = ref<'history' | 'favorites'>('history')

const favorites = computed(() => [...library.favorites].sort((a, b) => b.addedAt - a.addedAt))
const history = computed(() => library.recentHistory)

function open(item: PosterItem) {
  void router.push({ name: 'detail', params: { source: item.sourceId, id: item.id } })
}

function openHistory(source: string, id: string) {
  void router.push({ name: 'detail', params: { source, id } })
}

function progressOf(source: string, id: string): number {
  const entry = library.progressOf(source, id)
  if (!entry || !entry.duration) return 0
  return entry.position / entry.duration
}

function historySub(entry: HistoryEntry): string {
  const percent = entry.duration ? Math.round((entry.position / entry.duration) * 100) : 0
  return [entry.episodeName || '上次看到这里', percent > 0 ? `已看 ${percent}%` : '']
    .filter(Boolean)
    .join(' · ')
}

function removeHistory(entry: HistoryEntry) {
  library.removeHistory(entry.sourceId, entry.id)
  toast.success('已删除记录')
}

function removeFavorite(item: PosterItem) {
  library.removeFavorite(item.sourceId, item.id)
  toast.success('已移出收藏')
}

function clearHistory() {
  if (!window.confirm('确定清空全部观看历史吗？')) return
  library.clearHistory()
  toast.success('历史已清空')
}

function clearFavorites() {
  if (!window.confirm('确定清空全部收藏吗？')) return
  library.clearFavorites()
  toast.success('收藏已清空')
}
</script>

<template>
  <div class="page lib-page">
    <div class="lib-head">
      <h1>片库</h1>
      <RouterLink class="lib-sync" to="/settings" data-nav>
        <AppIcon name="refresh" :size="12" />
        多端同步
      </RouterLink>
    </div>

    <div class="lib-tabs">
      <div class="lib-tab-scroll hide-scrollbar">
        <button
          class="lib-tab"
          :class="{ on: tab === 'history' }"
          type="button"
          data-nav
          @click="tab = 'history'"
        >
          观看历史
        </button>
        <button
          class="lib-tab"
          :class="{ on: tab === 'favorites' }"
          type="button"
          data-nav
          @click="tab = 'favorites'"
        >
          我的收藏
        </button>
      </div>
      <button
        v-if="tab === 'history' && history.length"
        class="lib-clear"
        type="button"
        data-nav
        @click="clearHistory"
      >
        清空历史
      </button>
      <button
        v-else-if="tab === 'favorites' && favorites.length"
        class="lib-clear"
        type="button"
        data-nav
        @click="clearFavorites"
      >
        清空收藏
      </button>
    </div>

    <div v-if="tab === 'history'" class="lib-list">
      <div
        v-for="entry in history"
        :key="itemKey(entry.sourceId, entry.id)"
        class="lib-row"
        role="button"
        tabindex="0"
        data-nav
        @click="openHistory(entry.sourceId, entry.id)"
        @keydown.enter="openHistory(entry.sourceId, entry.id)"
      >
        <span class="lib-thumb">
          <img
            v-if="entry.pic"
            :src="mediaUrl(entry.pic)"
            alt=""
            loading="lazy"
            referrerpolicy="no-referrer"
          />
          <span v-else class="lib-fallback">{{ entry.name.slice(0, 1) }}</span>
        </span>
        <span class="lib-info">
          <strong>{{ entry.name }}</strong>
          <span>{{ historySub(entry) }}</span>
          <span class="lib-progress">
            <span :style="{ width: `${Math.min(100, progressOf(entry.sourceId, entry.id) * 100)}%` }" />
          </span>
        </span>
        <button class="lib-del" type="button" @click.stop="removeHistory(entry)">删除</button>
      </div>

      <p v-if="!history.length" class="lib-empty">暂无观看历史记录</p>
    </div>

    <div v-else class="lib-list">
      <div
        v-for="item in favorites"
        :key="itemKey(item.sourceId, item.id)"
        class="lib-row"
        role="button"
        tabindex="0"
        data-nav
        @click="open(item)"
        @keydown.enter="open(item)"
      >
        <span class="lib-thumb">
          <img
            v-if="item.pic"
            :src="mediaUrl(item.pic)"
            alt=""
            loading="lazy"
            referrerpolicy="no-referrer"
          />
          <span v-else class="lib-fallback">{{ item.name.slice(0, 1) }}</span>
        </span>
        <span class="lib-info">
          <strong>{{ item.name }}</strong>
          <span>{{ [item.year, item.typeName, item.remarks].filter(Boolean).join(' · ') || '已收藏' }}</span>
        </span>
        <button class="lib-del" type="button" @click.stop="removeFavorite(item)">移除</button>
      </div>

      <p v-if="!favorites.length" class="lib-empty">
        还没有收藏任何影片
        <RouterLink class="lib-empty-link" to="/" data-nav>去影视专区</RouterLink>
      </p>
    </div>
  </div>
</template>

<style scoped>
.lib-page {
  padding: 18px 16px calc(96px + env(safe-area-inset-bottom, 0px));
}

.lib-head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.lib-head h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 800;
  letter-spacing: 0;
  color: #f5f5f7;
}

.lib-sync {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border: 1px solid rgba(90, 200, 250, 0.34);
  border-radius: 999px;
  background: rgba(90, 200, 250, 0.12);
  color: #5ac8fa;
  font-size: 12px;
  font-weight: 700;
  text-decoration: none;
}

.lib-tabs {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 14px 0 8px;
}

.lib-tab-scroll {
  flex: 1;
  min-width: 0;
  display: flex;
  gap: 8px;
  overflow-x: auto;
}

.lib-tab {
  flex: none;
  padding: 7px 15px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 999px;
  background: linear-gradient(180deg, rgba(38, 46, 43, 0.8), rgba(26, 33, 31, 0.72));
  color: #e5e7eb;
  font-size: 13.5px;
  font-weight: 400;
  cursor: pointer;
  outline: none;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
}

.lib-tab.on {
  border-color: transparent;
  background: linear-gradient(180deg, #ffffff, #eaeaf0);
  color: #000000;
  font-weight: 700;
}

.lib-clear {
  flex: none;
  padding: 4px 0;
  border: 0;
  background: none;
  color: #ef4444;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  outline: none;
}

.lib-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 6px;
}

.lib-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 18px;
  background: linear-gradient(180deg, rgba(24, 33, 29, 0.82), rgba(13, 20, 17, 0.9));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1);
  cursor: pointer;
  outline: none;
}

.lib-thumb {
  flex: none;
  display: grid;
  place-items: center;
  width: 52px;
  height: 74px;
  border-radius: 15px;
  overflow: hidden;
  background: #1c2823;
}

.lib-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.lib-fallback {
  font-size: 20px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.3);
}

.lib-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.lib-info strong {
  font-size: 15px;
  font-weight: 700;
  color: #f5f5f7;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lib-info > span:not(.lib-progress) {
  font-size: 12px;
  color: #8e959e;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lib-progress {
  height: 3px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.2);
  overflow: hidden;
}

.lib-progress > span {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: #6ee7b7;
}

.lib-del {
  flex: none;
  padding: 6px 2px 6px 8px;
  border: 0;
  background: none;
  color: #ef4444;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  outline: none;
}

.lib-empty {
  margin: 30px 0 0;
  text-align: center;
  font-size: 13px;
  color: #8e959e;
  line-height: 1.8;
}

.lib-empty-link {
  display: block;
  margin-top: 8px;
  color: var(--accent);
  font-weight: 600;
  text-decoration: none;
}

.tv-mode .lib-page {
  max-width: 1100px;
  padding: 26px 120px 90px 34px;
}

.tv-mode .lib-head h1 {
  font-size: 24px;
}

.tv-mode .lib-tab {
  font-size: 15px;
}

.tv-mode .lib-row {
  padding: 12px;
}

.tv-mode .lib-thumb {
  width: 58px;
  height: 82px;
}
</style>

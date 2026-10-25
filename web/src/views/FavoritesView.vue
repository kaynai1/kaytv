<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { useLibraryStore } from '../stores/library'
import { toast } from '../composables/useToast'
import type { PosterItem } from '../types'
import AppIcon from '../components/AppIcon.vue'
import EmptyState from '../components/EmptyState.vue'
import PosterCard from '../components/PosterCard.vue'
import DetailModal from '../components/DetailModal.vue'

const library = useLibraryStore()
const router = useRouter()
const manage = ref(false)
const modalTarget = ref<{ sourceId: string; id: string } | null>(null)

const favorites = computed(() =>
  [...library.favorites].sort((a, b) => b.addedAt - a.addedAt)
)

const history = computed(() => library.recentHistory.slice(0, 16))

function open(item: PosterItem) {
  if (manage.value) return
  modalTarget.value = { sourceId: item.sourceId, id: item.id }
}

function openHistory(source: string, id: string) {
  modalTarget.value = { sourceId: source, id }
}

function progressOf(source: string, id: string): number {
  const entry = library.progressOf(source, id)
  if (!entry || !entry.duration) return 0
  return entry.position / entry.duration
}

function remove(item: PosterItem) {
  library.removeFavorite(item.sourceId, item.id)
  toast.success('已移出清单')
}

function clearAll() {
  if (!window.confirm('确定清空全部收藏吗？')) return
  library.clearFavorites()
  toast.success('清单已清空')
}

function goSearch() {
  router.push('/search')
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 class="page-title">
          <span class="bar" />
          我的清单
          <span v-if="favorites.length" class="badge accent">{{ favorites.length }}</span>
        </h1>
        <p class="page-desc">
          {{ favorites.length ? '收藏与想看保存在这台设备上，换浏览器需要重新收藏' : '清单为空，去影视专区挑一部加进来' }}
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" data-nav type="button" @click="manage = !manage">
          {{ manage ? '完成管理' : '管理清单' }}
        </button>
        <button v-if="favorites.length" class="btn danger" data-nav type="button" @click="clearAll">
          <AppIcon name="trash" :size="16" />
          清空
        </button>
      </div>
    </div>

    <section v-if="history.length" class="section-block">
      <h2 class="section-title">
        <span class="mark live" />
        看到一半
        <span class="hint">继续上次播放的位置</span>
      </h2>
      <div class="row-scroll hide-scrollbar">
        <PosterCard
          v-for="entry in history"
          :key="`h-${entry.sourceId}:${entry.id}`"
          :item="{
            sourceId: entry.sourceId,
            sourceName: entry.sourceName,
            id: entry.id,
            name: entry.name,
            pic: entry.pic,
            remarks: entry.episodeName || '',
            year: '',
            typeName: entry.episodeName || ''
          }"
          :progress="progressOf(entry.sourceId, entry.id)"
          compact
          @select="openHistory(entry.sourceId, entry.id)"
        />
      </div>
    </section>

    <section class="section-block">
      <h2 class="section-title">
        <span class="mark" />
        想看清单
        <span class="hint">{{ favorites.length }} 部</span>
      </h2>

      <div v-if="favorites.length" class="poster-grid">
        <div v-for="item in favorites" :key="`${item.sourceId}:${item.id}`" class="fav-item">
          <PosterCard :item="item" @select="open" />
          <button
            v-if="manage"
            class="remove-btn"
            data-nav
            type="button"
            :aria-label="`移出清单 ${item.name}`"
            @click="remove(item)"
          >
            <AppIcon name="close" :size="16" />
          </button>
        </div>
      </div>

      <EmptyState
        v-else
        title="清单还是空的"
        message="在影片详情里点「加入清单」，之后可以在这里快速找到；播放记录会自动出现在上方。"
        icon="bookmark"
      >
        <RouterLink class="btn red" to="/" data-nav>去影视专区</RouterLink>
        <button class="btn ghost" data-nav type="button" @click="goSearch">搜索片名</button>
      </EmptyState>
    </section>

    <DetailModal
      v-if="modalTarget"
      :source-id="modalTarget.sourceId"
      :vod-id="modalTarget.id"
      @close="modalTarget = null"
    />
  </div>
</template>

<style scoped>
.fav-item {
  position: relative;
}
.remove-btn {
  position: absolute;
  z-index: 5;
  top: -8px;
  right: -8px;
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(18, 18, 22, 0.95);
  color: #ffb3b3;
  cursor: pointer;
  outline: none;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.45);
}
.remove-btn:hover {
  background: var(--accent);
  color: #fff;
}
.remove-btn:focus {
  outline: 3px solid var(--accent);
  outline-offset: 2px;
  color: var(--text);
}
</style>

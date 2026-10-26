<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AppIcon from '../components/AppIcon.vue'
import { useCloudStore } from '../stores/cloud'
import { toast } from '../composables/useToast'

const cloud = useCloudStore()
const kind = ref('request')
const title = ref('')
const body = ref('')
const contact = ref('')
const sending = ref(false)

const statusLabel: Record<string, string> = {
  open: '待处理',
  done: '已完成',
  ignored: '已忽略'
}
const kindLabel: Record<string, string> = {
  request: '求片',
  problem: '问题',
  other: '建议'
}
const loggedIn = computed(() => cloud.loggedIn)

onMounted(() => {
  if (cloud.loggedIn) void cloud.loadMyFeedback().catch(() => {})
})

async function submit() {
  if (!title.value.trim()) {
    toast.info('请填写标题，例如想看的片名')
    return
  }
  if (body.value.trim().length < 4) {
    toast.info('内容至少写几个字，方便我们处理')
    return
  }
  sending.value = true
  try {
    const message = await cloud.submitFeedback({
      kind: kind.value,
      title: title.value.trim(),
      body: body.value.trim(),
      contact: contact.value.trim()
    })
    toast.success(message)
    title.value = ''
    body.value = ''
    contact.value = ''
    if (cloud.loggedIn) await cloud.loadMyFeedback().catch(() => {})
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '提交失败，请稍后再试')
  } finally {
    sending.value = false
  }
}

function fmt(ms: number) {
  if (!ms) return ''
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}
</script>

<template>
  <div class="page feedback-page">
    <section class="panel feedback-panel">
      <div class="feedback-head">
        <span class="feedback-icon"><AppIcon name="message" :size="24" /></span>
        <div>
          <h1 class="feedback-title">求片与反馈</h1>
          <p class="feedback-sub">
            想看的片子、播放问题或功能建议都可以写在这里，管理员会统一处理。
            <template v-if="!loggedIn">不登录也能提交。</template>
          </p>
        </div>
      </div>

      <div class="kind-row">
        <button
          v-for="item in [
            { value: 'request', label: '求片', hint: '想看但搜不到' },
            { value: 'problem', label: '问题', hint: '播放 / 登录异常' },
            { value: 'other', label: '建议', hint: '功能与体验' }
          ]"
          :key="item.value"
          class="kind-chip"
          :class="{ active: kind === item.value }"
          data-nav
          type="button"
          @click="kind = item.value"
        >
          <strong>{{ item.label }}</strong>
          <span>{{ item.hint }}</span>
        </button>
      </div>

      <label class="field">
        <span class="field-label">{{ kind === 'request' ? '片名 / 剧名' : '标题' }}</span>
        <input
          v-model="title"
          class="input"
          type="text"
          maxlength="80"
          :placeholder="kind === 'request' ? '例如：流浪地球 3 / 某某剧 第二季' : '用一句话概括'"
        />
      </label>

      <label class="field">
        <span class="field-label">{{ kind === 'request' ? '补充信息' : '详细描述' }}</span>
        <textarea
          v-model="body"
          class="input textarea"
          rows="5"
          maxlength="1500"
          :placeholder="
            kind === 'request'
              ? '年代、类型、主演，或者你看过的平台，写清楚更容易找到'
              : '在哪个页面、哪一步出的问题，方便我们复现'
          "
        />
      </label>

      <label class="field">
        <span class="field-label">联系方式（可选）</span>
        <input v-model="contact" class="input" type="text" maxlength="120" placeholder="QQ / 邮箱，方便处理完通知你" />
      </label>

      <div class="feedback-actions">
        <button class="btn primary feedback-submit" data-nav type="button" :disabled="sending" @click="submit">
          <AppIcon name="message" :size="17" />
          {{ sending ? '提交中…' : '提交反馈' }}
        </button>
        <span class="feedback-note">同一 IP 15 秒内只能提交一次，避免刷屏。</span>
      </div>
      <p v-if="!loggedIn" class="feedback-hint">
        想查看处理进度？在「设置 → 云后台」登录云端账号后，提交的反馈会显示在下方。
      </p>
    </section>

    <section v-if="loggedIn" class="panel feedback-history">
      <div class="feedback-history-head">
        <h2>我的反馈</h2>
        <button class="btn sm ghost" data-nav type="button" @click="cloud.loadMyFeedback().catch(() => {})">
          <AppIcon name="refresh" :size="15" />
          刷新
        </button>
      </div>
      <ul v-if="cloud.myFeedback.length" class="feedback-list">
        <li v-for="item in cloud.myFeedback" :key="item.id" class="feedback-item">
          <div class="feedback-item-head">
            <strong>{{ item.title }}</strong>
            <span class="feedback-status" :class="item.status">{{ statusLabel[item.status] || item.status }}</span>
            <span class="feedback-kind">{{ kindLabel[item.kind] || item.kind }}</span>
          </div>
          <p class="feedback-text">{{ item.body }}</p>
          <p v-if="item.adminNote" class="feedback-admin">管理员回复：{{ item.adminNote }}</p>
          <p class="feedback-time">{{ fmt(item.createdAt) }}</p>
        </li>
      </ul>
      <p v-else class="feedback-empty">还没有提交过反馈。</p>
    </section>
  </div>
</template>

<style scoped>
.feedback-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 820px;
  margin: 0 auto;
  padding: clamp(20px, 5vh, 48px) 18px 80px;
}
.feedback-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: clamp(20px, 3vw, 30px);
}
.feedback-head {
  display: flex;
  align-items: flex-start;
  gap: 14px;
}
.feedback-icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 48px;
  height: 48px;
  border-radius: 8px;
  background: rgba(229, 9, 20, 0.14);
  color: var(--accent);
}
.feedback-title {
  margin: 0;
  font-size: 24px;
}
.feedback-sub {
  margin: 6px 0 0;
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.7;
}
.kind-row {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}
.kind-chip {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 14px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.kind-chip span {
  color: var(--muted);
  font-size: 11.5px;
}
.kind-chip.active {
  border-color: var(--accent);
  background: rgba(229, 9, 20, 0.12);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field-label {
  font-size: 11.5px;
  color: var(--muted);
}
.textarea {
  min-height: 120px;
  resize: vertical;
  line-height: 1.7;
}
.feedback-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}
.feedback-submit {
  min-height: 44px;
  padding: 0 24px;
}
.feedback-note,
.feedback-hint {
  color: var(--muted);
  font-size: 11.5px;
}
.feedback-hint {
  margin: 0;
}
.feedback-history {
  padding: clamp(18px, 2.6vw, 26px);
}
.feedback-history-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.feedback-history-head h2 {
  margin: 0;
  font-size: 16px;
}
.feedback-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.feedback-item {
  padding: 12px 14px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.16);
}
.feedback-item-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.feedback-status,
.feedback-kind {
  padding: 1px 7px;
  border-radius: 4px;
  font-size: 10.5px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--muted);
}
.feedback-status.done {
  background: rgba(52, 211, 153, 0.16);
  color: #6ee7b7;
}
.feedback-status.open {
  background: rgba(251, 191, 36, 0.14);
  color: #fcd34d;
}
.feedback-text {
  margin: 8px 0 0;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text);
  white-space: pre-wrap;
}
.feedback-admin {
  margin: 8px 0 0;
  font-size: 12px;
  color: #9fcbff;
}
.feedback-time {
  margin: 8px 0 0;
  font-size: 11px;
  color: var(--muted);
}
.feedback-empty {
  color: var(--muted);
  font-size: 12.5px;
}
@media (max-width: 720px) {
  .kind-row {
    grid-template-columns: 1fr;
  }
}
</style>

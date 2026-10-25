<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSettingsStore } from '../stores/settings'
import AppIcon from '../components/AppIcon.vue'

const settings = useSettingsStore()
const route = useRoute()
const router = useRouter()

const username = ref('admin')
const password = ref('')
const loading = ref(false)
const error = ref('')

const redirect = computed(() => {
  const target = String(route.query.redirect || '')
  return target.startsWith('/') && target !== '/login' ? target : '/'
})

async function submit() {
  if (!username.value.trim() || !password.value) {
    error.value = '请输入账号和密码'
    return
  }
  loading.value = true
  error.value = ''
  try {
    await settings.login(username.value.trim(), password.value)
    password.value = ''
    await router.replace(redirect.value)
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '登录失败'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="page login-page">
    <form class="panel login-card" @submit.prevent="submit">
      <div class="login-brand">
        <span class="brand-mark"><AppIcon name="tv" :size="22" /></span>
        <div>
          <h1 class="login-title">{{ settings.siteName }}</h1>
          <p class="login-sub">登录后观看直播与影视</p>
        </div>
      </div>

      <label class="field">
        <span class="field-label">账号</span>
        <input
          v-model="username"
          class="input"
          type="text"
          autocomplete="username"
          spellcheck="false"
          placeholder="账号（主管理员为 admin）"
          autofocus
        />
      </label>

      <label class="field">
        <span class="field-label">密码</span>
        <input
          v-model="password"
          class="input"
          type="password"
          autocomplete="current-password"
          placeholder="密码"
        />
      </label>

      <p v-if="error" class="login-error">{{ error }}</p>

      <button class="btn primary login-submit" data-nav type="submit" :disabled="loading">
        {{ loading ? '登录中…' : '登录' }}
      </button>

      <p class="login-hint">
        账号由 NAS 管理员在「管理后台 → 用户」中创建。忘记密码请联系管理员重置。
      </p>
      <button class="btn ghost login-back" data-nav type="button" @click="router.push('/')">
        返回首页
      </button>
    </form>
  </div>
</template>

<style scoped>
.login-page {
  display: flex;
  justify-content: center;
  padding: clamp(36px, 9vh, 110px) 20px;
}
.login-card {
  width: min(440px, 100%);
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 30px;
}
.login-brand {
  display: flex;
  align-items: center;
  gap: 12px;
}
.brand-mark {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 6px;
  background: rgba(229, 9, 20, 0.16);
  color: var(--accent);
}
.login-title {
  margin: 0;
  font-size: 21px;
  font-weight: 660;
}
.login-sub {
  margin: 3px 0 0;
  font-size: 12.5px;
  color: var(--muted);
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
.field .input {
  height: 44px;
}
.login-submit {
  min-height: 46px;
  margin-top: 4px;
}
.login-error {
  margin: 0;
  font-size: 12.5px;
  color: #ffb3b3;
}
.login-hint {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--muted);
}
.login-back {
  align-self: center;
  border: 0;
  background: transparent;
}
</style>

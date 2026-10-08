<script setup lang="ts">
import { defineAsyncComponent, onMounted, ref } from 'vue'
import { ShieldCheck, LogOut, LoaderCircle } from '@lucide/vue'
import { useAuthStore } from '../src/stores/auth'

const AdminView = defineAsyncComponent(() => import('../src/pages/AdminView.vue'))

const auth = useAuthStore()
const username = ref('')
const password = ref('')
const authenticated = ref(false)
const checking = ref(true)
const busy = ref(false)
const error = ref('')

async function readResponse(response: Response) {
  return await response.json().catch(() => ({})) as { authenticated?: boolean; message?: string }
}

async function restoreSession() {
  checking.value = true
  try {
    const response = await fetch('/__admin/session', { cache: 'no-store', credentials: 'same-origin' })
    const result = await readResponse(response)
    if (!response.ok) throw new Error(result.message || '无法连接本机管理服务')
    authenticated.value = result.authenticated === true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '无法连接本机管理服务'
  } finally {
    checking.value = false
  }
}

async function signIn() {
  error.value = ''
  if (!username.value.trim() || !password.value) {
    error.value = '请输入本机管理账号和密码。'
    return
  }
  busy.value = true
  try {
    const response = await fetch('/__admin/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.value.trim(), password: password.value }),
    })
    const result = await readResponse(response)
    if (!response.ok) throw new Error(result.message || '账号或密码错误')
    password.value = ''
    authenticated.value = true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '登录失败，请重试。'
  } finally {
    busy.value = false
  }
}

async function signOut() {
  busy.value = true
  try {
    await fetch('/__admin/logout', { method: 'POST', credentials: 'same-origin' })
  } finally {
    await auth.signOut().catch(() => undefined)
    authenticated.value = false
    password.value = ''
    error.value = ''
    busy.value = false
  }
}

onMounted(() => { void restoreSession() })
</script>

<template>
  <main v-if="checking" class="local-admin-loading">
    <LoaderCircle :size="24" class="local-admin-spin" />
    <span>正在检查本机登录状态…</span>
  </main>

  <main v-else-if="!authenticated" class="local-admin-login-page">
    <section class="local-admin-login-card" aria-labelledby="local-admin-title">
      <div class="local-admin-login-mark"><ShieldCheck :size="23" /></div>
      <div class="local-admin-kicker">JIWANG · LOCAL ONLY</div>
      <h1 id="local-admin-title">本机管理端</h1>
      <p class="local-admin-login-copy">此入口只监听本机回环地址。请使用独立于用户站的管理账号登录。</p>
      <form class="local-admin-form" @submit.prevent="signIn">
        <label for="local-admin-username">管理账号</label>
        <input id="local-admin-username" v-model="username" name="username" type="text" autocomplete="username" autofocus />
        <label for="local-admin-password">管理密码</label>
        <input id="local-admin-password" v-model="password" name="password" type="password" autocomplete="current-password" />
        <p v-if="error" class="local-admin-error" role="alert">{{ error }}</p>
        <button class="local-admin-submit" type="submit" :disabled="busy">
          {{ busy ? '正在验证…' : '登录管理后台' }}
        </button>
      </form>
      <p class="local-admin-footnote">账号只从本机 <code>.env.admin.local</code> 读取；管理会话为 HttpOnly Cookie，不保存到浏览器本地存储。</p>
    </section>
  </main>

  <div v-else class="local-admin-shell">
    <header class="local-admin-topbar">
      <div class="local-admin-brand"><span class="local-admin-brand-icon"><ShieldCheck :size="17" /></span><span><b>极汪</b><small>本机管理端</small></span></div>
      <div class="local-admin-topbar-right"><span class="local-only-pill"><i></i>仅本机</span><button class="local-admin-logout" type="button" :disabled="busy" @click="signOut"><LogOut :size="15" />退出管理端</button></div>
    </header>
    <AdminView />
  </div>
</template>

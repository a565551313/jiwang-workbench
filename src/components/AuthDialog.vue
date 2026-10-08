<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useAuthStore } from '../stores/auth'
import { supabaseConfigured } from '../lib/supabase'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
const auth = useAuthStore()
const mode = ref<'login' | 'signup'>('login')
const email = ref('')
const password = ref('')
const displayName = ref('')
const busy = ref(false)
const authError = ref('')
const visible = ref(false)
watch(() => props.modelValue, (value) => { visible.value = value })
watch(visible, (value) => emit('update:modelValue', value))

function humanizeAuthError(error: unknown) {
  const message = error instanceof Error ? error.message : ''
  if (/invalid login credentials/i.test(message)) return '邮箱或密码不匹配，请检查登录信息后重试。'
  if (/email not confirmed/i.test(message)) return '该邮箱尚未完成验证，请先查收并点击验证邮件。'
  return message || '登录失败，请稍后重试。'
}

async function submit() {
  authError.value = ''
  if (!email.value.trim() || !password.value) {
    ElMessage.warning('请填写邮箱和密码')
    return
  }
  if (password.value.length < 8) {
    ElMessage.warning('密码至少需要 8 位')
    return
  }
  busy.value = true
  try {
    if (mode.value === 'login') {
      await auth.signIn(email.value.trim(), password.value)
      ElMessage.success('欢迎回来')
    } else {
      const result = await auth.signUp(email.value.trim(), password.value, displayName.value.trim())
      ElMessage.success(result.confirmationRequired ? '注册成功，请前往邮箱完成确认' : '注册成功，欢迎加入极汪')
    }
    visible.value = false
  } catch (error) {
    authError.value = humanizeAuthError(error)
  } finally {
    busy.value = false
  }
}

async function resendConfirmation() {
  const targetEmail = email.value.trim()
  if (!targetEmail) {
    ElMessage.warning('请先填写注册邮箱')
    return
  }
  busy.value = true
  try {
    await auth.resendConfirmation(targetEmail)
    ElMessage.success('验证邮件已重新发送，请查收邮箱')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '验证邮件发送失败，请稍后重试')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <el-dialog v-model="visible" width="420px" :show-close="true" :close-on-click-modal="!busy" class="auth-dialog" align-center>
    <div class="auth-mark"><span>汪</span></div>
    <p class="eyebrow">JIWANG ACCOUNT</p>
    <h2>{{ mode === 'login' ? '欢迎回来' : '创建你的账号' }}</h2>
    <p class="auth-intro">{{ mode === 'login' ? '登录后，创作和素材将同步保存。' : '用邮箱开启你的第一套表情。' }}</p>
    <el-alert v-if="!supabaseConfigured" type="warning" :closable="false" show-icon class="auth-alert">
      云端邮箱认证尚未启用。请按项目 README 配置 Supabase 后，注册与登录即可使用。
    </el-alert>
    <el-alert v-if="authError" type="error" :closable="false" show-icon class="auth-alert">{{ authError }}</el-alert>
    <el-form @submit.prevent="submit" class="auth-form">
      <el-form-item v-if="mode === 'signup'" label="昵称">
        <el-input v-model="displayName" placeholder="怎么称呼你" maxlength="24" />
      </el-form-item>
      <el-form-item label="邮箱">
        <el-input v-model="email" type="email" autocomplete="email" placeholder="you@example.com" @input="authError = ''" @keyup.enter="submit" />
      </el-form-item>
      <el-form-item label="密码">
        <el-input v-model="password" type="password" autocomplete="current-password" show-password placeholder="至少 8 位" @input="authError = ''" @keyup.enter="submit" />
      </el-form-item>
      <el-button class="primary-button auth-submit" type="primary" :loading="busy" :disabled="!supabaseConfigured" @click="submit">
        {{ mode === 'login' ? '邮箱登录' : '注册并继续' }}
      </el-button>
      <el-button v-if="mode === 'login'" class="auth-resend" link type="primary" :loading="busy" :disabled="!supabaseConfigured" @click="resendConfirmation">
        还没收到验证邮件？重新发送
      </el-button>
    </el-form>
    <p class="auth-switch">
      {{ mode === 'login' ? '还没有账号？' : '已经有账号？' }}
      <button type="button" @click="mode = mode === 'login' ? 'signup' : 'login'">{{ mode === 'login' ? '免费注册' : '返回登录' }}</button>
    </p>
    <div class="auth-footnote"><span class="tiny-shield">✓</span> 邮箱认证 · 私有素材 · 按账号隔离</div>
  </el-dialog>
</template>

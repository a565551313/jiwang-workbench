<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Check, Clock3, History, LoaderCircle, RefreshCw, WandSparkles, X } from '@lucide/vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { fetchJobs } from '../lib/repository'
import { explainGenerationError, loadEnabledImageModels, retryGenerationJob } from '../lib/generation'
import { supabaseConfigured } from '../lib/supabase'
import { useAuthStore } from '../stores/auth'
import type { GenerationJob } from '../types'

const router = useRouter()
const auth = useAuthStore()
const jobs = ref<GenerationJob[]>([])
const loading = ref(true)
const loadError = ref('')
const retryingJobId = ref('')
const completedCount = computed(() => jobs.value.filter((job) => job.status === 'completed' || job.status === 'partial').length)
const sourceLabel = computed(() => auth.user?.id && supabaseConfigured ? '账号云端记录' : '本机演示记录')
async function load() {
  loading.value = true
  loadError.value = ''
  try { jobs.value = await fetchJobs(auth.user?.id) }
  catch (error) {
    jobs.value = []
    loadError.value = `任务历史加载失败：${error instanceof Error ? error.message : '云端暂时不可用'}。请检查网络和登录状态后重试；在任务状态可见前，不能据此确认退款已到账。`
  }
  finally { loading.value = false }
}
function dateLabel(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}
function statusLabel(status: GenerationJob['status']) {
  if (status === 'completed') return '已完成'
  if (status === 'partial') return '部分完成'
  if (status === 'failed') return '失败'
  return status === 'processing' ? '生成中' : '排队中'
}
function deliveredLabel(job: GenerationJob) {
  return `已交付 ${job.completedCount ?? 0}/16 张`
}

/**
 * Retrying is the owner's decision: the price is shown and confirmed before anything is charged.
 * The server charges the current model price as a new attempt.
 */
async function retryJob(job: GenerationJob) {
  if (!auth.user?.id || !supabaseConfigured) { ElMessage.warning('请先登录后再重新生成'); return }
  if (retryingJobId.value) return
  let started = false
  try {
    const available = await loadEnabledImageModels()
    const model = available.find((item) => item.id === job.modelId)
    if (!model) {
      ElMessage.warning('该任务使用的模型当前未启用，无法重新生成；请到创作工坊选择其他模型')
      return
    }
    await ElMessageBox.confirm(
      `将按当前价格重新预扣 ${model.priceCoins} 汪币，并重新生成这套 16 张表情。成功后结算；未交付的部分会自动退回。确认继续？`,
      `重新生成：${job.title}`,
      { confirmButtonText: `确认扣除 ${model.priceCoins} 汪币`, cancelButtonText: '取消', type: 'warning' },
    )
    started = true
    retryingJobId.value = job.id
    const result = await retryGenerationJob(job.id)
    ElMessage.success(result.status === 'partial'
      ? `已交付 ${result.deliveredCount}/16 张，未交付部分已退回 ${result.refundedCoins ?? 0} 汪币`
      : '重新生成完成，已保存到素材库')
  } catch (cause) {
    if (cause !== 'cancel' && cause !== 'close') {
      ElMessage.error(cause instanceof Error ? explainGenerationError(cause) : '重新生成失败')
    }
  } finally {
    retryingJobId.value = ''
    if (started) await load()
  }
}

onMounted(() => { void load() })
watch(() => auth.user?.id, () => { void load() })
</script>

<template>
  <div class="history-page">
    <div class="subpage-heading">
      <div><div class="eyebrow">CREATION HISTORY</div><h1>生成记录</h1><p>查看你的表情套装生成流水与当前状态。</p></div>
      <el-button class="soft-button" @click="load"><RefreshCw :size="14" />刷新记录</el-button>
    </div>
    <el-alert class="subtle-alert" type="info" :closable="false" show-icon>{{ sourceLabel }} · 生成由服务端模型处理；未交付的部分会自动退回汪币，请以余额和退款记录为准。</el-alert>
    <el-alert v-if="loadError" class="subtle-alert" type="error" :closable="false" show-icon>{{ loadError }} <el-button link type="primary" @click="load">重试读取</el-button></el-alert>
    <div class="assets-toolbar"><div class="asset-count"><strong>{{ jobs.length }}</strong>条任务 <span>· 已完成 {{ completedCount }} 条</span></div></div>
    <div v-if="loading" class="empty-state"><div class="empty-state-inner"><LoaderCircle class="spin" :size="28" color="#3977d4" /><p>正在加载任务…</p></div></div>
    <div v-else-if="jobs.length" class="history-list">
      <article v-for="job in jobs" :key="job.id" class="history-row">
        <div class="history-icon"><WandSparkles :size="18" /></div>
        <div class="history-info">
          <strong>{{ job.title }}</strong>
          <p>{{ job.topic || '日常聊天' }} <span>·</span> {{ job.status === 'completed' || job.status === 'partial' ? deliveredLabel(job) : '16 格' }} <template v-if="job.attempt && job.attempt > 1"><span>·</span> 第 {{ job.attempt }} 次尝试</template> <template v-if="job.modelName"><span>·</span> {{ job.modelName }}</template><template v-if="job.priceCoins"><span>·</span> {{ job.priceCoins }} 汪币</template> <span>·</span> {{ sourceLabel }}</p>
          <p v-if="job.status === 'failed' && job.errorMessage" class="history-error">{{ explainGenerationError(job.errorMessage) }}</p>
          <p v-else-if="job.status === 'partial' && job.errorMessage" class="history-note">{{ job.errorMessage }}</p>
          <el-button v-if="job.status === 'failed'" class="table-action" link type="primary" :loading="retryingJobId === job.id" :disabled="Boolean(retryingJobId)" @click="retryJob(job)"><RefreshCw :size="13" />重新生成（需确认扣费）</el-button>
        </div>
        <div class="history-status" :class="{ failed: job.status === 'failed' }"><Check v-if="job.status === 'completed' || job.status === 'partial'" :size="12" /><X v-else-if="job.status === 'failed'" :size="12" /><Clock3 v-else :size="12" />{{ statusLabel(job.status) }}</div>
        <time class="history-date">{{ dateLabel(job.finishedAt || job.createdAt) }}</time>
      </article>
    </div>
    <div v-else class="empty-state"><div class="empty-state-inner"><div class="empty-illustration"><History :size="24" /></div><h2>还没有生成任务</h2><p>创建第一套 16 格表情后，任务状态和费用会显示在这里。</p><el-button class="primary-button" type="primary" @click="router.push('/studio')"><WandSparkles :size="15" />开始创作</el-button></div></div>
  </div>
</template>

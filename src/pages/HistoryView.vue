<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Check, Clock3, History, LoaderCircle, RefreshCw, WandSparkles, X } from '@lucide/vue'
import { fetchJobs } from '../lib/repository'
import { supabaseConfigured } from '../lib/supabase'
import { useAuthStore } from '../stores/auth'
import type { GenerationJob } from '../types'

const router = useRouter()
const auth = useAuthStore()
const jobs = ref<GenerationJob[]>([])
const loading = ref(true)
const completedCount = computed(() => jobs.value.filter((job) => job.status === 'completed').length)
const sourceLabel = computed(() => auth.user?.id && supabaseConfigured ? '账号云端记录' : '本机演示记录')
async function load() {
  loading.value = true
  try { jobs.value = await fetchJobs(auth.user?.id) }
  finally { loading.value = false }
}
function dateLabel(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}
function statusLabel(status: GenerationJob['status']) {
  return status === 'completed' ? '已完成' : status === 'failed' ? '失败' : status === 'processing' ? '生成中' : '排队中'
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
    <el-alert class="subtle-alert" type="info" :closable="false" show-icon>{{ sourceLabel }} · 任务由本地 Mock 提供器完成，不会调用真实模型或扣除汪币。</el-alert>
    <div class="assets-toolbar"><div class="asset-count"><strong>{{ jobs.length }}</strong>条任务 <span>· 已完成 {{ completedCount }} 条</span></div></div>
    <div v-if="loading" class="empty-state"><div class="empty-state-inner"><LoaderCircle class="spin" :size="28" color="#719073" /><p>正在加载任务…</p></div></div>
    <div v-else-if="jobs.length" class="history-list">
      <article v-for="job in jobs" :key="job.id" class="history-row">
        <div class="history-icon"><WandSparkles :size="18" /></div>
        <div class="history-info"><strong>{{ job.title }}</strong><p>{{ job.topic || '日常聊天' }} <span>·</span> {{ job.assetCount || 16 }} 格 <span>·</span> {{ sourceLabel }}</p></div>
        <div class="history-status" :class="{ failed: job.status === 'failed' }"><Check v-if="job.status === 'completed'" :size="12" /><X v-else-if="job.status === 'failed'" :size="12" /><Clock3 v-else :size="12" />{{ statusLabel(job.status) }}</div>
        <time class="history-date">{{ dateLabel(job.finishedAt || job.createdAt) }}</time>
      </article>
    </div>
    <div v-else class="empty-state"><div class="empty-state-inner"><div class="empty-illustration"><History :size="24" /></div><h2>还没有生成任务</h2><p>完成第一套 16 格草案并生成演示素材后，任务会出现在这里。</p><el-button class="primary-button" type="primary" @click="router.push('/studio')"><WandSparkles :size="15" />开始创作</el-button></div></div>
  </div>
</template>

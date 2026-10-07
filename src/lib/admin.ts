import { supabase, supabaseConfigured } from './supabase'
import type { GenerationJob } from '../types'

export interface AdminUser {
  userId: string
  email: string
  displayName: string
  createdAt: string
  coins: number
  totalCount: number
}

export interface AdminJob {
  jobId: string
  userEmail: string
  title: string
  topic: string
  status: GenerationJob['status']
  createdAt: string
  finishedAt?: string
  assetCount: number
}

export interface AdminMetrics {
  users: number
  jobs: number
  todayJobs: number
  failedJobs: number
  assets: number
  coinsInCirculation: number
}

export interface AdminSettings {
  themes: { presets: string[] }
  prompts: { sticker: string }
  model: { provider: string; name: string; endpoint: string; enabled: boolean; secretConfigured: boolean }
  features: { signup: boolean; customThemes: boolean; communitySubmissions: boolean; maintenance: boolean }
}

export interface AdminWorkspace {
  metrics: AdminMetrics
  users: AdminUser[]
  jobs: AdminJob[]
  settings: AdminSettings
  demo: boolean
}

export const defaultAdminSettings: AdminSettings = {
  themes: { presets: ['日常聊天', '可爱撒娇', '上班摸鱼', '节日限定', '自定义主题'] },
  prompts: { sticker: '生成一套统一角色设定的聊天表情。每格保持清晰轮廓、单一动作和易读情绪；透明背景，主体居中。主题：{{topic}}；单格描述：{{caption}}；画面：{{visual}}。' },
  model: { provider: 'OpenAI 兼容接口', name: 'gpt-image-2.5', endpoint: '', enabled: false, secretConfigured: false },
  features: { signup: true, customThemes: true, communitySubmissions: false, maintenance: false },
}

const SETTINGS_KEY = 'jiwang:admin:settings:v1'
const DEMO_WALLETS_KEY = 'jiwang:admin:wallets:v1'
const DEMO_JOBS_KEY = 'jiwang:admin:demo-jobs:v1'
const JOBS_KEY = 'jiwang:jobs:v1'

function readLocal<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key)
    return value ? JSON.parse(value) as T : fallback
  } catch {
    return fallback
  }
}

function sampleJobs(): AdminJob[] {
  const localJobs = readLocal<GenerationJob[]>(JOBS_KEY, [])
  if (localJobs.length) return localJobs.slice(0, 30).map((job) => ({
    jobId: job.id,
    userEmail: '本机演示用户',
    title: job.title,
    topic: job.topic,
    status: job.status,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    assetCount: job.assetCount ?? 16,
  }))
  const now = Date.now()
  const seeded: GenerationJob[] = [
    { id: 'demo-job-1003', title: '周一不想上班', topic: '上班摸鱼', status: 'completed', createdAt: new Date(now - 18 * 60_000).toISOString(), finishedAt: new Date(now - 16 * 60_000).toISOString(), assetCount: 16 },
    { id: 'demo-job-1002', title: '今天也要开心', topic: '日常聊天', status: 'processing', createdAt: new Date(now - 7 * 60_000).toISOString(), assetCount: 0 },
    { id: 'demo-job-1001', title: '节日快乐小狗', topic: '节日限定', status: 'failed', createdAt: new Date(now - 90 * 60_000).toISOString(), finishedAt: new Date(now - 89 * 60_000).toISOString(), assetCount: 0 },
  ]
  const existing = readLocal<GenerationJob[]>(DEMO_JOBS_KEY, [])
  const jobs = existing.length ? existing : seeded
  if (!existing.length) localStorage.setItem(DEMO_JOBS_KEY, JSON.stringify(seeded))
  return jobs.map((job) => ({ jobId: job.id, userEmail: 'demo@jiwang.local', title: job.title, topic: job.topic, status: job.status, createdAt: job.createdAt, finishedAt: job.finishedAt, assetCount: job.assetCount ?? 16 }))
}

function sampleUsers(): AdminUser[] {
  const saved = readLocal<Record<string, number>>(DEMO_WALLETS_KEY, {})
  return [
    { userId: 'demo-user-01', email: 'demo@jiwang.local', displayName: '演示用户', createdAt: new Date(Date.now() - 7 * 86_400_000).toISOString(), coins: saved['demo-user-01'] ?? 128, totalCount: 3 },
    { userId: 'demo-user-02', email: 'creator@jiwang.local', displayName: '创作者小汪', createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), coins: saved['demo-user-02'] ?? 64, totalCount: 3 },
    { userId: 'demo-user-03', email: 'new@jiwang.local', displayName: '新朋友', createdAt: new Date(Date.now() - 86_400_000).toISOString(), coins: saved['demo-user-03'] ?? 20, totalCount: 3 },
  ]
}

function normalizeSettings(rows: Array<{ setting_key: string; value: unknown }>): AdminSettings {
  const values = Object.fromEntries(rows.map((row) => [row.setting_key, row.value])) as Partial<AdminSettings>
  return {
    themes: { ...defaultAdminSettings.themes, ...(values.themes || {}) },
    prompts: { ...defaultAdminSettings.prompts, ...(values.prompts || {}) },
    model: { ...defaultAdminSettings.model, ...(values.model || {}) },
    features: { ...defaultAdminSettings.features, ...(values.features || {}) },
  }
}

export async function loadAdminWorkspace(): Promise<AdminWorkspace> {
  if (!supabase || !supabaseConfigured) {
    const jobs = sampleJobs()
    const users = sampleUsers()
    const settings = { ...defaultAdminSettings, ...readLocal<Partial<AdminSettings>>(SETTINGS_KEY, {}) }
    const realJobs = readLocal<GenerationJob[]>(JOBS_KEY, [])
    return {
      demo: true,
      metrics: {
        users: users.length,
        jobs: realJobs.length || 128,
        todayJobs: realJobs.filter((job) => Date.now() - new Date(job.createdAt).getTime() < 86_400_000).length || 24,
        failedJobs: jobs.filter((job) => job.status === 'failed').length,
        assets: 864,
        coinsInCirculation: users.reduce((sum, user) => sum + user.coins, 0),
      },
      users,
      jobs,
      settings,
    }
  }

  const [metricsResult, usersResult, jobsResult, settingsResult] = await Promise.all([
    supabase.rpc('admin_dashboard_metrics'),
    supabase.rpc('admin_list_users', { p_limit: 100, p_offset: 0 }),
    supabase.rpc('admin_list_jobs', { p_limit: 100 }),
    supabase.from('admin_settings').select('setting_key,value'),
  ])
  const failure = metricsResult.error || usersResult.error || jobsResult.error || settingsResult.error
  if (failure) throw new Error(failure.message)

  const metricsRaw = (metricsResult.data || {}) as Record<string, number>
  const users = (usersResult.data || []) as Array<{ user_id: string; email: string | null; display_name: string | null; created_at: string; coins: number; total_count: number }>
  const jobs = (jobsResult.data || []) as Array<{ job_id: string; user_email: string | null; title: string; topic: string; status: GenerationJob['status']; created_at: string; finished_at: string | null; asset_count: number | null }>
  const settingsRows = (settingsResult.data || []) as Array<{ setting_key: string; value: unknown }>
  return {
    demo: false,
    metrics: {
      users: Number(metricsRaw.users || 0),
      jobs: Number(metricsRaw.jobs || 0),
      todayJobs: Number(metricsRaw.today_jobs || 0),
      failedJobs: Number(metricsRaw.failed_jobs || 0),
      assets: Number(metricsRaw.assets || 0),
      coinsInCirculation: Number(metricsRaw.coins_in_circulation || 0),
    },
    users: users.map((user) => ({ userId: user.user_id, email: user.email || '—', displayName: user.display_name || '极汪用户', createdAt: user.created_at, coins: Number(user.coins || 0), totalCount: Number(user.total_count || 0) })),
    jobs: jobs.map((job) => ({ jobId: job.job_id, userEmail: job.user_email || '—', title: job.title, topic: job.topic, status: job.status, createdAt: job.created_at, finishedAt: job.finished_at || undefined, assetCount: Number(job.asset_count || 0) })),
    settings: normalizeSettings(settingsRows),
  }
}

export async function saveAdminSettings(settings: AdminSettings, demo: boolean, userId?: string) {
  if (demo || !supabase) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    return
  }
  const rows = Object.entries(settings).map(([setting_key, value]) => ({ setting_key, value, updated_by: userId || null }))
  const { error } = await supabase.from('admin_settings').upsert(rows, { onConflict: 'setting_key' })
  if (error) throw new Error(error.message)
}

export async function saveAdminModelApiKey(apiKey: string) {
  if (!supabase || !supabaseConfigured) throw new Error('请先配置 Supabase 后再安全保存第三方 API Key')
  if (apiKey.trim().length < 8 || apiKey.length > 8192) throw new Error('API Key 长度无效')
  const { error } = await supabase.rpc('admin_set_model_api_key', { p_api_key: apiKey })
  if (error) throw new Error('API Key 未能安全保存；请确认后台迁移已应用且当前用户拥有管理员权限')
}

export async function requeueAdminJob(jobId: string, demo: boolean) {
  if (demo || !supabase) {
    const jobs = readLocal<GenerationJob[]>(JOBS_KEY, [])
    const target = jobs.find((job) => job.id === jobId)
    if (target) {
      target.status = 'queued'
      target.finishedAt = undefined
      localStorage.setItem(JOBS_KEY, JSON.stringify(jobs))
      return
    }
    const demoJobs = readLocal<GenerationJob[]>(DEMO_JOBS_KEY, [])
    const demoTarget = demoJobs.find((job) => job.id === jobId)
    if (demoTarget) {
      demoTarget.status = 'queued'
      demoTarget.finishedAt = undefined
      localStorage.setItem(DEMO_JOBS_KEY, JSON.stringify(demoJobs))
    }
    return
  }
  const { error } = await supabase.from('generation_jobs').update({ status: 'queued', finished_at: null }).eq('id', jobId).eq('status', 'failed')
  if (error) throw new Error(error.message)
}

export async function adjustAdminWallet(userId: string, delta: number, note: string, demo: boolean) {
  if (!Number.isInteger(delta) || delta === 0) throw new Error('汪币调整数必须是非零整数')
  if (demo || !supabase) {
    const wallets = readLocal<Record<string, number>>(DEMO_WALLETS_KEY, {})
    const user = sampleUsers().find((item) => item.userId === userId)
    const current = wallets[userId] ?? user?.coins ?? 0
    if (current + delta < 0) throw new Error('调整后余额不能小于 0')
    wallets[userId] = current + delta
    localStorage.setItem(DEMO_WALLETS_KEY, JSON.stringify(wallets))
    return
  }
  const { error } = await supabase.rpc('admin_adjust_wallet', { p_user_id: userId, p_delta: delta, p_note: note })
  if (error) throw new Error(error.message)
}

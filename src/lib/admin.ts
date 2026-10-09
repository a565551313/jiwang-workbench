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
  modelName?: string
  priceCoins?: number
  createdAt: string
  finishedAt?: string
  /** Images actually delivered (0–16). */
  deliveredCount: number
  attempt: number
  errorMessage?: string
}

export interface AdminMetrics {
  users: number
  jobs: number
  todayJobs: number
  failedJobs: number
  assets: number
  coinsInCirculation: number
}

export type ImageApiProtocol = 'responses' | 'chat_completions'

export interface AdminImageModel {
  id: string
  name: string
  enabled: boolean
  priceCoins: number
}

export interface AdminImageProvider {
  id: string
  name: string
  protocol: ImageApiProtocol
  baseUrl: string
  secretConfigured: boolean
  models: AdminImageModel[]
}

/** True when the Base URL differs from the saved one (trailing slashes ignored, as on the server). */
export function baseUrlChanged(current: string, saved: string): boolean {
  return current.trim().replace(/\/+$/, '') !== saved.trim().replace(/\/+$/, '')
}

/**
 * `originalBaseUrl` is the value stored on the server. Changing the Base URL of a provider whose key is saved
 * requires typing the key again; otherwise the server (correctly) refuses to use the old key.
 */
export function getProviderSaveIssues(provider: AdminImageProvider, apiKey: string, originalBaseUrl?: string): string[] {
  const issues: string[] = []
  const trimmedKey = apiKey.trim()
  const modelIds = provider.models.map((model) => model.name.trim())

  if (!provider.name.trim()) issues.push('请填写供应商名称。')
  if (!provider.baseUrl.trim().startsWith('https://')) issues.push('请填写有效的 HTTPS Base URL。')
  if (originalBaseUrl !== undefined && provider.secretConfigured && !trimmedKey && baseUrlChanged(provider.baseUrl, originalBaseUrl)) {
    issues.push('修改 Base URL 后必须重新输入 API Key；旧密钥只会发送到保存时的地址，不会用于新地址。')
  }
  if (modelIds.some((name) => !name)) issues.push('请填写每个模型 ID。')
  if (new Set(modelIds).size !== modelIds.length) issues.push('同一供应商下的模型 ID 不能重复。')
  if (trimmedKey && (trimmedKey.length < 8 || apiKey.length > 8192)) issues.push('API Key 长度无效。')

  const enabledModels = provider.models
    .map((model, index) => ({ model, index }))
    .filter(({ model }) => model.enabled)
  if (enabledModels.length && !provider.secretConfigured && !trimmedKey) {
    issues.push('已勾选模型，但供应商 API Key 尚未保存；请先填写 API Key。')
  }
  for (const { model, index } of enabledModels) {
    if (!Number.isInteger(model.priceCoins) || model.priceCoins < 1 || model.priceCoins > 100000) {
      const label = model.name.trim() || `第 ${index + 1} 个模型`
      issues.push(`模型「${label}」已勾选，但汪币价格无效；请设置 1–100000 的整数价格后再保存。`)
    }
  }
  return issues
}

export interface AdminSettings {
  prompts: { sticker: string }
  model: { providers: AdminImageProvider[] }
  features: { signup: boolean; customThemes: boolean; communitySubmissions: boolean; maintenance: boolean }
}

export interface AdminWorkspace {
  metrics: AdminMetrics
  users: AdminUser[]
  jobs: AdminJob[]
  settings: AdminSettings
  demo: boolean
  providerModelSchemaReady: boolean
}

export const defaultAdminSettings: AdminSettings = {
  prompts: { sticker: '生成一套统一角色设定的聊天表情。每格保持清晰轮廓、单一动作和易读情绪；透明背景，主体居中。主题：{{topic}}；单格描述：{{caption}}；画面：{{visual}}。' },
  model: { providers: [] },
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
    deliveredCount: job.completedCount ?? 0,
    attempt: job.attempt ?? 1,
    errorMessage: job.errorMessage,
  }))
  const now = Date.now()
  const seeded: Array<GenerationJob & { completedCount: number }> = [
    { id: 'demo-job-1003', title: '周一不想上班', topic: '上班摸鱼', status: 'completed', createdAt: new Date(now - 18 * 60_000).toISOString(), finishedAt: new Date(now - 16 * 60_000).toISOString(), completedCount: 16 },
    { id: 'demo-job-1002', title: '今天也要开心', topic: '日常聊天', status: 'processing', createdAt: new Date(now - 7 * 60_000).toISOString(), completedCount: 0 },
    { id: 'demo-job-1001', title: '节日快乐小狗', topic: '节日限定', status: 'failed', createdAt: new Date(now - 90 * 60_000).toISOString(), finishedAt: new Date(now - 89 * 60_000).toISOString(), completedCount: 0 },
  ]
  const existing = readLocal<Array<GenerationJob & { completedCount: number }>>(DEMO_JOBS_KEY, [])
  const jobs = existing.length ? existing : seeded
  if (!existing.length) localStorage.setItem(DEMO_JOBS_KEY, JSON.stringify(seeded))
  return jobs.map((job) => ({ jobId: job.id, userEmail: 'demo@jiwang.local', title: job.title, topic: job.topic, status: job.status, createdAt: job.createdAt, finishedAt: job.finishedAt, deliveredCount: job.completedCount ?? 0, attempt: 1 }))
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
  const rawModel = values.model as unknown as Record<string, unknown> | undefined
  const normalizeModel = (model: Partial<AdminImageModel>, index: number): AdminImageModel => ({
    id: typeof model.id === 'string' && model.id ? model.id : crypto.randomUUID(),
    name: typeof model.name === 'string' ? model.name : `图像模型 ${index + 1}`,
    enabled: model.enabled === true,
    priceCoins: Number.isInteger(Number(model.priceCoins)) ? Number(model.priceCoins) : 0,
  })
  const providerList: AdminImageProvider[] = Array.isArray(rawModel?.providers)
    ? (rawModel.providers as Array<Partial<AdminImageProvider>>).map((provider, providerIndex) => ({
      id: typeof provider.id === 'string' && provider.id ? provider.id : crypto.randomUUID(),
      name: typeof provider.name === 'string' ? provider.name : `供应商 ${providerIndex + 1}`,
      protocol: provider.protocol === 'chat_completions' ? 'chat_completions' : 'responses',
      baseUrl: typeof provider.baseUrl === 'string' ? provider.baseUrl : '',
      secretConfigured: provider.secretConfigured === true,
      models: Array.isArray(provider.models)
        ? (provider.models as Array<Partial<AdminImageModel>>).map(normalizeModel)
        : [],
    }))
    : Array.isArray(rawModel?.models)
      ? (rawModel.models as Array<Record<string, unknown>>).map((legacy, index) => {
        const modelId = typeof legacy.id === 'string' && legacy.id ? legacy.id : crypto.randomUUID()
        return {
          id: modelId,
          name: typeof legacy.provider === 'string' ? legacy.provider : 'OpenAI 兼容接口',
          protocol: 'responses' as const,
          baseUrl: typeof legacy.endpoint === 'string' ? legacy.endpoint : '',
          secretConfigured: legacy.secretConfigured === true,
          models: [normalizeModel({
            id: modelId,
            name: typeof legacy.name === 'string' ? legacy.name : `图像模型 ${index + 1}`,
            enabled: legacy.enabled === true,
            priceCoins: Number.isInteger(Number(legacy.priceCoins)) ? Number(legacy.priceCoins) : 0,
          }, index)],
        }
      })
      : []
  return {
    prompts: { ...defaultAdminSettings.prompts, ...(values.prompts || {}) },
    model: { providers: providerList },
    features: { ...defaultAdminSettings.features, ...(values.features || {}) },
  }
}

export async function loadAdminWorkspace(): Promise<AdminWorkspace> {
  if (!supabase || !supabaseConfigured) {
    const jobs = sampleJobs()
    const users = sampleUsers()
    const localSettings = readLocal<Record<string, unknown>>(SETTINGS_KEY, {})
    const settings = normalizeSettings(Object.entries(localSettings).map(([setting_key, value]) => ({ setting_key, value })))
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
      providerModelSchemaReady: true,
    }
  }

  const [metricsResult, usersResult, jobsResult, settingsResult] = await Promise.all([
    supabase.rpc('admin_dashboard_metrics'),
    supabase.rpc('admin_list_users', { p_limit: 100, p_offset: 0 }),
    supabase.rpc('admin_list_jobs_with_model', { p_limit: 100 }),
    supabase.from('admin_settings').select('setting_key,value'),
  ])
  const failure = metricsResult.error || usersResult.error || jobsResult.error || settingsResult.error
  if (failure) throw new Error(failure.message)

  const metricsRaw = (metricsResult.data || {}) as Record<string, number>
  const users = (usersResult.data || []) as Array<{ user_id: string; email: string | null; display_name: string | null; created_at: string; coins: number; total_count: number }>
  const jobs = (jobsResult.data || []) as Array<{ job_id: string; user_email: string | null; title: string; topic: string; status: GenerationJob['status']; created_at: string; finished_at: string | null; completed_count: number; attempt: number; model_name: string | null; price_coins: number | null; error_message: string | null }>
  const settingsRows = (settingsResult.data || []) as Array<{ setting_key: string; value: unknown }>
  const modelValue = settingsRows.find((row) => row.setting_key === 'model')?.value
  const providerModelSchemaReady = Boolean(modelValue && typeof modelValue === 'object' && Array.isArray((modelValue as Record<string, unknown>).providers))
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
    jobs: jobs.map((job) => ({
      jobId: job.job_id,
      userEmail: job.user_email || '—',
      title: job.title,
      topic: job.topic,
      status: job.status,
      modelName: job.model_name || undefined,
      priceCoins: job.price_coins ?? undefined,
      createdAt: job.created_at,
      finishedAt: job.finished_at || undefined,
      deliveredCount: Number(job.completed_count || 0),
      attempt: Number(job.attempt || 1),
      errorMessage: job.error_message || undefined,
    })),
    settings: normalizeSettings(settingsRows),
    providerModelSchemaReady,
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

export async function saveAdminProviderApiKey(apiKey: string, providerId: string) {
  if (!supabase || !supabaseConfigured) throw new Error('请先配置 Supabase 后再安全保存第三方 API Key')
  if (apiKey.trim().length < 8 || apiKey.length > 8192) throw new Error('API Key 长度无效')
  const { error } = await supabase.rpc('admin_set_image_provider_api_key', { p_provider_id: providerId, p_api_key: apiKey })
  if (error) throw new Error('API Key 未能安全保存；请确认后台迁移已应用且当前用户拥有管理员权限')
}

export async function fetchUpstreamImageModels(input: {
  providerId: string
  baseUrl: string
  protocol: ImageApiProtocol
  apiKey?: string
}) {
  if (!supabase || !supabaseConfigured) throw new Error('连接 Supabase 后才能安全从上游获取模型列表')
  const { data, error } = await supabase.functions.invoke('jiwang-generate', {
    body: { action: 'list_models', ...input },
  })
  if (error) {
    let message = error.message
    const context = (error as { context?: unknown }).context
    if (context instanceof Response) {
      try {
        const body = await context.clone().json() as { error?: unknown }
        if (typeof body.error === 'string') message = body.error
      } catch { /* Keep the SDK error message. */ }
    }
    throw new Error(message || '上游模型列表获取失败')
  }
  const models = data && typeof data === 'object' ? (data as { models?: unknown }).models : null
  if (!Array.isArray(models)) throw new Error('上游返回的模型列表格式无效')
  return models.filter((item): item is string => typeof item === 'string' && item.length > 0)
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

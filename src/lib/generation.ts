import { supabase, supabaseConfigured } from './supabase'

export interface PublicImageModel {
  id: string
  provider: string
  name: string
  priceCoins: number
}

export interface StickerGenerationInput {
  jobId: string
  modelId: string
  referencePath: string
  title: string
  topic: string
  cells: Array<{ caption: string; visual: string }>
  options: { originalStyle: boolean; noText: boolean; whiteBorder: boolean }
}

export interface StickerGenerationResult {
  jobId: string
  images: Array<{ cellIndex: number; url: string }>
  balance?: number
  priceCoins?: number
}

export class GenerationHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'GenerationHttpError'
  }
}

/** Turn transport, upstream and legacy server errors into actionable Chinese guidance. */
export function explainGenerationError(value: unknown): string {
  const raw = typeof value === 'string'
    ? value
    : value instanceof Error
      ? value.message
      : value && typeof value === 'object' && 'message' in value
        ? String((value as { message?: unknown }).message ?? '')
        : ''
  const message = raw.trim() || '发生了未识别的生成错误'
  const lower = message.toLowerCase()
  if (/建议[:：]/.test(message)) return message

  const upstreamProtocol = /responses api/i.test(message) ? 'Responses API' : /chat completions/i.test(message) ? 'Chat Completions' : '上游模型接口'
  const status = message.match(/(?:http\s*)?\(?([45]\d\d)\)?/i)?.[1]
  if (status === '403') {
    return `${upstreamProtocol} 返回 HTTP 403，说明上游拒绝了这次请求。常见原因是 API Key 无权调用该模型、账户/区域策略限制，或所选协议与供应商实现不兼容。\n建议：请管理员核对供应商协议、Base URL、模型 ID 与 API Key 权限；核实前不要连续重复提交。若任务已失败，请刷新余额和任务历史确认退款状态。`
  }
  if (status === '401') {
    return `${upstreamProtocol} 返回 HTTP 401，API Key 无效、过期或未被该接口接受。\n建议：请管理员重新核对并保存供应商 API Key，再确认模型启用状态；失败任务的汪币退款请以余额和任务历史为准。`
  }
  if (status === '404') {
    return `${upstreamProtocol} 返回 HTTP 404，接口路径或模型 ID 未找到。\n建议：请管理员核对 Base URL 是否包含正确的 API 前缀、协议类型和模型 ID。`
  }
  if (status === '429') {
    return `${upstreamProtocol} 返回 HTTP 429，供应商限流或额度暂不可用。\n建议：稍后再试，并请管理员检查上游速率限制、并发额度和账户配额；不要短时间连续提交。`
  }
  if (status && Number(status) >= 500) {
    return `${upstreamProtocol} 返回 HTTP ${status}，供应商服务暂时异常。\n建议：稍后重试，并请管理员检查供应商状态；先在任务历史与余额中确认本次任务和退款状态。`
  }
  if (/aborterror|timed?\s*out|timeout|超时/i.test(message)) {
    return `${message}\n建议：请求超时可能是上游处理慢或网络中断。请先刷新任务历史确认云端任务是否仍在处理，不要立即重复提交。`
  }
  if (/failed to fetch|fetch failed|networkerror|network request failed|load failed/i.test(lower)) {
    return '无法连接生成服务或上游模型，可能是网络、DNS、TLS 或服务暂时不可用。\n建议：检查网络后刷新页面和任务历史；确认任务状态与余额后再决定是否重试。'
  }
  if (/insufficient wallet balance|汪币余额不足/i.test(message)) {
    return '汪币余额不足，本次模型调用未开始。\n建议：刷新余额，选择价格更低的已启用模型，或先补充汪币。'
  }
  return `${message}\n建议：先刷新任务历史与汪币余额，确认任务状态和退款结果后再重试；若仍失败，请把完整错误和任务编号提供给项目管理员。`
}

export function explainPreparationError(stage: '参考图云端保存' | '汪币余额读取', value: unknown): string {
  const message = value instanceof Error ? value.message : typeof value === 'string' ? value : ''
  const detail = message.trim() || '未知服务错误'
  const lower = detail.toLowerCase()
  if (/failed to fetch|fetch failed|networkerror|network request failed|load failed/i.test(lower)) {
    return `${stage}失败，当前无法连接云端服务。请检查网络后重试；这一步尚未开始模型调用。`
  }
  if (/401|403|row.level security|permission|unauthorized/i.test(detail)) {
    return `${stage}失败，当前账号会话或云端权限不足。请重新登录；若仍失败，请管理员检查 Supabase Storage/RLS 策略。`
  }
  if (/404|bucket.*not found|not found/i.test(detail)) {
    return `${stage}失败，云端存储桶或数据资源不存在。请管理员检查 jiwang-private 存储桶及数据库迁移。`
  }
  if (/413|too large|payload/i.test(detail)) {
    return `${stage}失败，图片或请求超过服务限制。请换用不超过 12 MB 的 PNG、JPG 或 WebP 图片。`
  }
  return `${stage}失败：${detail}\n建议：检查网络和登录状态后重试；如持续发生，请管理员检查 Supabase 存储/数据库权限与服务状态。`
}

let enabledImageModelsRequest: Promise<PublicImageModel[]> | null = null

export function loadEnabledImageModels(): Promise<PublicImageModel[]> {
  if (!supabase || !supabaseConfigured) return Promise.resolve([])
  if (enabledImageModelsRequest) return enabledImageModelsRequest

  const request = (async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const { data, error } = await supabase.rpc('public_enabled_image_models')
        if (error) throw new Error(error.message)
        return ((data ?? []) as Array<{ id: string; provider: string; name: string; price_coins: number }>).map((row) => ({
          id: row.id,
          provider: row.provider,
          name: row.name,
          priceCoins: Number(row.price_coins),
        })).filter((model) => Boolean(model.id && model.name) && Number.isInteger(model.priceCoins) && model.priceCoins > 0)
      } catch (error) {
        if (attempt === 1) throw error
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
    return []
  })()

  const sharedRequest = request.finally(() => {
    if (enabledImageModelsRequest === sharedRequest) enabledImageModelsRequest = null
  })
  enabledImageModelsRequest = sharedRequest
  return sharedRequest
}

export async function loadWalletBalance(userId: string): Promise<number> {
  if (!supabase || !supabaseConfigured) return 0
  const { data, error } = await supabase.from('wallet_balances').select('balance').eq('user_id', userId).maybeSingle()
  if (error) throw new Error(error.message)
  return Number(data?.balance ?? 0)
}

export async function loadGenerationStatus(jobId: string) {
  if (!supabase || !supabaseConfigured) return null
  const { data, error } = await supabase.from('generation_jobs').select('status,progress,error_message').eq('id', jobId).maybeSingle()
  if (error) throw new Error(error.message)
  return data as { status: 'queued' | 'processing' | 'completed' | 'failed'; progress: number; error_message: string | null } | null
}

export async function loadGenerationImages(jobId: string, userId: string): Promise<Array<{ cellIndex: number; url: string }>> {
  if (!supabase || !supabaseConfigured) return []
  const { data, error } = await supabase.from('assets')
    .select('cell_index,storage_path')
    .eq('user_id', userId)
    .eq('job_id', jobId)
    .eq('kind', 'sticker')
    .order('cell_index', { ascending: true })
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as Array<{ cell_index: number; storage_path: string }>
  if (!rows.length) return []
  const { data: signed, error: signedError } = await supabase.storage.from('jiwang-private').createSignedUrls(rows.map((row) => row.storage_path), 1800)
  if (signedError) throw new Error(signedError.message)
  return rows.map((row, index) => ({ cellIndex: row.cell_index, url: signed?.[index]?.signedUrl || '' })).filter((image) => Boolean(image.url))
}

function errorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const error = value as Record<string, unknown>
  return typeof error.error === 'string' ? error.error : undefined
}

export async function generateStickers(input: StickerGenerationInput, onProgress?: (progress: number) => void): Promise<StickerGenerationResult> {
  if (!supabase || !supabaseConfigured) throw new Error('真实生成服务尚未配置 Supabase')
  let active = true
  const updateProgress = async () => {
    try {
      const status = await loadGenerationStatus(input.jobId)
      if (status && active) onProgress?.(Number(status.progress || 0))
    } catch { /* progress refresh is best-effort; the generation request remains authoritative */ }
  }
  const timer = window.setInterval(() => { void updateProgress() }, 1800)
  void updateProgress()
  try {
    const { data, error } = await supabase.functions.invoke('jiwang-generate', { body: input })
    if (error) {
      if (error.context instanceof Response) {
        const payload = await error.context.clone().json().catch(() => null)
        throw new GenerationHttpError(errorMessage(payload) || error.message, error.context.status)
      }
      throw new Error(error.message)
    }
    const result = data as StickerGenerationResult & { error?: string }
    if (result.error) throw new Error(result.error)
    return result
  } finally {
    active = false
    window.clearInterval(timer)
  }
}

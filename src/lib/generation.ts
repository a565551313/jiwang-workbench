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
        throw new Error(errorMessage(payload) || error.message)
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

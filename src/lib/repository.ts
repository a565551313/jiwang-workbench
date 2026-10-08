import { supabase, supabaseConfigured } from './supabase'
import type { GenerationJob, WorkAsset } from '../types'

const JOBS_KEY = 'jiwang:jobs:v1'
const ASSETS_KEY = 'jiwang:assets:v1'

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch { return fallback }
}

export async function persistReference(file: File, userId?: string): Promise<string | undefined> {
  if (!supabase || !supabaseConfigured || !userId) return undefined
  const extension = file.name.split('.').pop()?.toLowerCase() || 'png'
  const storagePath = `${userId}/references/${crypto.randomUUID()}.${extension}`
  const { error: uploadError } = await supabase.storage.from('jiwang-private').upload(storagePath, file, { contentType: file.type || 'image/png', upsert: true })
  if (uploadError) throw uploadError
  const { error: rowError } = await supabase.from('assets').insert({
    user_id: userId,
    kind: 'reference',
    name: file.name,
    storage_path: storagePath,
    mime_type: file.type || 'image/png',
  })
  if (rowError) throw rowError
  return storagePath
}

export async function fetchAssets(userId?: string): Promise<WorkAsset[]> {
  if (supabase && supabaseConfigured && userId) {
    const { data, error } = await supabase.from('assets').select('*').eq('user_id', userId).eq('kind', 'sticker').order('created_at', { ascending: false }).limit(240)
    if (!error && data) {
      const rows = data as Array<{ id: string; job_id: string | null; name: string; storage_path: string; created_at: string; caption: string | null; cell_index: number | null }>
      const paths = rows.map((row) => row.storage_path)
      const { data: signed } = await supabase.storage.from('jiwang-private').createSignedUrls(paths, 1800)
      return rows.map((row, index) => ({
        id: row.id,
        jobId: row.job_id || '',
        kind: 'sticker' as const,
        name: row.name,
        imageUrl: signed?.[index]?.signedUrl || '',
        createdAt: row.created_at,
        caption: row.caption || undefined,
        cellIndex: row.cell_index ?? undefined,
      })).filter((row) => Boolean(row.imageUrl))
    }
  }
  return readJson<WorkAsset[]>(ASSETS_KEY, [])
}

export async function fetchJobs(userId?: string): Promise<GenerationJob[]> {
  if (supabase && supabaseConfigured && userId) {
    const { data, error } = await supabase.from('generation_jobs').select('*').order('created_at', { ascending: false }).limit(80)
    if (error) throw new Error(error.message)
    if (data) {
      return (data as Array<{ id: string; title: string; topic: string; status: GenerationJob['status']; created_at: string; finished_at: string | null; options: { cellCount?: number }; model_id?: string | null; model_name?: string | null; price_coins?: number | null; progress?: number; error_message?: string | null }>).map((row) => ({
        id: row.id,
        title: row.title,
        topic: row.topic,
        status: row.status,
        modelId: row.model_id || undefined,
        modelName: row.model_name || undefined,
        priceCoins: row.price_coins ?? undefined,
        progress: row.progress,
        createdAt: row.created_at,
        finishedAt: row.finished_at || undefined,
        assetCount: row.options?.cellCount,
        errorMessage: row.error_message || undefined,
      }))
    }
    return []
  }
  return readJson<GenerationJob[]>(JOBS_KEY, [])
}

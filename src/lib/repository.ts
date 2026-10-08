import { supabase, supabaseConfigured } from './supabase'
import type { GenerationJob, WorkAsset } from '../types'

/** Upload a reference image and register it. Users may only add reference rows; generated stickers are written by the server. */
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

/** The signed-in user's stickers, newest first. Signed links expire after 30 minutes; callers refresh them before downloads. */
export async function fetchAssets(userId?: string): Promise<WorkAsset[]> {
  if (!supabase || !supabaseConfigured || !userId) return []
  const { data, error } = await supabase.from('assets')
    .select('id,job_id,name,storage_path,created_at,caption,cell_index')
    .eq('user_id', userId)
    .eq('kind', 'sticker')
    .order('created_at', { ascending: false })
    .limit(240)
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as Array<{ id: string; job_id: string | null; name: string; storage_path: string; created_at: string; caption: string | null; cell_index: number | null }>
  const { data: signed, error: signedError } = await supabase.storage.from('jiwang-private').createSignedUrls(rows.map((row) => row.storage_path), 1800)
  if (signedError) throw new Error(signedError.message)
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

/**
 * The signed-in user's generation history. Columns are listed explicitly so the worker token and
 * server-only fields never reach the browser.
 */
export async function fetchJobs(userId?: string): Promise<GenerationJob[]> {
  if (!supabase || !supabaseConfigured || !userId) return []
  const { data, error } = await supabase.from('generation_jobs')
    .select('id,title,topic,status,model_id,model_name,price_coins,progress,completed_count,attempt,created_at,finished_at,error_message')
    .order('created_at', { ascending: false })
    .limit(80)
  if (error) throw new Error(error.message)
  return ((data ?? []) as Array<{
    id: string
    title: string
    topic: string
    status: GenerationJob['status']
    model_id: string | null
    model_name: string | null
    price_coins: number | null
    progress: number
    completed_count: number
    attempt: number
    created_at: string
    finished_at: string | null
    error_message: string | null
  }>).map((row) => ({
    id: row.id,
    title: row.title,
    topic: row.topic,
    status: row.status,
    modelId: row.model_id || undefined,
    modelName: row.model_name || undefined,
    priceCoins: row.price_coins ?? undefined,
    progress: row.progress,
    completedCount: row.completed_count,
    attempt: row.attempt,
    createdAt: row.created_at,
    finishedAt: row.finished_at || undefined,
    errorMessage: row.error_message || undefined,
  }))
}

import { supabase, supabaseConfigured } from './supabase'
import type { GenerationJob, WorkAsset, DraftCell } from '../types'

const JOBS_KEY = 'jiwang:jobs:v1'
const ASSETS_KEY = 'jiwang:assets:v1'

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch { return fallback }
}

function saveLocalJob(job: GenerationJob, captions: string[], images: string[]) {
  const jobs = readJson<GenerationJob[]>(JOBS_KEY, [])
  const assets = readJson<WorkAsset[]>(ASSETS_KEY, [])
  jobs.unshift(job)
  const created: WorkAsset[] = images.map((imageUrl, index) => ({
    id: `${job.id}-${index + 1}`,
    jobId: job.id,
    kind: 'sticker',
    name: captions[index] || `表情 ${index + 1}`,
    imageUrl,
    createdAt: job.finishedAt || job.createdAt,
    caption: captions[index],
    cellIndex: index,
  }))
  assets.unshift(...created)
  localStorage.setItem(JOBS_KEY, JSON.stringify(jobs.slice(0, 80)))
  localStorage.setItem(ASSETS_KEY, JSON.stringify(assets.slice(0, 600)))
}

function dataUrlToBlob(dataUrl: string) {
  const [header, encoded] = dataUrl.split(',')
  const mime = header.match(/data:([^;]+)/)?.[1] || 'image/png'
  const binary = atob(encoded || '')
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

export async function persistGeneration(
  job: GenerationJob,
  cells: DraftCell[],
  images: string[],
  userId?: string,
): Promise<{ cloudSaved: boolean; error?: string }> {
  const finishedJob = { ...job, status: 'completed' as const, finishedAt: new Date().toISOString(), assetCount: images.length }
  const captions = cells.map((cell) => cell.caption)
  saveLocalJob(finishedJob, captions, images)

  if (!supabase || !supabaseConfigured || !userId) return { cloudSaved: false }

  let cloudJobId = job.id
  try {
    const { data: insertedJob, error: jobError } = await supabase.from('generation_jobs').insert({
      id: job.id,
      user_id: userId,
      kind: 'sticker_grid',
      status: 'processing',
      title: job.title,
      topic: job.topic,
      options: { cellCount: images.length, provider: 'mock' },
    }).select('id').single()
    if (jobError) throw jobError
    cloudJobId = insertedJob.id

    const assetRows: Array<Record<string, unknown>> = []
    for (let base = 0; base < images.length; base += 4) {
      const batch = images.slice(base, base + 4)
      const rows = await Promise.all(batch.map(async (imageUrl, batchIndex) => {
        const index = base + batchIndex
        const storagePath = `${userId}/jobs/${cloudJobId}/${String(index + 1).padStart(2, '0')}.png`
        const { error: uploadError } = await supabase!.storage.from('jiwang-private').upload(storagePath, dataUrlToBlob(imageUrl), { contentType: 'image/png', upsert: true })
        if (uploadError) throw uploadError
        return {
          user_id: userId,
          job_id: cloudJobId,
          kind: 'sticker',
          name: captions[index] || `表情 ${index + 1}`,
          storage_path: storagePath,
          mime_type: 'image/png',
          cell_index: index,
          caption: captions[index] || '',
        }
      }))
      assetRows.push(...rows)
    }
    const { error: assetError } = await supabase.from('assets').insert(assetRows)
    if (assetError) throw assetError
    const { error: completeError } = await supabase.from('generation_jobs').update({ status: 'completed', finished_at: finishedJob.finishedAt }).eq('id', cloudJobId)
    if (completeError) throw completeError
    return { cloudSaved: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : '云端保存失败'
    return { cloudSaved: false, error: message }
  }
}

export async function persistReference(file: File, userId?: string) {
  if (!supabase || !supabaseConfigured || !userId) return
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
    if (!error && data) {
      return (data as Array<{ id: string; title: string; topic: string; status: GenerationJob['status']; created_at: string; finished_at: string | null; options: { cellCount?: number } }>).map((row) => ({
        id: row.id,
        title: row.title,
        topic: row.topic,
        status: row.status,
        createdAt: row.created_at,
        finishedAt: row.finished_at || undefined,
        assetCount: row.options?.cellCount,
      }))
    }
  }
  return readJson<GenerationJob[]>(JOBS_KEY, [])
}

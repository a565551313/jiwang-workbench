export interface DraftCell {
  caption: string
  visual: string
}

export interface WorkAsset {
  id: string
  jobId: string
  kind: 'reference' | 'sticker' | 'grid'
  name: string
  imageUrl: string
  createdAt: string
  caption?: string
  cellIndex?: number
}

/** `partial` means some cells were delivered and settled proportionally; the rest of the charge was refunded. */
export type GenerationStatus = 'queued' | 'processing' | 'completed' | 'partial' | 'failed'

export interface GenerationJob {
  id: string
  title: string
  topic: string
  status: GenerationStatus
  modelId?: string
  modelName?: string
  priceCoins?: number
  progress?: number
  /** Images actually delivered for this job (0–16). */
  completedCount?: number
  /** Attempt number; a retry is a new attempt with its own charge and refund. */
  attempt?: number
  createdAt: string
  finishedAt?: string
  errorMessage?: string
}

export interface GenerationOptions {
  originalStyle: boolean
  noText: boolean
  whiteBorder: boolean
}

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

export interface GenerationJob {
  id: string
  title: string
  topic: string
  status: 'queued' | 'processing' | 'completed' | 'failed'
  modelId?: string
  modelName?: string
  priceCoins?: number
  progress?: number
  createdAt: string
  finishedAt?: string
  assetCount?: number
  errorMessage?: string
}

export interface GenerationOptions {
  originalStyle: boolean
  noText: boolean
  whiteBorder: boolean
}

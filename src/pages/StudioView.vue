<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Download, ImagePlus, LoaderCircle, RefreshCw, Sparkles, WandSparkles, X, ArrowRight, Check, Clock3, Coins, Cpu } from '@lucide/vue'
import { ElMessage } from 'element-plus'
import { useAuthStore } from '../stores/auth'
import { makeDraft, themeGroups, titleForTopic } from '../lib/drafts'
import { makeZip, type ZipEntry } from '../lib/archive'
import { persistReference } from '../lib/repository'
import { supabase, supabaseConfigured } from '../lib/supabase'
import {
  defaultPublicFeatures,
  explainGenerationError,
  explainPreparationError,
  GenerationHttpError,
  generateStickers,
  loadEnabledImageModels,
  loadGenerationImages,
  loadGenerationStatus,
  loadPublicFeatures,
  loadWalletBalance,
  type PublicImageModel,
  type PublicSiteFeatures,
  type StickerGenerationResult,
} from '../lib/generation'
import type { DraftCell, GenerationJob, GenerationOptions } from '../types'

const router = useRouter()
const auth = useAuthStore()
const activeCategory = ref(themeGroups[0].label)
const activeTheme = ref('日常精选')
const themeDescription = ref('')
const topic = ref('')
const draft = ref<DraftCell[]>(makeDraft(activeTheme.value))
const selectedFile = ref<File | null>(null)
const referenceUrl = ref('')
const referenceStoragePath = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
/** One slot per script cell; a slot is null until its image has been delivered. */
const generatedCells = ref<Array<string | null>>(emptyCells())
/** Images the server reports as saved while a job is running (or after it ends). */
const completedCount = ref(0)
const loading = ref(false)
const zipLoading = ref(false)
const modelsLoading = ref(false)
const models = ref<PublicImageModel[]>([])
const selectedModelId = ref('')
const walletBalance = ref(0)
const balanceLoading = ref(false)
const balanceLoadFailed = ref(false)
const progress = ref(0)
const progressText = ref('准备就绪')
const failureMessage = ref('')
const latestJob = ref<GenerationJob | null>(null)
const features = ref<PublicSiteFeatures>(defaultPublicFeatures)
const options = reactive<GenerationOptions>({ originalStyle: true, noText: false, whiteBorder: true })
let referenceUpload: Promise<string | undefined> | null = null
let modelLoadSequence = 0
let balanceLoadSequence = 0
/** When the preview links on this page were signed; they expire after 30 minutes. */
let previewSignedAt = 0
const modelLoadFailed = ref(false)
const categories = computed(() => themeGroups.map((group) => group.label))
const visibleThemes = computed(() => themeGroups.find((group) => group.label === activeCategory.value)?.themes ?? [])
const outputTitle = computed(() => titleForTopic(topic.value || themeDescription.value, activeTheme.value))
const selectedModel = computed(() => models.value.find((model) => model.id === selectedModelId.value) || null)
const generationCost = computed(() => selectedModel.value?.priceCoins ?? 0)
const deliveredCount = computed(() => generatedCells.value.filter((url) => Boolean(url)).length)
const hasResult = computed(() => deliveredCount.value > 0 && !loading.value)

function emptyCells(): Array<string | null> {
  return Array.from({ length: 16 }, () => null)
}

function resetResult() {
  generatedCells.value = emptyCells()
  completedCount.value = 0
}

function applyImages(images: Array<{ cellIndex: number; url: string }>) {
  const cells = emptyCells()
  for (const image of images) {
    if (image.cellIndex >= 0 && image.cellIndex < 16 && image.url) cells[image.cellIndex] = image.url
  }
  generatedCells.value = cells
  completedCount.value = cells.filter((url) => Boolean(url)).length
  previewSignedAt = Date.now()
}

function selectTheme(theme: string) {
  activeTheme.value = theme
  topic.value = theme
  draft.value = makeDraft(theme)
  resetResult()
  if (latestJob.value?.status !== 'processing' && latestJob.value?.status !== 'queued') latestJob.value = null
}

function useCustomDraft() {
  if (!features.value.customThemes) { ElMessage.warning('管理员已关闭自定义主题，请从预设主题中选择'); return }
  const clean = themeDescription.value.trim()
  if (!clean) { ElMessage.warning('先写一句主题需求，再生成主题草案'); return }
  activeTheme.value = '自定义主题'
  topic.value = clean
  draft.value = makeDraft('日常精选')
  resetResult()
  if (latestJob.value?.status !== 'processing' && latestJob.value?.status !== 'queued') latestJob.value = null
  ElMessage.success('已生成 16 格草案，请检查或编辑每格文字')
}

function regenerateDraft() {
  draft.value = makeDraft(activeTheme.value)
  resetResult()
}

/** Clear the finished set so the user can start a new one (which is charged separately). */
function startNewSet() {
  resetResult()
  latestJob.value = null
  failureMessage.value = ''
  progress.value = 0
  progressText.value = '准备就绪'
}

async function refreshFeatures() {
  features.value = await loadPublicFeatures()
}

async function refreshModels() {
  const requestId = ++modelLoadSequence
  modelsLoading.value = true
  try {
    const loadedModels = await loadEnabledImageModels()
    if (requestId !== modelLoadSequence) return
    const previous = selectedModelId.value
    models.value = loadedModels
    selectedModelId.value = models.value.some((model) => model.id === previous) ? previous : (models.value[0]?.id || '')
    modelLoadFailed.value = false
  } catch (error) {
    if (requestId !== modelLoadSequence) return
    modelLoadFailed.value = models.value.length === 0
    ElMessage.warning(error instanceof Error ? `模型列表加载失败：${error.message}` : '模型列表加载失败')
  } finally {
    if (requestId === modelLoadSequence) modelsLoading.value = false
  }
}

async function refreshBalance() {
  const requestId = ++balanceLoadSequence
  if (!auth.user?.id) { walletBalance.value = 0; balanceLoadFailed.value = false; balanceLoading.value = false; return }
  balanceLoading.value = true
  balanceLoadFailed.value = false
  try {
    const balance = await loadWalletBalance(auth.user.id)
    if (requestId === balanceLoadSequence) walletBalance.value = balance
  }
  catch (error) {
    if (requestId === balanceLoadSequence) {
      balanceLoadFailed.value = true
      ElMessage.warning(explainPreparationError('汪币余额读取', error))
    }
  } finally {
    if (requestId === balanceLoadSequence) balanceLoading.value = false
  }
}

/** Re-sign the preview links when the tab comes back after they may have expired. */
function refreshPreviewsIfStale() {
  const jobId = latestJob.value?.id
  const userId = auth.user?.id
  if (document.visibilityState !== 'visible' || !jobId || !userId || !supabaseConfigured) return
  if (deliveredCount.value === 0 || loading.value || Date.now() - previewSignedAt < 20 * 60_000) return
  void loadGenerationImages(jobId, userId)
    .then((images) => { if (images.length) applyImages(images) })
    .catch(() => undefined)
}

onMounted(() => {
  void refreshFeatures()
  void refreshModels()
  void refreshBalance()
  void auth.init().catch(() => undefined)
  document.addEventListener('visibilitychange', refreshPreviewsIfStale)
})
watch(() => auth.user?.id, () => { void refreshBalance() })

function chooseFile() { fileInput.value?.click() }
function handleFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { ElMessage.warning('请上传 PNG、JPG 或 WebP 图片'); input.value = ''; return }
  if (file.size > 12 * 1024 * 1024) { ElMessage.warning('图片不能超过 12 MB'); input.value = ''; return }
  if (referenceUrl.value.startsWith('blob:')) URL.revokeObjectURL(referenceUrl.value)
  selectedFile.value = file
  referenceUrl.value = URL.createObjectURL(file)
  referenceStoragePath.value = ''
  referenceUpload = null
  resetResult()
  if (auth.user?.id && supabaseConfigured) {
    const selected = file
    referenceUpload = persistReference(selected, auth.user.id).then((path) => {
      if (selectedFile.value === selected) referenceStoragePath.value = path || ''
      return path
    }).catch((error: unknown) => {
      if (selectedFile.value === selected) referenceUpload = null
      ElMessage.warning(`预览可用。${explainPreparationError('参考图云端保存', error)}`)
      return undefined
    })
  }
}
function removeFile() {
  if (referenceUrl.value.startsWith('blob:')) URL.revokeObjectURL(referenceUrl.value)
  selectedFile.value = null
  referenceUrl.value = ''
  referenceStoragePath.value = ''
  referenceUpload = null
  resetResult()
  if (fileInput.value) fileInput.value.value = ''
}

/** Show what was delivered and say what was refunded. The refund is recomputed only when the server did not report it. */
async function settleSuccess(job: GenerationJob, result: Pick<StickerGenerationResult, 'images' | 'status' | 'refundedCoins'>, price: number) {
  const delivered = result.images.length
  const partial = result.status === 'partial' || delivered < 16
  const refunded = partial ? (result.refundedCoins ?? price - Math.ceil((price * delivered) / 16)) : 0
  latestJob.value = {
    ...job,
    status: partial ? 'partial' : 'completed',
    progress: 100,
    finishedAt: new Date().toISOString(),
    completedCount: delivered,
    errorMessage: partial ? `已交付 ${delivered}/16 张，未交付部分已退回 ${refunded} 汪币` : undefined,
  }
  progress.value = 100
  if (partial) {
    progressText.value = `部分完成：已交付 ${delivered}/16 张，未交付部分已退回 ${refunded} 汪币`
    ElMessage.warning(`已交付 ${delivered}/16 张，退回 ${refunded} 汪币`)
  } else {
    progressText.value = `已生成并安全保存；本次结算 ${price} 汪币`
    ElMessage.success(`16 张贴图已生成，扣除 ${price} 汪币`)
  }
  await refreshBalance()
}

async function generate() {
  if (!auth.user?.id) { ElMessage.warning('真实生成和汪币结算需要先登录；请使用页面右上角登录 / 注册'); return }
  if (!supabaseConfigured || !supabase) { ElMessage.error('云端生成服务尚未配置，当前不能提交任务或结算汪币；请联系项目管理员检查 Supabase 配置。'); return }
  if (features.value.maintenance) { ElMessage.warning('极汪正在维护，暂不接受新的生成任务'); return }
  if (!selectedFile.value || !referenceUrl.value) { ElMessage.warning('请先上传一张角色图'); return }
  if (!selectedModel.value) { ElMessage.warning('当前没有已启用的图像模型，请稍后再试或联系管理员'); return }
  if (balanceLoading.value) { ElMessage.warning('正在读取汪币余额，请稍候'); return }
  if (balanceLoadFailed.value) { ElMessage.warning('汪币余额暂时无法读取，请先重新读取余额，避免提交后无法确认费用'); return }
  if (walletBalance.value < generationCost.value) { ElMessage.warning(`汪币余额不足：本次需要 ${generationCost.value} 汪币，当前余额 ${walletBalance.value}`); return }
  if (draft.value.length !== 16 || draft.value.some((cell) => !cell.caption.trim() || !cell.visual.trim())) { ElMessage.warning('请为 16 格草案都填写短句和画面描述'); return }
  loading.value = true
  failureMessage.value = ''
  resetResult()
  progress.value = 3
  progressText.value = '正在安全上传参考图并创建生成任务'
  const model = selectedModel.value
  const job: GenerationJob = {
    id: crypto.randomUUID(),
    title: outputTitle.value,
    topic: topic.value || themeDescription.value || activeTheme.value,
    status: 'processing',
    modelId: model.id,
    modelName: model.name,
    priceCoins: model.priceCoins,
    progress: 3,
    createdAt: new Date().toISOString(),
  }
  latestJob.value = job
  try {
    const referencePath = referenceStoragePath.value || await (referenceUpload || persistReference(selectedFile.value, auth.user.id))
    if (!referencePath) throw new Error('参考图未能保存到云端。请检查网络、登录状态和私有存储权限，确认上传成功后再开始生成。')
    referenceStoragePath.value = referencePath
    progressText.value = `正在调用 ${model.name} 生成 16 张贴图；失败时系统会尝试退款`
    const result = await generateStickers({
      jobId: job.id,
      modelId: model.id,
      referencePath,
      title: job.title,
      topic: job.topic,
      cells: draft.value.map((cell) => ({ caption: cell.caption.trim(), visual: cell.visual.trim() })),
      options: { ...options },
    }, (value, completed) => {
      progress.value = Math.max(progress.value, value)
      completedCount.value = Math.max(completedCount.value, completed)
      if (progress.value >= 95) progressText.value = '16 张图片已返回，正在保存素材并完成任务'
      else if (progress.value >= 10) progressText.value = `模型已返回 ${completedCount.value}/16 张，正在继续生成`
    })
    if (result.images.length === 0) throw new Error('生成任务已返回，但没有可用图片；请查看任务记录')
    applyImages(result.images)
    await settleSuccess(job, result, model.priceCoins)
  } catch (error) {
    const message = error instanceof Error ? error.message : '生成失败，请检查模型配置后重试'
    if (error instanceof GenerationHttpError && error.status === 503 && /维护/.test(message)) {
      // The server refuses before creating a job, so there is nothing to reconcile.
      features.value = { ...features.value, maintenance: true }
      latestJob.value = null
      progress.value = 0
      progressText.value = '服务维护中：尚未创建任务，也未扣费'
      ElMessage.warning(message)
      return
    }
    let remoteStatus: Awaited<ReturnType<typeof loadGenerationStatus>> = null
    let statusCheckFailed = false
    try { remoteStatus = await loadGenerationStatus(job.id) }
    catch { statusCheckFailed = true }
    if (remoteStatus?.status === 'completed' || remoteStatus?.status === 'partial') {
      const images = await loadGenerationImages(job.id, auth.user.id).catch(() => [])
      if (images.length > 0) {
        applyImages(images)
        await settleSuccess(job, { images, status: remoteStatus.status === 'completed' ? 'completed' : 'partial' }, model.priceCoins)
      } else {
        failureMessage.value = '任务已完成，但当前无法读取图片预览。请打开任务历史或素材库查看；若仍看不到图片，请管理员检查私有存储桶和临时访问链接。'
        latestJob.value = { ...job, status: remoteStatus.status, progress: 100, finishedAt: new Date().toISOString(), errorMessage: failureMessage.value }
        progressText.value = '任务已完成；打开任务历史或素材库查看图片'
        ElMessage.warning(failureMessage.value)
      }
    } else if (remoteStatus?.status === 'processing' || remoteStatus?.status === 'queued') {
      latestJob.value = { ...job, status: remoteStatus.status, progress: remoteStatus.progress }
      progress.value = Number(remoteStatus.progress || 3)
      if (/严重提醒|退款记录已写入|失败\/退款状态/i.test(message)) {
        failureMessage.value = explainGenerationError(message)
        progressText.value = '请求已返回错误，但任务/退款状态尚未确认；请勿重复提交'
        ElMessage.error(failureMessage.value.split('\n')[0] || '任务和退款状态尚未确认')
      } else if (error instanceof GenerationHttpError) {
        failureMessage.value = `${explainGenerationError(message)}\n\n服务端已返回 HTTP ${error.status}，但任务状态仍显示处理中。请勿重复提交；稍后刷新任务历史和余额，确认失败/退款状态。`
        progressText.value = '生成服务已返回错误；任务状态与退款仍在确认，请勿重试'
        await refreshBalance()
        ElMessage.error(failureMessage.value.split('\n')[0] || '生成服务返回错误')
      } else {
        failureMessage.value = '浏览器与生成服务的连接中断，但云端任务仍在处理。请勿再次提交同一套生成；稍后刷新任务历史查看结果。'
        progressText.value = '连接中断；云端仍在处理，请勿重复提交'
        ElMessage.warning('连接中断，但云端任务仍在处理；请勿重复提交')
      }
      latestJob.value = { ...latestJob.value, errorMessage: failureMessage.value }
    } else if (remoteStatus?.status === 'failed') {
      failureMessage.value = explainGenerationError(remoteStatus.error_message || message)
      latestJob.value = { ...job, status: 'failed', finishedAt: new Date().toISOString(), errorMessage: failureMessage.value }
      progressText.value = '生成失败；请按下方原因排查并核对退款'
      await refreshBalance()
      ElMessage.error(failureMessage.value.split('\n')[0] || '生成失败')
    } else {
      if (statusCheckFailed) {
        failureMessage.value = `${explainGenerationError(message)}\n\n另外，当前无法查询云端任务状态，因此也无法确认是否已预扣或退款。请勿立即重复提交；检查网络后刷新任务历史和余额。`
      } else {
        failureMessage.value = `${explainGenerationError(message)}\n\n当前没有查到这次任务记录，扣费状态尚不能仅凭此页面确认。请刷新任务历史和余额；确认没有同一任务在处理后再重试。`
      }
      latestJob.value = {
        ...job,
        status: statusCheckFailed || !remoteStatus ? 'processing' : 'failed',
        finishedAt: statusCheckFailed || !remoteStatus ? undefined : new Date().toISOString(),
        errorMessage: failureMessage.value,
      }
      progressText.value = statusCheckFailed ? '无法确认云端任务状态；请先核对任务历史与余额' : '未查到任务记录；请先确认扣费状态'
      await refreshBalance()
      ElMessage.error(failureMessage.value.split('\n')[0] || '生成失败')
    }
  } finally {
    loading.value = false
  }
}

/** Packaging always uses fresh signed links, so a download works even after the page has been open for hours. */
async function currentDownloadItems(): Promise<ZipEntry[]> {
  const jobId = latestJob.value?.id
  if (jobId && auth.user?.id && supabaseConfigured) {
    try {
      const fresh = await loadGenerationImages(jobId, auth.user.id)
      if (fresh.length) applyImages(fresh)
    } catch { /* fall back to the links already on the page */ }
  }
  return generatedCells.value.flatMap((url, index) => url
    ? [{ url, filename: `${String(index + 1).padStart(2, '0')}-${draft.value[index]?.caption || '表情'}` }]
    : [])
}

async function downloadZip() {
  if (deliveredCount.value === 0) return
  zipLoading.value = true
  try {
    const items = await currentDownloadItems()
    if (items.length === 0) throw new Error('图片链接已失效，请刷新页面或打开素材库后重试')
    const blob = await makeZip(items)
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${outputTitle.value}-${items.length === 16 ? '16格表情' : `${items.length}张部分表情`}.zip`
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    ElMessage.success(items.length === 16 ? 'ZIP 素材包已下载' : `已下载 ${items.length} 张已交付的图片`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '打包失败')
  } finally { zipLoading.value = false }
}

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', refreshPreviewsIfStale)
  if (referenceUrl.value.startsWith('blob:')) URL.revokeObjectURL(referenceUrl.value)
})
</script>

<template>
  <div class="studio-page">
    <section class="studio-intro">
      <div>
        <div class="intro-kicker"><span class="sparkle-chip"><Sparkles :size="14" /></span> YOUR CHARACTER, YOUR STICKERS</div>
        <h1>让喜欢的角色<span>开口说话</span></h1>
        <p>上传一张角色图，整理 16 格脚本，做一套每天都想用的表情包。</p>
      </div>
      <div class="intro-badge"><span class="intro-badge-dot"></span>创作工坊 <span class="badge-divider"></span> 16 格</div>
    </section>

    <el-alert v-if="features.maintenance" class="subtle-alert" type="warning" :closable="false" show-icon>极汪正在维护，暂不接受新的生成任务；已在进行中的任务不受影响。</el-alert>
    <div class="prototype-banner"><span class="banner-icon"><WandSparkles :size="17" /></span><span><strong>真实模型生成</strong> 选择已启用的图像模型后，系统会显示本套价格并在服务端安全结算；失败时系统会尝试退款，退款是否到账以任务历史和余额为准。</span></div>

    <div class="studio-layout">
      <div class="studio-form-column">
        <section class="work-card upload-card">
          <div class="section-head">
            <div class="section-number">01</div><div class="section-copy"><h2>上传角色图</h2><p>用一张清晰、主体完整的图片锁定角色样貌</p></div>
            <span class="section-status" :class="{ done: selectedFile }"><Check v-if="selectedFile" :size="14" /><span v-else class="status-ring"></span>{{ selectedFile ? '已添加' : '待上传' }}</span>
          </div>
          <input ref="fileInput" class="hidden-input" type="file" accept="image/png,image/jpeg,image/webp" @change="handleFileChange" />
          <div v-if="!selectedFile" class="upload-dropzone" role="button" tabindex="0" @click="chooseFile" @keydown.enter="chooseFile" @keydown.space.prevent="chooseFile">
            <div class="upload-icon"><ImagePlus :size="22" /></div>
            <div class="upload-main"><strong>选择一张角色图</strong><span>点击从设备中选择 · PNG / JPG / WebP，最大 12 MB</span></div>
            <el-button class="soft-button" @click.stop="chooseFile">选择图片</el-button>
          </div>
          <div v-else class="selected-file-row">
            <div class="selected-preview"><img :src="referenceUrl" :alt="selectedFile.name" /></div>
            <div class="selected-file-meta"><strong>{{ selectedFile.name }}</strong><span>{{ (selectedFile.size / 1024 / 1024).toFixed(1) }} MB · 仅用作本次角色参考</span></div>
            <el-button class="soft-button replace-button" @click="chooseFile">更换图片</el-button>
            <button class="remove-file" aria-label="移除图片" @click="removeFile"><X :size="17" /></button>
          </div>
          <p class="privacy-note"><span class="privacy-shield">✓</span> {{ auth.isSignedIn && supabaseConfigured ? '登录后会保存到你的私有素材空间' : '本地预览只保留在此浏览器；配置云端后可按账号私有保存' }}</p>
        </section>

        <section class="work-card theme-card">
          <div class="section-head">
            <div class="section-number">02</div><div class="section-copy"><h2>选一个主题</h2><p>预设主题可以直接开始，也可以写下你的想法</p></div>
          </div>
          <div class="theme-tabs"><button v-for="category in categories" :key="category" :class="{ active: activeCategory === category }" @click="activeCategory = category">{{ category }}</button></div>
          <div class="theme-chips"><button v-for="theme in visibleThemes" :key="theme" class="theme-chip" :class="{ selected: activeTheme === theme }" @click="selectTheme(theme)"><span v-if="activeTheme === theme" class="chip-check"><Check :size="11" /></span>{{ theme }}</button></div>
          <div v-if="features.customThemes" class="custom-theme">
            <el-input v-model="themeDescription" type="textarea" :rows="2" maxlength="160" show-word-limit resize="none" placeholder="描述你想要的主题，例如：给角色做一套下班后松弛感满满的表情" />
            <el-button class="soft-button draft-button" @click="useCustomDraft"><RefreshCw :size="15" />整理 16 格草案</el-button>
          </div>
          <div class="script-heading"><div><h3>主题草案 <span>16 格</span></h3><p>文字可以直接编辑；画面描述用于保持每格动作不重复。</p></div><button class="text-action" @click="regenerateDraft"><RefreshCw :size="14" />重新整理</button></div>
          <div class="script-grid">
            <div v-for="(cell, index) in draft" :key="index" class="script-cell">
              <div class="script-cell-top"><span class="script-index">{{ String(index + 1).padStart(2, '0') }}</span><el-input v-model="cell.caption" maxlength="10" placeholder="短句" /></div>
              <p>{{ cell.visual }}</p>
            </div>
          </div>
        </section>

        <section class="work-card options-card">
          <div class="section-head compact-head"><div class="section-number">03</div><div class="section-copy"><h2>画面选项</h2><p>轻调细节，让整套表情更像你的角色</p></div></div>
          <div class="option-list">
            <div class="option-row"><div><strong>保留原图风格</strong><span>尽量保持角色原来的颜色与气质</span></div><el-switch v-model="options.originalStyle" /></div>
            <div class="option-row"><div><strong>无文字贴图</strong><span>关闭后会显示上方草案中的短句</span></div><el-switch v-model="options.noText" /></div>
            <div class="option-row"><div><strong>白边贴纸</strong><span>为角色轮廓添加浅色贴纸边缘</span></div><el-switch v-model="options.whiteBorder" /></div>
          </div>
        </section>

        <section class="work-card model-choice-card">
          <div class="section-head compact-head"><div class="section-number">04</div><div class="section-copy"><h2>选择生成模型</h2><p>不同模型价格不同；开始前会显示本次汪币费用。</p></div><Cpu :size="18" /></div>
          <div v-if="modelsLoading" class="model-loading"><LoaderCircle class="spin" :size="15" />正在读取已启用模型…</div>
          <template v-else-if="models.length">
            <el-select v-model="selectedModelId" class="model-select" placeholder="选择图像模型">
              <el-option v-for="model in models" :key="model.id" :label="`${model.name} · ${model.priceCoins} 汪币/套`" :value="model.id">
                <div class="model-option"><span><strong>{{ model.name }}</strong><small>{{ model.provider }}</small></span><b>{{ model.priceCoins }} 汪币/套</b></div>
              </el-option>
            </el-select>
            <div class="model-price-summary"><span><Coins :size="15" />本套 16 张贴图</span><strong>{{ generationCost }} <small>汪币</small></strong></div>
            <div class="wallet-summary"><span>当前余额</span><strong v-if="balanceLoading">正在读取…</strong><strong v-else-if="balanceLoadFailed">暂时无法读取</strong><strong v-else-if="auth.user">{{ walletBalance }} 汪币</strong><strong v-else>登录后查看</strong><span v-if="auth.user && !balanceLoading && !balanceLoadFailed && walletBalance < generationCost" class="wallet-short">余额不足</span><button v-if="auth.user && balanceLoadFailed" type="button" class="text-action balance-retry" @click="refreshBalance">重新读取余额</button></div>
          </template>
          <div v-else-if="modelLoadFailed" class="model-empty">暂时无法读取模型列表。请检查网络、Supabase RPC 和登录/匿名读取权限后重试。<button type="button" class="text-action" @click="refreshModels">重试读取</button></div>
          <div v-else class="model-empty">目前没有已启用的可用模型。请管理员确认供应商已保存 API Key、模型 ID 和 1–100000 整数价格，且模型已启用；检查 public_enabled_image_models RPC 权限及数据库迁移。</div>
          <div v-if="!auth.user" class="model-login-note">真实生成需要登录账号；请先使用页面右上角“登录 / 注册”。</div>
        </section>
      </div>

      <aside class="preview-column">
        <section class="preview-card">
          <div class="preview-header"><div><div class="preview-eyebrow">PREVIEW CANVAS</div><h2>你的 16 格预览</h2></div><span class="preview-mode"><span></span>云端模型</span></div>
          <div class="preview-title-row"><span class="preview-title">{{ outputTitle }}</span><span class="preview-count">{{ deliveredCount }}/16</span></div>
          <div v-if="loading || latestJob" class="generation-status" :class="{ 'is-active': loading, 'has-error': Boolean(failureMessage) }" aria-live="polite">
            <div class="generation-status-heading">
              <span class="generation-status-icon"><LoaderCircle v-if="loading" class="spin" :size="18" /><Check v-else-if="latestJob?.status === 'completed'" :size="18" /><X v-else-if="latestJob?.status === 'failed'" :size="18" /><Clock3 v-else :size="18" /></span>
              <div class="generation-status-copy"><strong>{{ loading ? '正在生成这套贴图' : latestJob?.status === 'completed' ? '生成完成' : latestJob?.status === 'partial' ? '部分完成' : latestJob?.status === 'failed' ? '生成未完成' : '任务状态待确认' }}</strong><span>{{ progressText }}</span></div>
              <strong class="generation-status-percent">{{ progress }}%</strong>
            </div>
            <el-progress :percentage="progress" :show-text="false" :stroke-width="7" color="#4f86e8" />
            <div class="generation-status-meta"><span>{{ latestJob?.status === 'failed' ? `失败前模型已返回 ${completedCount}/16 张` : latestJob?.status === 'completed' || latestJob?.status === 'partial' ? `已交付 ${deliveredCount}/16 张` : `模型已返回 ${completedCount}/16 张` }}</span><span v-if="loading">进度自动刷新；请保持本页打开</span><span v-else-if="latestJob?.status === 'processing' || latestJob?.status === 'queued'">状态确认期间请勿重复提交</span><span v-else-if="latestJob?.status === 'completed'">图片已保存到私有素材库</span><span v-else-if="latestJob?.status === 'partial'">未交付部分已自动退回，已交付图片可下载</span></div>
            <div v-if="failureMessage" class="generation-error" role="alert">{{ failureMessage }}</div>
          </div>
          <div class="preview-grid" :class="{ 'has-results': deliveredCount === 16 }">
            <div v-for="(cell, index) in draft" :key="index" class="preview-tile" :class="{ 'is-generating': loading && !generatedCells[index] }">
              <img v-if="generatedCells[index]" :src="generatedCells[index]" :alt="cell.caption" />
              <template v-else><div class="preview-doodle" :style="{ '--tile-index': index }"><span>{{ ['✦', '♡', '✿', '☁'][index % 4] }}</span><i></i></div><small>{{ loading ? '正在生成…' : cell.caption || '短句' }}</small></template>
              <span class="tile-number">{{ String(index + 1).padStart(2, '0') }}</span>
            </div>
          </div>
          <el-button v-if="!hasResult" class="primary-button generate-button" type="primary" :loading="loading" :disabled="features.maintenance || modelsLoading || !selectedModel || !auth.user || balanceLoading || balanceLoadFailed || walletBalance < generationCost || latestJob?.status === 'processing' || latestJob?.status === 'queued'" @click="generate"><Sparkles v-if="!loading" :size="17" />{{ loading ? '正在生成并结算…' : features.maintenance ? '服务维护中' : modelsLoading ? '正在读取模型…' : modelLoadFailed ? '模型列表暂不可用' : balanceLoading ? '正在读取余额…' : balanceLoadFailed ? '请先重新读取余额' : !auth.user ? '请先登录' : walletBalance < generationCost ? '汪币余额不足' : selectedModel ? `生成 16 张 · ${generationCost} 汪币` : '暂无可用模型' }}<ArrowRight v-if="!loading" :size="16" /></el-button>
          <div v-else class="result-actions"><el-button class="primary-button" type="primary" :loading="zipLoading" @click="downloadZip"><Download :size="16" />下载 {{ deliveredCount }} 张 PNG</el-button><el-button class="text-result-button" @click="router.push('/assets')">打开素材库</el-button><el-button class="text-result-button" @click="startNewSet">生成新的一套</el-button></div>
          <div class="preview-footnote"><span class="tiny-info">i</span><span>模型在服务端调用；图片保存在账号私有素材库。失败时系统会尝试退回已预扣汪币，请以任务历史和余额确认退款状态。</span></div>
        </section>
        <section class="next-step-card"><div class="next-step-icon"><WandSparkles :size="17" /></div><div><strong>下一步可以做什么？</strong><p>检查 16 格短句，选择模型并确认价格后开始生成。</p><button @click="router.push('/history')">查看任务历史 <ArrowRight :size="14" /></button></div></section>
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Download, ImagePlus, LoaderCircle, RefreshCw, Sparkles, WandSparkles, X, ArrowRight, Check, Clock3, Coins, Cpu } from '@lucide/vue'
import { ElMessage } from 'element-plus'
import { useAuthStore } from '../stores/auth'
import { makeDraft, themeGroups, titleForTopic } from '../lib/drafts'
import { makeZip } from '../lib/archive'
import { persistReference } from '../lib/repository'
import { supabase, supabaseConfigured } from '../lib/supabase'
import { generateStickers, loadEnabledImageModels, loadGenerationImages, loadGenerationStatus, loadWalletBalance, type PublicImageModel } from '../lib/generation'
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
const generatedCells = ref<string[]>([])
const loading = ref(false)
const zipLoading = ref(false)
const modelsLoading = ref(false)
const models = ref<PublicImageModel[]>([])
const selectedModelId = ref('')
const walletBalance = ref(0)
const progress = ref(0)
const progressText = ref('准备就绪')
const latestJob = ref<GenerationJob | null>(null)
const options = reactive<GenerationOptions>({ originalStyle: true, noText: false, whiteBorder: true })
let referenceUpload: Promise<string | undefined> | null = null
const categories = computed(() => themeGroups.map((group) => group.label))
const visibleThemes = computed(() => themeGroups.find((group) => group.label === activeCategory.value)?.themes ?? [])
const outputTitle = computed(() => titleForTopic(topic.value || themeDescription.value, activeTheme.value))
const selectedModel = computed(() => models.value.find((model) => model.id === selectedModelId.value) || null)
const generationCost = computed(() => selectedModel.value?.priceCoins ?? 0)

function selectTheme(theme: string) {
  activeTheme.value = theme
  topic.value = theme
  draft.value = makeDraft(theme)
  generatedCells.value = []
  latestJob.value = null
}

function useCustomDraft() {
  const clean = themeDescription.value.trim()
  if (!clean) { ElMessage.warning('先写一句主题需求，再生成主题草案'); return }
  activeTheme.value = '自定义主题'
  topic.value = clean
  draft.value = makeDraft('日常精选')
  generatedCells.value = []
  latestJob.value = null
  ElMessage.success('已生成 16 格草案，请检查或编辑每格文字')
}

async function refreshModels() {
  modelsLoading.value = true
  try {
    const previous = selectedModelId.value
    models.value = await loadEnabledImageModels()
    selectedModelId.value = models.value.some((model) => model.id === previous) ? previous : (models.value[0]?.id || '')
  } catch (error) {
    models.value = []
    ElMessage.warning(error instanceof Error ? `模型列表加载失败：${error.message}` : '模型列表加载失败')
  } finally { modelsLoading.value = false }
}

async function refreshBalance() {
  if (!auth.user?.id) { walletBalance.value = 0; return }
  try { walletBalance.value = await loadWalletBalance(auth.user.id) }
  catch { walletBalance.value = 0 }
}

onMounted(async () => {
  await auth.init()
  await Promise.all([refreshModels(), refreshBalance()])
})
watch(() => auth.user?.id, () => { void refreshBalance(); void refreshModels() })

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
  generatedCells.value = []
  if (auth.user?.id && supabaseConfigured) {
    const selected = file
    referenceUpload = persistReference(selected, auth.user.id).then((path) => {
      if (selectedFile.value === selected) referenceStoragePath.value = path || ''
      return path
    }).catch((error: unknown) => {
      ElMessage.warning(`预览可用，参考图云端保存失败：${error instanceof Error ? error.message : '请稍后重试'}`)
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
  generatedCells.value = []
  if (fileInput.value) fileInput.value.value = ''
}

async function generate() {
  if (!auth.user?.id || !supabaseConfigured || !supabase) { ElMessage.warning('真实生成和汪币结算需要先登录；请使用页面右上角登录 / 注册') ; return }
  if (!selectedFile.value || !referenceUrl.value) { ElMessage.warning('请先上传一张角色图'); return }
  if (!selectedModel.value) { ElMessage.warning('当前没有已启用的图像模型，请稍后再试或联系管理员'); return }
  if (walletBalance.value < generationCost.value) { ElMessage.warning(`汪币余额不足：本次需要 ${generationCost.value} 汪币，当前余额 ${walletBalance.value}`); return }
  if (draft.value.length !== 16 || draft.value.some((cell) => !cell.caption.trim() || !cell.visual.trim())) { ElMessage.warning('请为 16 格草案都填写短句和画面描述'); return }
  loading.value = true
  generatedCells.value = []
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
    if (!referencePath) throw new Error('参考图未能安全上传到云端，请稍后重试')
    referenceStoragePath.value = referencePath
    progressText.value = `正在调用 ${model.name} 生成 16 张贴图；失败会自动退回汪币`
    const result = await generateStickers({
      jobId: job.id,
      modelId: model.id,
      referencePath,
      title: job.title,
      topic: job.topic,
      cells: draft.value.map((cell) => ({ caption: cell.caption.trim(), visual: cell.visual.trim() })),
      options: { ...options },
    }, (value) => { progress.value = Math.max(progress.value, value) })
    const images = result.images.slice().sort((a, b) => a.cellIndex - b.cellIndex)
    if (images.length !== 16 || images.some((image) => !image.url)) throw new Error('生成任务已返回，但素材数量不完整；请查看任务记录')
    generatedCells.value = images.map((image) => image.url)
    latestJob.value = { ...job, status: 'completed', progress: 100, finishedAt: new Date().toISOString(), assetCount: images.length }
    progress.value = 100
    progressText.value = `已生成并安全保存；本次结算 ${model.priceCoins} 汪币`
    await refreshBalance()
    ElMessage.success(`16 张贴图已生成，扣除 ${model.priceCoins} 汪币`)
  } catch (error) {
    const message = error instanceof Error ? error.message : '生成失败，请检查模型配置后重试'
    let remoteStatus: Awaited<ReturnType<typeof loadGenerationStatus>> = null
    try { remoteStatus = await loadGenerationStatus(job.id) } catch { /* report the original request error */ }
    if (remoteStatus?.status === 'completed') {
      const images = await loadGenerationImages(job.id, auth.user.id).catch(() => [])
      if (images.length === 16) {
        generatedCells.value = images.map((image) => image.url)
        latestJob.value = { ...job, status: 'completed', progress: 100, finishedAt: new Date().toISOString(), assetCount: 16 }
        progress.value = 100
        progressText.value = '已生成并安全保存'
        await refreshBalance()
        ElMessage.success('16 张贴图已生成并同步')
      } else {
        latestJob.value = { ...job, status: 'completed', progress: 100, finishedAt: new Date().toISOString(), assetCount: 16 }
        progressText.value = '任务已完成；打开任务历史或素材库查看图片'
        ElMessage.warning('任务已完成，但当前无法读取预览，请稍后从素材库查看')
      }
    } else if (remoteStatus?.status === 'processing' || remoteStatus?.status === 'queued') {
      latestJob.value = { ...job, status: remoteStatus.status, progress: remoteStatus.progress }
      progress.value = Number(remoteStatus.progress || 3)
      progressText.value = '云端任务仍在处理；请勿重复提交，稍后到任务历史查看'
      ElMessage.warning('连接中断但云端任务仍在处理；请勿再次提交同一套生成')
    } else {
      latestJob.value = { ...job, status: 'failed', finishedAt: new Date().toISOString() }
      progressText.value = '生成失败，若已预扣汪币系统会自动退回'
      await refreshBalance()
      ElMessage.error(remoteStatus?.error_message || message)
    }
  } finally {
    loading.value = false
  }
}

async function downloadZip() {
  if (generatedCells.value.length !== 16) return
  zipLoading.value = true
  try {
    const blob = await makeZip(generatedCells.value, draft.value.map((cell) => cell.caption))
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${outputTitle.value}-16格表情.zip`
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    ElMessage.success('ZIP 素材包已下载')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '打包失败')
  } finally { zipLoading.value = false }
}

onBeforeUnmount(() => {
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

    <div class="prototype-banner"><span class="banner-icon"><WandSparkles :size="17" /></span><span><strong>真实模型生成</strong> 选择已启用的图像模型后，系统会显示本套价格并在服务端安全结算；生成失败会自动退回汪币。</span></div>

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
          <div class="custom-theme">
            <el-input v-model="themeDescription" type="textarea" :rows="2" maxlength="160" show-word-limit resize="none" placeholder="描述你想要的主题，例如：给角色做一套下班后松弛感满满的表情" />
            <el-button class="soft-button draft-button" @click="useCustomDraft"><RefreshCw :size="15" />整理 16 格草案</el-button>
          </div>
          <div class="script-heading"><div><h3>主题草案 <span>16 格</span></h3><p>文字可以直接编辑；画面描述用于保持每格动作不重复。</p></div><button class="text-action" @click="draft = makeDraft(activeTheme); generatedCells = []"><RefreshCw :size="14" />重新整理</button></div>
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
            <div class="wallet-summary"><span>当前余额</span><strong v-if="auth.user">{{ walletBalance }} 汪币</strong><strong v-else>登录后查看</strong><span v-if="auth.user && walletBalance < generationCost" class="wallet-short">余额不足</span></div>
          </template>
          <div v-else class="model-empty">目前没有可用模型。请管理员在后台配置密钥、设置汪币价格并启用模型。</div>
          <div v-if="!auth.user" class="model-login-note">真实生成需要登录账号；请先使用页面右上角“登录 / 注册”。</div>
        </section>
      </div>

      <aside class="preview-column">
        <section class="preview-card">
          <div class="preview-header"><div><div class="preview-eyebrow">PREVIEW CANVAS</div><h2>你的 16 格预览</h2></div><span class="preview-mode"><span></span>云端模型</span></div>
          <div class="preview-title-row"><span class="preview-title">{{ outputTitle }}</span><span class="preview-count">{{ generatedCells.length || 0 }}/16</span></div>
          <div class="preview-grid" :class="{ 'has-results': generatedCells.length === 16 }">
            <div v-for="(cell, index) in draft" :key="index" class="preview-tile">
              <img v-if="generatedCells[index]" :src="generatedCells[index]" :alt="cell.caption" />
              <template v-else><div class="preview-doodle" :style="{ '--tile-index': index }"><span>{{ ['✦', '♡', '✿', '☁'][index % 4] }}</span><i></i></div><small>{{ cell.caption || '短句' }}</small></template>
              <span class="tile-number">{{ String(index + 1).padStart(2, '0') }}</span>
            </div>
          </div>
          <div v-if="loading || latestJob" class="generation-status">
            <div class="generation-status-top"><span><LoaderCircle v-if="loading" class="spin" :size="15" /><Check v-else-if="latestJob?.status === 'completed'" :size="15" /><Clock3 v-else :size="15" />{{ progressText }}</span><strong>{{ progress }}%</strong></div>
            <el-progress :percentage="progress" :show-text="false" :stroke-width="5" color="#4f86e8" />
          </div>
          <el-button v-if="generatedCells.length !== 16" class="primary-button generate-button" type="primary" :loading="loading" :disabled="modelsLoading || !selectedModel || !auth.user || latestJob?.status === 'processing' || latestJob?.status === 'queued'" @click="generate"><Sparkles v-if="!loading" :size="17" />{{ loading ? '正在生成并结算…' : selectedModel ? `生成 16 张 · ${generationCost} 汪币` : '暂无可用模型' }}<ArrowRight v-if="!loading" :size="16" /></el-button>
          <div v-else class="result-actions"><el-button class="primary-button" type="primary" :loading="zipLoading" @click="downloadZip"><Download :size="16" />下载 16 张 PNG</el-button><el-button class="text-result-button" @click="router.push('/assets')">打开素材库</el-button></div>
          <div class="preview-footnote"><span class="tiny-info">i</span><span>模型在服务端调用；图片保存在账号私有素材库，生成请求失败会退回已预扣汪币。</span></div>
        </section>
        <section class="next-step-card"><div class="next-step-icon"><WandSparkles :size="17" /></div><div><strong>下一步可以做什么？</strong><p>检查 16 格短句，选择模型并确认价格后开始生成。</p><button @click="router.push('/history')">查看任务历史 <ArrowRight :size="14" /></button></div></section>
      </aside>
    </div>
  </div>
</template>

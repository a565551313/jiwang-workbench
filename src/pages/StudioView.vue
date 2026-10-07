<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Download, ImagePlus, LoaderCircle, RefreshCw, Sparkles, WandSparkles, X, ArrowRight, Check, Clock3 } from '@lucide/vue'
import { ElMessage } from 'element-plus'
import { useAuthStore } from '../stores/auth'
import { makeDraft, themeGroups, titleForTopic } from '../lib/drafts'
import { generateMockCells, makeZip } from '../lib/mockGenerator'
import { persistGeneration, persistReference } from '../lib/repository'
import { supabaseConfigured } from '../lib/supabase'
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
const fileInput = ref<HTMLInputElement | null>(null)
const generatedCells = ref<string[]>([])
const loading = ref(false)
const zipLoading = ref(false)
const progress = ref(0)
const progressText = ref('准备就绪')
const latestJob = ref<GenerationJob | null>(null)
const options = reactive<GenerationOptions>({ originalStyle: true, noText: false, whiteBorder: true })
const categories = computed(() => themeGroups.map((group) => group.label))
const visibleThemes = computed(() => themeGroups.find((group) => group.label === activeCategory.value)?.themes ?? [])
const outputTitle = computed(() => titleForTopic(topic.value || themeDescription.value, activeTheme.value))

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
  generatedCells.value = []
  if (auth.user?.id && supabaseConfigured) {
    void persistReference(file, auth.user.id).catch((error: unknown) => {
      ElMessage.warning(`本地预览可用，参考图云端保存失败：${error instanceof Error ? error.message : '请稍后重试'}`)
    })
  }
}
function removeFile() {
  if (referenceUrl.value.startsWith('blob:')) URL.revokeObjectURL(referenceUrl.value)
  selectedFile.value = null
  referenceUrl.value = ''
  generatedCells.value = []
  if (fileInput.value) fileInput.value.value = ''
}

async function wait(ms: number) { return new Promise((resolve) => window.setTimeout(resolve, ms)) }

async function generate() {
  if (!selectedFile.value || !referenceUrl.value) { ElMessage.warning('请先上传一张角色图'); return }
  if (draft.value.length !== 16 || draft.value.some((cell) => !cell.caption.trim())) { ElMessage.warning('请为 16 格草案都填写简短文字'); return }
  loading.value = true
  generatedCells.value = []
  progress.value = 8
  progressText.value = '正在整理 16 格创作脚本'
  const job: GenerationJob = {
    id: crypto.randomUUID(),
    title: outputTitle.value,
    topic: topic.value || themeDescription.value || activeTheme.value,
    status: 'processing',
    createdAt: new Date().toISOString(),
  }
  latestJob.value = job
  try {
    await wait(280)
    progress.value = 28
    progressText.value = '模拟提供器正在合成预览'
    const images = await generateMockCells(referenceUrl.value, draft.value, options)
    progress.value = 72
    progressText.value = '正在切分并保存 16 张素材'
    generatedCells.value = images
    const result = await persistGeneration(job, draft.value, images, auth.user?.id)
    latestJob.value = { ...job, status: 'completed', finishedAt: new Date().toISOString(), assetCount: images.length }
    progress.value = 100
    progressText.value = result.cloudSaved ? '已安全同步至云端' : '已保存到此浏览器'
    if (result.error) ElMessage.warning(`贴图已生成并保存在本机；云端同步失败：${result.error}`)
    else ElMessage.success(result.cloudSaved ? '16 格贴图已生成并同步' : '16 格贴图已生成，当前保存在本机浏览器')
  } catch (error) {
    latestJob.value = { ...job, status: 'failed', finishedAt: new Date().toISOString() }
    progressText.value = '生成失败'
    ElMessage.error(error instanceof Error ? error.message : '生成失败，请检查图片后重试')
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

    <div class="prototype-banner"><span class="banner-icon"><WandSparkles :size="17" /></span><span><strong>原型演示</strong> 目前由本地 Mock 提供器生成预览，不会调用真实图像模型，也不会扣除汪币。可接入模型后替换此提供器。</span></div>

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
      </div>

      <aside class="preview-column">
        <section class="preview-card">
          <div class="preview-header"><div><div class="preview-eyebrow">PREVIEW CANVAS</div><h2>你的 16 格预览</h2></div><span class="preview-mode"><span></span>本地演示</span></div>
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
          <el-button v-if="generatedCells.length !== 16" class="primary-button generate-button" type="primary" :loading="loading" @click="generate"><Sparkles v-if="!loading" :size="17" />{{ loading ? '正在本地合成…' : '生成 16 格预览' }}<ArrowRight v-if="!loading" :size="16" /></el-button>
          <div v-else class="result-actions"><el-button class="primary-button" type="primary" :loading="zipLoading" @click="downloadZip"><Download :size="16" />下载 16 张 PNG</el-button><el-button class="text-result-button" @click="router.push('/assets')">打开素材库</el-button></div>
          <div class="preview-footnote"><span class="tiny-info">i</span><span>预览在浏览器本地合成。下载会打包为 ZIP；登录及云端配置后，可保存到私有素材库。</span></div>
        </section>
        <section class="next-step-card"><div class="next-step-icon"><WandSparkles :size="17" /></div><div><strong>下一步可以做什么？</strong><p>检查 16 格短句，上传角色图后生成演示素材。</p><button @click="router.push('/history')">查看任务历史 <ArrowRight :size="14" /></button></div></section>
      </aside>
    </div>
  </div>
</template>

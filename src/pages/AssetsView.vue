<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Download, Images, LoaderCircle, PackageOpen, RefreshCw, WandSparkles } from '@lucide/vue'
import { ElMessage } from 'element-plus'
import { useAuthStore } from '../stores/auth'
import { fetchAssets } from '../lib/repository'
import { makeZip } from '../lib/mockGenerator'
import { supabaseConfigured } from '../lib/supabase'
import type { WorkAsset } from '../types'

const router = useRouter()
const auth = useAuthStore()
const assets = ref<WorkAsset[]>([])
const loading = ref(true)
const packaging = ref(false)
const sourceLabel = computed(() => auth.user?.id && supabaseConfigured ? '账号私有素材' : '本机演示素材')

async function load() {
  loading.value = true
  try { assets.value = await fetchAssets(auth.user?.id) }
  finally { loading.value = false }
}
async function downloadOne(asset: WorkAsset) {
  try {
    const response = await fetch(asset.imageUrl)
    if (!response.ok) throw new Error('素材下载失败')
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${String((asset.cellIndex ?? 0) + 1).padStart(2, '0')}-${asset.name.replace(/[\\/:*?"<>|]/g, '')}.png`
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '素材下载失败') }
}
async function downloadAll() {
  if (!assets.value.length) return
  packaging.value = true
  try {
    const blob = await makeZip(assets.value.map((asset) => asset.imageUrl), assets.value.map((asset) => asset.name))
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = '极汪-我的表情素材.zip'
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    ElMessage.success('素材 ZIP 已下载')
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '打包失败') }
  finally { packaging.value = false }
}
onMounted(() => { void load() })
watch(() => auth.user?.id, () => { void load() })
</script>

<template>
  <div class="assets-page">
    <div class="subpage-heading">
      <div><div class="eyebrow">YOUR STICKER LIBRARY</div><h1>我的素材</h1><p>生成的贴图会单独保存，随时可以下载复用。</p></div>
      <div class="subpage-actions"><el-button class="soft-button" @click="load"><RefreshCw :size="14" />刷新</el-button><el-button class="primary-button" type="primary" :disabled="!assets.length" :loading="packaging" @click="downloadAll"><PackageOpen :size="15" />打包下载 {{ assets.length ? `(${assets.length})` : '' }}</el-button></div>
    </div>
    <el-alert class="subtle-alert" type="info" :closable="false" show-icon>{{ sourceLabel }} · 尚未接入真实模型；图片只在此浏览器或你自己的 Supabase 私有空间保存。</el-alert>
    <div class="assets-toolbar"><div class="asset-count"><strong>{{ assets.length }}</strong>张贴图 <span>· {{ sourceLabel }}</span></div><span v-if="assets.length" class="asset-sort">最近生成优先</span></div>
    <div v-if="loading" class="empty-state"><div class="empty-state-inner"><LoaderCircle class="spin" :size="28" color="#3977d4" /><p>正在加载素材…</p></div></div>
    <div v-else-if="assets.length" class="asset-grid">
      <article v-for="asset in assets" :key="asset.id" class="asset-card">
        <div class="asset-image-wrap"><img :src="asset.imageUrl" :alt="asset.name" loading="lazy" /><span class="asset-number">{{ String((asset.cellIndex ?? 0) + 1).padStart(2, '0') }} / 16</span></div>
        <div class="asset-meta"><strong :title="asset.name">{{ asset.name }}</strong><button :aria-label="`下载 ${asset.name}`" @click="downloadOne(asset)"><Download :size="14" /></button></div>
      </article>
    </div>
    <div v-else class="empty-state"><div class="empty-state-inner"><div class="empty-illustration"><Images :size="24" /></div><h2>还没有表情素材</h2><p>先在创作工作台上传一张角色图，生成第一套 16 格演示素材。你也可以随时重新编辑主题草案。</p><el-button class="primary-button" type="primary" @click="router.push('/studio')"><WandSparkles :size="15" />去创作一套</el-button></div></div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Activity, ArrowUpRight, BadgeCheck, Clock3, Coins, Cpu,
  FileText, History, Images, LayoutDashboard, LoaderCircle, Palette, RefreshCw,
  Save, Search, Server, ShieldCheck, Sparkles, ToggleLeft, UsersRound, Plus, Pencil, Trash2,
} from '@lucide/vue'
import AuthDialog from '../components/AuthDialog.vue'
import { adjustAdminWallet, defaultAdminSettings, fetchUpstreamImageModels, getProviderSaveIssues, loadAdminWorkspace, requeueAdminJob, saveAdminProviderApiKey, saveAdminSettings, type AdminImageProvider, type AdminJob, type AdminSettings, type AdminUser } from '../lib/admin'
import { supabaseConfigured } from '../lib/supabase'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const activeSection = ref('overview')
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const loginOpen = ref(false)
const searchText = ref('')
const walletDialogOpen = ref(false)
const selectedUser = ref<AdminUser | null>(null)
const walletDelta = ref<number | undefined>()
const walletNote = ref('')
const providerDialogOpen = ref(false)
const providerDraft = ref<AdminImageProvider | null>(null)
const providerApiKey = ref('')
const fetchingModels = ref(false)
const editingProviderId = ref('')
const sections = [
  { id: 'overview', label: '运营总览', icon: LayoutDashboard },
  { id: 'tasks', label: '任务运维', icon: Activity },
  { id: 'users', label: '用户与汪币', icon: UsersRound },
  { id: 'content', label: '内容配置', icon: Palette },
  { id: 'system', label: '模型与系统', icon: Cpu },
]
const workspace = ref<Awaited<ReturnType<typeof loadAdminWorkspace>> | null>(null)
const settings = ref<AdminSettings>(JSON.parse(JSON.stringify(defaultAdminSettings)) as AdminSettings)
const providerSaveIssues = computed(() => providerDraft.value ? getProviderSaveIssues(providerDraft.value, providerApiKey.value) : [])
const themeText = computed({
  get: () => settings.value.themes.presets.join('\n'),
  set: (value: string) => { settings.value.themes.presets = value.split('\n').map((item) => item.trim()).filter(Boolean) },
})
const isAdmin = computed(() => !supabaseConfigured || auth.user?.app_metadata?.role === 'admin')
const title = computed(() => sections.find((item) => item.id === activeSection.value)?.label || '运营总览')
const userRows = computed(() => (workspace.value?.users || []).filter((user) => `${user.email} ${user.displayName}`.toLowerCase().includes(searchText.value.toLowerCase())))
const jobRows = computed(() => (workspace.value?.jobs || []).filter((job) => `${job.title} ${job.topic} ${job.userEmail} ${job.jobId} ${job.modelName || ''} ${job.errorMessage || ''}`.toLowerCase().includes(searchText.value.toLowerCase())))
const failureRate = computed(() => {
  const metrics = workspace.value?.metrics
  return metrics?.jobs ? `${((metrics.failedJobs / metrics.jobs) * 100).toFixed(1)}%` : '0%'
})

function money(value: number) { return new Intl.NumberFormat('zh-CN').format(value) }
function dateLabel(value: string) { return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) }
function statusLabel(status: AdminJob['status']) { return status === 'completed' ? '已完成' : status === 'failed' ? '失败' : status === 'processing' ? '生成中' : '排队中' }

async function refresh() {
  if (!auth.ready) return
  if (supabaseConfigured && !auth.user) { loading.value = false; return }
  if (!isAdmin.value) { loading.value = false; return }
  loading.value = true
  error.value = ''
  try {
    workspace.value = await loadAdminWorkspace()
    settings.value = JSON.parse(JSON.stringify(workspace.value.settings)) as AdminSettings
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '后台数据加载失败'
  } finally { loading.value = false }
}

async function bootstrap() {
  await auth.init()
  await refresh()
}

watch(() => [auth.user?.id, auth.user?.app_metadata?.role, auth.ready] as const, () => { if (auth.ready) void refresh() })
onMounted(() => { void bootstrap() })

async function saveSettings() {
  if (!workspace.value) return
  if (!workspace.value.demo && !workspace.value.providerModelSchemaReady) {
    ElMessage.warning('模型数据升级尚未完成，当前配置为只读；请稍后刷新再试')
    return
  }
  const invalidEnabledModel = settings.value.model.providers.some((provider) => provider.models.some((model) => model.enabled && (
    !provider.secretConfigured || !provider.name.trim() || !model.name.trim() ||
    !Number.isInteger(model.priceCoins) || model.priceCoins < 1 || model.priceCoins > 100000 ||
    !provider.baseUrl.trim().startsWith('https://')
  )))
  if (invalidEnabledModel) {
    ElMessage.warning('已启用模型必须填写供应商、模型 ID、HTTPS Base URL、已保存密钥及 1–100000 的整数汪币价格')
    return
  }
  saving.value = true
  try {
    await saveAdminSettings(settings.value, workspace.value.demo, auth.user?.id)
    ElMessage.success(workspace.value.demo ? '设置已保存在当前浏览器（演示模式）' : '管理设置已保存')
    await refresh()
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : '保存失败')
  } finally { saving.value = false }
}

function addProvider() {
  if (!workspace.value || (!workspace.value.demo && !workspace.value.providerModelSchemaReady)) {
    ElMessage.warning('模型数据升级尚未完成，请稍后刷新再添加供应商')
    return
  }
  editingProviderId.value = ''
  providerDraft.value = {
    id: crypto.randomUUID(),
    name: '',
    protocol: 'responses',
    baseUrl: 'https://api.openai.com/v1',
    secretConfigured: false,
    models: [],
  }
  providerApiKey.value = ''
  providerDialogOpen.value = true
}

function editProvider(provider: AdminImageProvider) {
  if (!workspace.value || (!workspace.value.demo && !workspace.value.providerModelSchemaReady)) {
    ElMessage.warning('模型数据升级尚未完成，当前配置为只读')
    return
  }
  editingProviderId.value = provider.id
  providerDraft.value = JSON.parse(JSON.stringify(provider)) as AdminImageProvider
  providerApiKey.value = ''
  providerDialogOpen.value = true
}

function addProviderModel() {
  if (!providerDraft.value) return
  providerDraft.value.models.push({ id: crypto.randomUUID(), name: '', enabled: false, priceCoins: 0 })
}

function removeProviderModel(index: number) {
  providerDraft.value?.models.splice(index, 1)
}

async function fetchModels() {
  const provider = providerDraft.value
  if (!provider) return
  if (workspace.value && !workspace.value.demo && !workspace.value.providerModelSchemaReady) {
    ElMessage.warning('模型数据升级尚未完成，请稍后刷新再获取模型')
    return
  }
  if (!provider.baseUrl.trim() || !provider.baseUrl.trim().startsWith('https://')) {
    ElMessage.warning('请填写有效的 HTTPS Base URL')
    return
  }
  if (!providerApiKey.value.trim() && !provider.secretConfigured) {
    ElMessage.warning('首次获取模型列表前，请输入 API Key')
    return
  }
  fetchingModels.value = true
  try {
    const modelIds = await fetchUpstreamImageModels({
      providerId: provider.id,
      baseUrl: provider.baseUrl.trim(),
      protocol: provider.protocol,
      apiKey: providerApiKey.value.trim() || undefined,
    })
    const known = new Set(provider.models.map((model) => model.name.trim()))
    const newIds = modelIds.filter((name) => !known.has(name))
    provider.models.push(...newIds.map((name) => ({ id: crypto.randomUUID(), name, enabled: false, priceCoins: 0 })))
    ElMessage.success(`上游返回 ${modelIds.length} 个模型，新增 ${newIds.length} 个模型条目`)
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : '获取模型列表失败')
  } finally { fetchingModels.value = false }
}

async function saveProvider() {
  const provider = providerDraft.value
  if (!workspace.value || !provider) return
  if (!workspace.value.demo && !workspace.value.providerModelSchemaReady) {
    ElMessage.warning('模型数据升级尚未完成，当前配置为只读')
    return
  }
  const issues = getProviderSaveIssues(provider, providerApiKey.value)
  if (issues.length) {
    ElMessage.warning(issues[0])
    return
  }
  if (providerApiKey.value.trim() && workspace.value.demo) {
    ElMessage.warning('演示模式无法安全保存 API Key；请连接 Supabase 后再配置')
    return
  }
  saving.value = true
  try {
    const savedProvider = JSON.parse(JSON.stringify(provider)) as AdminImageProvider
    const providers = [...settings.value.model.providers]
    const index = providers.findIndex((item) => item.id === savedProvider.id)
    if (index >= 0) providers.splice(index, 1, savedProvider)
    else providers.push(savedProvider)
    const nextSettings = { ...settings.value, model: { providers } }
    await saveAdminSettings(nextSettings, workspace.value.demo, auth.user?.id)
    settings.value = nextSettings
    if (providerApiKey.value.trim()) {
      await saveAdminProviderApiKey(providerApiKey.value.trim(), provider.id)
      provider.secretConfigured = true
    }
    providerDialogOpen.value = false
    providerApiKey.value = ''
    ElMessage.success('供应商与模型配置已保存；API Key 仅保存在 Supabase Vault')
    await refresh()
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : '供应商配置保存失败')
  } finally { saving.value = false }
}

async function retryJob(job: AdminJob) {
  try {
    await ElMessageBox.confirm(
      '系统会使用该任务对应的模型重新生成，并按当前模型价格预扣汪币；成功后结算，失败时会尝试退款，请在任务记录和用户余额中确认退款状态。',
      `重新排队：${job.title}`,
      { confirmButtonText: '确认重排', cancelButtonText: '取消', type: 'warning' },
    )
    await requeueAdminJob(job.jobId, workspace.value?.demo ?? true)
    ElMessage.success('任务已重新排队')
    await refresh()
  } catch (cause) {
    if (cause !== 'cancel' && cause !== 'close') ElMessage.error(cause instanceof Error ? cause.message : '任务更新失败')
  }
}

function openWalletDialog(user: AdminUser) {
  selectedUser.value = user
  walletDelta.value = undefined
  walletNote.value = ''
  walletDialogOpen.value = true
}

async function confirmWalletAdjustment() {
  const user = selectedUser.value
  const delta = Number(walletDelta.value)
  if (!user || !Number.isInteger(delta) || delta === 0 || !walletNote.value.trim()) {
    ElMessage.warning('请输入非零整数和调整原因')
    return
  }
  saving.value = true
  try {
    await adjustAdminWallet(user.userId, delta, walletNote.value.trim(), workspace.value?.demo ?? true)
    walletDialogOpen.value = false
    ElMessage.success(`已${delta > 0 ? '增加' : '扣减'} ${Math.abs(delta)} 汪币`)
    await refresh()
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : '汪币调整失败')
  } finally { saving.value = false }
}

async function resetSettings() {
  if (workspace.value && !workspace.value.demo && !workspace.value.providerModelSchemaReady) {
    ElMessage.warning('模型数据升级尚未完成，当前设置为只读')
    return
  }
  try {
    await ElMessageBox.confirm('恢复默认主题、提示词和功能开关？现有模型配置与密钥状态会保留。', '恢复默认设置', { confirmButtonText: '恢复默认', cancelButtonText: '取消', type: 'warning' })
    const existingProviders = JSON.parse(JSON.stringify(settings.value.model.providers)) as AdminImageProvider[]
    settings.value = JSON.parse(JSON.stringify(defaultAdminSettings)) as AdminSettings
    settings.value.model.providers = existingProviders
    await saveSettings()
  } catch (cause) {
    if (cause !== 'cancel' && cause !== 'close') ElMessage.error(cause instanceof Error ? cause.message : '恢复失败')
  }
}
</script>

<template>
  <div class="admin-page">
    <div v-if="supabaseConfigured && !auth.ready" class="admin-state"><LoaderCircle class="spin" :size="26" />正在验证管理员身份…</div>
    <div v-else-if="supabaseConfigured && !auth.user" class="admin-access-card">
      <div class="admin-access-icon"><ShieldCheck :size="24" /></div><h1>管理员登录</h1>
      <p>此区域仅限获得后台管理员权限的账号访问。请使用已授权的邮箱登录。</p>
      <el-button class="admin-primary" type="primary" @click="loginOpen = true">邮箱登录</el-button>
      <AuthDialog v-model="loginOpen" />
    </div>
    <div v-else-if="!isAdmin" class="admin-access-card">
      <div class="admin-access-icon"><ShieldCheck :size="24" /></div><h1>没有后台权限</h1>
      <p>当前账号尚未获得管理员角色。请由项目所有者在 Supabase Auth 的用户 <code>app_metadata</code> 中设置 <code>{ "role": "admin" }</code> 后重新登录。</p>
      <el-button class="admin-quiet" @click="$router.push('/studio')">返回创作工作台</el-button>
    </div>
    <template v-else>
      <header class="admin-heading">
        <div><div class="admin-eyebrow"><span class="admin-eyebrow-mark"><ShieldCheck :size="14" /></span>JIWANG CONTROL CENTER</div><h1>管理后台</h1><p>产品运营、任务监控与创作配置。</p></div>
        <div class="admin-heading-actions">
          <span class="admin-mode" :class="{ 'is-demo': workspace?.demo }"><i></i>{{ workspace?.demo ? '演示数据' : 'Supabase 云端数据' }}</span>
          <el-button class="admin-quiet" @click="refresh"><RefreshCw :size="14" />刷新</el-button>
        </div>
      </header>

      <el-alert v-if="workspace?.demo" class="admin-notice" type="info" :closable="false" show-icon>
        当前为演示模式：后台设置只保存在此浏览器，示例用户与统计不代表真实线上数据。配置 Supabase 并应用管理后台迁移后，管理员可管理云端数据。
      </el-alert>
      <el-alert v-else class="admin-notice" type="success" :closable="false" show-icon>
        管理后台已连接云端。图像生成由 Supabase Edge Function 在服务端调用；模型 API 密钥保存在 Vault，失败任务会尝试退回已预扣汪币，需结合任务详情和余额确认。
      </el-alert>
      <el-alert v-if="workspace && !workspace.demo && !workspace.providerModelSchemaReady" class="admin-notice" type="warning" :closable="false" show-icon>
        模型数据结构正在升级；现有供应商与模型可查看，但暂时不能编辑或保存。升级完成后刷新页面即可继续操作。
      </el-alert>

      <nav class="admin-tabs" aria-label="管理后台模块">
        <button v-for="item in sections" :key="item.id" :class="{ active: activeSection === item.id }" @click="activeSection = item.id"><component :is="item.icon" :size="16" /><span>{{ item.label }}</span></button>
      </nav>

      <div v-if="loading" class="admin-state"><LoaderCircle class="spin" :size="25" />正在加载{{ title }}…</div>
      <el-alert v-else-if="error" class="admin-error" type="error" :closable="false" show-icon>{{ error }}。请确认已应用管理后台迁移，且当前账号的 app_metadata.role 为 admin。</el-alert>
      <template v-else-if="workspace">
        <section v-if="activeSection === 'overview'" class="admin-section">
          <div class="admin-section-title"><div><h2>运营概况</h2><p>关键业务数据与任务运行状态一览</p></div><span class="admin-updated"><i></i>数据已更新</span></div>
          <div class="admin-metrics">
            <article class="admin-metric"><div class="metric-top"><span>累计用户</span><span class="metric-icon users"><UsersRound :size="16" /></span></div><strong>{{ money(workspace.metrics.users) }}</strong><small>邮箱注册用户</small></article>
            <article class="admin-metric"><div class="metric-top"><span>生成任务</span><span class="metric-icon jobs"><Sparkles :size="16" /></span></div><strong>{{ money(workspace.metrics.jobs) }}</strong><small><ArrowUpRight :size="13" /> {{ money(workspace.metrics.todayJobs) }} 今日新增</small></article>
            <article class="admin-metric"><div class="metric-top"><span>累计素材</span><span class="metric-icon assets"><Images :size="16" /></span></div><strong>{{ money(workspace.metrics.assets) }}</strong><small>图片与贴纸文件</small></article>
            <article class="admin-metric"><div class="metric-top"><span>汪币流通</span><span class="metric-icon coins"><Coins :size="16" /></span></div><strong>{{ money(workspace.metrics.coinsInCirculation) }}</strong><small>所有用户账户余额</small></article>
          </div>

          <div class="admin-overview-grid">
            <article class="admin-panel admin-task-panel">
              <div class="admin-panel-head"><div><h3>近期生成任务</h3><p>实时检查队列状态</p></div><button class="admin-link-button" @click="activeSection = 'tasks'">查看全部 <ArrowUpRight :size="14" /></button></div>
              <div v-if="workspace.jobs.length" class="admin-mini-jobs">
                <div v-for="job in workspace.jobs.slice(0, 5)" :key="job.jobId" class="admin-mini-job"><span class="job-status-dot" :class="job.status"></span><div class="mini-job-name"><strong>{{ job.title }}</strong><small>{{ job.userEmail }} · {{ job.modelName || '模型待定' }} · {{ job.priceCoins || 0 }} 汪币</small></div><span class="admin-status" :class="job.status">{{ statusLabel(job.status) }}</span></div>
              </div><div v-else class="admin-panel-empty">暂无任务</div>
            </article>
            <article class="admin-panel health-panel">
              <div class="admin-panel-head"><div><h3>系统健康度</h3><p>云端生成与账本服务状态</p></div><span class="health-icon"><Activity :size="16" /></span></div>
              <div class="health-row"><span><i class="health-check"></i>邮箱认证与资料库</span><b>{{ workspace.demo ? '演示' : '已连接' }}</b></div>
              <div class="health-row"><span><i class="health-check"></i>任务与素材存储</span><b>{{ workspace.demo ? '演示' : '已连接' }}</b></div>
              <div class="health-row"><span><i :class="workspace.demo ? 'health-pending' : 'health-check'"></i>真实图像生成服务</span><b :class="{ 'pending-text': workspace.demo }">{{ workspace.demo ? '未连接' : 'Edge Function' }}</b></div>
              <div class="health-summary"><span><History :size="15" /> 近 24 小时任务</span><strong>{{ money(workspace.metrics.todayJobs) }}</strong></div>
              <div class="health-meter"><span :style="{ width: `${Math.max(8, 100 - Math.min(Number.parseFloat(failureRate), 100))}%` }"></span></div><small class="health-footnote">失败率 {{ failureRate }} · 生成状态由云端任务记录更新</small>
            </article>
          </div>
        </section>

        <section v-else-if="activeSection === 'tasks'" class="admin-section">
          <div class="admin-section-title"><div><h2>任务运维</h2><p>查看生成模型和费用；失败任务可按当前模型价格重试。</p></div><div class="admin-search"><Search :size="15" /><el-input v-model="searchText" placeholder="搜索任务 / 用户 / 模型" clearable /></div></div>
          <div class="admin-table-wrap"><el-table :data="jobRows" stripe style="width: 100%" empty-text="没有匹配的生成任务">
            <el-table-column label="任务" min-width="230"><template #default="{ row }"><div class="table-primary">{{ row.title }}</div><div class="table-secondary">{{ row.topic || '自定义主题' }} · {{ row.assetCount || 0 }} 格 · {{ row.modelName || '—' }} · {{ row.priceCoins || 0 }} 汪币</div></template></el-table-column>
            <el-table-column prop="userEmail" label="用户" min-width="165" show-overflow-tooltip />
            <el-table-column label="状态" width="115"><template #default="{ row }"><span class="admin-status" :class="row.status"><i></i>{{ statusLabel(row.status) }}</span></template></el-table-column>
            <el-table-column label="失败诊断" min-width="320" show-overflow-tooltip><template #default="{ row }"><span v-if="row.status === 'failed'">{{ row.errorMessage || '该任务未保存失败详情；请检查是否为旧任务，并先核对用户退款状态。' }}</span><span v-else class="table-muted">—</span></template></el-table-column>
            <el-table-column label="创建时间" width="145"><template #default="{ row }">{{ dateLabel(row.createdAt) }}</template></el-table-column>
            <el-table-column label="操作" width="125" fixed="right"><template #default="{ row }"><el-button v-if="row.status === 'failed'" class="table-action" link type="primary" @click="retryJob(row as AdminJob)"><RefreshCw :size="13" />重新生成</el-button><span v-else class="table-muted">—</span></template></el-table-column>
          </el-table></div>
          <p class="admin-table-note"><Clock3 :size="13" /> 重试会通过服务端重新调用模型，并按当前模型价格扣费；失败时系统会尝试退款，请根据用户余额和账本记录确认是否到账。</p>
        </section>

        <section v-else-if="activeSection === 'users'" class="admin-section">
          <div class="admin-section-title"><div><h2>用户与汪币</h2><p>查看账号、加入时间及余额；每次人工调整都会写入账本。</p></div><div class="admin-search"><Search :size="15" /><el-input v-model="searchText" placeholder="搜索邮箱 / 昵称" clearable /></div></div>
          <div class="admin-coins-callout"><span><Coins :size="17" /></span><div><strong>汪币总流通量</strong><small>用户账户余额汇总</small></div><b>{{ money(workspace.metrics.coinsInCirculation) }} <i>汪币</i></b></div>
          <div class="admin-table-wrap"><el-table :data="userRows" stripe style="width: 100%" empty-text="没有匹配的用户">
            <el-table-column label="用户" min-width="230"><template #default="{ row }"><div class="admin-user-cell"><span class="user-initial">{{ (row.displayName || row.email).slice(0, 1).toUpperCase() }}</span><span><b>{{ row.displayName }}</b><small>{{ row.email }}</small></span></div></template></el-table-column>
            <el-table-column label="注册时间" width="150"><template #default="{ row }">{{ dateLabel(row.createdAt) }}</template></el-table-column>
            <el-table-column label="生成次数" width="110"><template #default="{ row }">{{ row.totalCount }} 次</template></el-table-column>
            <el-table-column label="汪币余额" width="130"><template #default="{ row }"><b class="coin-balance"><Coins :size="14" />{{ money(row.coins) }}</b></template></el-table-column>
            <el-table-column label="操作" width="130" fixed="right"><template #default="{ row }"><el-button class="table-action" link type="primary" @click="openWalletDialog(row as AdminUser)"><Coins :size="14" />调整汪币</el-button></template></el-table-column>
          </el-table></div>
          <div v-if="!workspace.demo" class="admin-table-note"><ShieldCheck :size="14" /> 本页展示最近 100 个账号；余额调整会由数据库事务校验并写入不可由普通用户修改的流水。</div>
        </section>

        <section v-else-if="activeSection === 'content'" class="admin-section">
          <div class="admin-section-title"><div><h2>内容配置</h2><p>管理创作主题和默认提示词，影响后续用户端体验。</p></div></div>
          <div class="admin-config-grid">
            <article class="admin-panel config-card"><div class="config-card-title"><span class="config-icon blue"><Palette :size="17" /></span><div><h3>主题预设</h3><p>在创作工作台展示的主题入口</p></div></div>
              <label class="admin-field-label" for="theme-presets">主题名称（每行一个）</label><el-input id="theme-presets" v-model="themeText" type="textarea" :rows="7" placeholder="每行输入一个主题" />
              <div class="field-footnote">共 {{ settings.themes.presets.length }} 个主题预设</div>
            </article>
            <article class="admin-panel config-card"><div class="config-card-title"><span class="config-icon violet"><FileText :size="17" /></span><div><h3>系统提示词模板</h3><p v-pre>支持 {{topic}}、{{caption}} 和 {{visual}} 变量</p></div></div>
              <label class="admin-field-label" for="sticker-prompt">表情生成提示词</label><el-input id="sticker-prompt" v-model="settings.prompts.sticker" type="textarea" :rows="9" placeholder="输入生成提示词模板" />
              <div class="field-footnote">请保留需要由任务服务填入的变量标记</div>
            </article>
          </div>
          <div class="admin-save-row"><span>调整会作为管理设置保存，不包含密钥。</span><el-button class="admin-primary" type="primary" :loading="saving" @click="saveSettings"><Save :size="15" />保存内容配置</el-button></div>
        </section>

        <section v-else class="admin-section">
          <div class="admin-section-title"><div><h2>模型与系统</h2><p>每个供应商共享协议、Base URL 和 API Key；供应商下可配置多个模型及各自汪币价格。</p></div><el-button class="admin-primary" type="primary" :disabled="!workspace.demo && !workspace.providerModelSchemaReady" @click="addProvider"><Plus :size="15" />添加模型</el-button></div>
          <article v-for="provider in settings.model.providers" :key="provider.id" class="admin-panel provider-card">
            <header class="provider-card-head">
              <span class="config-icon cyan"><Server :size="17" /></span>
              <div class="provider-card-title"><h3>{{ provider.name }}</h3><p>{{ provider.protocol === 'responses' ? 'Responses API' : 'Chat Completions' }} · {{ provider.baseUrl || '未设置 Base URL' }}</p></div>
              <span class="provider-secret-state" :class="{ configured: provider.secretConfigured }">{{ provider.secretConfigured ? 'API Key 已保存' : '未配置 API Key' }}</span>
              <el-button class="admin-quiet provider-edit" :disabled="!workspace.demo && !workspace.providerModelSchemaReady" @click="editProvider(provider)"><Pencil :size="14" />编辑</el-button>
            </header>
            <div v-if="provider.models.length" class="provider-model-list">
              <div v-for="model in provider.models" :key="model.id" class="provider-model-row">
                <strong>{{ model.name || '未命名模型' }}</strong>
                <span>{{ money(model.priceCoins) }} 汪币/套</span>
                <span class="provider-model-state" :class="{ enabled: model.enabled }">{{ model.enabled ? '启用' : '停用' }}</span>
              </div>
            </div>
            <div v-else class="provider-model-empty">尚未添加模型；点击“编辑”后可从上游获取。</div>
          </article>
          <div v-if="settings.model.providers.length === 0" class="admin-panel-empty">还没有供应商或模型配置，点击“添加模型”开始添加。</div>
          <div class="secret-note"><ShieldCheck :size="15" /><span>供应商 API Key 加密保存在 Supabase Vault，由生成 Edge Function 安全读取；不会返回浏览器或写入 localStorage。只有 API Key 已保存、价格有效并启用的模型才会显示在前台。</span></div>
          <article class="admin-panel feature-panel"><div class="admin-panel-head"><div><h3>产品功能开关</h3><p>控制产品模块的开放状态</p></div><span class="feature-icon"><ToggleLeft :size="16" /></span></div>
            <div class="feature-row"><div><b>邮箱注册</b><small>允许新用户创建极汪账号</small></div><el-switch v-model="settings.features.signup" /></div>
            <div class="feature-row"><div><b>自定义主题</b><small>允许用户输入自定义创作主题</small></div><el-switch v-model="settings.features.customThemes" /></div>
            <div class="feature-row"><div><b>社区投稿入口</b><small>预留投稿审核功能，当前未开放</small></div><el-switch v-model="settings.features.communitySubmissions" /></div>
            <div class="feature-row"><div><b>维护模式</b><small>启用后应由服务端拦截用户侧新任务</small></div><el-switch v-model="settings.features.maintenance" /></div>
          </article>
          <div class="admin-save-row"><span>模型配置与功能开关保存到后台；启用模型需已配置 API Key 并设置有效汪币价格。</span><div class="admin-save-actions"><el-button class="admin-quiet" @click="resetSettings"><RefreshCw :size="14" />恢复默认</el-button><el-button class="admin-primary" type="primary" :loading="saving" @click="saveSettings"><Save :size="15" />保存系统设置</el-button></div></div>
        </section>
      </template>

      <footer class="admin-footer"><span><BadgeCheck :size="14" /> 权限由 Supabase app_metadata 与 RLS 校验</span><span>极汪管理后台 <b>v0.2</b></span></footer>
    </template>

    <el-dialog v-model="providerDialogOpen" :title="editingProviderId ? '编辑供应商和模型' : '添加模型供应商'" width="760px" class="provider-dialog" :close-on-click-modal="false" destroy-on-close>
      <template v-if="providerDraft">
        <div class="provider-form-grid">
          <label><span>供应商</span><el-input v-model="providerDraft.name" maxlength="100" placeholder="输入供应商名称" /></label>
          <label><span>上游协议</span><el-select v-model="providerDraft.protocol"><el-option label="Responses API" value="responses" /><el-option label="Chat Completions" value="chat_completions" /></el-select></label>
          <label class="provider-form-wide"><span>Base URL</span><el-input v-model="providerDraft.baseUrl" placeholder="例如 https://api.example.com/v1" /></label>
          <label class="provider-form-wide"><span>API Key</span><el-input v-model="providerApiKey" type="password" show-password autocomplete="new-password" :disabled="workspace?.demo" :placeholder="providerDraft.secretConfigured ? '留空保持已保存的密钥不变' : '输入上游 API Key'" /><small>{{ workspace?.demo ? '演示模式无法安全保存密钥，请连接 Supabase 后配置。' : providerDraft.secretConfigured ? '密钥已保存在 Vault；此处不会显示原文。输入新密钥可替换。' : '密钥仅会加密保存到 Supabase Vault，不会保存到浏览器。' }}</small></label>
        </div>
        <div class="provider-model-toolbar"><div><strong>模型列表</strong><small>启用状态可先勾选；保存前需填写模型 ID、正数汪币价格并配置 API Key</small></div><div><el-button class="admin-quiet" :loading="fetchingModels" :disabled="workspace?.demo || !workspace?.providerModelSchemaReady" @click="fetchModels"><RefreshCw :size="14" />获取模型</el-button><el-button class="admin-quiet" :disabled="!workspace?.demo && !workspace?.providerModelSchemaReady" @click="addProviderModel"><Plus :size="14" />手动添加</el-button></div></div>
        <el-alert v-if="providerSaveIssues.length" class="provider-save-warning" type="warning" :closable="false" show-icon>
          <template #title>当前配置尚不能保存</template>
          <div v-for="issue in providerSaveIssues" :key="issue">{{ issue }}</div>
        </el-alert>
        <div v-if="fetchingModels" class="provider-fetching"><LoaderCircle class="spin" :size="15" />正在从上游获取模型列表…</div>
        <div v-else-if="providerDraft.models.length" class="provider-edit-list">
          <div class="provider-edit-header"><span>模型 ID</span><span>额外汪币</span><span>启用</span><span>删除</span></div>
          <div v-for="(model, index) in providerDraft.models" :key="model.id" class="provider-edit-row">
            <el-input v-model="model.name" placeholder="例如 gpt-image-2.5" />
            <el-input-number v-model="model.priceCoins" :min="0" :max="100000" :precision="0" controls-position="right" />
            <el-checkbox v-model="model.enabled" />
            <el-button class="provider-delete-model" text type="danger" aria-label="删除模型" @click="removeProviderModel(index)"><Trash2 :size="15" /></el-button>
          </div>
        </div>
        <div v-else class="provider-model-empty">还没有模型。点击“获取模型”从上游读取，或手动添加一个模型 ID。</div>
      </template>
      <template #footer><el-button @click="providerDialogOpen = false">取消</el-button><el-button class="admin-primary" type="primary" :loading="saving" @click="saveProvider"><Save :size="15" />保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="walletDialogOpen" title="调整用户汪币" width="440px" class="wallet-dialog" destroy-on-close>
      <div v-if="selectedUser" class="wallet-target"><span class="user-initial">{{ selectedUser.displayName.slice(0, 1) }}</span><span><b>{{ selectedUser.displayName }}</b><small>{{ selectedUser.email }}</small></span><strong>现有 {{ money(selectedUser.coins) }} 汪币</strong></div>
      <el-form label-position="top"><el-form-item label="调整数量（正数增加，负数扣减）"><el-input v-model.number="walletDelta" type="number" placeholder="例如 50 或 -20"><template #append>汪币</template></el-input></el-form-item><el-form-item label="调整原因（必填，写入流水）"><el-input v-model="walletNote" maxlength="240" show-word-limit placeholder="例如：活动奖励 / 客服补偿" /></el-form-item></el-form>
      <template #footer><el-button @click="walletDialogOpen = false">取消</el-button><el-button class="admin-primary" type="primary" :loading="saving" @click="confirmWalletAdjustment">确认调整</el-button></template>
    </el-dialog>
  </div>
</template>

<style src="../styles/admin.css"></style>

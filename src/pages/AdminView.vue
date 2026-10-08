<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Activity, ArrowUpRight, BadgeCheck, Clock3, Coins, Cpu,
  FileText, History, Images, LayoutDashboard, LoaderCircle, Palette, RefreshCw,
  Save, Search, Server, ShieldCheck, Sparkles, ToggleLeft, UsersRound,
} from '@lucide/vue'
import AuthDialog from '../components/AuthDialog.vue'
import { adjustAdminWallet, defaultAdminSettings, loadAdminWorkspace, requeueAdminJob, saveAdminModelApiKey, saveAdminSettings, type AdminJob, type AdminSettings, type AdminUser } from '../lib/admin'
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
const modelApiKey = ref('')
const sections = [
  { id: 'overview', label: '运营总览', icon: LayoutDashboard },
  { id: 'tasks', label: '任务运维', icon: Activity },
  { id: 'users', label: '用户与汪币', icon: UsersRound },
  { id: 'content', label: '内容配置', icon: Palette },
  { id: 'system', label: '模型与系统', icon: Cpu },
]
const workspace = ref<Awaited<ReturnType<typeof loadAdminWorkspace>> | null>(null)
const settings = ref<AdminSettings>(JSON.parse(JSON.stringify(defaultAdminSettings)) as AdminSettings)
const themeText = computed({
  get: () => settings.value.themes.presets.join('\n'),
  set: (value: string) => { settings.value.themes.presets = value.split('\n').map((item) => item.trim()).filter(Boolean) },
})
const isAdmin = computed(() => !supabaseConfigured || auth.user?.app_metadata?.role === 'admin')
const title = computed(() => sections.find((item) => item.id === activeSection.value)?.label || '运营总览')
const userRows = computed(() => (workspace.value?.users || []).filter((user) => `${user.email} ${user.displayName}`.toLowerCase().includes(searchText.value.toLowerCase())))
const jobRows = computed(() => (workspace.value?.jobs || []).filter((job) => `${job.title} ${job.topic} ${job.userEmail} ${job.jobId}`.toLowerCase().includes(searchText.value.toLowerCase())))
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
  if (settings.value.model.enabled && !settings.value.model.secretConfigured) {
    ElMessage.warning('请先安全保存第三方 API Key，再启用模型服务')
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

async function saveModelApiKey() {
  if (!workspace.value || workspace.value.demo || !modelApiKey.value.trim()) {
    ElMessage.warning('请先连接 Supabase，并输入第三方模型 API Key')
    return
  }
  saving.value = true
  try {
    await saveAdminModelApiKey(modelApiKey.value.trim())
    modelApiKey.value = ''
    settings.value.model.secretConfigured = true
    ElMessage.success('API Key 已加密保存在 Supabase Vault；页面不会取回原文或写入本地存储')
    await refresh()
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : 'API Key 保存失败')
  } finally { saving.value = false }
}

async function retryJob(job: AdminJob) {
  try {
    await ElMessageBox.confirm(
      '这会将失败任务重置为“排队中”。目前真实图像模型和后台 worker 尚未接入，云端任务只会进入队列，不会启动真实生成。',
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
  try {
    await ElMessageBox.confirm('恢复默认主题、提示词、模型展示参数和功能开关？', '恢复默认设置', { confirmButtonText: '恢复默认', cancelButtonText: '取消', type: 'warning' })
    const savedSecretState = settings.value.model.secretConfigured
    settings.value = JSON.parse(JSON.stringify(defaultAdminSettings)) as AdminSettings
    settings.value.model.secretConfigured = savedSecretState
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
      <el-alert v-else class="admin-notice" type="warning" :closable="false" show-icon>
        管理后台已连接云端。真实模型推理与异步 worker 尚未接入；模型 API 密钥必须保存在服务端 Secret 中，不会存进浏览器配置表。
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
                <div v-for="job in workspace.jobs.slice(0, 5)" :key="job.jobId" class="admin-mini-job"><span class="job-status-dot" :class="job.status"></span><div class="mini-job-name"><strong>{{ job.title }}</strong><small>{{ job.userEmail }} · {{ dateLabel(job.createdAt) }}</small></div><span class="admin-status" :class="job.status">{{ statusLabel(job.status) }}</span></div>
              </div><div v-else class="admin-panel-empty">暂无任务</div>
            </article>
            <article class="admin-panel health-panel">
              <div class="admin-panel-head"><div><h3>系统健康度</h3><p>原型环境服务接入状态</p></div><span class="health-icon"><Activity :size="16" /></span></div>
              <div class="health-row"><span><i class="health-check"></i>邮箱认证与资料库</span><b>{{ workspace.demo ? '演示' : '已连接' }}</b></div>
              <div class="health-row"><span><i class="health-check"></i>任务与素材存储</span><b>{{ workspace.demo ? '演示' : '已连接' }}</b></div>
              <div class="health-row"><span><i class="health-pending"></i>真实图像生成 Worker</span><b class="pending-text">未接入</b></div>
              <div class="health-summary"><span><History :size="15" /> 近 24 小时任务</span><strong>{{ money(workspace.metrics.todayJobs) }}</strong></div>
              <div class="health-meter"><span :style="{ width: `${Math.max(8, 100 - Math.min(Number.parseFloat(failureRate), 100))}%` }"></span></div><small class="health-footnote">失败率 {{ failureRate }} · 当前数据不包含真实推理延迟</small>
            </article>
          </div>
        </section>

        <section v-else-if="activeSection === 'tasks'" class="admin-section">
          <div class="admin-section-title"><div><h2>任务运维</h2><p>查看用户生成任务；失败任务可重新放回队列。</p></div><div class="admin-search"><Search :size="15" /><el-input v-model="searchText" placeholder="搜索任务 / 用户" clearable /></div></div>
          <div class="admin-table-wrap"><el-table :data="jobRows" stripe style="width: 100%" empty-text="没有匹配的生成任务">
            <el-table-column label="任务" min-width="210"><template #default="{ row }"><div class="table-primary">{{ row.title }}</div><div class="table-secondary">{{ row.topic || '自定义主题' }} · {{ row.assetCount || 0 }} 格</div></template></el-table-column>
            <el-table-column prop="userEmail" label="用户" min-width="165" show-overflow-tooltip />
            <el-table-column label="状态" width="115"><template #default="{ row }"><span class="admin-status" :class="row.status"><i></i>{{ statusLabel(row.status) }}</span></template></el-table-column>
            <el-table-column label="创建时间" width="145"><template #default="{ row }">{{ dateLabel(row.createdAt) }}</template></el-table-column>
            <el-table-column label="操作" width="125" fixed="right"><template #default="{ row }"><el-button v-if="row.status === 'failed'" class="table-action" link type="primary" @click="retryJob(row as AdminJob)"><RefreshCw :size="13" />重新排队</el-button><span v-else class="table-muted">—</span></template></el-table-column>
          </el-table></div>
          <p class="admin-table-note"><Clock3 :size="13" /> 重新排队只会将任务状态改为 queued；接入服务端生成 Worker 后才会真正开始处理。</p>
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
          <div class="admin-section-title"><div><h2>模型与系统</h2><p>控制模型连接参数和产品功能开关。</p></div></div>
          <article class="admin-panel model-card"><div class="config-card-title"><span class="config-icon cyan"><Server :size="17" /></span><div><h3>第三方图像模型</h3><p>配置 OpenAI 兼容的第三方服务、模型名称和 API 地址。</p></div><el-switch v-model="settings.model.enabled" /></div>
            <div class="model-fields"><label><span>服务商 / 接口类型</span><el-input v-model="settings.model.provider" placeholder="如：OpenAI 兼容接口" /></label><label><span>模型名称 / ID</span><el-input v-model="settings.model.name" placeholder="填入供应商提供的模型 ID" /></label><label class="field-wide"><span>API Base URL（可选）</span><el-input v-model="settings.model.endpoint" placeholder="例如 https://api.example.com/v1；由服务端调用" /></label><label class="field-wide"><span>第三方 API Key</span><div class="model-secret-input"><el-input v-model="modelApiKey" type="password" show-password autocomplete="new-password" :disabled="workspace.demo" placeholder="留空不会更改已保存的密钥" /><el-button class="admin-primary" type="primary" :loading="saving" :disabled="workspace.demo || !modelApiKey.trim()" @click="saveModelApiKey">安全保存密钥</el-button></div><small class="secret-status">{{ workspace.demo ? '演示模式不能保存密钥；连接 Supabase 后可配置。' : settings.model.secretConfigured ? '已保存一把密钥；页面只显示状态，不会从 Vault 取回密钥原文。' : '尚未保存模型密钥。密钥通过 RPC 写入 Supabase Vault。' }}</small></label></div>
            <div class="secret-note"><ShieldCheck :size="15" /><span>安全说明：密钥在输入和提交时短暂经过管理员浏览器内存，并通过 Supabase HTTPS RPC 发送；保存后页面不会取回原文或写入 localStorage。Vault 加密保存后，仅服务端 service_role 可读取。当前创作流程仍使用 Mock，接入服务端生成 Worker 后才会调用此模型。</span></div>
          </article>
          <article class="admin-panel feature-panel"><div class="admin-panel-head"><div><h3>产品功能开关</h3><p>控制产品模块的开放状态</p></div><span class="feature-icon"><ToggleLeft :size="16" /></span></div>
            <div class="feature-row"><div><b>邮箱注册</b><small>允许新用户创建极汪账号</small></div><el-switch v-model="settings.features.signup" /></div>
            <div class="feature-row"><div><b>自定义主题</b><small>允许用户输入自定义创作主题</small></div><el-switch v-model="settings.features.customThemes" /></div>
            <div class="feature-row"><div><b>社区投稿入口</b><small>预留投稿审核功能，当前未开放</small></div><el-switch v-model="settings.features.communitySubmissions" /></div>
            <div class="feature-row"><div><b>维护模式</b><small>启用后应由服务端拦截用户侧新任务</small></div><el-switch v-model="settings.features.maintenance" /></div>
          </article>
          <div class="admin-save-row"><span>功能开关保存到后台配置；实际生效需用户端和任务 Worker 读取同一配置。</span><div class="admin-save-actions"><el-button class="admin-quiet" @click="resetSettings"><RefreshCw :size="14" />恢复默认</el-button><el-button class="admin-primary" type="primary" :loading="saving" @click="saveSettings"><Save :size="15" />保存系统设置</el-button></div></div>
        </section>
      </template>

      <footer class="admin-footer"><span><BadgeCheck :size="14" /> 权限由 Supabase app_metadata 与 RLS 校验</span><span>极汪管理后台 <b>v0.2</b></span></footer>
    </template>

    <el-dialog v-model="walletDialogOpen" title="调整用户汪币" width="440px" class="wallet-dialog" destroy-on-close>
      <div v-if="selectedUser" class="wallet-target"><span class="user-initial">{{ selectedUser.displayName.slice(0, 1) }}</span><span><b>{{ selectedUser.displayName }}</b><small>{{ selectedUser.email }}</small></span><strong>现有 {{ money(selectedUser.coins) }} 汪币</strong></div>
      <el-form label-position="top"><el-form-item label="调整数量（正数增加，负数扣减）"><el-input v-model.number="walletDelta" type="number" placeholder="例如 50 或 -20"><template #append>汪币</template></el-input></el-form-item><el-form-item label="调整原因（必填，写入流水）"><el-input v-model="walletNote" maxlength="240" show-word-limit placeholder="例如：活动奖励 / 客服补偿" /></el-form-item></el-form>
      <template #footer><el-button @click="walletDialogOpen = false">取消</el-button><el-button class="admin-primary" type="primary" :loading="saving" @click="confirmWalletAdjustment">确认调整</el-button></template>
    </el-dialog>
  </div>
</template>

<style src="../styles/admin.css"></style>

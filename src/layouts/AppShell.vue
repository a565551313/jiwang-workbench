<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { Images, LogOut, History, WandSparkles, UserRound, Sparkles } from '@lucide/vue'
import { ElMessage } from 'element-plus'
import AuthDialog from '../components/AuthDialog.vue'
import { useAuthStore } from '../stores/auth'

const route = useRoute()
const auth = useAuthStore()
const authOpen = ref(false)
const pageTitle = computed(() => String(route.meta.title || '创作工作台'))
const navItems = [
  { label: '创作工作台', to: '/studio', icon: WandSparkles },
  { label: '我的素材', to: '/assets', icon: Images },
  { label: '生成记录', to: '/history', icon: History },
]
const initial = computed(() => auth.user?.email?.slice(0, 1).toUpperCase() || '汪')

async function signOut() {
  try {
    await auth.signOut()
    ElMessage.success('已退出登录')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '退出失败')
  }
}
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <RouterLink class="brand" to="/studio" aria-label="极汪首页">
        <span class="brand-mark"><span class="paw-pad"></span><i></i><i></i><i></i></span>
        <span class="brand-name">极汪<span class="brand-dot">.</span><small>JIWANG STUDIO</small></span>
      </RouterLink>

      <div class="side-label">创作空间</div>
      <nav class="primary-nav" aria-label="主导航">
        <RouterLink v-for="item in navItems" :key="item.to" :to="item.to" class="nav-link" :class="{ active: route.path === item.to }">
          <component :is="item.icon" :size="18" :stroke-width="1.8" />
          <span>{{ item.label }}</span>
          <span v-if="item.to === '/studio'" class="nav-indicator"></span>
        </RouterLink>
      </nav>

      <div class="sidebar-spacer"></div>
      <div class="provider-card">
        <div class="provider-card-top"><span class="live-dot"></span><span>原型演示模式</span><Sparkles :size="15" /></div>
        <p>真实图像模型尚未接入。生成过程由浏览器本地 Mock 完成。</p>
      </div>
      <div class="sidebar-bottom">
        <div class="side-user" v-if="auth.isSignedIn">
          <div class="avatar small-avatar">{{ initial }}</div>
          <div class="user-meta"><strong>{{ auth.user?.user_metadata?.display_name || '极汪用户' }}</strong><span>{{ auth.user?.email }}</span></div>
          <el-dropdown trigger="click" @command="signOut">
            <button class="icon-button user-menu" aria-label="账户菜单"><UserRound :size="18" /></button>
            <template #dropdown><el-dropdown-menu><el-dropdown-item command="logout"><LogOut :size="15" />退出登录</el-dropdown-item></el-dropdown-menu></template>
          </el-dropdown>
        </div>
        <button v-else class="sidebar-login" @click="authOpen = true"><div class="avatar small-avatar"><UserRound :size="17" /></div><span>邮箱登录 / 注册</span><span class="side-arrow">↗</span></button>
        <div class="sidebar-footnote">极汪工作台 <span>v0.1</span></div>
      </div>
    </aside>

    <div class="main-column">
      <header class="topbar">
        <div class="breadcrumb"><span>创作空间</span><span class="breadcrumb-slash">/</span><strong>{{ pageTitle }}</strong></div>
        <div class="topbar-actions">
          <span class="topbar-mode"><span class="live-dot"></span>原型模式</span>
          <button v-if="auth.isSignedIn" class="header-user" @click="signOut"><span class="avatar">{{ initial }}</span><span class="header-user-label">{{ auth.user?.email }}</span><LogOut :size="16" /></button>
          <button v-else class="header-login" @click="authOpen = true">登录 / 注册</button>
        </div>
      </header>
      <nav class="mobile-nav" aria-label="移动端主导航">
        <RouterLink v-for="item in navItems" :key="item.to" :to="item.to" :class="{ active: route.path === item.to }"><component :is="item.icon" :size="17" /><span>{{ item.label }}</span></RouterLink>
      </nav>
      <main class="page-content"><RouterView /></main>
    </div>
    <AuthDialog v-model="authOpen" />
  </div>
</template>

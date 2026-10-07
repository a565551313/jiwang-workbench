import { createRouter, createWebHistory } from 'vue-router'
import AppShell from './layouts/AppShell.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      component: AppShell,
      children: [
        { path: '', redirect: '/studio' },
        { path: 'studio', name: 'studio', component: () => import('./pages/StudioView.vue'), meta: { title: '创作工作台' } },
        { path: 'assets', name: 'assets', component: () => import('./pages/AssetsView.vue'), meta: { title: '我的素材' } },
        { path: 'history', name: 'history', component: () => import('./pages/HistoryView.vue'), meta: { title: '生成记录' } },
        { path: 'admin', name: 'admin', component: () => import('./pages/AdminView.vue'), meta: { title: '管理后台' } },
        { path: '/:pathMatch(.*)*', redirect: '/studio' },
      ],
    },
  ],
  scrollBehavior: () => ({ top: 0, behavior: 'smooth' }),
})

export default router

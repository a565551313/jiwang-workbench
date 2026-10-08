import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHistory, RouterView } from 'vue-router'
import '../src/styles.css'
import './admin.css'
import LocalAdminApp from './LocalAdminApp.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/admin' },
    { path: '/admin', component: LocalAdminApp },
    { path: '/:pathMatch(.*)*', redirect: '/admin' },
  ],
})

createApp({ render: () => h(RouterView) }).use(createPinia()).use(router).mount('#admin-app')

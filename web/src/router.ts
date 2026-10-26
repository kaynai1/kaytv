import { createRouter, createWebHashHistory, createWebHistory } from 'vue-router'

const routes = [
  { path: '/', name: 'movies', component: () => import('./views/MoviesView.vue'), meta: { title: '影视专区' } },
  { path: '/movies', redirect: '/' },
  { path: '/live', name: 'live', component: () => import('./views/LiveView.vue'), meta: { title: '直播频道' } },
  { path: '/hot', name: 'hot', component: () => import('./views/HotView.vue'), meta: { title: '最新热门' } },
  { path: '/search', name: 'search', component: () => import('./views/SearchView.vue'), meta: { title: '搜索' } },
  { path: '/favorites', name: 'favorites', component: () => import('./views/FavoritesView.vue'), meta: { title: '我的清单' } },
  { path: '/feedback', name: 'feedback', component: () => import('./views/FeedbackView.vue'), meta: { title: '求片与反馈' } },
  { path: '/settings', name: 'settings', component: () => import('./views/SettingsView.vue'), meta: { title: '设置' } },
  { path: '/login', name: 'login', component: () => import('./views/LoginView.vue'), meta: { title: '登录', auth: true } },
  {
    path: '/detail/:source/:id',
    name: 'detail',
    component: () => import('./views/DetailView.vue'),
    meta: { title: '详情' }
  },
  { path: '/admin', name: 'admin', component: () => import('./views/AdminView.vue'), meta: { title: '管理后台', admin: true } },
  { path: '/:pathMatch(.*)*', redirect: '/' }
]

const router = createRouter({
  history:
    window.location.protocol === 'file:' ? createWebHashHistory() : createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 })
})

router.afterEach((to) => {
  const title = to.meta?.title ? `${to.meta.title} · KayTV` : 'KayTV'
  document.title = title
})

export default router

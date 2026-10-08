import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { Session, User } from '@supabase/supabase-js'
import { supabase, supabaseConfigured } from '../lib/supabase'

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null)
  const ready = ref(false)
  const isSignedIn = computed(() => Boolean(user.value))
  let listenerAttached = false

  async function init() {
    if (!supabase) { ready.value = true; return }
    if (!listenerAttached) {
      listenerAttached = true
      supabase.auth.onAuthStateChange((_event, session: Session | null) => {
        user.value = session?.user ?? null
        ready.value = true
      })
    }
    const { data } = await supabase.auth.getSession()
    user.value = data.session?.user ?? null
    ready.value = true
  }

  async function signIn(email: string, password: string) {
    if (!supabase || !supabaseConfigured) throw new Error('请先设置 Supabase 项目配置')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
  }

  async function signUp(email: string, password: string, displayName: string) {
    if (!supabase || !supabaseConfigured) throw new Error('请先设置 Supabase 项目配置')
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { display_name: displayName },
        emailRedirectTo: window.location.origin,
      },
    })
    if (error) throw error
    if (data.session) user.value = data.user
    return { confirmationRequired: !data.session }
  }

  async function resendConfirmation(email: string) {
    if (!supabase || !supabaseConfigured) throw new Error('请先设置 Supabase 项目配置')
    const { error } = await supabase.auth.resend({
      type: 'signup',
      email,
      options: { emailRedirectTo: window.location.origin },
    })
    if (error) throw error
  }

  async function signOut() {
    if (supabase) {
      const { error } = await supabase.auth.signOut()
      if (error) throw error
    }
    user.value = null
  }

  return { user, ready, isSignedIn, init, signIn, signUp, resendConfirmation, signOut }
})

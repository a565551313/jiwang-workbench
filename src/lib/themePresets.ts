import type { DraftCell } from '../types'
import { makeDraft, themeGroups } from './drafts'
import { supabase, supabaseConfigured } from './supabase'

/** Every preset theme is a full 16-cell script. */
export const THEME_CELL_COUNT = 16
export const THEME_LABEL_MAX = 8
export const THEME_NAME_MAX = 12
export const THEME_CAPTION_MAX = 12
export const THEME_VISUAL_MAX = 200

export interface ThemePresetCell {
  caption: string
  visual: string
}

export interface ThemePreset {
  /** Unique across all groups; the studio selects a theme by this name. */
  name: string
  cells: ThemePresetCell[]
}

export interface ThemePresetGroup {
  label: string
  themes: ThemePreset[]
}

function clip(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/** Built-in presets. Used until an administrator saves presets, and whenever the server cannot be read. */
export function defaultThemePresetGroups(): ThemePresetGroup[] {
  return themeGroups.map((group) => ({
    label: group.label,
    themes: group.themes.map((name) => ({
      name,
      cells: makeDraft(name).map((cell) => ({ caption: cell.caption, visual: cell.visual })),
    })),
  }))
}

/**
 * Drop malformed entries from untrusted JSON (the admin settings row or the public RPC).
 * Returns null when nothing usable remains, so callers can fall back to the built-in presets.
 */
export function normalizeThemePresetGroups(value: unknown): ThemePresetGroup[] | null {
  if (!Array.isArray(value)) return null
  const names = new Set<string>()
  const groups: ThemePresetGroup[] = []
  for (const rawGroup of value) {
    if (!rawGroup || typeof rawGroup !== 'object') continue
    const group = rawGroup as Record<string, unknown>
    const label = clip(group.label, THEME_LABEL_MAX)
    if (!label || !Array.isArray(group.themes)) continue
    const themes: ThemePreset[] = []
    for (const rawTheme of group.themes) {
      if (!rawTheme || typeof rawTheme !== 'object') continue
      const theme = rawTheme as Record<string, unknown>
      const name = clip(theme.name, THEME_NAME_MAX)
      if (!name || names.has(name) || !Array.isArray(theme.cells)) continue
      const cells: ThemePresetCell[] = []
      for (const rawCell of theme.cells) {
        if (!rawCell || typeof rawCell !== 'object') continue
        const cell = rawCell as Record<string, unknown>
        const caption = clip(cell.caption, THEME_CAPTION_MAX)
        const visual = clip(cell.visual, THEME_VISUAL_MAX)
        if (caption && visual) cells.push({ caption, visual })
      }
      if (cells.length !== THEME_CELL_COUNT) continue
      names.add(name)
      themes.push({ name, cells })
    }
    if (themes.length) groups.push({ label, themes })
  }
  return groups.length ? groups : null
}

/** Human-readable problems that would make the studio unusable. An empty array means the presets can be saved. */
export function themePresetIssues(groups: ThemePresetGroup[]): string[] {
  const issues: string[] = []
  if (groups.length === 0) issues.push('至少需要一个主题分类。')
  const seenLabels = new Set<string>()
  const seenNames = new Set<string>()
  let themeCount = 0
  groups.forEach((group, groupIndex) => {
    const label = group.label.trim()
    const position = `第 ${groupIndex + 1} 个分类`
    if (!label) issues.push(`${position}缺少名称。`)
    else if (seenLabels.has(label)) issues.push(`分类「${label}」重复。`)
    seenLabels.add(label)
    if (group.themes.length === 0) issues.push(`分类「${label || position}」下至少需要一个主题。`)
    for (const theme of group.themes) {
      themeCount += 1
      const name = theme.name.trim()
      if (!name) { issues.push(`分类「${label || position}」中有未命名的主题。`); continue }
      if (seenNames.has(name)) issues.push(`主题「${name}」重复；主题名称必须唯一。`)
      seenNames.add(name)
      if (theme.cells.length !== THEME_CELL_COUNT) { issues.push(`主题「${name}」必须正好有 ${THEME_CELL_COUNT} 格。`); continue }
      theme.cells.forEach((cell, index) => {
        if (!cell.caption.trim() || !cell.visual.trim()) issues.push(`主题「${name}」第 ${index + 1} 格的短句和画面描述都需要填写。`)
      })
    }
  })
  if (groups.length && themeCount === 0) issues.push('至少需要一个主题。')
  return issues
}

/** Copy of the 16 cells for a theme. Falls back to the built-in draft when the name is not configured. */
export function draftForTheme(groups: ThemePresetGroup[], name: string): DraftCell[] {
  for (const group of groups) {
    const theme = group.themes.find((item) => item.name === name)
    if (theme) return theme.cells.map((cell) => ({ caption: cell.caption, visual: cell.visual }))
  }
  return makeDraft(name)
}

export function themeNamesFor(groups: ThemePresetGroup[], label: string): string[] {
  return groups.find((group) => group.label === label)?.themes.map((theme) => theme.name) ?? []
}

/** Load the presets administrators have published. Any failure silently uses the built-in presets. */
export async function loadThemePresets(): Promise<ThemePresetGroup[]> {
  if (!supabase || !supabaseConfigured) return defaultThemePresetGroups()
  try {
    const { data, error } = await supabase.rpc('public_theme_presets')
    if (error) return defaultThemePresetGroups()
    return normalizeThemePresetGroups(data) ?? defaultThemePresetGroups()
  } catch {
    return defaultThemePresetGroups()
  }
}

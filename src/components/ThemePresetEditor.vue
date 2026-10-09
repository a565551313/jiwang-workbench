<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import { Plus, RefreshCw, Trash2 } from '@lucide/vue'
import { makeDraft } from '../lib/drafts'
import {
  defaultThemePresetGroups,
  THEME_CAPTION_MAX,
  THEME_LABEL_MAX,
  THEME_NAME_MAX,
  THEME_VISUAL_MAX,
  themePresetIssues,
  type ThemePreset,
  type ThemePresetGroup,
} from '../lib/themePresets'

/** Editing happens in place on the parent's settings object; the parent saves it with the rest of the content settings. */
const groups = defineModel<ThemePresetGroup[]>({ required: true })

const builtIns = new Map(defaultThemePresetGroups().flatMap((group) => group.themes).map((theme) => [theme.name, theme]))
const activeGroupIndex = ref(0)
/** Selected by object identity, so renaming a theme while typing does not move the selection. */
const selectedTheme = ref<ThemePreset | null>(null)

const activeGroup = computed(() => groups.value[Math.min(activeGroupIndex.value, groups.value.length - 1)])
const activeTheme = computed<ThemePreset | undefined>(() => {
  const themes = activeGroup.value?.themes ?? []
  return selectedTheme.value && themes.includes(selectedTheme.value) ? selectedTheme.value : themes[0]
})
const activeIsBuiltIn = computed(() => Boolean(activeTheme.value && builtIns.has(activeTheme.value.name)))
const issues = computed(() => themePresetIssues(groups.value))
const totalThemes = computed(() => groups.value.reduce((sum, group) => sum + group.themes.length, 0))

function allNames(): Set<string> {
  return new Set(groups.value.flatMap((group) => group.themes.map((theme) => theme.name)))
}

/** Pick a name such as "新主题 2" that nothing else uses. */
function uniqueName(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base
  for (let index = 2; ; index += 1) {
    const candidate = `${base} ${index}`
    if (!existing.has(candidate)) return candidate
  }
}

async function confirmAction(message: string, title: string, confirmText: string): Promise<boolean> {
  try {
    await ElMessageBox.confirm(message, title, { type: 'warning', confirmButtonText: confirmText, cancelButtonText: '取消' })
    return true
  } catch {
    return false
  }
}

function selectGroup(index: number) {
  activeGroupIndex.value = index
  selectedTheme.value = null
}

function newTheme(): ThemePreset {
  const name = uniqueName('新主题', allNames())
  return { name, cells: makeDraft(name).map((cell) => ({ ...cell })) }
}

function addGroup() {
  const label = uniqueName('新分类', new Set(groups.value.map((group) => group.label)))
  const theme = newTheme()
  groups.value.push({ label, themes: [theme] })
  activeGroupIndex.value = groups.value.length - 1
  selectedTheme.value = theme
}

async function removeGroup() {
  const group = activeGroup.value
  if (!group || groups.value.length <= 1) return
  const confirmed = await confirmAction(`删除分类「${group.label || '未命名'}」及其中 ${group.themes.length} 个主题？保存后前台将不再显示。`, '删除分类', '删除')
  if (!confirmed) return
  groups.value.splice(groups.value.indexOf(group), 1)
  selectGroup(Math.max(0, Math.min(activeGroupIndex.value, groups.value.length - 1)))
}

function addTheme() {
  const group = activeGroup.value
  if (!group) return
  const theme = newTheme()
  group.themes.push(theme)
  selectedTheme.value = theme
}

async function removeTheme() {
  const group = activeGroup.value
  const theme = activeTheme.value
  if (!group || !theme || totalThemes.value <= 1) return
  const confirmed = await confirmAction(`删除主题「${theme.name || '未命名'}」？保存后前台将不再显示。`, '删除主题', '删除')
  if (!confirmed) return
  group.themes.splice(group.themes.indexOf(theme), 1)
  selectedTheme.value = null
}

/** Restore a built-in theme's 16 cells. Only offered for names that exist in the built-in presets. */
async function resetTheme() {
  const theme = activeTheme.value
  const builtIn = theme ? builtIns.get(theme.name) : undefined
  if (!theme || !builtIn) return
  const confirmed = await confirmAction(`把「${theme.name}」的 16 格文字和画面描述恢复为内置草案？未保存的修改会丢失。`, '恢复内置草案', '恢复')
  if (confirmed) theme.cells = builtIn.cells.map((cell) => ({ ...cell }))
}
</script>

<template>
  <div class="theme-editor">
    <el-alert v-if="issues.length" class="theme-editor-issues" type="warning" :closable="false" show-icon>
      <template #title>保存前请修正以下问题</template>
      <div v-for="issue in issues" :key="issue">{{ issue }}</div>
    </el-alert>

    <div class="theme-editor-group-row">
      <div class="theme-editor-tabs" role="tablist" aria-label="主题分类">
        <button
          v-for="(group, index) in groups"
          :key="index"
          type="button"
          role="tab"
          :aria-selected="index === activeGroupIndex"
          :class="{ active: index === activeGroupIndex }"
          @click="selectGroup(index)"
        >{{ group.label || '未命名分类' }}</button>
        <button type="button" class="theme-editor-add" @click="addGroup"><Plus :size="13" />新增分类</button>
      </div>
      <button v-if="activeGroup" type="button" class="theme-editor-danger" :disabled="groups.length <= 1" :title="groups.length <= 1 ? '至少保留一个分类' : '删除当前分类'" @click="removeGroup"><Trash2 :size="13" />删除分类</button>
    </div>

    <template v-if="activeGroup">
      <div class="theme-editor-field">
        <label class="admin-field-label" for="theme-group-label">分类名称</label>
        <el-input id="theme-group-label" v-model="activeGroup.label" :maxlength="THEME_LABEL_MAX" show-word-limit placeholder="例如：日常聊天" />
      </div>

      <div class="theme-editor-chips">
        <button
          v-for="theme in activeGroup.themes"
          :key="theme.name"
          type="button"
          class="theme-editor-chip"
          :class="{ active: theme === activeTheme }"
          @click="selectedTheme = theme"
        >{{ theme.name || '未命名主题' }}</button>
        <button type="button" class="theme-editor-add" @click="addTheme"><Plus :size="13" />新增主题</button>
      </div>
    </template>

    <template v-if="activeTheme">
      <div class="theme-editor-theme-head">
        <div class="theme-editor-field">
          <label class="admin-field-label" for="theme-name">主题名称（前台显示，全站唯一）</label>
          <el-input id="theme-name" v-model="activeTheme.name" :maxlength="THEME_NAME_MAX" show-word-limit placeholder="例如：收到回复" />
        </div>
        <div class="theme-editor-theme-actions">
          <button v-if="activeIsBuiltIn" type="button" class="theme-editor-quiet" @click="resetTheme"><RefreshCw :size="13" />恢复内置草案</button>
          <button type="button" class="theme-editor-danger" :disabled="totalThemes <= 1" :title="totalThemes <= 1 ? '至少保留一个主题' : '删除当前主题'" @click="removeTheme"><Trash2 :size="13" />删除主题</button>
        </div>
      </div>

      <div class="theme-editor-cells">
        <div class="theme-editor-cell-header"><span>#</span><span>短句（≤{{ THEME_CAPTION_MAX }} 字）</span><span>画面描述（≤{{ THEME_VISUAL_MAX }} 字）</span></div>
        <div v-for="(cell, index) in activeTheme.cells" :key="index" class="theme-editor-cell-row">
          <span class="theme-editor-cell-index">{{ String(index + 1).padStart(2, '0') }}</span>
          <el-input v-model="cell.caption" :maxlength="THEME_CAPTION_MAX" placeholder="短句" />
          <el-input v-model="cell.visual" :maxlength="THEME_VISUAL_MAX" placeholder="画面描述" />
        </div>
      </div>
    </template>
  </div>
</template>

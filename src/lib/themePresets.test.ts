import { beforeEach, describe, expect, it, vi } from 'vitest'

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))

vi.mock('./supabase', () => ({
  supabase: { rpc },
  supabaseConfigured: true,
}))

import { themeGroups } from './drafts'
import {
  defaultThemePresetGroups,
  draftForTheme,
  loadThemePresets,
  normalizeThemePresetGroups,
  THEME_CELL_COUNT,
  themeNamesFor,
  themePresetIssues,
  type ThemePresetGroup,
} from './themePresets'

function cells(prefix = 'c') {
  return Array.from({ length: THEME_CELL_COUNT }, (_, index) => ({ caption: `${prefix}${index + 1}`, visual: `画面 ${index + 1}` }))
}

function sampleGroups(): ThemePresetGroup[] {
  return [
    { label: '推荐', themes: [{ name: '日常精选', cells: cells('a') }, { name: '晚安', cells: cells('b') }] },
    { label: '节日', themes: [{ name: '新年快乐', cells: cells('n') }] },
  ]
}

describe('内置默认主题', () => {
  it('与原先的内置分类和主题名称一致，且每个主题都是 16 格', () => {
    const defaults = defaultThemePresetGroups()
    expect(defaults.map((group) => group.label)).toEqual(themeGroups.map((group) => group.label))
    for (const group of defaults) {
      expect(group.themes.map((theme) => theme.name)).toEqual(themeGroups.find((item) => item.label === group.label)!.themes)
      for (const theme of group.themes) expect(theme.cells).toHaveLength(THEME_CELL_COUNT)
    }
  })

  it('默认预设通过校验，可直接作为后台初始内容', () => {
    expect(themePresetIssues(defaultThemePresetGroups())).toEqual([])
  })
})

describe('normalizeThemePresetGroups', () => {
  it('非数组或没有可用内容时返回 null，调用方会回退到内置预设', () => {
    expect(normalizeThemePresetGroups(null)).toBeNull()
    expect(normalizeThemePresetGroups({})).toBeNull()
    expect(normalizeThemePresetGroups([])).toBeNull()
    expect(normalizeThemePresetGroups([{ label: '', themes: [] }])).toBeNull()
  })

  it('去掉首尾空白并截断超长文字', () => {
    const [group] = normalizeThemePresetGroups([{
      label: '  超长分类名称  ',
      themes: [{ name: '  主题名称很长很长很长  ', cells: cells('x').map((cell) => ({ caption: `  ${cell.caption}  `, visual: 'v'.repeat(500) })) }],
    }])!
    expect(group.label).toBe('超长分类名称'.slice(0, 8))
    expect(group.themes[0]!.name).toBe('主题名称很长很长很长'.slice(0, 12))
    expect(group.themes[0]!.cells[0]!.visual).toHaveLength(200)
    expect(group.themes[0]!.cells[0]!.caption).toBe('x1')
  })

  it('丢弃格数不足、名称重复或字段缺失的主题', () => {
    const result = normalizeThemePresetGroups([{
      label: '测试',
      themes: [
        { name: '完整', cells: cells() },
        { name: '完整', cells: cells() },
        { name: '少一格', cells: cells().slice(1) },
        { name: '空字段', cells: [{ caption: '', visual: 'x' }, ...cells().slice(1)] },
        'not-an-object',
      ],
    }])
    expect(result!.map((group) => group.themes.map((theme) => theme.name))).toEqual([['完整']])
  })
})

describe('themePresetIssues', () => {
  it('列出会导致前台无法使用的问题', () => {
    const issues = themePresetIssues([
      { label: '', themes: [] },
      { label: '重复', themes: [{ name: '甲', cells: cells() }] },
      { label: '重复', themes: [{ name: '甲', cells: cells().slice(0, 3) }] },
    ])
    expect(issues).toContain('第 1 个分类缺少名称。')
    expect(issues).toContain('分类「第 1 个分类」下至少需要一个主题。')
    expect(issues).toContain('分类「重复」重复。')
    expect(issues).toContain('主题「甲」重复；主题名称必须唯一。')
    expect(issues).toContain('主题「甲」必须正好有 16 格。')
  })

  it('检查每格的短句与画面描述是否都已填写', () => {
    const groups = sampleGroups()
    groups[0]!.themes[0]!.cells[4] = { caption: '  ', visual: '有画面' }
    expect(themePresetIssues(groups)).toEqual(['主题「日常精选」第 5 格的短句和画面描述都需要填写。'])
  })

  it('完整的分组没有问题', () => {
    expect(themePresetIssues(sampleGroups())).toEqual([])
  })
})

describe('draftForTheme 与分类查询', () => {
  it('返回副本，编辑草案不会改动预设本身', () => {
    const groups = sampleGroups()
    const draft = draftForTheme(groups, '日常精选')
    draft[0]!.caption = '被修改'
    expect(groups[0]!.themes[0]!.cells[0]!.caption).toBe('a1')
  })

  it('未配置的主题名称沿用内置草案', () => {
    const draft = draftForTheme(sampleGroups(), '自定义主题')
    expect(draft).toHaveLength(16)
    expect(draft[0]!.caption).toBe('早上好')
  })

  it('按分类列出主题名称', () => {
    expect(themeNamesFor(sampleGroups(), '推荐')).toEqual(['日常精选', '晚安'])
    expect(themeNamesFor(sampleGroups(), '不存在')).toEqual([])
  })
})

describe('loadThemePresets', () => {
  beforeEach(() => rpc.mockReset())

  it('读取后台发布的预设', async () => {
    rpc.mockResolvedValueOnce({ data: sampleGroups(), error: null })
    await expect(loadThemePresets()).resolves.toEqual(sampleGroups())
    expect(rpc).toHaveBeenCalledWith('public_theme_presets')
  })

  it('后台尚未保存过预设（返回 null）时使用内置预设', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: null })
    await expect(loadThemePresets()).resolves.toEqual(defaultThemePresetGroups())
  })

  it('读取失败或抛错时静默回退到内置预设', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'network' } })
    await expect(loadThemePresets()).resolves.toEqual(defaultThemePresetGroups())
    rpc.mockRejectedValueOnce(new Error('boom'))
    await expect(loadThemePresets()).resolves.toEqual(defaultThemePresetGroups())
  })
})

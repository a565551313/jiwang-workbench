import { describe, expect, it } from 'vitest'
import { makeDraft, themeGroups, titleForTopic } from './drafts'

describe('16 格创作草案', () => {
  it('预设主题始终补齐 16 个有文字和画面描述的格子', () => {
    for (const group of themeGroups) {
      for (const theme of group.themes) {
        const cells = makeDraft(theme)
        expect(cells).toHaveLength(16)
        expect(cells.every((cell) => cell.caption.length > 0 && cell.visual.length > 0)).toBe(true)
      }
    }
  })

  it('对未知主题提供稳定的默认草案', () => {
    expect(makeDraft('自定义主题')).toHaveLength(16)
    expect(makeDraft('自定义主题')[0].caption).toBe('早上好')
  })

  it('主题标题支持空输入回退并限制过长标题', () => {
    expect(titleForTopic('', '日常精选')).toBe('日常精选 · 日常表情')
    expect(titleForTopic('下班后的小狗', '日常精选')).toBe('下班后的小狗')
    expect(titleForTopic('一段很长很长的主题描述标题超过二十个中文字', '日常精选')).toHaveLength(21)
  })
})

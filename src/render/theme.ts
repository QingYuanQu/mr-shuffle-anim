/** 全局配色与排版令牌。浅色主题，画布与 SVG 共用同一套。 */

export interface Ramp {
  bg: string
  mid: string
  stroke: string
  text: string
}

const r = (
  bg: string,
  mid: string,
  stroke: string,
  text: string,
): Ramp => ({ bg, mid, stroke, text })

export const C = {
  bg: '#FFFFFF',
  panel: '#F1EFE8',
  panelSoft: '#FAFAF8',

  ink: '#2C2C2A',
  inkMuted: '#5F5E5A',
  inkFaint: '#888780',

  line: '#B4B2A9',
  lineSoft: '#D3D1C7',
  lineFaint: '#E8E6DE',

  blue: r('#E6F1FB', '#85B7EB', '#185FA5', '#0C447C'),
  teal: r('#E1F5EE', '#5DCAA5', '#0F6E56', '#085041'),
  amber: r('#FAEEDA', '#EF9F27', '#854F0B', '#633806'),
  purple: r('#EEEDFE', '#AFA9EC', '#534AB7', '#3C3489'),
  coral: r('#FAECE7', '#F0997B', '#993C1D', '#712B13'),
  pink: r('#FBEAF0', '#ED93B1', '#993556', '#72243E'),
  green: r('#EAF3DE', '#97C459', '#3B6D11', '#27500A'),
  red: r('#FCEBEB', '#F09595', '#A32D2D', '#791F1F'),
  gray: r('#F1EFE8', '#B4B2A9', '#5F5E5A', '#2C2C2A'),
} as const

export type RampName = 'blue' | 'teal' | 'amber' | 'purple' | 'coral' | 'pink' | 'green' | 'red' | 'gray'

export const FONT_SANS =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif'
export const FONT_MONO =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'

/** 分区色板：分区的颜色是全片最重要的视觉约定 —— 颜色 = 目标 reducer */
export const PARTITION_RAMPS: RampName[] = ['blue', 'amber', 'teal', 'purple', 'coral']

export function partitionRamp(p: number): RampName {
  return PARTITION_RAMPS[p % PARTITION_RAMPS.length]
}

export function ramp(name: RampName): Ramp {
  return C[name]
}

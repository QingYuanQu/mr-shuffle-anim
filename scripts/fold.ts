/**
 * 侧栏折叠功能验证。
 * 用法：npx tsx scripts/fold.ts
 */
import { chromium } from 'playwright'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const URL = 'http://localhost:4180/'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? '  ' + detail : ''}`)
  else {
    failures++
    console.log(`  \x1b[31m✗ ${name}\x1b[0m  ${detail}`)
  }
}

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-gpu-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

const errors: string[] = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text())
})

await page.goto(URL, { waitUntil: 'networkidle' })
await page.waitForTimeout(600)
await page.evaluate(() => {
  const b = document.querySelector('.play-btn') as HTMLButtonElement
  b?.click()
})

console.log('\n\x1b[1m侧栏折叠验证\x1b[0m')

const sideVisible = () =>
  page.evaluate(() => {
    const s = document.querySelector('.side') as HTMLElement | null
    if (!s) return false
    return getComputedStyle(s).display !== 'none'
  })

const stageWidth = () =>
  page.evaluate(() => {
    const s = document.querySelector('.stage') as HTMLElement
    return Math.round(s.getBoundingClientRect().width)
  })

// 1. 初始侧栏可见
check('初始状态侧栏可见', await sideVisible())

const w1 = await stageWidth()

// 2. 点击折叠按钮
await page.click('.fold-btn')
await page.waitForTimeout(500)
check('点击后侧栏隐藏', !(await sideVisible()))

const w2 = await stageWidth()
check('演示区变宽', w2 > w1, `${w1}px → ${w2}px (+${w2 - w1})`)

// 3. 折叠后出现讲解横条
const bar = await page.evaluate(() => {
  const f = document.querySelector('.narrate-bar')
  if (!f) return null
  const r = f.getBoundingClientRect()
  const stage = document.querySelector('.stage')!.getBoundingClientRect()
  return {
    title: f.querySelector('.narrate-bar-title')?.textContent ?? '',
    text: (f.querySelector('.narrate-bar-text')?.textContent ?? '').slice(0, 20),
    visible: r.width > 0 && r.height > 0,
    // 横条必须在画布下方，不与画布重叠
    belowStage: r.top >= stage.bottom - 1,
  }
})
check('折叠后显示讲解横条', bar !== null && bar.visible, bar?.title ?? '未出现')
check('横条不遮挡画布区域', bar?.belowStage === true)
check('横条含讲解正文', (bar?.text.length ?? 0) > 5, bar?.text ?? '')

// 4. Canvas 尺寸随折叠同步（ResizeObserver 是否生效）
const canvasInfo = await page.evaluate(() => {
  const c = document.querySelector('canvas') as HTMLCanvasElement
  const r = c.getBoundingClientRect()
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  return {
    cssW: Math.round(r.width),
    cssH: Math.round(r.height),
    attrW: c.width,
    attrH: c.height,
    expectW: Math.round(r.width * dpr),
    expectH: Math.round(r.height * dpr),
  }
})
check(
  'Canvas 像素尺寸与 CSS 尺寸同步',
  Math.abs(canvasInfo.attrW - canvasInfo.expectW) <= 2 &&
    Math.abs(canvasInfo.attrH - canvasInfo.expectH) <= 2,
  `CSS ${canvasInfo.cssW}×${canvasInfo.cssH} / attr ${canvasInfo.attrW}×${canvasInfo.attrH} / 期望 ${canvasInfo.expectW}×${canvasInfo.expectH}`,
)

// 5. 折叠后画面确实重绘了（不是空白）
const painted = await page.evaluate(() => {
  const c = document.querySelector('canvas') as HTMLCanvasElement
  const ctx = c.getContext('2d')!
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  let nonEmpty = 0
  for (let i = 3; i < d.length; i += 400) if (d[i] > 0) nonEmpty++
  return nonEmpty
})
check('折叠后画面正常绘制', painted > 50, `${painted} 个采样点有内容`)

// 6. 快捷键 D 切换
await page.keyboard.press('d')
await page.waitForTimeout(400)
check('快捷键 D 可重新展开侧栏', await sideVisible())

const w3 = await stageWidth()
check('展开后演示区恢复原宽', Math.abs(w3 - w1) <= 2, `${w3}px vs ${w1}px`)

// 7. 输入框内按 D 不应触发折叠
{
  // 先确保处于"已折叠"状态
  if (await sideVisible()) {
    await page.click('.fold-btn')
    await page.waitForTimeout(300)
  }
  const before = await sideVisible()
  // 用键盘 Tab 无法可靠聚焦 range input，直接派发到 input 元素上
  await page.evaluate(() => {
    const r = document.querySelectorAll<HTMLInputElement>('.ctrl input[type=range]')[0]
    r?.focus()
    r?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'd', bubbles: true }),
    )
  })
  await page.waitForTimeout(300)
  check(
    '输入框聚焦时 D 不触发折叠',
    before === false && (await sideVisible()) === false,
    `折叠前可见=${before}`,
  )
}

// 8. 折叠状态下时间轴仍可用，且浮层同步更新
{
  if (await sideVisible()) {
    await page.click('.fold-btn')
    await page.waitForTimeout(300)
  }
  const beforeTitle = await page.evaluate(
    () => document.querySelector('.narrate-bar-title')?.textContent ?? '',
  )
  await page.evaluate(() => {
    const track = document.querySelector('input.track') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!
    setter.call(track, track.max)
    track.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.waitForTimeout(400)
  const afterTitle = await page.evaluate(
    () => document.querySelector('.narrate-bar-title')?.textContent ?? '',
  )
  check(
    '折叠状态下时间轴可拖拽且浮层同步',
    afterTitle.length > 0 && afterTitle !== beforeTitle,
    `${beforeTitle} → ${afterTitle}`,
  )
}

if (errors.length) {
  console.log('\n\x1b[31m运行时错误：\x1b[0m')
  for (const e of errors.slice(0, 8)) console.log('  ' + e)
  failures += errors.length
}

console.log(
  failures === 0 ? '\n\x1b[32m折叠验证全部通过\x1b[0m\n' : `\n\x1b[31m${failures} 项失败\x1b[0m\n`,
)
await browser.close()
process.exit(failures === 0 ? 0 : 1)

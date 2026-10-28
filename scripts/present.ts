/**
 * 演示模式验证。
 * 用法：npx tsx scripts/present.ts
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const URL = 'http://localhost:4180/'
const OUT = 'shots'

mkdirSync(OUT, { recursive: true })

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
  ;(document.querySelector('.play-btn') as HTMLButtonElement)?.click()
})

console.log('\n\x1b[1m演示模式验证\x1b[0m')

const visible = (sel: string) =>
  page.evaluate((s) => {
    const el = document.querySelector(s) as HTMLElement | null
    if (!el) return false
    const st = getComputedStyle(el)
    return st.display !== 'none' && st.visibility !== 'hidden'
  }, sel)

const stageBox = () =>
  page.evaluate(() => {
    const r = document.querySelector('.stage')!.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height) }
  })

// 1. 初始状态所有界面元素可见
check('初始顶栏可见', await visible('.topbar'))
check('初始侧栏可见', await visible('.side'))

const before = await stageBox()

// 2. 进入演示模式
await page.click('.present-btn')
await page.waitForTimeout(600)

check('演示模式隐藏顶栏', !(await visible('.topbar')))
check('演示模式隐藏侧栏', !(await visible('.side')))
check('演示模式隐藏底部图例', !(await visible('.legend')))
check('演示模式隐藏常规时间轴', !(await visible('.timeline')))
check('演示模式显示悬浮控制条', await visible('.present-hud'))

// 3. 演示区铺满视口
const after = await stageBox()
const vp = page.viewportSize()!
check(
  '演示区占满视口宽度',
  after.w >= vp.width - 2,
  `${before.w}px → ${after.w}px（视口 ${vp.width}px）`,
)
check(
  '演示区占满视口高度',
  after.h >= vp.height - 2,
  `${before.h}px → ${after.h}px（视口 ${vp.height}px）`,
)

// 4. 控制条悬浮在画面底部，不遮挡主体
const hudPos = await page.evaluate(() => {
  const bar = document.querySelector('.hud-bar')!.getBoundingClientRect()
  const stage = document.querySelector('.stage')!.getBoundingClientRect()
  return {
    barBottom: Math.round(bar.bottom),
    stageBottom: Math.round(stage.bottom),
    barTop: Math.round(bar.top),
    barHeight: Math.round(bar.height),
    stageHeight: Math.round(stage.height),
  }
})
check(
  '控制条位于画面底部',
  hudPos.barBottom <= hudPos.stageBottom + 1,
  `控制条底 ${hudPos.barBottom} / 画面底 ${hudPos.stageBottom}`,
)
check(
  '控制条高度合理（不遮挡主体）',
  hudPos.barHeight < hudPos.stageHeight * 0.2,
  `控制条高 ${hudPos.barHeight}px / 画面高 ${hudPos.stageHeight}px`,
)

// 5. 画面正常绘制
const painted = await page.evaluate(() => {
  const c = document.querySelector('canvas') as HTMLCanvasElement
  const ctx = c.getContext('2d')!
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  let n = 0
  for (let i = 3; i < d.length; i += 400) if (d[i] > 0) n++
  return n
})
check('演示模式画面正常绘制', painted > 50, `${painted} 个采样点`)

// 6. 鼠标静止后控制条自动隐藏
await page.mouse.move(700, 400)
await page.waitForTimeout(200)
const visibleBefore = await page.evaluate(
  () => getComputedStyle(document.querySelector('.present-hud')!).opacity,
)
await page.waitForTimeout(3200)
const visibleAfter = await page.evaluate(
  () => getComputedStyle(document.querySelector('.present-hud')!).opacity,
)
check(
  '鼠标静止后控制条自动隐藏',
  Number(visibleAfter) < Number(visibleBefore),
  `opacity ${visibleBefore} → ${visibleAfter}`,
)

// 7. 移动鼠标后控制条恢复（CSS 过渡 0.45s，需留足时间）
await page.mouse.move(720, 420)
await page.waitForTimeout(700)
const restored = await page.evaluate(
  () => getComputedStyle(document.querySelector('.present-hud')!).opacity,
)
check('移动鼠标后控制条恢复', Number(restored) > 0.9, `opacity ${restored}`)

// 8. 演示模式内时间轴可拖拽
await page.evaluate(() => {
  const track = document.querySelector('.present-hud input.track') as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )!.set!
  setter.call(track, track.max)
  track.dispatchEvent(new Event('input', { bubbles: true }))
})
await page.waitForTimeout(400)
const beatTitle = await page.evaluate(
  () => document.querySelector('.hud-beat-title')?.textContent ?? '',
)
check('演示模式内时间轴可拖拽', beatTitle.length > 0, beatTitle)

// 9. Space 键播放/暂停
// 注意：需在动画播放中测。若时间轴已到末尾，按 Space 播放会立即结束，观测不到变化。
{
  await page.evaluate(() => {
    const track = document.querySelector('.present-hud input.track') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!
    setter.call(track, String(Number(track.min) + (Number(track.max) - Number(track.min)) * 0.1))
    track.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.waitForTimeout(300)
  await page.evaluate(() => {
    ;(document.querySelector('.present-hud .play-btn') as HTMLButtonElement)?.blur()
  })
  await page.waitForTimeout(200)
  const playing1 = await page.evaluate(
    () => document.querySelector('.present-hud .play-btn')?.getAttribute('aria-label'),
  )
  await page.keyboard.press('Space')
  await page.waitForTimeout(300)
  const playing2 = await page.evaluate(
    () => document.querySelector('.present-hud .play-btn')?.getAttribute('aria-label'),
  )
  check('演示模式内 Space 可播放/暂停', playing1 !== playing2, `${playing1} → ${playing2}`)
}

// 10. F 键切换演示模式
await page.keyboard.press('f')
await page.waitForTimeout(500)
check('F 键可退出演示模式', await visible('.topbar'))

await page.keyboard.press('f')
await page.waitForTimeout(500)
check('F 键可再次进入演示模式', !(await visible('.topbar')))

// 11. Esc 退出演示模式
await page.keyboard.press('Escape')
await page.waitForTimeout(500)
check('Esc 可退出演示模式', await visible('.topbar'))
check('退出后侧栏恢复', await visible('.side'))

// 12. 退出后布局复原
const restored2 = await stageBox()
check(
  '退出演示模式后布局复原',
  Math.abs(restored2.w - before.w) <= 2,
  `${restored2.w}px vs ${before.w}px`,
)

// 13. 演示模式截图
await page.keyboard.press('f')
await page.waitForTimeout(600)
await page.mouse.move(700, 300)
await page.waitForTimeout(300)
await page.screenshot({ path: `${OUT}/p1-present-overview.png` })
console.log('  ✓ p1-present-overview.png')

await page.evaluate(() => {
  const track = document.querySelector('.present-hud input.track') as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )!.set!
  setter.call(track, String(Number(track.min) + (Number(track.max) - Number(track.min)) * 0.26))
  track.dispatchEvent(new Event('input', { bubbles: true }))
})
await page.waitForTimeout(400)
await page.mouse.move(700, 300)
await page.waitForTimeout(200)
await page.screenshot({ path: `${OUT}/p2-present-map.png` })
console.log('  ✓ p2-present-map.png')

await page.keyboard.press('Escape')
await page.waitForTimeout(500)

if (errors.length) {
  console.log('\n\x1b[31m运行时错误：\x1b[0m')
  for (const e of errors.slice(0, 8)) console.log('  ' + e)
  failures += errors.length
}

console.log(
  failures === 0 ? '\n\x1b[32m演示模式验证全部通过\x1b[0m\n' : `\n\x1b[31m${failures} 项失败\x1b[0m\n`,
)
await browser.close()
process.exit(failures === 0 ? 0 : 1)

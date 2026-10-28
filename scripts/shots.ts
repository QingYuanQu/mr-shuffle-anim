/**
 * 截图脚本：用系统已安装的 Chrome 渲染动画，验证各阶段视觉效果。
 * 用法：npx tsx scripts/shots.ts
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const URL = 'http://localhost:4180/'
const OUT = 'shots'

mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-gpu-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

const errors: string[] = []
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
page.on('pageerror', (e) => errors.push(String(e)))

await page.goto(URL, { waitUntil: 'networkidle' })
await page.waitForTimeout(600)

// 暂停自动播放，改由脚本精确控制时间点
await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('button'))
  const pause = btns.find((b) => b.getAttribute('aria-label') === '暂停')
  pause?.click()
})

/** 拖动时间轴到指定比例 */
async function seekTo(ratio: number) {
  await page.evaluate((r) => {
    const track = document.querySelector('input.track') as HTMLInputElement
    const max = Number(track.max)
    const min = Number(track.min)
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!
    setter.call(track, String(min + (max - min) * r))
    track.dispatchEvent(new Event('input', { bubbles: true }))
    track.dispatchEvent(new Event('change', { bubbles: true }))
  }, ratio)
  await page.waitForTimeout(320)
}

/** 切换视图模式（手动点击会关闭自动镜头） */
async function setMode(label: string) {
  await page.evaluate((l) => {
    const b = Array.from(document.querySelectorAll('.modes button')).find(
      (x) => x.textContent?.trim() === l,
    ) as HTMLButtonElement | undefined
    b?.click()
  }, label)
  await page.waitForTimeout(280)
}

/** 切回自动镜头 */
async function setAutoCam() {
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.modes button')).find(
      (x) => x.textContent?.trim() === '自动镜头',
    ) as HTMLButtonElement | undefined
    b?.click()
  })
  await page.waitForTimeout(280)
}

const shots: [string, number, string][] = [
  ['01-overview-early', 0.08, '全局拓扑'],
  ['02-overview-spill', 0.2, '全局拓扑'],
  ['03-overview-fetch', 0.55, '全局拓扑'],
  ['04-overview-merge', 0.72, '全局拓扑'],
  ['05-overview-done', 0.97, '全局拓扑'],
  ['06-map-focus', 0.2, 'Map 端特写'],
  ['07-map-focus-late', 0.45, 'Map 端特写'],
  ['08-reduce-focus', 0.75, 'Reduce 端特写'],
  ['09-reduce-focus-done', 0.96, 'Reduce 端特写'],
]

for (const [name, ratio, modeLabel] of shots) {
  await seekTo(ratio)
  await setMode(modeLabel)
  await page.waitForTimeout(220)
  await page.screenshot({ path: `${OUT}/${name}.png` })
  console.log(`  ✓ ${name}.png`)
}

// 自动镜头模式下的跟随效果
await setAutoCam()
await seekTo(0.22)
await page.waitForTimeout(300)
await page.screenshot({ path: `${OUT}/11-autocam-map.png` })
console.log('  ✓ 11-autocam-map.png')

await seekTo(0.78)
await page.waitForTimeout(300)
await page.screenshot({ path: `${OUT}/12-autocam-reduce.png` })
console.log('  ✓ 12-autocam-reduce.png')

// 面板与整体布局
await page.screenshot({ path: `${OUT}/10-full-page.png`, fullPage: true })
console.log('  ✓ 10-full-page.png')

// 抓取关键 DOM 状态，验证数据一致性
const info = await page.evaluate(() => {
  const nums = Array.from(document.querySelectorAll('.metric-value')).map((e) => ({
    label: e.previousElementSibling?.textContent,
    value: e.textContent,
  }))
  const beat = document.querySelector('.narrate-text')?.textContent
  const title = document.querySelector('.panel-head h2')?.textContent
  return { nums, beat, title }
})

console.log('\n面板读数：')
for (const n of info.nums) console.log(`  ${n.label}: ${n.value}`)
console.log(`当前节拍: ${info.title}`)
console.log(`讲解: ${info.beat?.slice(0, 60)}...`)

if (errors.length) {
  console.log('\n\x1b[31m控制台错误：\x1b[0m')
  for (const e of errors.slice(0, 10)) console.log('  ' + e)
} else {
  console.log('\n\x1b[32m无控制台错误\x1b[0m')
}

await browser.close()

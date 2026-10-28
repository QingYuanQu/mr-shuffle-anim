/**
 * 折叠状态下的截图，用于视觉核对。
 * 用法：npx tsx scripts/shots-fold.ts
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

await page.goto(URL, { waitUntil: 'networkidle' })
await page.waitForTimeout(600)
await page.evaluate(() => {
  ;(document.querySelector('.play-btn') as HTMLButtonElement)?.click()
})

async function seekTo(ratio: number) {
  await page.evaluate((r) => {
    const track = document.querySelector('input.track') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!
    setter.call(track, String(Number(track.min) + (Number(track.max) - Number(track.min)) * r))
    track.dispatchEvent(new Event('input', { bubbles: true }))
  }, ratio)
  await page.waitForTimeout(300)
}

async function setMode(label: string) {
  await page.evaluate((l) => {
    const b = Array.from(document.querySelectorAll('.modes button')).find(
      (x) => x.textContent?.trim() === l,
    ) as HTMLButtonElement | undefined
    b?.click()
  }, label)
  await page.waitForTimeout(250)
}

// 先折叠侧栏，再逐个镜头截图
await page.evaluate(() => {
  ;(document.querySelector('.fold-btn') as HTMLButtonElement)?.click()
})
await page.waitForTimeout(400)

const collapsed = await page.evaluate(() => {
  const s = document.querySelector('.side') as HTMLElement | null
  return !s || getComputedStyle(s).display === 'none'
})
if (!collapsed) throw new Error('侧栏未能折叠，截图无意义')

const shots: [string, number, string][] = [
  ['f1-fold-overview', 0.55, '全局拓扑'],
  ['f2-fold-map', 0.24, 'Map 端特写'],
  ['f3-fold-reduce', 0.8, 'Reduce 端特写'],
]

for (const [name, ratio, mode] of shots) {
  await seekTo(ratio)
  await setMode(mode)
  await page.waitForTimeout(250)
  await page.screenshot({ path: `${OUT}/${name}.png` })
  console.log(`  ✓ ${name}.png`)
}

// 展开态对比
await page.evaluate(() => {
  ;(document.querySelector('.fold-btn') as HTMLButtonElement)?.click()
})
await page.waitForTimeout(400)
await seekTo(0.55)
await setMode('全局拓扑')
await page.screenshot({ path: `${OUT}/f4-open-overview.png` })
console.log('  ✓ f4-open-overview.png')

await browser.close()

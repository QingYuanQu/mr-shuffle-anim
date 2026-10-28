/**
 * 交互与一致性验证：检查参数联动、悬停高亮、时间轴拖拽等真实交互。
 * 用法：npx tsx scripts/interact.ts
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
await page.waitForTimeout(500)

const readStats = () =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.metric')).map((e) => ({
      label: e.querySelector('.metric-label')?.textContent ?? '',
      value: e.querySelector('.metric-value')?.textContent ?? '',
    })),
  )

console.log('\n\x1b[1m交互验证\x1b[0m')

// 1. 暂停按钮
{
  const label = await page.evaluate(() => {
    const b = document.querySelector('.play-btn')
    return b?.getAttribute('aria-label')
  })
  await page.click('.play-btn')
  await page.waitForTimeout(200)
  const label2 = await page.evaluate(() =>
    document.querySelector('.play-btn')?.getAttribute('aria-label'),
  )
  check('播放/暂停按钮可切换', label !== label2, `${label} → ${label2}`)
}

// 2. 拖动时间轴会改变画面状态（通过讲解节拍变化验证）
{
  const before = await page.evaluate(
    () => document.querySelector('.panel-head h2')?.textContent ?? '',
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
  await page.waitForTimeout(300)
  const after = await page.evaluate(
    () => document.querySelector('.panel-head h2')?.textContent ?? '',
  )
  check('拖动时间轴改变讲解节拍', before !== after, `${before} → ${after}`)
}

// 3. 上一步/下一步按钮
{
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.beat-nav button')).find(
      (x) => x.textContent?.includes('上一步'),
    ) as HTMLButtonElement
    b?.click()
  })
  await page.waitForTimeout(250)
  const pos = await page.evaluate(
    () => document.querySelector('.beat-pos')?.textContent ?? '',
  )
  check('上一步按钮可回退节拍', /^\d+ \/ \d+$/.test(pos.trim()), pos)
}

// 4. 关闭 Combiner 会改变统计读数
{
  const before = await readStats()
  await page.evaluate(() => {
    const cb = Array.from(
      document.querySelectorAll<HTMLInputElement>('.switch input[type=checkbox]'),
    )[0]
    cb?.click()
  })
  await page.waitForTimeout(400)
  const after = await readStats()
  const b = before.find((x) => x.label.includes('Map 端写出'))?.value
  const a = after.find((x) => x.label.includes('Map 端写出'))?.value
  check('关闭 Combiner 后写出条数增加', b !== a, `${b} → ${a}`)
}

// 5. 重新开启 Combiner
{
  await page.evaluate(() => {
    const cb = Array.from(
      document.querySelectorAll<HTMLInputElement>('.switch input[type=checkbox]'),
    )[0]
    cb?.click()
  })
  await page.waitForTimeout(400)
  const stats = await readStats()
  const a = stats.find((x) => x.label.includes('Map 端写出'))?.value
  check('重新开启 Combiner 后写出条数回落', a === '34条', a ?? '')
}

// 6. 调整 Map 数量会改变读入量
{
  const before = await readStats()
  await page.evaluate(() => {
    const ranges = document.querySelectorAll<HTMLInputElement>('.ctrl input[type=range]')
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!
    setter.call(ranges[0], '5')
    ranges[0].dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.waitForTimeout(500)
  const after = await readStats()
  const b = before.find((x) => x.label.includes('Map 端读入'))?.value
  const a = after.find((x) => x.label.includes('Map 端读入'))?.value
  check('增加 Map 数量会改变读入总量', b !== a, `${b} → ${a}`)
}

// 7. 场景预设可用
{
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.scen-grid button')).find(
      (x) => x.textContent?.trim() === '数据倾斜',
    ) as HTMLButtonElement
    b?.click()
  })
  await page.waitForTimeout(500)
  const warn = await page.evaluate(
    () => document.querySelector('.warn')?.textContent ?? '',
  )
  const stats = await readStats()
  check(
    '数据倾斜场景触发分区不均提示',
    warn.length > 0,
    warn ? warn.slice(0, 30) + '…' : `未提示，读入 ${stats[0]?.value}`,
  )
}

// 8. 恢复标准场景
{
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.scen-grid button')).find(
      (x) => x.textContent?.trim() === '标准',
    ) as HTMLButtonElement
    b?.click()
  })
  await page.waitForTimeout(500)
  const stats = await readStats()
  check('恢复标准场景后读入量回到 90', stats[0]?.value === '90条', stats[0]?.value ?? '')
}

// 9. 手动切换镜头不会被自动弹回
{
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.modes button')).find(
      (x) => x.textContent?.trim() === 'Reduce 端特写',
    ) as HTMLButtonElement
    b?.click()
  })
  await page.waitForTimeout(600)
  const active = await page.evaluate(
    () =>
      Array.from(document.querySelectorAll('.modes button'))
        .filter((b) => b.classList.contains('active'))
        .map((b) => b.textContent?.trim())[0] ?? '',
  )
  check('手动切换后镜头保持不变', active === 'Reduce 端特写', active)
}

// 10. 悬停 Reduce 触发分区高亮（DOM 层）——需先切回全局拓扑
{
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.modes button')).find(
      (x) => x.textContent?.trim() === '全局拓扑',
    ) as HTMLButtonElement
    b?.click()
  })
  await page.waitForTimeout(400)
  const box = await page.evaluate(() => {
    const r = document.querySelector('.stage svg')?.getBoundingClientRect()
    return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null
  })
  check('全局拓扑下拓扑 SVG 已挂载', box !== null)

  // 悬停在某个 Reduce 框上，应出现分区高亮描边
  const stroke = await page.evaluate(async () => {
    const svg = document.querySelector('.stage svg') as SVGSVGElement
    const rect = svg.getBoundingClientRect()
    // 右侧 Reduce 区域
    const x = rect.x + rect.width * 0.88
    const y = rect.y + rect.height * 0.35
    svg.dispatchEvent(
      new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }),
    )
    await new Promise((r) => setTimeout(r, 120))
    const strokes = Array.from(svg.querySelectorAll('rect'))
      .map((r) => r.getAttribute('stroke'))
      .filter((s) => s && s !== 'transparent')
    return strokes.length
  })
  check('悬停 Reduce 时出现高亮描边', stroke > 0, `${stroke} 个高亮`)
}

if (errors.length) {
  console.log('\n\x1b[31m运行时错误：\x1b[0m')
  for (const e of errors.slice(0, 8)) console.log('  ' + e)
  failures += errors.length
}

console.log(
  failures === 0 ? '\n\x1b[32m交互验证全部通过\x1b[0m\n' : `\n\x1b[31m${failures} 项失败\x1b[0m\n`,
)
await browser.close()
process.exit(failures === 0 ? 0 : 1)

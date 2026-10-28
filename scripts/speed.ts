/**
 * 倍速档位验证。
 * 用法：npx tsx scripts/speed.ts
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
  ;(document.querySelector('.play-btn') as HTMLButtonElement)?.click()
})

console.log('\n\x1b[1m倍速档位验证\x1b[0m')

// 1. 触发器存在且显示当前速度（默认应为 0.25×）
{
  const trig = await page.evaluate(
    () => document.querySelector('.speed-trigger')?.textContent?.trim() ?? '',
  )
  check('倍速触发器显示当前速度', trig.includes('0.25×'), trig)
}

// 2. 展开菜单后档位齐全
{
  await page.click('.speed-trigger')
  await page.waitForTimeout(300)
  const items = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.speed-item')).map((e) => ({
      val: e.querySelector('.speed-val')?.textContent ?? '',
      eta: e.querySelector('.speed-eta')?.textContent ?? '',
    })),
  )
  const vals = items.map((i) => i.val)
  const expect = ['0.05×', '0.1×', '0.2×', '0.25×', '0.5×']
  const missing = expect.filter((e) => !vals.includes(e))
  check(
    '档位为 0.05/0.1/0.2/0.25/0.5',
    missing.length === 0,
    missing.length ? '缺: ' + missing.join(',') : vals.join(' '),
  )
  check(
    '已移除 1×/2×/4× 高速档',
    !vals.some((v) => v === '1×' || v === '2×' || v === '4×'),
    vals.join(' '),
  )
  check(
    '每档标注预计全程耗时',
    items.every((i) => i.eta.includes('全程')),
    items[0]?.eta ?? '',
  )
}

// 3. 各档耗时与实际时长自洽
{
  // 总时长直接取 range 的 max，避免解析含"全程"提示的文本
  const total = await page.evaluate(
    () => Number((document.querySelector('input.track') as HTMLInputElement).max) / 1000,
  )
  const etas = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.speed-item')).map((e) => ({
      val: e.querySelector('.speed-val')?.textContent ?? '',
      eta: e.querySelector('.speed-eta')?.textContent ?? '',
    })),
  )
  const get = (v: string) =>
    Number(etas.find((i) => i.val === v)?.eta.match(/([\d.]+)s/)?.[1] ?? '0')
  check(
    '0.25× 档预计耗时 = 总时长 ÷ 0.25',
    Math.abs(get('0.25×') - total / 0.25) < 0.2,
    `${get('0.25×')}s vs ${(total / 0.25).toFixed(1)}s`,
  )
  check(
    '0.05× 档耗时 = 总时长 ÷ 0.05',
    Math.abs(get('0.05×') - total / 0.05) < 0.5,
    `${get('0.05×')}s vs ${(total / 0.05).toFixed(1)}s`,
  )
}

// 4. 选择新档位生效
{
  await page.evaluate(() => {
    const it = Array.from(document.querySelectorAll('.speed-item')).find(
      (x) => x.querySelector('.speed-val')?.textContent === '0.1×',
    ) as HTMLElement
    it?.click()
  })
  await page.waitForTimeout(300)
  const trig = await page.evaluate(
    () => document.querySelector('.speed-trigger')?.textContent?.trim() ?? '',
  )
  check('选择 0.1× 后触发器更新', trig.includes('0.1×'), trig)
  const menuClosed = await page.evaluate(() => document.querySelector('.speed-menu') === null)
  check('选择后菜单自动关闭', menuClosed)
}

// 5. 播放速度实际变慢（测量窗口内推进的仿真时间）
{
  const measure = async (sp: string) => {
    // 打开菜单与点选菜单项必须分两步：
    // React 渲染菜单需要时间，同一个同步块内查找不到菜单项。
    await page.click('.speed-trigger')
    await page.waitForTimeout(250)
    const picked = await page.evaluate((s) => {
      const it = Array.from(document.querySelectorAll('.speed-item')).find(
        (x) => x.querySelector('.speed-val')?.textContent === s,
      ) as HTMLElement | undefined
      it?.click()
      return !!it
    }, sp)
    if (!picked) throw new Error(`未找到速度档位 ${sp}`)
    await page.waitForTimeout(250)
    // 回到起点并确保处于播放状态
    await page.evaluate(() => {
      const track = document.querySelector('input.track') as HTMLInputElement
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )!.set!
      setter.call(track, '0')
      track.dispatchEvent(new Event('input', { bubbles: true }))
      const btn = document.querySelector('.play-btn') as HTMLButtonElement
      if (btn.getAttribute('aria-label') === '播放') btn.click()
    })
    await page.waitForTimeout(200)
    const t1 = await page.evaluate(
      () => (window as unknown as { __simTime?: () => number }).__simTime?.() ?? 0,
    )
    await page.waitForTimeout(3000)
    const t2 = await page.evaluate(
      () => (window as unknown as { __simTime?: () => number }).__simTime?.() ?? 0,
    )
    return t2 - t1
  }

  const fast = await measure('0.5×')
  const slow = await measure('0.05×')
  // 0.5× 与 0.05× 的推进量比值应为 10；留出余量以容忍 rAF 抖动
  check(
    '0.5× 约为 0.05× 的 10 倍推进量',
    fast > slow * 6,
    `0.5× 推进 ${Math.round(fast)}ms / 0.05× 推进 ${Math.round(slow)}ms（比值 ${(fast / Math.max(slow, 1)).toFixed(1)}）`,
  )
  check('0.05× 确实极慢（3 秒推进不足 250ms）', slow < 250, `推进 ${Math.round(slow)}ms`)
}

// 6. 时间轴进度条未被挤压
{
  const w = await page.evaluate(() => {
    const tr = document.querySelector('.track-wrap') as HTMLElement
    const tl = document.querySelector('.timeline') as HTMLElement
    return {
      track: Math.round(tr.getBoundingClientRect().width),
      overflow: tl.scrollWidth > tl.clientWidth + 1,
    }
  })
  check('进度条宽度充足', w.track > 500, `${w.track}px`)
  check('时间轴无溢出', !w.overflow)
}

// 7. 演示模式内也能切换倍速
{
  await page.evaluate(() => {
    ;(document.querySelector('.present-btn') as HTMLButtonElement)?.click()
  })
  await page.waitForTimeout(500)
  await page.evaluate(() => {
    ;(document.querySelector('.present-hud .speed-trigger') as HTMLButtonElement)?.click()
  })
  await page.waitForTimeout(300)
  const menuItems = await page.evaluate(
    () => document.querySelectorAll('.present-hud .speed-item').length,
  )
  check('演示模式内倍速菜单可用', menuItems === 5, `${menuItems} 项`)

  await page.evaluate(() => {
    const it = Array.from(document.querySelectorAll('.present-hud .speed-item')).find(
      (x) => x.querySelector('.speed-val')?.textContent === '0.2×',
    ) as HTMLElement
    it?.click()
  })
  await page.waitForTimeout(300)
  const trig = await page.evaluate(
    () => document.querySelector('.present-hud .speed-trigger')?.textContent?.trim() ?? '',
  )
  check('演示模式内可切换到 0.2×', trig.includes('0.2×'), trig)

  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
}

if (errors.length) {
  console.log('\n\x1b[31m运行时错误：\x1b[0m')
  for (const e of errors.slice(0, 8)) console.log('  ' + e)
  failures += errors.length
}

console.log(
  failures === 0 ? '\n\x1b[32m倍速验证全部通过\x1b[0m\n' : `\n\x1b[31m${failures} 项失败\x1b[0m\n`,
)
await browser.close()
process.exit(failures === 0 ? 0 : 1)

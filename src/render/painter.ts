import { TIME, type MapSide, type ReducerSide, type SimResult } from '../sim/engine'
import {
  BOT_Y,
  BUF_W,
  BUF_X,
  CHIP_GAP,
  CHIP_H,
  CHIP_W,
  FILE_W,
  FILE_X,
  FLOW_X0,
  FLOW_X1,
  MAP_X,
  MAP_W,
  NET_X0,
  NET_X1,
  RED_X,
  RED_W,
  SPILL_W,
  SPILL_X,
  TOP_Y,
  VIEW_H,
  VIEW_W,
  clamp01,
  easeInOut,
  flowPath,
  mapBoxH,
  mapBoxY,
  progress,
  quadPoint,
  reducerBoxH,
  reducerBoxY,
} from './layout'
import { C, FONT_MONO, FONT_SANS, partitionRamp, ramp, type RampName } from './theme'

/* ------------------------------------------------------------------ *
 * 绘图工具
 * ------------------------------------------------------------------ */

function rrect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

function label(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  opts: { size?: number; color?: string; align?: CanvasTextAlign; weight?: number; mono?: boolean } = {},
) {
  const size = opts.size ?? 12
  ctx.font = `${opts.weight ?? 400} ${size}px ${opts.mono ? FONT_MONO : FONT_SANS}`
  ctx.fillStyle = opts.color ?? C.inkMuted
  ctx.textAlign = opts.align ?? 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x, y)
}

function chip(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  rampName: RampName,
  opts: { w?: number; h?: number; alpha?: number; bold?: boolean; scale?: number } = {},
) {
  const w = (opts.w ?? CHIP_W) * (opts.scale ?? 1)
  const h = (opts.h ?? CHIP_H) * (opts.scale ?? 1)
  const r = ramp(rampName)
  ctx.globalAlpha = opts.alpha ?? 1
  rrect(ctx, x, y, w, h, 4)
  ctx.fillStyle = r.bg
  ctx.fill()
  ctx.strokeStyle = r.stroke
  ctx.lineWidth = 0.5
  ctx.stroke()
  label(ctx, text, x + w / 2, y + h / 2, {
    size: 10.5,
    color: r.text,
    align: 'center',
    weight: opts.bold ? 500 : 400,
    mono: true,
  })
  ctx.globalAlpha = 1
}

/* ------------------------------------------------------------------ *
 * 主渲染
 * ------------------------------------------------------------------ */

export interface RenderOpts {
  sim: SimResult
  t: number
  /** 高亮的 Map（特写镜头） */
  focusMap: number | null
  /** 高亮的 Reducer（特写镜头） */
  focusReducer: number | null
  /** 视图模式：overview 概览 / map 特写 / reduce 特写 */
  mode: 'overview' | 'map' | 'reduce'
  /** 是否绘制数据流 */
  showFlow: boolean
}

export function render(ctx: CanvasRenderingContext2D, o: RenderOpts) {
  const { sim, t } = o
  ctx.clearRect(0, 0, VIEW_W, VIEW_H)

  if (o.mode === 'map') {
    renderMapFocus(ctx, sim, t, o.focusMap ?? 0)
  } else if (o.mode === 'reduce') {
    renderReduceFocus(ctx, sim, t, o.focusReducer ?? 0)
  } else {
    renderOverview(ctx, sim, t, o)
  }
}

/* ------------------------------------------------------------------ *
 * 概览：全局拓扑 + 数据流动
 * ------------------------------------------------------------------ */

function renderOverview(ctx: CanvasRenderingContext2D, sim: SimResult, t: number, o: RenderOpts) {
  const nMaps = sim.maps.length
  const nReds = sim.reducers.length
  const mH = mapBoxH(nMaps)
  const rH = reducerBoxH(nReds)

  // ---- 传输带背景 ----
  const netGrad = ctx.createLinearGradient(NET_X0, 0, NET_X1, 0)
  netGrad.addColorStop(0, 'rgba(241,239,232,0)')
  netGrad.addColorStop(0.15, 'rgba(241,239,232,0.75)')
  netGrad.addColorStop(0.85, 'rgba(241,239,232,0.75)')
  netGrad.addColorStop(1, 'rgba(241,239,232,0)')
  ctx.fillStyle = netGrad
  ctx.fillRect(NET_X0, TOP_Y - 8, NET_X1 - NET_X0, BOT_Y - TOP_Y + 16)
  label(ctx, 'Shuffle 网络传输区', (NET_X0 + NET_X1) / 2, TOP_Y - 22, {
    size: 11,
    color: C.inkFaint,
    align: 'center',
  })

  // ---- 传输路径（细线，底色） ----
  for (const mp of sim.maps) {
    const my = mapBoxY(mp.mapId, nMaps) + mH / 2
    for (const rd of sim.reducers) {
      const ry = reducerBoxY(rd.reducerId, nReds) + rH / 2
      const c = flowPath({ x: FLOW_X0, y: my }, { x: FLOW_X1, y: ry })
      ctx.beginPath()
      ctx.moveTo(FLOW_X0, my)
      ctx.quadraticCurveTo(c.x, c.y, FLOW_X1, ry)
      ctx.strokeStyle = C.lineFaint
      ctx.lineWidth = 1
      ctx.stroke()
    }
  }

  // ---- Map 端框 ----
  for (const mp of sim.maps) {
    const y = mapBoxY(mp.mapId, nMaps)
    drawMapBox(ctx, mp, MAP_X, y, MAP_W, mH, t, sim)
  }

  // ---- Reduce 端框 ----
  for (const rd of sim.reducers) {
    const y = reducerBoxY(rd.reducerId, nReds)
    drawReducerBox(ctx, rd, RED_X, y, RED_W, rH, t)
  }

  // ---- 数据流（画在框之上，形成穿越感） ----
  if (o.showFlow) {
    drawFlow(ctx, sim, t, nMaps, nReds, mH, rH)
  }
}

function drawMapBox(
  ctx: CanvasRenderingContext2D,
  mp: MapSide,
  x: number,
  y: number,
  w: number,
  h: number,
  t: number,
  sim: SimResult,
) {
  const committed = t >= mp.commitT
  rrect(ctx, x, y, w, h, 8)
  ctx.fillStyle = C.panelSoft
  ctx.fill()
  ctx.strokeStyle = committed ? C.line : C.lineSoft
  ctx.lineWidth = 0.5
  ctx.stroke()

  // ---- 槽位 1：标题行 ----
  label(ctx, `Map ${mp.mapId}`, x + 10, y + 13, { size: 13, color: C.ink, weight: 500 })
  const busy = t >= mp.startT && !committed
  const status = committed ? '已提交' : busy ? '运行中' : '待启动'
  label(ctx, status, x + w - 10, y + 13, {
    size: 10.5,
    color: committed ? C.green.text : busy ? C.blue.text : C.inkFaint,
    align: 'right',
  })

  // ---- 槽位 2：缓冲区水位条 ----
  const buf = mp.tokens.filter((tk) => {
    const s = tk.stops.find((x2) => x2.kind === 'buffer')
    return s && t >= s.tIn && t < s.tOut
  })
  const bx = x + 10
  const bw = w - 20
  const ratio = buf.length / sim.config.bufferSize
  const barY = y + 26
  rrect(ctx, bx, barY, bw, 7, 3.5)
  ctx.fillStyle = C.lineFaint
  ctx.fill()
  if (ratio > 0) {
    rrect(ctx, bx, barY, bw * clamp01(ratio), 7, 3.5)
    ctx.fillStyle = ratio >= 1 ? C.red.mid : C.blue.mid
    ctx.fill()
  }

  // ---- 槽位 3：缓冲区文字（左） + 溢写阶段（右） ----
  const rowY = y + 44
  label(ctx, `缓冲区 ${buf.length}/${sim.config.bufferSize}`, bx, rowY, {
    size: 9.5,
    color: ratio >= 1 ? C.red.text : C.inkFaint,
  })

  const active = mp.spills.find((s) => t >= s.startT && t < s.endT)
  if (active) {
    const p = progress(t, active.startT, active.endT)
    const sortEnd = active.startT + TIME.SPILL * TIME.SPILL_SORT
    const combineEnd = sortEnd + TIME.SPILL * TIME.SPILL_COMBINE
    const stage = t >= combineEnd ? '写盘' : t >= sortEnd ? '合并' : '排序'
    label(ctx, `溢写${stage}中`, bx + bw, rowY, {
      size: 9.5,
      color: C.amber.text,
      align: 'right',
    })
    // 溢写进度条（独立一行，避免与文字重叠）
    const py = y + 52
    rrect(ctx, bx, py, bw, 4, 2)
    ctx.fillStyle = C.lineFaint
    ctx.fill()
    rrect(ctx, bx, py, bw * p, 4, 2)
    ctx.fillStyle = ramp(stage === '写盘' ? 'amber' : stage === '合并' ? 'purple' : 'blue').mid
    ctx.fill()
  }

  // ---- 槽位 4：底部统计 ----
  const spillsDone = mp.spills.filter((s) => t >= s.endT).length
  label(ctx, `溢写 ${spillsDone}/${mp.spillCount}`, x + 10, y + h - 11, {
    size: 10,
    color: C.inkFaint,
  })
  label(ctx, `写出 ${mp.merged.filter((e) => e.mergedT <= t).length} 条`, x + w - 10, y + h - 11, {
    size: 10,
    color: C.inkFaint,
    align: 'right',
  })
}

function drawReducerBox(
  ctx: CanvasRenderingContext2D,
  rd: ReducerSide,
  x: number,
  y: number,
  w: number,
  h: number,
  t: number,
) {
  const done = t >= rd.endT
  rrect(ctx, x, y, w, h, 8)
  ctx.fillStyle = C.panelSoft
  ctx.fill()
  ctx.strokeStyle = done ? C.green.stroke : C.lineSoft
  ctx.lineWidth = 0.5
  ctx.stroke()

  const p = partitionRamp(rd.partition)
  label(ctx, `Reduce ${rd.reducerId}`, x + 10, y + 14, { size: 13, color: C.ink, weight: 500 })

  // 分区色条
  rrect(ctx, x + w - 46, y + 8, 36, 14, 4)
  ctx.fillStyle = ramp(p).bg
  ctx.fill()
  ctx.strokeStyle = ramp(p).stroke
  ctx.lineWidth = 0.5
  ctx.stroke()
  label(ctx, `分区 ${rd.partition}`, x + w - 28, y + 15, {
    size: 9.5,
    color: ramp(p).text,
    align: 'center',
  })

  const groups = rd.groups.filter((g) => t >= g.startT)
  const merging = t >= rd.mergeStartT && groups.length === 0
  const status = done ? '已完成' : merging ? '归并中' : groups.length ? '归约中' : '等待数据'
  label(ctx, status, x + 10, y + h - 12, {
    size: 10,
    color: done ? C.green.text : merging ? C.amber.text : C.inkFaint,
  })
  label(ctx, `输出 ${rd.output.filter((o2) => t >= o2.outT).length} 行`, x + w - 10, y + h - 12, {
    size: 10,
    color: C.inkFaint,
    align: 'right',
  })

  // 已完成的分组（限制在框内可用高度内）
  let gy = y + 30
  const maxRows = Math.max(1, Math.floor((h - 48) / 16))
  groups.slice(0, maxRows).forEach((g) => {
    const reduced = t >= g.reduceT
    chip(ctx, x + 10, gy, g.key, p, {
      w: 52,
      h: 14,
      alpha: reduced ? 1 : 0.55,
      bold: reduced,
    })
    label(ctx, `${g.value}`, x + 68, gy + 7, {
      size: 10.5,
      color: reduced ? C.ink : C.inkFaint,
      mono: true,
    })
    gy += 16
  })
  if (groups.length > maxRows) {
    label(ctx, `+${groups.length - maxRows}`, x + w - 10, gy + 2, {
      size: 10,
      color: C.inkFaint,
      align: 'right',
    })
  }
}

/* ------------------------------------------------------------------ *
 * 数据流
 * ------------------------------------------------------------------ */

function drawFlow(
  ctx: CanvasRenderingContext2D,
  sim: SimResult,
  t: number,
  nMaps: number,
  nReds: number,
  mH: number,
  rH: number,
) {
  for (const rd of sim.reducers) {
    const ry = reducerBoxY(rd.reducerId, nReds) + rH / 2
    for (const st of rd.streams) {
      const mp = sim.maps[st.mapId]
      const my = mapBoxY(mp.mapId, nMaps) + mH / 2
      const c = flowPath({ x: FLOW_X0, y: my }, { x: FLOW_X1, y: ry })
      for (const e of st.entries) {
        if (t < e.fetchDepartT || t > e.fetchArriveT) continue
        const p = progress(t, e.fetchDepartT, e.fetchArriveT)
        const pos = quadPoint(
          { x: FLOW_X0, y: my },
          { x: c.x, y: c.y },
          { x: FLOW_X1, y: ry },
          easeInOut(p),
        )
        const fade = p > 0.92 ? (1 - p) / 0.08 : 1
        chip(ctx, pos.x - CHIP_W / 2, pos.y - CHIP_H / 2, e.key, partitionRamp(e.partition), {
          alpha: fade * 0.95,
          bold: true,
        })
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Map 端特写：环形缓冲区 → 溢写 → 合并文件
 * ------------------------------------------------------------------ */

function renderMapFocus(ctx: CanvasRenderingContext2D, sim: SimResult, t: number, mapId: number) {
  const mp = sim.maps[mapId]
  if (!mp) return

  const y0 = 108
  const colH = 430

  // ---------- 标题 ----------
  label(ctx, `Map ${mp.mapId} 任务内部`, 40, 52, { size: 17, color: C.ink, weight: 500 })
  label(ctx, '环形缓冲区 → 溢写落盘 → 合并大文件 + 索引', 40, 76, {
    size: 12,
    color: C.inkMuted,
  })

  // ---------- 三段容器 ----------
  const cols = [
    { x: 40, w: 336, title: '① 环形缓冲区（内存）', sub: `容量 ${sim.config.bufferSize} 条` },
    { x: 404, w: 336, title: '② 溢写文件（磁盘）', sub: `${mp.spillCount} 个` },
    { x: 768, w: 372, title: '③ 合并大文件 + 索引', sub: '' },
  ]

  for (const c of cols) {
    rrect(ctx, c.x, y0, c.w, colH, 10)
    ctx.fillStyle = C.panelSoft
    ctx.fill()
    ctx.strokeStyle = C.lineSoft
    ctx.lineWidth = 0.5
    ctx.stroke()
    label(ctx, c.title, c.x + 16, y0 + 22, { size: 13, color: C.ink, weight: 500 })
    if (c.sub) {
      label(ctx, c.sub, c.x + c.w - 16, y0 + 22, {
        size: 10.5,
        color: C.inkFaint,
        align: 'right',
      })
    }
  }

  // ---------- ① 缓冲区 ----------
  drawBuffer(ctx, sim, mp, cols[0].x, y0, cols[0].w, colH, t)

  // ---------- ② 溢写文件 ----------
  drawSpills(ctx, mp, cols[1].x, y0, cols[1].w, t)

  // ---------- ③ 合并文件 + 索引 ----------
  drawMergedFile(ctx, mp, cols[2].x, y0, cols[2].w, colH, t)

  // ---------- 底部讲解 ----------
  const beat = sim.beats.find((b) => b.kind === 'spill' && mp.spills[0] && b.t <= t && b.t > (mp.spills[0].startT - 1))
  if (beat) {
    label(ctx, beat.title, 40, y0 + colH + 34, { size: 13, color: C.amber.text, weight: 500 })
    wrapText(ctx, beat.text, 40, y0 + colH + 54, 800, 17, 12, C.inkMuted)
  } else {
    label(ctx, 'Map 任务尚未开始', 40, y0 + colH + 34, { size: 13, color: C.inkFaint })
  }
}

function drawBuffer(
  ctx: CanvasRenderingContext2D,
  sim: SimResult,
  mp: MapSide,
  x: number,
  y0: number,
  w: number,
  h: number,
  t: number,
) {
  const buf = mp.tokens.filter((tk) => {
    const s = tk.stops.find((x2) => x2.kind === 'buffer')
    return s && t >= s.tIn && t < s.tOut
  })

  // 水位条
  const lx = x + 14
  const ly = y0 + 44
  const lw = w - 28
  rrect(ctx, lx, ly, lw, 10, 5)
  ctx.fillStyle = C.lineFaint
  ctx.fill()
  const ratio = buf.length / sim.config.bufferSize
  rrect(ctx, lx, ly, lw * clamp01(ratio), 10, 5)
  ctx.fillStyle = ratio >= 1 ? C.red.mid : C.blue.mid
  ctx.fill()
  label(ctx, `内存占用 ${buf.length}/${sim.config.bufferSize}`, lx, ly + 22, {
    size: 10.5,
    color: ratio >= 1 ? C.red.text : C.inkMuted,
  })
  if (ratio >= 1) {
    label(ctx, '写满 → 触发溢写', lx + lw, ly + 22, {
      size: 10.5,
      color: C.red.text,
      align: 'right',
    })
  }

  // 缓冲区里的记录（横向排列）
  const startX = x + 14
  const startY = y0 + 84
  const perRow = 6
  buf.forEach((tk, i) => {
    const col = i % perRow
    const row = Math.floor(i / perRow)
    const cx = startX + col * (CHIP_W + CHIP_GAP)
    const cy = startY + row * (CHIP_H + CHIP_GAP + 3)
    if (cy > y0 + h - 40) return
    chip(ctx, cx, cy, tk.key, partitionRamp(tk.partition), { alpha: 0.9 })
  })

  if (buf.length === 0) {
    label(ctx, '缓冲区为空', x + w / 2, y0 + 110, {
      size: 11,
      color: C.inkFaint,
      align: 'center',
    })
  }

  // 正在进行的溢写：显示排序后的中间态
  const active = mp.spills.find((s) => t >= s.startT && t < s.endT)
  if (active) {
    const p = progress(t, active.startT, active.endT)
    const sortEnd = active.startT + TIME.SPILL * TIME.SPILL_SORT
    const combineEnd = sortEnd + TIME.SPILL * TIME.SPILL_COMBINE
    let phaseText = '排序中'
    let phaseColor = C.blue.text
    if (t >= combineEnd) {
      phaseText = '写盘'
      phaseColor = C.amber.text
    } else if (t >= sortEnd) {
      phaseText = sim.config.combiner ? 'Combiner 合并中' : '排序中'
      phaseColor = C.purple.text
    }
    label(ctx, `溢写 #${active.index} · ${phaseText}`, x + 14, y0 + h - 42, {
      size: 11,
      color: phaseColor,
      weight: 500,
    })
    // 进度条
    const phaseRamp: RampName =
      t >= combineEnd ? 'amber' : t >= sortEnd ? 'purple' : 'blue'
    rrect(ctx, x + 14, y0 + h - 28, w - 28, 5, 2.5)
    ctx.fillStyle = C.lineFaint
    ctx.fill()
    rrect(ctx, x + 14, y0 + h - 28, (w - 28) * p, 5, 2.5)
    ctx.fillStyle = ramp(phaseRamp).mid
    ctx.fill()
  }
}

function drawSpills(
  ctx: CanvasRenderingContext2D,
  mp: MapSide,
  x: number,
  y0: number,
  w: number,
  t: number,
) {
  let sy = y0 + 48
  mp.spills.forEach((sp) => {
    const written = t >= sp.endT
    const active = t >= sp.startT && t < sp.endT
    const hgt = 58

    rrect(ctx, x + 14, sy, w - 28, hgt, 8)
    ctx.fillStyle = written ? C.bg : active ? C.amber.bg : C.panelSoft
    ctx.fill()
    ctx.strokeStyle = written ? C.amber.stroke : active ? C.amber.mid : C.lineSoft
    ctx.lineWidth = 0.5
    ctx.stroke()

    label(ctx, `spill-${sp.index}`, x + 24, sy + 13, {
      size: 11,
      color: written ? C.amber.text : C.inkMuted,
      weight: 500,
      mono: true,
    })
    label(
      ctx,
      written ? `${sp.entries.length} 条已落盘` : active ? '写入中…' : '待写入',
      x + w - 24,
      sy + 13,
      { size: 10, color: C.inkFaint, align: 'right' },
    )

    // 文件内的条目（排序后）
    if (written) {
      sp.entries.slice(0, 9).forEach((e, i) => {
        chip(ctx, x + 24 + (i % 5) * 40, sy + 26 + Math.floor(i / 5) * 16, e.key, partitionRamp(e.partition), {
          w: 34,
          h: 13,
          alpha: 0.92,
        })
      })
    }
    sy += hgt + 10
  })

  if (mp.spills.length === 0) {
    label(ctx, '尚无溢写', x + w / 2, y0 + 80, { size: 11, color: C.inkFaint, align: 'center' })
  }
}

function drawMergedFile(
  ctx: CanvasRenderingContext2D,
  mp: MapSide,
  x: number,
  y0: number,
  w: number,
  h: number,
  t: number,
) {
  const merging = t >= mp.mergeStartT && t < mp.commitT
  const done = t >= mp.commitT

  label(
    ctx,
    done ? '已提交' : merging ? '合并中…' : '待合并',
    x + w - 16,
    y0 + 44,
    {
      size: 10.5,
      color: done ? C.green.text : merging ? C.amber.text : C.inkFaint,
      align: 'right',
    },
  )

  // 大文件内容：按 (分区, key) 有序，逐条写出
  const written = mp.merged.filter((e) => e.mergedT <= t)
  let fy = y0 + 58
  const maxRows = Math.max(1, Math.floor((h - 190) / 19))
  written.slice(0, maxRows).forEach((e) => {
    chip(ctx, x + 16, fy, e.key, partitionRamp(e.partition), { w: 42, h: 15, alpha: 0.95 })
    label(ctx, String(e.value), x + 62, fy + 7, { size: 10, color: C.inkFaint, mono: true })
    fy += 19
  })
  if (written.length === 0) {
    // 合并前：把各溢写文件画成待归并的来源块
    label(ctx, '合并前的来源', x + 16, y0 + 60, { size: 11, color: C.inkMuted, weight: 500 })
    mp.spills.forEach((sp, i) => {
      const sy = y0 + 80 + i * 30
      if (sy > y0 + h - 150) return
      const ready = t >= sp.endT
      rrect(ctx, x + 16, sy, w - 32, 24, 5)
      ctx.fillStyle = ready ? C.bg : C.panel
      ctx.fill()
      ctx.strokeStyle = ready ? C.lineSoft : C.lineFaint
      ctx.lineWidth = 0.5
      ctx.stroke()
      label(ctx, `spill-${sp.index}`, x + 26, sy + 12, {
        size: 10,
        color: ready ? C.inkMuted : C.inkFaint,
        mono: true,
      })
      sp.entries.slice(0, 7).forEach((e, j) => {
        chip(ctx, x + 88 + j * 36, sy + 5, e.key, partitionRamp(e.partition), {
          w: 32,
          h: 14,
          alpha: ready ? 0.85 : 0.3,
        })
      })
    })
    label(ctx, merging ? '正在把溢写文件归并成一个大文件…' : '等待溢写完成', x + w / 2, y0 + 62, {
      size: 11,
      color: C.inkFaint,
      align: 'center',
    })
  } else if (written.length > maxRows) {
    label(ctx, `+${written.length - maxRows} 条`, x + w - 16, fy + 2, {
      size: 10,
      color: C.inkFaint,
      align: 'right',
    })
  }

  // 索引表：合并完成后才生成，此前显示占位
  const iy = y0 + h - 122
  label(ctx, '索引 index', x + 16, iy - 8, { size: 11, color: C.ink, weight: 500 })
  rrect(ctx, x + 16, iy, w - 32, 100, 6)
  ctx.fillStyle = C.panel
  ctx.fill()
  ctx.strokeStyle = C.lineSoft
  ctx.lineWidth = 0.5
  ctx.stroke()

  if (done) {
    mp.index.forEach((idx, i) => {
      const ry = iy + 16 + i * 24
      if (ry > iy + 92) return
      chip(ctx, x + 24, ry - 7, `P${idx.partition}`, partitionRamp(idx.partition), {
        w: 28,
        h: 14,
        bold: true,
      })
      label(ctx, `偏移 ${idx.offset}`, x + 60, ry, {
        size: 10,
        color: C.inkMuted,
        mono: true,
      })
      label(ctx, `${idx.count} 条`, x + 118, ry, {
        size: 10,
        color: C.inkMuted,
        mono: true,
      })
      label(ctx, `${idx.minKey}~${idx.maxKey}`, x + w - 24, ry, {
        size: 9.5,
        color: C.inkFaint,
        align: 'right',
        mono: true,
      })
    })
  } else {
    label(ctx, '索引在 Map 提交时生成', x + w / 2, iy + 50, {
      size: 11,
      color: C.inkFaint,
      align: 'center',
    })
  }
}

/* ------------------------------------------------------------------ *
 * Reduce 端特写：K 路归并 → 分组 → reduce
 * ------------------------------------------------------------------ */

function renderReduceFocus(ctx: CanvasRenderingContext2D, sim: SimResult, t: number, redId: number) {
  const rd = sim.reducers[redId]
  if (!rd) return

  label(ctx, `Reduce ${rd.reducerId} 任务内部`, 40, 52, { size: 17, color: C.ink, weight: 500 })
  label(ctx, 'K 路归并 → 相同 key 相邻 → 归组 → reduce()', 40, 76, {
    size: 12,
    color: C.inkMuted,
  })

  const y0 = 104
  const colH = 420
  const colL = { x: 40, w: 336 }
  const colM = { x: 404, w: 336 }
  const colR = { x: 768, w: 372 }

  const panel = (x: number, w: number, title: string, sub?: string) => {
    rrect(ctx, x, y0, w, colH, 10)
    ctx.fillStyle = C.panelSoft
    ctx.fill()
    ctx.strokeStyle = C.lineSoft
    ctx.lineWidth = 0.5
    ctx.stroke()
    label(ctx, title, x + 16, y0 + 22, { size: 13, color: C.ink, weight: 500 })
    if (sub) {
      label(ctx, sub, x + w - 16, y0 + 22, {
        size: 10.5,
        color: C.inkFaint,
        align: 'right',
      })
    }
  }

  // ---- 左：各 Map 拉来的有序流 ----
  panel(colL.x, colL.w, '来自各 Map 的有序片段', '▶ = 队首')
  // 三路流纵向平分栏高；每路内部把所有条目竖排出来，
  // 这样"多路 → 一条有序流"的对比才完整可见。
  const streamSlot = (colH - 64) / Math.max(rd.streams.length, 1)
  rd.streams.forEach((st, si) => {
    const sx = colL.x + 16
    const sy = y0 + 46 + si * streamSlot
    const consumedCount = st.entries.filter((e) => e.mergeStepT <= t).length
    label(ctx, `Map ${st.mapId}`, sx, sy, { size: 11, color: C.ink, weight: 500 })
    label(ctx, `${consumedCount}/${st.entries.length}`, sx + colL.w - 32, sy, {
      size: 9.5,
      color: C.inkFaint,
      align: 'right',
      mono: true,
    })

    // 一路内部：条目竖排，队首用指针标出
    const rowH = 15
    const cap = Math.max(1, Math.floor((streamSlot - 20) / rowH))
    st.entries.slice(0, cap).forEach((e, i) => {
      const consumed = e.mergeStepT <= t
      chip(ctx, sx + 58, sy + 4 + i * rowH, e.key, partitionRamp(e.partition), {
        w: 42,
        h: 12,
        alpha: consumed ? 0.42 : 0.95,
      })
    })
    if (st.entries.length > cap) {
      label(ctx, `+${st.entries.length - cap}`, sx + 58, sy + 8 + cap * rowH, {
        size: 9.5,
        color: C.inkFaint,
      })
    }

    // 队首指针
    const head = st.entries[consumedCount]
    if (head && consumedCount < cap) {
      const hy = sy + 4 + consumedCount * rowH
      ctx.beginPath()
      ctx.moveTo(sx + 52, hy + 6)
      ctx.lineTo(sx + 56, hy + 9)
      ctx.lineTo(sx + 52, hy + 12)
      ctx.closePath()
      ctx.fillStyle = C.purple.stroke
      ctx.fill()
    }
  })

  // ---- 中：归并输出流 ----
  panel(colM.x, colM.w, 'K 路归并结果', '每次取各路队首最小者')
  const mergedShown = rd.merged.filter((e) => e.mergeStepT <= t)
  const maxRows = Math.floor((colH - 60) / 19)
  let my2 = y0 + 44
  mergedShown.slice(0, maxRows).forEach((e, i) => {
    // 同 key 高亮成组
    const prev = mergedShown[i - 1]
    const next = mergedShown[i + 1]
    const sameAsPrev = prev && prev.key === e.key
    const sameAsNext = next && next.key === e.key
    chip(ctx, colM.x + 16, my2, e.key, partitionRamp(e.partition), {
      w: 46,
      h: 15,
      alpha: 1,
      bold: true,
    })
    if (sameAsPrev || sameAsNext) {
      rrect(ctx, colM.x + 12, my2 - 2, 54, 19, 5)
      ctx.strokeStyle = C.purple.mid
      ctx.lineWidth = 1
      ctx.stroke()
    }
    label(ctx, String(e.value), colM.x + 68, my2 + 7, {
      size: 10,
      color: C.inkFaint,
      mono: true,
    })
    my2 += 19
  })
  if (rd.merged.length === 0) {
    label(ctx, '等待数据到达', colM.x + colM.w / 2, y0 + 70, {
      size: 11,
      color: C.inkFaint,
      align: 'center',
    })
  } else if (rd.merged.length > maxRows) {
    label(ctx, `+${rd.merged.length - maxRows} 条`, colM.x + colM.w - 16, my2 + 2, {
      size: 10,
      color: C.inkFaint,
      align: 'right',
    })
  }

  // ---- 右：分组与输出 ----
  panel(colR.x, colR.w, '归组 → reduce() 输出', `分区 ${rd.partition}`)
  const groups = rd.groups.filter((g) => t >= g.startT)
  let gy = y0 + 44
  groups.slice(0, maxRows).forEach((g) => {
    const reduced = t >= g.reduceT
    const isHot = g.entries.length > 1
    chip(ctx, colR.x + 16, gy, g.key, partitionRamp(rd.partition), {
      w: 54,
      h: 16,
      alpha: reduced ? 1 : 0.6,
      bold: true,
    })
    if (isHot) {
      label(ctx, `${g.entries.length} 个值合并`, colR.x + 78, gy + 8, {
        size: 9.5,
        color: C.purple.text,
      })
    }
    label(ctx, `= ${g.value}`, colR.x + colR.w - 16, gy + 8, {
      size: 11,
      color: reduced ? C.ink : C.inkFaint,
      align: 'right',
      mono: true,
    })
    gy += 20
  })
  if (groups.length === 0) {
    label(ctx, '尚未产生输出', colR.x + colR.w / 2, y0 + 70, {
      size: 11,
      color: C.inkFaint,
      align: 'center',
    })
  }

  // ---- 底部讲解 ----
  const beat = sim.beats.find((b) => b.kind === 'merge' && b.t <= t)
  if (beat) {
    label(ctx, beat.title, 40, y0 + colH + 34, {
      size: 13,
      color: C.purple.text,
      weight: 500,
    })
    wrapText(ctx, beat.text, 40, y0 + colH + 54, 900, 17, 12, C.inkMuted)
  }
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  size: number,
  color: string,
) {
  ctx.font = `400 ${size}px ${FONT_SANS}`
  const words = text.split('')
  let line = ''
  let ly = y
  for (const ch of words) {
    const test = line + ch
    if (ctx.measureText(test).width > maxWidth && line) {
      label(ctx, line, x, ly, { size, color })
      line = ch
      ly += lineHeight
    } else {
      line = test
    }
  }
  if (line) label(ctx, line, x, ly, { size, color })
}

export { BUF_W, BUF_X, FILE_W, FILE_X, SPILL_W, SPILL_X }

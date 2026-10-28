import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_CONFIG,
  TIME,
  simulate,
  type SimConfig,
  type SimResult,
} from './sim/engine'
import { render } from './render/painter'
import { TopologyLayer } from './render/TopologyLayer'
import { VIEW_H, VIEW_W } from './render/layout'
import { C, partitionRamp } from './render/theme'
import './styles.css'

type Mode = 'overview' | 'map' | 'reduce'

/**
 * 倍速档位：只保留讲课时用得上的慢速区间。
 * 完整流程约 3.5 秒（仿真时间），按档位换算后：
 *   0.05× → 约 71 秒，可以逐帧讲
 *   0.1×  → 约 35 秒，适合边讲边指
 *   0.5×  → 约 7 秒，快速过一遍
 * 去掉 1× 及以上：演示场景不需要快放。
 */
const SPEEDS = [0.05, 0.1, 0.2, 0.25, 0.5]

/** 默认播放速度 */
const DEFAULT_SPEED = 0.25

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const [config, setConfig] = useState<SimConfig>(DEFAULT_CONFIG)
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(DEFAULT_SPEED)
  const [mode, setMode] = useState<Mode>('overview')
  const [focusMap, setFocusMap] = useState<number | null>(null)
  const [focusReducer, setFocusReducer] = useState<number | null>(null)
  const [hoverPartition, setHoverPartition] = useState<number | null>(null)
  const [showFlow, setShowFlow] = useState(true)
  const [autoCam, setAutoCam] = useState(true)
  const [beatIdx, setBeatIdx] = useState(0)
  const [sideOpen, setSideOpen] = useState(true)
  /** 演示模式：隐藏全部界面元素，动画占满全屏 */
  const [presentation, setPresentation] = useState(false)
  /** 演示模式下控制条是否可见（鼠标静止后自动隐藏） */
  const [hudVisible, setHudVisible] = useState(true)

  const sim: SimResult = useMemo(() => simulate(config), [config])
  const dur = sim.duration

  // 时间推进：GSAP ticker 驱动，React 只在节拍变化时更新
  const tRef = useRef(0)
  const playingRef = useRef(true)
  const speedRef = useRef(1)
  const durRef = useRef(dur)

  useEffect(() => {
    durRef.current = dur
  }, [dur])

  useEffect(() => {
    playingRef.current = playing
  }, [playing])

  useEffect(() => {
    speedRef.current = speed
  }, [speed])

  useEffect(() => {
    let last = performance.now()
    const tick = (now: number) => {
      const dt = Math.min(64, now - last)
      last = now
      if (playingRef.current) {
        tRef.current += dt * speedRef.current
        if (tRef.current >= durRef.current) {
          tRef.current = durRef.current
          playingRef.current = false
          setPlaying(false)
        }
      }
      setT(tRef.current)
      requestAnimationFrame(tick)
    }
    const raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  // 精确读取当前仿真时间（不受 React 渲染节流影响），供自动化测试校验倍速
  useEffect(() => {
    ;(window as unknown as { __simTime?: () => number }).__simTime = () => tRef.current
    return () => {
      delete (window as unknown as { __simTime?: () => number }).__simTime
    }
  }, [])

  // 重置时间轴
  const reset = () => {
    tRef.current = 0
    setT(0)
    setPlaying(true)
    setBeatIdx(0)
  }

  // 配置变化 → 重新仿真并重置
  const updateConfig = (patch: Partial<SimConfig>) => {
    setConfig((c) => ({ ...c, ...patch }))
    tRef.current = 0
    setT(0)
    setBeatIdx(0)
    setPlaying(true)
  }

  // Canvas 渲染（不经过 React）
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    // 用可变引用持有画布尺寸：侧栏折叠/窗口变化时都要重新测量，
    // 否则 draw 会继续用旧宽高渲染，导致画面错位。
    const dims = { w: 0, h: 0 }

    const measure = () => {
      const r = canvas.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return false
      dims.w = r.width
      dims.h = r.height
      canvas.width = Math.round(r.width * dpr)
      canvas.height = Math.round(r.height * dpr)
      return true
    }
    measure()

    const draw = () => {
      const { w, h } = dims
      if (w > 0 && h > 0) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, w, h)
        // 铺满背景，避免宽屏下等比缩放后出现透明留白
        ctx.fillStyle = '#FFFFFF'
        ctx.fillRect(0, 0, w, h)
        // 等比缩放，居中
        const s = Math.min(w / VIEW_W, h / VIEW_H)
        const ox = (w - VIEW_W * s) / 2
        const oy = (h - VIEW_H * s) / 2
        ctx.translate(ox, oy)
        ctx.scale(s, s)
        render(ctx, {
          sim,
          t: tRef.current,
          focusMap,
          focusReducer,
          mode,
          showFlow,
        })
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      }
      raf = requestAnimationFrame(draw)
    }
    let raf = requestAnimationFrame(draw)

    // ResizeObserver 覆盖侧栏折叠这类"窗口尺寸没变但容器变了"的情况
    const ro = new ResizeObserver(() => measure())
    ro.observe(canvas)
    window.addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [sim, mode, focusMap, focusReducer, showFlow])

  // 当前讲解节拍
  useEffect(() => {
    let idx = 0
    for (let i = 0; i < sim.beats.length; i++) {
      if (sim.beats[i].t <= t) idx = i
    }
    setBeatIdx(idx)
  }, [t, sim])

  const beat = sim.beats[beatIdx] ?? sim.beats[0]

  // 自动镜头：跟随讲解节拍切换特写。
  // 用户手动选择视图后自动镜头让位，避免"点了按钮立刻被弹回去"。
  useEffect(() => {
    if (!beat || !autoCam) return
    if (beat.focus?.map != null) {
      setMode('map')
      setFocusMap(beat.focus.map)
      setFocusReducer(null)
    } else if (beat.focus?.reducer != null) {
      setMode('reduce')
      setFocusReducer(beat.focus.reducer)
      setFocusMap(null)
    } else {
      setMode('overview')
    }
  }, [beatIdx, beat, autoCam])

  // 侧栏折叠快捷键（按 D 切换），输入框内不触发
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el?.closest?.('input, textarea, select, [contenteditable="true"]')) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'd' || e.key === 'D') {
        setSideOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /* ---------------- 演示模式 ---------------- */

  // 记录进入演示模式前的侧栏状态，退出时还原
  const sideBeforePresent = useRef(true)

  const enterPresentation = useCallback(async () => {
    sideBeforePresent.current = sideOpen
    setPresentation(true)
    setSideOpen(false)
    try {
      await document.documentElement.requestFullscreen?.()
    } catch {
      // 浏览器拒绝全屏时，仍进入页内演示模式（已隐藏所有界面元素）
    }
  }, [sideOpen])

  const exitPresentation = useCallback(() => {
    setPresentation(false)
    setSideOpen(sideBeforePresent.current)
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {})
    }
  }, [])

  // 演示模式快捷键：F 切换、Space 播放/暂停、方向键步进、Esc 退出
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el?.closest?.('input, textarea, select, [contenteditable="true"]')) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      if (e.key === 'Escape') {
        if (presentation) {
          e.preventDefault()
          exitPresentation()
        }
        return
      }
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault()
        if (presentation) exitPresentation()
        else void enterPresentation()
        return
      }
      if (!presentation) return
      // 焦点在按钮上时，Space 交给按钮自身处理，避免双重触发
      const onButton = (e.target as HTMLElement | null)?.closest?.('button')
      if (e.key === ' ' || e.code === 'Space') {
        if (onButton) return
        e.preventDefault()
        setPlaying((v) => !v)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        seekRef.current(tRef.current + 300)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        seekRef.current(tRef.current - 300)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [presentation, enterPresentation, exitPresentation])

  // 系统全屏被用户按 Esc 退出时，同步退出演示模式
  useEffect(() => {
    const onFs = () => {
      if (!document.fullscreenElement && presentation) setPresentation(false)
    }
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [presentation])

  // 鼠标静止时自动隐藏控制条，避免遮挡画面
  useEffect(() => {
    if (!presentation) {
      setHudVisible(true)
      return
    }
    let timer = 0
    const wake = () => {
      setHudVisible(true)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setHudVisible(false), 2600)
    }
    wake()
    window.addEventListener('mousemove', wake)
    window.addEventListener('keydown', wake)
    window.addEventListener('touchstart', wake)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('mousemove', wake)
      window.removeEventListener('keydown', wake)
      window.removeEventListener('touchstart', wake)
    }
  }, [presentation])

  const seek = (nt: number) => {
    tRef.current = Math.max(0, Math.min(dur, nt))
    setT(tRef.current)
  }

  // 快捷键回调需要稳定引用，避免每次渲染重建监听
  const seekRef = useRef(seek)
  useEffect(() => {
    seekRef.current = seek
  })

  const progressPct = (t / dur) * 100

  return (
    <div className={presentation ? 'app presenting' : 'app'}>
      <header className="topbar">
        <div className="brand">
          <h1>MapReduce Shuffle 过程可视化</h1>
          <p>基于确定性仿真内核 · 每一次播放都可复现、可拖拽、可调参</p>
        </div>
        <div className="topbar-right">
          <div className="modes" role="tablist" aria-label="视图模式">
            <button
              role="tab"
              aria-selected={autoCam}
              className={autoCam ? 'chip-btn active' : 'chip-btn'}
              onClick={() => {
                setAutoCam(true)
                setMode('overview')
              }}
              title="镜头自动跟随讲解节奏切换"
            >
              自动镜头
            </button>
            {(
              [
                ['overview', '全局拓扑'],
                ['map', 'Map 端特写'],
                ['reduce', 'Reduce 端特写'],
              ] as [Mode, string][]
            ).map(([m, name]) => (
              <button
                key={m}
                role="tab"
                aria-selected={!autoCam && mode === m}
                className={!autoCam && mode === m ? 'chip-btn active' : 'chip-btn'}
                onClick={() => {
                  setAutoCam(false)
                  setMode(m)
                  if (m === 'map' && focusMap == null) setFocusMap(0)
                  if (m === 'reduce' && focusReducer == null) setFocusReducer(0)
                }}
              >
                {name}
              </button>
            ))}
          </div>
          <button
            className="fold-btn"
            onClick={() => setSideOpen((v) => !v)}
            aria-label={sideOpen ? '收起侧栏' : '展开侧栏'}
            aria-pressed={!sideOpen}
            title={sideOpen ? '收起侧栏（快捷键 D）' : '展开侧栏（快捷键 D）'}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d={sideOpen ? 'M5 2.5 L9 7 L5 11.5' : 'M9 2.5 L5 7 L9 11.5'}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            className="fold-btn present-btn"
            onClick={() => void enterPresentation()}
            aria-label="进入演示模式"
            title="演示模式：隐藏界面全屏播放（快捷键 F）"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d="M1.5 5 V1.5 H5 M9 1.5 H12.5 V5 M12.5 9 V12.5 H9 M5 12.5 H1.5 V9"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </header>

      <main className={sideOpen ? 'main' : 'main side-collapsed'}>
        <section className="stage-wrap">
          <div className="stage" ref={wrapRef}>
            <canvas ref={canvasRef} className="stage-canvas" />
            <TopologyLayer
              sim={sim}
              mode={mode}
              focusMap={focusMap}
              focusReducer={focusReducer}
              onPickMap={(id) => {
                setFocusMap(id)
                setMode('map')
              }}
              onPickReducer={(id) => {
                setFocusReducer(id)
                setMode('reduce')
              }}
              hoverPartition={hoverPartition}
              onHoverPartition={setHoverPartition}
            />
          </div>

          {/* 侧栏收起时，讲解内容移到这里 —— 在画布之外，不遮挡任何画面 */}
          {!sideOpen && (
            <div className="narrate-bar">
              <span className={`dot d-${beat?.kind ?? 'map'}`} />
              <span className="narrate-bar-title">{beat?.title ?? '准备中'}</span>
              <span className="narrate-bar-text">{beat?.text ?? ''}</span>
              <span className="narrate-bar-stats">
                读入 <b>{sim.stats.tokensIn}</b> · 写出 <b>{sim.stats.entriesOut}</b> ·
                传输 <b>{sim.stats.bytesWithCombiner}</b>B
              </span>
            </div>
          )}

          {/* 时间轴 */}
          <div className="timeline">
            <button
              className="play-btn"
              onClick={() => {
                if (tRef.current >= dur) {
                  tRef.current = 0
                }
                setPlaying(!playing)
              }}
              aria-label={playing ? '暂停' : '播放'}
            >
              {playing ? '❚❚' : '▶'}
            </button>
            <button className="step-btn" onClick={() => seek(tRef.current - 120)} aria-label="后退">
              ‹
            </button>
            <button className="step-btn" onClick={() => seek(tRef.current + 120)} aria-label="前进">
              ›
            </button>

            <div className="track-wrap">
              <input
                className="track"
                type="range"
                min={0}
                max={dur}
                step={10}
                value={t}
                onChange={(e) => seek(Number(e.target.value))}
                aria-label="时间轴进度"
                style={
                  {
                    '--pct': `${progressPct}%`,
                  } as React.CSSProperties
                }
              />
              <div className="beat-marks" aria-hidden="true">
                {sim.beats.map((b, i) => (
                  <span
                    key={i}
                    className={`beat-mark bm-${b.kind} ${i === beatIdx ? 'cur' : ''}`}
                    style={{ left: `${(b.t / dur) * 100}%` }}
                    title={b.title}
                  />
                ))}
              </div>
            </div>

            <div className="time-text">
              {(t / 1000).toFixed(2)}s / {(dur / 1000).toFixed(2)}s
              <span className="eta" title="按当前速度，从头播完全程所需时间">
                · 全程 {(dur / 1000 / speed).toFixed(1)}s
              </span>
            </div>

            <SpeedPicker speed={speed} onChange={setSpeed} dur={dur} />
            <button className="chip-btn small" onClick={reset}>
              重置
            </button>
          </div>
        </section>

        <aside className="side">
          {/* 讲解面板 */}
          <section className="panel narrate">
            <div className="panel-head">
              <span className={`dot d-${beat?.kind ?? 'map'}`} />
              <h2>{beat?.title ?? '准备中'}</h2>
            </div>
            <p className="narrate-text">{beat?.text ?? ''}</p>
            <div className="beat-nav">
              <button
                className="chip-btn small"
                disabled={beatIdx === 0}
                onClick={() => {
                  const i = Math.max(0, beatIdx - 1)
                  seek(sim.beats[i].t)
                }}
              >
                上一步
              </button>
              <span className="beat-pos">
                {beatIdx + 1} / {sim.beats.length}
              </span>
              <button
                className="chip-btn small"
                disabled={beatIdx >= sim.beats.length - 1}
                onClick={() => {
                  const i = Math.min(sim.beats.length - 1, beatIdx + 1)
                  seek(sim.beats[i].t)
                }}
              >
                下一步
              </button>
            </div>
          </section>

          {/* 参数面板 */}
          <section className="panel">
            <h3>参数</h3>

            <div className="ctrl">
              <label>
                Map 任务数 <b>{config.numMaps}</b>
              </label>
              <input
                type="range"
                min={1}
                max={5}
                value={config.numMaps}
                onChange={(e) => updateConfig({ numMaps: Number(e.target.value) })}
              />
            </div>

            <div className="ctrl">
              <label>
                Reduce 任务数 <b>{config.numReducers}</b>
              </label>
              <input
                type="range"
                min={1}
                max={5}
                value={config.numReducers}
                onChange={(e) => updateConfig({ numReducers: Number(e.target.value) })}
              />
            </div>

            <div className="ctrl">
              <label>
                缓冲区容量 <b>{config.bufferSize} 条</b>
              </label>
              <input
                type="range"
                min={4}
                max={30}
                value={config.bufferSize}
                onChange={(e) => updateConfig({ bufferSize: Number(e.target.value) })}
              />
            </div>

            <div className="ctrl">
              <label>
                数据倾斜 <b>{Math.round(config.skew * 100)}%</b>
              </label>
              <input
                type="range"
                min={0}
                max={0.6}
                step={0.05}
                value={config.skew}
                onChange={(e) => updateConfig({ skew: Number(e.target.value) })}
              />
            </div>

            <div className="ctrl">
              <label>
                每 Map 输入量 <b>{config.inputPerMap} 条</b>
              </label>
              <input
                type="range"
                min={12}
                max={120}
                step={6}
                value={config.inputPerMap}
                onChange={(e) => updateConfig({ inputPerMap: Number(e.target.value) })}
              />
            </div>

            <div className="ctrl row">
              <label className="switch">
                <input
                  type="checkbox"
                  checked={config.combiner}
                  onChange={(e) => updateConfig({ combiner: e.target.checked })}
                />
                <span>启用 Combiner</span>
              </label>
            </div>

            <div className="ctrl row">
              <label className="switch">
                <input
                  type="checkbox"
                  checked={showFlow}
                  onChange={(e) => setShowFlow(e.target.checked)}
                />
                <span>显示数据流动画</span>
              </label>
            </div>

            <div className="scenarios">
              <h4>场景预设</h4>
              <div className="scen-grid">
                <button
                  className="chip-btn small"
                  onClick={() => updateConfig({ ...DEFAULT_CONFIG, combiner: true, skew: 0 })}
                >
                  标准
                </button>
                <button
                  className="chip-btn small"
                  onClick={() => updateConfig({ ...DEFAULT_CONFIG, combiner: false })}
                >
                  无 Combiner
                </button>
                <button
                  className="chip-btn small"
                  onClick={() => updateConfig({ ...DEFAULT_CONFIG, skew: 0.45 })}
                >
                  数据倾斜
                </button>
                <button
                  className="chip-btn small"
                  onClick={() => updateConfig({ ...DEFAULT_CONFIG, bufferSize: 5 })}
                >
                  频繁溢写
                </button>
              </div>
            </div>
          </section>

          {/* 统计面板 */}
          <section className="panel">
            <h3>本次运行</h3>
            <div className="stats">
              <Metric label="Map 端读入" value={sim.stats.tokensIn} unit="条" />
              <Metric label="Map 端写出" value={sim.stats.entriesOut} unit="条" />
              <Metric label="溢写文件" value={sim.stats.spillFiles} unit="个" />
              <Metric label="网络传输" value={sim.stats.bytesWithCombiner} unit="B" />
            </div>
            {config.combiner && (
              <div className="saved">
                <span className="saved-label">Combiner 节省</span>
                <div className="saved-bar">
                  <div
                    className="saved-fill"
                    style={{
                      width: `${(sim.stats.bytesWithCombiner / Math.max(1, sim.stats.bytesWithoutCombiner)) * 100}%`,
                    }}
                  />
                </div>
                <span className="saved-num">
                  {Math.round(
                    (1 - sim.stats.bytesWithCombiner / Math.max(1, sim.stats.bytesWithoutCombiner)) *
                      100,
                  )}
                  %
                </span>
              </div>
            )}
            <div className="partition-bars">
              <h4>各分区数据量</h4>
              {sim.partitionSizes.map((n, p) => {
                const max = Math.max(...sim.partitionSizes, 1)
                const r = partitionRamp(p)
                return (
                  <div key={p} className="pbar">
                    <span className="pbar-label">P{p}</span>
                    <div className="pbar-track">
                      <div
                        className="pbar-fill"
                        style={{
                          width: `${(n / max) * 100}%`,
                          background: C[r].mid,
                        }}
                      />
                    </div>
                    <span className="pbar-num">{n}</span>
                  </div>
                )
              })}
              {sim.partitionSizes.length > 1 &&
                Math.max(...sim.partitionSizes) >
                  Math.min(...sim.partitionSizes) * 1.6 && (
                  <p className="warn">分区不均：最重的分区比最轻的多出数倍，Reducer 之间会出现明显拖尾。</p>
                )}
            </div>
          </section>
        </aside>
      </main>

      {/* 演示模式悬浮控制条：鼠标静止后自动淡出，移动鼠标恢复 */}
      {presentation && (
        <div className={`present-hud${hudVisible ? '' : ' hidden'}`}>
          <div className="hud-beat">
            <span className={`dot d-${beat?.kind ?? 'map'}`} />
            <span className="hud-beat-title">{beat?.title ?? ''}</span>
            <span className="hud-beat-text">{beat?.text ?? ''}</span>
          </div>
          <div className="hud-bar">
            <button
              className="play-btn"
              onClick={() => setPlaying((v) => !v)}
              aria-label={playing ? '暂停' : '播放'}
            >
              {playing ? '❚❚' : '▶'}
            </button>
            <button className="step-btn" onClick={() => seek(tRef.current - 120)} aria-label="后退">
              ‹
            </button>
            <button className="step-btn" onClick={() => seek(tRef.current + 120)} aria-label="前进">
              ›
            </button>
            <div className="hud-track-wrap">
              <input
                className="track"
                type="range"
                min={0}
                max={dur}
                step={10}
                value={t}
                onChange={(e) => seek(Number(e.target.value))}
                aria-label="时间轴进度"
                style={{ '--pct': `${progressPct}%` } as React.CSSProperties}
              />
            </div>
            <div className="time-text">
              {(t / 1000).toFixed(1)}s / {(dur / 1000).toFixed(1)}s
            </div>
            <SpeedPicker speed={speed} onChange={setSpeed} dur={dur} />
            <button className="chip-btn small" onClick={exitPresentation}>
              退出 (Esc)
            </button>
          </div>
        </div>
      )}

      <footer className="legend">
        <span className="lg-title">图例</span>
        {sim.config.numReducers <= 5 &&
          sim.reducers.map((rd) => {
            const r = partitionRamp(rd.partition)
            return (
              <span key={rd.reducerId} className="lg-item">
                <span className="lg-swatch" style={{ background: C[r].mid, borderColor: C[r].stroke }} />
                颜色 = 目标 Reduce {rd.reducerId}（分区 {rd.partition}）
              </span>
            )
          })}
        <span className="lg-item">纵向位置 = 来源 Map</span>
        <span className="lg-item">悬停 Reduce 可高亮其分区</span>
        <span className="lg-item lg-dim">
          阶段耗时：溢写 {TIME.SPILL}ms · 合并 {TIME.MERGE}ms · 传输 {TIME.TRANSIT}ms
        </span>
      </footer>
    </div>
  )
}

function Metric({ label, value, unit }: { label: string; value: number; unit: string }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className="metric-value">
        {value.toLocaleString()}
        <em>{unit}</em>
      </span>
    </div>
  )
}

/**
 * 倍速选择器：平时只显示当前速度（省下横向空间给进度条），
 * 点击后弹出全部档位。演示时切换快，讲解时也不会挤占画面。
 */
function SpeedPicker({
  speed,
  onChange,
  dur,
}: {
  speed: number
  onChange: (s: number) => void
  dur: number
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="speed-picker" ref={ref}>
      <button
        className="chip-btn small speed-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        title={`播放速度 ${speed}× · 播完全程约需 ${(dur / 1000 / speed).toFixed(1)} 秒`}
      >
        {speed}×
        <span className="caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="speed-menu" role="menu">
          <div className="speed-menu-head">播放速度</div>
          {SPEEDS.map((s) => (
            <button
              key={s}
              role="menuitemradio"
              aria-checked={speed === s}
              className={speed === s ? 'speed-item active' : 'speed-item'}
              onClick={() => {
                onChange(s)
                setOpen(false)
              }}
            >
              <span className="speed-val">{s}×</span>
              <span className="speed-eta">全程 {(dur / 1000 / s).toFixed(1)}s</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

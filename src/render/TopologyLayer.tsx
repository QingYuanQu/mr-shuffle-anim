import { useEffect, useRef } from 'react'
import {
  MAP_X,
  MAP_W,
  RED_X,
  RED_W,
  VIEW_H,
  VIEW_W,
  mapBoxH,
  mapBoxY,
  reducerBoxH,
  reducerBoxY,
} from './layout'
import { C, partitionRamp, ramp } from './theme'
import type { SimResult } from '../sim/engine'

interface Props {
  sim: SimResult
  mode: 'overview' | 'map' | 'reduce'
  focusMap: number | null
  focusReducer: number | null
  onPickMap?: (id: number) => void
  onPickReducer?: (id: number) => void
  hoverPartition: number | null
  onHoverPartition: (p: number | null) => void
}

/**
 * SVG 拓扑层：画结构性骨架。
 * 数据流由 Canvas 绘制，本层负责边框、标签、交互热区与高亮。
 * 两层使用完全相同的坐标系，因此数据块会精确地飞向它要去的那个 reducer。
 */
export function TopologyLayer({
  sim,
  mode,
  focusMap,
  focusReducer,
  onPickMap,
  onPickReducer,
  hoverPartition,
  onHoverPartition,
}: Props) {
  const nMaps = sim.maps.length
  const nReds = sim.reducers.length
  const mH = mapBoxH(nMaps)
  const rH = reducerBoxH(nReds)
  const svgRef = useRef<SVGSVGElement>(null)

  // 鼠标位置 -> 分区，用于悬停高亮
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onMove = (ev: MouseEvent) => {
      const rect = svg.getBoundingClientRect()
      const x = ((ev.clientX - rect.left) / rect.width) * VIEW_W
      const y = ((ev.clientY - rect.top) / rect.height) * VIEW_H
      let found: number | null = null
      for (const rd of sim.reducers) {
        const ry = reducerBoxY(rd.reducerId, nReds)
        if (x >= RED_X && x <= RED_X + RED_W && y >= ry && y <= ry + rH) {
          found = rd.partition
        }
      }
      onHoverPartition(found)
    }
    svg.addEventListener('mousemove', onMove)
    svg.addEventListener('mouseleave', () => onHoverPartition(null))
    return () => {
      svg.removeEventListener('mousemove', onMove)
      svg.removeEventListener('mouseleave', () => onHoverPartition(null))
    }
  }, [sim, nReds, rH, onHoverPartition])

  if (mode !== 'overview') return null

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      aria-hidden="true"
    >
      {/* 列标题 */}
      <text x={MAP_X} y={68} className="tp-col">
        Map 端（{nMaps} 个任务）
      </text>
      <text x={RED_X} y={68} className="tp-col">
        Reduce 端（{nReds} 个任务）
      </text>

      {/* Map 框热区 */}
      {sim.maps.map((mp) => {
        const y = mapBoxY(mp.mapId, nMaps)
        const active = focusMap === mp.mapId
        return (
          <g key={`m${mp.mapId}`}>
            <rect
              x={MAP_X}
              y={y}
              width={MAP_W}
              height={mH}
              rx={8}
              fill="transparent"
              stroke={active ? C.blue.stroke : 'transparent'}
              strokeWidth={active ? 1.5 : 0}
              style={{ cursor: 'pointer' }}
              onClick={() => onPickMap?.(mp.mapId)}
            />
          </g>
        )
      })}

      {/* Reduce 框热区 + 分区色标 */}
      {sim.reducers.map((rd) => {
        const y = reducerBoxY(rd.reducerId, nReds)
        const active = focusReducer === rd.reducerId
        const dim = hoverPartition != null && hoverPartition !== rd.partition
        return (
          <g key={`r${rd.reducerId}`}>
            <rect
              x={RED_X}
              y={y}
              width={RED_W}
              height={rH}
              rx={8}
              fill="transparent"
              stroke={active ? rampStroke(rd.partition) : 'transparent'}
              strokeWidth={active ? 1.5 : 0}
              opacity={dim ? 0.35 : 1}
              style={{ cursor: 'pointer' }}
              onClick={() => onPickReducer?.(rd.reducerId)}
            />
            <rect
              x={RED_X}
              y={y}
              width={RED_W}
              height={rH}
              rx={8}
              fill="none"
              stroke={hoverPartition === rd.partition ? rampStroke(rd.partition) : 'transparent'}
              strokeWidth={1.5}
              pointerEvents="none"
            />
          </g>
        )
      })}
    </svg>
  )
}

function rampStroke(p: number): string {
  return ramp(partitionRamp(p)).stroke
}

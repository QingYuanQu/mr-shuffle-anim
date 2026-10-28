import { hashKey, mulberry32 } from './rng'

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

export interface SimConfig {
  numMaps: number
  numReducers: number
  /** 环形缓冲区容量（条），写满即触发溢写 */
  bufferSize: number
  /** 是否启用 Map 端 Combiner */
  combiner: boolean
  /** 数据倾斜强度 0~1：越大越多记录落在热点 key 上 */
  skew: number
  /** 每个 Map 任务处理的输入记录数 */
  inputPerMap: number
  seed: number
}

export const DEFAULT_CONFIG: SimConfig = {
  numMaps: 3,
  numReducers: 3,
  bufferSize: 10,
  combiner: true,
  skew: 0,
  inputPerMap: 30,
  seed: 20240517,
}

/** 各阶段耗时（毫秒，仿真时间轴） */
export const TIME = {
  EMIT: 16, // 读一条输入并调用 map()
  SPILL: 340, // 溢写一次：排序 + combine + 落盘
  SPILL_SORT: 0.4, // 溢写内排序阶段占比
  SPILL_COMBINE: 0.25, // 溢写内合并阶段占比
  SPILL_WRITE: 0.35, // 溢写内写盘阶段占比
  MERGE: 280, // Map 端合并所有溢写文件
  CONNECT: 90, // Reducer 与 Map 建立连接
  FETCH_WINDOW: 240, // 单个分区数据传输窗口
  TRANSIT: 130, // 网络传输时延
  MERGE_STEP: 70, // 归并每输出一个 entry
  REDUCE_STEP: 60, // 每组调用一次 reduce
  GROUP_GAP: 30, // 分组到 reduce 之间的间隔
} as const

/* ------------------------------------------------------------------ *
 * 数据结构
 * ------------------------------------------------------------------ */

export type StopKind =
  | 'emitted'
  | 'buffer'
  | 'spill'
  | 'merged'
  | 'flight'
  | 'rbuf'
  | 'merge'
  | 'group'
  | 'out'

export type AbsorbKind = 'spill' | 'merge' | 'group'

export interface Stop {
  kind: StopKind
  tIn: number
  tOut: number
}

export interface Token {
  id: number
  key: string
  value: number
  mapId: number
  partition: number
  emitT: number
  /** 被 Combiner / reduce 吸收掉的记录，指向直接吸收者（可能自身也被吸收，形成链） */
  absorbedBy: number | null
  /** 沿吸收链一直追溯到的最终存活者 */
  finalOwnerId: number
  absorbT: number | null
  absorbKind: AbsorbKind | null
  /** 该记录所属的溢写文件序号 */
  spillIndex: number
  /** 写入溢写文件的时刻 */
  spillWriteT: number
  stops: Stop[]
}

export interface Entry {
  key: string
  value: number
  partition: number
  ownerTokenId: number
  absorbedTokenIds: number[]
  spillIndex: number
  spillWriteT: number
  mergedIndex: number
  mergedT: number
  fetchDepartT: number
  fetchArriveT: number
  mergeStepT: number
  mergeIndex: number
  groupIndex: number
  groupT: number
  reduceT: number
  outT: number
}

export interface SpillFile {
  index: number
  startT: number
  endT: number
  entries: Entry[]
}

export interface PartitionIndex {
  partition: number
  offset: number
  count: number
  minKey: string
  maxKey: string
}

export interface MapSide {
  mapId: number
  startT: number
  tokens: Token[]
  spills: SpillFile[]
  merged: Entry[]
  index: PartitionIndex[]
  mergeStartT: number
  commitT: number
  spillCount: number
  /** 该 Map 因 Combiner 而少写出的记录数 */
  combinerSaved: number
}

export interface MergeStep {
  t: number
  key: string
  fromMapIds: number[]
  entry: Entry
}

export interface GroupInfo {
  key: string
  entries: Entry[]
  startT: number
  reduceT: number
  outT: number
  value: number
}

export interface ReducerSide {
  reducerId: number
  partition: number
  streams: { mapId: number; entries: Entry[] }[]
  mergeStartT: number
  mergeSteps: MergeStep[]
  merged: Entry[]
  groups: GroupInfo[]
  output: { key: string; value: number; outT: number }[]
  endT: number
}

export interface Beat {
  t: number
  kind: 'map' | 'spill' | 'commit' | 'fetch' | 'merge' | 'group' | 'reduce' | 'done'
  title: string
  text: string
  focus?: { map?: number; reducer?: number }
}

export interface SimStats {
  tokensIn: number
  entriesOut: number
  bytesWithCombiner: number
  bytesWithoutCombiner: number
  spillFiles: number
  groups: number
  outputRows: number
  /** 若关闭 Combiner，同一 Map 内的同 key 记录会多写出的条数 */
  combinerSavedTokens: number
}

export interface SimResult {
  config: SimConfig
  maps: MapSide[]
  reducers: ReducerSide[]
  tokens: Token[]
  duration: number
  stats: SimStats
  beats: Beat[]
  partitionSizes: number[]
}

/* ------------------------------------------------------------------ *
 * 数据集
 * ------------------------------------------------------------------ */

export const VOCAB = [
  'apple', 'banana', 'cherry', 'date', 'elder',
  'fig', 'grape', 'honey', 'kiwi', 'lemon',
  'mango', 'melon',
]
export const HOT_KEY = 'honey'

interface RawRec {
  key: string
  value: number
}

function genInput(rng: () => number, count: number, skew: number): RawRec[] {
  const out: RawRec[] = []
  for (let i = 0; i < count; i++) {
    const isHot = rng() < skew
    const key = isHot ? HOT_KEY : VOCAB[Math.floor(rng() * VOCAB.length)]
    out.push({ key, value: 1 + Math.floor(rng() * 3) })
  }
  return out
}

function cmpEntry(a: { partition: number; key: string }, b: { partition: number; key: string }) {
  if (a.partition !== b.partition) return a.partition - b.partition
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

/* ------------------------------------------------------------------ *
 * 主仿真
 * ------------------------------------------------------------------ */

/** 内核实现。withBaseline 控制是否额外跑一遍"关闭 Combiner"用于对比统计。 */
function simulateCore(config: SimConfig, withBaseline: boolean): SimResult {
  const rng = mulberry32(config.seed)
  const tokens: Token[] = []
  const maps: MapSide[] = []
  const tokenById = new Map<number, Token>()

  let tokenId = 0

  for (let m = 0; m < config.numMaps; m++) {
    const mapId = m
    const mapStart = m * 60
    const recs = genInput(rng, config.inputPerMap, config.skew)
    const mapTokens: Token[] = []
    const spills: SpillFile[] = []
    let buffer: Token[] = []
    let clock = mapStart
    let i = 0

    while (i < recs.length || buffer.length > 0) {
      if (buffer.length < config.bufferSize && i < recs.length) {
        const r = recs[i++]
        const tok: Token = {
          id: tokenId++,
          key: r.key,
          value: r.value,
          mapId,
          partition: hashKey(r.key) % config.numReducers,
          emitT: clock,
          absorbedBy: null,
          finalOwnerId: tokenId,
          absorbT: null,
          absorbKind: null,
          spillIndex: -1,
          spillWriteT: 0,
          stops: [],
        }
        tokens.push(tok)
        tokenById.set(tok.id, tok)
        mapTokens.push(tok)
        buffer.push(tok)
        clock += TIME.EMIT
      } else {
        // ---------------- 溢写 ----------------
        const spillIndex = spills.length
        const startT = clock
        const sortEndT = startT + TIME.SPILL * TIME.SPILL_SORT
        const combineEndT = sortEndT + TIME.SPILL * TIME.SPILL_COMBINE
        const writeEndT = combineEndT + TIME.SPILL * TIME.SPILL_WRITE
        const sorted = [...buffer].sort((a, b) => cmpEntry(a, b))

        const entries: Entry[] = []
        const mkEntry = (winner: Token, absorbed: Token[]): Entry => {
          let value = winner.value
          for (const a of absorbed) value += a.value
          return {
            key: winner.key,
            value,
            partition: winner.partition,
            ownerTokenId: winner.id,
            absorbedTokenIds: absorbed.map((a) => a.id),
            spillIndex,
            spillWriteT: writeEndT,
            mergedIndex: 0,
            mergedT: 0,
            fetchDepartT: 0,
            fetchArriveT: 0,
            mergeStepT: 0,
            mergeIndex: 0,
            groupIndex: 0,
            groupT: 0,
            reduceT: 0,
            outT: 0,
          }
        }

        if (config.combiner) {
          // 同 (分区, key) 的记录在 Map 端就地合并
          let p = 0
          while (p < sorted.length) {
            let q = p
            while (
              q + 1 < sorted.length &&
              sorted[q + 1].partition === sorted[p].partition &&
              sorted[q + 1].key === sorted[p].key
            ) q++
            const group = sorted.slice(p, q + 1)
            const winner = group[0]
            const absorbed = group.slice(1)
            const absorbT = sortEndT + TIME.SPILL * TIME.SPILL_COMBINE * 0.5
            for (const t of absorbed) {
              t.absorbedBy = winner.id
              t.absorbT = absorbT
              t.absorbKind = 'spill'
              t.spillIndex = spillIndex
              t.spillWriteT = writeEndT
            }
            winner.spillIndex = spillIndex
            winner.spillWriteT = writeEndT
            entries.push(mkEntry(winner, absorbed))
            p = q + 1
          }
        } else {
          for (const t of sorted) {
            t.spillIndex = spillIndex
            t.spillWriteT = writeEndT
            entries.push(mkEntry(t, []))
          }
        }

        clock = writeEndT
        spills.push({ index: spillIndex, startT, endT: clock, entries })
        buffer = []
      }
    }

    // ---------------- 合并所有溢写文件 → 单个大文件 + 索引 ----------------
    const mergeStartT = clock
    const all = spills.flatMap((s) => s.entries).sort(cmpEntry)
    const merged: Entry[] = []

    if (config.combiner) {
      let p = 0
      while (p < all.length) {
        let q = p
        while (
          q + 1 < all.length &&
          all[q + 1].partition === all[p].partition &&
          all[q + 1].key === all[p].key
        ) q++
        const group = all.slice(p, q + 1)
        const owner = group[0]
        let total = 0
        const absorbedToks: number[] = []
        for (const e of group) {
          total += e.value
          absorbedToks.push(...e.absorbedTokenIds)
        }
        // 跨溢写文件的同 key 记录，在合并阶段再次被 combiner 吸收
        for (const e of group.slice(1)) {
          const t = tokenById.get(e.ownerTokenId)
          if (t && t.absorbedBy === null) {
            t.absorbedBy = owner.ownerTokenId
            t.absorbT = mergeStartT + TIME.MERGE * 0.5
            t.absorbKind = 'merge'
          }
        }
        merged.push({
          ...owner,
          value: total,
          absorbedTokenIds: absorbedToks,
          mergedIndex: merged.length,
          mergedT: mergeStartT + (TIME.MERGE * merged.length) / Math.max(1, all.length),
        })
        p = q + 1
      }
    } else {
      all.forEach((e, idx) => {
        merged.push({
          ...e,
          mergedIndex: idx,
          mergedT: mergeStartT + (TIME.MERGE * idx) / Math.max(1, all.length),
        })
      })
    }

    // ---------------- 索引 ----------------
    const index: PartitionIndex[] = []
    for (let p = 0; p < config.numReducers; p++) {
      const slice = merged.filter((e) => e.partition === p)
      index.push({
        partition: p,
        offset: merged.findIndex((e) => e.partition === p),
        count: slice.length,
        minKey: slice.length ? slice[0].key : '-',
        maxKey: slice.length ? slice[slice.length - 1].key : '-',
      })
    }

    const commitT = mergeStartT + TIME.MERGE
    const combinerSaved = mapTokens.filter((t) => t.absorbKind === 'spill' || t.absorbKind === 'merge').length
    maps.push({
      mapId,
      startT: mapStart,
      tokens: mapTokens,
      spills,
      merged,
      index,
      mergeStartT,
      commitT,
      spillCount: spills.length,
      combinerSaved,
    })
  }

  // ---------------- Reducer：拉取 → K 路归并 → 分组 → reduce ----------------
  const reducers: ReducerSide[] = []
  for (let r = 0; r < config.numReducers; r++) {
    const streams = maps.map((mp) => ({
      mapId: mp.mapId,
      entries: mp.merged.filter((e) => e.partition === r),
    }))

    let mergeStartT = 0
    streams.forEach((st, si) => {
      const mapCommit = maps[si].commitT
      const fetchStart = mapCommit + TIME.CONNECT + si * 12
      const n = st.entries.length
      st.entries.forEach((e, j) => {
        e.fetchDepartT = fetchStart + (n > 1 ? (j / n) * TIME.FETCH_WINDOW : 0)
        e.fetchArriveT = e.fetchDepartT + TIME.TRANSIT
      })
      const last = n ? st.entries[n - 1].fetchArriveT : fetchStart
      mergeStartT = Math.max(mergeStartT, last)
    })
    mergeStartT += TIME.GROUP_GAP

    // K 路归并：每次取各路队首的最小者
    const ptr = streams.map(() => 0)
    const mergeSteps: MergeStep[] = []
    const merged: Entry[] = []
    for (;;) {
      let best = -1
      let bestKey = ''
      for (let s = 0; s < streams.length; s++) {
        const cur = streams[s].entries[ptr[s]]
        if (!cur) continue
        if (best === -1 || cur.key < bestKey) {
          best = s
          bestKey = cur.key
        }
      }
      if (best === -1) break
      const e = streams[best].entries[ptr[best]]
      e.mergeStepT = mergeStartT + mergeSteps.length * TIME.MERGE_STEP
      e.mergeIndex = merged.length
      mergeSteps.push({ t: e.mergeStepT, key: e.key, fromMapIds: [streams[best].mapId], entry: e })
      merged.push(e)
      ptr[best]++
    }

    // 分组：归并流里连续的相同 key 归为一组
    const groups: GroupInfo[] = []
    let gi = 0
    while (gi < merged.length) {
      let gj = gi
      while (gj + 1 < merged.length && merged[gj + 1].key === merged[gi].key) gj++
      const groupEntries = merged.slice(gi, gj + 1)
      const owner = groupEntries[0]
      const startT = owner.mergeStepT
      const reduceT = startT + TIME.REDUCE_STEP
      const outT = reduceT + 20
      let total = 0
      for (const e of groupEntries) total += e.value
      for (const e of groupEntries.slice(1)) {
        const t = tokenById.get(e.ownerTokenId)
        if (t && t.absorbedBy === null) {
          t.absorbedBy = owner.ownerTokenId
          t.absorbT = startT + TIME.REDUCE_STEP * 0.5
          t.absorbKind = 'group'
        }
      }
      for (const e of groupEntries) {
        e.groupIndex = groups.length
        e.groupT = startT
        e.reduceT = reduceT
        e.outT = outT
      }
      groups.push({ key: owner.key, entries: groupEntries, startT, reduceT, outT, value: total })
      gi = gj + 1
    }

    const output = groups.map((g) => ({ key: g.key, value: g.value, outT: g.outT }))
    const endT = groups.length ? groups[groups.length - 1].outT + 60 : mergeStartT

    reducers.push({
      reducerId: r,
      partition: r,
      streams,
      mergeStartT,
      mergeSteps,
      merged,
      groups,
      output,
      endT,
    })
  }

  // ---------------- 组装每条记录的旅程 ----------------
  for (const mp of maps) {
    for (const tk of mp.tokens) {
      tk.stops.push({ kind: 'emitted', tIn: tk.emitT, tOut: tk.emitT + TIME.EMIT * 1.5 })
      tk.stops.push({ kind: 'buffer', tIn: tk.emitT + TIME.EMIT * 1.5, tOut: tk.spillWriteT })
      if (tk.absorbKind !== 'spill') {
        tk.stops.push({ kind: 'spill', tIn: tk.spillWriteT, tOut: 0 })
      }
    }
  }
  for (const mp of maps) {
    for (const e of mp.merged) {
      const t = tokenById.get(e.ownerTokenId)
      if (!t) continue
      const spillStop = t.stops.find((s) => s.kind === 'spill')
      if (spillStop) spillStop.tOut = e.mergedT
      t.stops.push({ kind: 'merged', tIn: e.mergedT, tOut: e.fetchDepartT })
    }
  }
  for (const rd of reducers) {
    for (const e of rd.merged) {
      const t = tokenById.get(e.ownerTokenId)
      if (!t) continue
      t.stops.push({ kind: 'flight', tIn: e.fetchDepartT, tOut: e.fetchArriveT })
      t.stops.push({ kind: 'rbuf', tIn: e.fetchArriveT, tOut: e.mergeStepT })
      t.stops.push({ kind: 'merge', tIn: e.mergeStepT, tOut: e.groupT })
      t.stops.push({ kind: 'group', tIn: e.groupT, tOut: e.reduceT })
      t.stops.push({ kind: 'out', tIn: e.reduceT, tOut: 1e9 })
    }
  }
  // 吸收类记录：在被吸收的时刻截断旅程
  for (const t of tokens) {
    if (t.absorbT == null) continue
    const stage: AbsorbKind = t.absorbKind as AbsorbKind
    const idx =
      stage === 'spill'
        ? t.stops.findIndex((s) => s.kind === 'buffer')
        : stage === 'merge'
          ? t.stops.findIndex((s) => s.kind === 'spill')
          : t.stops.findIndex((s) => s.kind === 'merge')
    if (idx >= 0) t.stops[idx].tOut = t.absorbT
  }

  // 解析吸收链：A 被 B 吸收、B 又被 C 吸收时，A 的最终归属是 C。
  // 链式吸收是真实语义 —— combiner 的中间结果会继续向下折叠。
  {
    const resolveFinal = (id: number): number => {
      const seen = new Set<number>()
      let cur = id
      for (;;) {
        if (seen.has(cur)) return cur // 成环保护
        seen.add(cur)
        const tk = tokenById.get(cur)
        if (!tk || tk.absorbedBy == null) return cur
        cur = tk.absorbedBy
      }
    }
    for (const t of tokens) {
      t.finalOwnerId = t.absorbedBy != null ? resolveFinal(t.absorbedBy) : t.id
    }
  }

  for (const t of tokens) {
    t.stops = t.stops.filter((s) => s.tOut > s.tIn)
    t.stops.sort((a, b) => a.tIn - b.tIn)
  }

  // ---------------- 统计 ----------------
  const bytesOf = (entries: Entry[]) => entries.reduce((s, e) => s + e.key.length + 8, 0)
  const withCombiner = maps.reduce((s, mp) => s + bytesOf(mp.merged), 0)
  let withoutCombiner = withCombiner
  if (withBaseline) {
    const alt = simulateCore({ ...config, combiner: false }, false)
    withoutCombiner = alt.maps.reduce((s, mp) => s + bytesOf(mp.merged), 0)
  }

  const partitionSizes = new Array(config.numReducers).fill(0)
  for (const mp of maps) for (const e of mp.merged) partitionSizes[e.partition] += 1

  const stats: SimStats = {
    tokensIn: tokens.length,
    entriesOut: maps.reduce((s, mp) => s + mp.merged.length, 0),
    bytesWithCombiner: withCombiner,
    bytesWithoutCombiner: withoutCombiner,
    spillFiles: maps.reduce((s, mp) => s + mp.spillCount, 0),
    groups: reducers.reduce((s, rd) => s + rd.groups.length, 0),
    outputRows: reducers.reduce((s, rd) => s + rd.output.length, 0),
    combinerSavedTokens: maps.reduce((s, mp) => s + mp.combinerSaved, 0),
  }

  // ---------------- 讲解节拍 ----------------
  const beats: Beat[] = [
    {
      t: 0,
      kind: 'map',
      title: 'Map 任务启动',
      text: `每个 Map 读取一个输入分片，逐条调用 map()，把结果写进内存中的环形缓冲区。缓冲区容量 ${config.bufferSize} 条。`,
    },
  ]
  const firstSpill = maps
    .flatMap((mp) => mp.spills.map((s) => ({ mp, s })))
    .sort((a, b) => a.s.startT - b.s.startT)[0]
  if (firstSpill) {
    beats.push({
      t: firstSpill.s.startT,
      kind: 'spill',
      title: '缓冲区写满，触发溢写',
      text:
        '内存装不下了，Map 停下来做溢写：把缓冲区里的记录按 (分区, key) 排序' +
        (config.combiner ? '，对同一分区内相同 key 的 value 先做局部求和（Combiner），' : '，') +
        '再写成一个溢写文件落盘，缓冲区腾空后继续处理输入。',
      focus: { map: firstSpill.mp.mapId },
    })
  }
  const firstCommit = [...maps].sort((a, b) => a.commitT - b.commitT)[0]
  beats.push({
    t: firstCommit.commitT,
    kind: 'commit',
    title: 'Map 任务提交',
    text: '所有溢写文件被归并成一个大文件，同时生成索引：记下每个分区在大文件里的偏移、条数和 key 范围。Reducer 之后按索引精确读取自己那一段，不用传输无关数据。',
    focus: { map: firstCommit.mapId },
  })
  const firstFetch = reducers
    .flatMap((rd) => rd.streams.flatMap((st) => st.entries))
    .sort((a, b) => a.fetchDepartT - b.fetchDepartT)[0]
  if (firstFetch) {
    beats.push({
      t: firstFetch.fetchDepartT,
      kind: 'fetch',
      title: 'Reducer 主动拉取',
      text: '数据不是 Map 推给 Reducer 的，而是 Reducer 拿着索引主动去每个 Map 拉取。Map 还没提交时，Reducer 只能等；Map 一提交，连接立刻建立。',
    })
  }
  const firstMerge = [...reducers].sort((a, b) => a.mergeStartT - b.mergeStartT)[0]
  if (firstMerge) {
    beats.push({
      t: firstMerge.mergeStartT,
      kind: 'merge',
      title: 'K 路归并',
      text: `Reducer 收到 ${config.numMaps} 段各自有序的数据流，做 K 路归并：每次比较各路队首，取最小的输出。因为每一段内部已经有序，相同 key 在归并后必然相邻。`,
      focus: { reducer: firstMerge.reducerId },
    })
  }
  const firstGroup = reducers
    .flatMap((rd) => rd.groups.map((g) => ({ g, rd })))
    .sort((a, b) => a.g.startT - b.g.startT)[0]
  if (firstGroup) {
    beats.push({
      t: firstGroup.g.startT,
      kind: 'group',
      title: '相同 key 归为一组',
      text: '归并流里连续的相同 key，就是这个 key 的全部 value。Reducer 把它们合成一组，一次调用 reduce()，产出最终结果的一行。',
      focus: { reducer: firstGroup.rd.reducerId },
    })
  }
  const lastOut = reducers.flatMap((r) => r.output).sort((a, b) => a.outT - b.outT).pop()
  if (lastOut) {
    beats.push({
      t: lastOut.outT,
      kind: 'reduce',
      title: '写出最终结果',
      text: '每个 key 一行输出。走到这一步，MapReduce 才算真正把"分散在各个 Map 上的同 key 数据"重新聚合到了一起。',
    })
  }
  beats.sort((a, b) => a.t - b.t)

  const duration =
    Math.max(...reducers.map((r) => r.endT), ...maps.map((m) => m.commitT)) + 200

  return { config, maps, reducers, tokens, duration, stats, beats, partitionSizes }
}

/**
 * 运行一次完整仿真。
 * 结果完全由 config 决定 —— 同样的 config 永远得到同样的时间轴与状态。
 */
export function simulate(config: SimConfig): SimResult {
  return simulateCore(config, true)
}

/* ------------------------------------------------------------------ *
 * 查询辅助（供渲染层使用）
 * ------------------------------------------------------------------ */

/** 某一时刻某 Map 缓冲区里的记录（尚未被溢写带走） */
export function bufferTokens(map: MapSide, t: number): Token[] {
  return map.tokens.filter((tk) => {
    const s = tk.stops.find((x) => x.kind === 'buffer')
    return !!s && t >= s.tIn && t < s.tOut
  })
}

/** 某一时刻已经落盘的溢写文件 */
export function completedSpills(map: MapSide, t: number): SpillFile[] {
  return map.spills.filter((s) => t >= s.endT)
}

/** 正在进行中的溢写（用于展示排序/合并过程） */
export function activeSpill(map: MapSide, t: number): SpillFile | null {
  for (const s of map.spills) if (t >= s.startT && t < s.endT) return s
  return null
}

/** 某一时刻已进入合并大文件的 entry */
export function mergedEntries(map: MapSide, t: number): Entry[] {
  return map.merged.filter((e) => e.mergedT <= t)
}

/** 记录在 t 时刻的状态 */
export function stopAt(tok: Token, t: number): { kind: StopKind; stop: Stop | null } {
  for (const s of tok.stops) {
    if (t >= s.tIn && t < s.tOut) return { kind: s.kind, stop: s }
  }
  const next = tok.stops.find((s) => s.tIn > t)
  if (next) return { kind: next.kind, stop: next }
  const last = tok.stops[tok.stops.length - 1]
  return { kind: last ? last.kind : 'emitted', stop: last ?? null }
}

/** 归并阶段：t 时刻各路（来自不同 Map）的队首 */
export function mergeHeads(rd: ReducerSide, t: number): { mapId: number; entry: Entry | null }[] {
  return rd.streams.map((st) => {
    const done = rd.merged.filter((e) => e.mergeStepT <= t && st.entries.includes(e)).length
    return { mapId: st.mapId, entry: st.entries[done] ?? null }
  })
}

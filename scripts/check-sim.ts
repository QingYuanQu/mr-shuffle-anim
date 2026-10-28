/**
 * 仿真内核校验：确认动画里呈现的因果链是真的正确的。
 * 运行：npm run check
 */
import {
  DEFAULT_CONFIG,
  HOT_KEY,
  TIME,
  simulate,
  stopAt,
  type SimConfig,
} from '../src/sim/engine'
import { hashKey } from '../src/sim/rng'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? '  ' + detail : ''}`)
  } else {
    failures++
    console.log(`  \x1b[31m✗ ${name}\x1b[0m  ${detail}`)
  }
}

function runSuite(label: string, config: SimConfig) {
  console.log(`\n\x1b[1m${label}\x1b[0m`)
  const sim = simulate(config)

  /* 1. 分区正确性：同一 key 必须落到同一个 reducer */
  {
    const keyToPartition = new Map<string, number>()
    let ok = true
    let bad = ''
    for (const t of sim.tokens) {
      const expect = hashKey(t.key) % config.numReducers
      if (t.partition !== expect) {
        ok = false
        bad = `token ${t.id} key=${t.key} partition=${t.partition} expect=${expect}`
        break
      }
      const prev = keyToPartition.get(t.key)
      if (prev !== undefined && prev !== expect) {
        ok = false
        bad = `key=${t.key} 出现在分区 ${prev} 和 ${expect}`
        break
      }
      keyToPartition.set(t.key, expect)
    }
    check('分区由 hash(key) % numReducers 决定，同 key 同分区', ok, bad)
  }

  /* 2. 输出分区正确：key 的归组必须发生在它所属的 reducer 上 */
  {
    let ok = true
    let bad = ''
    for (const rd of sim.reducers) {
      for (const g of rd.groups) {
        const expect = hashKey(g.key) % config.numReducers
        if (expect !== rd.reducerId) {
          ok = false
          bad = `key=${g.key} 应在 reducer ${expect}，却在 ${rd.reducerId}`
          break
        }
      }
      if (!ok) break
    }
    check('每个 key 的归组发生在正确的 reducer 上', ok, bad)
  }

  /* 3. 值守恒：所有输入 token 的 value 之和 == 所有输出的 value 之和 */
  {
    const inSum = sim.tokens.reduce((s, t) => s + t.value, 0)
    const outSum = sim.reducers.reduce(
      (s, rd) => s + rd.output.reduce((x, o) => x + o.value, 0),
      0,
    )
    check(
      'value 守恒：输入总和 == 输出总和',
      inSum === outSum,
      `输入 ${inSum} / 输出 ${outSum}`,
    )
  }

  /* 4. 归并后相同 key 必相邻（这是 reduce 能分组的唯一前提） */
  {
    let ok = true
    let bad = ''
    for (const rd of sim.reducers) {
      // 同 key 的所有出现必须连续：一旦离开某 key，就不能再回来
      const closed = new Set<string>()
      let prev: string | null = null
      for (const e of rd.merged) {
        if (e.key !== prev) {
          if (closed.has(e.key)) {
            ok = false
            bad = `reducer ${rd.reducerId} 的 key=${e.key} 不相邻`
            break
          }
          if (prev !== null) closed.add(prev)
          prev = e.key
        }
      }
      if (!ok) break
    }
    check('K 路归并后相同 key 必然相邻', ok, bad)
  }

  /* 5. Map 端合并文件内，分区有序且分区内 key 有序 */
  {
    let ok = true
    let bad = ''
    for (const mp of sim.maps) {
      for (let i = 1; i < mp.merged.length; i++) {
        const a = mp.merged[i - 1]
        const b = mp.merged[i]
        if (a.partition > b.partition || (a.partition === b.partition && a.key > b.key)) {
          ok = false
          bad = `map ${mp.mapId} 第 ${i} 项未有序`
          break
        }
      }
      if (!ok) break
    }
    check('Map 端合并文件按 (分区, key) 有序', ok, bad)
  }

  /* 6. 索引正确：索引指向的分区段与实际内容吻合 */
  {
    let ok = true
    let bad = ''
    for (const mp of sim.maps) {
      for (const idx of mp.index) {
        const slice = mp.merged.filter((e) => e.partition === idx.partition)
        if (slice.length !== idx.count) {
          ok = false
          bad = `map ${mp.mapId} 分区 ${idx.partition} 索引条数 ${idx.count} != 实际 ${slice.length}`
          break
        }
        if (slice.length) {
          if (slice[0].key !== idx.minKey || slice[slice.length - 1].key !== idx.maxKey) {
            ok = false
            bad = `map ${mp.mapId} 分区 ${idx.partition} key 范围不符`
            break
          }
        }
      }
      if (!ok) break
    }
    check('合并文件索引（偏移/条数/key 范围）与实际一致', ok, bad)
  }

  /* 7. Combiner 确实减少了写出量，且只在同分区内合并 */
  {
    const withC = simulate({ ...config, combiner: true })
    const withoutC = simulate({ ...config, combiner: false })
    const outCount = withC.stats.entriesOut
    const noCount = withoutC.stats.entriesOut
    if (config.combiner) {
      check(
        'Combiner 减少了写出记录数',
        outCount <= noCount,
        `${noCount} → ${outCount} 条`,
      )
      check(
        'Combiner 减少了网络传输字节',
        withC.stats.bytesWithCombiner <= withC.stats.bytesWithoutCombiner,
        `${withC.stats.bytesWithoutCombiner} → ${withC.stats.bytesWithCombiner} B`,
      )
    } else {
      // 关闭 Combiner 时，Map 端不应发生任何合并：写出的条数应等于输入条数
      check(
        '关闭 Combiner 时 Map 端不发生合并',
        sim.stats.entriesOut === sim.stats.tokensIn,
        `输入 ${sim.stats.tokensIn} 条 → 写出 ${sim.stats.entriesOut} 条`,
      )
    }
  }

  /* 8. 生命周期：每条记录的 stop 序列单调递增、无空隙倒挂 */
  {
    let ok = true
    let bad = ''
    for (const t of sim.tokens) {
      if (t.stops.length === 0) {
        ok = false
        bad = `token ${t.id} 没有任何 stop`
        break
      }
      for (let i = 1; i < t.stops.length; i++) {
        if (t.stops[i].tIn < t.stops[i - 1].tIn) {
          ok = false
          bad = `token ${t.id} 的 stop 序列倒挂`
          break
        }
        if (t.stops[i].tOut <= t.stops[i].tIn) {
          ok = false
          bad = `token ${t.id} 的 stop ${t.stops[i].kind} 区间非法`
          break
        }
      }
      if (!ok) break
    }
    check('每条记录的旅程区间合法且单调', ok, bad)
  }

  /* 9. 吸收关系自洽：沿链可追溯到最终存活者，且同 key 同分区 */
  {
    let ok = true
    let bad = ''
    const byId = new Map(sim.tokens.map((t) => [t.id, t]))
    for (const t of sim.tokens) {
      if (t.absorbedBy == null) continue
      const owner = byId.get(t.absorbedBy)
      if (!owner) {
        ok = false
        bad = `token ${t.id} 指向不存在的 owner`
        break
      }
      if (owner.key !== t.key || owner.partition !== t.partition) {
        ok = false
        bad = `token ${t.id} 与 owner 的 key/分区不一致`
        break
      }
      // 链式吸收是合法的：owner 自己也可能被吸收，但必须能追溯到唯一的最终存活者
      const final = byId.get(t.finalOwnerId)
      if (!final) {
        ok = false
        bad = `token ${t.id} 的最终存活者不存在`
        break
      }
      if (final.absorbedBy != null) {
        ok = false
        bad = `token ${t.id} 的最终存活者仍被吸收`
        break
      }
      if (final.key !== t.key || final.partition !== t.partition) {
        ok = false
        bad = `token ${t.id} 的最终存活者 key/分区不一致`
        break
      }
    }
    check('Combiner/reduce 的吸收链自洽且能追溯到唯一存活者', ok, bad)
  }

  /* 10. 时序：Map 提交早于该分区的拉取；拉取早于归并 */
  {
    let ok = true
    let bad = ''
    for (const rd of sim.reducers) {
      for (const st of rd.streams) {
        const mapCommit = sim.maps[st.mapId].commitT
        for (const e of st.entries) {
          if (e.fetchDepartT < mapCommit) {
            ok = false
            bad = `reducer ${rd.reducerId} 在 map ${st.mapId} 提交前就开始拉取`
            break
          }
          if (e.fetchArriveT < e.fetchDepartT) {
            ok = false
            bad = '传输到达时间早于出发时间'
            break
          }
        }
      }
      if (!ok) break
    }
    check('时序：Map 提交 → 拉取 → 到达，顺序正确', ok, bad)
  }

  /* 11. 归并步骤数与归并流长度一致 */
  {
    let ok = true
    let bad = ''
    for (const rd of sim.reducers) {
      if (rd.mergeSteps.length !== rd.merged.length) {
        ok = false
        bad = `reducer ${rd.reducerId} 归并步骤 ${rd.mergeSteps.length} != 流长度 ${rd.merged.length}`
        break
      }
    }
    check('归并步骤与归并流一一对应', ok, bad)
  }

  /* 12. 时间轴完整：任意时刻都能定位到状态，不越界 */
  {
    let ok = true
    let bad = ''
    for (const t of sim.tokens) {
      const s = stopAt(t, 0)
      if (!s.stop) {
        ok = false
        bad = `token ${t.id} 在 t=0 无状态`
        break
      }
      const s2 = stopAt(t, sim.duration)
      if (!s2.stop) {
        ok = false
        bad = `token ${t.id} 在 t=duration 无状态`
        break
      }
    }
    check('时间轴端点无越界', ok, bad)
  }

  /* 13. 溢写文件数 = ceil(记录数 / 缓冲区容量) */
  {
    let ok = true
    let bad = ''
    for (const mp of sim.maps) {
      const expect = Math.ceil(mp.tokens.length / config.bufferSize)
      if (mp.spillCount !== expect) {
        ok = false
        bad = `map ${mp.mapId} 溢写 ${mp.spillCount} 次，期望 ${expect}`
        break
      }
    }
    check('溢写次数 = ceil(记录数 / 缓冲区容量)', ok, bad)
  }

  /* 14. 讲解节拍按时间有序且覆盖全过程 */
  {
    let ok = true
    let bad = ''
    for (let i = 1; i < sim.beats.length; i++) {
      if (sim.beats[i].t < sim.beats[i - 1].t) {
        ok = false
        bad = '节拍时间乱序'
        break
      }
    }
    if (sim.beats.length < 6) {
      ok = false
      bad = `节拍只有 ${sim.beats.length} 条`
    }
    check('讲解节拍有序且完整', ok, bad)
  }

  console.log(
    `  \x1b[2m输入 ${sim.stats.tokensIn} 条 → 写出 ${sim.stats.entriesOut} 条 → 归组 ${sim.stats.groups} 组 → 输出 ${sim.stats.outputRows} 行，时长 ${Math.round(sim.duration)}ms\x1b[0m`,
  )
  return sim
}

/* ---------------------------------------------------------------- */

console.log('\x1b[1mMapReduce Shuffle 仿真内核校验\x1b[0m')

runSuite('默认配置（3 Map / 3 Reducer / Combiner 开）', DEFAULT_CONFIG)
runSuite('关闭 Combiner', { ...DEFAULT_CONFIG, combiner: false })
runSuite('2 Map / 2 Reducer', { ...DEFAULT_CONFIG, numMaps: 2, numReducers: 2 })
runSuite('强数据倾斜（热点 key 占 40%）', { ...DEFAULT_CONFIG, skew: 0.4 })
runSuite('小缓冲区（频繁溢写）', { ...DEFAULT_CONFIG, bufferSize: 4 })
runSuite('单 Reducer', { ...DEFAULT_CONFIG, numReducers: 1 })
runSuite('大输入量', { ...DEFAULT_CONFIG, inputPerMap: 120, numMaps: 4 })

/* 倾斜场景下的分区分布观察 */
{
  console.log('\n\x1b[1m倾斜场景分区分布\x1b[0m')
  const sim = simulate({ ...DEFAULT_CONFIG, skew: 0.4 })
  console.log(
    `  热点 key = ${HOT_KEY}，各分区 entry 数：${sim.partitionSizes.join(' / ')}`,
  )
  const hot = sim.partitionSizes.indexOf(Math.max(...sim.partitionSizes))
  console.log(
    `  最重的分区是 ${hot}，占比 ${Math.round((sim.partitionSizes[hot] / sim.stats.entriesOut) * 100)}%`,
  )
  console.log(
    `  \x1b[2m（时间常量：EMIT=${TIME.EMIT}ms SPILL=${TIME.SPILL}ms MERGE=${TIME.MERGE}ms TRANSIT=${TIME.TRANSIT}ms）\x1b[0m`,
  )
}

console.log(
  failures === 0
    ? '\n\x1b[32m全部校验通过\x1b[0m\n'
    : `\n\x1b[31m${failures} 项校验失败\x1b[0m\n`,
)
process.exit(failures === 0 ? 0 : 1)

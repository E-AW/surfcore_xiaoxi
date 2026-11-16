// socialV2.localTools 开关的回归测试。
//
// 这条开关做的事很少，但一旦做错就是把「仿真会话没有本地工具」这条硬边界
// 悄悄拆了 —— 而且拆得没声音（restrict 不报错、模型照样自我设限）。
// 所以这里钉死四件事：
//   1. 默认（配置里没有 / 是 false）→ 老行为：restrict 逐个装、guard 装上；
//   2. true → 一条都不装（读写/执行类工具可用）；
//   3. 只看 DSH_HOME 下的 config.json，读不到就按 false 处理（配置文件坏了不能变宽松）；
//   4. store 归一化不会把 "true" 字符串、1 这种脏值当成 true。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const MOD = pathToFileURL(path.join(ROOT, 'plugins', 'surfcore', 'qq-tool-restrict.mjs')).href

let pass = 0
let fail = 0
function check(ok, label, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${label}`) } else { fail += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

function makeHome(config) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-localTools-'))
  fs.mkdirSync(path.join(home, 'surfcore'), { recursive: true })
  if (config !== undefined) {
    fs.writeFileSync(path.join(home, 'surfcore', 'config.json'), typeof config === 'string' ? config : JSON.stringify(config))
  }
  return home
}

async function runApply(home, config) {
  const mod = await import(`${MOD}?v=${Math.random()}`)
  const seen = { restrict: 0, guard: 0 }
  const ctx = {
    tools: {
      restrict() { seen.restrict += 1 },
      guard() { seen.guard += 1 }
    },
    on() {}
  }
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    mod.apply(ctx, config)
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  }
  return seen
}

console.log('localTools 开关：')
{
  const seen = await runApply(makeHome({ socialV2: {} }))
  check(seen.restrict > 0 && seen.guard === 1, '默认关闭 → restrict 照装、guard 装上', JSON.stringify(seen))
}
{
  const seen = await runApply(makeHome({ socialV2: { localTools: false } }))
  check(seen.restrict > 0 && seen.guard === 1, 'localTools=false → 与默认一致', JSON.stringify(seen))
}
{
  const seen = await runApply(makeHome({ socialV2: { localTools: true } }), { honorLocalToolsSwitch: true })
  check(seen.restrict === 0 && seen.guard === 0, 'localTools=true → 一条限制都不装', JSON.stringify(seen))
}
{
  // 封闭模式（qq-chat）不声明 honorLocalToolsSwitch：即使全局开了开关，它也必须照装限制。
  const seen = await runApply(makeHome({ socialV2: { localTools: true } }))
  check(seen.restrict > 0 && seen.guard === 1,
    'preset 未声明 honorLocalToolsSwitch → 开关无效（封闭模式 L7 不受影响）', JSON.stringify(seen))
}
{
  const seen = await runApply(makeHome(undefined))
  check(seen.restrict > 0 && seen.guard === 1, '配置文件不存在 → 按关闭处理（不放宽）', JSON.stringify(seen))
}
{
  const seen = await runApply(makeHome('{ 这不是 json'))
  check(seen.restrict > 0 && seen.guard === 1, '配置文件坏掉 → 按关闭处理（不放宽）', JSON.stringify(seen))
}
{
  const seen = await runApply(makeHome({ socialV2: { localTools: 'true' } }))
  check(seen.restrict > 0 && seen.guard === 1, '字符串 "true" 不算打开（必须真是布尔 true）', JSON.stringify(seen))
}

// store 归一化：脏值不能变成 true
{
  const store = await import(pathToFileURL(path.join(ROOT, 'plugins', 'surfcore', 'lib', 'store.js')).href)
  const normalize = store.normalizeQqConfig || null
  if (typeof normalize === 'function') {
    for (const dirty of ['true', 1, {}, []]) {
      const cfg = normalize({ socialV2: { localTools: dirty } })
      check(cfg?.socialV2?.localTools === false, `归一化：localTools=${JSON.stringify(dirty)} → false`)
    }
    const cfg = normalize({ socialV2: { localTools: true } })
    check(cfg?.socialV2?.localTools === true, '归一化：localTools=true → 保持 true')
  } else {
    console.log('  · 跳过归一化断言（store.js 未导出 normalize*）')
  }
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败`)
process.exitCode = fail === 0 ? 0 : 1

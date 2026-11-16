/**
 * tools/check-backticks.mjs —— 检查页面 JS 模板内部是否存在未转义的裸反引号
 */
import { readFileSync } from 'node:fs'

const files = process.argv.slice(2)
const targets = files.length ? files : ['lib/douyin-group.mjs', 'lib/media.mjs']

let bad = 0
for (const file of targets) {
  const src = readFileSync(file, 'utf8')
  const lines = src.split('\n')
  let inTemplate = false
  let startLine = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const ticks = (line.match(/(?<!\\)`/g) || []).length
    if (!inTemplate && ticks > 0) {
      inTemplate = ticks % 2 === 1
      if (inTemplate) startLine = i + 1
      continue
    }
    if (inTemplate && ticks > 0) {
      if (ticks % 2 === 1) inTemplate = false
      else {
        console.log(`✘ ${file}:${i + 1} 模板（始于第 ${startLine} 行）内部出现裸反引号`)
        bad++
      }
    }
  }
}

if (bad === 0) console.log(`✔ 模板反引号检查通过（${targets.join(', ')}）`)
process.exit(bad ? 1 : 0)

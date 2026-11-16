/**
 * lib/hostdeps.mjs —— 从 DSH 宿主树解析 `@deepseek-ai/*`，取不到时降级为本地或等价实现
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF_MODULES = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@deepseek-ai')

function walkUp(start, levels = 6) {
  const out = []
  let dir = start
  for (let i = 0; i < levels && dir; i++) {
    const p = join(dir, 'node_modules', '@deepseek-ai')
    if (!out.includes(p)) out.push(p)
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return out
}

export function candidateRoots() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_HOST_MODULES)
  push(process.env.DSH_APP_MODULES)

  try {
    const exeDir = dirname(process.execPath)
    push(join(exeDir, 'resources', 'app', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(exeDir, 'resources', 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(exeDir, 'resources', 'app', 'node_modules', '@deepseek-ai'))
    for (const p of walkUp(exeDir, 4)) push(p)
  } catch { /* ignore */ }

  try { for (const p of walkUp(process.cwd(), 5)) push(p) } catch { /* ignore */ }

  const localAppData = process.env.LOCALAPPDATA
  if (localAppData) {
    push(join(localAppData, 'Programs', 'DeepSeek Harness', 'resources', 'app', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(localAppData, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai'))
  }

  const appdata = process.env.APPDATA
  if (appdata) {
    const npm = join(appdata, 'npm', 'node_modules')
    push(join(npm, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(npm, '@deepseek-ai'))
    try {
      for (const n of readdirSync(join(npm, '@deepseek-ai'))) {
        push(join(npm, '@deepseek-ai', n, 'node_modules', '@deepseek-ai'))
      }
    } catch { /* ignore */ }
  }

  push('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  push('/usr/local/lib/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai')

  try {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    for (const p of readdirSync(join(dshHome, 'profiles'))) {
      push(join(dshHome, 'profiles', p, 'node_modules', '@deepseek-ai'))
    }
  } catch { /* ignore */ }

  push(SELF_MODULES)
  return out
}

function entryUrlFor(root, name) {
  try {
    const dir = join(root, name)
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) return null
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    const dot = pkg.exports?.['.']
    const rel = typeof dot === 'string'
      ? dot
      : (dot?.import || dot?.default || pkg.module || pkg.main)
    if (!rel) return null
    const file = join(dir, String(rel).replace(/^\.\//, ''))
    return existsSync(file) ? pathToFileURL(file).href : null
  } catch { return null }
}

async function fromHostTree(name, log) {
  const fails = []
  for (const root of candidateRoots()) {
    if (root === SELF_MODULES) continue
    const url = entryUrlFor(root, name)
    if (!url) continue
    try {
      const mod = await import(url)
      log(`${name}：从宿主树取到`)
      return mod
    } catch (e) { fails.push(`${e?.code || 'ERR'}:${root}`) }
  }
  if (fails.length) log(`${name}：宿主树不可用（${fails.slice(0, 3).join(' ')}）`)
  return null
}

function localDefineTool(options, log) {
  const check = (schema, where) => {
    if (!schema || typeof schema !== 'object') return
    if (schema.type === 'object' && schema.additionalProperties === undefined) {
      throw new Error(`defineTool(${options.name}): ${where} 是 object 却没写 additionalProperties`)
    }
    for (const [k, v] of Object.entries(schema.properties || {})) check(v, `${where}.properties.${k}`)
  }
  check(options.parameters, 'parameters')
  check(options.output?.schema, 'output.schema')
  log?.(`dsh-tools 不可用，使用本地等价实现（${options.name}）`)
  return options
}

function localCreateUserMessage(input) {
  return {
    ...structuredClone(input),
    role: 'user',
    id: randomUUID(),
  }
}

export async function loadHostDeps() {
  const notes = []
  const log = (m) => notes.push(m)

  let zMod = await fromHostTree('schemastery', log)
  if (!zMod) {
    try {
      zMod = await import('@deepseek-ai/schemastery')
      log('schemastery：从自身依赖加载')
    } catch (e) {
      log(`schemastery 不可用（${e?.code || e?.message || ''}），跳过 Config schema`)
    }
  }
  const z = zMod?.default ?? zMod ?? null

  let dtMod = await fromHostTree('dsh-tools', log)
  if (!dtMod) {
    try {
      dtMod = await import('@deepseek-ai/dsh-tools')
      log('dsh-tools：从自身依赖加载')
    } catch {
      dtMod = null
      log('dsh-tools 不可用，使用本地等价实现')
    }
  }
  const defineTool = dtMod?.defineTool || ((options) => localDefineTool(options, log))

  let llmMod = await fromHostTree('dsh-llm', log)
  if (!llmMod) {
    try {
      llmMod = await import('@deepseek-ai/dsh-llm')
      log('dsh-llm：从自身依赖加载')
    } catch {
      llmMod = null
      log('dsh-llm 不可用，使用本地 createUserMessage')
    }
  }
  const createUserMessage = llmMod?.createUserMessage || localCreateUserMessage

  return { z, defineTool, createUserMessage, notes }
}

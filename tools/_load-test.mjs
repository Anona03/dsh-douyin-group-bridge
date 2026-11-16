/**
 * tools/_load-test.mjs —— 模拟 DSH Cordis Proxy 陷阱的加载自检
 */
import { pathToFileURL, fileURLToPath } from 'node:url'

const mod = await import(pathToFileURL(fileURLToPath(new URL('../index.js', import.meta.url))).href)

const KNOWN_SERVICES = [
  'tools', 'agents', 'sessions', 'agentLoop', 'webServer', 'systemPrompt',
  'agentPresets', 'attachments', 'agentDefaultModel', 'connection', 'hmr',
  'loader', 'logger', 'reflect', 'events', 'registry', 'effect', 'plugin',
  'inject', 'get', 'on', 'emit', 'waterfall',
]

const registered = []
const injectedDeps = []
const effects = []
const injectCallbacks = []

function makeCtx(declared) {
  const base = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    tools: { register: (t) => { registered.push(t.name); return () => {} } },
    effect: (fn, label) => { effects.push(label); return () => {} },
    inject: (deps, cb) => {
      injectedDeps.push(deps)
      injectCallbacks.push({ deps, cb })
      return () => {}
    },
    get: (name) => (declared.includes(name) ? (base[name] ?? {}) : undefined),
    on: () => () => {},
    emit: () => {},
    webServer: { register: () => () => {}, port: 0 },
    attachments: { saveImages: async () => [] },
  }
  return new Proxy(base, {
    get(target, prop) {
      if (typeof prop === 'symbol' || String(prop).startsWith('_')) return Reflect.get(target, prop)
      if (Reflect.has(target, prop)) return Reflect.get(target, prop)
      if (KNOWN_SERVICES.includes(prop) && !declared.includes(prop)) {
        throw new Error(`cannot get property "${String(prop)}" without inject`)
      }
      return undefined
    },
  })
}

const config = {
  enabled: true,
  mode: 'simulation',
  triggerMode: 'mention',
  pollIntervalMs: 5000,
  groups: [],
  mentionAliases: ['DeepSeek'],
  contextMessages: 8,
  maxInjectChars: 4000,
  browserPort: 47882,
}

let failed = 0

try {
  const ctx = makeCtx(['tools'])
  const dispose = await mod.apply(ctx, config)
  console.log('✔ apply() 成功')
  console.log('  注册的工具:', registered.length, registered.join(', '))
  console.log('  inject 的依赖:', JSON.stringify(injectedDeps))
  if (typeof dispose === 'function') dispose()
} catch (e) {
  failed++
  console.error('✘ apply() 失败:', e?.message)
  console.error(e?.stack)
}

for (const { deps, cb } of injectCallbacks) {
  try {
    const scoped = makeCtx(['tools', ...deps])
    const res = await cb(scoped)
    if (typeof res === 'function') res()
    console.log(`✔ inject ${JSON.stringify(deps)} 回调执行通过`)
  } catch (e) {
    failed++
    console.error(`✘ inject ${JSON.stringify(deps)} 回调失败:`, e?.message)
    console.error(e?.stack)
  }
}

if (failed > 0) process.exit(1)
console.log('✔ Cordis Proxy 加载测试全部通过')

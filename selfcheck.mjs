#!/usr/bin/env node
/**
 * selfcheck.mjs —— 安装前本地完整性与契约自检
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import vm from 'node:vm'

const ROOT = dirname(fileURLToPath(import.meta.url))
let failures = 0
let warnings = 0

const ok = (m) => console.log(`  ✔ ${m}`)
const bad = (m) => { failures++; console.log(`  ✘ ${m}`) }
const warn = (m) => { warnings++; console.log(`  ! ${m}`) }
const head = (m) => console.log(`\n── ${m}`)

/* 1. 必备文件 */
head('必备文件')
const required = [
  'index.js', 'client.js', 'cordis.patch.yml', 'package.json',
  'prompts/duty.md', 'prompts/persona.md', 'locale/en.json', 'locale/zh.json', 'icon.svg',
  'README.md', 'LICENSE',
  'lib/browser.mjs', 'lib/douyin-group.mjs', 'lib/state.mjs', 'lib/bridge.mjs',
  'lib/hostdeps.mjs', 'lib/media.mjs', 'lib/selectors.mjs', 'lib/session-history.mjs',
]
for (const f of required) {
  const p = join(ROOT, f)
  if (!existsSync(p)) bad(`缺少 ${f}`)
  else if (statSync(p).size === 0) bad(`${f} 为空文件`)
}
if (failures === 0) ok(`${required.length} 个必备文件齐备`)

/* 2. 语法检查 */
head('模块语法')
const jsFiles = [
  'index.js', 'client.js',
  'lib/browser.mjs', 'lib/douyin-group.mjs', 'lib/state.mjs', 'lib/bridge.mjs',
  'lib/hostdeps.mjs', 'lib/media.mjs', 'lib/selectors.mjs', 'lib/session-history.mjs',
]
for (const f of jsFiles) {
  const p = join(ROOT, f)
  if (!existsSync(p)) continue
  try {
    if (f === 'client.js') {
      const src = readFileSync(p, 'utf8')
      new vm.Script(src, { filename: f })
      if (!src.includes('__ModuleLoader__')) throw new Error('缺少 __ModuleLoader__.load 自注册')
      ok(f)
    } else {
      await import(pathToFileURL(p).href)
      ok(f)
    }
  } catch (e) {
    bad(`${f}：${e?.message || e}`)
  }
}

/* 3. package.json */
head('package.json')
try {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  if (pkg.name !== 'dsh-douyin-group-bridge') bad(`name 应为 dsh-douyin-group-bridge，实际为 ${pkg.name}`)
  else ok('name 正确')
  if (pkg.exports?.['.'] !== './index.js') bad('exports["."] 应为 ./index.js')
  if (pkg.exports?.['./client'] !== './client.js') bad('exports["./client"] 应为 ./client.js')
  if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') bad('dsh.bundle.patch 应为 ./cordis.patch.yml')
  if (!pkg.dependencies?.['@deepseek-ai/schemastery']) bad('dependencies 中必须包含 @deepseek-ai/schemastery')
  else ok('exports / bundle / dependencies 均正确')
} catch (e) {
  bad(`package.json 解析失败：${e?.message || e}`)
}

/* 4. cordis.patch.yml */
head('cordis.patch.yml')
try {
  const yml = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  if (!/-\s*insert:/.test(yml) || !/id:\s*douyin-group-bridge/.test(yml) || !/name:\s*dsh-douyin-group-bridge/.test(yml)) {
    bad('cordis.patch.yml 结构不完整')
  } else {
    ok('cordis.patch.yml 结构正确')
  }
} catch (e) { bad(e?.message || e) }

/* 5. locale & icon */
head('locale 与图标')
for (const loc of ['zh', 'en']) {
  const p = join(ROOT, 'locale', `${loc}.json`)
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'))
    if (!j?.meta?.title || !j?.meta?.description) bad(`locale/${loc}.json 缺少 meta.title 或 meta.description`)
    else ok(`locale/${loc}.json 校验通过`)
  } catch (e) { bad(`locale/${loc}.json 解析失败：${e?.message || e}`) }
}
try {
  const svg = readFileSync(join(ROOT, 'icon.svg'), 'utf8')
  if (!/^<svg[\s>]/i.test(svg.trim()) || !svg.includes('</svg>')) bad('icon.svg 不是有效 SVG')
  else ok('icon.svg 校验通过')
} catch (e) { bad(e?.message || e) }

/* 6. 宿主依赖解析 */
head('宿主依赖')
try {
  const { loadHostDeps } = await import(pathToFileURL(join(ROOT, 'lib', 'hostdeps.mjs')).href)
  const deps = await loadHostDeps()
  if (deps.z) ok('已解析到 @deepseek-ai/schemastery')
  else warn('未找到 schemastery（本地无依赖时属正常，装入 DSH 时由 pnpm 安装）')
} catch (e) {
  bad(`hostdeps 检查失败：${e?.message || e}`)
}

/* 7. Cordis Proxy 加载测试 */
head('Cordis Proxy 加载测试')
{
  const r = spawnSync(process.execPath, [join(ROOT, 'tools', '_load-test.mjs')], {
    encoding: 'utf8',
    timeout: 30000,
  })
  if (r.status === 0) ok('Cordis Proxy 模拟加载通过')
  else {
    bad('Cordis Proxy 模拟加载失败')
    console.log(r.stdout || r.stderr)
  }
}

/* 8. 页面 JS 模板反引号检查 */
head('页面 JS 模板反引号检查')
{
  const r = spawnSync(process.execPath, [
    join(ROOT, 'tools', 'check-backticks.mjs'),
    join(ROOT, 'lib', 'douyin-group.mjs'),
    join(ROOT, 'lib', 'media.mjs'),
  ], { encoding: 'utf8', timeout: 20000 })
  if (r.status === 0) ok('无裸反引号')
  else {
    bad('检测到裸反引号')
    console.log(r.stdout || r.stderr)
  }
}

/* 9. 单元测试 */
head('单元测试')
{
  const r = spawnSync(process.execPath, ['--test', join(ROOT, 'test', 'bridge.test.mjs')], {
    encoding: 'utf8',
    timeout: 30000,
  })
  if (r.status === 0) ok('test/bridge.test.mjs 全部通过')
  else {
    bad('单元测试存在失败')
    console.log(r.stdout || r.stderr)
  }
}

console.log(`\n${failures ? '✘' : '✔'} 自检结束：失败 ${failures} 项，警告 ${warnings} 项`)
process.exit(failures ? 1 : 0)

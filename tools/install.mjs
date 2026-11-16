#!/usr/bin/env node
/**
 * tools/install.mjs —— 一键安装或重装本插件到运行中的桌面版 DSH
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { callUnary } from './dsh-rpc.mjs'

const NAME = 'dsh-douyin-group-bridge'
const SPEC = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const reinstall = process.argv.includes('--reinstall')

if (reinstall) {
  console.log('① 移除旧版本...')
  const rm = await callUnary('pluginManager/removeBundle', { name: NAME })
  console.log('  ', JSON.stringify(rm.body?.result?.value ?? rm.body?.result ?? rm.body).slice(0, 300))
  await new Promise((r) => setTimeout(r, 1500))
}

console.log(`安装插件包：${SPEC}`)
const add = await callUnary('pluginManager/installBundle', {
  spec: SPEC,
  options: { enabled: true, requestId: `install-${Date.now()}` },
}, { timeoutMs: 1800000 })

console.log(JSON.stringify(add, null, 2))
const val = add.body?.result?.value
if (add.status !== 200 || add.body?.result?.ok === false || val?.error) {
  process.exit(1)
}

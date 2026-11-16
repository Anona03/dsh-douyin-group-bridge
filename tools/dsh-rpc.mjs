#!/usr/bin/env node
/**
 * tools/dsh-rpc.mjs —— 与运行中的桌面版 DSH 通信（安装本地插件 / 查询状态）
 *
 * 用法：
 *   node tools/dsh-rpc.mjs GET /dsh-douyin-group-bridge/status
 *   node tools/dsh-rpc.mjs pluginManager/installBundle '{"spec":"g:/DSH插件","options":{}}'
 *   node tools/dsh-rpc.mjs pluginManager/listPlugins '{}'
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

function resolveDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function isDshHttp(base) {
  return new Promise((resolve) => {
    let u
    try { u = new URL(base) } catch { return resolve(false) }
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: '/api/pluginManager/list',
      method: 'POST',
      timeout: 2000,
      headers: { 'content-type': 'application/json' },
    }, (res) => { res.resume(); resolve(true) })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.end('{}')
  })
}

async function resolveBaseUrl() {
  if (process.env.DSH_URL) return process.env.DSH_URL.replace(/\/$/, '')
  try {
    const script = [
      "$pids = @(Get-CimInstance Win32_Process -Filter \"Name like '%DeepSeek%'\" | ForEach-Object { $_.ProcessId })",
      "$ports = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $pids -contains $_.OwningProcess } | ForEach-Object { $_.LocalPort } | Sort-Object -Unique)",
      "Write-Output ($ports -join ' ')",
    ].join('; ')
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 15000,
    })
    const ports = String(out).match(/\d{4,5}/g) || []
    for (const p of ports) {
      const url = `http://127.0.0.1:${p}`
      if (await isDshHttp(url)) return url
    }
  } catch { /* fallback */ }

  for (const port of [3080, 64125, 54257, 62942, 43120]) {
    const url = `http://127.0.0.1:${port}`
    if (await isDshHttp(url)) return url
  }
  throw new Error('未探测到运行中的 DeepSeek Harness HTTP 端口，请先启动 DSH 或设置 DSH_URL')
}

const base64url = (buf) => Buffer.from(buf).toString('base64')
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

function readSecret() {
  const file = path.join(resolveDshHome(), '.credentials.yaml')
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  let inRecord = false
  let inPayload = false
  for (const line of lines) {
    if (/^\s{0,4}client-connection\/browser-session:\s*$/.test(line)) { inRecord = true; continue }
    if (inRecord && /^\s{0,4}payload:\s*$/.test(line)) { inPayload = true; continue }
    if (inPayload) {
      const m = line.match(/^\s+secret:\s*['"]?([A-Za-z0-9_-]+)['"]?\s*$/)
      if (m) {
        const decoded = Buffer.from(m[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64')
        if (decoded.byteLength === 32) return decoded
      }
      if (/^\s{0,4}\S/.test(line)) break
    }
  }
  throw new Error('在 .credentials.yaml 中未找到 client-connection/browser-session 密钥')
}

function mintCookie(baseUrl, secret) {
  const authority = new URL(baseUrl).host
  const issuedAt = Date.now()
  const expiresAt = issuedAt + 60 * 60 * 1000
  const body = base64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), 'utf8'))
  const sig = base64url(createHmac('sha256', secret).update(body).digest())
  const name = 'dsh-auth-' + base64url(createHash('sha256').update(authority).digest())
  return `${name}=v1.${body}.${sig}`
}

function httpRequest(baseUrl, reqPath, method, bodyObj, cookie, timeoutMs = 300000) {
  const url = new URL(reqPath, baseUrl)
  const bodyStr = bodyObj !== undefined ? JSON.stringify(bodyObj) : ''
  return new Promise((resolve, reject) => {
    const req = http.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        ...(bodyStr ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bodyStr) } : {}),
        cookie,
      },
    }, (r) => {
      const chunks = []
      r.on('data', (c) => chunks.push(c))
      r.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json
        try { json = JSON.parse(text) } catch { json = { raw: text } }
        resolve({ status: r.statusCode, body: json })
      })
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)))
    if (bodyStr) req.end(bodyStr)
    else req.end()
  })
}

export async function callUnary(endpoint, args = {}, { timeoutMs = 300000 } = {}) {
  const baseUrl = await resolveBaseUrl()
  const cookie = mintCookie(baseUrl, readSecret())
  const msg = { type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } }
  return httpRequest(baseUrl, `/api/${endpoint}`, 'POST', msg, cookie, timeoutMs)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  if (!args.length) {
    console.error('用法: node tools/dsh-rpc.mjs <GET|POST> <path> [json] | <rpcEndpoint> [json]')
    process.exit(1)
  }
  const baseUrl = await resolveBaseUrl()
  const cookie = mintCookie(baseUrl, readSecret())
  let res
  if (args[0] === 'GET' || args[0] === 'POST') {
    const method = args[0]
    const reqPath = args[1]
    const payload = args[2] ? JSON.parse(args[2]) : (method === 'POST' ? {} : undefined)
    res = await httpRequest(baseUrl, reqPath, method, payload, cookie)
  } else {
    const endpoint = args[0]
    const rpcArgs = args[1] ? JSON.parse(args[1]) : {}
    const msg = { type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args: rpcArgs } }
    res = await httpRequest(baseUrl, `/api/${endpoint}`, 'POST', msg, cookie)
  }
  console.log(JSON.stringify(res, null, 2))
}

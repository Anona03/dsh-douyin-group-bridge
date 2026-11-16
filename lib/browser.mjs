/**
 * lib/browser.mjs —— 零依赖 Node 22+ 原生 WebSocket CDP 浏览器控制层
 */
import { spawn, execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const LAUNCH_FLAGS = [
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1440,960',
]

const BROWSER_CANDIDATES = {
  win32: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge'],
}

export function findBrowser(explicit = '') {
  if (explicit && existsSync(explicit)) return explicit
  for (const p of BROWSER_CANDIDATES[process.platform] || []) {
    if (existsSync(p)) return p
  }
  for (const n of ['msedge', 'chrome', 'google-chrome', 'chromium']) {
    const dirs = String(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')
    for (const d of dirs) {
      for (const ext of process.platform === 'win32' ? ['.exe'] : ['']) {
        const f = join(d, n + ext)
        if (existsSync(f)) return f
      }
    }
  }
  return ''
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const REGISTRY = new Map()
const LAUNCHING = new Map()

const psQuote = (s) => String(s).replace(/'/g, "''")

function psExec(script, timeout = 20000) {
  return new Promise((resolve) => {
    try {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        timeout,
        windowsHide: true,
      }, (err, stdout) => resolve(err ? '' : String(stdout || '')))
    } catch { resolve('') }
  })
}

export async function browserProcesses(userDataDir = '', port = 0) {
  if (process.platform !== 'win32') return []
  const dir = psQuote(userDataDir)
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$all = Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='chrome.exe'\"",
    "$hit = $all | Where-Object { $_.CommandLine -and $_.CommandLine -notlike '*--type=*' -and (",
    `  (${dir ? "($_.CommandLine -like ('*' + '" + dir + "' + '*'))" : '$false'}) -or`,
    `  (${port ? `($_.CommandLine -like ('*remote-debugging-port=${port}*'))` : '$false'})`,
    ') }',
    "Write-Output (($hit | ForEach-Object { $_.ProcessId }) -join ',')",
  ].join('\n')
  const out = await psExec(script)
  return out.trim().split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0)
}

export async function killTree(pid) {
  if (!pid || process.platform !== 'win32') return false
  const out = await psExec(`taskkill /PID ${Number(pid)} /T /F 2>&1 | Out-String`, 15000)
  return !/没有找到进程|not found/i.test(out)
}

export function cleanLocks(dir) {
  try {
    for (const f of readdirSync(dir)) {
      if (/^Singleton(Lock|Socket|Cookie)$/.test(f)) {
        try { rmSync(join(dir, f), { force: true }) } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

export class Browser {
  constructor({ exe, userDataDir, port = 47882, log = () => {} }) {
    this.exe = exe
    this.userDataDir = userDataDir
    this.port = port
    this.log = log
    this.proc = null
    this.ws = null
    this.sessionId = null
    this.targetId = null
    this.nextId = 0
    this.pending = new Map()
    this.events = []
    this.ready = false
    this.attached = false
    this.onDead = null
    this.disposed = false
    this.everAttached = false
    this.preloadScripts = []
    this._scriptIds = []
    this._waiters = []
  }

  addPreloadScript(source) {
    if (typeof source !== 'string' || !source) return this
    if (!this.preloadScripts.includes(source)) {
      this.preloadScripts.push(source)
      if (this.ready && this.sessionId) {
        void (async () => {
          try {
            const r = await this.send('Page.addScriptToEvaluateOnNewDocument', { source }, this.sessionId)
            if (r?.identifier) this._scriptIds.push(r.identifier)
          } catch { /* ignore */ }
        })()
      }
    }
    return this
  }

  isAlive() {
    return Boolean(this.ready && this.ws && this.ws.readyState === 1 && !this.disposed)
  }

  get base() { return `http://127.0.0.1:${this.port}` }

  async probePort() {
    try {
      const r = await fetch(`${this.base}/json/version`, { signal: AbortSignal.timeout(2000) })
      if (!r.ok) return null
      return await r.json()
    } catch { return null }
  }

  async connect() {
    const ver = await this.probePort()
    if (!ver) return false
    try {
      await this.#attach(ver.webSocketDebuggerUrl)
      this.attached = true
      return true
    } catch {
      return false
    }
  }

  async launch() {
    if (this.ready) return
    if (!this.exe) {
      throw new Error('找不到 Edge / Chrome 可执行文件，请在配置中指定 browser 路径')
    }

    const existing = await this.probePort()
    if (existing) {
      this.log(`CDP 端口 ${this.port} 已有浏览器（${existing.Browser}），直接复用`)
      const ok = await this.connect()
      if (ok) return
      throw new Error(`CDP 端口 ${this.port} 已被占用但无法连接，请更换 browserPort`)
    }

    const zombies = await browserProcesses(this.userDataDir, this.port)
    if (zombies.length) {
      this.log(`清理 ${zombies.length} 个占着同一 profile/端口的残留进程`)
      for (const pid of zombies) await killTree(pid)
      await sleep(800)
    }
    cleanLocks(this.userDataDir)
    mkdirSync(this.userDataDir, { recursive: true })

    this.proc = spawn(this.exe, [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.userDataDir}`,
      ...LAUNCH_FLAGS,
      'about:blank',
    ], { stdio: 'ignore', windowsHide: false })

    let exited = false
    this.proc.on('exit', (code) => {
      exited = true
      this.log(`浏览器进程退出（code=${code}）`)
      this.proc = null
      const wasReady = this.ready
      this.ready = false
      void (async () => {
        const alive = await this.probePort()
        if (alive) {
          this.ready = wasReady
          this.log('CDP 端口仍可用，浏览器由已有实例接管')
          return
        }
        if (this.everAttached && !this.disposed) this.onDead?.(code)
      })()
    })

    let ver = null
    for (let i = 0; i < 80; i++) {
      if (exited) {
        ver = await this.probePort()
        if (ver) {
          this.attached = true
          break
        }
        throw new Error('浏览器启动后立刻退出，请检查是否已有进程占用同一 userDataDir')
      }
      try {
        const r = await fetch(`${this.base}/json/version`, { signal: AbortSignal.timeout(2000) })
        if (r.ok) { ver = await r.json(); break }
      } catch { /* wait */ }
      await sleep(250)
    }
    if (!ver) throw new Error(`浏览器已启动但 CDP 端口 ${this.port} 未响应`)
    this.log(`浏览器就绪：${ver.Browser}`)
    await this.#attach(ver.webSocketDebuggerUrl)
  }

  async #attach(wsUrl) {
    const ws = new WebSocket(wsUrl)
    this.ws = ws
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('连接 CDP WebSocket 超时')), 15000)
      ws.onopen = () => { clearTimeout(t); res() }
      ws.onerror = () => { clearTimeout(t); rej(new Error('CDP WebSocket 连接失败')) }
    })
    ws.onmessage = (ev) => this.handleMessage(ev)
    ws.onclose = () => {
      if (this.ws !== ws) return
      const wasReady = this.ready
      this.ready = false
      this.ws = null
      if (!wasReady || this.disposed || !this.everAttached) return
      this.onDead?.(-1)
    }

    const { targetInfos } = await this.send('Target.getTargets')
    const page = targetInfos.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
    let targetId = page?.targetId
    if (!targetId) {
      const r = await this.send('Target.createTarget', { url: 'about:blank' })
      targetId = r.targetId
    }

    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true })
    this.targetId = targetId
    this.sessionId = sessionId

    await this.send('Page.enable', {}, sessionId)
    await this.send('Runtime.enable', {}, sessionId)
    await this.send('Network.enable', { maxPostDataSize: 65536 }, sessionId)

    try {
      for (const id of this._scriptIds) {
        await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: id }, sessionId).catch(() => {})
      }
      this._scriptIds = []
      for (const source of this.preloadScripts) {
        try {
          const r = await this.send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId)
          if (r?.identifier) this._scriptIds.push(r.identifier)
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    this.ready = true
    this.everAttached = true
  }

  handleMessage(ev) {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
      else p.resolve(msg.result)
    } else if (msg.method) {
      this.events.push(msg)
      if (this.events.length > 800) this.events.splice(0, 400)
      if (this._waiters.length) {
        for (const w of this._waiters.slice()) {
          if ((!w.method || w.method === msg.method) && (!w.predicate || w.predicate(msg))) {
            this._waiters.splice(this._waiters.indexOf(w), 1)
            clearTimeout(w.timer)
            w.resolve(msg)
          }
        }
      }
    }
  }

  waitForEvent(method, { timeoutMs = 10000, predicate = null } = {}) {
    return new Promise((resolve, reject) => {
      const w = { method, predicate, resolve, reject }
      w.timer = setTimeout(() => {
        const i = this._waiters.indexOf(w)
        if (i >= 0) this._waiters.splice(i, 1)
        reject(new Error(`等待 CDP 事件 ${method} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this._waiters.push(w)
    })
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error('CDP 连接已断开'))
      const id = ++this.nextId
      const t = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} 超时`))
      }, 60000)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v) },
        reject: (e) => { clearTimeout(t); reject(e) },
      })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  async eval(expression, opts = {}) {
    if (!this.ready) throw new Error('浏览器尚未连接')
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: opts.awaitPromise !== false,
      userGesture: true,
    }, this.sessionId)
    if (r.exceptionDetails) {
      throw new Error(`页面 JS 异常：${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`)
    }
    return r.result?.value
  }

  async goto(url, { settleMs = 7000, retries = 2 } = {}) {
    if (!this.ready) throw new Error('浏览器尚未连接')
    this.events = []

    let lastHref = ''
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.send('Page.navigate', { url }, this.sessionId)
      } catch (e) {
        if (attempt >= retries) throw new Error(`导航失败：${e.message}`)
        await sleep(800)
        continue
      }

      await sleep(Math.min(2500, Math.max(800, settleMs / 3)))
      lastHref = await this.eval('location.href').catch(() => '')

      const ok = lastHref
        && lastHref !== 'about:blank'
        && !lastHref.startsWith('chrome-error://')
        && lastHref !== 'chrome://newtab/'

      if (ok) {
        await sleep(Math.max(0, settleMs - 2500))
        return { url: lastHref, attempt }
      }
      if (attempt < retries) await sleep(1000)
    }

    throw new Error(`导航超时：停留在 ${lastHref || '(空)'}`)
  }

  async cookies(urls) {
    const r = await this.send('Network.getCookies', { urls }, this.sessionId)
    return r?.cookies || []
  }

  async screenshot() {
    const r = await this.send('Page.captureScreenshot', { format: 'png' }, this.sessionId)
    return Buffer.from(r.data, 'base64')
  }

  detach() {
    this.disposed = true
    try { this.ws?.close() } catch { /* ignore */ }
    this.ready = false
    this.ws = null
    REGISTRY.delete(String(this.port))
  }
}

export async function getBrowser({ exe, userDataDir, port = 47882, log = () => {}, reuse = true, preloadScripts = [], onDead = null } = {}) {
  const key = String(port || 47882)

  const cached = REGISTRY.get(key)
  if (cached) {
    for (const src of preloadScripts) cached.addPreloadScript(src)
    if (onDead) cached.onDead = onDead
    if (cached.isAlive()) return cached
    REGISTRY.delete(key)
    try { cached.detach() } catch { /* ignore */ }
  }

  if (LAUNCHING.has(key)) return LAUNCHING.get(key)

  const p = (async () => {
    const b = new Browser({ exe: exe || findBrowser(), userDataDir, port, log })
    if (onDead) b.onDead = onDead
    for (const src of preloadScripts) b.addPreloadScript(src)
    if (reuse && await b.connect()) {
      log('已复用运行中的浏览器实例')
      REGISTRY.set(key, b)
      return b
    }
    await b.launch()
    REGISTRY.set(key, b)
    return b
  })()

  LAUNCHING.set(key, p)
  try {
    return await p
  } finally {
    if (LAUNCHING.get(key) === p) LAUNCHING.delete(key)
  }
}

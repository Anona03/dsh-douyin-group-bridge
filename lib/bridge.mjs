/**
 * lib/bridge.mjs —— 抖音群聊 ⇄ DeepSeek Harness 会话桥接核心
 *
 * 数据职责边界：
 *   - 群聊对话内容本体全落在 DSH 的 session 日志中（agent/inbox/spliced + assistant/message）；
 *   - 本插件仅持久化群名 ↔ sessionId 映射、窗口去重指纹与运行配置。
 */
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { getBrowser, findBrowser } from './browser.mjs'
import {
  checkLogin, bringToFront, listConversations, discoverAccountGroups, readGroupMessages, sendGroupMessage, normalizeSingleLine,
} from './douyin-group.mjs'
import { dataUrlToBytes } from './media.mjs'
import { canary } from './selectors.mjs'
import { readGroupHistory } from './session-history.mjs'
import { loadHostDeps } from './hostdeps.mjs'
import {
  loadConfig, saveConfig, loadSessionMap, saveSessionMap, loadDiscoveredGroups, saveDiscoveredGroups,
  groupSession, setGroupSession, hasSeen, markSeen, fingerprint, appendLog,
} from './state.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 进程级单例锁，防止 DSH 热重载期间新旧插件实例同时轮询抢夺浏览器 */
const BRIDGE_LOCK = (globalThis.__douyinGroupBridgeLock ||= {
  owner: 0,
  seq: 0,
  selftest: false,
  lastToggle: 0,
  toggles: 0,
  warned: false,
})

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 构造 `@触发词` 匹配正则（参考 douyin-rpa-bridge） */
export function buildMentionRegex(aliases = []) {
  const cleaned = (Array.isArray(aliases) ? aliases : [])
    .map((a) => String(a || '').trim())
    .filter(Boolean)
    .map(escapeRegExp)
  if (!cleaned.length) cleaned.push('DeepSeek')
  return new RegExp(`@\\s*(?:${cleaned.join('|')})`, 'i')
}

/** 检查文本是否包含 @ 召唤并剥离触发词生成干净问题 */
export function matchMention(text, aliases = []) {
  const raw = String(text || '').trim()
  if (!raw) return { matched: false, cleanQuestion: '' }
  const re = buildMentionRegex(aliases)
  if (!re.test(raw)) return { matched: false, cleanQuestion: '' }
  const globalRe = new RegExp(re.source, 'gi')
  let clean = raw.replace(globalRe, '').replace(/\s+/g, ' ').trim()
  clean = clean.replace(/^[，,：:\s]+/, '').trim()
  if (!clean) clean = '（你在群里 @ 了机器人，主动打了个招呼）'
  return { matched: true, cleanQuestion: clean }
}

/** 窗口位移对比：从 prev 后缀与 cur 前缀最大重合处起截取真正新增的消息 */
export function newFromWindow(prev, cur) {
  if (!prev?.length || !cur?.length) return 0
  for (let overlap = Math.min(prev.length, cur.length); overlap > 0; overlap--) {
    let same = true
    for (let i = 0; i < overlap; i++) {
      if (prev[prev.length - overlap + i] !== cur[i]) {
        same = false
        break
      }
    }
    if (same) return overlap
  }
  return 0
}

/** 构造注入进 DSH 会话的结构化群聊提示（含触发者、净提问与最近 N 条群聊上下文） */
export function formatGroupInjection({ group, sender, question, rawText, recentContext = [], maxChars = 4000 }) {
  const lines = [
    `【抖音群聊 · ${group}】`,
    `触发成员：${sender || '群友'}`,
    `提问内容：${question || rawText || ''}`,
  ]
  if (rawText && rawText !== question) {
    lines.push(`原始消息：${rawText}`)
  }
  if (Array.isArray(recentContext) && recentContext.length) {
    lines.push('最近群聊上下文：')
    for (const c of recentContext) {
      const who = c.fromMe ? '我' : (c.sender || '群友')
      lines.push(`- [${who}]: ${c.text}`)
    }
  }
  return lines.join('\n').slice(0, Math.max(200, Number(maxChars) || 4000))
}

export function extractAssistantText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim()
}

export function sanitizeGroupId(s) {
  return String(s || 'group').replace(/[^0-9A-Za-z_-]/g, '_').slice(0, 28) || 'group'
}

export class DouyinGroupBridge {
  constructor({ ctx, log = () => {} }) {
    this.ctx = ctx
    this.log = (m) => { log(m); appendLog(m) }
    this.cfg = loadConfig()
    this.map = loadSessionMap()
    this.discovered = loadDiscoveredGroups()
    this.browser = null
    this._browserPromise = null
    this.browserClosed = false
    this._relaunchCount = 0
    this._relaunchAt = 0
    this.busy = false
    this.discovering = false
    this.loggedIn = false
    this.waitingLogin = false
    this._loginWatchToken = 0
    this.timer = null
    this.onSessionSetup = null
    this.setCtx = (scoped) => { this.ctx = scoped }
    this.setAttachmentCtx = (scoped) => { this.attCtx = scoped }
    this.service = (name) => {
      try { return this.ctx?.get?.(name) } catch { return undefined }
    }
    this.state = {
      lastPollAt: 0,
      lastError: '',
      consecutiveErrors: 0,
      polls: 0,
      injected: 0,
      sent: 0,
      startedAt: Date.now(),
    }
  }

  async makeUserMessage(input) {
    if (!this._cUM) {
      try {
        const deps = await loadHostDeps()
        this._cUM = deps.createUserMessage
      } catch {
        this._cUM = (i) => ({ ...structuredClone(i), role: 'user', id: randomUUID() })
      }
    }
    return this._cUM(input)
  }

  reloadConfig() {
    this.cfg = loadConfig()
    return this.cfg
  }

  updateConfig(patch) {
    this.cfg = saveConfig({ ...loadConfig(), ...(patch || {}) })
    return this.cfg
  }

  async ensureBrowser({ relaunch = false } = {}) {
    if (this._browserPromise) return this._browserPromise
    this._browserPromise = (async () => {
      if (this.browser && this.browser.isAlive()) return this.browser
      if (this.browser) this.browser = null

      if (this.browserClosed && !relaunch) {
        throw new Error('浏览器窗口已被关闭，桥接暂停中（恢复请调用 douyin_group_login 或在设置页点打开浏览器）')
      }
      if (!relaunch && this._relaunchAt && Date.now() < this._relaunchAt) {
        const wait = Math.ceil((this._relaunchAt - Date.now()) / 1000)
        throw new Error(`浏览器异常退出冷却中，${wait} 秒后再试`)
      }

      const b = await getBrowser({
        exe: this.cfg.browser || findBrowser(),
        userDataDir: this.cfg.userDataDir,
        port: Number(this.cfg.browserPort) || 47882,
        log: (m) => this.log(`浏览器：${m}`),
        reuse: true,
      })
      b.onDead = (code) => this.#onBrowserDead(code)
      this.browser = b
      this.browserClosed = false
      this._relaunchCount = 0
      this._relaunchAt = 0
      return b
    })()

    try {
      return await this._browserPromise
    } finally {
      this._browserPromise = null
    }
  }

  #onBrowserDead(code) {
    const c = Number(code)
    if (c === 0) {
      this.browserClosed = true
      this._relaunchCount = 0
      this._relaunchAt = 0
      this.log('浏览器窗口已关闭，桥接暂停（不会重复弹出窗口）')
      return
    }
    this._relaunchCount = (this._relaunchCount || 0) + 1
    this._relaunchAt = Date.now() + 30000
    if (this._relaunchCount > 3) {
      this.browserClosed = true
      this.log(`浏览器异常退出 ${this._relaunchCount} 次，已暂停自动重连`)
    } else {
      this.log(`浏览器连接中断（code=${c}），30 秒后重试（${this._relaunchCount}/3）`)
    }
  }

  async openLogin() {
    this.browserClosed = false
    this._relaunchCount = 0
    this._relaunchAt = 0
    const b = await this.ensureBrowser({ relaunch: true })
    await bringToFront(b)
    const curHref = await b.eval('location.href').catch(() => '')
    if (!curHref || !/^https:\/\/www\.douyin\.com\//.test(curHref)) {
      await b.goto(this.cfg.douyinUrl || 'https://www.douyin.com/jingxuan', { settleMs: 4500 })
      await bringToFront(b)
    }
    const st = await checkLogin(b)
    this.loggedIn = Boolean(st.loggedIn)
    if (st.loggedIn) {
      this.waitingLogin = false
      this.log('抖音已登录（已将浏览器窗口置顶显示）')
      if (this.cfg.autoDiscoverOnLogin !== false) {
        void this.discoverGroups({ autoWatch: Boolean(this.cfg.autoWatchDiscovered) }).catch((e) => {
          this.log(`自动检索群聊失败：${e?.message || e}`)
        })
      }
      return { ...st, broughtToFront: true }
    }
    this.log('已打开并置顶抖音页面，请扫码登录（登录成功后将自动检索账号内群聊）')
    if (this.cfg.autoDiscoverOnLogin !== false) {
      this.startLoginWatcher()
    }
    return { ...st, waitingLogin: true, broughtToFront: true }
  }

  /**
   * 扫码等待器：用户点击打开浏览器登录后，后台低频检查登录状态；
   * 一旦检测到 sessionid/sessionid_ss 就位，自动检索账号里的群聊。
   */
  startLoginWatcher() {
    const token = ++this._loginWatchToken
    this.waitingLogin = true
    void (async () => {
      try {
        for (let i = 0; i < 72; i++) {
          if (token !== this._loginWatchToken || this.browserClosed) return
          if (!this.browser || !this.browser.isAlive()) return
          const st = await checkLogin(this.browser).catch(() => null)
          if (st?.loggedIn) {
            this.loggedIn = true
            this.waitingLogin = false
            this.log('检测到扫码登录成功，正在自动检索账号内群聊…')
            await this.discoverGroups({ autoWatch: Boolean(this.cfg.autoWatchDiscovered) }).catch((e) => {
              this.log(`登录后自动检索群聊失败：${e?.message || e}`)
            })
            return
          }
          await sleep(2500)
        }
      } finally {
        if (token === this._loginWatchToken) this.waitingLogin = false
      }
    })()
  }

  /**
   * 检索当前已登录抖音账号内的群聊列表，并缓存到本地供设置页与工具直接选用。
   */
  async discoverGroups({ query = '', groupOnly = true, maxScrolls = 10, autoWatch = false } = {}) {
    if (this.discovering) {
      return { ok: false, error: '正在检索群聊中，请稍候', groups: this.discovered.items || [] }
    }
    this.discovering = true
    let timer
    try {
      for (let i = 0; i < 20 && this.busy; i++) await sleep(300)
      const b = await this.ensureBrowser()
      const timeout = new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error('检索群聊超时（25s）')), 25000)
      })
      const r = await Promise.race([
        discoverAccountGroups({ browser: b, query, groupOnly, maxScrolls }),
        timeout,
      ])
      this.loggedIn = Boolean(r.loggedIn)
      if (!r.ok) return r

      // 无关键词过滤时更新全量缓存
      if (!String(query || '').trim()) {
        this.discovered = saveDiscoveredGroups({
          updatedAt: r.discoveredAt || Date.now(),
          items: r.groups || [],
        })
      }

      const names = (r.groups || []).map((g) => g.name)
      this.log(`检索到 ${names.length} 个候选群聊（已确认群=${r.confirmedGroupCount}，共扫描会话=${r.total}）${names.length ? '：' + names.slice(0, 8).join('、') : ''}`)

      if (autoWatch && names.length) {
        const merged = [...new Set([...this.targetGroups(), ...names])]
        this.updateConfig({ groups: merged })
        this.log(`已自动加入监听群聊列表（共 ${merged.length} 个）`)
      }

      return {
        ...r,
        watchedGroups: this.targetGroups(),
      }
    } finally {
      clearTimeout(timer)
      this.discovering = false
    }
  }

  async loginStatus() {
    const b = await this.ensureBrowser()
    const r = await checkLogin(b)
    this.loggedIn = Boolean(r.loggedIn)
    return {
      ...r,
      waitingLogin: this.waitingLogin,
      browser: this.browser?.exe || '',
      profile: this.cfg.userDataDir,
      port: this.cfg.browserPort,
    }
  }

  async selectorCheck() {
    if (BRIDGE_LOCK.selftest) {
      return { ok: true, skipped: '另一个实例正在自检', broken: [], absent: [], working: {} }
    }
    BRIDGE_LOCK.selftest = true
    try {
      const b = await this.ensureBrowser()
      const wasRunning = Boolean(this.timer)
      if (wasRunning) {
        clearInterval(this.timer)
        this.timer = null
      }
      try {
        for (let i = 0; i < 30 && this.busy; i++) await sleep(500)
        const r = await canary(b)
        this.log(r.ok ? '选择器自检通过' : `选择器自检发现异常：${r.broken.join(', ')}`)
        return r
      } finally {
        if (wasRunning && !this.timer) {
          const every = Math.max(2000, Number(this.cfg.pollIntervalMs) || 5000)
          this.timer = setInterval(() => { void this.pollOnce() }, every)
        }
      }
    } finally {
      BRIDGE_LOCK.selftest = false
    }
  }

  targetGroups() {
    return Array.isArray(this.cfg.groups)
      ? this.cfg.groups.map((g) => String(g || '').trim()).filter(Boolean)
      : []
  }

  sessionIdOf(group) {
    return groupSession(this.map, group)
  }

  groupOfSession(sessionId) {
    for (const [group, rec] of Object.entries(this.map.groups || {})) {
      if (rec && rec.sessionId === sessionId) return group
    }
    return ''
  }

  defaultModel() {
    if (this._defaultModel !== undefined) return this._defaultModel
    this._defaultModel = null
    const norm = (v) => {
      if (!v || typeof v !== 'object') return null
      const provider = v.provider ?? v.providerId ?? ''
      const model = v.model ?? v.modelId ?? ''
      if (!provider || !model) return null
      return { provider, model, reasoningEffort: v.reasoningEffort ?? '' }
    }
    const svc = this.service('agentDefaultModel')
    if (svc) {
      try {
        const got = norm(typeof svc.currentSelection === 'function' ? svc.currentSelection() : null)
        if (got) { this._defaultModel = got; return got }
      } catch { /* ignore */ }
      for (const v of [svc, svc.current, svc.value, svc.selection, svc.resolved]) {
        const got = norm(v)
        if (got) { this._defaultModel = got; return got }
      }
    }
    return null
  }

  agentOptions() {
    const o = {}
    const dm = this.defaultModel()
    const provider = this.cfg.provider || dm?.provider
    const model = this.cfg.model || dm?.model
    const effort = this.cfg.reasoningEffort || dm?.reasoningEffort
    if (provider) o.provider = provider
    if (model) o.model = model
    if (effort) o.reasoningEffort = effort
    return o
  }

  async ensureAgent(group) {
    const agents = this.service('agents')
    if (!agents) throw new Error('当前 DSH profile 未注入 agents 服务，无法连接会话')

    const existing = groupSession(this.map, group)
    if (existing) {
      const live = agents.get(existing)
      if (live) return live
      try {
        const handle = await agents.resume({
          resumeSessionId: existing,
          agentOptions: this.agentOptions(),
          setup: async (agentCtx, agent) => { await this.applyPreset(agent); await this.runSetup(agentCtx, agent) },
        })
        this.log(`已恢复群聊会话 ${existing}（${group}）`)
        return handle.agent
      } catch (e) {
        this.log(`恢复群聊会话 ${existing} 失败（${e?.message || e}），准备重建`)
      }
    }

    const id = `douyin-group-${sanitizeGroupId(group)}-${randomUUID().slice(0, 8)}`
    const cwd = this.cfg.cwd || homedir() || process.cwd()
    const opts = this.agentOptions()
    const handle = await agents.create({
      sessionId: id,
      meta: { cwd },
      agentOptions: opts,
      setup: async (agentCtx, agent) => { await this.applyPreset(agent); await this.runSetup(agentCtx, agent) },
    })
    const sessionId = handle?.agent?.id || id
    setGroupSession(this.map, group, sessionId, { group, createdAt: Date.now() })
    saveSessionMap(this.map)
    this.log(`已新建群聊会话 ${sessionId}（${group}，模型=${opts.provider || '默认'}/${opts.model || '默认'}）`)
    return handle.agent
  }

  async runSetup(agentCtx, agent) {
    if (typeof this.onSessionSetup !== 'function') return
    try { await this.onSessionSetup(agentCtx, agent) } catch (e) {
      this.log(`会话 setup 出错：${e?.message || e}`)
    }
  }

  async applyPreset(agent) {
    const preset = this.cfg.agentPreset
    if (!preset) return
    try {
      const presets = this.service('agentPresets')
      if (presets) await presets.select(agent, preset)
    } catch (e) {
      this.log(`套用 preset 失败（${preset}）：${e?.message || e}`)
    }
  }

  async saveImageAttachment(media) {
    if (!media?.data) return null
    const att = (() => {
      try { return this.attCtx?.get?.('attachments') } catch { /* ignore */ }
    })() || this.service('attachments')
    if (!att) return null

    const bytes = dataUrlToBytes(media.data)
    if (!bytes || !bytes.bytes?.length) return null
    if (!/^image\/(png|jpeg|webp|gif)$/.test(bytes.mediaType)) return null
    try {
      const refs = await att.saveImages([{
        data: bytes.bytes,
        mediaType: bytes.mediaType,
        name: 'douyin-group-image.png',
      }])
      return refs?.[0] || null
    } catch (e) {
      this.log(`保存群聊图片附件失败：${e?.message || e}`)
      return null
    }
  }

  async inject({ group, sender, question, rawText, recentContext = [], media = null }) {
    const formatted = formatGroupInjection({
      group,
      sender,
      question,
      rawText,
      recentContext,
      maxChars: this.cfg.maxInjectChars,
    })
    if (!formatted) return false

    const agent = await this.ensureAgent(group)
    const content = [{ type: 'text', text: formatted }]
    const ref = await this.saveImageAttachment(media)
    if (ref) content.push({ type: 'image', attachment: ref })

    const msg = await this.makeUserMessage({
      content,
      source: { kind: 'user', rpcId: `douyin-group-${randomUUID()}` },
    })

    try {
      const r = agent.followup(msg)
      if (r && typeof r.then === 'function') await r
    } catch (e) {
      this.log(`唤醒群聊会话失败(${group})：${e?.message || e}`)
      return false
    }

    this.state.injected++
    this.log(`注入群聊【${group}】<- ${sender || '群友'}: ${(question || rawText || '').slice(0, 40)}`)
    return true
  }

  async pollOnce() {
    if (this.busy) return { skipped: 'busy' }
    if (this.cfg.mode === 'off') return { skipped: 'mode-off' }
    const groups = this.targetGroups()
    if (!groups.length) return { skipped: 'no-groups-configured' }

    this.busy = true
    const started = Date.now()
    try {
      return await this.#pollWithTimeout(started, groups)
    } finally {
      this.busy = false
    }
  }

  async #pollWithTimeout(started, groups) {
    const LIMIT = Math.max(45000, Number(this.cfg.pollIntervalMs || 5000) * 6)
    let timer
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`本轮群聊轮询超时（>${LIMIT}ms）`)), LIMIT)
    })
    try {
      return await Promise.race([this.#pollBody(started, groups), timeout])
    } catch (e) {
      this.state.consecutiveErrors++
      this.state.lastError = String(e?.message || e)
      this.log(`轮询出错：${this.state.lastError}`)
      return { ok: false, error: this.state.lastError }
    } finally {
      clearTimeout(timer)
    }
  }

  async #pollBody(started, groups) {
    let b
    try {
      b = await this.ensureBrowser()
    } catch (e) {
      const msg = String(e?.message || e).split('\n')[0]
      this.state.lastError = msg
      return { ok: false, error: msg, skipped: true }
    }

    const injected = []
    const ctxLimit = Math.max(0, Math.min(20, Number(this.cfg.contextMessages ?? 8)))
    const triggerMode = this.cfg.triggerMode === 'all' ? 'all' : 'mention'

    for (const group of groups) {
      const r = await readGroupMessages({ browser: b, groupName: group, limit: 40 }).catch((e) => ({
        ok: false,
        error: String(e?.message || e),
        messages: [],
      }))
      if (!r.ok) {
        this.log(`读取群聊【${group}】失败：${r.error || '未知错误'}`)
        continue
      }

      const rec = this.map.groups[group] || (this.map.groups[group] = {})
      const msgs = Array.isArray(r.messages) ? r.messages : []
      const cur = msgs.map((m) => fingerprint(group, m))

      // 首次基准化当前可见历史，重启不重发
      if (!rec.seeded) {
        rec.window = cur
        for (const fp of cur) markSeen(this.map, group, fp)
        rec.seeded = true
        rec.lastSeenAt = Date.now()
        this.log(`已基准化群聊【${group}】历史消息 ${msgs.length} 条，实时监听已就绪`)
        continue
      }

      const fromIdx = newFromWindow(rec.window, cur)
      rec.window = cur

      for (let i = fromIdx; i < msgs.length; i++) {
        const m = msgs[i]
        const fp = cur[i]
        if (fromIdx === 0 && hasSeen(this.map, group, fp)) continue
        markSeen(this.map, group, fp)

        if (m.fromMe || m.system || m.unsupported) continue

        let question = m.text
        if (triggerMode === 'mention') {
          const hit = matchMention(m.text, this.cfg.mentionAliases)
          if (!hit.matched) continue
          question = hit.cleanQuestion
          this.log(`捕获 @ 召唤【${group}】<- ${m.sender}: ${m.text.slice(0, 60)}`)
        }

        const startCtx = Math.max(0, i - ctxLimit + 1)
        const recentContext = ctxLimit > 0
          ? msgs.slice(startCtx, i + 1).map((c) => ({ sender: c.sender, fromMe: c.fromMe, text: c.text }))
          : []

        try {
          const ok = await this.inject({
            group,
            sender: m.sender,
            question,
            rawText: m.text,
            recentContext,
            media: m.media,
          })
          if (ok) injected.push({ group, sender: m.sender, question: question.slice(0, 60) })
        } catch (e) {
          this.log(`注入群聊【${group}】失败：${e?.message || e}`)
        }
      }
      rec.lastSeenAt = Date.now()
    }

    saveSessionMap(this.map)
    this.state.polls++
    this.state.lastPollAt = Date.now()
    this.state.lastError = ''
    this.state.consecutiveErrors = 0
    await this.relayPending()
    return { ok: true, groups: groups.length, injected, ms: Date.now() - started }
  }

  /** mirror 模式下自动把 DSH 会话中的新 assistant 回复单行回发到抖音群聊 */
  async relayPending() {
    if (this.cfg.mode !== 'mirror') return []
    const sent = []
    for (const [group, rec] of Object.entries(this.map.groups || {})) {
      if (!rec || !rec.sessionId) continue
      const session = this.service('sessions')?.get?.(rec.sessionId)
      if (!session) continue
      const last = Number(rec.lastRelayedSeq) || 0
      const events = session.snapshotEvents()
      for (const ev of events) {
        if (ev.seq <= last) continue
        if (ev.type !== 'assistant/message') continue
        rec.lastRelayedSeq = ev.seq
        const raw = extractAssistantText(ev.data?.message?.content)
        const text = normalizeSingleLine(raw)
        if (!text) continue
        try {
          const b = await this.ensureBrowser()
          const r = await sendGroupMessage({ browser: b, groupName: group, text })
          if (r.ok) {
            this.state.sent++
            sent.push({ group, text: text.slice(0, 50) })
            this.log(`mirror 回发【${group}】：${text.slice(0, 50)}`)
          } else {
            this.log(`mirror 回发【${group}】失败：${r.error || '未知错误'}`)
          }
        } catch (e) {
          this.log(`mirror 回发【${group}】异常：${e?.message || e}`)
        }
      }
    }
    if (sent.length) saveSessionMap(this.map)
    return sent
  }

  attachObserver() {
    const handler = (session, event) => {
      if (!event) return
      if (event.type === 'agent/error') {
        const e = event.data?.error
        const msg = e?.message || String(e)
        this.log(`agent 运行出错：${msg}`)
        this.state.lastError = msg
        return
      }
      if (event.type !== 'assistant/message') return
      const group = this.groupOfSession(session?.id)
      if (!group) return
      void this.relayPending()
    }
    const disposer = this.ctx.on('session/event', handler)
    return typeof disposer === 'function' ? disposer : () => {}
  }

  async recentEvents(sessionId, limit = 50) {
    const sid = sessionId || Object.values(this.map.groups || {}).map((r) => r?.sessionId).find(Boolean)
    if (!sid) return { error: '暂无群聊会话' }
    const session = this.service('sessions')?.get?.(sid)
    if (!session) return { error: `会话 ${sid} 当前未加载到内存中` }
    try {
      const events = session.snapshotEvents()
      return {
        sessionId: sid,
        total: events.length,
        events: events.slice(-limit).map((ev) => {
          const out = { type: ev.type, seq: ev.seq }
          const content = ev.data?.message?.content
          if (Array.isArray(content)) {
            out.content = content.map((b) => (b.type === 'text'
              ? `text:${String(b.text).slice(0, 120)}`
              : b.type === 'tool-call' ? `tool:${b.name}` : b.type))
          }
          if (ev.data?.reason !== undefined) out.reason = ev.data.reason
          if (ev.data?.error !== undefined) out.error = String(ev.data.error?.message ?? ev.data.error).slice(0, 300)
          return out
        }),
      }
    } catch (e) {
      return { error: String(e?.message || e) }
    }
  }

  async history(group, limit = 100) {
    const sid = this.sessionIdOf(group)
    if (!sid) {
      return { ok: false, error: `群聊「${group}」还没有对应的 DSH 会话`, messages: [] }
    }
    const r = readGroupHistory(sid, group, limit)
    if (!r.ok) return { ok: false, error: r.error, messages: [] }
    return {
      ok: true,
      sessionId: sid,
      group,
      total: r.total,
      messages: r.messages.map((m) => ({
        who: m.role === 'group' ? '群友注入' : '我',
        text: m.text,
        time: m.time ? new Date(m.time).toLocaleString('zh-CN') : '',
      })),
    }
  }

  start({ relaunchBrowser = false } = {}) {
    if (relaunchBrowser) {
      this.browserClosed = false
      this._relaunchCount = 0
      this._relaunchAt = 0
    }
    if (!this._instanceId) this._instanceId = ++BRIDGE_LOCK.seq
    if (BRIDGE_LOCK.owner && BRIDGE_LOCK.owner !== this._instanceId) return

    const now = Date.now()
    if (now - BRIDGE_LOCK.lastToggle < 2000) {
      BRIDGE_LOCK.toggles++
      if (BRIDGE_LOCK.toggles > 3) {
        if (!BRIDGE_LOCK.warned) {
          BRIDGE_LOCK.warned = true
          this.log('检测到频繁启停（可能存在热重载残留实例），已自动节流')
        }
        return
      }
    } else {
      BRIDGE_LOCK.toggles = 0
    }
    BRIDGE_LOCK.lastToggle = now
    BRIDGE_LOCK.owner = this._instanceId

    this.stop()
    const every = Math.max(2000, Number(this.cfg.pollIntervalMs) || 5000)
    this.timer = setInterval(() => { void this.pollOnce() }, every)
    void this.pollOnce()
    this.log(`抖音群聊桥接已启动：轮询=${every}ms，模式=${this.cfg.mode}，触发=${this.cfg.triggerMode}`)
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
      this.log('抖音群聊桥接已停止')
    }
  }

  async dispose() {
    this._loginWatchToken++
    this.waitingLogin = false
    this.stop()
    if (BRIDGE_LOCK.owner === this._instanceId) BRIDGE_LOCK.owner = 0
    try { this.browser?.detach?.() } catch { /* ignore */ }
    this.browser = null
  }

  status() {
    const model = this.defaultModel()
    return {
      enabled: this.cfg.enabled,
      autoDiscoverOnLogin: this.cfg.autoDiscoverOnLogin !== false,
      autoWatchDiscovered: Boolean(this.cfg.autoWatchDiscovered),
      mode: this.cfg.mode,
      triggerMode: this.cfg.triggerMode,
      groups: this.targetGroups(),
      mentionAliases: this.cfg.mentionAliases,
      pollIntervalMs: this.cfg.pollIntervalMs,
      contextMessages: this.cfg.contextMessages,
      running: Boolean(this.timer),
      browserReady: Boolean(this.browser?.ready),
      browserClosed: Boolean(this.browserClosed),
      browserAlive: Boolean(this.browser?.isAlive?.()),
      loggedIn: Boolean(this.loggedIn),
      waitingLogin: Boolean(this.waitingLogin),
      discovering: Boolean(this.discovering),
      discoveredGroups: this.discovered?.items || [],
      lastDiscoveryAt: this.discovered?.updatedAt || 0,
      agentModel: {
        provider: this.cfg.provider || model?.provider || '',
        model: this.cfg.model || model?.model || '',
      },
      attachments: Boolean(this.service('attachments') || this.attCtx?.get?.('attachments')),
      sessions: Object.fromEntries(
        Object.entries(this.map.groups || {}).map(([g, r]) => [g, r.sessionId]),
      ),
      ...this.state,
    }
  }
}

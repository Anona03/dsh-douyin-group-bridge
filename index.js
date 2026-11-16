/**
 * dsh-douyin-group-bridge —— 抖音群聊 ⇄ DeepSeek Harness 会话桥接插件
 *
 * 架构：
 *   抖音群聊 (React Fiber + CDP) ──▶ DouyinGroupBridge ──▶ DSH 会话 (agents/sessions)
 *            ▲                                                       │
 *            └──── douyin_group_send / mirror 单行安全回发 ◀─────────┘
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadHostDeps } from './lib/hostdeps.mjs'
import { DouyinGroupBridge } from './lib/bridge.mjs'
import {
  listConversations, readGroupMessages, sendGroupMessage, sendGroupImage,
} from './lib/douyin-group.mjs'
import { loadConfig, tailLog, paths } from './lib/state.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const { z } = await loadHostDeps()

const writeDiag = (data) => {
  try {
    if (!existsSync(paths.dir)) mkdirSync(paths.dir, { recursive: true })
    const file = join(paths.dir, 'diag.json')
    let prev = {}
    try { prev = JSON.parse(readFileSync(file, 'utf8')) } catch { /* ignore */ }
    writeFileSync(file, JSON.stringify({ ...prev, ...data, at: new Date().toISOString() }, null, 2))
  } catch { /* ignore */ }
}

export const name = 'douyin-group-bridge'
export const inject = ['tools']

export const Config = !z ? undefined : z.object({
  enabled: z.boolean().default(true).extra('volatile', true),
  autoDiscoverOnLogin: z.boolean().default(true).extra('volatile', true),
  autoWatchDiscovered: z.boolean().default(false).extra('volatile', true),
  mode: z.union([
    z.const('simulation'), z.const('mirror'), z.const('off'),
  ]).default('simulation').extra('volatile', true),
  triggerMode: z.union([
    z.const('mention'), z.const('all'),
  ]).default('mention').extra('volatile', true),
  pollIntervalMs: z.number().min(2000).max(600000).step(1).default(5000).extra('volatile', true),
  groups: z.array(z.string()).default([]).extra('volatile', true),
  mentionAliases: z.array(z.string()).default(['DeepSeek', 'DS', '机器人']).extra('volatile', true),
  contextMessages: z.number().min(0).max(20).step(1).default(8).extra('volatile', true),
  maxInjectChars: z.number().min(200).max(20000).step(1).default(4000).extra('volatile', true),
  browserPort: z.number().min(1024).max(65535).step(1).default(47882).extra('volatile', true),
  autoReply: z.boolean().default(true).extra('volatile', true),
})

const TEXT_OUTPUT = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, value) => [{
    type: 'text',
    text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  }],
}

const safe = (v) => {
  if (v === undefined || v === null) return null
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
}

const str = (v, dflt = '') => (v === undefined || v === null ? dflt : String(v))
const num = (v, dflt = 0, lo = -Infinity, hi = Infinity) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, n))
}

function sanitizeGroupRead(r) {
  if (!r || typeof r !== 'object') return r
  const out = { ...r }
  if (Array.isArray(r.messages)) {
    out.messages = r.messages.map((m) => {
      const media = m.media || {}
      const slim = {
        fromMe: !!m.fromMe,
        sender: m.sender || (m.fromMe ? '我' : '群友'),
        type: m.type || 'text',
        text: m.text || '',
      }
      if (m.system) slim.system = true
      if (m.unsupported) slim.unsupported = true
      if (m.isShare) slim.isShare = true
      if (m.itemId) slim.itemId = m.itemId
      const md = {}
      if (media.width || media.height) { md.width = media.width; md.height = media.height }
      if (media.name) md.name = media.name
      if (media.seconds) md.seconds = media.seconds
      if (media.src) md.hasImage = true
      if (media.data) md.hasImageData = true
      if (Object.keys(md).length) slim.media = md
      return slim
    })
  }
  return out
}

function readPrompt(file, fallback) {
  // 优先读 $DSH_HOME/douyin-group-bridge/prompts/<file>，其次插件内置 prompts/<file>
  const candidates = [
    join(paths.dir, 'prompts', file),
    join(__dirname, 'prompts', file),
  ]
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        const t = readFileSync(p, 'utf8')
        if (t.trim()) return t
      }
    } catch { /* ignore */ }
  }
  return fallback
}

function dutyText() {
  return readPrompt('duty.md', [
    '# 抖音群聊值班章程',
    '',
    '你已接入抖音群聊会话。请结合群友触发消息和最近上下文自然回复：',
    '- simulation 模式下需要回复时调用 `douyin_group_send`（`group` 留空即发回当前群）。',
    '- mirror 模式下你在会话里的文本会自动单行发出，勿重复调发送工具。',
    '- 尽量精炼自然，不要在群里发大段 Markdown 排版。',
  ].join('\n'))
}

function personaText() {
  return readPrompt('persona.md', '你是群聊里的智能伙伴，性格自然、聪明、乐于帮忙，说话简短接地气。')
}

export function apply(ctx, config) {
  const log = (m) => {
    try { ctx.logger?.info?.(`[douyin-group-bridge] ${m}`) } catch { /* ignore */ }
  }

  // 用户在 $DSH_HOME/douyin-group-bridge/config.json 保存的配置优先于 patch 默认值
  const fileCfg = loadConfig()
  const patchCfg = config && typeof config === 'object' ? config : {}
  const cfg = { ...patchCfg, ...fileCfg }
  if (!cfg.groups?.length && Array.isArray(patchCfg.groups) && patchCfg.groups.length) {
    cfg.groups = patchCfg.groups
  }
  if (!existsSync(paths.config) && patchCfg.mentionAliases?.length) {
    cfg.mentionAliases = patchCfg.mentionAliases
  }

  const bridge = new DouyinGroupBridge({ ctx, log })
  bridge.cfg = { ...bridge.cfg, ...cfg }

  const groupOfExec = (exec) => {
    const sid = exec?.agent?.id || ''
    return sid ? bridge.groupOfSession(sid) : ''
  }

  const checkGroupAllowed = (target) => {
    const allow = bridge.targetGroups()
    if (!allow.length) return ''
    const t = String(target || '').trim()
    if (!t) return `未指定群名（已配置白名单：${allow.join('、')}）`
    if (!allow.some((g) => g === t || g.includes(t) || t.includes(g))) {
      return `群聊「${t}」不在允许的监听列表（${allow.join('、')}）中`
    }
    return ''
  }

  const tools = [
    {
      name: 'douyin_group_login',
      description: '打开浏览器前往抖音网页版供扫码登录，并保持窗口用于群聊桥接。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: TEXT_OUTPUT,
      async execute() {
        return safe(await bridge.openLogin())
      },
    },
    {
      name: 'douyin_group_whoami',
      description: '检查抖音群聊桥接的浏览器登录态与连接信息。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: TEXT_OUTPUT,
      async execute() {
        return safe(await bridge.loginStatus())
      },
    },
    {
      name: 'douyin_group_list',
      description: '列出抖音消息抽屉中可见的会话列表（支持分页滚动与关键词过滤，返回群聊/私信类型标注）。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '最多返回条数（默认 60）' },
          query: { type: 'string', description: '可选：按名称或预览关键词过滤' },
          maxScrolls: { type: 'number', description: '向下滚动会话列表的最大次数（默认 8）' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        const b = await bridge.ensureBrowser()
        return safe(await listConversations({
          browser: b,
          limit: num(args.limit, 60, 1, 200),
          query: str(args.query).trim(),
          maxScrolls: num(args.maxScrolls, 8, 1, 20),
        }))
      },
    },
    {
      name: 'douyin_group_discover',
      description: '扫码登录后自动滚动检索当前抖音账号里的所有群聊（基于 React Fiber 与标题特征识别群聊），可选关键词搜索并自动加入监听列表。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '可选：只检索名称或最近消息包含该关键词的群聊' },
          groupOnly: { type: 'boolean', description: '是否优先过滤出群聊（默认 true）' },
          maxScrolls: { type: 'number', description: '向下滚动会话列表的最大次数（默认 10）' },
          autoWatch: { type: 'boolean', description: '是否将检索到的群聊自动加入当前监听名单（默认 false）' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        return safe(await bridge.discoverGroups({
          query: str(args.query).trim(),
          groupOnly: args.groupOnly !== false,
          maxScrolls: num(args.maxScrolls, 10, 1, 20),
          autoWatch: Boolean(args.autoWatch),
        }))
      },
    },
    {
      name: 'douyin_group_read',
      description: '读取指定抖音群聊的最新消息（基于 React Fiber 解析发送者昵称、方向与正文）。`group` 留空时默认读取当前会话绑定的群聊。',
      parameters: {
        type: 'object',
        properties: {
          group: { type: 'string', description: '群聊名称（留空 = 当前会话绑定的群）' },
          limit: { type: 'number', description: '最多返回几条（默认 30）' },
          scrollBack: { type: 'number', description: '向上滚动加载历史的次数（默认 0）' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const group = str(args.group).trim() || groupOfExec(exec) || bridge.targetGroups()[0] || ''
        if (!group) return { ok: false, error: '未指定群聊名称，也没有当前会话绑定的群' }
        const b = await bridge.ensureBrowser()
        const r = await readGroupMessages({
          browser: b,
          groupName: group,
          limit: num(args.limit, 30, 1, 100),
          scrollBack: num(args.scrollBack, 0, 0, 15),
        })
        return safe(sanitizeGroupRead(r))
      },
    },
    {
      name: 'douyin_group_send',
      description: '向指定抖音群聊发送纯文本消息（自动单行化以防富文本换行截断，发送后自动在页面验证）。`group` 留空 = 发送到当前会话绑定的群聊。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要发送的纯文本内容（请勿带复杂 Markdown）' },
          group: { type: 'string', description: '目标群聊名称（留空 = 当前会话绑定的群）' },
          atSender: { type: 'string', description: '可选：在消息开头加 @某群友 前缀' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const text = str(args.text).trim()
        if (!text) return { ok: false, error: '发送内容为空' }
        const group = str(args.group).trim() || groupOfExec(exec) || bridge.targetGroups()[0] || ''
        if (!group) return { ok: false, error: '不知道发到哪个群：请传入 group 或在群聊桥接会话中调用' }
        const bad = checkGroupAllowed(group)
        if (bad) return { ok: false, error: bad }
        const b = await bridge.ensureBrowser()
        const r = await sendGroupMessage({
          browser: b,
          groupName: group,
          text,
          atSender: str(args.atSender).trim(),
        })
        if (r.ok) bridge.state.sent++
        return safe(r)
      },
    },
    {
      name: 'douyin_group_send_image',
      description: '向指定抖音群聊发送本地图片（jpg/png/gif，不支持 webp）或 base64 图片。',
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: '本地图片绝对路径' },
          base64: { type: 'string', description: '图片 base64（当没有本地 file 时使用）' },
          mediaType: { type: 'string', description: 'base64 图片类型，默认 image/png' },
          group: { type: 'string', description: '目标群聊名称（留空 = 当前会话绑定的群）' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const group = str(args.group).trim() || groupOfExec(exec) || bridge.targetGroups()[0] || ''
        if (!group) return { ok: false, error: '未指定目标群聊' }
        const bad = checkGroupAllowed(group)
        if (bad) return { ok: false, error: bad }

        let file = str(args.file).trim()
        if (!file) {
          const raw = str(args.base64).trim()
          if (!raw) return { ok: false, error: '请提供 file 或 base64' }
          const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(raw)
          const mt = str(args.mediaType).trim() || (m && m[1]) || 'image/png'
          if (mt.includes('webp')) return { ok: false, error: '抖音上传控件不支持 webp，请传 png 或 jpg' }
          const payload = m ? m[3] : raw
          const buf = Buffer.from(payload, 'base64')
          if (!buf.length) return { ok: false, error: 'base64 内容为空' }
          const ext = mt.includes('jpeg') ? '.jpg' : mt.includes('gif') ? '.gif' : '.png'
          const outDir = join(paths.dir, 'outbox')
          mkdirSync(outDir, { recursive: true })
          file = join(outDir, `img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}${ext}`)
          writeFileSync(file, buf)
        }

        const b = await bridge.ensureBrowser()
        return safe(await sendGroupImage({ browser: b, groupName: group, file }))
      },
    },
    {
      name: 'douyin_group_history',
      description: '从 DSH 原始会话日志读取某个群聊的完整历史记录（不受网页端虚拟列表条数限制）。',
      parameters: {
        type: 'object',
        properties: {
          group: { type: 'string', description: '群聊名称（留空 = 当前会话绑定的群）' },
          limit: { type: 'number', description: '最多返回条数（默认 100）' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const group = str(args.group).trim() || groupOfExec(exec) || bridge.targetGroups()[0] || ''
        if (!group) return { ok: false, error: '请指定群聊名称' }
        return safe(await bridge.history(group, num(args.limit, 100, 1, 500)))
      },
    },
    {
      name: 'douyin_group_duty',
      description: '读取群聊值班章程与人格设定。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: TEXT_OUTPUT,
      async execute() {
        return { persona: personaText(), duty: dutyText() }
      },
    },
    {
      name: 'douyin_group_status',
      description: '查看抖音群聊桥接插件的运行状态、配置、会话映射与最近日志。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: TEXT_OUTPUT,
      async execute() {
        return safe({ ...bridge.status(), config: bridge.cfg, log: tailLog(25) })
      },
    },
    {
      name: 'douyin_group_selftest',
      description: '自检抖音网页端关键选择器与消息抽屉可用性。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: TEXT_OUTPUT,
      async execute() {
        return safe(await bridge.selectorCheck())
      },
    },
  ]

  const disposers = []
  for (const t of tools) {
    const d = ctx.tools.register({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      output: t.output,
      async execute(args, exec) {
        try {
          return safe(await t.execute(args || {}, exec || {}))
        } catch (e) {
          const msg = String(e?.message || e)
          log(`工具 ${t.name} 出错：${msg}`)
          return { ok: false, error: msg }
        }
      },
    })
    disposers.push(d)
  }
  ctx.effect(() => () => {
    for (const d of disposers) { try { d() } catch { /* ignore */ } }
  }, 'douyin-group-bridge: tools')

  writeDiag({
    phase: 'tools-registered',
    tools: tools.map((t) => t.name),
    services: {
      tools: Boolean(ctx.get('tools')),
      agents: Boolean(ctx.get('agents')),
      sessions: Boolean(ctx.get('sessions')),
      webServer: Boolean(ctx.get('webServer')),
      attachments: Boolean(ctx.get('attachments')),
    },
    stateDir: paths.dir,
  })

  /* ── DSH 会话桥接（单独 inject，确保缺少可选服务时不阻塞） ───────── */
  ctx.inject(['agents', 'sessions'], (scoped) => {
    bridge.setCtx(scoped)
    bridge.onSessionSetup = async (agentCtx) => {
      const sections = [
        { name: 'douyin-group-bridge:persona', order: 900, text: personaText() },
        { name: 'douyin-group-bridge:duty', order: 1000, text: dutyText() },
      ]
      for (const s of sections) {
        try {
          agentCtx.systemPrompt.section(s)
        } catch (e) {
          log(`注入系统提示段失败（${s.name}）：${e?.message || e}`)
        }
      }
    }

    scoped.effect(() => bridge.attachObserver(), 'douyin-group-bridge: session observer')

    scoped.effect(async function* () {
      if (!bridge.cfg.enabled || bridge.cfg.mode === 'off') {
        log(`桥接未自动启动（enabled=${bridge.cfg.enabled}, mode=${bridge.cfg.mode}），仅提供工具`)
        return
      }
      bridge.start()
      yield () => { void bridge.dispose() }
    }, 'douyin-group-bridge: poller')

    log(`已装载群聊桥接插件：${tools.length} 个工具`)
  })

  try {
    ctx.inject(['attachments'], (scoped) => {
      bridge.setAttachmentCtx(scoped)
      log('已挂载 attachments 服务，群聊图片将作为原生图像块注入模型')
    })
  } catch (e) {
    log(`attachments 服务不可用（${e?.message || e}），图片将降级为文本描述`)
  }

  /* ── 设置页与调试用 HTTP API ─────────────────────────────────────── */
  const sameOriginOk = (req) => {
    try {
      const site = String(req.headers?.['sec-fetch-site'] || '').toLowerCase()
      if (site === 'cross-site') return false
      const host = String(req.headers?.host || '').trim()
      const origin = String(req.headers?.origin || '').trim()
      if (!origin) return true
      if (origin === 'null') return false
      let u
      try { u = new URL(origin) } catch { return false }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return true
      if (!host) return false
      return u.host.toLowerCase() === host.toLowerCase()
    } catch { return false }
  }

  const sendJson = (res, code, obj) => {
    try {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(obj))
    } catch { /* ignore */ }
  }

  const readBody = async (req) => {
    try {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const raw = Buffer.concat(chunks).toString('utf8')
      return raw ? JSON.parse(raw) : {}
    } catch { return {} }
  }

  try {
    ctx.inject(['webServer'], (host) => {
      writeDiag({ phase: 'webserver-injected', port: host?.webServer?.port ?? null })
      host.effect(() => host.webServer.register({
        kind: 'prefix',
        path: '/dsh-douyin-group-bridge',
        handler: async (req, res) => {
          if (!sameOriginOk(req)) {
            sendJson(res, 403, { ok: false, error: '只接受同源请求' })
            return
          }
          const url = new URL(req.url, 'http://127.0.0.1')
          const p = url.pathname.replace(/^\/dsh-douyin-group-bridge/, '') || '/'
          try {
            if (req.method === 'GET' && p === '/status') {
              sendJson(res, 200, { ok: true, status: bridge.status(), config: bridge.cfg })
              return
            }
            if (req.method === 'GET' && p === '/log') {
              sendJson(res, 200, { ok: true, log: tailLog(80) })
              return
            }
            if (req.method === 'POST' && p === '/config') {
              const body = await readBody(req)
              const prevInterval = Number(bridge.cfg.pollIntervalMs)
              const nextCfg = bridge.updateConfig(body)
              if (bridge.timer && (nextCfg.mode === 'off' || !nextCfg.enabled)) {
                bridge.stop()
              } else if (bridge.timer && Number(nextCfg.pollIntervalMs) !== prevInterval) {
                bridge.start()
              }
              sendJson(res, 200, { ok: true, config: nextCfg, status: bridge.status() })
              return
            }
            if (req.method === 'GET' && p === '/prompts') {
              sendJson(res, 200, { ok: true, persona: personaText(), duty: dutyText() })
              return
            }
            if (req.method === 'POST' && p === '/prompts') {
              const body = await readBody(req)
              const promptDir = join(paths.dir, 'prompts')
              mkdirSync(promptDir, { recursive: true })
              if (typeof body.persona === 'string') {
                writeFileSync(join(promptDir, 'persona.md'), body.persona, 'utf8')
              }
              if (typeof body.duty === 'string') {
                writeFileSync(join(promptDir, 'duty.md'), body.duty, 'utf8')
              }
              sendJson(res, 200, { ok: true, persona: personaText(), duty: dutyText() })
              return
            }
            if (req.method === 'POST' && p === '/login') {
              sendJson(res, 200, { ok: true, status: await bridge.openLogin() })
              return
            }
            if (req.method === 'POST' && p === '/discover') {
              const body = await readBody(req)
              const result = await bridge.discoverGroups({
                query: str(body.query).trim(),
                groupOnly: body.groupOnly !== false,
                maxScrolls: num(body.maxScrolls, 10, 1, 20),
                autoWatch: Boolean(body.autoWatch),
              })
              sendJson(res, 200, { ok: true, result, status: bridge.status() })
              return
            }
            if (req.method === 'POST' && p === '/start') {
              bridge.start({ relaunchBrowser: true })
              sendJson(res, 200, { ok: true, status: bridge.status() })
              return
            }
            if (req.method === 'POST' && p === '/stop') {
              bridge.stop()
              sendJson(res, 200, { ok: true, status: bridge.status() })
              return
            }
            if (req.method === 'POST' && p === '/poll') {
              sendJson(res, 200, { ok: true, result: await bridge.pollOnce() })
              return
            }
            if (req.method === 'POST' && p === '/selftest') {
              sendJson(res, 200, { ok: true, result: await bridge.selectorCheck() })
              return
            }
            if (req.method === 'GET' && p === '/history') {
              const group = url.searchParams.get('group') || ''
              const limit = Number(url.searchParams.get('limit')) || 100
              if (!group) {
                sendJson(res, 400, { ok: false, error: '缺少 group 参数' })
                return
              }
              sendJson(res, 200, { ok: true, result: await bridge.history(group, limit) })
              return
            }
            if (req.method === 'POST' && p === '/inject') {
              const body = await readBody(req)
              const group = String(body.group || '').trim()
              const sender = String(body.sender || '群友').trim()
              const text = String(body.text || '').trim()
              if (!group || !text) {
                sendJson(res, 400, { ok: false, error: '需要 group 和 text' })
                return
              }
              const recentContext = Array.isArray(body.recentContext) ? body.recentContext : []
              const ok = await bridge.inject({ group, sender, question: text, rawText: text, recentContext })
              sendJson(res, 200, { ok, sessionId: bridge.sessionIdOf(group), status: bridge.status() })
              return
            }
            if (req.method === 'GET' && p === '/events') {
              const sid = url.searchParams.get('sessionId') || ''
              sendJson(res, 200, { ok: true, events: await bridge.recentEvents(sid) })
              return
            }
            sendJson(res, 404, { ok: false, error: '未知接口' })
          } catch (e) {
            sendJson(res, 500, { ok: false, error: String(e?.message || e) })
          }
        },
      }), 'douyin-group-bridge: /dsh-douyin-group-bridge 路由')
    })
  } catch (e) {
    log(`HTTP 路由注册失败：${e?.message || e}`)
    writeDiag({ phase: 'webserver-failed', error: String(e?.message || e) })
  }

  return () => {
    for (const d of disposers) { try { d() } catch { /* ignore */ } }
    void bridge.dispose()
  }
}

export { paths }

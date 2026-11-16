/**
 * lib/state.mjs —— 配置、状态目录、群聊会话映射与去重指纹
 *
 * 所有配置与运行数据都落在 `$DSH_HOME/douyin-group-bridge/`，不写进插件包目录，
 * 保证升级/重装插件不会丢失登录态、群聊映射和去重状态。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'

/** DSH home 目录 */
export function resolveDshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 本插件独立数据目录（与私信桥/刷视频插件隔离） */
export function stateDir() {
  return join(resolveDshHome(), 'douyin-group-bridge')
}

export const paths = {
  dir: stateDir(),
  config: join(stateDir(), 'config.json'),
  sessions: join(stateDir(), 'sessions.json'),
  discovered: join(stateDir(), 'discovered-groups.json'),
  profile: join(stateDir(), 'profile'),
  log: join(stateDir(), 'bridge.log'),
  shots: join(stateDir(), 'shots'),
}

export const DEFAULTS = {
  /** 桥接总开关 */
  enabled: true,
  /** 扫码登录后自动检索账号内的群聊 */
  autoDiscoverOnLogin: true,
  /** 若当前未配置监听群聊，是否在检索后自动加入发现的群聊 */
  autoWatchDiscovered: false,
  /** 浏览器可执行文件路径；空 = 自动探测 Edge/Chrome */
  browser: '',
  /** CDP 调试端口（默认 47882，避免与 dsh-douyin-bridge 的 47881 冲突） */
  browserPort: 47882,
  /** 浏览器 profile 目录；空 = <家目录>/profile */
  userDataDir: '',
  /** 抖音入口 URL */
  douyinUrl: 'https://www.douyin.com/jingxuan',
  /** 轮询间隔（毫秒） */
  pollIntervalMs: 5000,
  /**
   * 桥接工作模式：
   *   simulation —— 注入群聊消息到 DSH 会话，由 AI 决定是否调用 douyin_group_send 回复
   *   mirror     —— 注入群聊消息，并把 AI 的文本回复自动单行发回对应群聊
   *   off        —— 只提供工具，不做自动轮询与注入
   */
  mode: 'simulation',
  /**
   * 群聊触发模式：
   *   mention —— 仅当群友 @ 触发词（mentionAliases）时唤醒 DSH 会话（推荐，参考 douyin-rpa-bridge）
   *   all     —— 群内所有非自己的新消息都注入 DSH 会话
   */
  triggerMode: 'mention',
  /** 要监听的抖音群聊名称列表（支持精确/子串匹配） */
  groups: [],
  /** @ 召唤触发词列表（例如机器人昵称、账号名） */
  mentionAliases: ['DeepSeek', 'DS', '机器人'],
  /** @ 触发时附带的最近群聊上下文条数 */
  contextMessages: 8,
  /** 单条注入消息字符上限 */
  maxInjectChars: 4000,
  /** 收到触发消息时是否自动唤醒 agent */
  autoReply: true,
  /** 桥接会话工作目录；空 = 用户主目录 */
  cwd: '',
  /** 桥接会话 preset（空 = 默认） */
  agentPreset: '',
  /** 桥接会话显式模型覆盖（空 = 自动读取 DSH 默认模型） */
  provider: '',
  model: '',
  reasoningEffort: '',
}

function ensureDir() {
  for (const d of [paths.dir, paths.profile, paths.shots]) {
    try { mkdirSync(d, { recursive: true }) } catch { /* ignore */ }
  }
}

/** 读配置（缺字段用默认值补齐；损坏时回退默认值） */
export function loadConfig() {
  ensureDir()
  let raw = {}
  try {
    if (existsSync(paths.config)) raw = JSON.parse(readFileSync(paths.config, 'utf8')) || {}
  } catch { raw = {} }
  const cfg = { ...DEFAULTS }
  for (const k of Object.keys(DEFAULTS)) {
    if (raw[k] !== undefined) cfg[k] = raw[k]
  }
  if (!cfg.userDataDir) cfg.userDataDir = paths.profile
  if (!Array.isArray(cfg.groups)) cfg.groups = []
  if (!Array.isArray(cfg.mentionAliases) || !cfg.mentionAliases.length) {
    cfg.mentionAliases = [...DEFAULTS.mentionAliases]
  }
  return cfg
}

/** 原子写配置 */
export function saveConfig(cfg) {
  ensureDir()
  const tmp = paths.config + '.tmp'
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
  renameSync(tmp, paths.config)
  return cfg
}

/* ── 群聊会话映射与去重 ──────────────────────────────────────────── */

const emptyMap = () => ({ version: 1, groups: {}, seen: {} })

export function loadSessionMap() {
  ensureDir()
  try {
    if (!existsSync(paths.sessions)) return emptyMap()
    const raw = JSON.parse(readFileSync(paths.sessions, 'utf8'))
    return {
      version: 1,
      groups: raw?.groups && typeof raw.groups === 'object' ? raw.groups : {},
      seen: raw?.seen && typeof raw.seen === 'object' ? raw.seen : {},
    }
  } catch { return emptyMap() }
}

export function saveSessionMap(map) {
  ensureDir()
  const tmp = paths.sessions + '.tmp'
  writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8')
  renameSync(tmp, paths.sessions)
  return map
}

const MAX_SEEN = 1000

export function markSeen(map, group, fp) {
  const list = map.seen[group] || (map.seen[group] = [])
  if (!list.includes(fp)) list.push(fp)
  while (list.length > MAX_SEEN) list.shift()
  return map
}

export function hasSeen(map, group, fp) {
  const list = map.seen[group]
  return Array.isArray(list) && list.includes(fp)
}

/**
 * 群消息去重指纹：群名 + 发送者 + 方向 + msgId/itemId + 正文前 120 字 + 媒体特征
 */
export function fingerprint(group, msg) {
  let extra = ''
  const media = msg && msg.media
  if (media) {
    const bits = [msg.type || '']
    if (media.src) bits.push(String(media.src).split('?')[0].slice(-60))
    if (media.name) bits.push(media.name)
    if (media.seconds) bits.push(String(media.seconds))
    if (media.width) bits.push(`${media.width}x${media.height}`)
    extra = '|' + bits.join(':')
  }
  const idPart = msg?.msgId || msg?.itemId || ''
  const sender = String(msg?.sender || '').trim()
  const dir = msg?.fromMe ? 'me' : 'them'
  const text = String(msg?.text || '').replace(/\s+/g, ' ').trim().slice(0, 120)
  const base = `${group}|${sender}|${dir}|${idPart}|${text}${extra}`
  return createHash('sha1').update(base).digest('hex').slice(0, 16)
}

export function groupSession(map, group) {
  const rec = map.groups[group]
  return rec && typeof rec.sessionId === 'string' ? rec.sessionId : ''
}

export function setGroupSession(map, group, sessionId, extra = {}) {
  const prev = map.groups[group] || {}
  map.groups[group] = { ...prev, ...extra, sessionId, updatedAt: Date.now() }
  return map
}

export function forgetGroup(map, group) {
  delete map.groups[group]
  delete map.seen[group]
  return map
}

export function loadDiscoveredGroups() {
  ensureDir()
  try {
    if (!existsSync(paths.discovered)) return { updatedAt: 0, items: [] }
    const raw = JSON.parse(readFileSync(paths.discovered, 'utf8'))
    return {
      updatedAt: Number(raw?.updatedAt) || 0,
      items: Array.isArray(raw?.items) ? raw.items : [],
    }
  } catch {
    return { updatedAt: 0, items: [] }
  }
}

export function saveDiscoveredGroups(data) {
  ensureDir()
  const payload = {
    updatedAt: Number(data?.updatedAt) || Date.now(),
    items: Array.isArray(data?.items) ? data.items : [],
  }
  const tmp = paths.discovered + '.tmp'
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
  renameSync(tmp, paths.discovered)
  return payload
}

/* ── 运行日志（带连续重复折叠） ─────────────────────────────────── */

export function appendLog(line) {
  ensureDir()
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ')
  try {
    const prev = existsSync(paths.log) ? readFileSync(paths.log, 'utf8') : ''
    const lines = prev.split('\n').filter(Boolean)
    const strip = (s) => s.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /, '').replace(/ \(×\d+\)$/, '')
    const last = lines[lines.length - 1]
    if (last && strip(last) === line) {
      const m = last.match(/ \(×(\d+)\)$/)
      const n = m ? Number(m[1]) + 1 : 2
      lines[lines.length - 1] = `${stamp} ${line} (×${n})`
      writeFileSync(paths.log, lines.join('\n') + '\n', 'utf8')
      return
    }
    lines.push(`${stamp} ${line}`)
    while (lines.length > 500) lines.shift()
    writeFileSync(paths.log, lines.join('\n') + '\n', 'utf8')
  } catch { /* ignore */ }
}

export function tailLog(n = 80) {
  try {
    if (!existsSync(paths.log)) return []
    const lines = readFileSync(paths.log, 'utf8').split('\n').filter(Boolean)
    return lines.slice(-n)
  } catch { return [] }
}

export { existsSync, readdirSync }

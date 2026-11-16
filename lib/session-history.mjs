/**
 * lib/session-history.mjs —— 从 DSH 会话日志（session.v4.jsonl.zstd）读取完整群聊历史
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

export function decompressAll(buf) {
  const parts = []
  let offset = 0
  let guard = 0

  while (offset < buf.length && guard++ < 100000) {
    let next = -1
    for (let i = offset + 4; i <= buf.length - 4; i++) {
      if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1]
        && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) {
        next = i
        break
      }
    }
    const end = next === -1 ? buf.length : next
    try {
      const out = zstdDecompressSync(buf.subarray(offset, end))
      if (out.length) parts.push(out)
      offset = end
    } catch {
      offset += 1
    }
  }
  return Buffer.concat(parts)
}

export function findSessionDir(sessionId) {
  const root = join(dshHome(), 'sessions')
  if (!existsSync(root)) return ''
  try {
    for (const ws of readdirSync(root)) {
      const d = join(root, ws, sessionId)
      if (existsSync(d)) return d
    }
  } catch { /* ignore */ }
  return ''
}

export function readSessionEvents(sessionId) {
  const dir = findSessionDir(sessionId)
  if (!dir) return { ok: false, events: [], error: `找不到会话 ${sessionId}` }

  const file = join(dir, 'session.v4.jsonl.zstd')
  if (!existsSync(file)) return { ok: false, events: [], error: `没有 ${file}` }

  let text
  try {
    const raw = readFileSync(file)
    text = decompressAll(raw).toString('utf8')
    if (!text.trim()) text = zstdDecompressSync(raw).toString('utf8')
  } catch (e) {
    return { ok: false, events: [], error: `解压失败：${e?.message || e}` }
  }

  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch { /* ignore */ }
  }
  return { ok: true, events }
}

function textOf(content) {
  return (content ?? [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
}

/** 匹配格式：【抖音群聊 · 群名】\n... */
const INJECT_RE = /^【抖音群聊 · (.+?)】\n([\s\S]*)$/

export function extractGroupDialog(events) {
  const out = []

  for (const ev of events) {
    const t = ev.type

    if (t === 'agent/inbox/spliced' || t === 'user/message') {
      const list = t === 'agent/inbox/spliced'
        ? (ev.data?.inserted ?? [])
        : (ev.data?.message ? [ev.data.message] : [])
      for (const m of list) {
        const txt = textOf(m?.content)
        const hit = INJECT_RE.exec(txt)
        if (!hit) continue
        out.push({
          role: 'group',
          group: hit[1],
          text: hit[2].trim(),
          time: ev.time || 0,
          source: 'injected',
        })
      }
      continue
    }

    if (t === 'assistant/message') {
      const txt = textOf(ev.data?.message?.content).trim()
      if (!txt) continue
      out.push({ role: 'me', text: txt, time: ev.time || 0, source: 'assistant' })
    }
  }

  out.sort((a, b) => a.time - b.time)
  const seen = new Set()
  return out.filter((m) => {
    const sec = Math.floor((m.time || 0) / 1000)
    const k = `${m.role}|${sec}|${m.text}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

export function readGroupHistory(sessionId, group = '', limit = 100) {
  const r = readSessionEvents(sessionId)
  if (!r.ok) return { ok: false, messages: [], error: r.error }

  let msgs = extractGroupDialog(r.events)
  if (group) msgs = msgs.filter((m) => !m.group || m.group === group)

  return {
    ok: true,
    total: msgs.length,
    messages: limit > 0 ? msgs.slice(-limit) : msgs,
  }
}

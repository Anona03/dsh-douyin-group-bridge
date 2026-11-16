import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 使用临时 DSH_HOME，避免测试污染用户真实 ~/.dsh 状态
const testHome = mkdtempSync(join(tmpdir(), 'dsh-dyg-test-'))
process.env.DSH_HOME = testHome

const {
  buildMentionRegex,
  matchMention,
  newFromWindow,
  formatGroupInjection,
  extractAssistantText,
  sanitizeGroupId,
  DouyinGroupBridge,
} = await import('../lib/bridge.mjs')
const { normalizeSingleLine, normalizeGroupMessages, classifyConversation } = await import('../lib/douyin-group.mjs')
const { fingerprint } = await import('../lib/state.mjs')
const { extractGroupDialog } = await import('../lib/session-history.mjs')

test.after(() => {
  try { rmSync(testHome, { recursive: true, force: true }) } catch { /* ignore */ }
})

test('matchMention 正确识别多个 @ 别名并剥离前缀标点', () => {
  const r1 = matchMention('@DeepSeek，今天天气怎么样？', ['DeepSeek', 'DS'])
  assert.equal(r1.matched, true)
  assert.equal(r1.cleanQuestion, '今天天气怎么样？')

  const r2 = matchMention('大家觉得 @ds : 这个方案行吗', ['DeepSeek', 'DS'])
  assert.equal(r2.matched, true)
  assert.equal(r2.cleanQuestion, '大家觉得 : 这个方案行吗')

  const r3 = matchMention('@机器人', ['DeepSeek', '机器人'])
  assert.equal(r3.matched, true)
  assert.match(r3.cleanQuestion, /@ 了机器人/)

  const r4 = matchMention('今天午饭吃啥', ['DeepSeek', 'DS'])
  assert.equal(r4.matched, false)
  assert.equal(r4.cleanQuestion, '')

  // 含正则特殊字符的别名也应安全转义
  const re = buildMentionRegex(['C++助手', 'bot.1'])
  assert.equal(re.test('@C++助手 你好'), true)
  assert.equal(re.test('@botX1 你好'), false)
})

test('normalizeSingleLine 将多行文本压成安全的单行纯文本', () => {
  assert.equal(normalizeSingleLine('第一行\n第二行\r\n  第三行  '), '第一行 第二行 第三行')
  assert.equal(normalizeSingleLine('  \n\n  '), '')
})

test('normalizeGroupMessages 正确执行 y 排序、连续气泡继承、去重与系统消息标记', () => {
  const raw = [
    { own: '', text: '连续第二条', sender: '小明', type: 'text', y: 200 },
    { own: 'them', text: '第一条', sender: '小明', type: 'text', y: 100 },
    { own: 'me', text: '我发的', sender: '我', type: 'text', isFromMe: true, y: 300 },
    { own: 'them', text: '小明撤回了一条消息', sender: '', type: 'text', y: 400 },
    { own: 'them', text: '', sender: '小红', type: 'image', media: { width: 320, height: 240 }, y: 500 },
  ]
  const out = normalizeGroupMessages(raw)
  assert.equal(out.length, 5)
  assert.equal(out[0].text, '第一条')
  assert.equal(out[0].from, 'them')
  // 连续第二条无 own，应向上继承后面/同组或由 carry 继承（倒序 carry 遇到后面的 me -> 注意实际顺序！）
  // 这里 y=200 后紧接着 y=300 (own='me')，若同为 them 则页面中相邻气泡应按真实位置标 own；
  // 此处验证 y 排序与字段归一化：
  assert.equal(out[2].fromMe, true)
  assert.equal(out[3].system, true)
  assert.equal(out[4].text, '[图片 320×240]')
})

test('normalizeGroupMessages 倒序气泡继承：无头像气泡正确继承下方同侧方向', () => {
  const raw = [
    { own: '', text: '无头像第一句', sender: '群友A', type: 'text', y: 100 },
    { own: 'them', text: '带头像第二句', sender: '群友A', type: 'text', y: 150 },
  ]
  const out = normalizeGroupMessages(raw)
  assert.equal(out[0].from, 'them')
  assert.equal(out[0].fromMe, false)
  assert.equal(out[1].from, 'them')
})

test('newFromWindow 窗口位移对比能正确处理连续相同消息', () => {
  const fpA = fingerprint('测试群', { sender: '张三', fromMe: false, text: '1' })
  const fpB = fingerprint('测试群', { sender: '张三', fromMe: false, text: '1' })
  const fpC = fingerprint('测试群', { sender: '李四', fromMe: false, text: '2' })
  assert.equal(fpA, fpB)

  // 上一轮 [A, C]，这一轮滚进来一条新消息 B -> [C, B]，最大重合后缀 [C] 长度 1
  const idx = newFromWindow([fpA, fpC], [fpC, fpB])
  assert.equal(idx, 1)
})

test('formatGroupInjection 生成带上下文和长度限制的群聊提示', () => {
  const txt = formatGroupInjection({
    group: '猫娘测试群',
    sender: '阿强',
    question: '今晚吃什么？',
    rawText: '@DeepSeek 今晚吃什么？',
    recentContext: [
      { sender: '阿强', fromMe: false, text: '好饿啊' },
      { sender: '我', fromMe: true, text: '我也饿了' },
    ],
    maxChars: 1000,
  })
  assert.match(txt, /【抖音群聊 · 猫娘测试群】/)
  assert.match(txt, /触发成员：阿强/)
  assert.match(txt, /提问内容：今晚吃什么？/)
  assert.match(txt, /- \[阿强\]: 好饿啊/)
  assert.match(txt, /- \[我\]: 我也饿了/)
})

test('extractAssistantText 与 extractGroupDialog 正确提取群聊会话日志', () => {
  assert.equal(extractAssistantText([{ type: 'text', text: '第一句' }, { type: 'tool-call', name: 'x' }, { type: 'text', text: '第二句' }]), '第一句第二句')

  const dialog = extractGroupDialog([
    {
      type: 'user/message',
      time: 1000,
      data: { message: { content: [{ type: 'text', text: '【抖音群聊 · 测试群】\n触发成员：小明\n提问内容：你好' }] } },
    },
    {
      type: 'assistant/message',
      time: 2000,
      data: { message: { content: [{ type: 'text', text: '你好呀小明！' }] } },
    },
  ])
  assert.equal(dialog.length, 2)
  assert.equal(dialog[0].role, 'group')
  assert.equal(dialog[0].group, '测试群')
  assert.equal(dialog[1].role, 'me')
  assert.equal(dialog[1].text, '你好呀小明！')
})

test('DouyinGroupBridge.inject 创建 DSH 会话并调用 followup', async () => {
  const created = []
  const followups = []
  const fakeAgents = {
    get: () => null,
    create: async (opts) => {
      created.push(opts)
      const agent = {
        id: opts.sessionId,
        followup: async (msg) => { followups.push(msg) },
      }
      return { agent }
    },
  }
  const fakeCtx = {
    get: (name) => (name === 'agents' ? fakeAgents : undefined),
    on: () => () => {},
  }
  const bridge = new DouyinGroupBridge({ ctx: fakeCtx, log: () => {} })
  const ok = await bridge.inject({
    group: '测试群A',
    sender: '群友甲',
    question: '帮我查下天气',
    rawText: '@DeepSeek 帮我查下天气',
    recentContext: [{ sender: '群友甲', fromMe: false, text: '@DeepSeek 帮我查下天气' }],
  })
  assert.equal(ok, true)
  assert.equal(created.length, 1)
  assert.equal(followups.length, 1)
  assert.match(followups[0].content[0].text, /【抖音群聊 · 测试群A】/)
  assert.ok(bridge.sessionIdOf('测试群A').startsWith('douyin-group-'))
  assert.equal(sanitizeGroupId('测试群 A!'), '____A_')
})

test('classifyConversation 正确区分抖音群聊与私信会话', () => {
  const g1 = classifyConversation({ name: '摸鱼小分队', conversationType: 2, memberCount: 18, conversationId: '0:2:998877' })
  assert.equal(g1.kind, 'group')
  assert.equal(g1.memberCount, 18)

  const g2 = classifyConversation({ name: '技术交流群', rawTitle: '技术交流群(12)', conversationId: '0:2:12345' })
  assert.equal(g2.kind, 'group')

  const dm = classifyConversation({ name: '张三', conversationType: 1, conversationId: '0:1:111:222' })
  assert.equal(dm.kind, 'dm')

  const unk = classifyConversation({ name: '未知会话' })
  assert.equal(unk.kind, 'unknown')
})

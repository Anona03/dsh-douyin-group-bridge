#!/usr/bin/env node
/**
 * tools/probe-group.mjs —— 实机联调探测脚本（列出当前群聊或读取指定群聊 React Fiber 消息）
 *
 * 用法：
 *   node tools/probe-group.mjs
 *   node tools/probe-group.mjs "你的抖音群聊名称"
 */
import { getBrowser, findBrowser } from '../lib/browser.mjs'
import { loadConfig } from '../lib/state.mjs'
import { checkLogin, listConversations, readGroupMessages, enterGroupChat } from '../lib/douyin-group.mjs'

const cfg = loadConfig()
const args = process.argv.slice(2)
const inspect = args.includes('--inspect')
const groupName = args.find((a) => !a.startsWith('--')) || cfg.groups?.[0] || ''

const b = await getBrowser({
  exe: cfg.browser || findBrowser(),
  userDataDir: cfg.userDataDir,
  port: Number(cfg.browserPort) || 47882,
  log: (m) => console.log('[browser]', m),
  reuse: true,
})

try {
  const curHref = await b.eval('location.href').catch(() => '')
  if (!/^https:\/\/www\.douyin\.com\//.test(curHref)) {
    await b.goto(cfg.douyinUrl || 'https://www.douyin.com/jingxuan', { settleMs: 6000 })
  }
  const login = await checkLogin(b)
  console.log('登录状态:', login)

  const convs = await listConversations({ browser: b, limit: 20 })
  console.log('可见会话:', JSON.stringify(convs, null, 2))

  if (groupName) {
    const msgs = await readGroupMessages({ browser: b, groupName, limit: 20 })
    console.log(`群聊【${groupName}】消息:`, JSON.stringify(msgs, null, 2))
    if (inspect) {
      await enterGroupChat(b, groupName)
      const fiberDump = await b.eval(`(() => {
        const nodes = [...document.querySelectorAll('div[class*="messageMessageBox"]')];
        const samples = [];
        for (const n of nodes.slice(-4)) {
          const fk = Object.keys(n).find((k) => k.indexOf('__reactFiber$') === 0);
          let f = fk ? n[fk] : null;
          let msg = null, extraProps = null, userInfo = null;
          for (let d = 0; f && d < 35; d++) {
            const p = f.memoizedProps;
            if (p && p.message && typeof p.message === 'object') {
              msg = p.message;
              extraProps = Object.keys(p);
              userInfo = p.userInfo || p.senderInfo || p.user || null;
              break;
            }
            f = f.return;
          }
          if (msg) {
            samples.push({
              innerText: (n.innerText || '').slice(0, 120),
              extraProps,
              userInfo,
              msgKeys: Object.keys(msg),
              sender: msg.sender,
              isFromMe: msg.isFromMe,
              parsedContent: msg.parsedContent,
              ext: msg.ext,
            });
          }
        }
        return samples;
      })()`)
      console.log('React Fiber 样本:', JSON.stringify(fiberDump, null, 2))
    }
  }
} finally {
  b.detach()
}

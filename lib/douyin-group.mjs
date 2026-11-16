/**
 * lib/douyin-group.mjs —— 抖音网页版群聊 RPA 操作层（基于 CDP）
 *
 * 结合了：
 *   1. douyin-rpa-bridge 的 React Fiber (__reactFiber$) 群消息穿透解析、
 *      头像 midX + 连续气泡方向继承算法、单行安全输入机制；
 *   2. DSH CDP 控制器的零外部依赖、data-e2e 多级降级选择器、面板防重复开关、
 *      以及发送后冒泡验证机制。
 */
import { existsSync } from 'node:fs'
import { SEL, pageFindHelper } from './selectors.mjs'
import { pageMediaHelper, describeMedia, mediaFingerprintPart, MEDIA } from './media.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 抖音网页版 contenteditable 输入框在插入 `\n` 时会提前触发回车提交或报「不能发送空白消息」。
 * 统一压成单行纯文本。
 */
export function normalizeSingleLine(text) {
  return String(text || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 构造群聊常见系统提示过滤正则 */
const SYSTEM_MSG_RE = new RegExp([
  '已互相关注',
  '可以开始聊天',
  '发布了新作品',
  '进入了直播间',
  '关注了你',
  '赞了你的',
  '系统消息',
  '撤回了一条消息',
  '加入了群聊',
  '退出了群聊',
  '移出了群聊',
  '修改群名为',
  '邀请.*加入了群',
  '暂不支持该消息类型展示',
  '请到抖音手机端查看',
  '消息已发出.*但被对方拒收',
  '对方开启了朋友验证',
].join('|'))

/**
 * 对页面侧提取的原始群消息数组做归一化：
 *   - 按 y 坐标排序（视觉自上而下）
 *   - 去重同位置嵌套节点
 *   - 连续气泡方向继承（若页面侧未完成）
 *   - 标记系统消息与媒体描述文本
 */
export function normalizeGroupMessages(rawMsgs) {
  if (!Array.isArray(rawMsgs)) return []

  const sorted = rawMsgs
    .filter((m) => m && typeof m === 'object')
    .slice()
    .sort((a, b) => (Number(a.y) || 0) - (Number(b.y) || 0))

  // 倒序连续气泡方向继承（与 douyin-rpa-bridge 一致）
  let carry = ''
  for (let i = sorted.length - 1; i >= 0; i--) {
    const own = sorted[i].own || ''
    if (own) carry = own
    const resolved = sorted[i].from || own || carry || (sorted[i].isFromMe ? 'me' : 'them')
    sorted[i].from = resolved
    sorted[i].fromMe = resolved === 'me'
  }

  const seen = new Set()
  const uniq = []
  for (const m of sorted) {
    const text = String(m.text || '').replace(/\s+/g, ' ').trim()
    const type = m.type || MEDIA.TEXT
    const media = m.media && typeof m.media === 'object' ? m.media : {}
    const sender = String(m.sender || '').trim()

    if (type === MEDIA.TEXT && !text) continue
    if (['下载客户端', '发送'].includes(text)) continue

    const dedupKey = [
      m.msgId || m.itemId || '',
      m.fromMe ? 'me' : 'them',
      sender,
      text.slice(0, 60),
      mediaFingerprintPart({ type, media }),
      Math.round((Number(m.y) || 0) / 4),
    ].join('|')

    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)

    const isShare = Boolean(m.isShare || type === MEDIA.SHARE)
    const unsupported = /暂不支持该消息类型展示/.test(text) || type === MEDIA.UNSUPPORTED
    const system = !isShare && SYSTEM_MSG_RE.test(text)

    const finalText = text || (type !== MEDIA.TEXT ? describeMedia({ type, media, text }) : '')
    if (!finalText) continue

    uniq.push({
      fromMe: Boolean(m.fromMe),
      from: m.fromMe ? 'me' : 'them',
      sender: sender || (m.fromMe ? '我' : '群友'),
      text: finalText.slice(0, 20000),
      type,
      media,
      isShare,
      system,
      unsupported,
      aweType: Number(m.aweType || 0),
      itemId: m.itemId ? String(m.itemId) : '',
      msgId: m.msgId ? String(m.msgId) : '',
    })
  }

  return uniq
}

/** 登录态检查（仅认 sessionid / sessionid_ss） */
export async function checkLogin(browser) {
  const ck = await browser.cookies(['https://www.douyin.com/', 'https://www.douyin.com/user/self'])
  const names = ck.map((c) => c.name)
  const logged = names.includes('sessionid') || names.includes('sessionid_ss')
  return {
    loggedIn: logged,
    cookies: names.length,
    detail: logged ? '已登录抖音' : '未登录（请先扫码登录抖音网页版）',
  }
}

/** 确保窗口处于桌面可视区，不至于跑到屏幕外看不见 */
async function ensureWindowVisible(browser) {
  try {
    const targetInfo = await browser.send('Browser.getWindowForTarget', { targetId: browser.targetId }).catch(() => null)
    if (!targetInfo?.windowId) return
    const bounds = targetInfo.bounds || {}
    const sw = await browser.eval('screen.availWidth').catch(() => 1920)
    const sh = await browser.eval('screen.availHeight').catch(() => 1080)
    const left = Number(bounds.left ?? 0)
    const top = Number(bounds.top ?? 0)
    if (bounds.windowState === 'minimized' || left < -100 || top < -100 || left > sw - 200 || top > sh - 150) {
      await browser.send('Browser.setWindowBounds', {
        windowId: targetInfo.windowId,
        bounds: {
          left: left < -100 || left > sw - 200 ? 40 : left,
          top: top < -100 || top > sh - 150 ? 40 : top,
          windowState: 'normal',
        },
      }).catch(() => {})
    }
  } catch { /* ignore */ }
}

/** 将浏览器窗口拉到桌面最前面（供扫码登录与人工过验证使用） */
export async function bringToFront(browser) {
  await ensureWindowVisible(browser)
  try {
    await browser.send('Page.bringToFront', {}, browser.sessionId)
  } catch { /* ignore */ }
}

/** 确保浏览器当前停在抖音主站并加载完成 */
export async function ensureDouyinPage(browser, targetUrl = 'https://www.douyin.com/jingxuan') {
  const href = await browser.eval('location.href').catch(() => '')
  if (!href || !/^https:\/\/www\.douyin\.com\//.test(href)) {
    await browser.goto(targetUrl, { settleMs: 7000 })
  }
}

/** 确保右侧消息抽屉处于打开状态 */
export async function ensurePanel(browser) {
  await ensureWindowVisible(browser)
  await ensureDouyinPage(browser)

  const READ_STATE = String.raw`(() => {
    const FIND = ${pageFindHelper()};
    const convs = FIND.conversationItem().filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 100 && r.height > 20;
    });
    const ta = document.querySelector('textarea');
    const ce = FIND.chatInput().filter((x) => x.getBoundingClientRect().width > 80);
    const inChat = Boolean((ta && ta.getBoundingClientRect().width > 80) || ce.length);
    const entry = document.querySelector('[data-e2e="im-entry"]') || document.querySelector('[data-e2e="msg-entry"]');
    const mr = entry ? entry.getBoundingClientRect() : null;
    const cap = document.querySelector('iframe[src*="verifycenter"], iframe[src*="captcha"], [class*="captcha_verify"]');
    const capR = cap ? cap.getBoundingClientRect() : null;
    const hasCaptcha = Boolean(capR && capR.width > 50 && capR.height > 50);
    return {
      inChat,
      panelOpen: convs.length > 0 || inChat,
      convCount: convs.length,
      hasMsgBtn: Boolean(entry),
      hasCaptcha,
      msgAt: mr && mr.width > 0 ? { x: Math.round(mr.left + mr.width / 2), y: Math.round(mr.top + mr.height / 2) } : null,
      vw: innerWidth,
      vh: innerHeight,
    };
  })()`

  let st = await browser.eval(READ_STATE).catch(() => ({ inChat: false, panelOpen: false }))
  if (st.inChat || st.panelOpen) return st
  if (st.hasCaptcha) {
    await bringToFront(browser)
    return { ...st, error: '抖音页面弹出人机验证，请在弹出的浏览器窗口中手动完成验证后自动恢复' }
  }

  // 等待 im-entry 渲染（页面刚打开时延迟出现）
  for (let i = 0; i < 10; i++) {
    const hasEntry = await browser.eval(
      'Boolean(document.querySelector(\'[data-e2e="im-entry"], [data-e2e="msg-entry"]\'))',
    ).catch(() => false)
    if (hasEntry) break
    await sleep(600)
  }

  // ① 单点一次最内层按钮/文字（避免同时点内外两层把 toggle 开关按两下又关掉）
  await browser.eval(`(() => {
    const el = document.querySelector('[data-e2e="im-entry"]') || document.querySelector('[data-e2e="msg-entry"]');
    if (!el) return false;
    const btn = el.querySelector('[data-e2e="something-button"]') || el.querySelector('p') || el.querySelector('i') || el;
    btn.click();
    return true;
  })()`).catch(() => false)

  for (let i = 0; i < 6; i++) {
    await sleep(600)
    st = await browser.eval(READ_STATE).catch(() => ({ inChat: false, panelOpen: false }))
    if (st.inChat || st.panelOpen) return st
  }

  // ② 兜底：使用最新坐标做一次真实鼠标点击
  if (st.msgAt) {
    try {
      await browser.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: st.msgAt.x, y: st.msgAt.y, button: 'left', clickCount: 1,
      }, browser.sessionId)
      await browser.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: st.msgAt.x, y: st.msgAt.y, button: 'left', clickCount: 1,
      }, browser.sessionId)
      for (let i = 0; i < 5; i++) {
        await sleep(500)
        st = await browser.eval(READ_STATE).catch(() => ({ inChat: false, panelOpen: false }))
        if (st.inChat || st.panelOpen) return st
      }
    } catch { /* ignore */ }
  }

  // ③ 最后兜底：逐个候选节点试一次（每次都检查是否已经打开，防止重复 toggle）
  const trySingle = async (selectorStep) => {
    await browser.eval(selectorStep).catch(() => false)
    await sleep(1200)
    st = await browser.eval(READ_STATE).catch(() => ({ inChat: false, panelOpen: false }))
    return Boolean(st.inChat || st.panelOpen)
  }
  if (await trySingle('(() => { const el = document.querySelector(\'[data-e2e="im-entry"]\'); if (!el) return false; el.click(); return true; })()')) return st
  if (await trySingle('(() => { const el = document.querySelector(\'[data-e2e="im-entry"]\'); if (!el?.parentElement) return false; el.parentElement.click(); return true; })()')) return st

  return { ...st, error: '无法展开抖音消息抽屉，请确认已在浏览器中登录且窗口可见' }
}

/** 读取当前选中的会话/群名 */
export async function currentGroupChat({ browser }) {
  const JS = String.raw`(() => {
    const FIND = ${pageFindHelper()};
    const ta = document.querySelector('textarea');
    const ce = FIND.chatInput().filter((x) => x.getBoundingClientRect().width > 80);
    const inChat = Boolean((ta && ta.getBoundingClientRect().width > 80) || ce.length);
    if (!inChat) return { inChat: false, name: '' };

    const isNoise = (s) => /^\d{1,3}$/.test(s)
      || /^\d{1,2}:\d{2}$/.test(s)
      || /^(昨天|刚刚|\d+秒前|\d+分钟前|\d+小时前|\d+天前|\d{1,2}月\d{1,2}日)$/.test(s);

    const nameOf = (item) => {
      const title = FIND.one(item, 'conversationTitle');
      const parts = ((title?.innerText || '').trim() || (item.innerText || '').trim())
        .split('\n').map((s) => s.trim()).filter((s) => s && !isNoise(s));
      return (parts[0] || '').replace(/\s*\d{1,3}\s*$/, '').trim();
    };

    // ① 优先读左侧列表高亮选中项
    const items = FIND.conversationItem().filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 100 && r.height > 20;
    });
    for (const el of items) {
      const marks = [el, el.parentElement, el.firstElementChild].filter(Boolean);
      for (const m of marks) {
        const c = String(m.className || '');
        if (/active|selected|current|checked|isActive/i.test(c)) {
          const name = nameOf(el);
          if (name) return { inChat: true, name, via: 'active-item' };
        }
      }
    }

    // ② 其次读 im-dialog 内聊天头部标题（窄抽屉模式下左侧列表可能隐藏）
    const dialog = document.querySelector('[data-e2e="im-dialog"]')
      || document.querySelector('[class*="componentsRightPanel"]')
      || document;
    const header = FIND.one(dialog, 'chatHeaderTitle');
    if (header) {
      const ht = (header.innerText || '').trim().split('\n')[0].trim();
      if (ht && ht !== '消息') return { inChat: true, name: ht, via: 'header-title' };
    }

    return { inChat: true, name: '', via: 'unknown' };
  })()`

  return (await browser.eval(JS).catch(() => null)) || { inChat: false, name: '' }
}

/**
 * 根据 React Fiber 与标题特征判定会话类型（group / dm / unknown）
 */
export function classifyConversation(row) {
  if (!row || typeof row !== 'object') return { ...row, kind: 'unknown' }
  const ct = Number(row.conversationType ?? 0)
  const mc = Number(row.memberCount ?? 0)
  const cid = String(row.conversationId || '')
  const rawTitle = String(row.rawTitle || row.name || '')
  const name = String(row.name || '').trim()

  let kind = 'unknown'
  if (row.isGroup === true || ct === 2 || mc > 2 || /^0:2:/.test(cid) || /group/i.test(cid)) {
    kind = 'group'
  } else if (/\(\d{1,4}\)\s*$/.test(rawTitle) && !/\(\d{1,4}\)\s*$/.test(name)) {
    kind = 'group'
  } else if (/\(\d{1,4}\)\s*$/.test(name) && mc >= 2) {
    kind = 'group'
  } else if (row.isGroup === false || ct === 1 || /^0:1:/.test(cid)) {
    kind = 'dm'
  }

  return {
    ...row,
    kind,
    memberCount: mc > 0 ? mc : undefined,
  }
}

/** 列出消息抽屉中的所有会话（支持滚动分页收集与 React Fiber 群聊识别） */
export async function listConversations({ browser, limit = 60, maxScrolls = 8, query = '' }) {
  const st = await ensurePanel(browser)
  if (!st.panelOpen && !st.inChat) {
    return { ok: false, error: st.error || '无法打开抖音消息面板', conversations: [] }
  }

  // 如果处于窄版单聊界面且看不到会话列表，点返回按钮退回列表
  const hasVisibleList = await browser.eval(`(() => {
    const items = [...document.querySelectorAll('[data-e2e="conversation-item"], [class*="ConversationItemwrapper"]')]
      .filter((el) => el.getBoundingClientRect().width > 100 && el.getBoundingClientRect().height > 20);
    return items.length > 0;
  })()`).catch(() => false)

  if (!hasVisibleList && st.inChat) {
    await browser.eval(`(() => {
      const dialog = document.querySelector('[data-e2e="im-dialog"]') || document;
      const svg = dialog.querySelector('[class*="header"] svg, [class*="back"] svg, [class*="Title"] svg');
      if (svg && svg.parentElement) svg.parentElement.click();
    })()`).catch(() => {})
    await sleep(1500)
  }

  const ROWS_JS = String.raw`(() => {
    const FIND = ${pageFindHelper()};
    const items = FIND.conversationItem();
    const isNoise = (s) => /^\d{1,3}$/.test(s)
      || /^\d{1,2}:\d{2}$/.test(s)
      || /^(昨天|刚刚|\d+秒前|\d+分钟前|\d+小时前|\d+天前|\d{1,2}月\d{1,2}日)$/.test(s);

    const readFiberMeta = (el) => {
      const fk = Object.keys(el).find((k) => k.indexOf('__reactFiber$') === 0);
      if (!fk) return {};
      let f = el[fk];
      for (let d = 0; f && d < 20; d++) {
        const p = f.memoizedProps;
        if (p && typeof p === 'object') {
          const cand = p.conversation || p.conv || p.conversationInfo || p.data || p.item || p;
          if (cand && typeof cand === 'object' && (
            cand.conversationId !== undefined
            || cand.conversationShortId !== undefined
            || cand.conversationType !== undefined
            || cand.type !== undefined
            || cand.memberCount !== undefined
            || cand.isGroup !== undefined
            || cand.coreInfo !== undefined
          )) {
            const core = cand.coreInfo || cand;
            const nameFromFiber = String(core.name || cand.name || cand.title || cand.nickname || '').trim();
            return {
              conversationId: String(cand.conversationId || cand.conversationShortId || cand.id || ''),
              conversationType: Number(cand.conversationType ?? cand.type ?? core.conversationType ?? 0),
              isGroup: typeof cand.isGroup === 'boolean' ? cand.isGroup : (typeof core.isGroup === 'boolean' ? core.isGroup : undefined),
              memberCount: Number(cand.memberCount ?? core.memberCount ?? cand.participantCount ?? (Array.isArray(cand.members) ? cand.members.length : 0) ?? 0),
              fiberName: nameFromFiber,
            };
          }
        }
        f = f.return;
      }
      return {};
    };

    const out = [];
    for (const el of items) {
      const r = el.getBoundingClientRect();
      if (r.width < 100 || r.height < 20) continue;
      const nameEl = FIND.one(el, 'conversationTitle');
      const timeEl = FIND.one(el, 'conversationTime');
      const descEl = FIND.one(el, 'conversationDesc');
      const raw = (el.innerText || '').trim();
      const title = (nameEl?.innerText || '').trim();
      const parts = (title || raw).split('\n').map((s) => s.trim()).filter((s) => s && !isNoise(s));
      const domName = (parts[0] || '').replace(/\s*\d{1,3}\s*$/, '').trim();
      const meta = readFiberMeta(el);
      const name = domName || meta.fiberName || '';
      if (!name) continue;
      const badge = FIND.one(el, 'unreadBadge');
      out.push({
        name,
        rawTitle: title || domName,
        conversationId: meta.conversationId || '',
        conversationType: meta.conversationType || 0,
        isGroup: meta.isGroup,
        memberCount: meta.memberCount || 0,
        time: (timeEl?.innerText || '').trim(),
        preview: (descEl?.innerText || '').trim().split('\n').join(' ').slice(0, 200),
        unread: Boolean(badge),
        y: Math.round(r.top),
      });
    }

    // 定位会话列表可滚动容器，方便翻页拉取更多群聊
    let scrollInfo = { canScroll: false, atEnd: true };
    const dialog = document.querySelector('[data-e2e="im-dialog"]')
      || document.querySelector('[class*="LeftPanelwrapper"]')
      || document;
    let scroller = null;
    let bestH = 0;
    for (const d of dialog.querySelectorAll('div')) {
      if (d.scrollHeight <= d.clientHeight + 20) continue;
      if (!d.querySelector('[data-e2e="conversation-item"], [class*="ConversationItemwrapper"]')) continue;
      const dr = d.getBoundingClientRect();
      if (dr.height > bestH) { bestH = dr.height; scroller = d; }
    }
    if (scroller) {
      scrollInfo = {
        canScroll: true,
        scrollTop: scroller.scrollTop,
        clientHeight: scroller.clientHeight,
        scrollHeight: scroller.scrollHeight,
        atEnd: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8,
      };
    }
    return { rows: out, scrollInfo };
  })()`

  const collected = new Map()
  const scrollSteps = Math.max(1, Math.min(20, Number(maxScrolls) || 1))

  // 先确保回到顶部再从头扫描
  await browser.eval(`(() => {
    const dialog = document.querySelector('[data-e2e="im-dialog"]') || document;
    for (const d of dialog.querySelectorAll('div')) {
      if (d.scrollHeight > d.clientHeight + 20 && d.querySelector('[data-e2e="conversation-item"], [class*="ConversationItemwrapper"]')) {
        d.scrollTop = 0;
      }
    }
  })()`).catch(() => {})
  await sleep(300)

  for (let step = 0; step < scrollSteps; step++) {
    let snap = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      snap = await browser.eval(ROWS_JS).catch(() => null)
      if (snap && Array.isArray(snap.rows) && snap.rows.length) break
      await sleep(500)
    }
    if (!snap || !Array.isArray(snap.rows)) {
      if (step === 0) return { ok: false, error: '读不到会话列表', conversations: [] }
      break
    }

    const prevCount = collected.size
    for (const row of snap.rows) {
      const key = row.conversationId || row.name
      if (!collected.has(key)) {
        collected.set(key, classifyConversation({ ...row, order: collected.size }))
      }
    }

    if (!snap.scrollInfo?.canScroll || snap.scrollInfo?.atEnd || collected.size >= limit) break
    if (step > 0 && collected.size === prevCount) break

    await browser.eval(`(() => {
      const dialog = document.querySelector('[data-e2e="im-dialog"]') || document;
      for (const d of dialog.querySelectorAll('div')) {
        if (d.scrollHeight > d.clientHeight + 20 && d.querySelector('[data-e2e="conversation-item"], [class*="ConversationItemwrapper"]')) {
          d.scrollTop = Math.min(d.scrollHeight, d.scrollTop + Math.max(240, Math.round(d.clientHeight * 0.8)));
        }
      }
    })()`).catch(() => {})
    await sleep(450)
  }

  // 恢复滚动位置到顶部
  await browser.eval(`(() => {
    const dialog = document.querySelector('[data-e2e="im-dialog"]') || document;
    for (const d of dialog.querySelectorAll('div')) {
      if (d.scrollHeight > d.clientHeight + 20 && d.querySelector('[data-e2e="conversation-item"], [class*="ConversationItemwrapper"]')) {
        d.scrollTop = 0;
      }
    }
  })()`).catch(() => {})

  let all = [...collected.values()]
  const q = String(query || '').trim().toLowerCase()
  if (q) {
    all = all.filter((c) => c.name.toLowerCase().includes(q) || String(c.preview || '').toLowerCase().includes(q))
  }

  return {
    ok: true,
    conversations: all.slice(0, limit),
    total: all.length,
  }
}

/** 扫码登录后自动检索当前账号下的群聊列表 */
export async function discoverAccountGroups({ browser, query = '', groupOnly = true, maxScrolls = 10, limit = 100 }) {
  const login = await checkLogin(browser)
  if (!login.loggedIn) {
    return {
      ok: false,
      loggedIn: false,
      error: '尚未登录抖音，请先完成扫码登录',
      groups: [],
      conversations: [],
    }
  }

  const res = await listConversations({ browser, limit, maxScrolls, query })
  if (!res.ok) {
    return {
      ok: false,
      loggedIn: true,
      error: res.error || '检索会话列表失败',
      groups: [],
      conversations: [],
    }
  }

  const conversations = res.conversations || []
  const confirmedGroups = conversations.filter((c) => c.kind === 'group')
  const unknownConvs = conversations.filter((c) => c.kind === 'unknown')
  const groups = groupOnly
    ? (confirmedGroups.length ? confirmedGroups : unknownConvs)
    : conversations

  return {
    ok: true,
    loggedIn: true,
    groups,
    confirmedGroupCount: confirmedGroups.length,
    unknownCount: unknownConvs.length,
    conversations,
    total: conversations.length,
    discoveredAt: Date.now(),
  }
}

/** 切入目标群聊（精确匹配优先，其次子串匹配） */
export async function enterGroupChat(browser, groupName) {
  const want = String(groupName || '').trim()
  if (!want) return { ok: false, error: '未指定目标群聊名称' }

  const st = await ensurePanel(browser)
  if (!st.panelOpen && !st.inChat) {
    return { ok: false, error: st.error || '打不开消息面板' }
  }

  // 快路径：已经在目标群聊中
  const cur = await currentGroupChat({ browser }).catch(() => ({ inChat: false, name: '' }))
  if (cur.inChat && cur.name && (cur.name === want || cur.name.includes(want) || want.includes(cur.name))) {
    return { ok: true, via: 'already-in-group', name: cur.name }
  }

  // 检查列表是否可见；若处于窄版其他会话中，先点返回回到会话列表
  const hasList = await browser.eval(`(() => {
    return [...document.querySelectorAll('[data-e2e="conversation-item"], [class*="ConversationItemwrapper"]')]
      .some((el) => el.getBoundingClientRect().width > 100 && el.getBoundingClientRect().height > 20);
  })()`).catch(() => false)

  if (!hasList && cur.inChat) {
    await browser.eval(`(() => {
      const dialog = document.querySelector('[data-e2e="im-dialog"]') || document;
      const svg = dialog.querySelector('[class*="header"] svg, [class*="back"] svg, [class*="Title"] svg');
      if (svg && svg.parentElement) svg.parentElement.click();
    })()`).catch(() => {})
    await sleep(1500)
  }

  const CLICK_JS = String.raw`(() => {
    const FIND = ${pageFindHelper()};
    const want = ${JSON.stringify(want)};
    const isNoise = (s) => /^\d{1,3}$/.test(s)
      || /^\d{1,2}:\d{2}$/.test(s)
      || /^(昨天|刚刚|\d+秒前|\d+分钟前|\d+小时前|\d+天前|\d{1,2}月\d{1,2}日)$/.test(s);

    const rows = FIND.conversationItem()
      .map((el) => {
        const r = el.getBoundingClientRect();
        const nameEl = FIND.one(el, 'conversationTitle');
        const raw = (nameEl?.innerText || '').trim() || (el.innerText || '').trim();
        const parts = raw.split('\n').map((s) => s.trim()).filter((s) => s && !isNoise(s));
        const name = (parts[0] || '').replace(/\s*\d{1,3}\s*$/, '').trim();
        return { el, y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), name };
      })
      .filter((x) => x.name && x.w > 100 && x.h > 20)
      .sort((a, b) => a.y - b.y);

    if (!rows.length) return { err: 'no-items' };
    const exact = rows.find((r) => r.name === want);
    const hit = exact || rows.find((r) => r.name.includes(want) || want.includes(r.name));
    if (!hit) return { err: 'not-found', available: rows.map((r) => r.name) };

    const fire = (el) => {
      if (!el) return;
      const o = { bubbles: true, cancelable: true, view: window };
      try { el.dispatchEvent(new PointerEvent('pointerdown', o)); } catch (e) {}
      try { el.dispatchEvent(new MouseEvent('mousedown', o)); } catch (e) {}
      try { el.dispatchEvent(new PointerEvent('pointerup', o)); } catch (e) {}
      try { el.dispatchEvent(new MouseEvent('mouseup', o)); } catch (e) {}
      try { el.dispatchEvent(new MouseEvent('click', o)); } catch (e) {}
      try { el.click(); } catch (e) {}
    };

    fire(hit.el);
    fire(hit.el.parentElement);
    fire(hit.el.querySelector('[class*="rowArea2"]'));
    fire(FIND.one(hit.el, 'conversationDesc'));
    return { ok: true, name: hit.name };
  })()`

  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await browser.eval(CLICK_JS).catch((e) => ({ err: String(e?.message || e) }))
    if (res?.err === 'not-found') {
      return { ok: false, error: `找不到群聊「${want}」，当前可见会话：${(res.available || []).join('、')}` }
    }
    if (!res?.ok) {
      if (attempt === 2) return { ok: false, error: `无法点击群聊「${want}」(${res?.err || 'unknown'})` }
      await sleep(1000)
      continue
    }

    await sleep(1800)
    const hasInput = await browser.eval(`(() => {
      const ta = document.querySelector('textarea');
      const ce = [...document.querySelectorAll('[contenteditable="true"]')].some((x) => x.getBoundingClientRect().width > 80);
      return Boolean((ta && ta.getBoundingClientRect().width > 80) || ce);
    })()`).catch(() => false)

    if (hasInput) {
      const now = await currentGroupChat({ browser }).catch(() => ({ inChat: true, name: res.name }))
      if (!now.name || now.name === want || now.name.includes(want) || want.includes(now.name)) {
        return { ok: true, name: now.name || res.name, attempt }
      }
    }
  }

  return { ok: false, error: `进入群聊「${want}」后未出现聊天输入框` }
}

/**
 * 读取指定群聊中的可见消息。
 * 核心采用 douyin-rpa-bridge 的 React Fiber (__reactFiber$) 穿透方案，
 * 并结合 DOM 媒体提取与头像 midX + 连续气泡方向继承算法。
 */
export async function readGroupMessages({ browser, groupName, limit = 40, scrollBack = 0 }) {
  const entered = await enterGroupChat(browser, groupName)
  if (!entered.ok) {
    return { ok: false, error: entered.error, messages: [] }
  }

  if (scrollBack > 0) {
    for (let i = 0; i < scrollBack; i++) {
      await browser.eval(`(() => {
        let best = null;
        let bestArea = 0;
        for (const el of document.querySelectorAll('div')) {
          if (el.scrollHeight <= el.clientHeight + 20) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 200 || r.height < 150) continue;
          const area = r.width * r.height;
          if (area > bestArea) { bestArea = area; best = el; }
        }
        if (best) best.scrollTop = 0;
      })()`).catch(() => {})
      await sleep(1200)
    }
  }

  const EXTRACT_JS = String.raw`(() => {
    const FIND = ${pageFindHelper()};
    ${pageMediaHelper()}

    const listNode = FIND.one(document, 'messageList')
      || document.querySelector('[class*="messageMessageList"]')
      || document.querySelector('[class*="componentsRightPanel"]')
      || document.body;
    const lb = listNode.getBoundingClientRect();
    const mid = lb.left + lb.width / 2;

    const nodes = [...document.querySelectorAll(
      '[data-e2e="message-item"], div[class*="messageMessageBox"], [class*="MessageItemTextcontainer"], [data-e2e="msg-item-content"]'
    )];

    const out = [];
    const seenFiberObj = new WeakSet();

    for (const n of nodes) {
      const r = n.getBoundingClientRect();
      if (r.width < 40 || r.height < 14) continue;

      const fk = Object.keys(n).find((k) => k.indexOf('__reactFiber$') === 0);
      let found = null;
      if (fk) {
        let f = n[fk];
        let d = 0;
        while (f && d < 35) {
          const p = f.memoizedProps;
          if (p && p.message && typeof p.message === 'object' && (p.message.parsedContent || p.message.content !== undefined)) {
            found = p.message;
            break;
          }
          f = f.return;
          d++;
        }
      }

      // 优先以 React Fiber message 对象去重
      if (found) {
        if (seenFiberObj.has(found)) continue;
        seenFiberObj.add(found);
      }

      // 判断头像 X 坐标（midX 算法）
      let side = '';
      const imgs = [...n.querySelectorAll('img')];
      const avatarImg = imgs.find((img) => {
        const b = img.getBoundingClientRect();
        if (b.width < 24 || b.width > 56) return false;
        const cy = b.top + b.height / 2;
        return cy >= r.top - 14 && cy <= r.bottom + 14;
      });
      if (avatarImg) {
        const ib = avatarImg.getBoundingClientRect();
        side = ((ib.left + ib.width / 2) < mid) ? 'them' : 'me';
      }

      const type = typeOf(n);
      const media = {};
      if (type === 'image') {
        const src = imgOf(n, 'image');
        media.src = src;
        const dim = sizeOf(n);
        media.width = dim.w;
        media.height = dim.h;
        if (src && src.indexOf('data:') === 0 && src.length < 1500000) media.data = src;
      } else if (type === 'emoji') {
        const eBox = findByCls(n, 'MessageItemEmojiemojiBox');
        const img = eBox ? eBox.querySelector('img') : null;
        media.src = img ? (img.getAttribute('src') || '') : '';
        media.name = textOf(n, 'MessageItemEmojiname') || (img ? (img.getAttribute('alt') || img.getAttribute('title') || '') : '');
      } else if (type === 'voice') {
        media.seconds = voiceSeconds(n);
      } else if (type === 'location') {
        media.name = textOf(n, 'MessageItemLocationtitle') || '';
      } else if (type === 'video') {
        media.src = imgOf(n, 'video');
        const dim = sizeOf(n);
        media.width = dim.w;
        media.height = dim.h;
      } else if (type === 'share') {
        media.title = textOf(n, 'MessageItemShareAwemeauthorName') || '';
      }

      if (found) {
        const pc = found.parsedContent || {};
        const rawText = String(pc.text || pc.content_title || n.innerText || '').replace(/\s+/g, ' ').trim();
        out.push({
          own: side,
          text: rawText,
          sender: String(found.senderNickname || found.senderName || found.nickname || found.sender || '').trim(),
          type,
          media,
          aweType: Number(pc.aweType || 0),
          itemId: found.itemId ? String(found.itemId) : '',
          msgId: String(found.serverId || found.clientId || found.msgId || found.id || ''),
          isFromMe: Boolean(found.isFromMe) || Boolean(FIND.one(n, 'fromMe')) || String(n.className || '').includes('FromMe'),
          isShare: Boolean(FIND.one(n, 'shareCard')) || type === 'share',
          y: Math.round(r.top),
        });
      } else {
        // DOM 兜底路径
        const cls = String(n.className || '');
        if (cls.includes('selectableRow') || cls.includes('contentBox')) continue;
        const lines = (n.innerText || '').trim().split('\n').map((s) => s.replace(/\u200b/g, '').trim()).filter(Boolean);
        const text = lines.join(' ').trim();
        if (type === 'text' && !text) continue;
        out.push({
          own: side,
          text,
          sender: '',
          type,
          media,
          aweType: 0,
          itemId: '',
          msgId: '',
          isFromMe: Boolean(FIND.one(n, 'fromMe')) || cls.includes('FromMe'),
          isShare: Boolean(FIND.one(n, 'shareCard')) || type === 'share',
          y: Math.round(r.top),
        });
      }
    }

    return out;
  })()`

  const raw = await browser.eval(EXTRACT_JS).catch((e) => ({ err: String(e?.message || e) }))
  if (!Array.isArray(raw)) {
    return { ok: false, error: raw?.err || '提取群聊消息失败', messages: [] }
  }

  const normalized = normalizeGroupMessages(raw)
  return {
    ok: true,
    group: entered.name || groupName,
    messages: normalized.slice(-limit),
    total: normalized.length,
  }
}

/**
 * 向指定抖音群聊发送单行纯文本消息，并验证其出现在消息列表中。
 */
export async function sendGroupMessage({ browser, groupName, text, atSender = '' }) {
  let payload = normalizeSingleLine(text)
  if (!payload) return { ok: false, error: '发送内容不能为空' }
  if (atSender && !payload.startsWith('@')) {
    payload = `@${normalizeSingleLine(atSender)} ${payload}`
  }

  const entered = await enterGroupChat(browser, groupName)
  if (!entered.ok) return { ok: false, error: entered.error }

  const focused = await browser.eval(`(() => {
    const ta = document.querySelector('textarea');
    const ce = [...document.querySelectorAll('[contenteditable="true"]')]
      .filter((x) => x.getBoundingClientRect().width > 80)
      .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
    const el = (ta && ta.getBoundingClientRect().width > 80) ? ta : ce;
    if (!el) return null;
    el.focus();
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`).catch(() => null)

  if (!focused) return { ok: false, error: '找不到群聊输入框' }

  // 真实鼠标点击聚焦 + JS 选区兜底
  try {
    await browser.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: focused.x, y: focused.y, button: 'left', clickCount: 1,
    }, browser.sessionId)
    await browser.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: focused.x, y: focused.y, button: 'left', clickCount: 1,
    }, browser.sessionId)
  } catch { /* ignore */ }
  await sleep(250)

  await browser.eval(`(() => {
    const ce = [...document.querySelectorAll('[contenteditable="true"]')]
      .filter((x) => x.getBoundingClientRect().width > 50 && x.getBoundingClientRect().height > 10)
      .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
    if (!ce) return false;
    ce.focus();
    const inner = ce.querySelector('[contenteditable="true"]');
    if (inner && inner !== ce) inner.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(inner || ce);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  })()`).catch(() => false)
  await sleep(180)

  const READ_INPUT = `(() => {
    const ta = document.querySelector('textarea');
    const ce = [...document.querySelectorAll('[contenteditable="true"]')].find((x) => x.getBoundingClientRect().width > 80);
    const el = (ta && ta.getBoundingClientRect().width > 80) ? ta : ce;
    return el ? String(el.value || el.innerText || '').replace(/\u200b/g, '').trim() : '';
  })()`

  // 先尝试 CDP Input.insertText；如果为空再降级 document.execCommand('insertText')
  await browser.send('Input.insertText', { text: payload }, browser.sessionId)
  await sleep(600)

  let typed = await browser.eval(READ_INPUT).catch(() => '')
  if (!typed) {
    await browser.eval(`(() => {
      const ce = [...document.querySelectorAll('[contenteditable="true"]')]
        .filter((x) => x.getBoundingClientRect().width > 50 && x.getBoundingClientRect().height > 10)
        .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
      if (!ce) return false;
      ce.focus();
      document.execCommand('insertText', false, ${JSON.stringify(payload)});
      return true;
    })()`).catch(() => false)
    await sleep(600)
    typed = await browser.eval(READ_INPUT).catch(() => '')
  }

  if (!typed) {
    return { ok: false, error: '输入框写入失败（输入框仍为空）' }
  }

  // Enter 发送
  await browser.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
  }, browser.sessionId)
  await browser.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
  }, browser.sessionId)
  await sleep(1800)

  const after = await browser.eval(READ_INPUT).catch(() => '')
  if (after) {
    return { ok: false, error: '回车后输入框仍有残留文本，可能未成功发出' }
  }

  // 气泡验证
  const probe = payload.slice(0, 20)
  for (let i = 0; i < 4; i++) {
    const seen = await browser.eval(String.raw`(() => {
      const FINDV = ${pageFindHelper()};
      const boxes = FINDV.messageBox();
      for (const b of boxes) {
        if ((b.innerText || '').includes(${JSON.stringify(probe)})) return true;
      }
      return false;
    })()`).catch(() => false)
    if (seen) return { ok: true, verified: true, group: entered.name || groupName, sent: payload }
    await sleep(900)
  }

  return { ok: true, verified: false, group: entered.name || groupName, sent: payload }
}

/** 通过 CDP file chooser 向群聊发送图片（支持 jpg/png/gif，不支持 webp） */
export async function sendGroupImage({ browser, groupName, file }) {
  if (!file || !existsSync(file)) return { ok: false, error: `图片文件不存在：${file}` }
  if (/\.webp$/i.test(file)) {
    return { ok: false, error: '抖音网页端上传控件不支持 .webp 格式，请先转为 .png 或 .jpg' }
  }

  const entered = await enterGroupChat(browser, groupName)
  if (!entered.ok) return { ok: false, error: entered.error }

  const beforeImgs = await browser.eval(`(() => {
    return [...document.querySelectorAll('[class*="MessageItemImageImageBox"] img')].map((i) => i.getAttribute('src') || '');
  })()`).catch(() => [])

  await browser.send('Page.setInterceptFileChooserDialog', { enabled: true }, browser.sessionId)
  try {
    const chooserPromise = browser.waitForEvent('Page.fileChooserOpened', { timeoutMs: 12000 })
    const clicked = await browser.eval(`(() => {
      const btn = document.querySelector('.semi-upload-add') || document.querySelector('[class*="upload"] [role="button"]');
      if (!btn) return false;
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      btn.click();
      return true;
    })()`)
    if (!clicked) return { ok: false, error: '找不到群聊图片上传按钮 (.semi-upload-add)' }

    const ev = await chooserPromise
    const backendNodeId = ev?.params?.backendNodeId
    if (!backendNodeId) return { ok: false, error: '未能拦截到文件选择框 backendNodeId' }

    await browser.send('DOM.setFileInputFiles', { files: [file], backendNodeId }, browser.sessionId)
    await sleep(1200)

    const confirmed = await browser.eval(`(() => {
      const btn = document.querySelector('[class*="MsgInputSendFileModalbtnSure"]');
      if (!btn) return false;
      btn.click();
      return true;
    })()`)
    if (!confirmed) return { ok: false, error: '未出现发送图片确认弹窗' }

    for (let i = 0; i < 10; i++) {
      await sleep(1000)
      const afterImgs = await browser.eval(`(() => {
        return [...document.querySelectorAll('[class*="MessageItemImageImageBox"] img')].map((i) => i.getAttribute('src') || '');
      })()`).catch(() => [])
      const beforeSet = new Set(beforeImgs.filter(Boolean))
      if (afterImgs.some((x) => x && !beforeSet.has(x))) {
        return { ok: true, verified: true, group: entered.name || groupName, file }
      }
    }
    return { ok: true, verified: false, group: entered.name || groupName, file }
  } finally {
    await browser.send('Page.setInterceptFileChooserDialog', { enabled: false }, browser.sessionId).catch(() => {})
  }
}

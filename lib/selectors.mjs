/**
 * lib/selectors.mjs —— 抖音网页版消息抽屉与群聊选择器注册表
 */

export const SEL = {
  msgEntry: [
    '[data-e2e="im-entry"]',
    '[data-e2e="msg-entry"]',
  ],

  msgDialog: [
    '[data-e2e="im-dialog"]',
    '[class*="LeftPanelwrapper"]',
    '[class*="componentsRightPanel"]',
  ],

  conversationItem: [
    '[data-e2e="conversation-item"]',
    '[class*="conversationConversationItemwrapper"]',
    '[class*="ConversationItemwrapper"]',
    '[class*="conversationItem"]',
  ],

  conversationTitle: [
    '[data-e2e="conversation-title"]',
    '[class*="conversationConversationItemtitle"]',
    '[class*="ConversationItemtitle"]',
    '[class*="conversationTitle"]',
  ],

  conversationTime: [
    '[class*="ConversationItemTagNextToTitle"]',
    '[class*="TagNextToTitle"]',
    '[class*="conversationTime"]',
  ],

  conversationDesc: [
    '[class*="ConversationItemDesc"]',
    '[class*="conversationDesc"]',
  ],

  chatHeaderTitle: [
    '[class*="headerTitle"]',
    '[class*="ChatTitle"]',
    '[class*="header-title"]',
    '[class*="ConversationTitle"]',
  ],

  messageList: [
    '[class*="messageMessageList"]',
    '[class*="componentsRightPanel"]',
  ],

  messageBox: [
    '[data-e2e="message-item"]',
    'div[class*="messageMessageBox"][class*="messageBox"]',
    'div[class*="messageMessageBox"]',
    '[class*="MessageItemTextcontainer"]',
    '[data-e2e="msg-item-content"]',
  ],

  messageContent: [
    '[data-e2e="msg-item-content"]',
  ],

  fromMe: [
    '[class*="isFromMe"]',
    '[class*="FromMe"]',
    '[data-e2e="message-from-me"]',
  ],

  shareCard: [
    '[class*="MessageItemShareAweme"]',
    '[data-e2e="share-aweme"]',
  ],

  chatInput: [
    '[data-e2e="msg-input"] [contenteditable="true"]',
    '[data-e2e="msg-input"]',
    'div[contenteditable="true"]',
  ],

  unreadBadge: [
    '[class*="Badge"]',
    '[class*="RedPoint"]',
    '[class*="Dot"]',
  ],
}

export function pageFindHelper() {
  return `(() => {
    const CHAINS = ${JSON.stringify({
      conversationItem: SEL.conversationItem,
      conversationTitle: SEL.conversationTitle,
      conversationTime: SEL.conversationTime,
      conversationDesc: SEL.conversationDesc,
      chatHeaderTitle: SEL.chatHeaderTitle,
      messageList: SEL.messageList,
      messageBox: SEL.messageBox,
      fromMe: SEL.fromMe,
      shareCard: SEL.shareCard,
      chatInput: SEL.chatInput,
      unreadBadge: SEL.unreadBadge,
    })};
    const all = (key) => {
      for (const sel of (CHAINS[key] || [])) {
        try {
          const found = [...document.querySelectorAll(sel)];
          if (found.length) return found;
        } catch (e) {}
      }
      return [];
    };
    const one = (root, key) => {
      if (!root) return null;
      for (const sel of (CHAINS[key] || [])) {
        try {
          const found = root.querySelector(sel);
          if (found) return found;
        } catch (e) {}
      }
      return null;
    };
    const out = { all, one };
    for (const k of Object.keys(CHAINS)) out[k] = () => all(k);
    return out;
  })()`
}

export async function whichHits(browser, chain) {
  try {
    return await browser.eval(`(() => {
      const CHAIN = ${JSON.stringify(chain)};
      for (const sel of CHAIN) {
        try {
          const n = document.querySelectorAll(sel).length;
          if (n) return { selector: sel, count: n };
        } catch (e) {}
      }
      return { selector: '', count: 0 };
    })()`)
  } catch {
    return { selector: '', count: 0 }
  }
}

export async function canary(browser) {
  const keys = [
    'msgEntry',
    'msgDialog',
    'conversationItem',
    'conversationTitle',
    'messageBox',
    'messageContent',
    'fromMe',
    'chatInput',
  ]
  const working = {}
  const broken = []

  for (const key of keys) {
    const r = await whichHits(browser, SEL[key])
    working[key] = r
    if (!r.count) broken.push(key)
  }

  const critical = ['msgEntry', 'msgDialog', 'conversationItem']
  const criticalBroken = broken.filter((k) => critical.includes(k))
  return {
    ok: criticalBroken.length === 0,
    broken: criticalBroken,
    absent: broken.filter((k) => !critical.includes(k)),
    working,
  }
}

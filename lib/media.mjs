/**
 * lib/media.mjs —— 抖音群聊非文本消息识别与描述
 */

export const MEDIA = {
  TEXT: 'text',
  IMAGE: 'image',
  EMOJI: 'emoji',
  VOICE: 'voice',
  VIDEO: 'video',
  SHARE: 'share',
  LOCATION: 'location',
  UNSUPPORTED: 'unsupported',
  SYSTEM: 'system',
}

/**
 * 注入到浏览器页面的媒体识别工具集。
 * 注意：此函数返回体内部禁止出现裸反引号，避免外层 browser.eval 模板被截断。
 */
export function pageMediaHelper() {
  return String.raw`
    const MEDIA_CLASSES = [
      ['image',      'MessageItemImageImageBox'],
      ['emoji',      'MessageItemEmojiemojiBox'],
      ['voice',      'MessageItemAudiocontainer'],
      ['video',      'MessageItemVideovideoBox'],
      ['share',      'MessageItemShareAwemecontainer'],
      ['location',   'MessageItemLocationstackLayout'],
      ['unsupported','MessageItemUnsuportunsupport'],
      ['text',       'MessageItemTextcontainer'],
    ];

    const clsOf = (el) => String((el && el.className) || '');

    const findByCls = (root, needle) => {
      if (!root) return null;
      if (clsOf(root).includes(needle)) return root;
      const all = root.querySelectorAll ? root.querySelectorAll('div,span,a') : [];
      for (const el of all) {
        if (clsOf(el).includes(needle)) return el;
      }
      return null;
    };

    const typeOf = (box) => {
      for (const [type, needle] of MEDIA_CLASSES) {
        if (findByCls(box, needle)) return type;
      }
      return 'text';
    };

    const CONTAINER_OF = {
      image: 'MessageItemImageImageBox',
      emoji: 'MessageItemEmojiemojiBox',
      video: 'MessageItemVideovideoBox',
    };

    const imgOf = (box, type) => {
      const needle = CONTAINER_OF[type];
      const holder = needle ? findByCls(box, needle) : null;
      if (holder) {
        const img = holder.querySelector('img');
        if (img) return img.getAttribute('src') || '';
      }
      return '';
    };

    const textOf = (box, needle) => {
      const el = findByCls(box, needle);
      return el ? (el.innerText || '').trim() : '';
    };

    const sizeOf = (box) => {
      const holder = findByCls(box, 'MessageItemImageImageBox')
        || findByCls(box, 'MessageItemVideovideoBox')
        || findByCls(box, 'MessageItemEmojiemojiBox');
      if (!holder) return { w: 0, h: 0 };
      const st = holder.getAttribute('style') || '';
      const mw = /width:\s*(\d+)px/.exec(st);
      const mh = /height:\s*(\d+)px/.exec(st);
      if (mw && mh) return { w: Number(mw[1]), h: Number(mh[1]) };
      const r = holder.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    };

    const voiceSeconds = (box) => {
      const raw = textOf(box, 'MessageItemAudioduration') || textOf(box, 'MessageItemAudiovoiceText');
      const m = /(\d+(?:\.\d+)?)/.exec(raw);
      if (m) return Number(m[1]);
      const sec = /(\d+)\s*秒/.exec(raw);
      return sec ? Number(sec[1]) : 0;
    };
  `
}

export function describeMedia(m) {
  if (!m) return ''
  const media = m.media || {}
  switch (m.type) {
    case MEDIA.IMAGE: {
      const dim = media.width && media.height ? ` ${media.width}×${media.height}` : ''
      return `[图片${dim}]`
    }
    case MEDIA.EMOJI:
      return `[表情${media.name ? '：' + media.name : ''}]`
    case MEDIA.VOICE:
      return `[语音${media.seconds ? ' ' + media.seconds + ' 秒' : ''}]`
    case MEDIA.VIDEO:
      return '[视频]'
    case MEDIA.LOCATION:
      return `[位置${media.name ? '：' + media.name : ''}]`
    case MEDIA.SHARE:
      return `[分享卡片${media.title ? '：' + media.title : ''}]`
    case MEDIA.UNSUPPORTED:
      return '[网页端显示不了的消息]'
    default:
      return m.text || ''
  }
}

export function dataUrlToBytes(dataUrl) {
  const s = String(dataUrl || '')
  const m = /^data:([^;,]+)?(;base64)?,/.exec(s)
  if (!m) return null
  const mediaType = m[1] || 'application/octet-stream'
  const isB64 = Boolean(m[2])
  const payload = s.slice(m[0].length)
  try {
    if (isB64) {
      return { bytes: new Uint8Array(Buffer.from(payload, 'base64')), mediaType }
    }
    return { bytes: new Uint8Array(Buffer.from(decodeURIComponent(payload), 'utf8')), mediaType }
  } catch {
    return null
  }
}

export function mediaFingerprintPart(m) {
  if (!m || !m.media) return ''
  const parts = [m.type || '']
  if (m.media.sha) parts.push(m.media.sha)
  if (m.media.src) {
    const s = String(m.media.src)
    const idx = s.indexOf('/obj/')
    const normalized = idx >= 0 ? s.slice(idx).split('?')[0] : s.split('?')[0].slice(-60)
    parts.push(normalized)
  }
  if (m.media.url) parts.push(m.media.url.slice(-40))
  if (m.media.name) parts.push(m.media.name)
  if (m.media.seconds) parts.push(String(m.media.seconds))
  return parts.join(':')
}

/**
 * client.js —— DeepSeek Harness 设置页扩展（设置 → 抖音群聊）
 */
window.__ModuleLoader__.load({
  id: 'dsh-douyin-group-bridge',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const API = '/dsh-douyin-group-bridge'

    const asJson = async (res) => {
      const text = await res.text()
      let body = {}
      try { body = text ? JSON.parse(text) : {} } catch { body = { raw: text } }
      if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status))
      if (body && body.ok === false) throw new Error(body.error || '操作失败')
      return body
    }

    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const CSS = `
[data-dyg-page]{display:flex;flex-direction:column;gap:18px;padding:2px 2px 14px;max-width:700px;}
[data-dyg-sec]{display:flex;flex-direction:column;gap:8px;}
[data-dyg-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dyg-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-dyg-label]{font-size:13px;}
[data-dyg-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dyg-val]{font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}
[data-dyg-input],[data-dyg-ta]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.15));color:inherit;}
[data-dyg-ta]{min-height:84px;resize:vertical;font-family:inherit;line-height:18px;}
[data-dyg-btn]{font-size:12px;padding:6px 12px;border-radius:8px;cursor:pointer;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.16));
  background:var(--dsw-alias-interactive-bg,rgba(128,128,128,.18));color:inherit;}
[data-dyg-btn:hover]{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.3));}
[data-dyg-btn][disabled]{opacity:.45;cursor:default;}
[data-dyg-chip]{font-size:12px;padding:5px 10px;border-radius:999px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.16));color:inherit;}
[data-dyg-chip][data-active="1"]{border-color:#4ade80;background:rgba(74,222,128,.16);}
[data-dyg-grid]{display:flex;flex-wrap:wrap;gap:8px;}
[data-dyg-sel]{font-size:12px;padding:6px 8px;border-radius:8px;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.15));color:inherit;}
[data-dyg-log]{font-size:11px;line-height:17px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  white-space:pre-wrap;word-break:break-all;max-height:240px;overflow:auto;
  padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.18));}
[data-dyg-pill]{font-size:11px;padding:2px 8px;border-radius:999px;
  background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.1));}
[data-dyg-ok]{color:#4ade80;}[data-dyg-bad]{color:#f87171;}[data-dyg-warn]{color:#fbbf24;}
`

    function Row(props) {
      return h('div', { 'data-dyg-row': '' }, props.children)
    }

    function Sec(props) {
      return h('div', { 'data-dyg-sec': '' },
        h('div', { 'data-dyg-h': '' }, props.title),
        props.children)
    }

    function Panel() {
      const [status, setStatus] = useState(null)
      const [cfg, setCfg] = useState(null)
      const [log, setLog] = useState([])
      const [msg, setMsg] = useState('')
      const [busy, setBusy] = useState(false)
      const [groupsText, setGroupsText] = useState('')
      const [aliasesText, setAliasesText] = useState('')
      const [pollSec, setPollSec] = useState('5')
      const [ctxCount, setCtxCount] = useState('8')
      const [discoverQuery, setDiscoverQuery] = useState('')
      const [discoverResults, setDiscoverResults] = useState(null)
      const [persona, setPersona] = useState('')
      const [promptsLoaded, setPromptsLoaded] = useState(false)
      const [editingDraft, setEditingDraft] = useState(false)

      const refresh = useCallback(async (forceDraft = false) => {
        try {
          const s = await jget('/status')
          setStatus(s.status || null)
          setCfg(s.config || null)
          if (!editingDraft || forceDraft) {
            setGroupsText((s.config?.groups || []).join(', '))
            setAliasesText((s.config?.mentionAliases || []).join(', '))
            setPollSec(String(Math.round((s.config?.pollIntervalMs || 5000) / 1000)))
            setCtxCount(String(s.config?.contextMessages ?? 8))
          }
          const l = await jget('/log')
          setLog(l.log || [])
          if (!promptsLoaded) {
            const pr = await jget('/prompts').catch(() => null)
            if (pr) {
              setPersona(pr.persona || '')
              setPromptsLoaded(true)
            }
          }
        } catch (e) {
          setMsg(String(e.message || e))
        }
      }, [editingDraft, promptsLoaded])

      useEffect(() => {
        refresh(true)
        const t = setInterval(() => refresh(false), 3500)
        return () => clearInterval(t)
      }, [refresh])

      const act = async (path, body, okText = '操作完成') => {
        setBusy(true)
        setMsg('')
        try {
          const r = await jpost(path, body)
          setMsg(okText)
          setEditingDraft(false)
          await refresh(true)
          return r
        } catch (e) {
          setMsg(String(e.message || e))
          return null
        } finally {
          setBusy(false)
        }
      }

      const runDiscover = async (autoWatch = false) => {
        setBusy(true)
        setMsg('正在检索账号内的抖音群聊…')
        try {
          const r = await jpost('/discover', {
            query: discoverQuery.trim(),
            groupOnly: true,
            maxScrolls: 10,
            autoWatch,
          })
          const res = r?.result || {}
          if (res.ok === false) {
            setMsg(res.error || '检索群聊失败')
          } else {
            const list = res.groups || []
            setDiscoverResults(list)
            setMsg(`已检索到 ${list.length} 个候选群聊（共扫描 ${res.total ?? list.length} 个会话）`)
          }
          setEditingDraft(false)
          await refresh(true)
        } catch (e) {
          setMsg(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      const toggleGroup = async (groupName) => {
        const current = Array.isArray(cfg?.groups) ? cfg.groups.slice() : []
        const exists = current.includes(groupName)
        const next = exists ? current.filter((g) => g !== groupName) : [...current, groupName]
        await act('/config', { groups: next }, exists ? `已取消监听「${groupName}」` : `已加入监听「${groupName}」`)
      }

      const saveGroupSettings = async () => {
        const groups = groupsText.split(/[,，\n]+/).map((s) => s.trim()).filter(Boolean)
        const mentionAliases = aliasesText.split(/[,，\n]+/).map((s) => s.trim()).filter(Boolean)
        const pollIntervalMs = Math.max(2000, (Number(pollSec) || 5) * 1000)
        const contextMessages = Math.max(0, Math.min(20, Number(ctxCount) || 8))
        await act('/config', {
          groups,
          mentionAliases: mentionAliases.length ? mentionAliases : ['DeepSeek'],
          pollIntervalMs,
          contextMessages,
        })
      }

      const savePersona = async () => {
        await act('/prompts', { persona })
      }

      const running = status?.running
      const last = status?.lastPollAt ? new Date(status.lastPollAt).toLocaleTimeString() : '尚未轮询'
      const sessions = status?.sessions || {}
      const sessionEntries = Object.entries(sessions)
      const activeGroups = Array.isArray(cfg?.groups) ? cfg.groups : []
      const shownDiscovered = discoverResults !== null ? discoverResults : (status?.discoveredGroups || [])
      const loginLabel = status?.loggedIn
        ? '已登录'
        : (status?.waitingLogin ? '等待扫码登录中…' : '未登录')

      return h('div', { 'data-dyg-page': '' },
        h('div', { 'data-dyg-note': '' },
          '连接抖音网页版群聊与 DeepSeek Harness 会话：扫码登录后可自动检索账号内群聊并一键勾选监听，基于 React Fiber 提取群消息与 @ 触发唤醒。'),

        h(Sec, { title: '运行状态' },
          h(Row, null,
            h('span', { 'data-dyg-pill': '' }, running ? '桥接运行中' : '桥接已停止'),
            h('span', { 'data-dyg-label': '' }, '登录态：'),
            h('span', {
              'data-dyg-val': '',
              'data-dyg-ok': status?.loggedIn ? '' : undefined,
              'data-dyg-warn': status?.loggedIn ? undefined : '',
            }, loginLabel),
            h('span', { 'data-dyg-label': '' }, '回复模式：'),
            h('span', { 'data-dyg-val': '' }, status?.mode || '—'),
            h('span', { 'data-dyg-label': '' }, '上次轮询：'),
            h('span', { 'data-dyg-val': '' }, last),
          ),
          h(Row, null,
            h('span', { 'data-dyg-label': '' }, '已注入：'),
            h('span', { 'data-dyg-val': '' }, String(status?.injected ?? 0)),
            h('span', { 'data-dyg-label': '' }, '已回复：'),
            h('span', { 'data-dyg-val': '' }, String(status?.sent ?? 0)),
            h('span', { 'data-dyg-label': '' }, '浏览器：'),
            h('span', {
              'data-dyg-val': '',
              'data-dyg-ok': status?.browserReady ? '' : undefined,
              'data-dyg-warn': status?.browserReady ? undefined : '',
            }, status?.browserReady ? '已连接' : '未启动'),
          ),
          status?.lastError
            ? h('div', { 'data-dyg-note': '', 'data-dyg-bad': '' }, '最近错误：' + status.lastError)
            : null,
          h(Row, null,
            h('button', { 'data-dyg-btn': '', disabled: busy, onClick: () => act('/login', {}, '已打开抖音登录窗口') }, '打开浏览器扫码登录'),
            h('button', { 'data-dyg-btn': '', disabled: busy || status?.discovering, onClick: () => runDiscover(false) },
              status?.discovering ? '正在检索群聊…' : '检索账号群聊'),
            h('button', { 'data-dyg-btn': '', disabled: busy, onClick: () => act('/poll') }, '立刻轮询一次'),
            running
              ? h('button', { 'data-dyg-btn': '', disabled: busy, onClick: () => act('/stop') }, '停止轮询')
              : h('button', { 'data-dyg-btn': '', disabled: busy, onClick: () => act('/start') }, '启动轮询'),
            h('button', { 'data-dyg-btn': '', disabled: busy, onClick: () => act('/selftest') }, '选择器自检'),
            h('button', { 'data-dyg-btn': '', disabled: busy, onClick: () => refresh(true) }, '刷新'),
          ),
          msg ? h('div', { 'data-dyg-note': '' }, msg) : null),

        h(Sec, { title: '账号群聊自动检索与勾选' },
          h(Row, null,
            h('input', {
              'data-dyg-input': '',
              style: { flex: '1', minWidth: '180px' },
              value: discoverQuery,
              placeholder: '输入群名关键词过滤（留空检索账号内全部群聊）',
              onChange: (e) => setDiscoverQuery(e.target.value),
            }),
            h('button', { 'data-dyg-btn': '', disabled: busy || status?.discovering, onClick: () => runDiscover(false) }, '开始检索'),
            h('button', { 'data-dyg-btn': '', disabled: busy || status?.discovering, onClick: () => runDiscover(true) }, '检索并全部监听'),
          ),
          h(Row, null,
            h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                checked: cfg?.autoDiscoverOnLogin !== false,
                onChange: (e) => act('/config', { autoDiscoverOnLogin: e.target.checked }),
              }),
              '扫码登录成功后自动检索账号里的群聊',
            ),
            h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                checked: Boolean(cfg?.autoWatchDiscovered),
                onChange: (e) => act('/config', { autoWatchDiscovered: e.target.checked }),
              }),
              '自动加入监听名单',
            ),
          ),
          shownDiscovered.length
            ? h('div', null,
                h('div', { 'data-dyg-note': '', style: { marginBottom: '6px' } },
                  `已检索到 ${shownDiscovered.length} 个群聊（点击即可勾选加入/移出监听名单）：`),
                h('div', { 'data-dyg-grid': '' },
                  shownDiscovered.map((item) => {
                    const selected = activeGroups.includes(item.name)
                    const tag = item.kind === 'group' ? '群聊' : (item.kind === 'dm' ? '私信' : '会话')
                    const countStr = item.memberCount ? ` · ${item.memberCount}人` : ''
                    const unreadStr = item.unread ? ' · 未读' : ''
                    return h('button', {
                      key: item.conversationId || item.name,
                      'data-dyg-chip': '',
                      'data-active': selected ? '1' : '0',
                      disabled: busy,
                      title: item.preview || item.name,
                      onClick: () => toggleGroup(item.name),
                    }, `${selected ? '✓ ' : '+ '}${item.name} (${tag}${countStr}${unreadStr})`)
                  }),
                ),
              )
            : h('div', { 'data-dyg-note': '' }, '尚未检索到群聊记录：请先点击「打开浏览器扫码登录」，登录完成后会自动检索（也可点上方「检索账号群聊」手动刷新）。')),

        h(Sec, { title: '群聊与 @ 触发配置' },
          h('div', { 'data-dyg-label': '' }, '当前监听的抖音群聊名称（逗号分隔，可由上方勾选或手动编辑）'),
          h('input', {
            'data-dyg-input': '',
            value: groupsText,
            placeholder: '例：摸鱼小分队, AI交流群',
            onChange: (e) => { setEditingDraft(true); setGroupsText(e.target.value) },
          }),
          h('div', { 'data-dyg-label': '' }, '@ 触发词 / 机器人昵称别名（逗号分隔）'),
          h('input', {
            'data-dyg-input': '',
            value: aliasesText,
            placeholder: '例：DeepSeek, DS, 机器人',
            onChange: (e) => { setEditingDraft(true); setAliasesText(e.target.value) },
          }),
          h(Row, null,
            h('span', { 'data-dyg-label': '' }, '轮询间隔(秒)：'),
            h('input', {
              'data-dyg-input': '', style: { width: '76px' },
              value: pollSec,
              onChange: (e) => { setEditingDraft(true); setPollSec(e.target.value) },
            }),
            h('span', { 'data-dyg-label': '' }, '附带上下文条数：'),
            h('input', {
              'data-dyg-input': '', style: { width: '76px' },
              value: ctxCount,
              onChange: (e) => { setEditingDraft(true); setCtxCount(e.target.value) },
            }),
            h('button', { 'data-dyg-btn': '', disabled: busy, onClick: saveGroupSettings }, '保存群聊配置'),
          )),

        h(Sec, { title: '触发与回复策略' },
          h(Row, null,
            h('span', { 'data-dyg-label': '' }, '触发方式：'),
            h('select', {
              'data-dyg-sel': '',
              value: cfg?.triggerMode || 'mention',
              onChange: (e) => act('/config', { triggerMode: e.target.value }),
            },
              h('option', { value: 'mention' }, 'mention — 仅群友 @ 触发词时唤醒会话'),
              h('option', { value: 'all' }, 'all — 群里所有新消息都注入会话'),
            ),
          ),
          h(Row, null,
            h('span', { 'data-dyg-label': '' }, '回复模式：'),
            h('select', {
              'data-dyg-sel': '',
              value: cfg?.mode || 'simulation',
              onChange: (e) => act('/config', { mode: e.target.value }),
            },
              h('option', { value: 'simulation' }, 'simulation — 由 AI 自行决定是否调用 douyin_group_send 回复'),
              h('option', { value: 'mirror' }, 'mirror — AI 的每次文本输出自动单行回发到群聊'),
              h('option', { value: 'off' }, 'off — 暂停自动监听，仅保留手动工具'),
            ),
          )),

        h(Sec, { title: '群聊人格设定（persona.md）' },
          h('textarea', {
            'data-dyg-ta': '',
            value: persona,
            onChange: (e) => setPersona(e.target.value),
          }),
          h(Row, null,
            h('button', { 'data-dyg-btn': '', disabled: busy, onClick: savePersona }, '保存人格设定'),
            h('span', { 'data-dyg-note': '' }, '新建或恢复的群聊 DSH 会话会自动装载此系统提示'),
          )),

        sessionEntries.length
          ? h(Sec, { title: '群聊 ⇄ DSH 会话映射' },
              sessionEntries.map(([g, sid]) => h(Row, { key: g },
                h('span', { 'data-dyg-pill': '' }, g),
                h('span', { 'data-dyg-val': '' }, sid),
              )))
          : null,

        h(Sec, { title: '运行日志' },
          h('div', { 'data-dyg-log': '' }, (log || []).join('\n') || '（暂无日志）')),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-douyin-group-bridge')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-douyin-group-bridge: css')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'douyin-group-bridge', order: 32, label: '抖音群聊' },
          () => h(Panel),
        ))
      },
    }
  },
})

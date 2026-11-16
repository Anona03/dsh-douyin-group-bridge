# dsh-douyin-group-bridge（抖音群聊桥接插件）

> 把 **抖音网页版群聊** 接入 **DeepSeek Harness (DSH)** 原生会话的插件：无需逆向私密协议或额外 Python/Playwright 环境，扫码登录后即可自动检索账号里的群聊，把群消息（含图片与上下文）注入 DSH 会话，并由 AI 自主决策或自动回发到群里。



---

## 工作原理

```text
  抖音网页版群聊（Edge / Chrome CDP）                     DeepSeek Harness (DSH)
 ┌──────────────────────────────────┐               ┌──────────────────────────────┐
 │ 1. 扫码登录并自动检索账号群聊    │── 读群消息 ──▶│ 3. 命中触发词后注入 DSH 会话 │
 │ 2. React Fiber 提取发送者/正文/图│               │    (1 群聊 ⇄ 1 独立会话)      │
 │                                  │◀─ 单行回发 ───│ 4. simulation 工具回复 /     │
 │    校验气泡上屏，不重发历史基线  │               │    mirror 模式自动回发       │
 └──────────────────────────────────┘               └──────────────────────────────┘
                                                               ▲
                                               完整对话与推理全部沉淀在 DSH 会话日志
```

- **1 个群聊 ⇄ 1 个 DSH 会话**：每个被监听的抖音群聊会自动绑定一个独立的 DSH 会话（`douyin-group-<群名>-<id>`），所有聊过的内容和工具记录全部保存在 DSH 原生会话日志（`$DSH_HOME/sessions/`）里。
- **零外部 Python/Playwright 依赖**：直接通过 Node 22+ 原生 WebSocket + CDP 驱动本机已有的 Microsoft Edge 或 Google Chrome，默认使用独立调试端口 `47882` 和独立浏览器配置目录，不会与你日常浏览或其它 DSH 抖音插件冲突。
- **启动基线去重**：每次首次连接某个群聊时，插件会把当前屏幕内已有的历史消息标为「基线」，**不会**把以前的老消息一股脑重新发给 AI。

---

## 环境要求

- **DeepSeek Harness**：`>= 0.1.7-rc.1`（桌面版或 CLI 均可）
- **Node.js**：`>= 22`（桌面版内置运行环境已满足）
- **浏览器**：本机已安装 Microsoft Edge 或 Google Chrome

---

## 快速上手（5 分钟跑通）

### 第 1 步：安装插件

任选下面一种方式安装：

- **方式 A · DSH 桌面版（推荐）**
  1. 先启动 DeepSeek Harness 桌面端。
  2. 克隆本仓库并运行一键安装脚本：
     ```bash
     git clone https://github.com/Anona03/dsh-douyin-group-bridge.git
     cd dsh-douyin-group-bridge
     node tools/install.mjs
     ```
     > 如果你之后修改了插件代码需要重装刷新，运行 `node tools/install.mjs --reinstall`。
  3. 重启一次 DSH 桌面端（或刷新前端），即可在 **设置 → 抖音群聊** 看到控制面板。

- **方式 B · DSH CLI Profile**
  ```bash
  # 直接从 GitHub 安装
  dsh plugin --profile <你的profile名> add github:Anona03/dsh-douyin-group-bridge

  # 或从本地克隆目录链接安装
  dsh plugin --profile <你的profile名> add link:<本仓库绝对路径>
  ```

---

### 第 2 步：扫码登录抖音（自动检索群聊）

1. 打开 DSH 的 **设置 → 抖音群聊**。
2. 点击 **「打开浏览器扫码登录」**，插件会自动弹出并置顶一个独立的 Edge/Chrome 窗口（打开 `www.douyin.com`）。
3. 使用你的抖音 App 扫码登录；**登录完成后不要关闭该浏览器窗口**（登录态和实时监听依赖它）。
4. 登录成功瞬间，插件会自动滚动扫描你账号消息列表中的群聊，并在设置页 **「账号群聊自动检索与勾选」** 区域列出来。

> **提示**：你也可以随时在输入框填入关键词，点 **「开始检索」** 过滤特定群聊，或点击 **「检索并全部监听」**。

---

### 第 3 步：勾选群聊与填写 `@` 触发词

1. **勾选要监听的群聊**：在检索出的群聊卡片中直接点击需要接入的群（卡片变成绿色 `✓` 即已加入监听）；也可以在下方输入框手动填写多个群名（英文或中文逗号分隔）。
2. **填写 `@ 触发词`（非常关键！）**：
   - 当 **触发方式** 为默认的 `mention` 时，**只有群友 `@` 了这里的关键词，才会唤醒 DSH 回复**。
   - 请务必把你登录抖音号的**账号昵称**写进 `@ 触发词`！例如你的抖音昵称叫 `小鲸鱼`，群友在群里 `@小鲸鱼 帮我看看这个`，就把 `小鲸鱼` 填进 `@ 触发词`（多个别名用逗号分隔，如 `小鲸鱼, DeepSeek, 机器人`）。
3. 点击 **「保存群聊配置」**。

---

### 第 4 步：选择触发方式与回复模式

在设置页的 **「触发与回复策略」** 中按你的需求选择：

#### 1. 触发方式（`triggerMode`）

| 模式 | 说明 | 适用场景 |
| --- | --- | --- |
| `mention`（默认） | 仅当群友 `@` 触发词时才唤醒 DSH 会话，并自动附上最近 `contextMessages`（默认 8 条）群聊上下文 | **日常群聊推荐**，省 Token、不打扰群友 |
| `all` | 群里每一条非自己的新消息都会注入 DSH 会话 | 需要 AI 全程旁听群聊、随时接话（建议配合 `simulation` 模式） |

#### 2. 回复模式（`mode`）

| 模式 | 说明 | 注意事项 |
| --- | --- | --- |
| `simulation`（默认） | 消息注入会话后，由 AI **自己决定要不要回、回什么**，需要发言时主动调用 `douyin_group_send` | 最灵活，AI 可结合工具查资料/发图后再回 |
| `mirror` | 只要 AI 在该群绑定的 DSH 会话里输出文本，插件就自动单行回发到抖音群聊 | **全自动托管首选**，省去 AI 调发送工具的步骤 |
| `off` | 暂停后台轮询与自动注入，仅保留 `douyin_group_*` 工具供手动调用 | 临时停用自动回复时使用 |

---

## 自定义 AI 人格与群聊规矩

插件会在新建/恢复群聊对应的 DSH 会话时，自动注入以下两段系统提示（只影响群聊桥接会话，不会污染你日常使用的其它 DSH 会话）：

1. **群聊人格（`persona.md`）**：可以在 **设置 → 抖音群聊 → 群聊人格设定** 里直接编辑并保存；或直接编辑文件 `$DSH_HOME/douyin-group-bridge/prompts/persona.md`（内置默认模板见 [prompts/persona.md](prompts/persona.md)）。
2. **值班章程（`duty.md`）**：告诉 AI 在 `simulation` / `mirror` 模式下分别怎么发消息、保持短句、不刷屏，可在 `$DSH_HOME/douyin-group-bridge/prompts/duty.md` 中自定义（内置默认模板见 [prompts/duty.md](prompts/duty.md)）。

---

## 全部配置项说明

插件运行时配置保存在 `$DSH_HOME/douyin-group-bridge/config.json`（升级或重装插件不会丢失）：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 插件总开关 |
| `autoDiscoverOnLogin` | `true` | 扫码登录成功后自动检索账号内群聊 |
| `autoWatchDiscovered` | `false` | 检索到群聊后是否自动加入监听名单 |
| `groups` | `[]` | 要监听的抖音群聊名称列表（留空时不会自动监听任何群） |
| `mentionAliases` | `["DeepSeek", "DS", "机器人"]` | `mention` 模式下识别 `@` 召唤的昵称别名列表（区分大小写不敏感） |
| `triggerMode` | `"mention"` | `mention`（仅 `@` 触发）或 `all`（全部新消息触发） |
| `mode` | `"simulation"` | `simulation` / `mirror` / `off` |
| `pollIntervalMs` | `5000` | 轮询间隔（毫秒，最小 `2000`） |
| `contextMessages` | `8` | 触发时附带的最近群聊上下文消息条数（`0`–`20`） |
| `maxInjectChars` | `4000` | 单条注入 DSH 会话的文本长度上限 |
| `browserPort` | `47882` | 独立浏览器 CDP 调试端口 |
| `browser` | `""` | 自定义 Edge/Chrome 可执行文件路径（留空则自动探测） |
| `provider` / `model` | `""` | 显式指定群聊会话使用的模型（留空则自动继承 DSH 默认模型） |

---

## AI 可调用工具列表（LLM 侧）

在 DSH 任意会话中，AI 均可通过以下工具操作或排查抖音群聊：

| 工具名 | 用途 |
| --- | --- |
| `douyin_group_login` | 打开并置顶抖音网页版登录窗口，登录后自动检索群聊 |
| `douyin_group_whoami` | 查看当前抖音登录状态、Cookie 与浏览器连接信息 |
| `douyin_group_discover` | 滚动检索账号内全部群聊（支持 `query` 关键词过滤、`autoWatch` 自动加入监听） |
| `douyin_group_list` | 列出抖音消息抽屉中的会话列表（标注 `group` / `dm` 与成员数） |
| `douyin_group_read` | 基于 React Fiber 读取指定群聊的最新可见消息（`group` 留空 = 当前会话绑定的群） |
| `douyin_group_send` | 发送单行纯文本到群聊（支持 `atSender` 开头 `@` 群友，发送后自动回读气泡验证） |
| `douyin_group_send_image` | 向群聊发送本地图片或 base64 图片（支持 `.png` / `.jpg` / `.gif`，不支持 `.webp`） |
| `douyin_group_history` | 从 DSH 原始会话日志（`.jsonl.zstd`）读取完整群聊历史，不受网页端虚拟列表条数限制 |
| `douyin_group_duty` | 读取当前群聊人格与值班章程 |
| `douyin_group_status` | 查看桥接运行状态、群聊会话映射与最近日志 |
| `douyin_group_selftest` | 对抖音网页版消息抽屉与核心选择器执行自检 |

---

## 常见问题排查（FAQ）

1. **群友 `@` 了但 DSH 没回复？**
   - 检查 `@ 触发词` 是否包含了群友实际 `@` 的抖音账号昵称（例如群友 `@你的昵称`，但配置里只写了 `DeepSeek`）。
   - 启动或切换监听群时，屏幕上原本已经存在的消息会被记为**基线**（防止刷屏重发），请让群友**新发一条**包含 `@触发词` 的消息测试。
   - 检查设置页的 **运行状态** 与 **运行日志**：确认 `已注入` 是否有增长，以及回复模式是否设为了 `off`。
2. **提示「抖音页面弹出人机验证」或「无法展开抖音消息抽屉」？**
   - 抖音风控偶尔会在网页端弹出滑块或安全验证。请点击设置页的 **「打开浏览器扫码登录」** 把浏览器窗口拉到最前，手动完成一次验证即可自动恢复轮询。
3. **我不小心把弹出的浏览器窗口关掉了，怎么恢复？**
   - 为避免打扰用户，手动关闭浏览器窗口后插件会**暂停监听，不会每隔几秒自动弹出窗口**。需要恢复时，在 **设置 → 抖音群聊** 点击 **「打开浏览器扫码登录」** 或 **「启动轮询」** 即可。
4. **发长段带换行的回复时提示错误或被截断？**
   - 抖音网页端 `contenteditable` 输入框插入换行符容易误触发提前发送或报「不能发送空白消息」。插件的 `douyin_group_send` 与 `mirror` 回发都会自动做**单行化处理**；建议在 `persona.md` 中引导 AI 尽量用简短口语回复。
5. **发送图片失败？**
   - 抖音网页端上传控件不支持 `.webp` 格式，请使用 `.png`、`.jpg` 或 `.gif` 图片。

---

## 开发者与本地调试工具

```bash
# 1. 一键运行完整性、语法、模板反引号、Cordis Proxy 加载测试与全部单元测试
node selfcheck.mjs

# 2. 单独运行单元测试
node --test test/bridge.test.mjs

# 3. 实机探测抖音账号会话与指定群聊 React Fiber 消息结构
node tools/probe-group.mjs "你的群聊名称" --inspect

# 4. 通过 RPC 查询或调试运行中的桌面版 DSH
node tools/dsh-rpc.mjs GET /dsh-douyin-group-bridge/status
node tools/dsh-rpc.mjs GET /dsh-douyin-group-bridge/log
node tools/dsh-rpc.mjs POST /dsh-douyin-group-bridge/discover '{"groupOnly":true}'
```

---

## 目录结构与数据落盘

```text
├── package.json              # 插件清单与 DSH client/bundle 声明
├── cordis.patch.yml          # 默认插件挂载配置
├── index.js                  # DSH 宿主端入口：工具注册、桥接调度与 HTTP 接口
├── client.js                 # DSH 设置页前端面板（设置 → 抖音群聊）
├── prompts/
│   ├── duty.md               # 默认值班章程
│   └── persona.md            # 默认群聊人格
├── lib/
│   ├── browser.mjs           # 零依赖 Node CDP 浏览器控制
│   ├── selectors.mjs         # 多级降级选择器与 canary 自检
│   ├── media.mjs             # 媒体类型识别与 data URL 解码
│   ├── douyin-group.mjs      # 群聊检索、切换、React Fiber 消息解析、单行/图片发送
│   ├── bridge.mjs            # 群聊 ⇄ DSH 会话桥接核心与去重逻辑
│   ├── session-history.mjs   # DSH 多帧 zstd 会话日志读取
│   ├── state.mjs             # $DSH_HOME/douyin-group-bridge 状态持久化
│   └── hostdeps.mjs          # 宿主树依赖解析与降级兜底
└── tools/                    # 安装、自检、RPC 调试与群聊探测脚本
```

所有运行状态与登录态均保存在 `$DSH_HOME/douyin-group-bridge/`（Windows 默认为 `%USERPROFILE%\.dsh\douyin-group-bridge\`），包含 `config.json`、`sessions.json`、`discovered-groups.json`、`profile/`、`prompts/`、`bridge.log` 与 `diag.json`。

---

## 免责声明与隐私提示

- 本项目仅供个人学习浏览器自动化（CDP / React Fiber）与 DeepSeek Harness 插件开发使用。
- 桥接开启后，被监听群聊中的消息文本与图片会进入你在 DSH 中配置的大模型服务上下文，请仅在受信任的群聊中使用，并遵守相关平台社区规范与法律法规。
- 切勿将 `$DSH_HOME/douyin-group-bridge/profile/` 或 `.credentials.yaml` 上传至公开仓库。

## 许可

[MIT License](LICENSE)

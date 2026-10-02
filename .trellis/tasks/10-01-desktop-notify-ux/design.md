# 技术设计

## 1. 总体结构（不变的部分）

```
DSH 宿主进程 (profile=desktop)
├─ lib/host.js      宿主半边：订阅事件 → 判定 → spawn PowerShell 投递
│                   + 注册两条 HTTP 路由（焦点上报 / 点击唤起）
├─ lib/client.js    浏览器半边：上报「我在看哪个对话」+ 长轮询取「该打开哪个对话」
└─ 投递脚本        toast.ps1（WinRT 原生横幅）/ alert.ps1（自绘 Topmost 卡片）
   + activator     dsh-notify-activator.exe（Toast 点击的 COM 激活器，AOT 之前的 .NET Framework winexe）
```

数据流：

```
事件源 ──▶ host.js send() ──┬─▶ toast.ps1  ──▶ Windows 原生横幅（默认通道）
                            └─▶ alert.ps1  ──▶ 置顶卡片（兜底通道：前台是全屏时）
点击 ──▶ activator/card 写 %USERPROFILE%\.dsh\dsh-desktop-notify.activate
     ──▶ host 轮询取走 ──▶ 客户端长轮询 /dsh-desktop-notify/activate
     ──▶ client.js: uiWorkspace.openSession(id) + 滚到底部
```

## 2. 触发源改造（R4 的核心）

### 2.1 问题

`approval/request` 与 `user-questions/request` 是 waterfall 事件，宿主在 DSH 0.2.0-rc.2 上实测
到不了本插件的监听器（证据见 research）。而 `turn/end` 的 `blocked` 分支又被显式跳过
（原设计认为「审批/提问通道已经报过」），于是「等你回答 / 等你授权」这两类最需要提醒的事件全哑。

### 2.2 方案：改用会话事件流做主触发源

`session/event` 是本插件**已被证实可达**的通道（完成提醒一直正常）。在它之上直接识别等待类事件：

| 会话事件 | 判定 | 提醒类别 | 文案来源 |
|---|---|---|---|
| `approval/asked` | 一定 | `approval` | `toolName` + `reason` |
| `tool/call` 且 `name === "ask_user_question"` | 一定 | `question` | 解析 `arguments` JSON 取 `questions[0].header/question/options` |
| `turn/end` 且 `reason.kind === "blocked"` | 兜底 | `question` | 「回合在等你回话」 |
| `turn/end` completed/error/其他 | 保持现状 | `completion` / `failure` / `aborted` | 耗时、原因 |

要点：

- `blocked` 不再无条件跳过：先看这个会话最近是否已经因为 `approval`/`question` 提醒过（同一去重窗口），
  没有才补一条「需要你回答」。
- waterfall 订阅（`approval/request` / `user-questions/request`）**保留**，作为冗余 + 诊断；
  两个来源用现有的 `(会话, 类别)` 去重合并，不会出现两条。等待类去重窗口从 8s 提到 15s。
- `agent/created` → 在 agent 的 scoped ctx 上挂 waterfall 监听这段逻辑保留（若将来 waterfall 恢复即可生效），
  并补一条 `logOnce` 说明它是否真的被调用过（排查用）。

### 2.3 门控（R3）

保持「按对话级焦点判断」，但把判定集中到一处并补边界：

- `gateOnFocus=true` 时：窗口未聚焦 / 焦点心跳过期（> `backgroundGraceMs`）/ 焦点在别的对话 → 提醒；
  正在看该对话 → 静默。
- 从未上报视为「没在看」（页面没开，正是最需要提醒的时候）。
- 等待类事件（approval/question）同样走门控：用户正盯着那个对话时，UI 里已经能看到授权卡/问卷，
  再弹一次是打扰。

## 3. 投递通道改造（R1 / R2）

### 3.1 默认值

```yaml
channels:
  toast: true                       # 原生横幅：默认通道
  alert: true                       # 自绘卡片：兜底通道
  alertOnlyWhenFullscreen: true     # 只有前台是全屏时才补卡片
```

### 3.2 投递策略

```
send(cls, …)
 ├─ classes[cls] 开关
 ├─ 子代理过滤 / 焦点门控（抑制后等待类挂复核补发）/ 去重 / 最小间隔
 └─ deliver(cls, sessionId, detail)
     ├─ 双通道全开 + alertOnlyWhenFullscreen（默认）→ 宿主先问前台，裁决后只发一个（A2）：
     │    dsh-notify-probe.exe（预编译 C#，~40-60ms）退出码 = 位掩码
     │    ├─ bit1(2)：前台是 DSH 且客户端心跳过期/没开 → 静默（用户就在应用里）
     │    ├─ bit0(1)：前台全屏 → 只发 alert.ps1（横幅会被系统压掉）
     │    └─ 其余    → 只发 toast.ps1；toast 彻底失败（exit ∉ {0,4,5}）→ 补必显卡片
     ├─ 单通道 → 直接发对应通道
     └─ alertOnlyWhenFullscreen=false（用户显式选择）→ 两个都发
     activationType="foreground" launch=<sessionId>（点击交回宿主）
```

- 前台裁决放宿主侧的预编译探针里（学 dsh-donevoice 的 presence()；exe 模式对照
  `process.execPath` basename），一次 spawn 只要 ~40-60ms——PowerShell 探针要 ~700ms，
  是 2026-10-02 用户报「弹窗至少慢一秒」的主因之一（另一个是 settle 800ms，已减半）。
- 判"全屏"的标准：窗口盖满显示器（2px 容差）且非最大化（IsZoomed）；自动隐藏任务栏
  时最大化窗口恰好盖满全屏，靠最大化状态区分。
- `stickyBlocking` 保留：等待类与失败/中止用常驻横幅（`reminder`），完成类短提示。
- 提示音：toast 的音频保持 `silent="true"`，声音由脚本用 `SystemSounds` 短促播放。
- 卡片停留秒数默认：授权/提问 30s（原 60s 太黏），完成 10s，失败/中止 25s。

### 3.3 取舍

- 为什么不自绘卡片当主通道：用户明确要「Windows 原生的提示横幅」；原生横幅还带通知中心留痕。
- 为什么不只用原生横幅：独占全屏/专注助手会静默压掉且不补弹，R2 会失效。
- 卡片只在全屏补位，代价是「全屏时同时收到 toast（如果没被压）」——接受，宁可多一次也不漏。

## 4. 点击跳转（R5）

### 4.1 现有链路

Toast 点击 → COM 激活器写 `…activate` → 宿主 1s 轮询 → `publishActivation` → 客户端长轮询
→ `client.js` 调 `uiWorkspace.openSession(sessionId)`。

卡片点击 → 直接写同一个交接文件 + 唤前窗口 → 同上。

### 4.2 已知缺陷与修复

| 问题 | 修复 |
|---|---|
| 客户端 `exports.inject = []`，`ctx.get?.("uiWorkspace")` 可能取不到服务，失败是静默的 | 客户端插件显式声明 `inject = ["sessions", "uiWorkspace"]`，在 `ctx.inject` 回调里拿服务；同时保留 `ctx.get` 兜底，并在两条路径都失败时 `console.warn` + 上报宿主日志 |
| 切完会话视图停在历史位置 | 切会话后 best-effort「回到底部」：优先点聊天视图自带的 `aria-label="回到底部"/"Back to bottom"` 按钮（DSH 自带「回到底部」按钮，源码 `dsh-client-ui-chat/lib/client.js` 有 `chat.toBottom`），退化为把最大可滚动容器的 `scrollTop` 设到 `scrollHeight`；渲染是异步的，因此重试约 1.5s |
| 点击后只唤前窗口 | 保留唤前（`SetForegroundWindow` + 短暂 Topmost 1.2s），但要求「先切会话再唤前」，让用户看到的是目标对话 |
| 交接文件可能残留旧 id | 保留 `ACTIVATION_TTL_MS`；客户端取到后会 `openSession`，宿主日志记录 `activation published` 与客户端领取，便于排查 |

### 4.3 兼容性

- `uiWorkspace.openSession` 在 DSH 0.2.0-rc.2 存在；若将来改名，降级为「只唤前窗口 + 记日志」，
  不阻塞提醒本身。

## 5. 部署方式（本次要落地的工程约定）

live 目录与工作区是两份，容易改错。方案：

- 工作区仓库 = 唯一源；**新增 `tools/deploy.ps1`**：把 `lib/`、`cordis.patch.yml`、`README*.md`
  同步到 `%USERPROFILE%\.dsh\my-dsh\dsh-desktop-notify`，可选 `-Restart` 重启 Harness。
- 改完 host.js/client.js 必须重启 Harness 才生效（热重载只重跑 `apply()`，ESM 缓存不失效）。
- README 里写清三份副本的关系与这条命令。

## 6. 回滚

- 代码级：`git revert` / `git checkout -- lib`；live 目录重新部署即可。
- 配置级：`cordis.patch.yml` 里把 `channels.toast` 关掉就回到「只用自绘卡片」的旧行为；
  `classes.*` 可单独关某一类。
- 行为级：`enabled: false` 一键停用。

## 7. 测试与验证策略

- **离线 harness**（`.tmp-asar/exp/harness.mjs` 思路，落地为 `tools/verify.mjs`）：
  用 `@deepseek-ai/cordis` + `@deepseek-ai/dsh-scope` 搭最小宿主，加载真实 `lib/host.js`，
  用桩 `subprocess` 记录它到底 spawn 了哪些脚本、参数是什么；覆盖：
  焦点门控、去重、子代理过滤、`approval/asked`、`tool/call ask_user_question`、`turn/end blocked`、
  `turn/end completed`、全屏兜底分支。
- **脚本级**：`toast.ps1` / `alert.ps1` 的真实投递各自手动跑一次（原生横幅是否出现、卡片是否只在全屏出现）。
  toast 还要查 **通知中心历史**（见 §8-2）——脚本退出 0 不等于横幅真的显示了。
- **端到端**：重启 Harness → 触发一次 `ask_user_question`（切到别的会话）→ 看横幅 → 点击 → 核对
  是否切到该对话且停在最后一轮；日志三项（`dsh-desktop-notify.log`、`.activate.log`、宿主路由 204）都要对。

## 8. 外部同类项目与作者资料的输入（2026-10-02）

用户提供了两个同类项目与第二位作者（dsh-task-ask-notify）的内部调研资料，逐条消化后对本设计的影响：

### 8.1 被验证的设计决定（不需要改）

| 本设计 | 外部证据 |
|---|---|
| R5「回到底部按钮优先」的滚底方案 | dsh-task-reminder 用完全相同的做法：轮询内置"回到底部"按钮并点击，按钮不在就视为已在底部 |
| R4 改走 session/event，不依赖 waterfall | dsh-task-reminder 也不用 waterfall，改用 `uiSession.sessionStatus` 快照轮询检测"等待用户"；两个独立实现都绕开了同一通道，进一步佐证 waterfall 不可靠 |
| R2 用自绘卡片兜底全屏 | dsh-task-reminder README 独立确认：全屏时 Windows 压掉 toast（含优先级通知）、只进通知中心、退出全屏不补播，插件无法绕过 |
| toast 音频 silent + 自播短促提示音 | 两家做法一致 |
| `-File` 调脚本 + UTF-8 临时文件传中文 | deadbushxw 实测：detached 子进程会让 toast 被 Windows 静默丢弃但仍返回成功；含 `[DllImport]` 的字符串走 `-Command` 会被剥引号。本插件 host.js 用 subprocess 服务 + `-File` + 临时文件，两个坑都不踩（对照检查过 `lib/host.js:329-354`） |

### 8.2 新增的验证要求

- **AUMID 投递自证**：deadbushxw 实测 AUMID 没有对应注册时 `Show()` 会"成功"但不显示。本插件
  `toast.ps1` 写的是 `HKCU:\Software\Classes\AppUserModelId\<AUMID>` 注册表键（unpackaged 应用在
  Win10 1809+/Win11 的受支持机制，不需要开始菜单快捷方式），但 live 配置至今 `toast=false`，
  这条通道近期没被真实走过。验收 A1 必须包含：手动跑 `toast.ps1` → 横幅出现 **且**
  `[Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('<AUMID>')` 里有该条。
- **PID 陷阱（负面防线）**：DSH 窗口属于 Electron 主进程，插件跑在宿主子进程——
  按前台 PID == `process.pid` 判焦点永远为假。现有代码没有这种比较（`alert.ps1` 的
  `Raise-DshWindow` 按进程名找窗口，全屏判断按窗口矩形），保持下去；写进 spec 防回归。

### 8.3 明确不采纳的

- **S1 焦点抑制（前台是 DSH 就不弹，按 exe 路径比较）**：deadbushxw 方案 A 的核心。本插件的 R3
  门控是 S3（客户端按对话上报），粒度更细且已建成；叠加 S1 会让"正在看别的对话"的提醒也被压掉，
  语义反而变粗。若将来客户端半边失效导致过度提醒，S1 是现成的降级手段（exe 路径比较 +
  退出码 20 + `MainModule` 抛错时按未聚焦处理），届时再上。
- **按回合号去重**（dsh-task-reminder 的三通道 edge 表）：本插件是事件驱动、单通道主源，
  `(sessionId, class)` + 时间窗已够用；回合号方案是为"三通道并发"设计的，照搬是过度工程。
- **UI Automation 查焦点**：deadbushxw 实测三次读数两次错（csrss/explorer），且程序集加载并不便宜。
  本插件本来也不用，探针脚本（`ps1.zip`，在 `<Downloads>\ps1-extracted\`）留档备查。

### 8.4 成本预算（来自实测数据）

每次提醒双通道并存时：toast 冷启动 ~0.25s + alert 冷启动 ~0.25s（含 P/Invoke 编译 0.3-0.4s 时上限 ~0.7s）。
alert 在非全屏时编译完就退出，这笔钱只花在"需要兜底"的时候——可接受，不在 toast 路径上做任何
user32 检查（保持 `toast.ps1` 零 Add-Type）。

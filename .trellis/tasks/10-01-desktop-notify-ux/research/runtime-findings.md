# 运行环境与契约调研（2026-10-01）

本文件记录本次任务的实测结论，供实现与后续会话直接引用。结论都带证据来源，不是推测。

## 1. 三份代码副本与真实生效路径

| 路径 | 角色 | 说明 |
|---|---|---|
| `<工作区仓库>` | 本次工作区 / git 仓库 | remote = `github.com/VoodooB0Ys/dsh-desktop-notify`，HEAD `5023a7c` |
| `%USERPROFILE%\.dsh\my-dsh\dsh-desktop-notify` | **实际被 profile 加载的副本** | profile `desktop` 的 `node_modules/dsh-desktop-notify` 是指向它的 **junction** |
| `%USERPROFILE%\.dsh\plugins\dsh-desktop-notify` | plugin-manager 装的克隆 | 与工作区同 HEAD，未参与运行 |

- 运行中的宿主进程：`D:\DSH\DeepSeek Harness.exe --expose-internals ...dsh-desktop-host/lib/index.js ... %USERPROFILE%\.dsh\profiles\desktop ...`（单进程，profile = `desktop`）。
- profile 依赖：`"dsh-desktop-notify": "link:%USERPROFILE%/.dsh/my-dsh/dsh-desktop-notify"`。
- **结论：改工作区不会生效，必须同步到 my-dsh 那一份。**

## 2. DSH 版本与契约

- 桌面版 `0.2.0-rc.2`（`app.asar/package.json`，`dshBuildCommit=04f392c9ddd144fa426da2045178797da6db6c11`）。
  插件 `package.json` 里写的 `engines.dsh: ^0.1.7-rc.2` 已过期。
- DSH 实现代码都在 `D:\DSH\resources\app.asar`（121MB 归档，普通工具读不到内部；本次用自写的 asar 读取器解包到 `.tmp-asar/` 查阅）。
- 客户端服务（`cordis_inspect_query` client/Service）：`uiWorkspace.openSession(target)` 存在，
  `SessionTarget = SessionId | SubagentAddress`；另有 `layout`、`sessions`、`slots`、`theme`、`timer`、`workspaces`、`locale`。

## 3. 「等待用户」类事件选型（本次关键结论）

`session/event` 的 `SessionEventMap` 里**本来就有审批事件**（源码：`@deepseek-ai/dsh-api-session-controller/lib/typert.host.js`）：

```
'approval/asked':   { id: ApprovalRequestId; toolName: string; callId?: ToolCallId; reason?: string }
'approval/decided': { id: ApprovalRequestId; outcome: ApprovalOutcome }
'tool/call':        { turn, step, callId, name, arguments }
'turn/end':         { turn, reason }        // reason.kind = completed | blocked | aborted | error | max-tokens | interrupted | forked
```

结构化提问（`ask_user_question` 工具 / 计划审阅）在会话流里表现为 `tool/call`，`name === "ask_user_question"`，
`arguments` 是 JSON 字符串（含 `questions[].header / question / options`）。

**结论：不需要依赖 `user-questions/request` / `approval/request` 这两个 waterfall 事件，`session/event`
就能同时覆盖「等你授权」和「等你回答」，而且这条通道在本机是被证实可达的。**

## 4. 为什么现在的 waterfall 订阅收不到（现状与已排除项）

> **2026-10-02 悬案已破**：dsh-donevoice 的 ARCHITECTURE.md 点破了根因——官方转发器
> **先注册、拿到答案后不调 next()**，普通注册的监听器永远排不到。解法是注册时带
> `{ prepend: true }`（cordis 4.0.4 支持：`ctx.on(name, listener, { prepend: true })`）。
> 本插件已给全部 4 处 waterfall 注册加 prepend，冗余通道从死代码变成真的；
> session/event 仍是主通道（负载更丰富：ask_user_question 的题干/选项只有它有）。
> 下面的排查过程保留作记录。

实测证据：

- `~/.dsh/dsh-desktop-notify.log` 显示：最近一次 `question event reached ... registration`
  是 `2026-09-26T14:00:56Z`；此后（含 2026-10-01 全部使用）**一次 approval/question 事件都没到过**。
- 2026-10-01 21:59 现场做过对照实验：在当前会话里调用 `ask_user_question`（用户确实收到了问卷），
  插件日志**没有**新增任何一行（连 `skip question: user is looking at this conversation` 都没有）。
  → 说明监听器根本没有被调用，不是被门控挡掉。

已排除的原因（都做了实验）：

- **不是插件代码写错**：用 `@deepseek-ai/cordis@4.0.4` + `@deepseek-ai/dsh-scope` 搭最小宿主，
  离线加载真实的 `lib/host.js`，`ctx.waterfall(scopeTarget(agent, agent), 'user-questions/request', ...)`
  **能打进来**并正常投递（`.tmp-asar/exp/harness.mjs`）。
- **不是 scope 过滤规则**：`scopeTarget` 的 filter 对「未打作用域标签的监听器」直接放行
  （`dsh-scope/lib/index.js`：`if (tag === void 0) return true`），且 `EventsService` 是每个 Context
  root 一个实例、被所有子上下文原型继承 —— 同 root 内 `_hooks` 是共享的。
- 官方 `@deepseek-ai/dsh-api-remotes` 用**同样的根层 `ctx.on`** 订阅 `user-questions/request` 并能把问题
  转发给客户端 UI（问题确实能显示、能被回答），所以「根层订阅必失败」的说法不成立。

未定论的部分：水落石出的最后一步需要在宿主进程内打诊断（订阅 `internal/dispatch` 看这些事件是否
出现在同一条总线上），而**改 host.js 需要重启宿主**（见第 5 条），因此本次实现改为不依赖该通道。
诊断日志会保留在插件里（`debug` 开关下），下次重启后即可确认。

## 5. 热重载的真实边界（重要）

- `plugin_manager set_plugin include:desktop-notify enabled:false/true` 会让宿主**重新执行 `apply()`**
  （日志出现新的 `plugin loaded`），路由也会重新注册 —— 实测 `POST /dsh-desktop-notify/focus` 返回 204。
- **但 Node 的 ESM 模块缓存不会失效**：重新 `apply` 用的还是旧模块，改了 `lib/host.js` 也不会生效。
  实测：写入带 `diag:` 前缀的诊断代码并 toggle 后，日志里没有任何 `diag:` 行。
- **结论：host.js / client.js 的代码改动必须重启 Harness 才能验证**；toggle 只能用来验证「用配置驱动的行为」。
- 另外：toggle 会往 `~/.dsh/profiles/desktop/cordis.patch.yml` 追加 `- id: desktop-notify / disabled: false`，
  用完要手动删掉（本次已还原，hash 回到 `19E38512…`）。

## 6. 观察点（排障用）

- 插件判定日志：`%USERPROFILE%\.dsh\dsh-desktop-notify.log`
- 点击/窗口唤前日志：`%USERPROFILE%\.dsh\dsh-desktop-notify.activate.log`
- 宿主 HTTP 端口：GUI 在 `127.0.0.1:19387`，插件路由同源（`/dsh-desktop-notify/focus`、`/activate`）。
- 会话原始事件流用 zstd 压缩存在 `~/.dsh/sessions/<编码后的 cwd>/<sessionId>/session.v4.jsonl.zstd`
  （Node ≥22.15 有 `zlib.zstdDecompressSync`）。

## 7. Windows 提示横幅的行为边界

- 独占全屏（游戏/部分播放器）前台时，系统会**压掉** toast 横幅，且**不会补弹**，只进通知中心。
- 「专注助手 / 勿扰」的全屏自动规则同样会压。`scenario="reminder"` / `"alarm"` / `"urgent"` 属于
  「提醒类」，在多数专注助手档位下可以穿透，但对**独占全屏**仍不保证。
- 唯一在独占全屏下仍能显示的，是**我们自己的 Topmost 窗口**（现有 `alert.ps1` 就是为此写的）。
- 因此策略定为：原生横幅为主 + 「检测到前台是全屏」时补一张置顶卡片兜底（用户已确认此方案）。

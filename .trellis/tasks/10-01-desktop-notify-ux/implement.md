# 执行计划

## 0. 恢复入口（下次开工先读这一段）

- **状态**：2026-10-01 晚，PRD / 设计 / 本计划已写完并评审；用户决定**当天不动代码**，留到明天。
  任务仍是 `planning` 状态，**还没有 `task.py start`**。
- **开工头三件事**：
  1. `python ./.trellis/scripts/task.py current --source` —— 确认当前任务还是 `10-01-desktop-notify-ux`。
  2. 读 `research/runtime-findings.md`（三份副本地图、必须重启、为什么改用会话事件流），
     再读 `prd.md` 的验收标准 A1–A9。
  3. 向用户确认「现在开始实现」后再跑 `python ./.trellis/scripts/task.py start 10-01-desktop-notify-ux`
     （Trellis 规定 start 是进入实现的闸门，不能替用户决定）。
- **本次会话已经做过的环境改动（都已还原，无需再处理）**：
  - 临时诊断代码已从 `lib/host.js` 撤回，工作区与 live 副本 hash 都回到 `BFA4ACC87A50`。
  - `plugin_manager` 开关往 profile 补丁里写的 `- id: desktop-notify / disabled: false` 已删除，
    `cordis.patch.yml` hash 回到 `19E38512…`。
  - 新增 `.gitignore` 一条：`.tmp-asar/`（asar 解包器 + cordis harness 草稿，留着下次直接用）。
- **验证前提**：改完必须重启 Harness（实测热重载不生效），需要用户配合。
- **2026-10-02 外部资料输入**：两个同类项目（dsh-task-reminder / dsh-task-ask-notify）+ 后者作者的
  焦点检测调研（`<Downloads>\focus-detection.md`，探针在 `ps1-extracted\`）已消化，
  结论沉淀在 `design.md` §8。要点：R5 滚底与 R4 弃用 waterfall 的路线被外部实现独立验证；
  验收 A1 要补「通知中心历史可查」；`alert.ps1` 的全屏检测和点击顺序已经存在，2.2/3.4 的工作量
  缩小为「核对 + 配置接线」，不要重写。

## 依赖顺序执行；每一步做完都要能看到证据（日志、脚本输出、或用户实测）。写文件的边界尽量不重叠，
需要并行的部分在下面标出。

## 0. 准备（不写交付代码）

- [x] 0.1 建 `tools/verify.mjs`：最小 cordis 宿主 + 真实 `lib/host.js` 的离线 harness，
      桩 `subprocess` 记录 spawn 参数，桩 `webServer` 记录路由；能跑通「加载 → 派发事件 → 断言输出」。
- [x] 0.2 建 `tools/deploy.ps1`：`robocopy`/`Copy-Item` 同步 `lib/`、`cordis.patch.yml`、`README*.md`
      到 `%USERPROFILE%\.dsh\my-dsh\dsh-desktop-notify`，`-Restart` 时重启 Harness（需要用户确认）。

## 1. 触发源改造（lib/host.js）

- [x] 1.1 `session/event` 分支拆细：`tool/start`/`turn/start` 保持；新增
      `approval/asked`、`tool/call`(ask_user_question)、`turn/end`(blocked) 三条判定。
- [x] 1.2 会话最近提醒记录：按 `(sessionId, class)` 记时间戳 + 每会话最近一次「等待类」提醒时间，
      给 `blocked` 兜底和 waterfall 去重用；等待类去重窗口独立配置（默认 15s）。
- [x] 1.3 文案：等待类横幅正文带上下文 —— 授权带工具名/原因，提问带题干与选项摘要（截断到 2 行）。
- [x] 1.4 保留 waterfall 订阅 + `agent/created` 的 scoped 订阅，补 `logOnce` 诊断行，
      说明「这条通道这次到底有没有收到」。
- [x] 1.5 `resolveSessionId` / `isRootSession` 边界复核：`approval/asked` 只有 sessionId，
      没有 agent 对象，需要走 session 级判定（子代理过滤沿用 `header.origin` 判断）。

## 2. 投递通道改造（lib/host.js + toast.ps1 + alert.ps1 + cordis.patch.yml）

- [x] 2.1 默认配置改成 `toast:true / alert:true / alertOnlyWhenFullscreen:true`，
      `stickyBlocking` 语义写清（等待类 = `reminder` 常驻）。
- [x] 2.2 `deliver()`：按类别选 scenario；只有 `alertOnlyWhenFullscreen` 为真时给
      `alert.ps1` 传 `-OnlyWhenFullscreen 1`，否则按需显示；两通道都开且非全屏时不发卡片。
      （`alert.ps1` 里 `Test-FullscreenForeground` 已存在，无需重写。）
- [x] 2.3 `toast.ps1`：确认 `scenario="reminder"` 与 `duration="long"` 组合在 0.2.0 版 Windows 上
      的表现；补 `-OnlyWhenFullscreen` 需要的信息到日志（便于验证）。
      手测时同步查通知中心历史（`ToastNotificationManager::History.GetHistory('<AUMID>')`），
      退出码 0 不代表横幅真的显示了（design §8.2）。
- [x] 2.4 声音与 `minGapMs`/`dedupeMs` 复核，避免等待类事件被限速吞掉。
      `toast.ps1` 保持零 `Add-Type`（每次提醒少 0.3-0.4s 编译，design §8.4）。

## 3. 点击跳转（lib/client.js + alert.ps1）

- [x] 3.1 `client.js`：`exports.inject = ["sessions", "uiWorkspace"]`；在注入回调里拿
      `uiWorkspace.openSession`，保留 `ctx.get` 兜底，失败时 `console.warn` 且不静默。
- [x] 3.2 新增 `scrollToLatest()`：先找 `aria-label` 为「回到底部 / Back to bottom」的按钮点击，
      退化到找最大可滚动容器设 `scrollTop`；渲染异步，重试约 1.5s，最多 N 次。
- [x] 3.3 交接链路日志：客户端领到 activation 后上报宿主（新增 POST `/dsh-desktop-notify/activated`
      或复用 focus 路由附带字段），宿主写进 `dsh-desktop-notify.log`，下次排查能看出「客户端到底领没领」。
- [x] 3.4 `alert.ps1` 点击顺序改成「先写交接文件 → 唤前窗口」，并记录时间戳便于对齐日志。
      （现版已是此顺序：`Open-Conversation` 写文件并 trace 后才 `Raise-DshWindow`，核对即可，勿重写。）

## 4. 文档与配置收尾

- [x] 4.1 `README.md` + `README.en.md`：三份副本与 `tools/deploy.ps1`、新默认值、全屏兜底、
      已知限制（独占全屏不保证原生横幅）、重启要求。
- [x] 4.2 `package.json`：`engines.dsh` 升到 `^0.2.0-rc.2`，`files` 增加 `tools/`；版本号提升。
- [ ] 4.3 删除临时目录 `.tmp-asar/`（asar 解包器、harness 草稿、fakehome），确认 `.gitignore` 不遗漏。

## 5. 验证（写完后必做）

- [x] 5.1 `node tools/verify.mjs` 全绿：把「等待类不再哑」「门控正确」「去重正确」变成可重复的断言。
- [x] 5.2 语法/静态检查：`node --check lib/host.js`、`node --check lib/client.js`、
      PowerShell 脚本 `-NoProfile -Command "[scriptblock]::Create((Get-Content -Raw lib/toast.ps1))"` 能解析。
- [x] 5.2b AUMID 投递自证（design §8.2）：手动跑一次 `toast.ps1` 后，
      `[Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('DeepSeekHarness.DesktopNotify')`
      非空——注册表键在 ≠ 横幅会显示，这一步是 A1 的前置证据。
- [x] 5.3 部署到 live（`tools/deploy.ps1`），**请用户重启 Harness**。
- [ ] 5.4 端到端实测（需要用户配合，逐条对照 PRD 验收标准 A1–A7）：
      1) 切到别的会话后触发 `ask_user_question` → 原生横幅出现、通知中心有记录；
      2) 全屏播视频时再触发一次 → 横幅或卡片至少一个可见；
      3) 点击 → DSH 唤前 + 切到该对话 + 停在最后一轮；
      4) 打开该对话时再触发 → 安静。
- [ ] 5.5 查三项日志确认：`skip …: user is looking at this conversation`、`deliver cls=question`、
      `activation published` + 客户端领取记录。

## 6. 收尾

- [ ] 6.1 `trellis-update-spec`：把「session/event 才是可靠触发源」「改 host.js 必须重启」
      「三份副本地图」写进 spec/项目约定。
- [ ] 6.2 提交（按 Trellis 3.4 的批量提交流程，先给用户确认提交计划）。
- [ ] 6.3 提醒用户：若要发布，`git push` 到 `github.com/VoodooB0Ys/dsh-desktop-notify`；
      live 目录仍需 `tools/deploy.ps1` 同步（或后续把 profile 的 link 指向工作区）。

## 回滚点

- 每个阶段结束都可回滚：1/2/3 各自独立可回退（配置里关掉对应通道即可降级）。
- 端到端验证失败时，先 `channels.toast=false` 退回旧行为，再定位。

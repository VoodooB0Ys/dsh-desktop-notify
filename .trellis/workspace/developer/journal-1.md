# Journal - developer (Part 1)

> AI development session journal
> Started: 2026-10-01

---



## Session 1: 桌面提醒体验修复：调研与规划
<!-- trellis-session: v=2 fp=b241acc1fbace6c2 -->

**Date**: 2026-10-01
**Task**: 桌面提醒体验修复：调研与规划
**Branch**: `main`

### Summary

调研 dsh-desktop-notify 的 5 项体验问题，定位两个根因（等待类 waterfall 事件在 DSH 0.2.0-rc.2 上到不了插件；客户端未注入 uiWorkspace 导致点击只唤前窗口），完成 PRD/设计/执行计划，用户决定次日实现。

### Main Changes

- 新建任务 10-01-desktop-notify-ux，补齐 prd.md / design.md / implement.md / research/runtime-findings.md
- 实测确认 profile 实际加载的是 C:\\Users\\<user>\\.dsh\\my-dsh\\dsh-desktop-notify（junction），工作区仓库是另一份
- 实测确认 user-questions/request 与 approval/request 自 9/26 后再未到达插件；改用 session/event（approval/asked、tool/call ask_user_question）作为触发源
- 定位客户端 openSession 静默失败：exports.inject 为空，取不到 uiWorkspace
- 归档历史任务 00-bootstrap-guidelines；还原临时诊断代码与 profile 补丁改动

### Git Commits

(No commits - planning session)

### Testing

- [OK] 离线 cordis harness 加载真实 lib/host.js 成功收到 user-questions/request 并投递（证明插件代码本身没错）
- [OK] plugin_manager 开关可重跑 apply 但 ESM 缓存不失效，确认改代码必须重启宿主
- [OK] POST /dsh-desktop-notify/focus 返回 204，确认路由注册正常

### Status

[OK] **Completed**

### Next Steps

- 次日开工：task.py start 后按 implement.md 第 1-3 节改 host.js / client.js / toast.ps1 / alert.ps1
- 改完用 tools/deploy.ps1 同步到 live，请用户重启 Harness 做端到端验收（A1-A7）


## Session 2: Implement desktop-notify-ux: native toast, waiting-event sources, click-to-latest
<!-- trellis-session: v=2 fp=fe66683044b0a946 -->

**Date**: 2026-10-02
**Task**: Implement desktop-notify-ux: native toast, waiting-event sources, click-to-latest
**Branch**: `main`

### Summary

Implemented the 5 UX fixes end to end: session/event trigger sources (approval/asked, tool/call ask_user_question, turn/end blocked fallback), dual-channel delivery (native toast primary + fullscreen fallback card), click-to-conversation with scroll-to-latest and client receipt; 29-assertion offline harness green; deployed to live and restarted the harness.

### Git Commits

(No commits - planning session)

### Testing

- [OK] node tools/verify.mjs 29/29 green; node --check on host.js/client.js; PS parse x3; real toast sent + Action Center history verified; alert card skip-path logic verified with IsZoomed fix; live routes focus/activated 204, activate long-poll confirmed

### Status

[OK] **Completed**

### Next Steps

- E2E with user: trigger ask_user_question in another conversation, verify banner, click-to-switch, scroll-to-latest; then A2 fullscreen video test and A3 gate test


## Session 3: Speed up delivery + adopt donevoice ideas (probe exe, recheck, presence gate, prepend, route guard)
<!-- trellis-session: v=2 fp=ef96ee94a008a664 -->

**Date**: 2026-10-02
**Task**: Speed up delivery + adopt donevoice ideas (probe exe, recheck, presence gate, prepend, route guard)
**Branch**: `main`

### Summary

Cut notification latency: replaced the serialized PowerShell fullscreen scout with a precompiled C# probe (~40-60ms vs ~700ms) that decides fullscreen/presence, halved settleMs to 400ms; adopted from dsh-donevoice: host-side presence gate when heartbeat stale, recheck-and-reissue for suppressed waiting reminders, waterfall {prepend:true} (solves the 10-01 mystery: official forwarder never calls next()), same-origin route guard (evil Origin 403 verified live). 48 offline assertions green; deployed and restarted.

### Git Commits

(No commits - planning session)

### Testing

- [OK] node tools/verify.mjs 48/48 green incl. probe verdicts, presence gate, recheck, route guard, greedy-listener prepend pin; real machine: toast leg 370ms, probe 60ms, fake fullscreen window test probe=1 + card shown over it; live guard: same-origin 204 / evil 403

### Status

[OK] **Completed**

### Next Steps

- User re-tests popup latency and fullscreen video scenario; commit decision pending

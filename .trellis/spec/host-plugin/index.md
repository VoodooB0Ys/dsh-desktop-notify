# Host Plugin Guidelines（宿主侧插件）

> dsh-desktop-notify 的宿主半边运行在 DeepSeek Harness 的宿主进程里（Electron 之外的
> 独立 Node 进程）。本目录记录与 DSH 宿主、Windows API 打交道时的可执行契约。

## Files

| File | Contents | Status |
|------|----------|--------|
| [dsh-contracts.md](./dsh-contracts.md) | DSH 事件契约、重启边界、部署拓扑、Windows API 陷阱 | Filled |

## Pre-Development Checklist

动 `lib/host.js` / `lib/client.js` / `lib/*.ps1` 之前：

1. [ ] 读 [dsh-contracts.md](./dsh-contracts.md) 的「事件契约」——确认要订阅的事件在
      `session/event` 流里真实存在且可达；waterfall 通道默认视为不可达。
2. [ ] 记住改 `lib/*.js` 必须重启 Harness（热重载不失效 ESM 缓存，实测 2026-10-01）。
3. [ ] 部署用 `tools/deploy.ps1`——工作区仓库是唯一源，live 副本是生成物。
4. [ ] 改完跑 `npm run verify`（离线断言 harness，29+ 项，不弹真窗）。

**Language**: All documentation must be written in **English or bilingual**; keep
executable contracts (signatures, payloads, exit codes) verbatim.

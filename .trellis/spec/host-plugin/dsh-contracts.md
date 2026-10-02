# DSH Host Contracts & Windows Gotchas

> Executable contracts learned on DSH 0.2.0-rc.2, verified on this machine
> (2026-10-01/02). Every claim below was reproduced, not inferred.

## 1. Event contracts — what actually reaches the plugin

### Reliable: `session/event` (emit, root ctx)

```
ctx.on("session/event", (session, event) => { ... })
  session.id ?? session.header.id   → sessionId
  event.type: 'turn/start' | 'turn/end' | 'approval/asked' | 'approval/decided'
              | 'tool/call' | 'subagent/*' | ...
  event.data: payload (turn/end reason lives at event.data.reason.kind)
```

Waiting-class events ride the same stream:

| event.type | data fields | notify as |
|---|---|---|
| `approval/asked` | `{ id, toolName, callId?, reason? }` | approval |
| `tool/call` with `data.name === "ask_user_question"` | `data.arguments` = JSON string `{ questions[].header/question/options }` | question |
| `turn/end` with `reason.kind === "blocked"` | fallback | question |

### Unreliable: waterfall `approval/request` / `user-questions/request` — SOLVED

**Root cause found 2026-10-02** (dsh-donevoice's ARCHITECTURE.md, confirmed against
cordis 4.0.4 source): the official forwarder registers FIRST and, once it has the
answer, does **not call `next()`** — a normally-registered listener is never reached.
The fix is `{ prepend: true }`, and cordis's `on()` takes it as the third argument:
`ctx.on("approval/request", listener, { prepend: true })`. All four waterfall
registrations in host.js use it, and a verify scenario pins the behaviour with a
greedy (no-`next()`) listener registered after ours. `session/event` remains the
primary source: it carries richer payloads (ask_user_question's question text and
options only exist there). Waterfall handlers must observe inside try and call
`next()` outside it — never block the approval chain.

### Latency-critical delivery facts

Dedupe: all sources funnel into one `send()` keyed `(sessionId, class)` — waiting
classes use `waitingDedupeMs` (15 s), the rest `dedupeMs` (8 s). The `blocked`
fallback checks `lastWaiting` (per-session timestamp of the last delivered
approval/question) before sending.

- Foreground verdict: `lib/dsh-notify-probe.exe` (precompiled C#, ~40–60 ms per call,
  exit code = bitmask `1`=fullscreen, `2`=DSH-foreground). A PowerShell probe doing
  the same P/Invoke costs ~700 ms cold — that plus `settleMs` was the "at least one
  second late" user report. Rebuild after touching `lib/activator/DshNotifyProbe.cs`:
  `cmd /c %WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe -nologo -optimize+
  -platform:x64 -out:lib\dsh-notify-probe.exe lib\activator\DshNotifyProbe.cs`
  (run through cmd or csc eats forward slashes as switches).
- Per-notification wall time on this machine: toast leg ~370 ms (powershell.exe
  + WinRT), probe ~60 ms. Completion ≈ settleMs(400) + probe + toast ≈ 0.9 s.
- Recheck-and-reissue (`recheckMs`, waiting classes only): when the focus gate
  suppresses approval/question, a timer re-checks after 1.8 s and delivers if the
  user switched away; `fromRecheck` prevents loops. Completion/failure are never
  re-issued — the user watched them happen.
- Host-side presence gate (`hostPresenceGate`): only when the client heartbeat is
  stale or missing (page closed/frozen), a foreground that belongs to
  `basename(process.execPath)` suppresses the reminder entirely. Fresh heartbeats
  keep the client's per-conversation verdict authoritative.

### Window raise policy (snap-layout safe)

Click-to-open raises the DSH window with three states: minimized → `ShowWindow(SW_RESTORE)`
+ foreground; visible but covered → z-order only (`SetForegroundWindow` +
`BringWindowToTop`, no resize/restore/topmost — snap layouts survive); already
foreground → nothing. Never use `SW_RESTORE` on a visible window (yanks snapped
windows out of the layout) and never re-add a topmost pin (user rejected it twice).

### .ps1 files are ASCII-only — including comments

PowerShell 5.1 reads a UTF-8 script as ANSI. UTF-8 Chinese comments decode as
mojibake whose bytes can contain quote/brace characters and break parsing — this
actually shipped broken once (2026-10-02, "Try 缺少 Catch"). Rule: any comment
added to `lib/*.ps1` must be English. Always run the parse check
(`[scriptblock]::Create((Get-Content -Raw <script>))`) before deploying.

### Local route hardening

`/focus`, `/activate`, `/activated` sit on the GUI's loopback port — any local
webpage could otherwise forge focus reports or trigger activations. Guard
(`routeGuardOk`): `Host` must be loopback (kills DNS rebinding); an `Origin`
header, when present, must be same-host AND same-port (kills cross-origin POSTs
from arbitrary pages; curl/activator/offline-harness without Origin pass).
Verification: evil Origin → 403, same-origin → 204 (asserted offline AND
re-verified live after deploy).

### Uninstall/junction hazard

The profile depends on this plugin via `link:` (a junction). dsh-donevoice's README
documents a real accident: a recursive delete that FOLLOWS the junction wipes the
junction target. Here the target (`~/.dsh/my-dsh/dsh-desktop-notify`) is a generated
copy and the workspace repo is the source of truth, so damage is bounded — but do
not `rm -rf` a profile's `node_modules` with a tool that follows links; redeploy
with `tools/deploy.ps1` afterwards anyway.

## 2. Hot reload does NOT reload code

- `plugin_manager` toggle re-runs `apply()` and re-registers routes (focus POST → 204
  again), **but Node's ESM cache keeps the old module**: edits to `lib/*.js` never load.
- Verified by writing `diag:`-prefixed logging, toggling, and observing nothing.
- **Contract**: any `lib/*.js` / `lib/client.js` change requires a Harness restart.
  Config-only changes (`cordis.patch.yml`) are re-read on plugin re-enable without a
  restart.

## 3. Deployment topology — three copies

| path | role |
|---|---|
| workspace repo | single source of truth (git) |
| `%USERPROFILE%\.dsh\my-dsh\dsh-desktop-notify` | **the copy the profile loads** (profile `package.json` has `"dsh-desktop-notify": "link:C:/Users/.../my-dsh/..."` junction) |
| `%USERPROFILE%\.dsh\plugins\dsh-desktop-notify` | plugin-manager clone, not used at runtime |

Deploy: `tools/deploy.ps1` (robocopy lib/ + top-level files), `-Restart` to restart
the harness. Editing the workspace alone changes nothing at runtime.

## 4. Restarting the Harness (Electron) — wrong vs correct

### Wrong

```powershell
taskkill /IM 'DeepSeek Harness.exe'        # windowless children refuse: "只能强行终止"
# → app parks in tray, processes outlive the window, script hangs
```

### Correct

```powershell
$main = Get-Process -Name 'DeepSeek Harness' | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
[void]$main.CloseMainWindow()   # WM_CLOSE to the real window
Start-Sleep -Seconds 8
Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Process 'D:\DSH\DeepSeek Harness.exe'
```

Single-instance lock: launching while the old instance lives only focuses the old
window — it does not reload code. Always confirm old processes are gone first.
Success check: fresh `plugin loaded: … channels={...}` line in
`~/.dsh/dsh-desktop-notify.log` with the NEW values.

## 5. Windows API gotchas (delivery scripts)

### Focus/PID trap

The DSH window belongs to the **Electron main process**; the plugin runs in a **host
subprocess**. Comparing the foreground window PID to `process.pid` is always false →
silent feature death. If you ever need "is DSH in the foreground", compare **exe
paths** (`process.execPath` vs the window owner's `MainModule.FileName`), never PIDs.

### Fullscreen vs maximized (auto-hide taskbar)

`GetWindowRect` vs monitor rect is not enough: with an auto-hiding taskbar the work
area equals the full monitor, so a **maximized** window covers the monitor exactly and
looks "fullscreen" → the fallback card would duplicate the banner on every reminder.
Discriminator: `IsZoomed()` — true fullscreen (video F11 / HTML5 / exclusive
fullscreen) is not in maximized state; a maximized window is. Electron custom-titlebar
windows have no `WS_CAPTION`, so a caption check does **not** work here (verified:
Edge custom-titlebar maximized, caption=False on some builds).

### Toast delivery verification

`ToastNotificationManager.CreateToastNotifier(aumid).Show()` returning without
exception does NOT prove display. The AUMID must be registered
(`HKCU:\Software\Classes\AppUserModelId\<aumid>` — our toast.ps1 does this at every
send). Only reliable evidence: notification-centre history —
`[Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('<aumid>')`.

**AUMID DisplayName**: an AUMID key can exist with ONLY `CustomActivator` on it (the
registration half that demonstrably works) while `DisplayName` silently failed to
write — Windows then shows a fallback toast title. toast.ps1 now writes DisplayName
from BOTH registration paths and reports failures on stderr instead of `catch { }`.
An old AUMID key from a previous plugin iteration (`DeepSeekHarness.DshNotify`) may
linger in the registry; it is inert but confusing — check
`HKCU:\Software\Classes\AppUserModelId` when toast titles look wrong.

### One popup per reminder (delivery gate, exit code 30)

Both channels + `alertOnlyWhenFullscreen` (default) → `alert.ps1` runs FIRST with
`-OnlyWhenFullscreen 1` as a scout: exit **30** = foreground is fullscreen, card is
showing → host must NOT spawn the toast; exit 0 = card skipped (not fullscreen) →
host spawns the toast; any other code = card failed → host spawns the toast anyway.
Rationale: the fullscreen verdict only exists inside the script, and showing two
popups for one event was a real user-reported bug (2026-10-02). Cost of a false
"fullscreen" is now "reminder arrives as a card instead", never a duplicate.

### Spawning PowerShell for toast scripts

- Always `-File <script>`: passing `[DllImport(...)]` source through `-Command`
  strips inner quotes and fails to compile (measured 2026-10-01).
- Never `detached: true` for toast delivery: Windows silently drops the toast while
  the process reports success (dsh-task-ask-notify's finding; our host spawns via the
  DSH `subprocess` service, which is safe).
- Chinese text goes through UTF-8 temp files (PS 5.1 reads a UTF-8 script as ANSI);
  the scripts themselves stay ASCII-only.

## 6. Test requirements for changes here

`node tools/verify.mjs` must stay green. It loads the real `lib/host.js` into a
minimal cordis host with a stub `subprocess`/`webServer` and asserts: focus gate,
subagent filter, per-class dedupe windows, `approval/asked`, `ask_user_question`
copy, `blocked` fallback + dedupe, completion path, waterfall redundancy, delivery
flags (`-OnlyWhenFullscreen`, `-Scenario`, sound), activation handoff chain, toast
failure fallback. When adding an event source or config key, add a scenario — the
harness passes config via `ctx.plugin(plugin, config)` (forgetting this runs
everything on DEFAULTS: the first debugging clue is "completions don't fire").

Real-machine checks that cannot be automated: banner visible + notification-centre
history entry; card visible over fullscreen video; click → conversation switch +
scroll to latest.

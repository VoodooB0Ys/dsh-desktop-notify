# dsh-desktop-notify

[中文](README.md) | **English**

Desktop reminders for **DeepSeek Harness** on Windows: when the harness needs your
approval, asks you a question, finishes a turn, errors out, or gets interrupted, a
**native Windows toast banner** appears (and lands in the notification centre). While a
fullscreen app owns the foreground — where Windows suppresses banners and never replays
them — a topmost card of our own covers the gap. Click the banner or the card and DSH
comes to the front, switched to the conversation that raised it, scrolled to the latest
message when possible.

Built for the case where you are not looking at DSH — another window, another
conversation, or a fullscreen video.

> **Windows only.** macOS and Linux are not supported: the whole chain is WinRT
> notifications / PowerShell / Win32 window activation. On other platforms the plugin
> loads and does nothing.

## What you get

| Event | Card title | Loud or quiet |
|---|---|---|
| A tool needs your approval | `需要你授权`, body names the tool and reason | loud, waits for you |
| The model asks you something / plan review | `需要你回答`, body carries the question and options | loud, waits for you |
| A turn finishes | `任务完成` | quiet, auto-dismisses |
| A turn ends with an error | `任务出错` | waits |
| A turn is aborted / interrupted / hits the output cap | `任务被中止` | waits |
| A turn ends *blocked* (fallback) | `需要你回答` — only if no waiting reminder went out first | like a question |

Titles are shown in Chinese. `lib/host.js` holds the label table if you want to change it.

It stays quiet when it should:

| Situation | Behaviour |
|---|---|
| You are looking at the conversation that raised the event | **silent** |
| You are looking at a different conversation, or the window is minimised / covered | rings |
| A subagent / child session does something | silent by default |
| A turn shorter than 5 seconds ends | not treated as "finished" |
| The same event repeats | one reminder per window (15 s for waiting events, 8 s for the rest) |
| The main turn is waiting on background subagents | not treated as "finished" until they finish |
| Focus is unknown (the page never reported) | treated as "away" — rings rather than miss |

## Requirements

- Windows 10 / 11 (x64)
- DeepSeek Harness desktop app, `0.2.0-rc.2` or compatible
- PowerShell 5.1 and .NET Framework 4 (both ship with Windows)

No npm dependencies. No build step unless you want to rebuild the activator (below).

## Install

Installing means touching your profile's `package.json`, running pnpm once, and
restarting the harness — easy but fiddly. **The easiest path is to hand the
instructions to the agent inside DSH and let it install for you.**

### Option A (recommended): let your agent install it

Send this to the agent in DSH and it takes about two minutes:

> Please install the dsh-desktop-notify plugin for me: clone
> https://github.com/VoodooB0Ys/dsh-desktop-notify into a permanent tools folder;
> edit %USERPROFILE%\.dsh\profiles\desktop\package.json (adjust the profile name if
> yours differs), add `"dsh-desktop-notify": "link:<clone location>"` (forward
> slashes) to dependencies and `"dsh-desktop-notify"` to dsh.profile.bundles; then
> run one install inside the profile directory with the bundled node + pnpm from
> %USERPROFILE%\.dsh\dsh-runtimes\; finally restart DeepSeek Harness. Verify
> %USERPROFILE%\.dsh\dsh-desktop-notify.log shows a "plugin loaded" line and report back.

### Option B: plugin manager

In DSH: **Settings → Plugins**, install by spec:

```
github:VoodooB0Ys/dsh-desktop-notify
```

### Option C: manual (option A spelled out)

1. Clone it to a permanent location (this folder becomes the link target inside the
   profile — keep a copy of it, and don't "clean" it with link-following tools;
   if it ever disappears, re-cloning is enough):

   ```bash
   git clone https://github.com/VoodooB0Ys/dsh-desktop-notify D:\tools\dsh-desktop-notify
   ```

2. Edit `%USERPROFILE%\.dsh\profiles\<profile>\package.json` (`<profile>` is usually
   `desktop`, or `web` for a browser-based install) and add one line to `dependencies`
   and one to `bundles`:

   ```json
   {
     "dependencies": {
       "dsh-desktop-notify": "link:D:/tools/dsh-desktop-notify"
     },
     "dsh": {
       "profile": {
         "bundles": [
           "dsh-desktop-notify"
         ]
       }
     }
   }
   ```

   Keep your existing entries. Use forward slashes in the path.

3. Install it into the profile:

   ```bash
   cd %USERPROFILE%\.dsh\profiles\<profile>
   <bundled node> <bundled pnpm>/bin/pnpm.mjs install
   ```

   (The desktop app ships its own node/pnpm under `%USERPROFILE%\.dsh\dsh-runtimes\`.)

4. **Restart the harness.** The plugin registers its routes while the host boots; a hot
   re-apply is not enough.

Nothing else is machine specific: no absolute paths are stored anywhere in the plugin,
and the notification identity is created per-user in `HKCU` on first use.

## Click behaviour

Clicking the banner or the card writes the target conversation id to a handoff file
(`%USERPROFILE%\.dsh\dsh-desktop-notify.activate`); the host polls it and asks the page
to open that conversation — the same thing as clicking the row in the sidebar — then
**best-effort scrolls to the latest message**: it prefers DSH's built-in "back to
bottom" button and falls back to pinning the largest scrollable container to its end.
If DSH changes, this degrades to "switch only"; reminders are unaffected.

Window-raising policy (designed for Win snap layouts): **minimized** → restore and
foreground; **visible but covered** → bring DSH to the top at its current size and
position (z-order only — snap layouts survive); **already foreground** → nothing.
No forced topmost pin. Once the page claims the click it reports back, so the log shows
`activation claimed by client: session=… opened=true` — the first line to look at when
a click "does nothing".

## Configuration

Defaults live in this package's `cordis.patch.yml`. To change them, add an override to
your **profile's** `cordis.patch.yml`:

```yaml
- id: desktop-notify
  name: dsh-desktop-notify
  config:
    channels:
      toast: false        # turn the native banner off, back to card-only behaviour
      alert: true
      alertOnlyWhenFullscreen: false   # card shows at all times (default: fullscreen backup only)
    classes:
      completion: false
    minTurnMs: 10000
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `classes` | all `true` | per-event switches (`approval` / `question` / `completion` / `failure` / `aborted`) |
| `channels.toast` | `true` | native Windows banner (notification centre), **the default primary channel** |
| `channels.alert` | `true` | the topmost card: fullscreen backup + banner-failure backup |
| `channels.alertOnlyWhenFullscreen` | `true` | while the banner is on, the card only appears when the foreground is fullscreen |
| `alertSeconds` | see file | how long the card stays (approval/question 30 s, completion 10 s, failure/aborted 25 s; `0` = until clicked) |
| `gateOnFocus` | `true` | the "only when you are not looking at that conversation" gate |
| `backgroundGraceMs` | `45000` | how stale a focus report may be before you count as away |
| `minTurnMs` | `5000` | turns shorter than this do not count as "finished" |
| `dedupeMs` | `8000` | same event, same conversation: one reminder per window |
| `waitingDedupeMs` | `15000` | separate dedupe window for waiting events (approval/question) |
| `minGapMs` | `1500` | minimum gap between two reminders |
| `settleMs` | `400` | wait after a turn ends before calling it finished (the main latency term for completions) |
| `recheckMs` | `1800` | if a suppressed question/approval reminder's owner walks away within this window, it is re-issued (`0` disables) |
| `hostPresenceGate` | `true` | when the page is closed / heartbeat stale, a DSH foreground window means "you're in the app" — stay quiet |
| `notifySubagents` | `false` | also remind for subagent sessions |
| `sound` | `true` | short system cue per event class |
| `debug` | `true` | write `%USERPROFILE%\.dsh\dsh-desktop-notify.log` |

With both channels on, **each reminder produces exactly one popup**: the host asks
Windows about the foreground first via a precompiled probe (~60 ms) — fullscreen
foreground → the card only (the system would suppress the banner anyway and never
replay it), otherwise → the banner only. When the foreground IS DSH but the page is
closed or the heartbeat is stale, it treats you as "in the app" and stays quiet;
a fresh heartbeat keeps the client's per-conversation verdict authoritative. If the
banner channel fails outright (for instance the AUMID registration was removed), a
card is forced through regardless of the foreground — overlapping once beats staying
silent.

Two extra safety nets: a question/approval reminder suppressed while you were
looking is re-issued if you walk away within `recheckMs` (default 1.8 s); and the
three local routes carry a same-origin guard (loopback Host + same-origin Origin),
so arbitrary web pages cannot forge focus reports or activations.

The plugin also registers the AUMID and the COM activator it needs (see *Why the click
needs a COM activator*).

## Troubleshooting

```bash
tail -f %USERPROFILE%\.dsh\dsh-desktop-notify.log            # gate / delivery decisions
tail -f %USERPROFILE%\.dsh\dsh-desktop-notify.activate.log   # clicks and window raising
```

Every decision is logged: `skip completion: user is looking at this conversation`,
`skip ...: deduped`, `skip ...: subagent session`, `deliver cls=question`,
`activation published`, `activation claimed by client`, `card shown`, `card clicked`.

If a banner "succeeded" but nothing appeared on screen, check the notification-centre
history (the only reliable delivery evidence):

```powershell
powershell -NoProfile -Command "[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]; [Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('DeepSeekHarness.DesktopNotify').Count"
```

Quick check that the host routes are alive:

```bash
curl -X POST -H "content-type: application/json" -d "{\"focused\":true}" \
  http://127.0.0.1:<your dsh port>/dsh-desktop-notify/focus
```

`204` means the plugin registered its routes; `405`/`404` means it did not — you are
running a stale host process, restart it.

## Uninstall

1. Remove `dsh-desktop-notify` from your profile's `dependencies` and `bundles`, run
   `pnpm install` in the profile directory, then restart.
2. Optionally remove what it created while running:

```
HKCU\Software\Classes\AppUserModelId\DeepSeekHarness.DesktopNotify
HKCU\Software\Classes\CLSID\{D7A1F0B2-3C4D-4E5F-9A0B-1C2D3E4F5A6B}   (only with channels.toast)
```

## Why the click needs a COM activator

For an unpackaged Windows app, the two obvious approaches do not work — both verified by
trace, not assumed:

| Approach | Result |
|---|---|
| `activationType="protocol"` + a registered URI scheme | The handler works when invoked by hand, but a real banner click never reached it: Windows does not delegate the click for unpackaged apps |
| A resident process subscribing to the toast's `Activated` event | A PowerShell host never receives it. A programmatic dismiss produced no `Dismissed` event either, so the event pump cannot deliver here at all |
| **A COM local server registered as the AUMID's `CustomActivator`** | **Works.** Windows launches `lib/dsh-notify-activator.exe`, which hands the conversation id to the host; the client half then opens that conversation |
## Known limitations

- **Windows only**, x64. The activator is a .NET Framework 4 x64 binary.
- Pinned to DSH `^0.2.0-rc.2` event/service contracts. DSH internals change between
  releases; if one renames an event this plugin subscribes to, reminders stop.
- The first install and **every `lib/*.js` change need a host restart** — routes are
  registered during boot, and hot reload does not reload ESM modules (verified).
- Under **exclusive fullscreen** (some games/players) Windows suppresses native banners
  and never replays them; the topmost card is our own window and is immune — that is
  the reason it exists.
- Fullscreen is detected as "window covers the monitor and is not maximised". On
  machines with an auto-hiding taskbar a maximised window's rect equals the whole
  screen, so the maximised state itself is the discriminator. An oddly bordered app
  may be mistaken for fullscreen; the cost is that this one reminder arrives as a
  card instead of a banner — still a single popup.
- "Scroll to latest" is best-effort: it prefers DSH's own back-to-bottom button and
  falls back to the largest scrollable container. A DSH update may degrade it to
  "switch conversation only" (visible in the log).
- The Web GUI opened in a browser does not participate — this is a host-side plugin
  speaking through Windows channels.

## Acknowledgments

This plugin stands on the shoulders of community authors whose work and measured
findings fed directly into it:

- [dsh-task-ask-notify](https://github.com/deadbushxw/dsh-task-ask-notify) (@deadbushxw)
  — the author also privately shared an internal focus-detection study (process chain,
  probe scripts, timing data); the precompiled-probe vs PowerShell-cold-start and
  maximized ≠ fullscreen discriminators here benefit directly from it
- [dsh-donevoice](https://github.com/zywnb-2/dsh-donevoice) (@zywnb-2)
  — identified why waterfall events never arrive (the official forwarder registers
  first and never calls `next()`; you need `{ prepend: true }`), the host-side
  presence idea, and the walk-away re-issue
- [dsh-task-reminder](https://github.com/hawkongz/dsh-task-reminder) (@hawkongz)
  — the "back to bottom" button scrolling approach and independent verification of
  DND/fullscreen behaviour

## License

MIT — see [LICENSE](LICENSE).

# dsh-desktop-notify

**中文** | [English](README.en.md)

![platform](https://img.shields.io/badge/platform-Windows%2010%2F11-blue)
![dsh](https://img.shields.io/badge/DeepSeek%20Harness-0.2.0--rc.2%2B-green)
![license](https://img.shields.io/badge/license-MIT-lightgrey)

**DSH 的桌面提醒：agent 不用你盯着——卡住了它来叫你，点一下就回到现场。**

## 实际用起来是什么感觉

你左边分屏看直播、右边开着 DSH 跑长任务。agent 停下来等你授权一个命令——以前你得自己
发现；现在右下角弹一条 **Windows 原生横幅**：「需要你授权 · 你的任务名」，正文写着要
执行什么。**点一下**，右半边的 DSH 切到那个对话、停在最新一条，你的分屏布局纹丝不动。

你切去全屏看视频？系统横幅会被 Windows 压掉（压掉不补弹，这是系统行为）——插件检测到
前台全屏，**改弹一张自己的置顶卡片**。你正盯着那个对话看？它安静。页面关了、标签被冻结
了？提醒由宿主进程直接发，照收不误，它还会直接问 Windows「前台是不是 DSH」来决定响不响。

问答和授权的横幅正文不是干巴巴的「等你操作」：提问带**题干和选项摘要**，授权带**工具名
和原因**，不点开就知道发生了什么。等待类的横幅是常驻的，不走就一直在；完成类轻提示，
自动消失。

> **仅 Windows。** 不支持 macOS / Linux：整条链是 WinRT 通知 / PowerShell / Win32 窗口
> 激活。在其它系统上插件会加载但什么都不做。

## 覆盖哪些事件

| 事件 | 提醒 | 打扰程度 |
|---|---|---|
| 有工具需要你授权 | 「需要你授权」，正文带工具名与原因 | 响，且常驻等你 |
| 模型向你提问 / 计划审阅 | 「需要你回答」，正文带题干与选项摘要 | 响，且常驻等你 |
| 一个回合正常结束 | 「任务完成」 | 轻，自动消失 |
| 一个回合以报错结束 | 「任务出错」 | 常驻 |
| 回合被中止 / 中断 / 达到输出上限 | 「任务被中止」 | 常驻 |
| 回合以"被阻塞"结束（兜底） | 「需要你回答」——前面两类通道都没报过才补 | 同提问 |

该安静的时候它会安静：

| 情形 | 行为 |
|---|---|
| 你正看着**发出这条提醒的那个对话** | **不出声也不弹** |
| 你在看别的对话，或窗口最小化 / 被别的窗口盖住 | 提醒 |
| 子代理 / 子会话里的动作 | 默认不提醒 |
| 短于 5 秒的回合结束 | 不算"完成" |
| 同一件事短时间内又发生一次 | 只提醒一次（等待类 15 秒窗口，其余 8 秒） |
| 主回合在等后台子代理还没跑完 | 不算"完成"，等它们都结束 |
| 焦点信息取不到（页面从未上报） | 按"没在看"处理——宁可多响一次也不漏 |

## 环境要求

- Windows 10 / 11（x64）
- DeepSeek Harness 桌面版（profile 的宿主进程），`0.2.0-rc.2` 或兼容版本
- PowerShell 5.1 与 .NET Framework 4（Windows 自带）

没有 npm 依赖。除了想自己重建激活器（见下文）之外，没有构建步骤。

## 安装

安装要动 profile 的 `package.json`、跑一次 pnpm、重启 Harness——步骤不难但琐碎，
**推荐直接把话术丢给 DSH 里的 agent 让它装**；动手能力强的也可以走插件管理器或手动。

### 方式一（推荐）：让 agent 帮你装

把下面这段原样发给 DSH 里的 agent，两分钟搞定：

> 请帮我安装 dsh-desktop-notify 插件：把 https://github.com/VoodooB0Ys/dsh-desktop-notify
> 克隆到一个固定的工具目录；然后编辑 %USERPROFILE%\.dsh\profiles\desktop\package.json
> （如果你用的是别的 profile 就换目录名），在 dependencies 里加一行
> "dsh-desktop-notify": "link:<克隆位置>"（正斜杠），在 dsh.profile.bundles 数组里加
> "dsh-desktop-notify"；接着进 profile 目录用 %USERPROFILE%\.dsh\dsh-runtimes\ 下自带的
> node + pnpm 跑一次 install；最后重启 DeepSeek Harness。装完检查
> %USERPROFILE%\.dsh\dsh-desktop-notify.log 里出现 "plugin loaded" 就算成功，向我汇报。

agent 装完你重启一次 DSH，弹一条测试通知验证即可（配置里有 `debug`，日志见排查一节）。

### 方式二：插件管理器

在 DSH 里打开 **设置 → 插件**，用 spec 安装：

```
github:VoodooB0Ys/dsh-desktop-notify
```

### 方式三：手动（就是方式一展开）

1. 克隆到任意固定位置（别放在会被"清理工具"递归删除的地方，见下文 junction 警告）：

   ```bash
   git clone https://github.com/VoodooB0Ys/dsh-desktop-notify D:\tools\dsh-desktop-notify
   ```

2. 编辑 `%USERPROFILE%\.dsh\profiles\<profile>\package.json`（`<profile>` 通常是
   `desktop`，浏览器版是 `web`），加入：

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

   原有条目保留不动——你只是往 `dependencies` 加一行、往 `bundles` 加一行。路径用正斜杠。

3. 装进 profile：

   ```bash
   cd %USERPROFILE%\.dsh\profiles\<profile>
   <自带 node> <自带 pnpm>/bin/pnpm.mjs install
   ```

   （桌面版自带 node/pnpm，在 `%USERPROFILE%\.dsh\dsh-runtimes\` 下。）

4. **重启 Harness。** 插件是在宿主启动过程中注册自己的路由的，热重载不够。

除此之外没有任何跟机器绑定的东西：插件里不存任何绝对路径，通知身份是运行时在
`HKCU` 里按当前用户创建的。

## 开发：改完代码怎么生效

这套插件在你机器上实际有**三份副本**，别改错地方：

| 路径 | 角色 |
|---|---|
| 工作区仓库（本目录） | 唯一源，git 管理的就是它 |
| `%USERPROFILE%\.dsh\my-dsh\dsh-desktop-notify` | **profile 实际加载的那份**（通过 link junction） |
| `%USERPROFILE%\.dsh\plugins\dsh-desktop-notify` | 插件管理器装的克隆，不参与运行 |

从工作区同步到 live 目录：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\deploy.ps1          # 只同步
powershell -NoProfile -ExecutionPolicy Bypass -File tools\deploy.ps1 -Restart # 同步并重启 Harness
```

> **警告**：profile 对插件用的是 `link:`（junction）。曾有同类插件的用户在卸载时
> 被递归删除跟随链接、把 junction 指向的目录整个删掉。这里指向的是生成的副本、
> 损失可控，但**不要用会跟随链接的工具清空 profile 的 `node_modules`**；清完记得
> 重新 deploy。

改 `lib/*.js` 后**必须重启 Harness**——热重载只会重跑 `apply()`，Node 的 ESM 缓存
不会失效（实测）。改 `cordis.patch.yml` 的配置项不用重启，重新启用一次插件即可。
改 `lib/activator/DshNotifyProbe.cs` 后要重建探针（csc，命令见文件头注释）。

离线验证（不弹真窗，断言触发门 / 去重 / 投递参数）：

```bash
npm run verify
```

## 点击行为

点横幅或卡片会把目标对话 id 写进交接文件（`%USERPROFILE%\.dsh\dsh-desktop-notify.activate`），
宿主轮询取走后让页面打开那个对话——等同于点侧边栏里那一行——并**尽力把视图滚到最新一条**：
优先点 DSH 自带的"回到底部"按钮，找不到就把最大的可滚动容器拉到底。这一步是 best-effort，
DSH 改版后最多退化为"只切会话"，不影响提醒本身。

窗口唤起策略（为 Win 吸附分屏设计）：**最小化** → 恢复并唤前；**可见但被遮挡** → 只把
DSH 提到最上层，保持原大小原位置（吸附布局不破坏）；**本来就在前台** → 什么都不做。
不做强制置顶。客户端领到点击后会向宿主回执，日志里能看到
`activation claimed by client: session=… opened=true`，排查"点了但没切过去"时先看这行。

## 配置

默认值在本包的 `cordis.patch.yml` 里。要改就在**你自己 profile 的**
`cordis.patch.yml` 里加一段覆盖：

```yaml
- id: desktop-notify
  name: dsh-desktop-notify
  config:
    channels:
      toast: false        # 关掉原生横幅，回到"只用自绘卡片"的旧行为
      alert: true
      alertOnlyWhenFullscreen: false   # 卡片任何时候都显示（默认只在全屏时补位）
    classes:
      completion: false
    minTurnMs: 10000
```

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `classes` | 全 `true` | 按事件开关（`approval` / `question` / `completion` / `failure` / `aborted`） |
| `channels.toast` | `true` | Windows 原生横幅（进通知中心），**默认主通道** |
| `channels.alert` | `true` | 自绘置顶卡片：全屏兜底 + 横幅失败兜底 |
| `channels.alertOnlyWhenFullscreen` | `true` | 横幅开着时，卡片只在前台是全屏时补位（避免两条叠一起） |
| `alertSeconds` | 见文件 | 卡片停留秒数（授权/提问 30 秒，完成 10 秒，出错/中止 25 秒；`0` = 一直留到你点） |
| `gateOnFocus` | `true` | "你正在看那个对话就不打扰"这道门 |
| `backgroundGraceMs` | `45000` | 焦点上报多久没更新就当作你已离开 |
| `minTurnMs` | `5000` | 短于这个时长的回合不算"完成" |
| `dedupeMs` | `8000` | 同一对话同一类事件的去重窗口 |
| `waitingDedupeMs` | `15000` | 等待类（授权/提问）的独立去重窗口 |
| `minGapMs` | `1500` | 两条提醒之间的最小间隔 |
| `settleMs` | `400` | 回合结束后等多久再判定"完成"（完成类延迟的大头） |
| `recheckMs` | `1800` | 提问/授权被"正看着"抑制后，切走多久内补发（`0` 关闭） |
| `hostPresenceGate` | `true` | 页面没开/心跳过期时，前台是 DSH 就安静（宿主直接问 Windows） |
| `notifySubagents` | `false` | 子代理会话是否也提醒 |
| `sound` | `true` | 按类别播放的短提示音 |
| `debug` | `true` | 写 `%USERPROFILE%\.dsh\dsh-desktop-notify.log` |

横幅与卡片两个通道都开着时，**一次提醒只弹一个**：宿主先用预编译探针（~60ms）问一次
Windows 前台——前台是全屏 → 只弹卡片（这时系统横幅多半会被压掉且不补弹），否则 →
只弹横幅。前台就是 DSH 而页面又没开/心跳过期时，按"你在应用里"处理，安静；心跳新鲜时
以页面上报的对话级判定为准。横幅通道彻底失败（比如 AUMID 注册被清掉）时，插件会补一张
不挑前台状态的卡片，宁可重叠也不漏报。

另外两条补漏设计：提问/授权在你正看着时被抑制后，`recheckMs`（默认 1.8 秒）内切走
会补发一条——瞄了一眼就回去干活也不漏；本地三条路由带同源护栏（回环 Host + 同源
Origin），别的网页伪造不了焦点上报。

插件会顺带注册它需要的 AUMID 与 COM 激活器（见《为什么点击需要 COM 激活器》）。

## 排查

```bash
tail -f %USERPROFILE%\.dsh\dsh-desktop-notify.log            # 门与投递的判定
tail -f %USERPROFILE%\.dsh\dsh-desktop-notify.activate.log   # 点击与窗口唤前
```

每一步判定都会留痕：`skip completion: user is looking at this conversation`、
`skip ...: deduped`、`skip ...: subagent session`、`deliver cls=question`、
`activation published`、`activation claimed by client`、`card shown`、`card clicked`。

横幅"成功"但屏幕上没看到的，查通知中心历史（唯一可靠的投递证据）：

```powershell
powershell -NoProfile -Command "[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]; [Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('DeepSeekHarness.DesktopNotify').Count"
```

快速确认宿主路由是否活着：

```bash
curl -X POST -H "content-type: application/json" -d "{\"focused\":true}" \
  http://127.0.0.1:<你的 dsh 端口>/dsh-desktop-notify/focus
```

返回 `204` 说明插件注册上了；`405`/`404` 说明没有——你正在跑的是旧宿主进程，重启它。

## 卸载

1. 从 profile 的 `dependencies` 和 `bundles` 里删掉 `dsh-desktop-notify`，在 profile
   目录里跑一次 `pnpm install`，然后重启。
2. 可选：清掉它运行时创建的东西：

```
HKCU\Software\Classes\AppUserModelId\DeepSeekHarness.DesktopNotify
HKCU\Software\Classes\CLSID\{D7A1F0B2-3C4D-4E5F-9A0B-1C2D3E4F5A6B}   （只有用过 channels.toast 才会有）
```

## 为什么点击需要一个 COM 激活器

对未打包的 Windows 应用，两条看起来最直接的路实测都走不通——都是靠留痕判定，不是猜的：

| 做法 | 结果 |
|---|---|
| `activationType="protocol"` + 注册 URI 协议 | 手动执行这条 URI 每次都成功，但**真实点击横幅从来没有到过处理器**——Windows 对未打包应用不做这个转交 |
| 常驻进程订阅通知的 `Activated` 事件 | PowerShell 宿主收不到：用一个不需要点击的等价实验（程序化关闭通知）验证，连 `Dismissed` 都收不到，事件泵根本投递不进这个进程 |
| **注册成 AUMID 的 `CustomActivator` 的 COM 本地服务器** | **可用**——Windows 会启动 `lib/dsh-notify-activator.exe`，由它把对话 id 交给宿主并把窗口唤前 |

激活器刻意编译成 **winexe**：控制台子系统每次点击都会闪一个黑框。用 .NET Framework
自带的编译器重建：

```powershell
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" -nologo -optimize+ `
  -target:winexe -platform:x64 -out:lib\dsh-notify-activator.exe lib\activator\NotifyActivator.cs
```

`lib/register-activator.ps1` 可以手动注册（并校验）COM 那半边。

## 已知限制

- **仅 Windows**，x64。激活器是 .NET Framework 4 的 x64 二进制。
- 绑定 DSH `^0.2.0-rc.2` 的事件与服务契约。DSH 内部版本之间会变；如果某个版本改名了
  本插件订阅的事件，提醒就会失效。
- 首次安装与**每次改 `lib/*.js` 都必须重启宿主**——路由在启动过程中注册，且热重载
  不会重新加载 ESM 模块（实测）。
- **独占全屏**（某些游戏/播放器）下，Windows 会压掉原生横幅且不补弹；置顶卡片是我们
  自己的窗口，不受此限，这正是它存在的理由。
- 全屏判定按"窗口盖满显示器且不是最大化"来算；自动隐藏任务栏的机器上，最大化窗口
  尺寸恰好等于整屏，靠"是否处于最大化状态"区分。个别自绘边框的应用可能被误判成全屏，
  代价是这条提醒换成卡片呈现（仍然只弹一个），不影响功能。
- "滚到最新一条"是 best-effort：优先点 DSH 的"回到底部"按钮，找不到就拉最大的滚动
  容器。DSH 改版后可能退化为"只切会话"（日志可查）。
- 在浏览器里打开的 Web GUI 不参与这套通知——这是宿主侧插件，走的是 Windows 通道。

## 鸣谢

这个插件站在几位社区作者的肩膀上，直接借鉴并回报了实测结论：

- [dsh-task-ask-notify](https://github.com/deadbushxw/dsh-task-ask-notify)（@deadbushxw）
  —— 作者还无私分享了焦点检测的内部调研（进程链、探针脚本、耗时数据），本项目对
  「PowerShell 冷启 vs 预编译探针」「最大化 ≠ 全屏」的判定直接受益
- [dsh-donevoice](https://github.com/zywnb-2/dsh-donevoice)（@zywnb-2）
  —— 点破了 waterfall 事件收不到的根因（官方转发器先注册且不调 next()，要用
  `{ prepend: true }` 插队）、宿主侧 presence 思路、「切走复核补发」
- [dsh-task-reminder](https://github.com/hawkongz/dsh-task-reminder)（@hawkongz）
  —— 「回到底部」按钮的滚动方案，以及对勿扰/全屏行为的独立验证

## 许可

MIT，见 [LICENSE](LICENSE)。

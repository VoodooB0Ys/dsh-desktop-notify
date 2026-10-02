/**
 * dsh-desktop-notify —— 宿主侧桌面提醒插件。
 *
 * 行为取自社区同类插件（@mzzsfy/dsh-turn-notify、aokamoaki/dsh-notify、
 * kongdexu/dsh-win-notify、bululuburuarua666/dsh-herald、YiMlT/dsh-notify-yimit 等）
 * 提炼出的共性逻辑：
 *
 *   - 宿主直发：DSH 宿主是 Electron 之外的独立 Node 进程（lib/main.js 用
 *     spawn(node, [dsh-desktop-host/lib/index.js]) 起），拿不到 Electron 的
 *     Notification / flashFrame，所以由宿主 spawn PowerShell 弹窗。
 *     窗口最小化、被全屏视频盖住、甚至页面关掉，都照样送达。
 *   - 双通道，但一次提醒只弹一个：toast.ps1 走 WinRT 系统 Toast（进通知中心，
 *     默认通道）；alert.ps1 走常驻置顶 WPF 浮窗（Topmost，能盖在全屏视频上）。
 *     前台是不是全屏只有脚本知道，所以卡片先探路：前台全屏 → 只弹卡片
 *     （全屏会压掉横幅且不补弹），非全屏 → 只弹横幅；横幅彻底失败时再补一张
 *     不挑前台状态的卡片。
 *   - 仅后台触发：只在用户没在看「发出事件的那个对话」时提醒，等待类（授权/提问）
 *     也不例外——正盯着问卷时再弹一次是打扰。焦点状态由客户端半边上报，宿主自己判断不了。
 *   - 单一出口 + 去重限速：所有事件走同一个 send()，按 (会话, 类别) 短时去重，
 *     并保证全局最小发送间隔，避免同一事件重复轰炸。
 *   - 不打扰：子代理 / workflow 子会话默认不通知；过短的回合不通知；
 *     等子代理还没跑完时不算“完成”。
 *
 * 订阅点（对照 DSH 0.2.0-rc.2 的事件目录与实测：waterfall 的 approval/request /
 * user-questions/request 在该版本到不了插件，保留只作冗余与诊断）：
 *   需要授权       session/event 的 approval/asked（主）+ approval/request（waterfall 冗余）
 *   提问/计划审阅  session/event 的 tool/call（ask_user_question）为主，
 *                  turn/end blocked 兜底 + user-questions/request（waterfall 冗余）
 *   完成 / 被中止  session/event 的 turn/end + agent/status
 *   出错           agent/error
 *
 * @module dsh-desktop-notify
 */

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 脚本目录（与本文件同目录）。 */
const HERE = dirname(fileURLToPath(import.meta.url));
/** WinRT Toast + 提示音。 */
const TOAST_SCRIPT = join(HERE, "toast.ps1");
/** 置顶 WPF 浮窗。 */
const ALERT_SCRIPT = join(HERE, "alert.ps1");
/** 前台判定探针（预编译，~40ms；PowerShell 探针要 ~700ms）。 */
const PROBE_EXE = join(HERE, "dsh-notify-probe.exe");
/** DSH 自己的可执行文件名，探针拿它判断「前台是不是 DSH」。 */
const DSH_EXE_NAME = basename(process.execPath);
/** 点击通知后的会话交接文件（由 activate.ps1 写入）。 */
const ACTIVATION_FILE = join(homedir(), ".dsh", "dsh-desktop-notify.activate");
/** 点击后会话 id 的保留时长。 */
const ACTIVATION_TTL_MS = 120000;

/** 客户端上报焦点状态的路由。 */
const FOCUS_PATH = "/dsh-desktop-notify/focus";
/** 客户端长轮询取「该打开哪个会话」的路由。 */
const ACTIVATION_PATH = "/dsh-desktop-notify/activate";
/** 客户端领到 activation 并尝试切换后的回执路由（只留痕）。 */
const ACTIVATED_PATH = "/dsh-desktop-notify/activated";

/** 类别 → 通知标题里的动作词。 */
const LABEL = {
	approval: "需要你授权",
	question: "需要你回答",
	completion: "任务完成",
	failure: "任务出错",
	aborted: "任务被中止"
};

/** 是否需要抢眼（Toast 标 urgent）。 */
const URGENT = { approval: true, question: true, completion: false, failure: true, aborted: true };

/** 浮窗左边条颜色。 */
const ACCENT = {
	approval: "#E0A800",
	question: "#E0A800",
	completion: "#2E7D32",
	failure: "#D9534F",
	aborted: "#D9534F"
};

// 触发门按“对话级焦点”判断，见 shouldNotify()。

/** 默认配置，可由 cordis.patch.yml 的 config 覆盖。 */
const DEFAULTS = {
	enabled: true,
	classes: { approval: true, question: true, completion: true, failure: true, aborted: true },
	// 原生横幅是主通道；自绘卡片兜底（全屏/横幅被压时补位）
	channels: { toast: true, alert: true },
	// 系统横幅开着时，卡片只在前台是全屏时补位；关掉 toast 后卡片就是唯一通道
	alertOnlyWhenFullscreen: true,
	alertSeconds: { approval: 30, question: 30, failure: 25, aborted: 25, completion: 10 },
	// 等你在场的事件（授权/提问）与失败/中止用常驻横幅；完成类自动消失、不打扰
	stickyBlocking: true,
	// 点击通知→唤起窗口并落到对应对话
	clickToFocus: true,
	// 触发门：只提醒“没在看发出通知的那个对话”的情况
	gateOnFocus: true,
	backgroundGraceMs: 45000,
	minTurnMs: 5000,
	dedupeMs: 8000,
	// 等待类（授权/提问）独立去重窗口：session/event 主源、waterfall 冗余源、
	// turn/end blocked 兜底三条路汇进同一个 send()，窗口内只允许弹一条
	waitingDedupeMs: 15000,
	minGapMs: 1500,
	// 回合结束后等待多久确认“真的空闲了”再判定完成。
	// 这是完成类提醒延迟的大头：太短会在排队消息马上续回合时误报
	settleMs: 400,
	// 「正看着被抑制」的复核补发窗口（毫秒）：事件那刻你在看那个对话，窗口内
	// 切走了就补一条。只对等待类（授权/提问）生效，0 = 关闭
	recheckMs: 1800,
	// 宿主侧在场门控：客户端心跳过期/页面没开时，问一次 Windows——前台是 DSH
	// 就安静（用户在应用里，UI 里看得见）。心跳新鲜时仍以客户端的对话级判定为准
	hostPresenceGate: true,
	notifySubagents: false,
	sound: true,
	debug: true
};

/** 日志文件（debug 打开时写入）。 */
const LOG_FILE = join(homedir(), ".dsh", "dsh-desktop-notify.log");

/** 毫秒休眠。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 插件入口。
 * @param ctx - 宿主 cordis 上下文。
 * @param config - 入口 config（cordis.patch.yml）。
 */
export function apply(ctx, config = {}) {
	const cfg = {
		...DEFAULTS,
		...config,
		classes: { ...DEFAULTS.classes, ...(config.classes ?? {}) },
		channels: { ...DEFAULTS.channels, ...(config.channels ?? {}) },
		alertSeconds: { ...DEFAULTS.alertSeconds, ...(config.alertSeconds ?? {}) }
	};
	const subprocess = ctx.get?.("subprocess");
	const isWindows = process.platform === "win32";

	/** 只写一次的日志：用来确认此前从未到达的事件走的是哪一份注册。 */
	const loggedOnce = new Set();
	function logOnce(key, message) {
		if (loggedOnce.has(key)) return;
		loggedOnce.add(key);
		log(message);
	}

	/** 追加一行日志；任何失败都不能影响主流程。 */
	function log(message) {
		if (!cfg.debug) return;
		try {
			mkdirSync(dirname(LOG_FILE), { recursive: true });
			appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`, "utf8");
		} catch {
			/* 日志失败无所谓 */
		}
	}

	log(
		`plugin loaded: windows=${isWindows} subprocess=${subprocess !== undefined} ` +
			`enabled=${cfg.enabled} gate=${cfg.gateOnFocus} click=${cfg.clickToFocus} channels=${JSON.stringify(cfg.channels)}`
	);

	if (!cfg.enabled) return;
	if (!isWindows) {
		log("non-Windows platform: desktop channels disabled (v1)");
		return;
	}
	if (!subprocess) {
		log("subprocess service missing: cannot deliver desktop notifications");
		return;
	}

	/* ------------------------------------------------------------------ */
	/* 状态                                                                */
	/* ------------------------------------------------------------------ */

	/** 各会话最近一次的 agent 状态（'idle' | 'running'）。 */
	const running = new Map();
	/** 各会话本轮 turn 的开始时间。 */
	const turnStart = new Map();
	/** 已确认是子代理 / workflow 子会话的会话 id。 */
	const childSessions = new Set();
	/** 页面焦点状态；at === 0 表示从未上报（页面没开）。 */
	let focusState = { focused: false, sessionId: undefined, at: 0 };
	/** (会话:类别) → 上次提醒时间。 */
	const lastSent = new Map();
	/** 会话 → 最近一次「等待类」（授权/提问）提醒时间，供 turn/end blocked 兜底去重。 */
	const lastWaiting = new Map();
	/** 全局上次发送时间。 */
	let lastGlobal = 0;
	/** 串行化发送，保证最小间隔是真的。 */
	let chain = Promise.resolve();

	/* ------------------------------------------------------------------ */
	/* 环境查询（全部防御式：任何一步失败都不该影响提醒本身）                  */
	/* ------------------------------------------------------------------ */

	/**
	 * 列出当前活着的会话。
	 * 宿主上 `ctx.sessions.list` 的形态不保证是数组，也不是每处都提供
	 * getSnapshot（那是客户端那半边的形态），所以两种都试。
	 * @returns 会话数组；取不到时为空数组。
	 */
	function listSessions() {
		try {
			const service = ctx.get?.("sessions");
			const raw = typeof service?.list === "function" ? service.list() : service?.list;
			const snapshot = typeof raw?.getSnapshot === "function" ? raw.getSnapshot() : raw;
			if (Array.isArray(snapshot)) return snapshot;
			return Object.values(snapshot?.byId ?? {});
		} catch (error) {
			log(`listSessions failed: ${error?.message}`);
			return [];
		}
	}

	/** 取会话标题与工作目录：cwd 在 header 上，title 由 sessionTitle 折叠得来。 */
	function sessionInfo(sessionId) {
		const info = { title: "", cwd: "" };
		try {
			const sessions = listSessions();
			const session = sessions.find((item) => item?.id === sessionId);
			info.cwd = session?.header?.cwd ?? "";
			info.title = ctx.get?.("sessionTitle")?.get?.(session)?.title ?? "";
			if (session === undefined) log(`sessionInfo miss: live sessions=${sessions.length}`);
		} catch (error) {
			log(`sessionInfo failed: ${error?.message}`);
		}
		return info;
	}

	/**
	 * turn/end 的结束原因 → 通知类别。
	 * blocked 不在这里：它在 session/event 处理器里先查等待类去重，再兜底成 question。
	 * @param kind - TurnEndReason.kind。
	 * @returns 类别；null 表示无需提醒。
	 */
	function classOfTurnEnd(kind) {
		switch (kind) {
			case "completed":
				return "completion";
			case "error":
				// 和 agent/error 归到同一类，好让去重把同一件事压成一条
				return "failure";
			case "forked":
				return null;
			default:
				// aborted / interrupted / max-tokens，以及将来新增的异常结束
				return "aborted";
		}
	}

	/** 是否是根会话（非子代理）。 */
	function isRootSession(sessionId) {
		if (childSessions.has(sessionId)) return false;
		try {
			// header 是权威判据：子代理会话带 origin='subagent' 或 parentSession
			const session = listSessions().find((item) => item?.id === sessionId);
			const header = session?.header;
			if (header?.origin === "subagent" || header?.parentSession !== undefined) return false;
			const roots = ctx.agents?.roots?.() ?? [];
			// 根代理列表为空时保守放行：宁可多提醒一次，也不要漏掉主会话。
			if (roots.length === 0) return true;
			return roots.some((agent) => agent?.id === sessionId);
		} catch {
			return true;
		}
	}

	/** 是否还有没跑完的子代理。 */
	async function hasLiveChildren(sessionId) {
		try {
			const subagents = ctx.get?.("subagents");
			if (!subagents?.listChildren) return false;
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 1500);
			try {
				const children = await subagents.listChildren(sessionId, controller.signal);
				return Array.isArray(children) && children.length > 0;
			} finally {
				clearTimeout(timer);
			}
		} catch {
			return false;
		}
	}

	/**
	 * 触发门：现在该不该为这个会话发提醒。
	 *
	 * 规则就是用户说的那条：窗口没聚焦，或聚焦的不是发出通知的那个对话 → 提醒；
	 * 就盯着这个对话 → 安静。
	 * 从未上报或上报已过期都算“没在看”——页面关掉时正是最需要提醒的时候。
	 *
	 * @param sessionId - 发出通知的会话。
	 * @returns 是否应该提醒。
	 */
	function shouldNotify(sessionId) {
		if (!cfg.gateOnFocus) return true;
		const heartbeat = focusState;
		if (heartbeat.at === 0) return true;
		if (Date.now() - heartbeat.at > cfg.backgroundGraceMs) return true;
		if (heartbeat.focused !== true) return true;
		return heartbeat.sessionId !== sessionId;
	}

	/**
	 * 从 waterfall 的 `this`、事件负载、或当前发起者里捞出会话 id。
	 * user-questions/request 的 `agent` 在类型上是可选的，官方客户端实现
	 * 用的就是 `this`，所以三条路都要试。
	 * @param payloadAgent - 负载里的 agent。
	 * @param receiver - 监听器的 this。
	 * @returns 会话 id 或 undefined。
	 */
	function resolveSessionId(payloadAgent, receiver) {
		return (
			payloadAgent?.id ??
			receiver?.id ??
			ctx.get?.("agents")?.currentInitiator?.()?.id ??
			undefined
		);
	}

	/**
	 * 会话事件流里的等待类事件：审批、结构化提问。这是 0.2.0-rc.2 上被证实
	 * 可达的主通道；waterfall 订阅保留作冗余，两条路都汇进 send() 靠去重合并。
	 * approval/asked 的负载里只有会话 id、没有 agent 对象，子代理过滤沿用
	 * isRootSession 的 header.origin 判定。
	 * @param sessionId - 会话 id。
	 * @param event - 会话事件。
	 */
	function handleWaitingEvent(sessionId, event) {
		try {
			if (event?.type === "approval/asked") {
				const data = event.data ?? {};
				const detail = [
					data.toolName ? `工具：${data.toolName}` : "",
					typeof data.reason === "string" ? data.reason : ""
				]
					.filter(Boolean)
					.join("\n");
				send("approval", sessionId, detail);
				return;
			}
			if (event?.type === "tool/call" && event.data?.name === "ask_user_question") {
				send("question", sessionId, describeQuestions(event.data.arguments));
			}
		} catch (error) {
			log(`waiting event handler failed: ${error?.message}`);
		}
	}

	/**
	 * 从 ask_user_question 的 arguments 里取第一题的题干与选项，拼成两行以内的正文，
	 * 让横幅不用点开就能看出「问的是什么」。
	 * @param raw - JSON 字符串或已解析的对象。
	 * @returns 摘要正文；取不到就是空串。
	 */
	function describeQuestions(raw) {
		try {
			const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
			const first = parsed?.questions?.[0];
			if (!first) return "";
			const stem = [first.header, first.question].filter(Boolean).join("：");
			const labels = (Array.isArray(first.options) ? first.options : [])
				.map((option) =>
					typeof option === "string" ? option : (option?.label ?? option?.header ?? "")
				)
				.filter(Boolean)
				.slice(0, 4);
			const lines = [stem, labels.length ? `选项：${labels.join(" / ")}` : ""].filter(Boolean);
			return lines.join("\n").slice(0, 200);
		} catch {
			/* arguments 不是合法 JSON 就不给正文，标题里还有会话名兜底 */
			return "";
		}
	}

	/* ------------------------------------------------------------------ */
	/* 单一通知出口                                                        */
	/* ------------------------------------------------------------------ */

	/** 把发送串起来，保证 minGapMs 生效且不并发炸出多条。 */
	function enqueue(task) {
		chain = chain.then(task).catch((error) => log(`send task failed: ${error?.message}`));
		return chain;
	}

	/**
	 * 起一个脚本：标题/正文写 UTF-8 临时文件（避免中文乱码）后 spawn PowerShell。
	 * 不 await，失败只记日志。
	 * @param script - 脚本绝对路径。
	 * @param extraArgs - 附加参数。
	 * @param headline - 标题。
	 * @param body - 正文。
	 */
	function runScript(script, extraArgs, headline, body, onDone) {
		let dir;
		try {
			dir = mkdtempSync(join(tmpdir(), "dsh-desktop-notify-"));
			const titleFile = join(dir, "title.txt");
			const bodyFile = join(dir, "body.txt");
			writeFileSync(titleFile, headline, "utf8");
			writeFileSync(bodyFile, body, "utf8");
			const handle = subprocess.spawn({
				argv: [
					"powershell.exe",
					"-NoProfile",
					"-NonInteractive",
					// 不要在屏幕上留黑框
					"-WindowStyle",
					"Hidden",
					"-ExecutionPolicy",
					"Bypass",
					"-File",
					script,
					"-TitleFile",
					titleFile,
					"-BodyFile",
					bodyFile,
					...extraArgs
				],
				cwd: dir,
				stdio: {
					stdin: "ignore",
					stdout: { maxBytes: 16384 },
					stderr: { maxBytes: 16384 }
				},
				graceMs: 15000
			});
			const label = script.slice(script.lastIndexOf("\\") + 1);
			handle.done
				.then((outcome) => {
					log(`${label} exit=${outcome?.exitCode}`);
					onDone?.(outcome?.exitCode);
				})
				.catch((error) => {
					log(`${label} spawn failed: ${error?.message}`);
					onDone?.(-1);
				})
				.finally(() => {
					try {
						rmSync(dir, { recursive: true, force: true });
					} catch {
						/* 临时目录清理失败无所谓 */
					}
				});
		} catch (error) {
			log(`runScript failed: ${error?.message}`);
			if (dir) {
				try {
					rmSync(dir, { recursive: true, force: true });
				} catch {
					/* ignore */
				}
			}
		}
	}

	/**
	 * 问一次前台窗口（预编译探针，~40ms）。退出码即裁决：
	 * 0=普通前台，1=全屏，2=DSH 在前台，3=两者；失败按 -1 处理（未知）。
	 * @param onVerdict - 裁决回调（位掩码；-1 = 探针自身失败）。
	 */
	function probeForeground(onVerdict) {
		try {
			const handle = subprocess.spawn({
				argv: [PROBE_EXE, DSH_EXE_NAME],
				// cwd 不能省：subprocess 服务会碰它（缺了直接 spawn failed）
				cwd: HERE,
				stdio: {
					stdin: "ignore",
					stdout: { maxBytes: 1024 },
					stderr: { maxBytes: 1024 }
				},
				graceMs: 3000
			});
			handle.done
				.then((outcome) => {
					const code = outcome?.exitCode;
					onVerdict(code === 0 || code === 1 || code === 2 || code === 3 ? code : -1);
				})
				.catch((error) => {
					log(`foreground probe failed: ${error?.message}`);
					onVerdict(-1);
				});
		} catch (error) {
			log(`foreground probe spawn failed: ${error?.message}`);
			onVerdict(-1);
		}
	}

	/**
	 * 真正的投递：组织文案，再按配置把两个通道各起一次。
	 * @param cls - 事件类别。
	 * @param sessionId - 触发会话。
	 * @param detail - 正文补充（工具名 / 原因 / 提问内容等）。
	 */
	function deliver(cls, sessionId, detail) {
		const info = sessionInfo(sessionId);
		const who = info.title || info.cwd || String(sessionId).slice(0, 8);
		const headline = `${LABEL[cls] ?? "提醒"} · ${who}`;
		const lines = [];
		if (info.title) lines.push(`会话：${info.title}`);
		if (info.cwd) lines.push(`目录：${info.cwd}`);
		if (detail) lines.push(detail);
		const body = lines.join("\n") || "DeepSeek Harness";

		log(`deliver cls=${cls} session=${who} toast=${cfg.channels.toast} alert=${cfg.channels.alert}`);

		/**
		 * 发自绘卡片。
		 * @param onlyFullscreen - true 时脚本自己判断前台是否全屏，不是就退出；
		 *   全屏门控模式用它探路，横幅失败后的兜底必须传 false。
		 * @param playSound - 横幅通道静默时由卡片负责提示音。
		 * @param onDone - 脚本退出码回调（30 = 卡片显示了）。
		 */
		const runCard = (onlyFullscreen, playSound, onDone) => {
			runScript(
				ALERT_SCRIPT,
				[
					"-Kind",
					cls,
					"-Seconds",
					String(cfg.alertSeconds[cls] ?? 15),
					"-Accent",
					ACCENT[cls] ?? "#3B82F6",
					"-Sound",
					playSound ? "1" : "0",
					"-OnlyWhenFullscreen",
					onlyFullscreen ? "1" : "0",
					// 点浮窗本身也能跳回：它直接把会话 id 写进交接文件
					...(sessionId ? ["-SessionId", String(sessionId)] : [])
				],
				headline,
				body,
				onDone
			);
		};

		/** 发系统横幅；彻底失败（连兜底横幅都没出）时补一张必显卡片。 */
		const spawnToast = () => {
			// 等你在场的事件与失败/中止用常驻横幅（scenario=reminder，穿透专注助手）；
			// 完成类用普通通知，自动消失
			const scenario = cfg.stickyBlocking && cls !== "completion" ? "reminder" : "plain";
			runScript(
				TOAST_SCRIPT,
				[
					"-Kind",
					cls,
					"-Sound",
					cfg.sound ? "1" : "0",
					"-Scenario",
					scenario,
					// 点击跳回：告诉 toast 点击后该打开哪个会话
					...(cfg.clickToFocus && sessionId ? ["-SessionId", String(sessionId)] : [])
				],
				headline,
				body,
				(code) => {
					log(`toast tier cls=${cls} exit=${code}`);
					// 0/4/5 都算系统通知成功；彻底失败就补一张不挑前台状态的卡片。
					// 退出码 1 = toast 连横幅都没出，提示音也没放，兜底卡片要补上声音。
					if (code !== 0 && code !== 4 && code !== 5 && cfg.channels.alert) {
						runCard(false, code === 1 && cfg.sound);
					}
				}
			);
		};

		// 双通道 + 全屏门控：宿主先问一次前台（预编译探针 ~40ms），裁决后只发一个
		// 通道——一次提醒只出现一个弹窗（验收 A2），且没有 PowerShell 探针那 ~700ms：
		//   present 位 = 前台是 DSH：心跳已过期/页面没开 → 用户就在应用里，安静；
		//                心跳新鲜则不看这位（对话级判定已在 send() 做过）
		//   fullscreen 位 = 只发卡片（横幅会被系统压掉且不补弹）
		//   其余 = 只发横幅；横幅彻底失败（exit ∉ {0,4,5}）再补必显卡片
		if (cfg.channels.toast && cfg.channels.alert && cfg.alertOnlyWhenFullscreen) {
			probeForeground((verdict) => {
				if (verdict === -1) {
					// 探针自身失败（spawn 不出去等）：横幅照发 + 卡片按脚本自己的
					// 全屏判断补位——非全屏时卡片自会退出，不会双弹；全屏时横幅被压、
					// 卡片顶上。比闷头发横幅（全屏下等于没提醒）强。
					log(`deliver probe cls=${cls} verdict=unknown, falling back to toast+guarded card`);
					spawnToast();
					runCard(true, cfg.sound);
					return;
				}
				const heartbeatStale =
					focusState.at === 0 || Date.now() - focusState.at > cfg.backgroundGraceMs;
				if (verdict & 2 && cfg.hostPresenceGate && cfg.gateOnFocus && heartbeatStale) {
					log(`skip ${cls}: user is at the DSH window (host-side presence probe)`);
					return;
				}
				log(`deliver probe cls=${cls} verdict=${verdict}`);
				if (verdict & 1) {
					// 全屏已由探针判定，卡片直接显示（脚本里的全屏判断自然也成立）
					runCard(false, cfg.sound);
					return;
				}
				spawnToast();
			});
			return;
		}

		// 单通道或“卡片常显”模式：各发各的（后者是用户显式选择的重复）
		if (cfg.channels.alert) runCard(false, !cfg.channels.toast && cfg.sound);
		if (cfg.channels.toast) spawnToast();
	}

	/**
	 * 唯一的提醒入口：类别开关 → 会话过滤 → 后台判定 → 去重 → 限速 → 投递。
	 * @param cls - 事件类别。
	 * @param sessionId - 触发会话。
	 * @param detail - 正文补充。
	 * @param fromRecheck - 来自复核补发的重入；再次被抑制就彻底放弃，不再循环。
	 */
	function send(cls, sessionId, detail = "", fromRecheck = false) {
		if (!cfg.classes[cls]) return;
		if (!sessionId) {
			log(`skip ${cls}: no session id resolved`);
			return;
		}
		if (!cfg.notifySubagents && !isRootSession(sessionId)) {
			log(`skip ${cls}: subagent session`);
			return;
		}
		if (!shouldNotify(sessionId)) {
			log(`skip ${cls}: user is looking at this conversation`);
			scheduleRecheck(cls, sessionId, detail, fromRecheck);
			return;
		}
		enqueue(async () => {
			const now = Date.now();
			// 等待类去重窗口独立配置：三条触发路（session/event 主源、waterfall 冗余、
			// blocked 兜底）汇进同一个 (会话, 类别) 键，窗口内只允许弹一条
			const waiting = cls === "approval" || cls === "question";
			const windowMs = waiting ? cfg.waitingDedupeMs : cfg.dedupeMs;
			const key = `${sessionId}:${cls}`;
			const previous = lastSent.get(key) ?? 0;
			if (now - previous < windowMs) {
				log(`skip ${cls}: deduped`);
				return;
			}
			const gap = Date.now() - lastGlobal;
			if (gap < cfg.minGapMs) await sleep(cfg.minGapMs - gap);
			lastSent.set(key, Date.now());
			lastGlobal = Date.now();
			// blocked 兜底靠这条记录判断「这个会话刚刚已经因为等你说过话了」
			if (waiting) lastWaiting.set(sessionId, Date.now());
			deliver(cls, sessionId, detail);
		});
	}

	/* ------------------------------------------------------------------ */
	/* 事件订阅                                                            */
	/* ------------------------------------------------------------------ */

	/**
	 * 「正看着被抑制」的复核补发：事件那刻你在看那个对话，但窗口内切走了
	 * （瞄了一眼就回去干活）就该补一条——不然这次提醒凭空消失。只对等待类
	 * （授权/提问）生效：完成/出错你已经亲眼看到，事后补是噪音。
	 * 复核再被抑制就彻底放弃（fromRecheck 挡住递归）。
	 * @param cls - 事件类别。
	 * @param sessionId - 触发会话。
	 * @param detail - 正文补充。
	 * @param fromRecheck - 是否已是复核重入。
	 */
	function scheduleRecheck(cls, sessionId, detail, fromRecheck) {
		if (fromRecheck || !cfg.recheckMs) return;
		if (cls !== "approval" && cls !== "question") return;
		setTimeout(() => {
			try {
				if (!shouldNotify(sessionId)) {
					log(`recheck ${cls}: still looking, dropped for good`);
					return;
				}
				log(`recheck ${cls}: user switched away, reminding now`);
				send(cls, sessionId, detail, true);
			} catch (error) {
				log(`recheck ${cls} failed: ${error?.message}`);
			}
		}, cfg.recheckMs);
	}

	/**
	 * 需要授权：waterfall，必须透明穿过 next()，绝不替用户决定。
	 * @param request - 审批请求。
	 * @param receiver - 监听器的 this（scoped agent）。
	 * @param next - waterfall 的下一环。
	 * @param via - 注册来源，用来确认哪一份注册真的收到了事件。
	 * @returns next() 的结果。
	 */
	function handleApproval(request, receiver, next, via) {
		try {
			logOnce(`approval-via-${via}`, `approval event reached the ${via} registration`);
			const sessionId = resolveSessionId(request?.agent, receiver);
			const detail = [
				request?.toolName ? `工具：${request.toolName}` : "",
				request?.reason ?? request?.displayReason?.zh ?? request?.displayReason?.en ?? ""
			]
				.filter(Boolean)
				.join("\n");
			send("approval", sessionId, detail);
		} catch (error) {
			log(`approval handler failed: ${error?.message}`);
		}
		return next();
	}

	/**
	 * 提问 / 计划审阅：waterfall，必须透明穿过 next()。
	 * @param request - 提问请求。
	 * @param receiver - 监听器的 this（scoped agent）。
	 * @param next - waterfall 的下一环。
	 * @param via - 注册来源。
	 * @returns next() 的结果。
	 */
	function handleQuestion(request, receiver, next, via) {
		try {
			logOnce(`question-via-${via}`, `question event reached the ${via} registration`);
			const sessionId = resolveSessionId(request?.agent, receiver);
			const first = request?.questions?.[0];
			const isPlan = first?.intent?.kind === "plan-review";
			const detail = [isPlan ? "计划审阅" : "", first?.header ?? "", first?.question ?? ""]
				.filter(Boolean)
				.join("\n");
			send("question", sessionId, detail);
		} catch (error) {
			log(`question handler failed: ${error?.message}`);
		}
		return next();
	}

	// prepend 是关键：官方转发器先注册、拿到答案后不调 next()，普通注册永远
	// 排不到我们（这就是 10-01 调研里「waterfall 收不到」的根因，dsh-donevoice
	// 的 ARCHITECTURE.md 点破）。插到最前面我们才能观测到；观测后无条件 next()，
	// 决不卡审批。
	ctx.on(
		"approval/request",
		function (request, next) {
			return handleApproval(request, this, next, "root");
		},
		{ prepend: true }
	);
	ctx.on(
		"user-questions/request",
		function (request, next) {
			return handleQuestion(request, this, next, "root");
		},
		{ prepend: true }
	);

	// 这两个是 waterfall 事件，派发时带 scopeTarget(agent, agent)：根上下文的监听器
	// 会被派发基座的 filter 筛掉（emit 事件没这个问题，所以完成/出错一直正常，而
	// 授权/提问一次都没进来）。因此再在每个 agent 的 scoped ctx 上挂一份——两份都挂，
	// 谁收到算谁的，并各自留痕。
	ctx.on("agent/created", function (payload) {
		const scoped = payload?.agent?.ctx;
		if (!scoped || typeof scoped.on !== "function") {
			log("agent/created: agent.ctx missing, scoped waterfall listeners not installed");
			return;
		}
		ctx.effect(() => {
			const offApproval = scoped.on(
				"approval/request",
				function (request, next) {
					return handleApproval(request, this, next, "scope");
				},
				{ prepend: true }
			);
			const offQuestion = scoped.on(
				"user-questions/request",
				function (request, next) {
					return handleQuestion(request, this, next, "scope");
				},
				{ prepend: true }
			);
			return () => {
				try {
					offApproval?.();
				} catch {
					/* already released */
				}
				try {
					offQuestion?.();
				} catch {
					/* already released */
				}
			};
		}, "dsh-desktop-notify: scoped waterfall listeners");
	});

	/** 会话事件流：turn/start 记起点，turn/end 判定完成或被中止。 */
	ctx.on("session/event", (session, event) => {
		try {
			const sessionId = session?.id ?? session?.header?.id;
			if (!sessionId || !event) return;
			// 子代理 / workflow 子会话会在自己的日志里写 subagent/* 事件，据此排除
			if (typeof event.type === "string" && event.type.startsWith("subagent/")) {
				childSessions.add(sessionId);
				return;
			}
			if (event.type === "turn/start") {
				turnStart.set(sessionId, Date.now());
				return;
			}
			// 审批与结构化提问从这条流里识别（主通道）；turn/end 单独处理
			if (event.type !== "turn/end") {
				handleWaitingEvent(sessionId, event);
				return;
			}

			const started = turnStart.get(sessionId) ?? 0;
			turnStart.delete(sessionId);
			const duration = started > 0 ? Date.now() - started : Number.POSITIVE_INFINITY;

			const reason = event?.data?.reason;
			const kind =
				typeof reason === "string"
					? reason
					: typeof reason?.kind === "string"
						? reason.kind
						: "completed";

			// blocked 兜底：正常情况下 approval/asked 或 ask_user_question 已经提醒过，
			// 查等待类记录去重；真没报过（比如那条路也哑了）才补一条「回合在等你回话」
			if (kind === "blocked") {
				const since = Date.now() - (lastWaiting.get(sessionId) ?? 0);
				if (since < cfg.waitingDedupeMs) {
					log(`skip blocked: waiting reminder sent ${Math.round(since / 1000)}s ago`);
					return;
				}
				log(`blocked fallback: no waiting reminder in the last ${cfg.waitingDedupeMs}ms`);
				scheduleSettle(sessionId, "question", {
					kind,
					duration,
					reason,
					detail: "回合在等你回话"
				});
				return;
			}

			const cls = classOfTurnEnd(kind);
			if (cls === null) {
				log(`skip ${kind}: nothing to notify`);
				return;
			}
			if (cls === "completion" && duration < cfg.minTurnMs) {
				log(`skip completion: turn too short (${Math.round(duration)}ms)`);
				return;
			}
			scheduleSettle(sessionId, cls, { kind, duration, reason });
		} catch (error) {
			log(`session/event handler failed: ${error?.message}`);
		}
	});

	/** 出错。 */
	ctx.on("agent/error", (payload) => {
		try {
			const message =
				payload?.error instanceof Error
					? payload.error.message
					: typeof payload?.error === "string"
						? payload.error
						: "agent step or turn errored";
			send("failure", payload?.agent?.id, String(message).slice(0, 300));
		} catch (error) {
			log(`agent/error handler failed: ${error?.message}`);
		}
	});

	/** 跟踪 agent 空闲/运行，用于确认“真的结束了”。 */
	ctx.on("agent/status", (payload) => {
		try {
			const sessionId = payload?.agent?.id;
			if (sessionId) running.set(sessionId, payload.status);
		} catch {
			/* ignore */
		}
	});

	/**
	 * 回合结束后先等一会儿再判定完成：期间 agent 可能又起来了（排队消息、
	 * 让出回合去等子代理），也可能还有子代理在跑。多次复检都不行就放弃。
	 * @param sessionId - 会话。
	 * @param cls - completion 或 aborted。
	 * @param info - 结束原因与耗时。
	 */
	function scheduleSettle(sessionId, cls, info) {
		let detail = typeof info?.detail === "string" ? info.detail : "";
		if (!detail && cls === "aborted") {
			const cause = info?.reason?.reason?.kind;
			detail = `结束原因：${info.kind}${cause === "user" ? "（你手动停止）" : ""}`;
		} else if (!detail && cls === "completion" && info.duration !== Number.POSITIVE_INFINITY) {
			detail = `耗时：${Math.round(info.duration / 1000)} 秒`;
		}
		const attempt = async (round) => {
			if (round > 0) await sleep(2000);
			if (running.get(sessionId) === "running") {
				log(`skip ${cls}: session busy again`);
				return;
			}
			if (await hasLiveChildren(sessionId)) {
				if (round < 2) {
					await attempt(round + 1);
					return;
				}
				log(`skip ${cls}: subagent children still live`);
				return;
			}
			send(cls, sessionId, detail);
		};
		setTimeout(() => {
			attempt(0).catch((error) => log(`settle failed: ${error?.message}`));
		}, cfg.settleMs);
	}

	/* ------------------------------------------------------------------ */
	/* 焦点上报路由                                                        */
	/* ------------------------------------------------------------------ */

	/**
	 * 本地路由护栏：Host 必须是回环地址；请求带了 Origin 时必须同源同端口。
	 * 防两类滥用：浏览器里任意网页伪造焦点上报/触发唤起（跨源 POST 会带
	 * Origin，直接挡掉）；DNS 重绑定（Host 变成外部域名，挡掉）。
	 * 没带 Origin 的本地客户端（curl / 激活器 / 离线验证）照常放行。
	 * @param req - 请求。
	 * @returns 是否放行。
	 */
	function routeGuardOk(req) {
		try {
			const headers = req.headers ?? {};
			const host = String(headers.host ?? "");
			const hostname = host.replace(/:\d+$/, "").toLowerCase();
			if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname)) return false;
			const origin = headers.origin ? String(headers.origin) : "";
			if (origin) {
				const url = new URL(origin);
				if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname.toLowerCase())) {
					return false;
				}
				const originPort = url.port || (url.protocol === "https:" ? "443" : "80");
				const hostPort = host.includes(":") ? host.slice(host.lastIndexOf(":") + 1) : "80";
				if (originPort !== hostPort) return false;
			}
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * 读掉一个 POST 的 JSON 体（限 4KB）再回 204；坏负载按 null 回调。
	 * focus 与 activated 两个路由共用。
	 * @param req - 请求。
	 * @param res - 响应。
	 * @param onBody - 解析结果回调。
	 */
	function readJsonBody(req, res, onBody) {
		let raw = "";
		req.on("data", (chunk) => {
			raw += chunk;
			if (raw.length > 4096) req.destroy();
		});
		req.on("end", () => {
			let parsed = null;
			try {
				parsed = JSON.parse(raw);
			} catch {
				/* 坏负载忽略 */
			}
			try {
				onBody(parsed);
			} catch (error) {
				log(`route body handler failed: ${error?.message}`);
			}
			try {
				res.writeHead(204);
				res.end();
			} catch {
				/* ignore */
			}
		});
	}

	const webServer = ctx.get?.("webServer");
	if (webServer?.register) {
		ctx.effect(
			() =>
				webServer.register({
					kind: "exact",
					path: FOCUS_PATH,
					handler: (req, res) => {
						if (!routeGuardOk(req)) {
							log(`route rejected on ${FOCUS_PATH}: host=${req.headers?.host} origin=${req.headers?.origin ?? "-"}`);
							res.writeHead(403);
							res.end();
							return;
						}
						if (req.method !== "POST") {
							res.writeHead(405);
							res.end();
							return;
						}
						readJsonBody(req, res, (parsed) => {
							focusState = {
								focused: parsed?.focused === true,
								sessionId:
									typeof parsed?.sessionId === "string" ? parsed.sessionId : undefined,
								at: Date.now()
							};
						});
					}
				}),
			"dsh-desktop-notify: focus route"
		);
	} else {
		log("webServer missing: focus reporting disabled, background gate always passes");
	}

	/* ------------------------------------------------------------------ */
	/* 点击通知 → 唤起窗口并落到对应对话                                     */
	/* ------------------------------------------------------------------ */

	/** 待处理的点击唤起；客户端长轮询把它取走。 */
	let pendingActivation = null;
	/** 正在等待的客户端响应回调。 */
	const activationWaiters = new Set();

	/** 取走并清空待处理项。 */
	function claimActivation() {
		const current = pendingActivation;
		pendingActivation = null;
		return current;
	}

	/**
	 * 发布一次点击唤起：唤醒所有长轮询的客户端。
	 * @param sessionId - 要打开的会话。
	 */
	function publishActivation(sessionId) {
		pendingActivation = { sessionId, at: Date.now() };
		log(`activation published: session=${String(sessionId).slice(0, 16)}`);
		for (const wake of [...activationWaiters]) {
			activationWaiters.delete(wake);
			try {
				wake();
			} catch {
				/* ignore */
			}
		}
	}

	if (cfg.clickToFocus && webServer?.register) {
		// activate.ps1 把会话 id 写进文件；这里轮询取走，不依赖端口
		ctx.effect(() => {
			const timer = setInterval(() => {
				try {
					const raw = readFileSync(ACTIVATION_FILE, "utf8");
					rmSync(ACTIVATION_FILE, { force: true });
					const lines = raw
						.split(/\r?\n/)
						.map((line) => line.replace(/^\uFEFF/, "").trim())
						.filter(Boolean);
					const last = lines[lines.length - 1];
					if (last) publishActivation(last);
				} catch {
					/* 文件不存在就是没有点击 */
				}
			}, 1000);
			return () => clearInterval(timer);
		}, "dsh-desktop-notify: activation watcher");

		ctx.effect(
			() =>
				webServer.register({
					kind: "exact",
					path: ACTIVATION_PATH,
					handler: (req, res) => {
						if (!routeGuardOk(req)) {
							log(`route rejected on ${ACTIVATION_PATH}: host=${req.headers?.host} origin=${req.headers?.origin ?? "-"}`);
							res.writeHead(403);
							res.end();
							return;
						}
						const finish = () => {
							if (res.writableEnded) return;
							const claimed = claimActivation();
							const fresh =
								claimed && Date.now() - claimed.at < ACTIVATION_TTL_MS ? claimed : null;
							res.writeHead(200, {
								"content-type": "application/json",
								"cache-control": "no-store"
							});
							res.end(JSON.stringify({ sessionId: fresh?.sessionId ?? null }));
						};
						if (pendingActivation !== null) {
							finish();
							return;
						}
						// 长轮询：有点击就立刻回，没有就挂 25 秒
						const wake = () => finish();
						activationWaiters.add(wake);
						const timer = setTimeout(() => {
							activationWaiters.delete(wake);
							finish();
						}, 25000);
						req.on("close", () => {
							clearTimeout(timer);
							activationWaiters.delete(wake);
						});
					}
				}),
			"dsh-desktop-notify: activation route"
		);

		// 客户端领到 activation、尝试切换会话后的回执：只写日志对账，
		// 让「点击了但没切过去」这类问题能看出客户端到底有没有参与
		ctx.effect(
			() =>
				webServer.register({
					kind: "exact",
					path: ACTIVATED_PATH,
					handler: (req, res) => {
						if (!routeGuardOk(req)) {
							log(`route rejected on ${ACTIVATED_PATH}: host=${req.headers?.host} origin=${req.headers?.origin ?? "-"}`);
							res.writeHead(403);
							res.end();
							return;
						}
						if (req.method !== "POST") {
							res.writeHead(405);
							res.end();
							return;
						}
						readJsonBody(req, res, (parsed) => {
							log(
								`activation claimed by client: session=${String(parsed?.sessionId ?? "?").slice(0, 16)} opened=${parsed?.opened === true}`
							);
						});
					}
				}),
			"dsh-desktop-notify: activated route"
		);
	}
}

export const name = "desktop-notify";
export const inject = ["subprocess", "webServer"];

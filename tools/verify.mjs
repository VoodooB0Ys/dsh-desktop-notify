#!/usr/bin/env node
/**
 * dsh-desktop-notify 离线验证：把真实的 lib/host.js 装进最小 cordis 宿主，
 * 用桩 subprocess 记录它到底 spawn 了哪些脚本、参数与文案是什么，桩 webServer
 * 记录注册的路由，然后逐条断言「该弹的弹了、不该弹的没弹」。
 *
 * 覆盖：焦点门控、子代理过滤、(会话,类别) 去重、等待类独立去重窗口、
 * approval/asked 主通道、ask_user_question 文案、turn/end blocked 兜底与去重、
 * 完成判定、waterfall 冗余通道、双通道投递参数、点击交接链路。
 *
 * 用法：node tools/verify.mjs   （或 npm run verify）
 * 全绿退出 0；任何一条失败退出 1。不需要 Windows 以外的任何依赖；
 * Windows 上也不会真的弹窗（subprocess 是桩）。
 */

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(HERE);

// 假 home 必须在 import host.js 之前生效：ACTIVATION_FILE / LOG_FILE 是模块级常量
const fakeHome = mkdtempSync(join(tmpdir(), "dsh-notify-verify-"));
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;

const { Context } = await import("@deepseek-ai/cordis");
const plugin = await import(pathToFileURL(join(PLUGIN_ROOT, "lib", "host.js")).href);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* -------------------------------------------------------------------- */
/* 断言与统计                                                            */
/* -------------------------------------------------------------------- */

let passed = 0;
const failures = [];

function assert(condition, name) {
	if (condition) {
		passed += 1;
		console.log(`  ok   ${name}`);
	} else {
		failures.push(name);
		console.log(`  FAIL ${name}`);
	}
}

/** 断言指定脚本被 spawn 了 n 次，返回该脚本的 spawn 记录。 */
function assertSpawns(records, scriptName, n, name) {
	const list = records.filter((record) => record.script.endsWith(scriptName));
	assert(list.length === n, `${name}（实际 ${list.length} 次，期望 ${n} 次）`);
	return list;
}

/* -------------------------------------------------------------------- */
/* 桩                                                                    */
/* -------------------------------------------------------------------- */

/**
 * spawn 桩：记下 argv，并趁临时文件还在时把标题/正文读进记录。
 * @param {object[]} spawned - 记录数组。
 * @param {object} [exitCodes] - 按脚本/探针名尾巴定的退出码，默认
 *   toast.ps1 → 0（成功）、alert.ps1 → 30（已显示）、探针 → 0（普通前台）。
 */
function makeSpawnRecorder(spawned, exitCodes = {}) {
	return {
		spawn(options) {
			const argv = options.argv;
			const index = argv.indexOf("-File");
			const script = index >= 0 ? argv[index + 1] : argv[0] ?? "?";
			const arg = (flag) => {
				const at = argv.indexOf(flag);
				return at >= 0 ? argv[at + 1] : undefined;
			};
			let title = "";
			let body = "";
			try {
				title = readFileSync(arg("-TitleFile"), "utf8");
				body = readFileSync(arg("-BodyFile"), "utf8");
			} catch {
				/* 读不到就留空（探针没有这些参数） */
			}
			spawned.push({ script, argv, arg, title, body });
			// 拖一小会儿，模拟真实子进程耗时（文件内容已在上面读走）
			const base = script.endsWith("alert.ps1")
				? (exitCodes["alert.ps1"] ?? 30)
				: script.endsWith("dsh-notify-probe.exe")
					? (exitCodes["probe"] ?? 0)
					: (exitCodes["toast.ps1"] ?? 0);
			return { done: sleep(20).then(() => ({ exitCode: base })) };
		}
	};
}

/** webServer 桩：记录 exact 路由，便于直接调用 handler。 */
function makeWebServer(routes) {
	return {
		register(route) {
			routes.set(route.path, route);
			return () => routes.delete(route.path);
		}
	};
}

function fakeReq(method, body, headers = {}) {
	const req = new EventEmitter();
	req.method = method;
	req.headers = { host: "127.0.0.1:19387", ...headers };
	req.destroy = () => {};
	queueMicrotask(() => {
		if (body !== undefined) req.emit("data", body);
		req.emit("end");
	});
	return req;
}

function fakeRes() {
	return {
		statusCode: null,
		body: "",
		writeHead(code) {
			this.statusCode = code;
			return this;
		},
		end(chunk) {
			if (chunk) this.body += chunk;
		}
	};
}

/**
 * 建一个装好真实插件的宿主。
 * @param {object} [overrides] - overrides.config 覆盖测试配置；overrides.spawn
 *   换掉 spawn 桩；overrides.sessions 提供会话行。
 * @returns {{ ctx: object, spawned: object[], routes: Map, post: Function }}
 */
async function makeHost(overrides = {}) {
	const ctx = new Context();
	const spawned = [];
	const routes = new Map();
	ctx.provide("subprocess", overrides.spawn ?? makeSpawnRecorder(spawned, overrides.exitCodes));
	ctx.provide("webServer", makeWebServer(routes));
	ctx.provide("sessions", { list: overrides.sessions ?? [] });
	ctx.provide("sessionTitle", { get: (session) => ({ title: `标题-${session?.id ?? "?"}` }) });
	// 配置必须显式传：apply(ctx, config) 的第二参只有这样才到得了
	const fiber = ctx.plugin(plugin.default ?? plugin, { ...FAST, ...overrides.config });
	await fiber;
	liveHosts.push(fiber);
	/** 直接调用已注册的路由（POST JSON）；headers 可伪造 Origin 测护栏。 */
	const post = async (path, payload, headers = {}) => {
		const route = routes.get(path);
		if (!route) throw new Error(`route not registered: ${path}`);
		const res = fakeRes();
		route.handler(fakeReq("POST", JSON.stringify(payload), headers), res);
		await sleep(5);
		return res;
	};
	return { ctx, spawned, routes, post };
}

/**
 * 所有场景创建的插件 fiber。场景结束后统一 dispose：否则上一轮宿主的
 * 1 秒交接文件轮询还活着，会把下一轮场景刚写好的交接文件抢走。
 */
const liveHosts = [];

async function teardownHosts() {
	for (const fiber of liveHosts.splice(0)) {
		try {
			await fiber.dispose();
		} catch (error) {
			/* 释放失败不影响断言 */
		}
	}
}

/** 测试用的快配置：所有等待都缩到毫秒级。 */
const FAST = {
	settleMs: 5,
	minTurnMs: 0,
	dedupeMs: 40,
	waitingDedupeMs: 150,
	minGapMs: 0,
	backgroundGraceMs: 60000,
	recheckMs: 80,
	debug: false
};

const rowOf = (id, extraHeader = {}) => ({ id, header: { cwd: `D:\\proj\\${id}`, ...extraHeader } });

/* -------------------------------------------------------------------- */
/* 场景                                                                  */
/* -------------------------------------------------------------------- */

async function scenarioFocusGate() {
	console.log("\n[scenario] 焦点门控");
	// 「正在看该对话」→ 静默（send() 在投递前就拦下，探针都不该起）
	{
		const host = await makeHost({
			config: FAST,
			sessions: [rowOf("s-look")]
		});
		await host.post("/dsh-desktop-notify/focus", { focused: true, sessionId: "s-look" });
		host.ctx.emit("session/event", { id: "s-look" }, { type: "turn/start" });
		host.ctx.emit("session/event", { id: "s-look" }, {
			type: "turn/end",
			data: { turn: 1, reason: { kind: "completed" } }
		});
		await sleep(150);
		assertSpawns(host.spawned, "toast.ps1", 0, "正在看该对话 → 横幅不弹");
		assertSpawns(host.spawned, "alert.ps1", 0, "正在看该对话 → 卡片不弹");
		assertSpawns(host.spawned, "dsh-notify-probe.exe", 0, "正在看该对话 → 连探针都不起");
	}
	// 没在看（从未上报）→ 探针判普通前台 → 发横幅
	{
		const host = await makeHost({ config: FAST, sessions: [rowOf("s-open")] });
		host.ctx.emit("session/event", { id: "s-open" }, { type: "turn/start" });
		host.ctx.emit("session/event", { id: "s-open" }, {
			type: "turn/end",
			data: { turn: 1, reason: { kind: "completed" } }
		});
		await sleep(180);
		assertSpawns(host.spawned, "dsh-notify-probe.exe", 1, "投递前先问一次前台");
		assertSpawns(host.spawned, "toast.ps1", 1, "探针判普通前台 → 发横幅");
		assertSpawns(host.spawned, "alert.ps1", 0, "普通前台 → 不发卡片");
	}
}

async function scenarioProbeVerdicts() {
	console.log("\n[scenario] 探针裁决");
	// 全屏 → 只发卡片
	{
		const host = await makeHost({
			config: FAST,
			sessions: [rowOf("s-full")],
			exitCodes: { probe: 1 }
		});
		host.ctx.emit("session/event", { id: "s-full" }, { type: "turn/start" });
		host.ctx.emit("session/event", { id: "s-full" }, {
			type: "turn/end",
			data: { turn: 1, reason: { kind: "completed" } }
		});
		await sleep(180);
		const cards = assertSpawns(host.spawned, "alert.ps1", 1, "探针判全屏 → 只发卡片");
		assertSpawns(host.spawned, "toast.ps1", 0, "探针判全屏 → 不发横幅");
		if (cards.length === 1) {
			assert(cards[0].arg("-OnlyWhenFullscreen") === "0", "全屏已由探针判定，卡片直接显示");
			assert(cards[0].arg("-Sound") === "1", "卡片是唯一弹窗，提示音归它");
		}
	}
	// DSH 在前台 + 心跳过期（页面没开）→ 宿主侧在场门控静默
	{
		const host = await makeHost({
			config: FAST,
			sessions: [rowOf("s-pres")],
			exitCodes: { probe: 2 }
		});
		host.ctx.emit("session/event", { id: "s-pres" }, { type: "turn/start" });
		host.ctx.emit("session/event", { id: "s-pres" }, {
			type: "turn/end",
			data: { turn: 1, reason: { kind: "completed" } }
		});
		await sleep(180);
		assertSpawns(host.spawned, "toast.ps1", 0, "前台是 DSH 且心跳过期 → 静默");
		assertSpawns(host.spawned, "alert.ps1", 0, "在场门控 → 卡片也不发");
	}
	// DSH 在前台但心跳新鲜、看的是别的对话 → 照常提醒
	{
		const host = await makeHost({
			config: FAST,
			sessions: [rowOf("s-other"), rowOf("s-fresh")],
			exitCodes: { probe: 2 }
		});
		await host.post("/dsh-desktop-notify/focus", { focused: true, sessionId: "s-other" });
		host.ctx.emit("session/event", { id: "s-fresh" }, { type: "turn/start" });
		host.ctx.emit("session/event", { id: "s-fresh" }, {
			type: "turn/end",
			data: { turn: 1, reason: { kind: "completed" } }
		});
		await sleep(180);
		assertSpawns(host.spawned, "toast.ps1", 1, "DSH 在前台但在看别的对话 → 照常提醒");
	}
	// 探针自身失败（exit 99）→ 横幅照发 + 卡片按脚本自判全屏补位（不许闷头哑掉）
	{
		const host = await makeHost({
			config: FAST,
			sessions: [rowOf("s-unk")],
			exitCodes: { probe: 99 }
		});
		host.ctx.emit("session/event", { id: "s-unk" }, { type: "turn/start" });
		host.ctx.emit("session/event", { id: "s-unk" }, {
			type: "turn/end",
			data: { turn: 1, reason: { kind: "completed" } }
		});
		await sleep(200);
		assertSpawns(host.spawned, "toast.ps1", 1, "探针失败 → 横幅照发");
		const cards = assertSpawns(host.spawned, "alert.ps1", 1, "探针失败 → 卡片自判全屏补位");
		if (cards.length === 1) assert(cards[0].arg("-OnlyWhenFullscreen") === "1", "补位卡片带全屏门（非全屏自会退出）");
	}
}

async function scenarioRecheck() {
	console.log("\n[scenario] 切走复核补发");
	// 事件那刻正看着 → 抑制；窗口内切走 → 补发
	{
		const host = await makeHost({
			config: FAST,
			sessions: [rowOf("s-recheck")]
		});
		await host.post("/dsh-desktop-notify/focus", { focused: true, sessionId: "s-recheck" });
		host.ctx.emit("session/event", { id: "s-recheck" }, {
			type: "approval/asked",
			data: { id: "apr-r", toolName: "bash" }
		});
		await sleep(60);
		assertSpawns(host.spawned, "toast.ps1", 0, "正看着 → 先抑制");
		// 切走
		await host.post("/dsh-desktop-notify/focus", { focused: false, sessionId: "s-recheck" });
		await sleep(200);
		const toasts = assertSpawns(host.spawned, "toast.ps1", 1, "窗口内切走 → 复核补发");
		if (toasts.length === 1) assert(toasts[0].body.includes("bash"), "补发正文带工具名");
	}
	// 一直看着 → 复核后彻底放弃（不循环）
	{
		const host = await makeHost({
			config: FAST,
			sessions: [rowOf("s-stay")]
		});
		await host.post("/dsh-desktop-notify/focus", { focused: true, sessionId: "s-stay" });
		host.ctx.emit("session/event", { id: "s-stay" }, {
			type: "approval/asked",
			data: { id: "apr-s", toolName: "write" }
		});
		await sleep(300);
		assertSpawns(host.spawned, "toast.ps1", 0, "一直看着 → 复核后放弃");
	}
	// 完成类不复核（已经亲眼看到了）
	{
		const host = await makeHost({
			config: FAST,
			sessions: [rowOf("s-done-re")]
		});
		await host.post("/dsh-desktop-notify/focus", { focused: true, sessionId: "s-done-re" });
		host.ctx.emit("session/event", { id: "s-done-re" }, { type: "turn/start" });
		host.ctx.emit("session/event", { id: "s-done-re" }, {
			type: "turn/end",
			data: { turn: 1, reason: { kind: "completed" } }
		});
		await sleep(300);
		assertSpawns(host.spawned, "toast.ps1", 0, "完成类被抑制后不补发");
	}
}

async function scenarioRouteGuard() {
	console.log("\n[scenario] 路由同源护栏");
	const host = await makeHost({ config: FAST, sessions: [rowOf("s-guard")] });
	const evil = await host.post(
		"/dsh-desktop-notify/focus",
		{ focused: true, sessionId: "s-guard" },
		{ origin: "https://evil.example" }
	);
	assert(evil.statusCode === 403, "跨源 Origin → 403");
	const rebinding = await host.post(
		"/dsh-desktop-notify/focus",
		{ focused: true, sessionId: "s-guard" },
		{ host: "attacker.example:19387", origin: "http://attacker.example:19387" }
	);
	assert(rebinding.statusCode === 403, "非回环 Host（DNS 重绑定）→ 403");
	const otherPort = await host.post(
		"/dsh-desktop-notify/focus",
		{ focused: true, sessionId: "s-guard" },
		{ host: "127.0.0.1:19387", origin: "http://127.0.0.1:9999" }
	);
	assert(otherPort.statusCode === 403, "回环但端口不同源（别的本地服务页面）→ 403");
	const ok = await host.post("/dsh-desktop-notify/focus", { focused: false, sessionId: "s-guard" });
	assert(ok.statusCode === 204, "同源（含无 Origin 的本地客户端）→ 204");
	// 护栏挡掉的那几次不能污染焦点状态：随后的事件应正常提醒
	host.ctx.emit("session/event", { id: "s-guard" }, { type: "turn/start" });
	host.ctx.emit("session/event", { id: "s-guard" }, {
		type: "turn/end",
		data: { turn: 1, reason: { kind: "completed" } }
	});
	await sleep(180);
	assertSpawns(host.spawned, "toast.ps1", 1, "被拒请求未污染焦点状态");
}

async function scenarioSubagentFilter() {
	console.log("\n[scenario] 子代理过滤");
	const host = await makeHost({
		config: FAST,
		sessions: [rowOf("s-child", { origin: "subagent" })]
	});
	host.ctx.emit("session/event", { id: "s-child" }, {
		type: "turn/end",
		data: { turn: 1, reason: { kind: "completed" } }
	});
	await sleep(150);
	assertSpawns(host.spawned, "toast.ps1", 0, "origin=subagent → 不弹");
}

async function scenarioApprovalAsked() {
	console.log("\n[scenario] approval/asked 主通道");
	const host = await makeHost({ config: FAST, sessions: [rowOf("s-approval")] });
	host.ctx.emit("session/event", { id: "s-approval" }, {
		type: "approval/asked",
		data: { id: "apr-1", toolName: "pwsh", reason: "需要执行命令" }
	});
	await sleep(180);
	const toasts = assertSpawns(host.spawned, "toast.ps1", 1, "审批事件 → 弹一条");
	if (toasts.length === 1) {
		assert(toasts[0].arg("-Scenario") === "reminder", "审批横幅用常驻 reminder");
		assert(toasts[0].arg("-SessionId") === "s-approval", "横幅带上会话 id（点击跳回）");
		assert(toasts[0].body.includes("pwsh") && toasts[0].body.includes("需要执行命令"), "正文含工具名与原因");
	}
}

async function scenarioAskUserQuestion() {
	console.log("\n[scenario] ask_user_question 文案");
	const host = await makeHost({ config: FAST, sessions: [rowOf("s-ask")] });
	const args = JSON.stringify({
		questions: [
			{
				header: "范围",
				question: "这一轮先做哪几项？",
				options: [
					{ label: "只做触发源" },
					{ label: "触发源+投递" },
					{ label: "全部" }
				]
			}
		]
	});
	host.ctx.emit("session/event", { id: "s-ask" }, {
		type: "tool/call",
		data: { turn: 1, step: 1, callId: "c1", name: "ask_user_question", arguments: args }
	});
	await sleep(180);
	const toasts = assertSpawns(host.spawned, "toast.ps1", 1, "ask_user_question → 弹一条");
	if (toasts.length === 1) {
		assert(toasts[0].body.includes("范围") && toasts[0].body.includes("这一轮先做哪几项？"), "正文含题干");
		assert(toasts[0].body.includes("只做触发源") && toasts[0].body.includes("全部"), "正文含选项摘要");
	}
}

async function scenarioBlockedFallback() {
	console.log("\n[scenario] turn/end blocked 兜底");
	// 没有等待类提醒过 → 补一条「等你回话」
	{
		const host = await makeHost({ config: FAST, sessions: [rowOf("s-block")] });
		host.ctx.emit("session/event", { id: "s-block" }, { type: "turn/start" });
		host.ctx.emit("session/event", { id: "s-block" }, {
			type: "turn/end",
			data: { turn: 1, reason: { kind: "blocked" } }
		});
		await sleep(180);
		const toasts = assertSpawns(host.spawned, "toast.ps1", 1, "无前置提醒 → blocked 补一条 question");
		if (toasts.length === 1) assert(toasts[0].body.includes("回合在等你回话"), "兜底正文说明在等你回话");
	}
	// 已因 approval 提醒过 → 不重复（窗口放大到 5s，测试里两次事件相隔 ~150ms）
	{
		const host = await makeHost({
			config: { ...FAST, waitingDedupeMs: 5000 },
			sessions: [rowOf("s-both")]
		});
		host.ctx.emit("session/event", { id: "s-both" }, {
			type: "approval/asked",
			data: { id: "apr-2", toolName: "write" }
		});
		await sleep(180);
		host.ctx.emit("session/event", { id: "s-both" }, {
			type: "turn/end",
			data: { turn: 1, reason: { kind: "blocked" } }
		});
		await sleep(180);
		assertSpawns(host.spawned, "toast.ps1", 1, "审批已提醒过 → blocked 不重复");
	}
}

async function scenarioCompletionAndDedupe() {
	console.log("\n[scenario] 完成判定与去重");
	const host = await makeHost({ config: FAST, sessions: [rowOf("s-done")] });
	host.ctx.emit("session/event", { id: "s-done" }, { type: "turn/start" });
	host.ctx.emit("session/event", { id: "s-done" }, {
		type: "turn/end",
		data: { turn: 1, reason: { kind: "completed" } }
	});
	await sleep(180);
	const toasts = assertSpawns(host.spawned, "toast.ps1", 1, "完成 → 弹一条");
	if (toasts.length === 1) {
		assert(toasts[0].arg("-Scenario") === "plain", "完成横幅是短提示 plain");
		assert(toasts[0].body.includes("标题-s-done"), "正文带会话标题");
	}
	// forked 不提醒
	host.ctx.emit("session/event", { id: "s-done" }, {
		type: "turn/end",
		data: { turn: 2, reason: { kind: "forked" } }
	});
	await sleep(180);
	assertSpawns(host.spawned, "toast.ps1", 1, "forked → 仍只有 1 条");
}

async function scenarioWaterfallRedundancy() {
	console.log("\n[scenario] waterfall 冗余通道（prepend）");
	const { createScope, scopeTarget } = await import("@deepseek-ai/dsh-scope");
	const host = await makeHost({ config: FAST, sessions: [rowOf("s-wf")] });

	const agent = { id: "s-wf" };
	const loopCtx = host.ctx.extend({});
	const scope = createScope(loopCtx, agent);
	agent.ctx = scope.ctx;
	// prepend 注册的监听器排在一个「不调 next() 的贪心监听器」前面也能收到——
	// 这正是 dsh-donevoice 点破的 DSH 现场陷阱：官方转发器先注册且不调 next()
	let greedySaw = false;
	host.ctx.on("user-questions/request", function () {
		greedySaw = true;
		return "greedy-consumed";
	});
	await host.ctx.waterfall(scopeTarget(agent, agent), "user-questions/request", {
		agent,
		questions: [{ id: "q1", header: "确认", question: "要继续吗？" }]
	}, async () => ({ answers: [] }));
	await sleep(180);
	assert(greedySaw, "贪心监听器也收到了（我们在它前面，没被截胡）");
	const toasts = host.spawned.filter((record) => record.script.endsWith("toast.ps1"));
	assert(toasts.length === 1, "waterfall 可达时提问也弹（冗余路径）");
}

async function scenarioActivationChain() {
	console.log("\n[scenario] 点击交接链路");
	const host = await makeHost({ config: FAST, sessions: [rowOf("s-click")] });
	assert(host.routes.has("/dsh-desktop-notify/focus"), "focus 路由已注册");
	assert(host.routes.has("/dsh-desktop-notify/activate"), "activate 路由已注册");
	assert(host.routes.has("/dsh-desktop-notify/activated"), "activated 回执路由已注册");

	// 模拟卡片/激活器写交接文件 → 宿主 1s 轮询取走 → 客户端长轮询领到
	// （debug 关掉时宿主不建 .dsh 目录，交接目录要自己备好）
	const handoffDir = join(fakeHome, ".dsh");
	mkdirSync(handoffDir, { recursive: true });
	const handoff = join(handoffDir, "dsh-desktop-notify.activate");
	writeFileSync(handoff, "s-click\n", "utf8");
	await sleep(1400);
	const res = fakeRes();
	host.routes.get("/dsh-desktop-notify/activate").handler(fakeReq("GET"), res);
	await sleep(5);
	const payload = JSON.parse(res.body || "{}");
	assert(payload.sessionId === "s-click", "客户端长轮询领到点击的会话 id");

	// 回执路由只留痕
	const receipt = await host.post("/dsh-desktop-notify/activated", { sessionId: "s-click", opened: true });
	assert(receipt.statusCode === 204, "回执路由返回 204");
}

async function scenarioToastFailureFallback() {
	console.log("\n[scenario] toast 失败兜底");
	// toast 桩直接失败（exit 1），卡片成功
	const failingToastSpawn = (spawned) => ({
		spawn(options) {
			const argv = options.argv;
			const index = argv.indexOf("-File");
			const script = index >= 0 ? argv[index + 1] : argv[0] ?? "?";
			spawned.push({
				script,
				argv,
				arg: (flag) => {
					const at = argv.indexOf(flag);
					return at >= 0 ? argv[at + 1] : undefined;
				}
			});
			return { done: sleep(10).then(() => ({ exitCode: script.endsWith("toast.ps1") ? 1 : 0 })) };
		}
	});
	const spawned = [];
	const host = await makeHost({
		config: FAST,
		sessions: [rowOf("s-fail")],
		spawn: failingToastSpawn(spawned)
	});

	host.ctx.emit("session/event", { id: "s-fail" }, {
		type: "approval/asked",
		data: { id: "apr-3", toolName: "bash" }
	});
	await sleep(200);
	const cards = spawned.filter((record) => record.script.endsWith("alert.ps1"));
	assert(cards.length >= 1, "toast 失败 → 补发卡片");
	const forced = cards.filter((record) => record.arg("-OnlyWhenFullscreen") === "0");
	assert(forced.length >= 1, "兜底卡片不挑前台状态（必显）");
	if (forced.length >= 1) assert(forced[0].arg("-Sound") === "1", "toast 连横幅都没出时，卡片补提示音");
}

const scenarios = [
	scenarioFocusGate,
	scenarioProbeVerdicts,
	scenarioRecheck,
	scenarioRouteGuard,
	scenarioSubagentFilter,
	scenarioApprovalAsked,
	scenarioAskUserQuestion,
	scenarioBlockedFallback,
	scenarioCompletionAndDedupe,
	scenarioWaterfallRedundancy,
	scenarioActivationChain,
	scenarioToastFailureFallback
];

for (const scenario of scenarios) {
	try {
		await scenario();
	} catch (error) {
		failures.push(`${scenario.name}: ${error?.message}`);
		console.log(`  FAIL 场景抛错: ${error?.stack ?? error}`);
	}
	// 无论成败都释放宿主：上一轮的 1 秒轮询不能活到下一轮
	await teardownHosts();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
	for (const failure of failures) console.log(`  - ${failure}`);
	rmSync(fakeHome, { recursive: true, force: true });
	process.exit(1);
}
rmSync(fakeHome, { recursive: true, force: true });
console.log("all green.");

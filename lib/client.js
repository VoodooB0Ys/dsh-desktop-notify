/**
 * dsh-desktop-notify 的浏览器半边。
 *
 * 三件事：
 *  1. 上报「用户此刻在看哪一个对话」——宿主是 Electron 之外的独立 Node 进程，
 *     拿不到窗口焦点、更不知道当前显示的是哪个会话，触发门必须靠页面侧喂数据。
 *  2. 长轮询宿主，取「刚刚被点击的那条通知对应哪个会话」，切过去并尽力滚到最新一条。
 *  3. 把「客户端领到了 activation、有没有切成功」回执给宿主，让日志能对上账。
 *
 * 判定依据经代码核实：DSH 客户端用「被 mainView 持有」标记正在显示的那个会话——
 * dsh-client-ui-session 与 dsh-client-ui-workspace 都用
 * `retainedBy.mainView > 0` 求 currentId，ui-session 也用它决定何时清掉
 * “完成未读”标记。所以它就是“用户正盯着看的那个对话”。
 *
 * 用长轮询而不是定时轮询：窗口最小化/被盖住时 Chromium 会节流定时器，
 * 网络驱动的挂起请求不受影响。
 *
 * 刻意不耦合 DSH 内部结构：切会话走公开的 uiWorkspace.openSession 服务，
 * 滚动只做「找按钮点一下 / 把最大滚动容器拉到底」的尽力而为，DSH 改版最多
 * 让滚动失效（宿主日志有回执可查），不会让插件挂掉。
 */
window.__ModuleLoader__.load({
	id: "dsh-desktop-notify",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/** 宿主半边注册的同源路由：焦点上报。 */
		const FOCUS_ENDPOINT = "/dsh-desktop-notify/focus";
		/** 宿主半边注册的同源路由：点击唤起。 */
		const ACTIVATION_ENDPOINT = "/dsh-desktop-notify/activate";
		/** 宿主半边注册的同源路由：领取回执（只留痕）。 */
		const ACTIVATED_ENDPOINT = "/dsh-desktop-notify/activated";
		/** 焦点心跳间隔：让宿主能判断上报是否已经过期。 */
		const HEARTBEAT_MS = 15000;
		/** 长轮询失败后的重试间隔。 */
		const RETRY_MS = 2000;
		/** inject 迟迟不落地时，兜底自装的等待时长。 */
		const INSTALL_FALLBACK_MS = 5000;
		/** 「回到底部」类按钮的说法；不匹配任何 DSH 具体文案，改版也能猜中。 */
		const TO_BOTTOM_PATTERN = /回到底部|回到最新|返回底部|back to bottom|scroll to (?:bottom|latest|end)/i;

		/**
		 * 当前显示在主视图里的会话 id。
		 * @param sessions - 客户端 sessions 服务。
		 * @returns 会话 id；取不到时返回 undefined（宿主按“没在看”处理）。
		 */
		function activeSessionId(sessions) {
			try {
				const list = sessions?.list?.getSnapshot?.();
				if (!list) return undefined;
				const ids = list.ids ?? Object.keys(list.byId ?? {});
				for (const id of ids) {
					if ((list.byId?.[id]?.retainedBy?.mainView ?? 0) > 0) return id;
				}
			} catch (error) {
				/* 取不到就让宿主按“没在看”处理，宁可多提醒一次 */
			}
			return undefined;
		}

		/**
		 * 找「回到底部」按钮并点它：让 DSH 自己的滚动逻辑处理虚拟列表。
		 * 按钮可能不叫这个名字（改版/换语言），所以先试交互元素上的
		 * aria-label/title，再试任意带 aria-label 的元素，文本兜底。
		 * @returns 是否点了某个像「回到底部」的按钮。
		 */
		function clickToBottomButton() {
			const looksLike = (node) => {
				const label =
					node.getAttribute("aria-label") ||
					node.getAttribute("title") ||
					(node.textContent?.trim().length <= 10 ? node.textContent.trim() : "") ||
					"";
				return label !== "" && TO_BOTTOM_PATTERN.test(label);
			};
			for (const node of document.querySelectorAll('button, [role="button"]')) {
				if (looksLike(node)) {
					node.click();
					return true;
				}
			}
			for (const node of document.querySelectorAll("[aria-label]")) {
				if (looksLike(node)) {
					node.click();
					return true;
				}
			}
			return false;
		}

		/**
		 * 退化方案：把页面里最长的可滚动容器拉到底部。
		 * 虚拟列表依赖 scroll 事件回收/补渲染，所以手动补发一个 scroll 事件。
		 * @returns 是否找到了可滚动容器。
		 */
		function scrollLargestContainer() {
			let best = null;
			let bestHeight = 0;
			for (const node of document.querySelectorAll("div, section, main")) {
				const overflow = node.scrollHeight - node.clientHeight;
				if (overflow > 80 && node.scrollHeight > bestHeight) {
					best = node;
					bestHeight = node.scrollHeight;
				}
			}
			if (!best) return false;
			best.scrollTop = best.scrollHeight;
			best.dispatchEvent(new Event("scroll", { bubbles: true }));
			return true;
		}

		/**
		 * 尽力把会话视图滚到最新一条。渲染是异步的（切会话后内容才进来），
		 * 所以按计划重试约 2 秒；任何一步成功都不影响后续尝试——多点几次
		 * 「回到底部」是幂等的。
		 */
		function scrollToLatest() {
			for (const delay of [0, 300, 700, 1200, 2000]) {
				window.setTimeout(() => {
					try {
						if (!clickToBottomButton()) scrollLargestContainer();
					} catch (error) {
						/* 探测失败就下次再试；全部失败也只是停在原位 */
					}
				}, delay);
			}
		}

		/**
		 * 把「客户端领到了 activation」回执给宿主，只为日志对账。失败静默。
		 * @param sessionId - 要打开的会话。
		 * @param opened - 是否成功发出了切换。
		 */
		function reportActivated(sessionId, opened) {
			try {
				fetch(ACTIVATED_ENDPOINT, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionId, opened, at: Date.now() }),
					keepalive: true
				}).catch(() => {});
			} catch (error) {
				/* 回执失败无所谓 */
			}
		}

		/**
		 * 切到宿主点名要看的会话（就是侧边栏点一下那件事），然后尽力滚到底。
		 * @param ctx - 客户端上下文。
		 * @param uiWorkspace - 注入的 uiWorkspace 服务；没有就现取，再没有就报错。
		 * @param sessionId - 会话 id。
		 * @returns 是否已发出切换。
		 */
		function openSession(ctx, uiWorkspace, sessionId) {
			const workspace = uiWorkspace ?? ctx.get?.("uiWorkspace");
			if (!workspace || typeof workspace.openSession !== "function") {
				// 不静默：这条日志是「点击后只唤前窗口、没切会话」的唯一线索
				console.warn("[dsh-desktop-notify] uiWorkspace.openSession unavailable; only the window will be raised");
				return false;
			}
			try {
				workspace.openSession(sessionId);
				return true;
			} catch (error) {
				console.error("[dsh-desktop-notify] openSession failed", error);
				return false;
			}
		}

		/**
		 * 客户端插件主体。
		 * @param ctx - 客户端 cordis 上下文。
		 */
		function apply(ctx) {
			let installed = false;
			/**
			 * 装一次；依赖的服务就绪后再装。
			 * @param scope - 注入了服务的作用域上下文。
			 */
			const install = (scope) => {
				if (installed) return;
				installed = true;
				const sessions = scope?.sessions ?? ctx.get?.("sessions");
				// uiWorkspace 只在点击跳转时才真正用到，这里拿不到也不阻塞焦点上报
				const uiWorkspace = scope?.uiWorkspace ?? ctx.get?.("uiWorkspace");

				/** 上报一次：窗口是否聚焦 + 正在看哪个对话。失败静默。 */
				const report = () => {
					try {
						fetch(FOCUS_ENDPOINT, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({
								focused:
									typeof document !== "undefined" &&
									document.visibilityState === "visible" &&
									document.hasFocus(),
								sessionId: activeSessionId(sessions),
								at: Date.now()
							}),
							keepalive: true
						}).catch(() => {});
					} catch (error) {
						/* 页面侧上报永远不该抛错 */
					}
				};

				ctx.effect(
					() => {
						report();
						const onFocus = () => report();
						const onVisibility = () => report();
						window.addEventListener("focus", onFocus);
						window.addEventListener("blur", onFocus);
						document.addEventListener("visibilitychange", onVisibility);
						// 切换对话必须立刻上报，等 15 秒心跳就太迟了
						const unsubscribe = sessions?.list?.subscribe?.(report);
						const timer = window.setInterval(report, HEARTBEAT_MS);
						return () => {
							window.clearInterval(timer);
							window.removeEventListener("focus", onFocus);
							window.removeEventListener("blur", onFocus);
							document.removeEventListener("visibilitychange", onVisibility);
							if (typeof unsubscribe === "function") unsubscribe();
						};
					},
					"dsh-desktop-notify: focus reporter"
				);

				ctx.effect(
					() => {
						const controller = new AbortController();
						const loop = async () => {
							while (!controller.signal.aborted) {
								try {
									const response = await fetch(ACTIVATION_ENDPOINT, {
										cache: "no-store",
										signal: controller.signal
									});
									if (response.ok) {
										const data = await response.json();
										if (data?.sessionId) {
											const opened = openSession(ctx, uiWorkspace, data.sessionId);
											scrollToLatest();
											reportActivated(data.sessionId, opened);
										}
									}
								} catch (error) {
									if (controller.signal.aborted) return;
									await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
								}
							}
						};
						loop();
						return () => controller.abort();
					},
					"dsh-desktop-notify: activation watch"
				);
			};
			// 显式声明依赖：uiWorkspace 缺席最多让点击跳转退化成「只唤前窗口」，
			// 焦点上报和提醒本身不受影响
			if (typeof ctx.inject === "function") ctx.inject(["sessions", "uiWorkspace"], install);
			else install(ctx);
			// 兜底：inject 迟迟不落地（服务改名/加载顺序变了）就自装，
			// 宁可少个「点击切会话」，也不能整个客户端半边失联
			window.setTimeout(() => {
				if (!installed) {
					console.warn("[dsh-desktop-notify] services not injected within 5s; installing with what is available");
					install(ctx);
				}
			}, INSTALL_FALLBACK_MS);
		}

		exports.apply = apply;
		exports.inject = [];
		return module.exports;
	}
});

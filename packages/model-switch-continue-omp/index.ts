import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { matchesKey } from "@oh-my-pi/pi-tui";
import { buildPrompt, loadPromptConfig } from "./prompt.ts";

type Timer = NodeJS.Timeout;
const QUIET_MS = 800;
const CHECK_MS = 100;
const SWITCH_TIMEOUT_MS = 10_000;

export default function modelSwitchContinue(pi: ExtensionAPI): void {
	let unsubscribe: (() => void) | undefined;
	let timer: Timer | undefined;
	let generation = 0;
	let armed: { session: string; initialModel: string; leaf: string | null; deadline: number } | undefined;

	const cancel = () => {
		generation++;
		clearTimeout(timer);
		timer = undefined;
		armed = undefined;
	};
	const modelKey = (ctx: ExtensionContext) => ctx.model && `${ctx.model.provider}/${ctx.model.id}`;
	const resume = (ctx: ExtensionContext, token: number) => {
		try {
			checkResume(ctx, token);
		} catch (error) {
			cancel();
			ctx.ui.notify(`Auto-continue failed: ${error}`, "error");
		}
	};
	const checkResume = (ctx: ExtensionContext, token: number) => {
		if (generation !== token || !armed) return;
		if (!ctx.isIdle() || ctx.hasPendingMessages() || ctx.ui.getEditorText().trim() ||
			ctx.sessionManager.getSessionId() !== armed.session) return cancel();
		const entries = ctx.sessionManager.getBranch();
		const afterLeaf = armed.leaf === null ? entries : entries.slice(entries.findIndex(entry => entry.id === armed!.leaf) + 1);
		if (armed.leaf !== null && !entries.some(entry => entry.id === armed!.leaf)) return cancel();
		const change = afterLeaf.findLast(entry => entry.type === "model_change");
		const current = modelKey(ctx);
		if (change?.type === "model_change" && !change.resolvedModelIsFallback && change.role !== "fallback" && change.role !== "prewalk" && current && change.model === current && current !== armed.initialModel) {
			const prompt = buildPrompt(loadPromptConfig(), armed.initialModel, current);
			cancel();
			void pi.sendUserMessage(prompt, { attribution: "agent" }).catch(error => ctx.ui.notify(`Auto-continue failed: ${error}`, "error"));
			return;
		}
		if (Date.now() >= armed.deadline) return cancel();
		timer = setTimeout(() => resume(ctx, token), CHECK_MS);
	};
	const bind = (ctx: ExtensionContext) => {
		cancel();
		unsubscribe?.();
		unsubscribe = undefined;
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		unsubscribe = ctx.ui.onTerminalInput(data => {
			const isCycle = matchesKey(data, "ctrl+p");
			if (!isCycle) {
				if (armed) cancel();
				return;
			}
			if (!ctx.isIdle() || ctx.hasPendingMessages() || ctx.ui.getEditorText().trim()) return cancel();
			const current = modelKey(ctx);
			if (!current) return cancel();
			const branch = ctx.sessionManager.getBranch();
			if (!branch.some(entry => entry.type === "message" && entry.message.role === "user" ||
				entry.type === "compaction" || entry.type === "branch_summary")) return cancel();
			const session = ctx.sessionManager.getSessionId();
			const previous = armed?.session === session ? armed : undefined;
			cancel();
			armed = { session, initialModel: previous?.initialModel ?? current, leaf: previous?.leaf ?? ctx.sessionManager.getLeafId(), deadline: Date.now() + SWITCH_TIMEOUT_MS };
			const token = generation;
			timer = setTimeout(() => resume(ctx, token), QUIET_MS);
		});
	};
	pi.on("session_start", (_event, ctx) => bind(ctx));
	pi.on("session_switch", (_event, ctx) => bind(ctx));
	pi.on("session_shutdown", () => { cancel(); unsubscribe?.(); });
	pi.on("agent_start", () => cancel());
}

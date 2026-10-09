/**
 * Shake meter — footer status showing how many tokens a manual `/shake` would free now.
 * Display only: it never changes the session. See estimate.ts for the rules it mirrors.
 *
 * Colour: dim below 10k, warning from 10k, error from 25k (the point where a shake pays).
 * Refreshes on session start/switch, every turn end, and on a 3 s tick — `/shake` itself
 * emits no extension event, so the tick is what makes the number drop after a shake.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type Entry, estimateShake } from "./estimate";

/** Nerd Font nf-fa-scissors (U+F0C4); the Font Awesome range is in every Nerd Font build. */
export const ICON = "\uf0c4";
export const WARN_TOKENS = 10_000;
export const ALERT_TOKENS = 25_000;
const STATUS_KEY = "shake-meter";
const TICK_MS = 3_000;

export function label(tokens: number): string {
	return `${ICON} ${tokens < 1000 ? "<1k" : `~${Math.round(tokens / 1000)}k`} shakeable`;
}

export function severity(tokens: number): "dim" | "warning" | "error" {
	return tokens >= ALERT_TOKENS ? "error" : tokens >= WARN_TOKENS ? "warning" : "dim";
}

export default function shakeMeter(pi: ExtensionAPI): void {
	let ctx: ExtensionContext | undefined;
	let shown = "";
	let timer: Timer | undefined;

	function refresh(next?: ExtensionContext): void {
		if (next) ctx = next;
		if (!ctx?.hasUI || (ctx.agent?.kind ?? "main") !== "main") return;
		try {
			const { tokens } = estimateShake(ctx.sessionManager.getBranch() as unknown as Entry[]);
			const text = label(tokens);
			const key = `${text}|${severity(tokens)}`;
			if (key === shown) return;
			shown = key;
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(severity(tokens), text));
		} catch {
			// A stale ctx after shutdown or an unexpected entry shape must never break the footer.
		}
	}

	pi.on("session_start", (_e, c) => {
		refresh(c);
		timer ??= setInterval(() => refresh(), TICK_MS);
		timer.unref?.();
	});
	pi.on("session_switch", (_e, c) => {
		shown = "";
		refresh(c);
	});
	pi.on("session_compact", (_e, c) => refresh(c));
	pi.on("turn_end", (_e, c) => refresh(c));
	pi.on("agent_end", (_e, c) => refresh(c));
	pi.on("session_shutdown", () => {
		clearInterval(timer);
		timer = undefined;
		ctx = undefined;
	});
}

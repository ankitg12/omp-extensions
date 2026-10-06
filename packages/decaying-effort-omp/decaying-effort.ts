import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export type ConfiguredThinkingLevel =
	| "auto"
	| "inherit"
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

export interface DecayingEffortConfig {
	enabled: boolean;
	schedule: ConfiguredThinkingLevel[];
	logPath: string;
}

export const DEFAULT_SCHEDULE: ConfiguredThinkingLevel[] = [
	"max",
	"xhigh",
	"high",
	"medium",
	"auto",
];

const DEFAULT_LOG_PATH = join(homedir(), ".omp", "logs", "decaying-effort.jsonl");

/** Minimal slice of the extension context this module reads; entries are untyped session JSONL rows. */
interface EntriesCtx {
	sessionManager?: { getEntries?: () => readonly unknown[] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export default function decayingEffortExtension(pi: ExtensionAPI) {
	let turnCount = 0;
	let userOverridden = false;
	let lastProgrammaticLevel: string | undefined = undefined;

	const config: DecayingEffortConfig = {
		enabled: true,
		schedule: [...DEFAULT_SCHEDULE],
		logPath: DEFAULT_LOG_PATH,
	};

	try {
		mkdirSync(dirname(config.logPath), { recursive: true });
	} catch {}

	function logJSONL(event: string, details: Record<string, unknown>): void {
		try {
			const entry = {
				ts: new Date().toISOString(),
				event,
				turn: turnCount,
				currentLevel: pi.getThinkingLevel(),
				userOverridden,
				...details,
			};
			appendFileSync(config.logPath, `${JSON.stringify(entry)}\n`, "utf8");
		} catch {}
	}

	/**
	 * The level the user (or this extension) *selected*, not the level OMP resolved it to.
	 *
	 * `pi.getThinkingLevel()` returns the resolved level: with `auto` selected, OMP's
	 * auto-thinking judge re-resolves it per prompt (e.g. low -> high), so comparing
	 * resolved levels misreads the judge as a manual override. OMP records the selector
	 * as `configured` on every `thinking_level_change` session entry; read the latest.
	 * Falls back to the resolved level when no entry carries `configured`.
	 * TODO: switch to pi.getConfiguredThinkingLevel() once https://github.com/can1357/oh-my-pi/issues/14562 lands.
	 */
	function configuredLevel(ctx?: EntriesCtx): string {
		const entries = ctx?.sessionManager?.getEntries?.() ?? [];
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (!isRecord(e) || e.type !== "thinking_level_change") continue;
			if (typeof e.configured === "string") return e.configured;
			break;
		}
		return (pi.getThinkingLevel() ?? "inherit") as string;
	}

	const resetOrResumeState = (reason: string, ctx?: EntriesCtx) => {
		const entries = ctx?.sessionManager?.getEntries?.() ?? [];
		if (entries.length > 0) {
			const userTurns = entries.filter(
				e => isRecord(e) && e.type === "message" && isRecord(e.message) && e.message.role === "user",
			).length;
			turnCount = userTurns;
			logJSONL("session_resumed", { reason, turnCount, historyEntries: entries.length });
		} else {
			turnCount = 0;
			logJSONL("session_started", { reason });
		}
		userOverridden = false;
		lastProgrammaticLevel = undefined;
	};

	pi.on("session_start", (_event, ctx) => {
		resetOrResumeState("start", ctx);
	});

	pi.on("session_switch", (_event, ctx) => {
		resetOrResumeState("switch", ctx);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!config.enabled) return;

		// Manual mode is sticky: notify once at detection, then stay silent.
		if (userOverridden) return;

		const currentLevel = configuredLevel(ctx);
		if (lastProgrammaticLevel !== undefined && currentLevel !== lastProgrammaticLevel) {
			userOverridden = true;
			logJSONL("user_override_detected", {
				currentLevel,
				lastProgrammaticLevel,
			});
			ctx.ui.notify(
				`[decaying-effort] Manual override detected (set to ${currentLevel}). Shifted to manual transmission (automatic decay paused).`,
				"info"
			);
			return;
		}

		turnCount++;
		const targetIndex = Math.min(turnCount - 1, config.schedule.length - 1);
		const targetLevel = config.schedule[targetIndex];

		if (targetLevel && targetLevel !== currentLevel) {
			pi.setThinkingLevel(targetLevel as unknown as Parameters<typeof pi.setThinkingLevel>[0]);
			const effective = (pi.getThinkingLevel() ?? targetLevel) as string;
			// Remember the selector (e.g. "auto", or the clamped level), not the resolved level.
			lastProgrammaticLevel = configuredLevel(ctx);
			const isAuto = targetLevel === "auto";
			const wasClamped = !isAuto && lastProgrammaticLevel !== targetLevel;
			logJSONL("effort_stepped", {
				turnCount,
				targetLevel,
				effective,
				clamped: wasClamped,
			});
			const msg = isAuto
				? `[decaying-effort] Turn ${turnCount}: stepped effort to auto (resolved to ${effective})`
				: `[decaying-effort] Turn ${turnCount}: stepped effort to ${effective}${wasClamped ? ` (clamped from ${targetLevel})` : ""}`;
			ctx.ui.notify(msg, "info");
		} else {
			lastProgrammaticLevel = currentLevel;
			logJSONL("effort_unchanged", {
				turnCount,
				targetLevel,
				currentLevel,
			});
		}
	});

	pi.registerCommand("effort-decay", {
		description: "Inspect and manage decaying thinking effort schedule",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const [subcommand, ...rest] = trimmed.split(/\s+/);
			const sub = subcommand?.toLowerCase() ?? "";

			if (sub === "off") {
				config.enabled = false;
				ctx.ui.notify("Decaying effort disabled for this session.", "info");
			} else if (sub === "on") {
				config.enabled = true;
				userOverridden = false;
				ctx.ui.notify("Decaying effort enabled.", "info");
			} else if (sub === "reset") {
				turnCount = 0;
				userOverridden = false;
				lastProgrammaticLevel = undefined;
				ctx.ui.notify("Turn counter reset. Next prompt will start at Turn 1 (" + config.schedule[0] + ").", "info");
			} else if (sub === "schedule" && rest.length > 0) {
				const steps = rest.join(" ").split(",").map(s => s.trim().toLowerCase()).filter(Boolean) as ConfiguredThinkingLevel[];
				if (steps.length === 0) {
					ctx.ui.notify("Usage: /effort-decay schedule max,xhigh,high,medium,auto", "error");
					return;
				}
				config.schedule = steps;
				userOverridden = false;
				ctx.ui.notify(`Decay schedule updated: [${config.schedule.join(" -> ")}]`, "info");
			} else {
				const current = pi.getThinkingLevel();
				ctx.ui.notify(
					`Decaying effort: ${config.enabled ? "ACTIVE" : "PAUSED"} | Turn: ${turnCount} | Current: ${current} | Schedule: [${config.schedule.join(" -> ")}]${userOverridden ? " (User override detected - decay paused)" : ""}`,
					"info"
				);
			}
		},
	});
}

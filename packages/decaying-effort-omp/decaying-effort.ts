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

	const resetOrResumeState = (reason: string, ctx?: any) => {
		const entries = ctx?.sessionManager?.getEntries?.();
		if (Array.isArray(entries) && entries.length > 0) {
			const userTurns = entries.filter((e: any) => e.type === "message" && e.message?.role === "user").length;
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

		const currentLevel = (pi.getThinkingLevel() ?? "inherit") as string;
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

		if (userOverridden) return;

		turnCount++;
		const targetIndex = Math.min(turnCount - 1, config.schedule.length - 1);
		const targetLevel = config.schedule[targetIndex];

		if (targetLevel && targetLevel !== currentLevel) {
			pi.setThinkingLevel(targetLevel as unknown as Parameters<typeof pi.setThinkingLevel>[0]);
			const effective = (pi.getThinkingLevel() ?? targetLevel) as string;
			lastProgrammaticLevel = effective;
			const isAuto = targetLevel === "auto";
			const wasClamped = !isAuto && effective !== targetLevel;
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

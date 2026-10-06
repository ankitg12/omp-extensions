/**
 * model-switch-prune-omp: the execution layer for model switches. On every request, tool turns
 * written by a model other than the active one are pruned on the wire (see prune.ts). It has no
 * rules and no policy; it always runs, with or without session-governor-omp.
 *
 * Policy-driven pruning (epoch cuts from CEL rules) belongs to session-governor-omp, which imports
 * `pruneBeforeCut` from ./prune.ts. Load the governor BEFORE this extension: OMP chains `context`
 * handlers in load order, and the epoch pass must see tool results before this pass folds the
 * foreign ones into user messages. The reverse order is still correct, only less aggressive.
 *
 * Config (optional): ~/.omp/agent/model-switch-prune.json  { "mode": "elide"|"drop"|"keep", "debug": bool }
 * Overrides: OMP_MODEL_SWITCH_PRUNE_CONFIG, OMP_MODEL_SWITCH_PRUNE_LOG.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { emptyStats, type ForeignMode, pruneForeignHistory } from "./prune.ts";

export interface PruneConfig {
	mode: ForeignMode;
	debug: boolean;
}

export const CONFIG_PATH = join(homedir(), ".omp", "agent", "model-switch-prune.json");
export const DEBUG_LOG_PATH = join(homedir(), ".omp", "agent", "model-switch-prune.log");
const DEFAULT_CONFIG: PruneConfig = { mode: "elide", debug: false };

/** A missing or invalid file yields the default (elide): the mechanism must never switch itself off by accident. */
export function loadConfig(path = CONFIG_PATH): PruneConfig {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return DEFAULT_CONFIG;
		const { mode, debug } = parsed as Record<string, unknown>;
		if (mode !== undefined && mode !== "elide" && mode !== "drop" && mode !== "keep") return DEFAULT_CONFIG;
		if (debug !== undefined && typeof debug !== "boolean") return DEFAULT_CONFIG;
		return { mode: (mode as ForeignMode | undefined) ?? "elide", debug: debug ?? false };
	} catch {
		return DEFAULT_CONFIG;
	}
}

export default function modelSwitchPrune(pi: ExtensionAPI, options: { configPath?: string; debugLogPath?: string } = {}): void {
	const config = loadConfig(options.configPath ?? process.env.OMP_MODEL_SWITCH_PRUNE_CONFIG ?? CONFIG_PATH);
	const logPath = options.debugLogPath ?? process.env.OMP_MODEL_SWITCH_PRUNE_LOG ?? DEBUG_LOG_PATH;
	let lastKey = "";

	pi.on("context", (event, ctx) => {
		const model = ctx.model;
		if (!model) return;
		const stats = emptyStats();
		const messages = pruneForeignHistory(event.messages, model, config.mode, stats);
		if (config.debug && stats.foreignCalls > 0) {
			const line = JSON.stringify({ model: model.id, ...stats });
			if (line !== lastKey) {
				lastKey = line;
				try {
					appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), model: model.id, ...stats })}\n`);
				} catch {}
			}
		}
		if (messages === event.messages) return;
		return { messages };
	});
}

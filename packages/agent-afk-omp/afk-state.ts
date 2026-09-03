// Config loading for agent-afk.
//
// Config: ~/.omp/agent/agent-afk.json
// {
//   "debounceMs": 120000,     // no terminal input for this long -> auto-engage (default 2min)
//   "checkIntervalMs": 15000, // how often to check elapsed-since-last-input (default 15s)
//   "debug": false
// }

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface AfkConfig {
	debounceMs: number;
	checkIntervalMs: number;
	debug: boolean;
}

const DEFAULT_CONFIG: AfkConfig = {
	debounceMs: 120_000,
	checkIntervalMs: 15_000,
	debug: false,
};

export function loadConfig(log: (msg: string) => void): AfkConfig {
	const path = join(homedir(), ".omp", "agent", "agent-afk.json");
	if (!existsSync(path)) return DEFAULT_CONFIG;
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (typeof raw !== "object" || raw === null) return DEFAULT_CONFIG;
		return {
			debounceMs: "debounceMs" in raw && typeof raw.debounceMs === "number" ? raw.debounceMs : DEFAULT_CONFIG.debounceMs,
			checkIntervalMs: "checkIntervalMs" in raw && typeof raw.checkIntervalMs === "number" ? raw.checkIntervalMs : DEFAULT_CONFIG.checkIntervalMs,
			debug: "debug" in raw && typeof raw.debug === "boolean" ? raw.debug : DEFAULT_CONFIG.debug,
		};
	} catch (e: unknown) {
		log(`loadConfig: failed to parse ${path}: ${e instanceof Error ? e.message : String(e)}`);
		return DEFAULT_CONFIG;
	}
}

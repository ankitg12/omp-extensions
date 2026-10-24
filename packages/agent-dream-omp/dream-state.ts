// dream-state — config schema and diary-cooldown helpers for agent-dream-omp.
//
// Config: ~/.omp/agent/agent-dream.json (JSON, all fields optional).
// Missing file → defaults. Malformed JSON → defaults + logged reason.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DreamConfig {
	/** Fire only after this long with no activity. Default 30 min. */
	idleMs: number;
	/** Minimum gap between diary entries. Default 12 h. Manual /dream bypasses idle, not this. */
	minIntervalMs: number;
	/** Diary file. Default ~/Notes/dreams/DREAMS.md. */
	diaryPath: string;
	/** Max sessions scanned per pass. Default 10. */
	maxSessions: number;
	/** Max diary entries kept (newest-first, older trimmed). Default 50. */
	maxDiaryEntries: number;
	/** Max memories written to the store per pass. Default 20. */
	maxMemoriesPerPass: number;
	/** Max lines per diary entry body. Default 30. */
	maxDiaryEntryLines: number;
	/** Log file. Default ~/.omp/agent/agent-dream.log. */
	logPath: string;
	/** Master switch. Default true. */
	enabled: boolean;
	/** Log arming/cooldown decisions to the log file. Default false. */
	debug: boolean;
}

/** Expand a leading `~` to the home directory. Everything else passes through. */
export function expandHome(p: string): string {
	return p.replace(/^~(?=$|\/)/, homedir());
}

export const CONFIG_PATH = join(homedir(), ".omp", "agent", "agent-dream.json");

export const DEFAULT_CONFIG: DreamConfig = {
	idleMs: 30 * 60 * 1000,
	minIntervalMs: 12 * 60 * 60 * 1000,
	diaryPath: "~/Notes/dreams/DREAMS.md",
	maxSessions: 10,
	maxDiaryEntries: 50,
	maxMemoriesPerPass: 20,
	maxDiaryEntryLines: 30,
	logPath: "~/.omp/agent/agent-dream.log",
	enabled: true,
	debug: false,
};

function positiveInt(v: unknown): number | null {
	return typeof v === "number" && v > 0 ? Math.floor(v) : null;
}

/** Parse one raw config object. Unknown fields ignored; bad values fall back to defaults. */
export function parseConfig(raw: unknown): DreamConfig {
	const cfg: DreamConfig = { ...DEFAULT_CONFIG };
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return cfg;
	const o = raw as Record<string, unknown>;
	const idle = positiveInt(o.idleMs);
	if (idle !== null) cfg.idleMs = idle;
	const gap = positiveInt(o.minIntervalMs);
	if (gap !== null) cfg.minIntervalMs = gap;
	if (typeof o.diaryPath === "string" && o.diaryPath.length > 0) cfg.diaryPath = o.diaryPath;
	const sessions = positiveInt(o.maxSessions);
	if (sessions !== null) cfg.maxSessions = sessions;
	// Back-compat: old `maxEntries` maps to maxDiaryEntries.
	const entries = positiveInt(o.maxDiaryEntries ?? o.maxEntries);
	if (entries !== null) cfg.maxDiaryEntries = entries;
	const mems = positiveInt(o.maxMemoriesPerPass);
	if (mems !== null) cfg.maxMemoriesPerPass = mems;
	const lines = positiveInt(o.maxDiaryEntryLines);
	if (lines !== null) cfg.maxDiaryEntryLines = lines;
	if (typeof o.logPath === "string" && o.logPath.length > 0) cfg.logPath = o.logPath;
	if (typeof o.enabled === "boolean") cfg.enabled = o.enabled;
	return cfg;
}

export function loadConfig(log: (msg: string) => void = () => {}): DreamConfig {
	if (!existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
	try {
		return parseConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
	} catch (e) {
		log(`dream config unreadable (${e instanceof Error ? e.message : String(e)}) — using defaults`);
		return { ...DEFAULT_CONFIG };
	}
}

export interface DreamState {
	/** ISO timestamp of the last injected pass, or null when never run. */
 	lastPassAt: string | null;
	/** How the last pass was triggered. */
	lastReason: "idle" | "manual" | "afk" | null;
	/** Sessions scanned / memories added as reported by the skill (null until reported). */
	lastSessions: number | null;
	lastMemories: number | null;
	/** Diary entry timestamp written by the last pass. */
	lastDiaryEntry: string | null;
	/** Total passes injected since state file creation. */
	totalPasses: number;
}

export const STATE_PATH = join(homedir(), ".omp", "agent", "agent-dream-state.json");

export const EMPTY_STATE: DreamState = {
	lastPassAt: null,
	lastReason: null,
	lastSessions: null,
	lastMemories: null,
	lastDiaryEntry: null,
	totalPasses: 0,
};

/** Parse one raw state object. Bad values fall back to EMPTY_STATE fields. */
export function parseState(raw: unknown): DreamState {
	const st: DreamState = { ...EMPTY_STATE };
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return st;
	const o = raw as Record<string, unknown>;
	if (typeof o.lastPassAt === "string" && !Number.isNaN(Date.parse(o.lastPassAt))) st.lastPassAt = o.lastPassAt;
	if (o.lastReason === "idle" || o.lastReason === "manual" || o.lastReason === "afk") st.lastReason = o.lastReason;
	if (typeof o.lastSessions === "number" && o.lastSessions >= 0) st.lastSessions = Math.floor(o.lastSessions);
	if (typeof o.lastMemories === "number" && o.lastMemories >= 0) st.lastMemories = Math.floor(o.lastMemories);
	if (typeof o.lastDiaryEntry === "string" && o.lastDiaryEntry.length > 0) st.lastDiaryEntry = o.lastDiaryEntry;
	if (typeof o.totalPasses === "number" && o.totalPasses >= 0) st.totalPasses = Math.floor(o.totalPasses);
	return st;
}

export function loadDreamState(log: (msg: string) => void = () => {}): DreamState {
	if (!existsSync(STATE_PATH)) return { ...EMPTY_STATE };
	try {
		return parseState(JSON.parse(readFileSync(STATE_PATH, "utf8")));
	} catch (e) {
		log(`dream state unreadable (${e instanceof Error ? e.message : String(e)}) — starting fresh`);
		return { ...EMPTY_STATE };
	}
}

export function humanSince(iso: string | null, now: number = Date.now()): string {
	if (iso === null) return "never";
	const ageMs = now - new Date(iso).getTime();
	if (Number.isNaN(ageMs) || ageMs < 0) return "unknown";
	const mins = Math.floor(ageMs / 60000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

/** Leading `## <ISO-timestamp>` heading of a newest-first diary entry, or null. */
export function newestEntryTimestamp(diaryHead: string): Date | null {
	const m = diaryHead.slice(0, 2000).match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
	if (!m?.[1]) return null;
	const d = new Date(m[1]);
	return Number.isNaN(d.getTime()) ? null : d;
}

/** True when enough time passed since the newest diary entry (or diary empty/missing). */
export function cooldownElapsed(diaryHead: string | null, minIntervalMs: number, now: number = Date.now()): boolean {
	if (diaryHead === null) return true;
	const ts = newestEntryTimestamp(diaryHead);
	if (ts === null) return true;
	return now - ts.getTime() >= minIntervalMs;
}

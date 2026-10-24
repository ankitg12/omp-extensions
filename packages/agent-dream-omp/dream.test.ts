import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, cooldownElapsed, EMPTY_STATE, humanSince, newestEntryTimestamp, parseConfig, parseState } from "./dream-state";

describe("parseConfig", () => {
	test("defaults on missing/garbage", () => {
		expect(parseConfig(undefined)).toEqual(DEFAULT_CONFIG);
		expect(parseConfig(null)).toEqual(DEFAULT_CONFIG);
		expect(parseConfig("nope")).toEqual(DEFAULT_CONFIG);
		expect(parseConfig([1])).toEqual(DEFAULT_CONFIG);
	});

	test("accepts valid overrides, rejects bad values", () => {
		const cfg = parseConfig({ idleMs: 60000, minIntervalMs: -5, diaryPath: "", maxDiaryEntries: 3.7, enabled: false, debug: 1 });
		expect(cfg.idleMs).toBe(60000);
		expect(cfg.minIntervalMs).toBe(DEFAULT_CONFIG.minIntervalMs);
		expect(cfg.diaryPath).toBe(DEFAULT_CONFIG.diaryPath);
		expect(cfg.maxDiaryEntries).toBe(3);
		expect(cfg.enabled).toBe(false);
		expect(cfg.debug).toBe(false);
	});

	test("memory and diary caps, plus legacy maxEntries", () => {
		expect(parseConfig({ maxMemoriesPerPass: 5 }).maxMemoriesPerPass).toBe(5);
		expect(parseConfig({ maxDiaryEntryLines: 12 }).maxDiaryEntryLines).toBe(12);
		expect(parseConfig({ maxMemoriesPerPass: 0 }).maxMemoriesPerPass).toBe(DEFAULT_CONFIG.maxMemoriesPerPass);
		expect(parseConfig({ maxEntries: 7 }).maxDiaryEntries).toBe(7);
		expect(parseConfig({ maxDiaryEntries: 9, maxEntries: 7 }).maxDiaryEntries).toBe(9);
	});

 	test("ignores unknown fields", () => {
		const cfg = parseConfig({ whatever: 1, idleMs: 5000 });
		expect(cfg.idleMs).toBe(5000);
	});
});

describe("diary cooldown", () => {
	test("null diary means elapsed", () => {
		expect(cooldownElapsed(null, 3600000)).toBe(true);
	});

	test("unparseable head means elapsed", () => {
		expect(cooldownElapsed("no timestamps here", 3600000)).toBe(true);
	});

	test("fresh entry blocks, old entry passes", () => {
		const now = new Date("2026-10-24T10:00:00").getTime();
		const fresh = "## 2026-10-24T09:30\n- sessions: 2 scanned\n";
		const old = "## 2026-10-23T10:00\n- sessions: 5 scanned\n";
		expect(cooldownElapsed(fresh, 12 * 3600000, now)).toBe(false);
		expect(cooldownElapsed(old, 12 * 3600000, now)).toBe(true);
	});

	test("newestEntryTimestamp rejects invalid dates", () => {
		expect(newestEntryTimestamp("## 2026-13-45T99:99\n")).toBeNull();
		expect(newestEntryTimestamp("## 2026-10-24T09:30\n")?.toISOString().slice(0, 16)).toBe("2026-10-24T09:30");
	});
});

describe("parseState", () => {
	test("defaults on missing/garbage", () => {
		expect(parseState(undefined)).toEqual(EMPTY_STATE);
		expect(parseState("nope")).toEqual(EMPTY_STATE);
	});

	test("accepts valid state, rejects bad values", () => {
		const st = parseState({
			lastPassAt: "2026-10-24T09:00:00.000Z",
			lastReason: "idle",
			lastSessions: 4,
			lastMemories: 2,
			lastDiaryEntry: "2026-10-24T09:00",
			totalPasses: 3,
		});
		expect(st.lastPassAt).toBe("2026-10-24T09:00:00.000Z");
		expect(st.lastReason).toBe("idle");
		expect(st.totalPasses).toBe(3);
		const bad = parseState({ lastPassAt: "garbage", lastReason: "nap", lastSessions: -1, totalPasses: -2 });
		expect(bad).toEqual(EMPTY_STATE);
	});
});

describe("humanSince", () => {
	test("null and edges", () => {
		expect(humanSince(null)).toBe("never");
		const now = new Date("2026-10-24T10:00:00Z").getTime();
		expect(humanSince(new Date(now - 30 * 1000).toISOString(), now)).toBe("just now");
		expect(humanSince(new Date(now - 5 * 60000).toISOString(), now)).toBe("5m ago");
		expect(humanSince(new Date(now - 3 * 3600000).toISOString(), now)).toBe("3h ago");
		expect(humanSince(new Date(now - 4 * 86400000).toISOString(), now)).toBe("4d ago");
		expect(humanSince("garbage", now)).toBe("unknown");
	});
});

import { afterEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { DEFAULT_PROMPT, DEFAULT_SWITCH_CONTEXT } from "./prompt.ts";

mock.module("@oh-my-pi/pi-tui", () => ({ matchesKey: (data: string, key: string) => key === "ctrl+p" && data === "\x10" }));
// Load after the mock so the test isolates the extension from OMP's bundled TUI.
const { default: extension } = await import("./index.ts");

type Entry = { id: string; type: string; model?: string; role?: string; message?: { role: string } };
interface FakeTimer { fn: () => void; delay: number; cancelled: boolean }
type Handler = (event: unknown, ctx: object) => void;
const timers: FakeTimer[] = [];
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realNow = Date.now;
let now = 0;

afterEach(() => {
	globalThis.setTimeout = realSetTimeout;
	globalThis.clearTimeout = realClearTimeout;
	Date.now = realNow;
	timers.length = 0;
	now = 0;
});

function runTimer() {
	const timer = timers.find(item => !item.cancelled);
	if (!timer) throw new Error("No pending timer");
	timer.cancelled = true;
	now += timer.delay;
	timer.fn();
}

function setup() {
	const fakeSetTimeout = (fn: () => void, delay: number) => {
		const timer: FakeTimer = { fn, delay, cancelled: false };
		timers.push(timer);
		return timer;
	};
	const fakeClearTimeout = (timer: FakeTimer | undefined) => { if (timer) timer.cancelled = true; };
	// Tests replace the timer boundary with a deterministic scheduler.
	globalThis.setTimeout = fakeSetTimeout as unknown as typeof setTimeout;
	globalThis.clearTimeout = fakeClearTimeout as unknown as typeof clearTimeout;
	Date.now = () => now;
	const handlers: Record<string, Handler> = {};
	const sent: Array<[string, unknown]> = [];
	let input: ((data: string) => void) | undefined;
	let session = "session";
	let editor = "";
	let idle = true;
	let pending = false;
	const entries: Entry[] = [{ id: "first", type: "message", message: { role: "user" } }];
	const ctx = {
		mode: "tui", hasUI: true,
		model: { provider: "provider", id: "a" },
		isIdle: () => idle,
		hasPendingMessages: () => pending,
		ui: { onTerminalInput: (handler: (data: string) => void) => { input = handler; return () => { input = undefined; }; }, getEditorText: () => editor, notify: () => {} },
		sessionManager: { getSessionId: () => session, getLeafId: () => entries.at(-1)?.id ?? null, getBranch: () => entries },
	};
	const pi = { on: (event: string, handler: Handler) => { handlers[event] = handler; }, sendUserMessage: async (text: string, options: unknown) => { sent.push([text, options]); } };
	// The extension uses only the API methods represented by this test double.
	extension(pi as unknown as ExtensionAPI);
	handlers.session_start({}, ctx);
	return {
		ctx, sent, handlers,
		press: (data = "\x10") => input?.(data),
		switchTo: (id: string, role?: string) => { ctx.model.id = id; entries.push({ id: `change-${entries.length}`, type: "model_change", model: `provider/${id}`, role }); },
		setEditor: (value: string) => { editor = value; },
		setIdle: (value: boolean) => { idle = value; },
		setPending: (value: boolean) => { pending = value; },
		setSession: (value: string) => { session = value; },
		clearHistory: () => { entries.length = 0; },
	};
}

test("continues once after a confirmed cycle", () => {
	const s = setup();
	s.press(); s.switchTo("b"); runTimer();
	expect(s.sent).toEqual([[`${DEFAULT_PROMPT}\n\n${DEFAULT_SWITCH_CONTEXT.replace("{{previous_model}}", "provider/a").replace("{{new_model}}", "provider/b")}`, { attribution: "agent" }]]);
});

test("sends the destination model's configured prompt", () => {
	const dir = mkdtempSync(join(tmpdir(), "model-continue-"));
	const previous = process.env.OMP_MODEL_SWITCH_CONTINUE_CONFIG;
	try {
		const path = join(dir, "config.json");
		writeFileSync(path, JSON.stringify({ models: { "provider/b": "Review {{previous_model}} using {{new_model}}." }, switchContext: "" }));
		process.env.OMP_MODEL_SWITCH_CONTINUE_CONFIG = path;
		const s = setup(); s.press(); s.switchTo("b"); runTimer();
		expect(s.sent).toEqual([["Review provider/a using provider/b.", { attribution: "agent" }]]);
	} finally {
		if (previous === undefined) delete process.env.OMP_MODEL_SWITCH_CONTINUE_CONFIG;
		else process.env.OMP_MODEL_SWITCH_CONTINUE_CONFIG = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("waits for a recorded model change", () => {
	const s = setup();
	s.press(); s.ctx.model.id = "b"; runTimer();
	expect(s.sent).toEqual([]);
	s.switchTo("b"); runTimer();
	expect(s.sent).toHaveLength(1);
});

test("debounces multiple cycles and ignores return to original model", () => {
	const s = setup();
	s.press(); s.switchTo("b"); s.press(); s.switchTo("a"); runTimer();
	expect(s.sent).toEqual([]);
});

test("cancels on other input, a draft, or an agent start", () => {
	for (const cancel of [(s: TestSession) => s.press("x"), (s: TestSession) => s.setEditor("draft"), (s: TestSession) => s.handlers.agent_start({}, s.ctx)]) {
		const s = setup(); s.press(); s.switchTo("b"); cancel(s);
		const timer = timers.find(item => !item.cancelled);
		if (timer) runTimer();
		expect(s.sent).toEqual([]);
		timers.length = 0;
	}
});

test("does not arm while busy, queued, or editing", () => {
	for (const block of [(s: TestSession) => s.setIdle(false), (s: TestSession) => s.setPending(true), (s: TestSession) => s.setEditor("draft")]) {
		const s = setup(); block(s); s.press(); s.switchTo("b");
		expect(timers.some(item => !item.cancelled)).toBe(false);
		expect(s.sent).toEqual([]);
		timers.length = 0;
	}
});

test("stops waiting when a switch fails", () => {
	const s = setup();
	s.press();
	while (timers.some(item => !item.cancelled)) runTimer();
	expect(now).toBeGreaterThanOrEqual(10_000);
	expect(s.sent).toEqual([]);
});

test("does not continue for an automatic fallback after Ctrl-P", () => {
	const s = setup();
	s.press(); s.switchTo("b", "fallback");
	while (timers.some(item => !item.cancelled)) runTimer();
	expect(s.sent).toEqual([]);
});

test("does not start a conversation on an empty session", () => {
	const s = setup();
	s.clearHistory(); s.press(); s.switchTo("b");
	expect(timers.some(item => !item.cancelled)).toBe(false);
	expect(s.sent).toEqual([]);
});

test("does not act on automatic fallback or a changed session", () => {
	const s = setup();
	s.switchTo("b"); expect(s.sent).toEqual([]);
	s.press(); s.switchTo("c"); s.setSession("other"); runTimer();
	expect(s.sent).toEqual([]);
});

interface TestSession {
	ctx: object;
	handlers: Record<string, Handler>;
	press(data?: string): void;
	setEditor(value: string): void;
	setIdle(value: boolean): void;
	setPending(value: boolean): void;
}

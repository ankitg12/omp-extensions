#!/usr/bin/env bun
/**
 * Live end-to-end check (spends a few cents): starts OMP in RPC mode on FROM, installs a rule
 * `turns >= 1 → TO`, sends two prompts, and asserts that
 *   1. the extension announces the switch after prompt 1, and
 *   2. prompt 2's assistant message was produced by TO.
 * Usage: bun verify-live.ts [FROM] [TO]   (defaults: @smol @scout)
 * WITH_DECAY=1 also loads ../decaying-effort-omp and fails if it misreads the switch as a manual
 * effort override.
 * AFK=1 instead loads ../agent-afk-omp with rule `afk → TO (revert)` and runs prompt → /afk → /back,
 * asserting the models answering are FROM, TO, FROM.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const [from = "@smol", to = "@scout"] = process.argv.slice(2);
const dir = mkdtempSync(join(tmpdir(), "governor-live-"));
const config = join(dir, "governor.yml");
const afkMode = process.env.AFK === "1";
writeFileSync(
	config,
	afkMode
		? `rules:\n  - name: live-check\n    when: 'afk'\n    use: '${to}'\n    revert: true\n`
		: `rules:\n  - name: live-check\n    when: 'turns >= 1'\n    use: '${to}'\n`,
);

const extension = fileURLToPath(new URL("./governor.ts", import.meta.url));
const args = ["--mode", "rpc", "--no-session", "--no-tools", "--no-lsp", "--no-skills", "--no-rules", "--no-title", "--no-extensions", "--extension", extension, "--model", from];
if (process.env.WITH_DECAY === "1") args.push("--extension", fileURLToPath(new URL("../decaying-effort-omp/decaying-effort.ts", import.meta.url)));
if (afkMode) args.push("--extension", fileURLToPath(new URL("../agent-afk-omp/agent-afk.ts", import.meta.url)));
const child = spawn(process.env.OMP_BIN ?? "omp", args, {
	cwd: dir,
	stdio: ["pipe", "pipe", "inherit"],
	env: { ...process.env, OMP_GOVERNOR_CONFIG: config, OMP_GOVERNOR_LOG: join(dir, "log.jsonl") },
});
const send = (o: object) => child.stdin.write(`${JSON.stringify(o)}\n`);

/** Model of each turn (its last assistant message); a turn can have several when the agent calls tools. */
const models: string[] = [];
let turnModel = "";
const progressCalls: unknown[] = [];
let notice = "";
const notices: string[] = [];
let decayOverride = "";
let agentEnds = 0;
const timeout = setTimeout(() => finish("timeout after 90s"), 90_000);

function finish(error?: string) {
	clearTimeout(timeout);
	child.stdin.end();
	child.kill();
	const switched = /\[governor\] Rule 'live-check'/.test(notice) && models.length >= 2 && models[0] !== models[1];
	const reverted = !afkMode || (models.length >= 3 && models[2] === models[0] && notices.some(n => /no longer holds/.test(n)));
	const passed = !error && !decayOverride && switched && reverted;
	console.log(JSON.stringify({ check: "governor-live", from, to, afkMode, withDecay: process.env.WITH_DECAY === "1", turnModels: models, progressCalls, notices, decayOverride, error, passed }, null, 1));
	process.exitCode = passed ? 0 : 1;
}

createInterface({ input: child.stdout }).on("line", line => {
	// RPC events are external JSON; only the few fields read below are checked by usage.
	type RpcEvent = { type?: string; method?: string; message?: unknown };
	let ev: RpcEvent;
	try {
		ev = JSON.parse(line) as RpcEvent;
	} catch {
		return;
	}
	const msg = (typeof ev.message === "object" && ev.message !== null ? ev.message : {}) as { role?: string; provider?: string; model?: string; content?: unknown };
	if (ev.type === "ready") send({ id: "p1", type: "prompt", message: "Reply with the single word: one" });
	if (ev.type === "message_end" && msg.role === "assistant") {
		turnModel = `${msg.provider}/${msg.model}`;
		const parts = Array.isArray(msg.content) ? (msg.content as { type?: string; name?: string; arguments?: unknown }[]) : [];
		for (const p of parts) if (p.type === "toolCall" && p.name === "progress") progressCalls.push(p.arguments);
	}
	if (ev.type === "extension_ui_request" && ev.method === "notify" && String(ev.message).startsWith("[governor]")) {
		notice ||= String(ev.message);
		notices.push(String(ev.message));
	}
	if (ev.type === "extension_ui_request" && /\[decaying-effort\] Manual override/.test(String(ev.message))) decayOverride = String(ev.message);
	if (ev.type === "agent_end") {
		agentEnds++;
		models.push(turnModel);
		// agent_end handlers run after the event is emitted; give the switch a moment to land.
		const next = (message: string) => setTimeout(() => send({ id: `p${agentEnds + 1}`, type: "prompt", message }), 1500);
		if (afkMode) {
			if (agentEnds === 1) next("/afk");
			if (agentEnds === 2) next("/back");
			if (agentEnds === 3) finish();
		} else {
			if (agentEnds === 1) next("Reply with the single word: two");
			if (agentEnds === 2) finish();
		}
	}
});

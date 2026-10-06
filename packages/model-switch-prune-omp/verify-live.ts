#!/usr/bin/env bun
/**
 * Live check (spends a few cents). Runs the same scenario twice in RPC mode, once with the
 * extension and once without (--no-extensions control):
 *   1. On FROM, run three large bash outputs (~20 KB each) in separate tool calls.
 *   2. set_model to TO.
 *   3. Prompt TO with a trivial question and record its usage.input (prompt tokens).
 * Passes when the extension run bills fewer input tokens than the control.
 * Usage: bun verify-live.ts [FROM provider/id] [TO provider/id]
 *   defaults: amd-gemini/gemini-3.8-flash amd-gpt/gpt-6-luna
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const [from = "amd-gemini/gemini-3.8-flash", to = "amd-gpt/gpt-6-luna"] = process.argv.slice(2);
const [toProvider, toModelId] = to.split("/") as [string, string];
const extension = fileURLToPath(new URL("./model-switch-prune.ts", import.meta.url));

function run(withExtension: boolean): Promise<{ inputTokens: number; model: string; log: string }> {
	const { promise, resolve, reject } = Promise.withResolvers<{ inputTokens: number; model: string; log: string }>();
	{
		const dir = mkdtempSync(join(tmpdir(), "msp-live-"));
		const configPath = join(dir, "msp.json");
		const logPath = join(dir, "msp.log");
		writeFileSync(configPath, JSON.stringify({ mode: "elide", debug: true }));
		const args = ["--mode", "rpc", "--no-session", "--no-lsp", "--no-skills", "--no-rules", "--no-title", "--no-extensions", "--model", from];
		if (withExtension) args.push("--extension", extension);
		const child = spawn(process.env.OMP_BIN ?? "omp", args, {
			cwd: dir,
			stdio: ["pipe", "pipe", "inherit"],
			env: { ...process.env, OMP_MODEL_SWITCH_PRUNE_CONFIG: configPath, OMP_MODEL_SWITCH_PRUNE_LOG: logPath },
		});
		const send = (o: object) => child.stdin.write(`${JSON.stringify(o)}\n`);
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error("timeout after 180s"));
		}, 180_000);
		let agentEnds = 0;
		let toolResults = 0;
		let last = { inputTokens: 0, model: "" };
		createInterface({ input: child.stdout }).on("line", line => {
			type Usage = { input?: number; cacheRead?: number; cacheWrite?: number };
			type Ev = { type?: string; message?: { role?: string; model?: string; usage?: Usage } };
			let ev: Ev;
			try {
				ev = JSON.parse(line) as Ev;
			} catch {
				return;
			}
			if (ev.type === "ready") {
				send({
					id: "p1",
					type: "prompt",
					message:
						"Make exactly four separate bash tool calls, one after another, running each command verbatim with no pipes, head, tail or flags added: `seq 1 8000`, then `seq 8001 16000`, then `seq 16001 24000`, then `seq 24001 32000`. After the fourth, reply with the single word: done",
				});
			}
			if (ev.type === "message_end" && ev.message?.role === "toolResult") toolResults++;
			if (ev.type === "message_end" && ev.message?.role === "assistant") {
				const u = ev.message.usage;
				// Total prompt size = uncached + cache reads + cache writes (providers report cache hits separately).
				last = { inputTokens: (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0), model: ev.message.model ?? "" };
			}
			if (ev.type === "agent_end") {
				agentEnds++;
				if (agentEnds === 1) {
					if (toolResults < 4) {
						clearTimeout(timer);
						child.kill();
						reject(new Error(`expected 4 tool results, saw ${toolResults}`));
						return;
					}
					send({ id: "m", type: "set_model", provider: toProvider, modelId: toModelId });
					setTimeout(() => send({ id: "p2", type: "prompt", message: "Reply with the single word: two" }), 1500);
				} else {
					clearTimeout(timer);
					child.stdin.end();
					child.kill();
					let log = "";
					try {
						log = readFileSync(logPath, "utf8").trim();
					} catch {}
					resolve({ ...last, log });
				}
			}
		});
	}
	return promise;
}

const control = await run(false);
const treated = await run(true);
const passed = treated.inputTokens > 0 && treated.inputTokens < control.inputTokens;
console.log(JSON.stringify({ check: "model-switch-prune-live", from, to, controlInputTokens: control.inputTokens, prunedInputTokens: treated.inputTokens, answeredBy: treated.model, saved: control.inputTokens - treated.inputTokens, extensionLog: treated.log, passed }, null, 1));
process.exitCode = passed ? 0 : 1;

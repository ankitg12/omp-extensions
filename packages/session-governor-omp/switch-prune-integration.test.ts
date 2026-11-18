import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

interface Frame { type: string; id?: string; success?: boolean; status?: string; error?: string }

const MARKER = "OLDER_TOOL_RESULT_";
// The command text holds one marker; only the tool output repeats it.
const OUTPUT_MARKER = MARKER + MARKER;

function sse(delta: object, finish: string | null): string {
	const chunk = { id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] };
	return `data: ${JSON.stringify(chunk)}\n\n`;
}

// Real OMP, real provider boundary: a local OpenAI-compatible server records each request body.
for (const prune of [true, false]) test(`pruneOnModelSwitch=${prune}: new model's first request is ${prune ? "pruned" : "unpruned"}`, async () => {
	const dir = mkdtempSync(join(tmpdir(), "governor-switch-rpc-"));
	const bodies: { model: string; text: string }[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const text = await req.text();
			const parsed: unknown = JSON.parse(text);
			const model = parsed && typeof parsed === "object" && "model" in parsed ? String(parsed.model) : "";
			// OMP sends its own capability probes first; only the three test prompts count.
			const isTestRequest = text.includes("create an old tool result");
			if (isTestRequest) bodies.push({ model, text });
			const needsTool = isTestRequest && !text.includes('"role":"tool"');
			const body = needsTool
				? sse({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: `printf '${MARKER}%.0s' $(seq 1 600)` }) } }] }, null) + sse({}, "tool_calls")
				: sse({ role: "assistant", content: "done" }, null) + sse({}, "stop");
			return new Response(`${body}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
		},
	});
	const agentDir = join(dir, "agent");
	const modelEntry = (id: string) => `      - id: ${id}\n        name: ${id}\n        contextWindow: 128000\n        maxTokens: 1000\n`;
	writeFileSync(join(dir, "governor.yml"), `enabled: true\nagents: [main]\npruneOnModelSwitch: ${prune}\nprune:\n  style: aggressive\nrules: []\n`);
	await Bun.write(join(agentDir, "models.yml"),
		`providers:\n  mock:\n    baseUrl: http://127.0.0.1:${server.port}/v1\n    apiKey: test\n    api: openai-completions\n    models:\n${modelEntry("old")}${modelEntry("new")}`);
	const extension = fileURLToPath(new URL("./governor.ts", import.meta.url));
	const child = spawn(process.env.OMP_BIN ?? "omp", ["--mode", "rpc", "--no-session", "--no-lsp", "--no-skills", "--no-rules", "--no-title", "--no-extensions", "--tools", "bash", "--extension", extension], {
		cwd: dir,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, OMP_GOVERNOR_CONFIG: join(dir, "governor.yml") },
	});
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", chunk => { stderr += chunk; });
	const frames = createInterface({ input: child.stdout });
	const send = (frame: object) => child.stdin.write(`${JSON.stringify(frame)}\n`);
	const { promise: finished, resolve, reject } = Promise.withResolvers<void>();
	child.once("error", reject);
	child.once("exit", code => { if (code !== 0 && code !== null) reject(new Error(`OMP exited ${code}: ${stderr}`)); });
	frames.on("line", line => {
		let frame: Frame;
		try { frame = JSON.parse(line) as Frame; } catch { return; }
		if (frame.type === "response" && frame.success === false) return reject(new Error(`${frame.id}: ${frame.error}`));
		if (frame.type === "ready") send({ id: "old", type: "set_model", provider: "mock", modelId: "old" });
		if (frame.type === "response" && frame.id === "old") send({ id: "first", type: "prompt", message: "create an old tool result" });
		if (frame.type === "prompt_result" && frame.id === "first") {
			if (frame.status !== "completed") return reject(new Error(`First prompt: ${frame.status} ${frame.error ?? ""}`));
			send({ id: "second", type: "prompt", message: "finish the previous exchange" });
		}
		if (frame.type === "prompt_result" && frame.id === "second") {
			if (frame.status !== "completed") return reject(new Error(`Second prompt: ${frame.status} ${frame.error ?? ""}`));
			send({ id: "new", type: "set_model", provider: "mock", modelId: "new" });
		}
		if (frame.type === "response" && frame.id === "new") send({ id: "third", type: "prompt", message: "continue" });
		if (frame.type === "prompt_result" && frame.id === "third") {
			if (frame.status !== "completed") reject(new Error(`Third prompt: ${frame.status} ${frame.error ?? ""}`));
			else resolve();
		}
	});
	try {
		await finished;
		const before = bodies.filter(b => b.model === "old");
		const after = bodies.filter(b => b.model === "new");
		expect(before.some(b => b.text.includes(OUTPUT_MARKER))).toBe(true);
		expect(after.length).toBeGreaterThan(0);
		expect(after[0].text.includes(OUTPUT_MARKER)).toBe(!prune);
		expect(after[0].text.includes("[elided")).toBe(prune);
	} finally {
		child.kill();
		frames.close();
		await server.stop(true);
		rmSync(dir, { recursive: true, force: true });
	}
}, 60_000);

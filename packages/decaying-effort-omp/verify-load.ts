#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const extension = fileURLToPath(new URL("./decaying-effort.ts", import.meta.url));
const args = ["--mode", "rpc", "--no-session", "--no-tools", "--no-lsp", "--no-skills", "--no-rules", "--no-title", "--extension", extension];
const child = spawn(process.env.OMP_BIN ?? "omp", args, {
	cwd: tmpdir(),
	stdio: ["pipe", "pipe", "pipe"],
});

let ready = false;
let found = false;
let notified = false;
let failed = false;

function fail(message: string) {
	if (failed) return;
	failed = true;
	console.error(message);
	child.stdin.end();
	child.kill();
}

const timeout = setTimeout(() => fail("FAIL: timeout after 8s"), 8000);

const lines = createInterface({ input: child.stdout });
lines.on("line", line => {
	let parsed: any;
	try { parsed = JSON.parse(line); } catch { return; }
	if (parsed.type === "ready") {
		ready = true;
		child.stdin.write(JSON.stringify({ id: "check-cmds", type: "get_available_commands" }) + "\n");
	}
	if (parsed.type === "response" && parsed.id === "check-cmds") {
		const commands = parsed.data?.commands;
		found = Array.isArray(commands) && commands.some((c: any) => c.name === "effort-decay");
		if (found) {
			child.stdin.write(JSON.stringify({ id: "cmd-status", type: "prompt", message: "/effort-decay" }) + "\n");
		} else {
			fail("FAIL: /effort-decay command not found. Available: " + JSON.stringify(commands?.map((c: any) => c.name)));
		}
	}
	if (parsed.type === "extension_ui_request" && parsed.method === "notify" && /Decaying effort:/.test(parsed.message)) {
		notified = true;
		console.log("NOTIFY:", parsed.message);
		child.stdin.end();
	}
});

child.on("close", code => {
	clearTimeout(timeout);
	lines.close();
	const passed = !failed && code === 0 && ready && found && notified;
	console.log(JSON.stringify({ check: "decaying-effort-extension-load", ready, found, notified, code, passed }));
	process.exitCode = passed ? 0 : 1;
});

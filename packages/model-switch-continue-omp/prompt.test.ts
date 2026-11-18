import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPrompt, DEFAULT_PROMPT, DEFAULT_SWITCH_CONTEXT, loadPromptConfig } from "./prompt.ts";

test("missing or malformed config uses the default", () => {
	const dir = mkdtempSync(join(tmpdir(), "model-continue-"));
	try {
		const path = join(dir, "config.json");
		expect(loadPromptConfig(path)).toEqual({ prompt: DEFAULT_PROMPT, switchContext: DEFAULT_SWITCH_CONTEXT, models: {} });
		writeFileSync(path, "{");
		expect(loadPromptConfig(path).prompt).toBe(DEFAULT_PROMPT);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("target model selects its prompt and substitutes both model IDs", () => {
	const dir = mkdtempSync(join(tmpdir(), "model-continue-"));
	try {
		const path = join(dir, "config.json");
		writeFileSync(path, JSON.stringify({
			prompt: "Continue normally.",
			switchContext: "Switched {{previous_model}} to {{new_model}}.",
			models: { "provider/new": "Review {{previous_model}}'s work as {{new_model}}." },
		}));
		const config = loadPromptConfig(path);
		expect(buildPrompt(config, "provider/old", "provider/new")).toBe("Review provider/old's work as provider/new.\n\nSwitched provider/old to provider/new.");
		expect(buildPrompt(config, "provider/old", "provider/other")).toBe("Continue normally.\n\nSwitched provider/old to provider/other.");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("empty switch context omits model details and replacement is literal", () => {
	const config = { prompt: "Use {{new_model}} after {{previous_model}}.", switchContext: "", models: {} };
	expect(buildPrompt(config, "old/$&", "new/$1")).toBe("Use new/$1 after old/$&.");
});

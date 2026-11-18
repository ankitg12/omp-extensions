import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_PATH = join(homedir(), ".omp", "agent", "model-switch-continue.json");
export const DEFAULT_PROMPT = "Continue. Resume the most recent intent and complete unfinished work. If interrupted mid-step, resume where stopped. Do not pause to summarize progress, re-confirm the plan, or ask whether to proceed.";
export const DEFAULT_SWITCH_CONTEXT = "The user switched the model from {{previous_model}} to {{new_model}}.";

export interface PromptConfig {
	prompt: string;
	switchContext: string;
	models: Record<string, string>;
}

export function loadPromptConfig(path = process.env.OMP_MODEL_SWITCH_CONTINUE_CONFIG ?? CONFIG_PATH): PromptConfig {
	const defaults: PromptConfig = { prompt: DEFAULT_PROMPT, switchContext: DEFAULT_SWITCH_CONTEXT, models: {} };
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaults;
		const config = parsed as Record<string, unknown>;
		const models: Record<string, string> = {};
		if (config.models && typeof config.models === "object" && !Array.isArray(config.models)) {
			for (const [model, prompt] of Object.entries(config.models)) {
				if (typeof prompt === "string" && prompt.trim()) models[model] = prompt;
			}
		}
		return {
			prompt: typeof config.prompt === "string" && config.prompt.trim() ? config.prompt : defaults.prompt,
			switchContext: typeof config.switchContext === "string" ? config.switchContext : defaults.switchContext,
			models,
		};
	} catch {
		return defaults;
	}
}

export function buildPrompt(config: PromptConfig, previousModel: string, newModel: string): string {
	const prompt = config.models[newModel] ?? config.prompt;
	return [prompt, config.switchContext].filter(Boolean).join("\n\n")
		.replaceAll("{{previous_model}}", () => previousModel)
		.replaceAll("{{new_model}}", () => newModel);
}

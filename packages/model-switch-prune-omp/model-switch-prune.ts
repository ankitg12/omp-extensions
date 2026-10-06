/**
 * model-switch-prune-omp: after a model switch, shrink history the new model does not need.
 *
 * At the `context` hook, tool turns whose provenance (api/provider/model) differs from the
 * active model are "foreign". Their tool calls are removed and their results are folded into
 * user messages, with oversized older results elided (head + tail). The 2 most recent foreign
 * results stay whole. Native turns are never touched.
 *
 * Wire-only: the persisted session file is unchanged, and switching back restores the turns.
 * Foreignness depends on message provenance, not position, so the pruned prefix is identical on
 * every request after a switch (only the first post-switch request is cache-cold).
 *
 * Config: ~/.omp/agent/model-switch-prune.json  { "mode": "elide"|"drop"|"keep", "debug": bool }
 */
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, Model, TextContent, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export type PruneMode = "elide" | "drop" | "keep";

export interface PruneConfig {
	mode: PruneMode;
	debug: boolean;
}

export interface PruneStats {
	foreignCalls: number;
	foreignResults: number;
	kept: number;
	elided: number;
	dropped: number;
	charsBefore: number;
	charsAfter: number;
}

export const CONFIG_PATH = join(homedir(), ".omp", "agent", "model-switch-prune.json");
export const DEBUG_LOG_PATH = join(homedir(), ".omp", "agent", "model-switch-prune.log");
export const ELIDE_MIN_CHARS = 6000;
export const ELIDE_HEAD_CHARS = 1500;
export const ELIDE_TAIL_CHARS = 500;
/** Most recent foreign results kept whole; they still carry live relevance. */
export const PROTECT_RECENT = 2;

const DEFAULT_CONFIG: PruneConfig = { mode: "elide", debug: false };

type ModelProvenance = Pick<Model, "api" | "provider" | "id">;

export function loadConfig(path = CONFIG_PATH): PruneConfig {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return DEFAULT_CONFIG;
		const { mode, debug } = parsed as Record<string, unknown>;
		if (mode !== undefined && mode !== "elide" && mode !== "drop" && mode !== "keep") return DEFAULT_CONFIG;
		if (debug !== undefined && typeof debug !== "boolean") return DEFAULT_CONFIG;
		return { mode: (mode as PruneMode | undefined) ?? "elide", debug: debug ?? false };
	} catch {
		return DEFAULT_CONFIG;
	}
}

export function elideResult(text: string): string {
	if (text.length <= ELIDE_MIN_CHARS) return text;
	const dropped = text.length - ELIDE_HEAD_CHARS - ELIDE_TAIL_CHARS;
	return `${text.slice(0, ELIDE_HEAD_CHARS)}\n[elided ${dropped} chars of a tool result from an earlier model; full output is in the session log]\n${text.slice(-ELIDE_TAIL_CHARS)}`;
}

function isForeignToolTurn(message: AgentMessage, model: ModelProvenance): message is AssistantMessage {
	return (
		message.role === "assistant" &&
		message.content.some(part => part.type === "toolCall") &&
		(message.api !== model.api || message.provider !== model.provider || message.model !== model.id)
	);
}

function userParts(content: UserMessage["content"]): (TextContent | ImageContent)[] {
	return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

function textOf(message: ToolResultMessage): string {
	return message.content.map(part => (part.type === "text" ? part.text : "[image - see attached]")).join("\n");
}

export function pruneForeignHistory(
	messages: AgentMessage[],
	model: ModelProvenance,
	mode: PruneMode = "elide",
	stats?: PruneStats,
): AgentMessage[] {
	const foreignCalls = new Map<string, string>();
	for (const message of messages) {
		if (!isForeignToolTurn(message, model)) continue;
		for (const part of message.content) if (part.type === "toolCall") foreignCalls.set(part.id, part.name);
	}
	if (stats) stats.foreignCalls = foreignCalls.size;
	if (foreignCalls.size === 0) return messages;

	const resultIdx = messages.flatMap((m, i) => (m.role === "toolResult" && foreignCalls.has(m.toolCallId) ? [i] : []));
	const keepFullFrom = resultIdx[Math.max(0, resultIdx.length - PROTECT_RECENT)];
	const out: AgentMessage[] = [];

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (isForeignToolTurn(message, model)) {
			const content = message.content.filter(part => part.type !== "toolCall");
			if (content.length > 0) out.push({ ...message, content });
			continue;
		}
		const callName = message.role === "toolResult" ? foreignCalls.get(message.toolCallId) : undefined;
		if (message.role !== "toolResult" || callName === undefined) {
			out.push(message);
			continue;
		}
		const text = textOf(message);
		if (stats) {
			stats.foreignResults++;
			stats.charsBefore += text.length;
		}
		if (mode === "drop") {
			if (stats) stats.dropped++;
			continue;
		}
		const protectedResult = mode === "keep" || keepFullFrom === undefined || i >= keepFullFrom;
		const elided = !protectedResult && text.length > ELIDE_MIN_CHARS;
		const body = elided ? elideResult(text) : text;
		if (stats) {
			stats[elided ? "elided" : "kept"]++;
			stats.charsAfter += body.length;
		}
		const images = message.content.filter((p): p is ImageContent => p.type === "image");
		const next: UserMessage = {
			role: "user",
			content: [{ type: "text", text: `[result of ${callName}]\n${body}` }, ...images],
			timestamp: message.timestamp,
		};
		const prev = out.at(-1);
		if (prev?.role === "user") {
			out[out.length - 1] = { ...prev, content: [...userParts(prev.content), ...userParts(next.content)] };
		} else {
			out.push(next);
		}
	}
	return out;
}

export default function modelSwitchPrune(pi: ExtensionAPI, options: { configPath?: string; debugLogPath?: string } = {}): void {
	const config = loadConfig(options.configPath);
	const logPath = options.debugLogPath ?? DEBUG_LOG_PATH;

	pi.on("context", (event, ctx) => {
		const model = ctx.model;
		if (!model) return;
		const stats: PruneStats = { foreignCalls: 0, foreignResults: 0, kept: 0, elided: 0, dropped: 0, charsBefore: 0, charsAfter: 0 };
		const messages = pruneForeignHistory(event.messages, model, config.mode, stats);
		if (config.debug && stats.foreignCalls > 0) {
			try {
				appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), model: model.id, ...stats })}\n`);
			} catch {}
		}
		if (messages === event.messages) return;
		return { messages };
	});
}

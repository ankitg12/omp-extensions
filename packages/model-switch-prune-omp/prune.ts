/**
 * Wire-only context pruning. Pure functions applied at the `context` hook; the persisted session
 * file is never changed. Pass 1 is applied by model-switch-prune.ts (always on); pass 2 by
 * session-governor-omp, which imports this file.
 *
 * Two independent passes, both cache-stable by construction:
 *
 * 1. Foreign pruning (automatic). Tool turns whose provenance (api/provider/model) differs from
 *    the active model are "foreign". Their tool calls are removed and their results are folded
 *    into user messages, with oversized older results elided (head + tail). The 2 most recent
 *    foreign results stay whole. Foreignness depends on provenance, not position, so the pruned
 *    prefix is identical on every request after a switch (only the first one is cache-cold).
 *
 * 2. Epoch pruning (governor rule, `prune: true`). When a rule fires, the governor latches a cut
 *    timestamp. Every tool result older than the cut is elided. The cut changes only when a rule
 *    fires again, so the request prefix stays byte-identical between firings. A cut that moved
 *    every turn would make every request cache-cold and cost more than it saves.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, Model, TextContent, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";

export type ForeignMode = "elide" | "drop" | "keep";

export interface PruneStats {
	foreignCalls: number;
	foreignResults: number;
	kept: number;
	elided: number;
	dropped: number;
	/** Tool results elided by the epoch cut. */
	epochElided: number;
	charsBefore: number;
	charsAfter: number;
}

export interface ElideShape {
	minChars: number;
	headChars: number;
	tailChars: number;
}

/** Foreign results: generous, because they may still matter to the new model. */
export const FOREIGN_SHAPE: ElideShape = { minChars: 6000, headChars: 1500, tailChars: 500 };
/** Epoch results: older than a latched cut, so a short head + tail suffices by default. */
export const EPOCH_SHAPE: ElideShape = { minChars: 2000, headChars: 600, tailChars: 300 };
/** Most recent foreign results kept whole; they still carry live relevance. */
export const PROTECT_RECENT = 2;

export const emptyStats = (): PruneStats => ({
	foreignCalls: 0,
	foreignResults: 0,
	kept: 0,
	elided: 0,
	dropped: 0,
	epochElided: 0,
	charsBefore: 0,
	charsAfter: 0,
});

type ModelProvenance = Pick<Model, "api" | "provider" | "id">;

export function elideText(text: string, shape: ElideShape, what: string): string {
	if (text.length <= shape.minChars) return text;
	const dropped = text.length - shape.headChars - shape.tailChars;
	if (dropped <= 0) return text;
	// slice(-0) is the whole string, so a zero tail must be explicit.
	const tail = shape.tailChars > 0 ? text.slice(-shape.tailChars) : "";
	return `${text.slice(0, shape.headChars)}\n[elided ${dropped} chars of ${what}; full output is in the session log]\n${tail}`;
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

/**
 * Elide every tool result with `timestamp < cutTs`. Tool calls and message structure are kept, so
 * the result is valid for every provider. Returns the input by identity when nothing changes.
 */
export function pruneBeforeCut(messages: AgentMessage[], cutTs: number, shape: ElideShape = EPOCH_SHAPE, stats?: PruneStats): AgentMessage[] {
	let changed = false;
	const out = messages.map(message => {
		if (message.role !== "toolResult" || !(message.timestamp < cutTs)) return message;
		const text = message.content
			.filter((p): p is TextContent => p.type === "text")
			.map(p => p.text)
			.join("\n");
		const body = elideText(text, shape, "an older tool result");
		if (body === text) return message;
		changed = true;
		if (stats) {
			stats.epochElided++;
			stats.charsBefore += text.length;
			stats.charsAfter += body.length;
		}
		const images = message.content.filter((p): p is ImageContent => p.type === "image");
		return { ...message, content: [{ type: "text" as const, text: body }, ...images] };
	});
	return changed ? out : messages;
}

export function pruneForeignHistory(
	messages: AgentMessage[],
	model: ModelProvenance,
	mode: ForeignMode = "elide",
	stats?: PruneStats,
): AgentMessage[] {
	if (mode === "keep") return messages;
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
		const protectedResult = keepFullFrom === undefined || i >= keepFullFrom;
		const body = protectedResult ? text : elideText(text, FOREIGN_SHAPE, "a tool result from an earlier model");
		if (stats) {
			stats[body !== text ? "elided" : "kept"]++;
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

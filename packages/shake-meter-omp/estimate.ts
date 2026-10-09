/**
 * Estimate what a manual `/shake` would free, without running it.
 *
 * Mirrors `collectShakeRegions(branch, tokenizer, AGGRESSIVE_SHAKE_CONFIG)` in
 * oh-my-pi `packages/agent/src/compaction/shake.ts`. The compiled `omp` binary does not
 * let an extension import that code at runtime, so the rules are restated here:
 *
 * - keep the newest 4 000 tokens of the branch intact (the protect window);
 * - skip entries before the latest compaction's first kept entry (never sent);
 * - tool results: every one outside the window, unless already shaken (`prunedAt`),
 *   from the `skill` tool, or a `read` of `skill://…`; a `useless` result is eligible
 *   even inside the window;
 * - blocks: fenced (``` / ~~~) or top-level XML spans of at least 400 tokens inside
 *   user, developer, assistant text, or custom messages.
 *
 * Tokens are chars/4; OMP uses its model tokenizer, so expect a small difference.
 * Plan-file protection (`#withPlanProtection`) is not mirrored.
 */

export const PROTECT_TOKENS = 4_000;
export const FENCE_MIN_TOKENS = 400;
/** Approximate tokens of one `[shaken ~N tokens — recover: artifact://N (region N)]` line. */
export const PLACEHOLDER_TOKENS = 20;

export const tokensOf = (chars: number): number => Math.ceil(chars / 4);

interface Block {
	type: string;
	text?: string;
	thinking?: string;
	thinkingSignature?: string;
	data?: string;
	block?: unknown;
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}
interface Message {
	role: string;
	content: string | Block[];
	toolName?: string;
	toolCallId?: string;
	prunedAt?: number;
	useless?: boolean;
	isError?: boolean;
}
/** The subset of an OMP `SessionEntry` this estimator reads. */
export interface Entry {
	type: string;
	id?: string;
	message?: Message;
	content?: string | Block[];
	firstKeptEntryId?: string;
}

export interface ShakeEstimate {
	/** Estimated tokens `/shake` would free: sum of (region − placeholder), floored at 0. */
	tokens: number;
	toolResults: number;
	blocks: number;
}

const textsOf = (content: string | Block[] | undefined): string[] =>
	content === undefined
		? []
		: typeof content === "string"
			? [content]
			: content.flatMap(b => (b.type === "text" && typeof b.text === "string" ? [b.text] : []));

/**
 * Characters `Tokenizer.countMessage` would see (oh-my-pi `packages/agent/src/tokenizer.ts`
 * `#measureMessage`). Thinking text and its signature dominate assistant turns; leaving them
 * out made the protect window reach too far back and the meter read 0 while /shake freed 2.5k.
 */
function entryChars(entry: Entry): number {
	if (entry.type === "message" && entry.message) {
		const m = entry.message;
		if (m.role !== "assistant" || !Array.isArray(m.content)) return textsOf(m.content).reduce((n, t) => n + t.length, 0);
		let chars = 0;
		for (const b of m.content) {
			if (b.type === "text") chars += b.text?.length ?? 0;
			else if (b.type === "thinking") chars += (b.thinking?.length ?? 0) + (b.thinkingSignature?.length ?? 0);
			else if (b.type === "toolCall") chars += (b.name?.length ?? 0) + JSON.stringify(b.arguments ?? null).length;
			else if (b.type === "redactedThinking") chars += b.data?.length ?? 0;
			else if (b.type === "anthropicServerTool") chars += JSON.stringify(b.block ?? null).length;
		}
		return chars;
	}
	if (entry.type === "custom_message") return textsOf(entry.content).reduce((n, t) => n + t.length, 0);
	return 0;
}

const OPENING_XML = /^<([a-z_-]+)(?:\s+[^>]*)?>$/;
const CLOSING_XML = /^<\/([a-z_-]+)>$/;

/** Fenced and top-level XML spans, outermost only; same toggling as shake.ts `scanTextForBlockRanges`. */
export function blockRanges(text: string): Array<{ start: number; end: number }> {
	const ranges: Array<{ start: number; end: number }> = [];
	let inFence = false;
	let fenceStart = -1;
	const tags: string[] = [];
	let xmlStart = -1;
	let lineStart = 0;
	for (let i = 0; i <= text.length; i++) {
		if (i !== text.length && text[i] !== "\n") continue;
		const line = text.slice(lineStart, i);
		const trimmed = line.trimStart();
		if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
			if (!inFence) {
				inFence = true;
				fenceStart = lineStart;
			} else {
				inFence = false;
				ranges.push({ start: fenceStart, end: i });
			}
			lineStart = i + 1;
			continue;
		}
		if (!inFence) {
			const open = line.length === trimmed.length ? OPENING_XML.exec(trimmed) : null;
			if (open) {
				if (tags.length === 0) xmlStart = lineStart;
				tags.push(open[1]);
			} else {
				const close = CLOSING_XML.exec(trimmed);
				if (close && tags.at(-1) === close[1]) {
					tags.pop();
					if (tags.length === 0 && xmlStart >= 0) {
						ranges.push({ start: xmlStart, end: i });
						xmlStart = -1;
					}
				}
			}
		}
		lineStart = i + 1;
	}
	ranges.sort((a, b) => a.start - b.start);
	const kept: typeof ranges = [];
	let lastEnd = -1;
	for (const r of ranges) {
		if (r.start < lastEnd) continue;
		kept.push(r);
		lastEnd = r.end;
	}
	return kept;
}

function isProtected(m: Message, call: Block | undefined): boolean {
	if (m.toolName === "skill") return true;
	if (m.toolName !== "read" || call?.name !== "read") return false;
	const path = call.arguments?.path;
	return typeof path === "string" && path.startsWith("skill://");
}

export function estimateShake(entries: readonly Entry[]): ShakeEstimate {
	const n = entries.length;
	const after = new Array<number>(n);
	let acc = 0;
	for (let i = n - 1; i >= 0; i--) {
		after[i] = acc;
		acc += tokensOf(entryChars(entries[i]));
	}

	const calls = new Map<string, Block>();
	let boundaryId: string | undefined;
	for (const e of entries) {
		if (e.type === "compaction") boundaryId = e.firstKeptEntryId;
		if (e.type === "message" && e.message?.role === "assistant" && Array.isArray(e.message.content))
			for (const b of e.message.content) if (b.type === "toolCall" && b.id) calls.set(b.id, b);
	}
	const boundary = boundaryId === undefined ? 0 : Math.max(0, entries.findIndex(e => e.id === boundaryId));

	const out: ShakeEstimate = { tokens: 0, toolResults: 0, blocks: 0 };
	const add = (chars: number, kind: "toolResults" | "blocks") => {
		out.tokens += Math.max(0, tokensOf(chars) - PLACEHOLDER_TOKENS);
		out[kind]++;
	};
	for (let i = boundary; i < n; i++) {
		const e = entries[i];
		const m = e.type === "message" ? e.message : undefined;
		if (m?.role === "toolResult") {
			const useless = m.useless === true && m.isError !== true;
			if (!useless && after[i] < PROTECT_TOKENS) continue;
			if (m.prunedAt !== undefined || isProtected(m, calls.get(m.toolCallId ?? ""))) continue;
			const texts = textsOf(m.content);
			if (texts.length === 0) continue;
			add(texts.reduce((c, t) => c + t.length, 0) + texts.length - 1, "toolResults");
			continue;
		}
		if (after[i] < PROTECT_TOKENS) continue;
		const scan =
			e.type === "custom_message"
				? textsOf(e.content)
				: m && ["user", "developer", "assistant"].includes(m.role)
					? textsOf(m.content)
					: [];
		for (const text of scan)
			for (const r of blockRanges(text)) {
				const chars = r.end - r.start;
				if (chars > 0 && tokensOf(chars) >= FENCE_MIN_TOKENS) add(chars, "blocks");
			}
	}
	return out;
}

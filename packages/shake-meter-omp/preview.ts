/**
 * What `/shake` would free now, computed by OMP's own code: `collectShakeRegions` with
 * `AGGRESSIVE_SHAKE_CONFIG` and the model's native tokenizer — the same three things `/shake`
 * uses (`session-maintenance.ts`, `shake()`). Freed = Σ region.tokens − Σ placeholder tokens.
 *
 * `@oh-my-pi/pi-agent-core` resolves only inside OMP (the extension loader routes the bare
 * specifier to the in-process module). Outside OMP (unit tests), or if that import ever fails,
 * fall back to the restated rules in estimate.ts, which count chars/4. Claude tokenizers measure
 * ~2.2 chars/token on tool output, so the fallback undercounts by about half.
 */
import { type Entry, estimateShake } from "./estimate";

export interface ShakePreview {
	tokens: number;
	toolResults: number;
	blocks: number;
	/** `omp`: OMP's own region finder + tokenizer. `estimate`: chars/4 fallback. */
	source: "omp" | "estimate";
}

interface Region {
	kind: "toolResult" | "block";
	tokens: number;
}
interface TokenizerLike {
	countTokens(text: string): number;
}
interface Core {
	collectShakeRegions(entries: unknown[], tokenizer: TokenizerLike, config: unknown): Region[];
	AGGRESSIVE_SHAKE_CONFIG: unknown;
	Tokenizer: new (model?: unknown) => TokenizerLike;
}

/** Shape of the marker `/shake` leaves behind; only its token count matters. */
const PLACEHOLDER = "[shaken ~1234 tokens — recover: artifact://62 (region 12)]";

let core: Core | null | undefined;
let loadError: string | undefined;
const tokenizers = new Map<string, { tokenizer: TokenizerLike; placeholder: number }>();

/** Resolve OMP's shake code once. Returns the error text when it is unavailable. */
export async function loadShakeCore(): Promise<string | undefined> {
	if (core !== undefined) return loadError;
	try {
		// Dynamic on purpose: this module exists only inside the OMP host process; a static
		// import would make the extension fail to load anywhere else (tests, a future rename).
		const mod = (await import("@oh-my-pi/pi-agent-core")) as unknown as Partial<Core>;
		if (typeof mod.collectShakeRegions !== "function" || typeof mod.Tokenizer !== "function" || !mod.AGGRESSIVE_SHAKE_CONFIG)
			throw new Error("pi-agent-core lacks collectShakeRegions/Tokenizer/AGGRESSIVE_SHAKE_CONFIG");
		core = mod as Core;
	} catch (err) {
		core = null;
		loadError = err instanceof Error ? err.message : String(err);
	}
	return loadError;
}

function tokenizerFor(c: Core, model: { tokenizer?: string } | undefined) {
	const key = model?.tokenizer ?? "";
	let t = tokenizers.get(key);
	if (!t) {
		const tokenizer = new c.Tokenizer(model);
		t = { tokenizer, placeholder: tokenizer.countTokens(PLACEHOLDER) };
		tokenizers.set(key, t);
	}
	return t;
}

/** Tokens a no-argument `/shake` would free from this branch now. */
export function previewShake(entries: unknown[], model?: { tokenizer?: string }): ShakePreview {
	if (!core) return { ...estimateShake(entries as Entry[]), source: "estimate" };
	const { tokenizer, placeholder } = tokenizerFor(core, model);
	const regions = core.collectShakeRegions(entries, tokenizer, core.AGGRESSIVE_SHAKE_CONFIG);
	let tokens = 0;
	let toolResults = 0;
	for (const r of regions) {
		tokens += r.tokens - placeholder;
		if (r.kind === "toolResult") toolResults++;
	}
	return { tokens: Math.max(0, tokens), toolResults, blocks: regions.length - toolResults, source: "omp" };
}

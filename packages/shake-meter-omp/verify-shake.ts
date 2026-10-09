#!/usr/bin/env bun
/**
 * Replay one real `/shake` and check the meter against it.
 *
 *   bun verify-shake.ts <session.jsonl> <artifact-number> [tokenizer]
 *   e.g. bun verify-shake.ts ~/.omp/agent/sessions/-agents-jeeves/<id>.jsonl 62 claude-v5
 *
 * Rebuilds the branch as it was just before the shake (puts each `artifact://N (region K)` text
 * back, clears that shake's `prunedAt`, drops later entries), then prints:
 *   - `artifact`: Σ of the `~N tok` region headers OMP wrote (what /shake measured),
 *   - `omp`:      preview.ts math on OMP's own collectShakeRegions + tokenizer (from OMP_SRC),
 *   - `estimate`: the chars/4 fallback in estimate.ts.
 * Region text in the artifact is the removed text, so the rebuild is close, not byte-exact.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { type Entry, estimateShake } from "./estimate";

const [sessionPath, artifactNo, tokenizerName] = process.argv.slice(2);
if (!sessionPath || !artifactNo) {
	console.error("usage: bun verify-shake.ts <session.jsonl> <artifact-number> [tokenizer]");
	process.exit(2);
}
const artifactPath = join(sessionPath.replace(/\.jsonl$/, ""), `${artifactNo}.shake.log`);
const art = readFileSync(artifactPath, "utf8");
const heads = [...art.matchAll(/^### (?:region|block) (\d+) \((.+?), ~(\d+) tok\)$/gm)];
const bodies = new Map<string, string>();
heads.forEach((m, i) => {
	const end = heads[i + 1]?.index ?? art.length;
	bodies.set(m[1], art.slice(m.index + m[0].length, end).replace(/^\n+|\n+$/g, ""));
});
const artifactTokens = heads.reduce((s, m) => s + Number(m[3]), 0);

const marker = new RegExp(`\\[shaken ~\\d+ tokens — recover: artifact://${artifactNo} \\(region (\\d+)\\)\\]`, "g");
const lines = readFileSync(sessionPath, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
let shakeTs: number | undefined;
const restore = (v: unknown): unknown => {
	if (typeof v === "string") return v.replace(marker, (_m, k: string) => bodies.get(k) ?? _m);
	if (Array.isArray(v)) return v.map(restore);
	if (v && typeof v === "object") {
		const o = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, restore(x)]));
		return o;
	}
	return v;
};
const touched = (e: unknown) => JSON.stringify(e).includes(`artifact://${artifactNo} (region `);
// Later entries can quote the marker (e.g. this investigation's own tool output) and carry a
// later shake's prunedAt, so the shake time is the earliest prunedAt among marker-bearing entries.
for (const e of lines)
	if (touched(e) && typeof e.message?.prunedAt === "number") shakeTs = Math.min(shakeTs ?? Infinity, e.message.prunedAt);
if (shakeTs === undefined) throw new Error(`no entry carries artifact://${artifactNo}`);
const branch = lines
	.filter(e => Date.parse(e.timestamp ?? "") <= shakeTs!)
	.map(e => {
		if (!touched(e)) return e;
		const r = restore(e) as typeof e;
		if (r.message?.prunedAt === shakeTs) delete r.message.prunedAt;
		return r;
	});

const ompSrc = process.env.OMP_SRC ?? join(homedir(), "repos/github.com/can1357/oh-my-pi");
// Dynamic: the OMP source tree path is chosen at run time (OMP_SRC).
const core = await import(join(ompSrc, "packages/agent/src/index.ts"));
const model = tokenizerName ? { tokenizer: tokenizerName } : undefined;
const tokenizer = new core.Tokenizer(model);
const placeholder = tokenizer.countTokens(`[shaken ~1234 tokens — recover: artifact://${artifactNo} (region 12)]`);
const regions = core.collectShakeRegions(branch, tokenizer, core.AGGRESSIVE_SHAKE_CONFIG) as { kind: string; tokens: number }[];
const omp = regions.reduce((s, r) => s + r.tokens - placeholder, 0);

console.log(
	JSON.stringify({
		session: basename(sessionPath),
		artifact: Number(artifactNo),
		shakeAt: new Date(shakeTs).toISOString(),
		tokenizer: tokenizerName ?? "(byte estimate)",
		artifactRegions: heads.length,
		artifactTokens,
		ompRegions: regions.length,
		ompRegionTokens: regions.reduce((s, r) => s + r.tokens, 0),
		omp,
		estimate: estimateShake(branch as Entry[]),
	}),
);

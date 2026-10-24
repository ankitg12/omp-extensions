/**
 * spotlight-omp — fast filename search on macOS via the Spotlight index.
 *
 * Prefer this over `glob` when you know (part of) the file or directory name
 * and don't know which root it lives under. Root-agnostic, near-instant.
 * Falls back to nothing: fresh files lag the indexer, excluded paths are
 * invisible — use `glob` when ground truth matters.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { platform } from "node:os";

export const SPOTLIGHT_TOOL = "spotlight";

export const SPOTLIGHT_DESCRIPTION =
	"Fast filename search on macOS via the Spotlight index (mdfind). " +
	"Prefer over glob when you know (part of) the name but not the root directory. " +
	"macOS only. Index may lag fresh files; excluded paths are invisible.";

function searchSpotlight(name: string, onlyIn?: string, limit?: number): string[] {
	const query = `kMDItemFSName == '*${name.replace(/'/g, "\\'")}*'cd`;
	const args = ["-name", query];
	if (onlyIn) {
		args.push("-onlyin", onlyIn);
	}
	const out = execFileSync("mdfind", args, { encoding: "utf8", timeout: 10000 });
	const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
	return limit !== undefined ? lines.slice(0, limit) : lines;
}

export default function registerSpotlightTool(pi: ExtensionAPI): void {
	const T = pi.typebox.Type;
	pi.registerTool({
		name: SPOTLIGHT_TOOL,
		label: "Spotlight",
		description: SPOTLIGHT_DESCRIPTION,
		approval: "read",
		parameters: T.Object({
			name: T.String({ description: "Filename (or substring) to look up, e.g. agent-dream-omp" }),
			onlyin: T.Optional(T.String({ description: "Restrict search to this directory" })),
			limit: T.Optional(T.Number({ description: "Max results (default 30)" })),
		}),
		async execute(_id, params) {
			if (platform() !== "darwin") {
				return { content: [{ type: "text" as const, text: "spotlight: macOS only (mdfind unavailable)" }] };
			}
			try {
				const hits = searchSpotlight(params.name, params.onlyin, params.limit ?? 30);
				if (hits.length === 0) {
					return {
						content: [{
							type: "text" as const,
							text: `spotlight: no index hits for '${params.name}'. Index lags fresh files and skips excluded paths — try glob for ground truth.`,
						}],
					};
				}
				return { content: [{ type: "text" as const, text: hits.join("\n") }] };
			} catch (e) {
				return {
					content: [{ type: "text" as const, text: `spotlight failed: ${e instanceof Error ? e.message : String(e)}` }],
				};
			}
		},
	});
}

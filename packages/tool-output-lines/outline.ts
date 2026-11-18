import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

type Item = { signature?: string; range?: { start?: { line?: number }; end?: { line?: number } } };
type Outline = { items?: Item[] };

// One `START-END: signature` line per symbol, 1-based source lines, so the agent can `read path:START-END`.
export function formatOutline(json: string, budget: number): string[] | undefined {
  let parsed: Outline[];
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  const items = parsed[0]?.items;
  if (!Array.isArray(items) || items.length === 0) return undefined;
  const rows = items.flatMap(item => {
    const start = item.range?.start?.line;
    const end = item.range?.end?.line;
    if (typeof start !== "number" || typeof end !== "number" || !item.signature) return [];
    const span = end > start ? `${start + 1}-${end + 1}` : `${start + 1}`;
    return [`${span}: ${item.signature.split("\n")[0]}`];
  });
  if (rows.length === 0) return undefined;
  return rows.length <= budget ? rows : [...rows.slice(0, budget - 1), `… ${rows.length - budget + 1} more symbols`];
}

// Returns undefined when ast-grep is missing, outline is unsupported, or the file is not parseable code.
export async function outlineFile(path: string, budget: number, bin = "ast-grep"): Promise<string[] | undefined> {
  try {
    const { stdout } = await run(bin, ["outline", path, "--items", "all", "--json=compact"], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    return formatOutline(stdout, budget);
  } catch {
    return undefined;
  }
}

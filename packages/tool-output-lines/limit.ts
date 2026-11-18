import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const modes = ["head", "stride"];
export type Mode = "head" | "stride";
export type Limits = { maxLines: number; maxPreviewChars: number; mode: Mode; before: number; after: number };
const defaults: Limits = { maxLines: 10, maxPreviewChars: 2000, mode: "head", before: 0, after: 0 };
const xdgConfig = process.env.XDG_CONFIG_HOME;
const configPath = join(xdgConfig && isAbsolute(xdgConfig) ? xdgConfig : join(homedir(), ".config"), "omp", "tool-output-lines.json");

export async function loadLimits(path = configPath, toolName = "") {
  try {
    const config = JSON.parse(await readFile(path, "utf8"));
    const valid = (value: unknown, min: number) => Number.isSafeInteger(value) && (value as number) >= min;
    const global = { maxLines: config.maxLines, maxPreviewChars: config.maxPreviewChars, mode: config.mode ?? "head", before: config.before ?? 0, after: config.after ?? 0 };
    if (!valid(global.maxLines, 2) || !valid(global.maxPreviewChars, 1) || !modes.includes(global.mode) || !valid(global.before, 0) || !valid(global.after, 0)) throw new Error("invalid defaults");
    if (config.tools !== undefined && (!config.tools || typeof config.tools !== "object" || Array.isArray(config.tools))) throw new Error("invalid tools");
    for (const override of Object.values(config.tools ?? {})) {
      if (!override || typeof override !== "object" || Array.isArray(override)) throw new Error("invalid tool override");
      const limits = override as { maxLines?: unknown; maxPreviewChars?: unknown; mode?: unknown; before?: unknown; after?: unknown };
      if ((limits.maxLines !== undefined && !valid(limits.maxLines, 2)) || (limits.maxPreviewChars !== undefined && !valid(limits.maxPreviewChars, 1)) || (limits.mode !== undefined && !modes.includes(limits.mode as string)) || (limits.before !== undefined && !valid(limits.before, 0)) || (limits.after !== undefined && !valid(limits.after, 0))) throw new Error("invalid tool limits");
    }
    return { ...global, ...(config.tools?.[toolName] ?? {}) } as Limits;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`tool-output-lines: invalid config ${path}; using defaults`);
    return defaults;
  }
}

type Block = { type: string; text?: string; [key: string]: unknown };
export type Result = { toolName: string; content: Block[]; details?: Record<string, unknown>; input?: { path?: unknown; file_path?: unknown } };
export type Context = { sessionManager: { saveArtifact(text: string, toolType: string): Promise<string | undefined> } };

// Evenly spaced sample points (first and last included), each with `before`/`after` context lines
// like grep -B/-A. Each line carries its original number. Total stays within maxLines - 1.
function sample(lines: string[], limits: Limits) {
  const numbered = /^\s*\d+\|/.test(lines[0] ?? "");
  const budget = limits.maxLines - 1;
  const build = (points: number, before: number, after: number) => {
    const keep = new Set<number>();
    for (let p = 0; p < points; p++) {
      const center = Math.round((p * (lines.length - 1)) / (points - 1));
      for (let i = Math.max(0, center - before); i <= Math.min(lines.length - 1, center + after); i++) keep.add(i);
    }
    const picked = [...keep].sort((a, b) => a - b);
    return { picked, text: picked.map(i => (numbered ? lines[i] : `${i + 1}| ${lines[i]}`)).join("\n") };
  };
  let points = Math.max(2, Math.floor(budget / (1 + limits.before + limits.after)));
  let out = build(points, limits.before, limits.after);
  while ((out.picked.length > budget || out.text.length > limits.maxPreviewChars) && points > 2) out = build(--points, limits.before, limits.after);
  if (out.picked.length > budget) out = build(2, 0, 0);
  return { ...out, text: out.text.slice(0, limits.maxPreviewChars) };
}

export async function limitResult(event: Result, ctx: Context, limits: Limits = defaults) {
  const text = event.content.filter(block => block.type === "text").map(block => block.text ?? "").join("\n");
  const lines = text.split(/\r?\n/);
  if (lines.length <= limits.maxLines && text.length <= limits.maxPreviewChars) return;

  let id: string | undefined;
  try {
    // `read` text already carries `N|` prefixes; reading the artifact numbers it again, so save it plain.
    const plain = event.toolName === "read" && /^\s*\d+\|/.test(lines[0] ?? "") ? lines.map(line => line.replace(/^\s*\d+\|/, "")).join("\n") : text;
    id = await ctx.sessionManager.saveArtifact(plain, "tool-output");
  } catch {
    return;
  }
  if (id === undefined) return;

  const sampled = limits.mode === "stride" && lines.length > 2 ? sample(lines, limits) : undefined;
  const preview = sampled ? sampled.text : lines.slice(0, limits.maxLines - 1).join("\n").slice(0, limits.maxPreviewChars);
  const notice = sampled
    ? `[sampled ${sampled.picked.length} of ${lines.length} lines at evenly spaced points, not contiguous · full output: artifact://${id} · zoom in with read artifact://${id}:START-END]`
    : `[${lines.length} lines · full output: artifact://${id}]`;
  const nonText = event.content.filter(block => block.type !== "text");
  const details = event.details ? { ...event.details } : undefined;
  if (details && event.toolName === "read") {
    const display = details.displayContent;
    if (display && typeof display === "object" && "text" in display && typeof display.text === "string") {
      const all = display.text.split(/\r?\n/);
      const allNumbers = "lineNumbers" in display && Array.isArray(display.lineNumbers) ? display.lineNumbers : undefined;
      const picked = sampled && all.length === lines.length ? sampled.picked : all.slice(0, limits.maxLines - 1).map((_, i) => i);
      const displayLines = picked.map(i => all[i] ?? "");
      const lineNumbers = allNumbers ? picked.map(i => allNumbers[i] ?? i + 1) : undefined;
      details.displayContent = { ...display, text: `${displayLines.join("\n").slice(0, limits.maxPreviewChars)}\n${notice}`, ...(lineNumbers ? { lineNumbers: [...lineNumbers, (lineNumbers.at(-1) ?? 0) + 1] } : {}) };
    }
    const path = event.input?.path ?? event.input?.file_path;
    if (typeof path === "string" && path.startsWith("artifact://")) delete details.resolvedPath;
  }
  if (details && ["grep", "ast_grep", "ast_edit"].includes(event.toolName) && typeof details.displayContent === "string") {
    details.displayContent = `${details.displayContent.split(/\r?\n/).slice(0, limits.maxLines - 1).join("\n").slice(0, limits.maxPreviewChars)}\n${notice}`;
  }
  if (details && event.toolName === "glob" && Array.isArray(details.files)) {
    delete details.fileCount;
    delete details.files;
    details.truncated = true;
  }
  if (details && event.toolName === "task" && Array.isArray(details.results)) {
    let remainingLines = limits.maxLines - 1;
    let remainingChars = limits.maxPreviewChars;
    let noticeAdded = false;
    details.results = details.results.map((item: unknown) => {
      if (!item || typeof item !== "object" || !("output" in item) || typeof item.output !== "string") return item;
      const visible = item.output.split(/\r?\n/).slice(0, remainingLines).join("\n").slice(0, remainingChars);
      remainingLines -= visible ? visible.split("\n").length : 0;
      remainingChars -= visible.length;
      const shortened = visible !== item.output;
      const output = shortened && !noticeAdded ? `${visible}${visible ? "\n" : ""}${notice}` : visible;
      if (shortened) noticeAdded = true;
      return { ...item, output };
    });
  }
  if (details && event.toolName === "eval" && Array.isArray(details.cells)) {
    let remainingLines = limits.maxLines - 1;
    let remainingChars = limits.maxPreviewChars;
    let noticeAdded = false;
    details.cells = details.cells.map((cell: unknown) => {
      if (!cell || typeof cell !== "object" || !("output" in cell) || typeof cell.output !== "string") return cell;
      const visible = cell.output.split(/\r?\n/).slice(0, remainingLines).join("\n").slice(0, remainingChars);
      remainingLines -= visible ? visible.split("\n").length : 0;
      remainingChars -= visible.length;
      const shortened = visible !== cell.output;
      const output = shortened && !noticeAdded ? `${visible}${visible ? "\n" : ""}${notice}` : visible;
      if (shortened) noticeAdded = true;
      return { ...cell, output, views: [] };
    });
  }
  return { content: [{ type: "text", text: `${preview}\n${notice}` }, ...nonText], ...(details ? { details } : {}) };
}

export type Override = { off: boolean; maxLines?: number; mode?: Mode; before?: number; after?: number };

export function parseCommand(args: string, current: Override): { next: Override; message: string } {
  const arg = args.trim().toLowerCase();
  const describe = (o: Override) => (o.off ? "off (no truncation)" : [o.maxLines && `maxLines=${o.maxLines}`, o.mode && `mode=${o.mode}`, o.before !== undefined && `before=${o.before}`, o.after !== undefined && `after=${o.after}`].filter(Boolean).join(" ") || "config file limits");
  if (arg === "" || arg === "status") return { next: current, message: `tool-output-lines: ${describe(current)}` };
  if (arg === "off") return { next: { off: true }, message: "tool-output-lines: off for this session" };
  if (arg === "on" || arg === "reset") return { next: { off: false }, message: "tool-output-lines: config file limits restored" };
  const next: Override = { ...current, off: false };
  for (const token of arg.split(/\s+/)) {
    const [key, value = ""] = token.split("=");
    const count = Number(value);
    if (token === "stride" || token === "head") next.mode = token;
    else if (/^\d+$/.test(token) && Number(token) >= 2) next.maxLines = Number(token);
    else if (["before", "after", "context"].includes(key) && /^\d+$/.test(value)) {
      if (key !== "after") next.before = count;
      if (key !== "before") next.after = count;
    } else return { next: current, message: "usage: /tool-lines [status|off|on|reset|head|stride|<lines >= 2>|before=N|after=N|context=N]" };
  }
  return { next, message: `tool-output-lines: ${describe(next)} for this session` };
}

const strideNote = [
  "Tool results longer than the limit may arrive as an evenly spaced sample of lines (each sample point may carry a few context lines), not a contiguous block.",
  "Each sampled line starts with its original line number; the first and last lines are kept; the result ends with a [sampled K of N ...] notice.",
  "Do not assume skipped lines are empty or irrelevant. Zoom out by reading the sample; zoom in with `read artifact://ID:START-END` or `read <path>:START-END`.",
].join(" ");

type Pi = {
  on(name: "tool_result", handler: (event: Result, ctx: Context) => Promise<unknown>): void;
  on(name: "before_agent_start", handler: (event: { systemPrompt?: unknown }) => Promise<unknown>): void;
  registerCommand?: (name: string, def: { description?: string; handler: (args: string, ctx: { ui: { notify(message: string, level?: string): void } }) => Promise<void> }) => void;
};

export default function toolOutputLines(pi: Pi) {
  let override: Override = { off: false };
  pi.on("tool_result", async (event, ctx) => {
    if (override.off) return;
    const limits = await loadLimits(configPath, event.toolName);
    if (override.maxLines) limits.maxLines = override.maxLines;
    if (override.mode) limits.mode = override.mode;
    if (override.before !== undefined) limits.before = override.before;
    if (override.after !== undefined) limits.after = override.after;
    return limitResult(event, ctx, limits);
  });
  pi.on("before_agent_start", async event => {
    if (override.off || typeof event.systemPrompt !== "string") return;
    let stride = override.mode === "stride";
    if (!stride && override.mode === undefined) {
      try {
        const config = JSON.parse(await readFile(configPath, "utf8"));
        stride = config.mode === "stride" || Object.values(config.tools ?? {}).some(tool => !!tool && typeof tool === "object" && "mode" in tool && tool.mode === "stride");
      } catch {}
    }
    if (stride) return { systemPrompt: `${event.systemPrompt}\n\n${strideNote}` };
  });
  pi.registerCommand?.("tool-lines", {
    description: "Session tool-output limit: status | off | on | head | stride | <lines>",
    handler: async (args, ctx) => {
      const { next, message } = parseCommand(args, override);
      override = next;
      ctx.ui.notify(message, "info");
    },
  });
}

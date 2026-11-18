import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const modes = ["head", "stride"];
export type Mode = "head" | "stride";
export type Limits = { maxLines: number; maxPreviewChars: number; mode: Mode };
const defaults: Limits = { maxLines: 10, maxPreviewChars: 2000, mode: "head" };
const xdgConfig = process.env.XDG_CONFIG_HOME;
const configPath = join(xdgConfig && isAbsolute(xdgConfig) ? xdgConfig : join(homedir(), ".config"), "omp", "tool-output-lines.json");

export async function loadLimits(path = configPath, toolName = "") {
  try {
    const config = JSON.parse(await readFile(path, "utf8"));
    const valid = (value: unknown, min: number) => Number.isSafeInteger(value) && (value as number) >= min;
    const global = { maxLines: config.maxLines, maxPreviewChars: config.maxPreviewChars, mode: config.mode ?? "head" };
    if (!valid(global.maxLines, 2) || !valid(global.maxPreviewChars, 1) || !modes.includes(global.mode)) throw new Error("invalid defaults");
    if (config.tools !== undefined && (!config.tools || typeof config.tools !== "object" || Array.isArray(config.tools))) throw new Error("invalid tools");
    for (const override of Object.values(config.tools ?? {})) {
      if (!override || typeof override !== "object" || Array.isArray(override)) throw new Error("invalid tool override");
      const limits = override as { maxLines?: unknown; maxPreviewChars?: unknown; mode?: unknown };
      if ((limits.maxLines !== undefined && !valid(limits.maxLines, 2)) || (limits.maxPreviewChars !== undefined && !valid(limits.maxPreviewChars, 1)) || (limits.mode !== undefined && !modes.includes(limits.mode as string))) throw new Error("invalid tool limits");
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

// Evenly spaced lines, first and last included, each carrying its original line number.
function sample(lines: string[], limits: Limits) {
  const numbered = /^\s*\d+\|/.test(lines[0] ?? "");
  const render = (count: number) => {
    const picked = Array.from({ length: count }, (_, i) => Math.round((i * (lines.length - 1)) / (count - 1)));
    return { picked, text: picked.map(i => (numbered ? lines[i] : `${i + 1}| ${lines[i]}`)).join("\n") };
  };
  let count = Math.min(limits.maxLines - 1, lines.length);
  let out = render(count);
  while (out.text.length > limits.maxPreviewChars && count > 2) out = render(--count);
  return { ...out, text: out.text.slice(0, limits.maxPreviewChars) };
}

export async function limitResult(event: Result, ctx: Context, limits: Limits = defaults) {
  const text = event.content.filter(block => block.type === "text").map(block => block.text ?? "").join("\n");
  const lines = text.split(/\r?\n/);
  if (lines.length <= limits.maxLines && text.length <= limits.maxPreviewChars) return;

  let id: string | undefined;
  try {
    id = await ctx.sessionManager.saveArtifact(text, "tool-output");
  } catch {
    return;
  }
  if (id === undefined) return;

  const sampled = limits.mode === "stride" && lines.length > 2 ? sample(lines, limits) : undefined;
  const preview = sampled ? sampled.text : lines.slice(0, limits.maxLines - 1).join("\n").slice(0, limits.maxPreviewChars);
  const notice = sampled
    ? `[sampled ${sampled.picked.length} of ${lines.length} evenly spaced lines, not contiguous · full output: artifact://${id} · zoom in with read artifact://${id}:START-END]`
    : `[${lines.length} lines · full output: artifact://${id}]`;
  const nonText = event.content.filter(block => block.type !== "text");
  const details = event.details ? { ...event.details } : undefined;
  if (details && event.toolName === "read") {
    const display = details.displayContent;
    if (display && typeof display === "object" && "text" in display && typeof display.text === "string") {
      const displayLines = display.text.split(/\r?\n/).slice(0, limits.maxLines - 1);
      const lineNumbers = "lineNumbers" in display && Array.isArray(display.lineNumbers) ? display.lineNumbers.slice(0, displayLines.length) : undefined;
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

export type Override = { off: boolean; maxLines?: number; mode?: Mode };

export function parseCommand(args: string, current: Override): { next: Override; message: string } {
  const arg = args.trim().toLowerCase();
  const describe = (o: Override) => (o.off ? "off (no truncation)" : [o.maxLines && `maxLines=${o.maxLines}`, o.mode && `mode=${o.mode}`].filter(Boolean).join(" ") || "config file limits");
  if (arg === "" || arg === "status") return { next: current, message: `tool-output-lines: ${describe(current)}` };
  if (arg === "off") return { next: { off: true }, message: "tool-output-lines: off for this session" };
  if (arg === "on" || arg === "reset") return { next: { off: false }, message: "tool-output-lines: config file limits restored" };
  if (arg === "stride" || arg === "head") {
    const next = { ...current, off: false, mode: arg };
    return { next, message: `tool-output-lines: ${describe(next)} for this session` };
  }
  const n = Number(arg);
  if (Number.isSafeInteger(n) && n >= 2) {
    const next = { ...current, off: false, maxLines: n };
    return { next, message: `tool-output-lines: ${describe(next)} for this session` };
  }
  return { next: current, message: "usage: /tool-lines [status|off|on|reset|head|stride|<lines >= 2>]" };
}

const strideNote = [
  "Tool results longer than the limit may arrive as an evenly spaced sample of lines, not a contiguous block.",
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

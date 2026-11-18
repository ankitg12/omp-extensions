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
function sample(lines: string[], limits: Limits, startLine = 1, raw = false) {
  const first = /^\[Skill file: .*\]$/.test(lines[0] ?? "") ? 1 : 0;
  const numbered = !raw && /^\s*\d+\|/.test(lines[first] ?? "");
  const budget = limits.maxLines - 1;
  const build = (points: number, before: number, after: number) => {
    const keep = new Set<number>();
    for (let p = 0; p < points; p++) {
      const center = Math.round((p * (lines.length - 1)) / (points - 1));
      for (let i = Math.max(0, center - before); i <= Math.min(lines.length - 1, center + after); i++) keep.add(i);
    }
    const picked = [...keep].sort((a, b) => a - b);
    return { picked, text: picked.map(i => (numbered || i < first ? lines[i] : `${i + startLine}| ${lines[i]}`)).join("\n") };
  };
  let points = Math.max(2, Math.floor(budget / (1 + limits.before + limits.after)));
  let out = build(points, limits.before, limits.after);
  while ((out.picked.length > budget || out.text.length > limits.maxPreviewChars) && points > 2) out = build(--points, limits.before, limits.after);
  if (out.picked.length > budget) out = build(2, 0, 0);
  return { ...out, text: out.text.slice(0, limits.maxPreviewChars) };
}

function matchingReadDisplay(event: Result, text: string) {
  const display = event.details?.displayContent;
  if (event.toolName !== "read" || !display || typeof display !== "object" || !("text" in display) || typeof display.text !== "string") return;
  const { lineNumbers: _lineNumbers, ...rest } = display as Record<string, unknown>;
  return { ...event.details, contentType: "text/plain", displayContent: { ...rest, startLine: 1, text } };
}

export async function limitResult(event: Result, ctx: Context, limits: Limits = defaults) {
  const text = event.content.filter(block => block.type === "text").map(block => block.text ?? "").join("\n");
  const originalDisplay = () => {
    const details = matchingReadDisplay(event, text);
    return details ? { content: event.content, details } : undefined;
  };
  const allLines = text.split(/\r?\n/);
  if (allLines.length <= limits.maxLines && text.length <= limits.maxPreviewChars) return originalDisplay();
  const candidate = event.toolName === "read" ? allLines.at(-1)?.match(/^\[Showing lines .+ of (\d+); (\d+) middle lines \([^\]]+\) elided\..*Read artifact:\/\/([^\s\]]+) for full output\]$/) : null;
  const meta = event.details?.meta;
  const truncation = meta && typeof meta === "object" && "truncation" in meta ? meta.truncation : undefined;
  const footer = candidate && truncation && typeof truncation === "object" && "artifactId" in truncation && truncation.artifactId === candidate[3] ? candidate : null;
  const page = event.toolName === "read" ? allLines.at(-1)?.match(/^\[Showing lines (\d+)-(\d+) of (\d+) \([^\]]+ limit\)\. Use :(\d+) to continue\]$/) : null;
  const pageMeta = truncation && typeof truncation === "object" && "shownRange" in truncation && typeof truncation.shownRange === "object" && truncation.shownRange && "start" in truncation.shownRange && "end" in truncation.shownRange ? truncation.shownRange : undefined;
  const continuation = page && pageMeta && pageMeta.start === Number(page[1]) && pageMeta.end === Number(page[2]) && "totalLines" in truncation && truncation.totalLines === Number(page[3]) && "nextOffset" in truncation && truncation.nextOffset === Number(page[4]) ? page : null;
  const lines = footer || continuation ? allLines.slice(0, -1) : allLines;
  // An explicit range within the limit is a request for exact lines; OMP adds context lines and a footer around it.
  const selector = event.toolName === "read" ? String(event.input?.path ?? event.input?.file_path ?? "").replace(/^[A-Za-z]:/, "").match(/:(\d+)(?:-(\d+)|\+(\d+))?(?::raw)?$/) : null;
  if (selector) {
    const size = selector[2] ? Number(selector[2]) - Number(selector[1]) + 1 : selector[3] ? Number(selector[3]) : 1;
    if (size <= limits.maxLines && text.length <= limits.maxPreviewChars) return originalDisplay();
  }

  const path = event.input?.path ?? event.input?.file_path;
  const raw = typeof path === "string" && /(?:^|:)raw(?::|$)/.test(path);
  const rawRange = raw && typeof path === "string" ? path.match(/:(\d+)(?:-\d+|\+\d+)(?::raw)?$/) : null;
  const startLine = event.toolName === "read" && rawRange ? Number(rawRange[1]) : 1;
  let id: string | undefined = footer?.[3];
  try {
    const first = /^\[Skill file: .*\]$/.test(lines[0] ?? "") ? 1 : 0;
    const plain = event.toolName === "read" && !raw && /^\s*\d+\|/.test(lines[first] ?? "") ? lines.map((line, i) => i < first ? line : line.replace(/^\s*\d+(?:-\d+)?\|/, "")).join("\n") : text;
    if (!id) id = await ctx.sessionManager.saveArtifact(plain, "tool-output");
  } catch {
    return;
  }
  if (id === undefined) return;

  const sampled = limits.mode !== "head" && lines.length > 2 ? sample(lines, limits, startLine, raw) : undefined;
  const preview = sampled ? sampled.text : lines.slice(0, limits.maxLines - 1).join("\n").slice(0, limits.maxPreviewChars);
  const sampling = sampled ? `sampled ${sampled.picked.length}/${lines.length} lines` : `${lines.length} lines`;
  const notice = footer
    ? `[${sampling} · OMP omitted ${footer[2]} of ${footer[1]} source lines · full output: artifact://${id}]`
    : continuation ? `[${sampling} · OMP showed ${continuation[1]}-${continuation[2]} of ${continuation[3]} source lines · continue source at :${continuation[4]} · partial result: artifact://${id}]`
    : sampled ? `[${sampling} · artifact://${id}]` : `[${sampling} · full output: artifact://${id}]`;
  const nonText = event.content.filter(block => block.type !== "text");
  const details = event.details ? { ...event.details } : undefined;
  if (details && event.toolName === "read") {
    if ((footer || continuation) && details.meta && typeof details.meta === "object" && "truncation" in details.meta) {
      const { truncation: _truncation, ...meta } = details.meta;
      details.meta = meta;
    }
    const display = details.displayContent;
    if (display && typeof display === "object" && "text" in display && typeof display.text === "string") {
      // Show the exact text the model receives, line-number prefixes included, so a regression is visible.
      const { lineNumbers: _gutter, ...rest } = display as Record<string, unknown>;
      details.displayContent = { ...rest, startLine: 1, text: `${preview}\n${notice}` };
      details.contentType = "text/plain"; // Markdown rendering would join the `N|` lines into paragraphs.
    }
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
    } else return { next: current, message: "usage: /tool-lines [|status|off|on|reset|head|stride|<lines >= 2>|before=N|after=N|context=N]" };
  }
  return { next, message: `tool-output-lines: ${describe(next)} for this session` };
}

const exactReadNote = (maxLines: number) =>
  `Tool results may be shortened by line or character limits. To see exact source lines, request a read range of at most ${maxLines} lines: \`read <path>:START-END\`, or \`read artifact://ID:START-END\` for a saved result. Long lines can still exceed the character limit.`;

const strideNote = [
  "Tool results longer than the limit may arrive as an evenly spaced sample of lines (each sample point may carry a few context lines), not a contiguous block.",
  "Each sampled line starts with its original line number; the first and last lines are kept; the result ends with a [sampled K/N lines · artifact://ID] notice.",
  "Do not assume skipped lines are empty or irrelevant. For read results, use original source line numbers with the original path; artifact line numbers are offsets in the saved result and may not match source lines. For other results, zoom in with `read artifact://ID:START-END`.",
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
    const sampling = (mode: unknown) => mode === "stride";
    let stride = sampling(override.mode);
    if (!stride && override.mode === undefined) {
      try {
        const config = JSON.parse(await readFile(configPath, "utf8"));
        stride = sampling(config.mode) || Object.values(config.tools ?? {}).some(tool => !!tool && typeof tool === "object" && "mode" in tool && sampling(tool.mode));
      } catch {}
    }
    const { maxLines } = await loadLimits(configPath, "read");
    return { systemPrompt: `${event.systemPrompt}\n\n${exactReadNote(maxLines)}${stride ? `\n\n${strideNote}` : ""}` };
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

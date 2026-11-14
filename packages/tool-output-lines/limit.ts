import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const defaults = { maxLines: 10, maxPreviewChars: 2000 };
const xdgConfig = process.env.XDG_CONFIG_HOME;
const configPath = join(xdgConfig && isAbsolute(xdgConfig) ? xdgConfig : join(homedir(), ".config"), "omp", "tool-output-lines.json");

export async function loadLimits(path = configPath, toolName = "") {
  try {
    const config = JSON.parse(await readFile(path, "utf8"));
    const valid = (value: unknown, min: number) => Number.isSafeInteger(value) && (value as number) >= min;
    const global = { maxLines: config.maxLines, maxPreviewChars: config.maxPreviewChars };
    if (!valid(global.maxLines, 2) || !valid(global.maxPreviewChars, 1)) throw new Error("invalid defaults");
    if (config.tools !== undefined && (!config.tools || typeof config.tools !== "object" || Array.isArray(config.tools))) throw new Error("invalid tools");
    for (const override of Object.values(config.tools ?? {})) {
      if (!override || typeof override !== "object" || Array.isArray(override)) throw new Error("invalid tool override");
      const limits = override as { maxLines?: unknown; maxPreviewChars?: unknown };
      if ((limits.maxLines !== undefined && !valid(limits.maxLines, 2)) || (limits.maxPreviewChars !== undefined && !valid(limits.maxPreviewChars, 1))) throw new Error("invalid tool limits");
    }
    return { ...global, ...(config.tools?.[toolName] ?? {}) } as typeof defaults;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`tool-output-lines: invalid config ${path}; using defaults`);
    return defaults;
  }
}

type Block = { type: string; text?: string; [key: string]: unknown };
type Result = { toolName: string; content: Block[]; details?: Record<string, unknown>; input?: { path?: unknown; file_path?: unknown } };
type Context = { sessionManager: { saveArtifact(text: string, toolType: string): Promise<string | undefined> } };

export async function limitResult(event: Result, ctx: Context, limits = defaults) {
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

  const preview = lines.slice(0, limits.maxLines - 1).join("\n").slice(0, limits.maxPreviewChars);
  const notice = `[${lines.length} lines · full output: artifact://${id}]`;
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

export default function toolOutputLines(pi: { on: (name: string, handler: (event: Result, ctx: Context) => Promise<unknown>) => void }) {
  pi.on("tool_result", async (event, ctx) => limitResult(event, ctx, await loadLimits(configPath, event.toolName)));
}

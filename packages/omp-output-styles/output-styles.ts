/**
 * Dynamic Output Styles extension for Oh My Pi (OMP).
 *
 * Supports arbitrary custom styles without code changes:
 * Drop any `<name>.md` file into `~/.omp/agent/output-styles/` or `.omp/output-styles/`.
 *
 * Commands:
 *   /style <name>     - Switch to any available style (e.g. /style socratic, /style learning)
 *   /output-style     - List available styles or switch style
 *   /style-off        - Disable output style injection (0 token overhead)
 *   /learning         - Shortcut for /style learning
 *   /explanatory      - Shortcut for /style explanatory
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const AGENT_DIR = path.join(os.homedir(), ".omp", "agent");
const STATE_PATH = path.join(AGENT_DIR, "output-style.json");
const USER_PROMPT_DIR = path.join(AGENT_DIR, "output-styles");
const BUNDLED_PROMPT_DIR = path.join(__dirname, "prompts");

/** Scan directories and return map of style-name -> full file path */
export function getAvailableStyles(cwd?: string): Record<string, string> {
 const styles: Record<string, string> = {};

 const dirsToScan = [
  BUNDLED_PROMPT_DIR,
  USER_PROMPT_DIR,
  cwd ? path.join(cwd, ".omp", "output-styles") : undefined,
 ].filter((d): d is string => Boolean(d && fs.existsSync(d)));

 for (const dir of dirsToScan) {
  try {
   const files = fs.readdirSync(dir);
   for (const file of files) {
    if (file.endsWith(".md")) {
     const styleName = path.basename(file, ".md").toLowerCase();
     if (styleName !== "off") {
      styles[styleName] = path.join(dir, file);
     }
    }
   }
  } catch { }
 }

 return styles;
}

export function normalizeStyle(raw: string | undefined, availableStyles: Record<string, string>): string | undefined | null {
 const value = (raw ?? "").trim().toLowerCase();
 if (!value) return undefined;

 if (value === "off" || value === "none" || value === "default" || value === "normal" || value === "disable" || value === "disabled") {
  return "off";
 }

 // Exact match
 if (value in availableStyles) {
  return value;
 }

 // Common aliases
 if (value === "learn" && "learning" in availableStyles) return "learning";
 if (value === "explain" && "explanatory" in availableStyles) return "explanatory";

 return null;
}

export function readStyle(availableStyles: Record<string, string>): string {
 try {
  const raw = fs.readFileSync(STATE_PATH, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (parsed && typeof parsed === "object" && "style" in parsed && typeof parsed.style === "string") {
   const saved = parsed.style.toLowerCase();
   if (saved === "off" || saved in availableStyles) {
    return saved;
   }
  }
  return "off";
 } catch {
  return "off";
 }
}

export function writeStyle(style: string): void {
 fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
 fs.writeFileSync(STATE_PATH, `${JSON.stringify({ style }, null, 2)}\n`, "utf8");
}

export function loadStylePrompt(style: string, availableStyles: Record<string, string>): string | undefined {
 if (style === "off") return undefined;
 const filePath = availableStyles[style];
 if (!filePath || !fs.existsSync(filePath)) return undefined;

 try {
  const prompt = fs.readFileSync(filePath, "utf8").trim();
  return prompt.length > 0 ? prompt : undefined;
 } catch {
  return undefined;
 }
}

export function appendPrompt(systemPrompt: unknown, systemPromptAppend: string): string | string[] {
 if (Array.isArray(systemPrompt)) return [...systemPrompt.map(String), systemPromptAppend];
 const base = typeof systemPrompt === "string" ? systemPrompt : "";
 return base ? `${base}\n\n${systemPromptAppend}` : systemPromptAppend;
}

function updateStatus(ui: { setStatus?: (k: string, v: string) => void } | undefined, style: string) {
 if (!ui?.setStatus) return;
 if (style === "off" || !style) {
  ui.setStatus("output-style", "");
  return;
 }
 const icon = style === "learning" ? "🎓" : style === "explanatory" ? "💡" : "📝";
 ui.setStatus("output-style", `${icon} ${style}`);
}

export default function outputStyles(pi: ExtensionAPI) {
 async function setOrShowStyle(
  args: string | undefined,
  ctx: { ui?: { notify?: (message: string, level?: string) => void; setStatus?: (k: string, v: string) => void }; cwd?: string },
 ) {
  const available = getAvailableStyles(ctx.cwd);
  const availableNames = Object.keys(available).sort().join(", ");
  const current = readStyle(available);

  const parsed = normalizeStyle(args, available);
  if (parsed === undefined) {
   ctx.ui?.notify?.(
    `Active output style: ${current}\nAvailable styles: ${availableNames || "none"} (or 'off')\nUsage: /style <name> | /style-off\n\nAdd any new style by creating ~/.omp/agent/output-styles/<name>.md`,
    "info",
   );
   return;
  }
  if (parsed === null) {
   ctx.ui?.notify?.(
    `Unknown style: "${(args ?? "").trim()}". Available: ${availableNames || "none"} (or 'off')`,
    "warn",
   );
   return;
  }

  writeStyle(parsed);
  updateStatus(ctx.ui, parsed);
  ctx.ui?.notify?.(`Output style set to: ${parsed}`, "info");
 }

 pi.registerCommand("output-style", {
  description: "List or set output style (e.g. /output-style learning | explanatory | off)",
  handler: setOrShowStyle,
 });
 pi.registerCommand("style", {
  description: "Switch output style or list available styles",
  handler: setOrShowStyle,
 });
 pi.registerCommand("learning", {
  description: "Enable interactive learning style",
  handler: async (_args, ctx) => setOrShowStyle("learning", ctx),
 });
 pi.registerCommand("explanatory", {
  description: "Enable explanatory style",
  handler: async (_args, ctx) => setOrShowStyle("explanatory", ctx),
 });
 pi.registerCommand("style-off", {
  description: "Disable output style injection (0 token overhead)",
  handler: async (_args, ctx) => setOrShowStyle("off", ctx),
 });

 pi.on("session_start", async (_event, ctx) => {
  const available = getAvailableStyles(ctx.cwd);
  const active = readStyle(available);
  updateStatus(ctx.ui, active);
 });

 pi.on("before_agent_start", async (event, ctx) => {
  const available = getAvailableStyles(ctx.cwd);
  const active = readStyle(available);
  const systemPromptAppend = loadStylePrompt(active, available);
  if (!systemPromptAppend) return undefined;

  let basePrompt: unknown;
  if (event && typeof event === "object" && "systemPrompt" in event) {
   basePrompt = event.systemPrompt;
  }

  return {
   systemPromptAppend,
   systemPrompt: appendPrompt(basePrompt, systemPromptAppend),
  };
 });
}

/**
 * Output styles extension for Oh My Pi (OMP).
 *
 * Provides:
 *   /learning      - Enable interactive learning mode (code contribution + insights)
 *   /explanatory  - Enable educational insights mode
 *   /style-off     - Disable output style injection (0 token overhead)
 *   /output-style  - Inspect or set style directly
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type OutputStyle = "off" | "explanatory" | "learning";

const AGENT_DIR = path.join(os.homedir(), ".omp", "agent");
const STATE_PATH = path.join(AGENT_DIR, "output-style.json");
const USER_PROMPT_DIR = path.join(AGENT_DIR, "output-styles");
const BUNDLED_PROMPT_DIR = path.join(__dirname, "prompts");

const VALID_STYLES: Record<string, true> = {
 off: true,
 explanatory: true,
 learning: true,
};

export function normalizeStyle(raw: string | undefined): OutputStyle | undefined | null {
 const value = (raw ?? "").trim().toLowerCase();
 if (!value) return undefined;
 if (value === "off" || value === "none" || value === "default" || value === "normal" || value === "disable" || value === "disabled") {
  return "off";
 }
 if (value === "explain" || value === "explanatory") return "explanatory";
 if (value === "learn" || value === "learning") return "learning";
 return null;
}

export function readStyle(): OutputStyle {
 try {
  const raw = fs.readFileSync(STATE_PATH, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (parsed && typeof parsed === "object" && "style" in parsed && typeof parsed.style === "string") {
   if (parsed.style in VALID_STYLES) {
    return parsed.style as OutputStyle;
   }
  }
  return "off";
 } catch {
  return "off";
 }
}

export function writeStyle(style: OutputStyle): void {
 fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
 fs.writeFileSync(STATE_PATH, `${JSON.stringify({ style }, null, 2)}\n`, "utf8");
}

export function loadStylePrompt(style: OutputStyle): string | undefined {
 if (style === "off") return undefined;

 // 1. Check user override in ~/.omp/agent/output-styles/<style>.md
 const userPath = path.join(USER_PROMPT_DIR, `${style}.md`);
 if (fs.existsSync(userPath)) {
  try {
   const prompt = fs.readFileSync(userPath, "utf8").trim();
   if (prompt.length > 0) return prompt;
  } catch { }
 }

 // 2. Check bundled prompt in <package>/prompts/<style>.md
 const bundledPath = path.join(BUNDLED_PROMPT_DIR, `${style}.md`);
 if (fs.existsSync(bundledPath)) {
  try {
   const prompt = fs.readFileSync(bundledPath, "utf8").trim();
   if (prompt.length > 0) return prompt;
  } catch { }
 }

 return undefined;
}

export function appendPrompt(systemPrompt: unknown, systemPromptAppend: string): string | string[] {
 if (Array.isArray(systemPrompt)) return [...systemPrompt.map(String), systemPromptAppend];
 const base = typeof systemPrompt === "string" ? systemPrompt : "";
 return base ? `${base}\n\n${systemPromptAppend}` : systemPromptAppend;
}

function updateStatus(ui: { setStatus?: (k: string, v: string) => void } | undefined, style: OutputStyle) {
 if (!ui?.setStatus) return;
 const label = style === "learning" ? "🎓 learning" : style === "explanatory" ? "💡 explanatory" : "";
 ui.setStatus("output-style", label);
}

export default function outputStyles(pi: ExtensionAPI) {
 let activeStyle: OutputStyle = readStyle();

 async function setOrShowStyle(
  args: string | undefined,
  ctx: { ui?: { notify?: (message: string, level?: string) => void; setStatus?: (k: string, v: string) => void } },
 ) {
  const parsed = normalizeStyle(args);
  if (parsed === undefined) {
   ctx.ui?.notify?.(`Output style: ${activeStyle}\nUsage: /output-style [learning | explanatory | off]`, "info");
   return;
  }
  if (parsed === null) {
   ctx.ui?.notify?.(`Unknown output style: ${(args ?? "").trim()}`, "warn");
   return;
  }
  activeStyle = parsed;
  writeStyle(activeStyle);
  updateStatus(ctx.ui, activeStyle);
  ctx.ui?.notify?.(`Output style set to: ${activeStyle}`, "info");
 }

 pi.registerCommand("output-style", {
  description: "Set output style: learning, explanatory, or off",
  handler: setOrShowStyle,
 });
 pi.registerCommand("style", {
  description: "Alias for /output-style",
  handler: setOrShowStyle,
 });
 pi.registerCommand("learning", {
  description: "Enable interactive learning style (contributions + insights)",
  handler: async (_args, ctx) => setOrShowStyle("learning", ctx),
 });
 pi.registerCommand("explanatory", {
  description: "Enable explanatory style (insights only)",
  handler: async (_args, ctx) => setOrShowStyle("explanatory", ctx),
 });
 pi.registerCommand("style-off", {
  description: "Disable output style injection",
  handler: async (_args, ctx) => setOrShowStyle("off", ctx),
 });

 pi.on("session_start", async (_event, ctx) => {
  activeStyle = readStyle();
  updateStatus(ctx.ui, activeStyle);
 });

 pi.on("before_agent_start", async (event) => {
  activeStyle = readStyle();
  const systemPromptAppend = loadStylePrompt(activeStyle);
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

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { spawn } from "child_process";
import { existsSync, mkdirSync, appendFileSync } from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

const isWin = process.platform === "win32";
const SCREENSHOT_DIR = isWin
  ? "C:\\tmp\\omp-screenshots"
  : path.join(os.homedir(), "tmp", "omp-screenshots");
const LOG = path.join(SCREENSHOT_DIR, "omp-screenshot.log");
const PYTHON = process.env.OMP_SCREENSHOT_PYTHON ?? (isWin ? "python" : "python3");
// Windows capture engine: Windows.Graphics.Capture (occlusion/GPU-safe), PrintWindow fallback.
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "capture_window.py");

function log(msg: string) {
  try { appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`); } catch { }
}

interface RunResult { code: number; stdout: string; stderr: string; }

function run(cmd: string, args: string[]): Promise<RunResult> {
  const { promise, resolve, reject } = Promise.withResolvers<RunResult>();
  const child = spawn(cmd, args, { stdio: "pipe", windowsHide: true });

  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.on("data", (d) => stdout.push(d.toString()));
  child.stderr.on("data", (d) => stderr.push(d.toString()));

  child.on("close", (code) =>
    resolve({ code: code ?? -1, stdout: stdout.join("").trim(), stderr: stderr.join("").trim() }));
  child.on("error", reject);

  setTimeout(() => {
    child.kill();
    reject(new Error("capture timed out after 30s"));
  }, 30_000);

  return promise;
}

// Capture and return a short description of what was grabbed.
//   Windows: capture_window.py decides — named window (title given), `self`/`omp` for the
//            terminal/OMP window itself, else primary monitor (multi-display) or topmost
//            non-terminal window (single screen). Avoids screenshotting OMP unless asked.
//   macOS:   native `screencapture` of the main display (title arg not supported there).
async function capture(out: string, title: string): Promise<string> {
  if (isWin) {
    const args = [SCRIPT, "--out", out];
    if (title) args.push("--title", title);
    const r = await run(PYTHON, args);
    if (r.code === 0) return r.stdout.replace(/^OK\s*/, "") || "screen";
    throw new Error(r.stdout.replace(/^ERR\s*/, "") || r.stderr || `exit code ${r.code}`);
  }
  // darwin: native screencapture, no Python/PIL required
  const r = await run("screencapture", ["-x", "-D", "1", out]);
  if (r.code === 0) return "main display";
  throw new Error(r.stderr || `exit code ${r.code}`);
}

export default function ompScreenshot(pi: ExtensionAPI) {
  pi.setLabel("Screenshot");
  log("extension loaded");

  pi.registerCommand("screenshot", {
    description: "Capture a window (arg = title substring, e.g. /screenshot edge), `/screenshot self` for OMP itself, or the screen; attaches as @path. Avoids screenshotting OMP unless asked.",
    handler: async (args: string, ctx) => {
      try {
        const title = (args || "").trim();
        mkdirSync(SCREENSHOT_DIR, { recursive: true });

        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const out = path.join(SCREENSHOT_DIR, `ss-${ts}.png`);

        log(`capturing: ${out} title=${title || "(auto)"}`);
        const desc = await capture(out, title);

        if (!existsSync(out)) {
          ctx.ui.notify("Screenshot failed — file not created", "error");
          log("file missing after capture");
          return;
        }

        const outFwd = out.replace(/\\/g, "/");
        ctx.ui.setEditorText(`@${outFwd} ${ctx.ui.getEditorText()}`);
        ctx.ui.notify(`Captured ${desc} — add your question and send`, "info");
        log(`success: ${outFwd} (${desc})`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`error: ${msg}`);
        ctx.ui.notify(`Screenshot failed: ${msg}`, "error");
      }
    },
  });
}

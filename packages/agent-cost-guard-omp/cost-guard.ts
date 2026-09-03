/**
 * Soft per-session cost guard for OMP.
 * Defaults: warn at $8, abort at $10, then remind every additional $5.
 *
 * Configuration precedence (highest first):
 *   1. environment variables
 *   2. config file (OMP_COST_CONFIG, else ~/.omp/cost-guard.json)
 *   3. built-in defaults
 */
import { readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ReadonlySessionManager } from "@oh-my-pi/pi-coding-agent/hooks";

type Config = {
 limit: number;
 warn: number;
 reminderStep: number;
 /** Abort at every reminder checkpoint past the limit, not just once. */
 abortEachStep: boolean;
 /** Absolute path to a debug log file; empty disables logging. */
 debugLog: string;
};

const DEFAULTS: Config = {
 limit: 10,
 warn: 8,
 reminderStep: 5,
 abortEachStep: false,
 debugLog: "",
};

const CONFIG_PATH = process.env.OMP_COST_CONFIG ?? join(homedir(), ".omp", "cost-guard.json");

function readConfigFile(path: string): Partial<Config> {
 try {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return parsed && typeof parsed === "object" ? (parsed as Partial<Config>) : {};
 } catch {
  return {};
 }
}

function num(value: unknown, fallback: number): number {
 const n = Number(value);
 return Number.isFinite(n) ? n : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
 if (typeof value === "boolean") return value;
 if (typeof value === "string") {
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
 }
 return fallback;
}

function loadConfig(): { config: Config; source: string } {
 const file = readConfigFile(CONFIG_PATH);
 const base: Config = {
  limit: num(file.limit, DEFAULTS.limit),
  warn: num(file.warn, DEFAULTS.warn),
  reminderStep: num(file.reminderStep, DEFAULTS.reminderStep),
  abortEachStep: bool(file.abortEachStep, DEFAULTS.abortEachStep),
  debugLog: typeof file.debugLog === "string" ? file.debugLog : DEFAULTS.debugLog,
 };
 return {
  config: {
   limit: num(process.env.OMP_COST_LIMIT, base.limit),
   warn: num(process.env.OMP_COST_WARN, base.warn),
   reminderStep: num(process.env.OMP_COST_REMINDER_STEP, base.reminderStep),
   abortEachStep: bool(process.env.OMP_COST_ABORT_EACH_STEP, base.abortEachStep),
   debugLog: process.env.OMP_COST_DEBUG_LOG ?? base.debugLog,
  },
  source: CONFIG_PATH,
 };
}

const { config: CFG, source: CFG_SOURCE } = loadConfig();
const LIMIT = CFG.limit;
const WARN = CFG.warn;
const REMINDER_STEP = CFG.reminderStep;

function debug(message: string): void {
 if (!CFG.debugLog) return;
 try {
  appendFileSync(CFG.debugLog, `${new Date().toISOString()} cost-guard ${message}\n`);
 } catch {
  /* logging must never break the session */
 }
}

function usageCost(value: unknown): number {
 if (!value || typeof value !== "object") return 0;
 const cost = Reflect.get(value, "cost");
 if (!cost || typeof cost !== "object") return 0;
 const total = Reflect.get(cost, "total");
 return typeof total === "number" && Number.isFinite(total) ? total : 0;
}

function sessionCost(sessionManager: ReadonlySessionManager): number {
 let spent = 0;
 for (const entry of sessionManager.getBranch()) {
  if (entry.type !== "message") continue;
  const message = entry.message;
  if (message.role === "assistant") spent += usageCost(message.usage);
  if (message.role === "toolResult" && message.toolName === "task") {
   const usage = message.details && typeof message.details === "object"
    ? Reflect.get(message.details, "usage")
    : undefined;
   spent += usageCost(usage);
  }
 }
 return spent;
}

export default function(pi: ExtensionAPI) {
 let warned = false;
 let tripped = false;
 let lastReminded = LIMIT;

 debug(
  `config source=${CFG_SOURCE} warn=${WARN} limit=${LIMIT} step=${REMINDER_STEP} ` +
  `abortEachStep=${CFG.abortEachStep}`,
 );

 pi.on("session_start", (_event, ctx) => {
  const spent = sessionCost(ctx.sessionManager);
  warned = spent >= WARN;
  tripped = spent >= LIMIT;
  if (tripped) lastReminded = Math.floor(spent / REMINDER_STEP) * REMINDER_STEP;
  debug(`session_start spent=${spent.toFixed(4)} warned=${warned} tripped=${tripped}`);
 });

 pi.on("turn_end", (_event, ctx) => {
  const spent = sessionCost(ctx.sessionManager);
  debug(`turn_end spent=${spent.toFixed(4)} warned=${warned} tripped=${tripped}`);

  if (!warned && spent >= WARN) {
   warned = true;
   const text = `Cost guard: $${spent.toFixed(2)} has reached the $${WARN.toFixed(2)} warning threshold.`;
   debug(`warn ${text}`);
   if (ctx.hasUI) ctx.ui.notify(text, "warning");
   else console.error(text);
  }

  if (!tripped && spent >= LIMIT) {
   tripped = true;
   lastReminded = Math.floor(spent / REMINDER_STEP) * REMINDER_STEP;
   const text = `Cost guard: $${spent.toFixed(2)} exceeds $${LIMIT.toFixed(2)} limit — aborting.`;
   debug(`abort ${text}`);
   if (ctx.hasUI) ctx.ui.notify(text, "error");
   else console.error(text);
   ctx.abort();
   return;
  }

  if (tripped) {
   const threshold = Math.floor(spent / REMINDER_STEP) * REMINDER_STEP;
   if (threshold > lastReminded) {
    lastReminded = threshold;
    const text = CFG.abortEachStep
     ? `Cost guard: session cost is $${spent.toFixed(2)} — another $${REMINDER_STEP.toFixed(2)} spent past the $${LIMIT.toFixed(2)} limit; aborting again.`
     : `Cost guard: session cost is $${spent.toFixed(2)} — another $${REMINDER_STEP.toFixed(2)} spent since the last checkpoint.`;
    debug(`${CFG.abortEachStep ? "abort" : "remind"} checkpoint=${threshold} ${text}`);
    if (ctx.hasUI) ctx.ui.notify(text, CFG.abortEachStep ? "error" : "warning");
    else console.error(text);
    if (CFG.abortEachStep) ctx.abort();
   }
  }
 });
}

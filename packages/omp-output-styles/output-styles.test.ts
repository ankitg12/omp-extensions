import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import outputStyles, {
  getAvailableStyles,
  normalizeStyle,
  readStyle,
  writeStyle,
  loadStylePrompt,
  appendPrompt,
} from "./output-styles.ts";

test("getAvailableStyles discovers bundled styles including manual", () => {
  const styles = getAvailableStyles();
  expect(styles["learning"]).toBeDefined();
  expect(styles["explanatory"]).toBeDefined();
  expect(styles["manual"]).toBeDefined();
  const manualPrompt = loadStylePrompt("manual", styles);
  expect(manualPrompt).toContain("manual test execution");
  expect(manualPrompt).toContain("Proactive State Verification");
});

test("normalizeStyle parses keywords and dynamic styles", () => {
  const styles = { learning: "/path/learning.md", socratic: "/path/socratic.md" };
  expect(normalizeStyle(undefined, styles)).toBeUndefined();
  expect(normalizeStyle("", styles)).toBeUndefined();
  expect(normalizeStyle("off", styles)).toBe("off");
  expect(normalizeStyle("disable", styles)).toBe("off");
  expect(normalizeStyle("learning", styles)).toBe("learning");
  expect(normalizeStyle("learn", styles)).toBe("learning");
  expect(normalizeStyle("socratic", styles)).toBe("socratic");
  expect(normalizeStyle("unknown-style", styles)).toBeNull();
});

test("custom markdown file adds a new style with zero code changes", () => {
  // Simulate a custom style file created in project or user dir
  const tmpDir = path.join(import.meta.dir, ".test-tmp-styles");
  const tmpProjectStyles = path.join(tmpDir, ".omp", "output-styles");
  fs.mkdirSync(tmpProjectStyles, { recursive: true });

  const customStylePath = path.join(tmpProjectStyles, "socratic.md");
  fs.writeFileSync(customStylePath, "You are a Socratic tutor. Only ask leading questions.", "utf8");

  try {
    const discovered = getAvailableStyles(tmpDir);
    expect(discovered["socratic"]).toBe(customStylePath);

    const normalized = normalizeStyle("socratic", discovered);
    expect(normalized).toBe("socratic");

    const prompt = loadStylePrompt("socratic", discovered);
    expect(prompt).toBe("You are a Socratic tutor. Only ask leading questions.");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("appendPrompt correctly appends string or array", () => {
  expect(appendPrompt("Base prompt", "Extra text")).toBe("Base prompt\n\nExtra text");
  expect(appendPrompt(["P1", "P2"], "Extra text")).toEqual(["P1", "P2", "Extra text"]);
  expect(appendPrompt(undefined, "Extra text")).toBe("Extra text");
});

test("extension registers commands and dynamically switches styles", async () => {
  const commands: Record<string, { handler: Function; description?: string }> = {};
  const handlers: Record<string, Function> = {};
  let statusKey = "";
  let statusVal = "";

  const mockPi = {
    registerCommand(name: string, def: { handler: Function; description?: string }) {
      commands[name] = def;
    },
    on(event: string, handler: Function) {
      handlers[event] = handler;
    },
  };

  outputStyles(mockPi as never);

  expect(commands["output-style"]).toBeDefined();
  expect(commands["style"]).toBeDefined();
  expect(commands["learning"]).toBeDefined();
  expect(commands["explanatory"]).toBeDefined();
  expect(commands["style-off"]).toBeDefined();
  expect(handlers["session_start"]).toBeDefined();
  expect(handlers["before_agent_start"]).toBeDefined();

  const mockCtx = {
    ui: {
      setStatus(k: string, v: string) {
        statusKey = k;
        statusVal = v;
      },
      notify() { },
    },
  };

  // Test toggling to learning
  await commands["learning"].handler(undefined, mockCtx);
  const styles = getAvailableStyles();
  expect(readStyle(styles)).toBe("learning");
  expect(statusKey).toBe("output-style");
  expect(statusVal).toContain("learning");

  // Verify before_agent_start injects prompt when learning is active
  const result = await handlers["before_agent_start"]({ systemPrompt: "Hello" }, mockCtx);
  expect(result).toBeDefined();
  expect(result.systemPrompt).toContain("Learning Mode Philosophy");

  // Test toggling to off
  await commands["style-off"].handler(undefined, mockCtx);
  expect(readStyle(styles)).toBe("off");
  expect(statusVal).toBe("");

  // Verify before_agent_start returns undefined when off
  const resultOff = await handlers["before_agent_start"]({ systemPrompt: "Hello" }, mockCtx);
  expect(resultOff).toBeUndefined();
});

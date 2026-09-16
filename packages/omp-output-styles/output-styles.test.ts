import { test, expect } from "bun:test";
import outputStyles, {
  normalizeStyle,
  readStyle,
  writeStyle,
  loadStylePrompt,
  appendPrompt,
} from "./output-styles.ts";

test("normalizeStyle parses input keywords", () => {
  expect(normalizeStyle(undefined)).toBeUndefined();
  expect(normalizeStyle("")).toBeUndefined();
  expect(normalizeStyle("off")).toBe("off");
  expect(normalizeStyle("disable")).toBe("off");
  expect(normalizeStyle("learn")).toBe("learning");
  expect(normalizeStyle("learning")).toBe("learning");
  expect(normalizeStyle("explain")).toBe("explanatory");
  expect(normalizeStyle("explanatory")).toBe("explanatory");
  expect(normalizeStyle("invalid-style")).toBeNull();
});

test("loadStylePrompt reads prompt files or returns undefined for off", () => {
  expect(loadStylePrompt("off")).toBeUndefined();

  const learning = loadStylePrompt("learning");
  expect(learning).toBeDefined();
  expect(learning).toContain("Learning Mode Philosophy");
  expect(learning).toContain("★ Insight");

  const explanatory = loadStylePrompt("explanatory");
  expect(explanatory).toBeDefined();
  expect(explanatory).toContain("explanatory");
  expect(explanatory).toContain("★ Insight");
});

test("appendPrompt correctly appends string or array", () => {
  expect(appendPrompt("Base prompt", "Extra text")).toBe("Base prompt\n\nExtra text");
  expect(appendPrompt(["P1", "P2"], "Extra text")).toEqual(["P1", "P2", "Extra text"]);
  expect(appendPrompt(undefined, "Extra text")).toBe("Extra text");
});

test("extension registers commands and event handlers", async () => {
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
  expect(readStyle()).toBe("learning");
  expect(statusKey).toBe("output-style");
  expect(statusVal).toContain("learning");

  // Verify before_agent_start injects prompt when learning is active
  const result = await handlers["before_agent_start"]({ systemPrompt: "Hello" });
  expect(result).toBeDefined();
  expect(result.systemPrompt).toContain("Learning Mode Philosophy");

  // Test toggling to off
  await commands["style-off"].handler(undefined, mockCtx);
  expect(readStyle()).toBe("off");
  expect(statusVal).toBe("");

  // Verify before_agent_start returns undefined when off
  const resultOff = await handlers["before_agent_start"]({ systemPrompt: "Hello" });
  expect(resultOff).toBeUndefined();
});

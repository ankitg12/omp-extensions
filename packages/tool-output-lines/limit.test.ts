import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import toolOutputLines, { limitResult, loadLimits, parseCommand, type Context, type Result } from "./limit.ts";

const result = (text: string) => ({ toolName: "bash", content: [{ type: "text", text }] });

describe("tool output line limit", () => {
  test("slash command parses status, off, on and a line count", () => {
    const base = { off: false };
    expect(parseCommand("off", base).next).toEqual({ off: true });
    expect(parseCommand("25", base).next).toEqual({ off: false, maxLines: 25 });
    expect(parseCommand("on", { off: true }).next).toEqual({ off: false });
    expect(parseCommand("1", base).next).toBe(base);
    expect(parseCommand("", { off: true }).message).toContain("off");
  });

  test("stride mode keeps first and last lines, original numbers, and says it is sampled", async () => {
    const numbered = Array.from({ length: 100 }, (_, i) => `${i + 1}|row ${i + 1}`).join("\n");
    const out = await limitResult(result(numbered), { sessionManager: { saveArtifact: async () => "7" } }, { maxLines: 10, maxPreviewChars: 2000, mode: "stride", before: 0, after: 0 });
    const text = (out?.content[0] as { text: string }).text.split("\n");
    expect(text).toHaveLength(10);
    expect(text[0]).toBe("1|row 1");
    expect(text[8]).toBe("100|row 100");
    expect(text[9]).toContain("sampled 9 of 100");
    expect(text[9]).toContain("artifact://7:START-END");
  });

  test("stride mode numbers lines that arrive without numbers", async () => {
    const plain = Array.from({ length: 40 }, (_, i) => `log ${i + 1}`).join("\n");
    const out = await limitResult(result(plain), { sessionManager: { saveArtifact: async () => "2" } }, { maxLines: 5, maxPreviewChars: 2000, mode: "stride", before: 0, after: 0 });
    const text = (out?.content[0] as { text: string }).text.split("\n");
    expect(text.slice(0, 4)).toEqual(["1| log 1", "14| log 14", "27| log 27", "40| log 40"]);
  });

  test("stride context: before/after lines surround each point and the limit still holds", async () => {
    const numbered = Array.from({ length: 100 }, (_, i) => `${i + 1}|row ${i + 1}`).join("\n");
    const store = { sessionManager: { saveArtifact: async () => "7" } };
    const out = await limitResult(result(numbered), store, { maxLines: 10, maxPreviewChars: 2000, mode: "stride", before: 1, after: 1 });
    const text = (out?.content[0] as { text: string }).text.split("\n");
    expect(text.length).toBeLessThanOrEqual(10);
    expect(text[0]).toBe("1|row 1");
    expect(text[1]).toBe("2|row 2");
    expect(text[text.length - 2]).toBe("100|row 100");
    expect(text[text.length - 3]).toBe("99|row 99");
    const huge = await limitResult(result(numbered), store, { maxLines: 4, maxPreviewChars: 2000, mode: "stride", before: 5, after: 5 });
    expect((huge?.content[0] as { text: string }).text.split("\n").length).toBeLessThanOrEqual(4);
  });

  test("slash command accepts context tokens together with mode", () => {
    expect(parseCommand("stride context=2", { off: false }).next).toEqual({ off: false, mode: "stride", before: 2, after: 2 });
    expect(parseCommand("before=1 after=3", { off: false }).next).toEqual({ off: false, before: 1, after: 3 });
    const base = { off: false };
    expect(parseCommand("after=x", base).next).toBe(base);
  });

  test("/tool-lines stride adds a system-prompt note; head removes it", async () => {
    const promptHooks: Array<(event: { systemPrompt?: unknown }) => Promise<unknown>> = [];
    let command: (args: string, ctx: { ui: { notify(message: string): void } }) => Promise<void> = async () => {};
    toolOutputLines({
      on: ((name: string, h: (...args: never[]) => Promise<unknown>) => { if (name === "before_agent_start") promptHooks.push(h as never); }) as never,
      registerCommand: (_n, def) => { command = def.handler; },
    });
    const ui = { ui: { notify() {} } };
    await command("stride", ui);
    expect(JSON.stringify(await promptHooks[0]({ systemPrompt: "base" }))).toContain("evenly spaced sample");
    await command("head", ui);
    expect(await promptHooks[0]({ systemPrompt: "base" })).toBeUndefined();
  });

  test("/tool-lines off stops truncation for the session", async () => {
    const handlers: Record<string, (event: Result, ctx: Context) => Promise<unknown>> = {};
    const promptHooks: Array<(event: { systemPrompt?: unknown }) => Promise<unknown>> = [];
    let command: (args: string, ctx: { ui: { notify(message: string, level?: string): void } }) => Promise<void> = async () => {};
    toolOutputLines({
      on: ((name: string, h: (...args: never[]) => Promise<unknown>) => { if (name === "tool_result") handlers[name] = h as never; else promptHooks.push(h as never); }) as never,
      registerCommand: (_n, def) => { command = def.handler; },
    });
    const ctx = { sessionManager: { saveArtifact: async () => "1" }, ui: { notify() {} } } satisfies Context & { ui: { notify(): void } };
    const long = Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n");
    expect(await handlers.tool_result(result(long), ctx)).toBeDefined();
    await command("off", ctx);
    expect(await handlers.tool_result(result(long), ctx)).toBeUndefined();
    await command("on", ctx);
    expect(await handlers.tool_result(result(long), ctx)).toBeDefined();
  });

  test("loads user limits and applies them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "output-limit-"));
    try {
      const path = join(dir, "config.json");
      await writeFile(path, JSON.stringify({ maxLines: 3, maxPreviewChars: 30 }));
      const limits = await loadLimits(path);
      const output = await limitResult(result("one\ntwo\nthree\nfour"), { sessionManager: { saveArtifact: async () => "1" } }, limits);
      expect(output!.content[0].text!.split("\n")).toHaveLength(3);
      expect(limits).toEqual({ maxLines: 3, maxPreviewChars: 30, mode: "head", before: 0, after: 0 });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("applies per-tool overrides and inherits global values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "output-limit-"));
    try {
      const path = join(dir, "config.json");
      await writeFile(path, JSON.stringify({ maxLines: 10, maxPreviewChars: 2000, tools: { bash: { maxLines: 3 }, grep: { maxPreviewChars: 300 } } }));
      expect(await loadLimits(path, "bash")).toEqual({ maxLines: 3, maxPreviewChars: 2000, mode: "head", before: 0, after: 0 });
      expect(await loadLimits(path, "grep")).toEqual({ maxLines: 10, maxPreviewChars: 300, mode: "head", before: 0, after: 0 });
      expect(await loadLimits(path, "read")).toEqual({ maxLines: 10, maxPreviewChars: 2000, mode: "head", before: 0, after: 0 });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("respects XDG_CONFIG_HOME when selecting the config file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "output-limit-"));
    try {
      const configDir = join(dir, "omp");
      await mkdir(configDir);
      await writeFile(join(configDir, "tool-output-lines.json"), JSON.stringify({ maxLines: 3, maxPreviewChars: 100 }));
      const child = spawnSync(process.execPath, ["-e", 'import { loadLimits } from "./packages/tool-output-lines/limit.ts"; console.log(JSON.stringify(await loadLimits()))'], { cwd: process.cwd(), env: { ...process.env, XDG_CONFIG_HOME: dir }, encoding: "utf8" });
      expect(child.status).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({ maxLines: 3, maxPreviewChars: 100, mode: "head", before: 0, after: 0 });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("caps read and grep display metadata as well as model output", async () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    const ctx = { sessionManager: { saveArtifact: async () => "7" } };
    const limits = { maxLines: 10, maxPreviewChars: 2000 };
    const read = await limitResult({ toolName: "read", input: { path: "artifact://4" }, content: [{ type: "text", text }], details: { resolvedPath: "/long/path", displayContent: { text, startLine: 1, lineNumbers: Array.from({ length: 40 }, (_, i) => i + 1) } } }, ctx, limits);
    const display = read!.details!.displayContent as { text: string; lineNumbers: number[] };
    expect(display.text.split("\n")).toHaveLength(10);
    expect(display.text).toContain("artifact://7");
    expect(display.lineNumbers).toHaveLength(10);
    expect(read!.details!.resolvedPath).toBeUndefined();
    const grep = await limitResult({ toolName: "grep", content: [{ type: "text", text }], details: { displayContent: text } }, ctx, limits);
    expect((grep!.details!.displayContent as string).split("\n")).toHaveLength(10);
  });

  test("caps eval cell output in the terminal", async () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    const output = await limitResult({ toolName: "eval", content: [{ type: "text", text }], details: { cells: [{ code: "print()", output: text, views: [{ text, view: { kind: "markdown", text } }] }] } }, { sessionManager: { saveArtifact: async () => "9" } }, { maxLines: 10, maxPreviewChars: 2000 });
    const cell = (output!.details!.cells as { output: string; views: unknown[] }[])[0];
    expect(cell.output.split("\n")).toHaveLength(10);
    expect(cell.output).toContain("artifact://9");
    expect(cell.views).toEqual([]);
  });

  test("caps AST, glob, and task output metadata", async () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    const ctx = { sessionManager: { saveArtifact: async () => "8" } };
    const limits = { maxLines: 10, maxPreviewChars: 2000 };
    for (const toolName of ["ast_grep", "ast_edit"]) {
      const output = await limitResult({ toolName, content: [{ type: "text", text }], details: { displayContent: text } }, ctx, limits);
      expect((output!.details!.displayContent as string).split("\n")).toHaveLength(10);
    }
    const glob = await limitResult({ toolName: "glob", content: [{ type: "text", text }], details: { files: Array.from({ length: 40 }, (_, i) => `file${i}`) } }, ctx, limits);
    expect(glob!.details!.files).toBeUndefined();
    expect(glob!.details!.fileCount).toBeUndefined();
    expect(glob!.details!.truncated).toBe(true);
    const task = await limitResult({ toolName: "task", content: [{ type: "text", text }], details: { results: [{ output: text }, { output: text }] } }, ctx, limits);
    const results = task!.details!.results as { output: string }[];
    expect(results[0].output.split("\n")).toHaveLength(10);
    expect(results[1].output).toBe("");
  });

  test("keeps short results unchanged", async () => {
    expect(await limitResult(result("one\ntwo"), { sessionManager: { saveArtifact: async () => "1" } })).toBeUndefined();
  });

  test("saves complete output and emits at most ten lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "output-limit-"));
    try {
      const text = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\n");
      const image = { type: "image", data: "abc" };
      let saved = "";
      const output = await limitResult({ ...result(text), content: [...result(text).content, image] }, { sessionManager: { saveArtifact: async value => { saved = value; return "7"; } } });
      expect(output).toBeDefined();
      const preview = output!.content[0].text!;
      expect(preview.split("\n")).toHaveLength(10);
      expect(preview).toContain("[25 lines · full output: artifact://7]");
      expect(saved).toBe(text);
      expect(output!.content[1]).toEqual(image);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("bounds a single oversized line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "output-limit-"));
    try {
      const output = await limitResult(result("x".repeat(5000)), { sessionManager: { saveArtifact: async () => "1" } });
      expect(output!.content[0].text!.length).toBeLessThan(2300);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("does not lose output if storage is unavailable", async () => {
    const text = Array(11).fill("line").join("\n");
    expect(await limitResult(result(text), { sessionManager: { saveArtifact: async () => undefined } })).toBeUndefined();
    expect(await limitResult(result(text), { sessionManager: { saveArtifact: async () => { throw new Error("storage unavailable"); } } })).toBeUndefined();
  });
});

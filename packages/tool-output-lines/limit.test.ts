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
    expect(text[9]).toContain("sampled 9/100");
    expect(text[9]).toContain("artifact://7");
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

  test("read artifact is saved without N| prefixes so reading it back does not double them", async () => {
    let saved = "";
    const text = Array.from({ length: 40 }, (_, i) => `${i + 1}|row ${i + 1}`).join("\n");
    const ctx = { sessionManager: { saveArtifact: async (value: string) => { saved = value; return "5"; } } };
    await limitResult({ toolName: "read", input: { path: "/x" }, content: [{ type: "text", text }], details: {} }, ctx, { maxLines: 10, maxPreviewChars: 2000, mode: "head", before: 0, after: 0 });
    expect(saved.split("\n")[0]).toBe("row 1");
    expect(saved.split("\n")).toHaveLength(40);
  });

  test("skill provenance does not prevent removing generated read prefixes from artifacts", async () => {
    const text = "[Skill file: /tmp/SKILL.md]\n1|---\n2|name: example\n3|---";
    let saved = "";
    await limitResult({ toolName: "read", content: [{ type: "text", text }] }, { sessionManager: { saveArtifact: async value => { saved = value; return "5"; } } }, { maxLines: 2, maxPreviewChars: 2000, mode: "head", before: 0, after: 0 });
    expect(saved).toBe("[Skill file: /tmp/SKILL.md]\n---\nname: example\n---");
  });

  test("raw read content beginning with a number and pipe remains unchanged", async () => {
    const text = "1|payload\n2|payload\n3|payload";
    let saved = "";
    await limitResult({ toolName: "read", input: { path: "/tmp/data:raw" }, content: [{ type: "text", text }] }, { sessionManager: { saveArtifact: async value => { saved = value; return "5"; } } }, { maxLines: 2, maxPreviewChars: 2000, mode: "head", before: 0, after: 0 });
    expect(saved).toBe(text);
  });

  test("sampled raw ranges show source numbers to the model", async () => {
    const text = Array.from({ length: 51 }, (_, i) => `row ${i + 220}`).join("\n");
    for (const path of ["/x:220-270:raw", "/x:raw:220-270"]) {
      const out = await limitResult({ toolName: "read", input: { path }, content: [{ type: "text", text }], details: { displayContent: { text, startLine: 220 } } }, { sessionManager: { saveArtifact: async () => "5" } }, { maxLines: 10, maxPreviewChars: 2000, mode: "stride", before: 0, after: 0 });
      const block = out!.content[0];
      if (!("text" in block) || typeof block.text !== "string") throw new Error("missing text");
      const modelLines = block.text.split("\n");
      expect(modelLines[0]).toBe("220| row 220");
      expect(modelLines.at(-2)).toBe("270| row 270");
      const display = out!.details!.displayContent;
      if (!display || typeof display !== "object" || !("text" in display)) throw new Error("missing display");
      expect(display.text).toBe(block.text);
    }
  });

  test("sampled raw source lines keep numeric pipe content", async () => {
    const text = Array.from({ length: 40 }, (_, i) => `${i + 1}|payload`).join("\n");
    const out = await limitResult({ toolName: "read", input: { path: "/x:220-259:raw" }, content: [{ type: "text", text }] }, { sessionManager: { saveArtifact: async () => "5" } }, { maxLines: 10, maxPreviewChars: 2000, mode: "stride", before: 0, after: 0 });
    const block = out!.content[0];
    if (!("text" in block) || typeof block.text !== "string") throw new Error("missing text");
    expect(block.text.split("\n")[0]).toBe("220| 1|payload");
    expect(block.text.split("\n").at(-2)).toBe("259| 40|payload");
  });

  test("read stride notice is short; coordinate guidance lives in the session note", async () => {
    const text = Array.from({ length: 40 }, (_, i) => `${i + 101}|row ${i + 101}`).join("\n");
    const out = await limitResult({ toolName: "read", input: { path: "/x:101-140" }, content: [{ type: "text", text }], details: {} }, { sessionManager: { saveArtifact: async () => "5" } }, { maxLines: 10, maxPreviewChars: 2000, mode: "stride", before: 0, after: 0 });
    const notice = out!.content[0].text!.split("\n").at(-1)!;
    expect(notice).toBe("[sampled 9/40 lines · artifact://5]");
  });

  test("terminal preview of read shows exactly the text the model receives, line numbers included", async () => {
    const text = Array.from({ length: 100 }, (_, i) => `${i + 1}|row ${i + 1}`).join("\n");
    const plain = Array.from({ length: 100 }, (_, i) => `row ${i + 1}`).join("\n");
    const ctx = { sessionManager: { saveArtifact: async () => "5" } };
    for (const mode of ["stride", "head"] as const) {
      const out = await limitResult({ toolName: "read", content: [{ type: "text", text }], details: { displayContent: { text: plain, startLine: 1, lineNumbers: Array.from({ length: 100 }, (_, i) => i + 1) } } }, ctx, { maxLines: 10, maxPreviewChars: 2000, mode, before: 0, after: 0 });
      const display = out!.details!.displayContent as { text: string; lineNumbers?: unknown };
      expect(display.text).toBe((out!.content[0] as { text: string }).text);
      expect(display.text.split("\n")[0]).toBe("1|row 1");
      expect(display.lineNumbers).toBeUndefined();
      expect(out!.details!.contentType).toBe("text/plain");
    }
  });

  test("an OMP-elided read has one notice pointing to the full artifact", async () => {
    const text = `${Array.from({ length: 100 }, (_, i) => `${i + 1}|row ${i + 1}`).join("\n")}\n[Showing lines 1-100 and 168-251 of 251; 67 middle lines (3.2KB) elided. Read artifact://68 for full output]`;
    let saves = 0;
    const out = await limitResult({ toolName: "read", content: [{ type: "text", text }], details: { displayContent: { text: "old", startLine: 1 }, meta: { truncation: { artifactId: "68" }, other: "keep" } } }, { sessionManager: { saveArtifact: async () => { saves++; return "5"; } } }, { maxLines: 10, maxPreviewChars: 2000, mode: "stride", before: 0, after: 0 });
    const block = out!.content[0];
    if (!("text" in block) || typeof block.text !== "string") throw new Error("missing text");
    const result = block.text;
    expect(result).toContain("[sampled ");
    expect(result).toContain("OMP omitted 67 of 251 source lines");
    expect(result).toContain("full output: artifact://68");
    expect(result).not.toContain("artifact://5");
    expect(result).not.toContain("[Showing lines");
    const display = out!.details!.displayContent;
    if (!display || typeof display !== "object" || !("text" in display)) throw new Error("missing display");
    expect(display.text).toBe(result);
    const meta = out!.details!.meta;
    if (!meta || typeof meta !== "object") throw new Error("missing metadata");
    expect("truncation" in meta).toBe(false);
    expect("other" in meta && meta.other).toBe("keep");
    expect(saves).toBe(0);
  });

  test("combines an OMP continuation notice with the sampled-result notice", async () => {
    const text = `${Array.from({ length: 70 }, (_, i) => `${i + 1}|row ${i + 1}`).join("\n")}\n\n[Showing lines 1-70 of 129 (9.6KB limit). Use :71 to continue]`;
    const out = await limitResult({ toolName: "read", input: { path: "notes.md" }, content: [{ type: "text", text }], details: { displayContent: { text: "old" }, meta: { truncation: { direction: "head", truncatedBy: "bytes", totalLines: 129, shownRange: { start: 1, end: 70 }, nextOffset: 71 }, other: "keep" } } }, { sessionManager: { saveArtifact: async () => "5" } }, { maxLines: 10, maxPreviewChars: 2000, mode: "stride", before: 0, after: 0 });
    const block = out!.content[0];
    if (!("text" in block) || typeof block.text !== "string") throw new Error("missing text");
    expect(block.text).toContain("sampled");
    expect(block.text).toContain("OMP showed 1-70 of 129 source lines");
    expect(block.text).toContain("continue source at :71");
    expect(block.text).toContain("partial result: artifact://5");
    expect(block.text).not.toContain("[Showing lines");
    const meta = out!.details!.meta;
    if (!meta || typeof meta !== "object") throw new Error("missing metadata");
    expect("truncation" in meta).toBe(false);
    expect("other" in meta && meta.other).toBe("keep");
  });

  test("does not trust a continuation footer without matching metadata", async () => {
    const text = `${Array.from({ length: 70 }, (_, i) => `${i + 1}|row ${i + 1}`).join("\n")}\n\n[Showing lines 1-70 of 129 (9.6KB limit). Use :71 to continue]`;
    let saved = "";
    const out = await limitResult({ toolName: "read", input: { path: "notes.md" }, content: [{ type: "text", text }], details: {} }, { sessionManager: { saveArtifact: async value => { saved = value; return "5"; } } }, { maxLines: 10, maxPreviewChars: 2000, mode: "stride", before: 0, after: 0 });
    const block = out!.content[0];
    if (!("text" in block) || typeof block.text !== "string") throw new Error("missing text");
    expect(block.text).not.toContain("OMP showed 1-70 of 129 source lines");
    expect(saved).toContain("[Showing lines 1-70 of 129");
  });

  test("a footer without matching native truncation metadata is not trusted", async () => {
    const text = `${Array.from({ length: 100 }, (_, i) => `${i + 1}|row ${i + 1}`).join("\n")}\n[Showing lines 1-100 and 168-251 of 251; 67 middle lines (3.2KB) elided. Read artifact://68 for full output]`;
    let saved = "";
    const out = await limitResult({ toolName: "read", content: [{ type: "text", text }], details: {} }, { sessionManager: { saveArtifact: async value => { saved = value; return "5"; } } }, { maxLines: 10, maxPreviewChars: 2000, mode: "stride", before: 0, after: 0 });
    const block = out!.content[0];
    if (!("text" in block) || typeof block.text !== "string") throw new Error("missing text");
    expect(block.text).toContain("artifact://5");
    expect(saved).toContain("Read artifact://68 for full output");
  });

  test("a range read within the limit returns in full even when OMP adds context lines", async () => {
    const text = Array.from({ length: 14 }, (_, i) => `${i + 39}|row ${i + 39}`).join("\n");
    const ctx = { sessionManager: { saveArtifact: async () => "5" } };
    const limits = { maxLines: 10, maxPreviewChars: 2000, mode: "stride" as const, before: 0, after: 0 };
    expect(await limitResult({ toolName: "read", input: { path: "/x/a.ts:40-49" }, content: [{ type: "text", text }], details: {} }, ctx, limits)).toBeUndefined();
    expect(await limitResult({ toolName: "read", input: { path: "/x/a.ts:40+10" }, content: [{ type: "text", text }], details: {} }, ctx, limits)).toBeUndefined();
    expect(await limitResult({ toolName: "read", input: { path: "/x/a.ts:40-60" }, content: [{ type: "text", text }], details: {} }, ctx, limits)).toBeDefined();
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
    const headPrompt = JSON.stringify(await promptHooks[0]({ systemPrompt: "base" }));
    expect(headPrompt).toContain("read <path>:START-END");
    expect(headPrompt).not.toContain("evenly spaced sample");
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
    const limits = { maxLines: 10, maxPreviewChars: 2000, mode: "head" as const, before: 0, after: 0 };
    const read = await limitResult({ toolName: "read", input: { path: "artifact://4" }, content: [{ type: "text", text }], details: { resolvedPath: "/long/path", displayContent: { text, startLine: 1, lineNumbers: Array.from({ length: 40 }, (_, i) => i + 1) } } }, ctx, limits);
    const display = read!.details!.displayContent as { text: string };
    expect(display.text.split("\n")).toHaveLength(10);
    expect(display.text).toContain("artifact://7");
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

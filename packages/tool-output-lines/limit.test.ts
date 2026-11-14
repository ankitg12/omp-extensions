import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { limitResult, loadLimits } from "./limit.ts";

const result = (text: string) => ({ toolName: "bash", content: [{ type: "text", text }] });

describe("tool output line limit", () => {
  test("loads user limits and applies them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "output-limit-"));
    try {
      const path = join(dir, "config.json");
      await writeFile(path, JSON.stringify({ maxLines: 3, maxPreviewChars: 30 }));
      const limits = await loadLimits(path);
      const output = await limitResult(result("one\ntwo\nthree\nfour"), { sessionManager: { saveArtifact: async () => "1" } }, limits);
      expect(output!.content[0].text!.split("\n")).toHaveLength(3);
      expect(limits).toEqual({ maxLines: 3, maxPreviewChars: 30 });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("applies per-tool overrides and inherits global values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "output-limit-"));
    try {
      const path = join(dir, "config.json");
      await writeFile(path, JSON.stringify({ maxLines: 10, maxPreviewChars: 2000, tools: { bash: { maxLines: 3 }, grep: { maxPreviewChars: 300 } } }));
      expect(await loadLimits(path, "bash")).toEqual({ maxLines: 3, maxPreviewChars: 2000 });
      expect(await loadLimits(path, "grep")).toEqual({ maxLines: 10, maxPreviewChars: 300 });
      expect(await loadLimits(path, "read")).toEqual({ maxLines: 10, maxPreviewChars: 2000 });
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
      expect(JSON.parse(child.stdout)).toEqual({ maxLines: 3, maxPreviewChars: 100 });
    } finally { await rm(dir, { recursive: true, force: true }); }
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

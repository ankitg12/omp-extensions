import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { limitResult, loadLimits } from "./limit.ts";

const result = (text: string) => ({ toolName: "bash", content: [{ type: "text", text }] });

describe("tool output line limit", () => {
  test("loads user limits and applies them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "output-limit-"));
    try {
      const path = join(dir, "config.json");
      await writeFile(path, JSON.stringify({ maxLines: 3, maxPreviewChars: 30 }));
      const limits = await loadLimits(path);
      const output = await limitResult(result("one\ntwo\nthree\nfour"), { sessionManager: { getArtifactsDir: () => dir } }, limits);
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

  test("keeps short results unchanged", async () => {
    expect(await limitResult(result("one\ntwo"), { sessionManager: { getArtifactsDir: () => "/unused" } })).toBeUndefined();
  });

  test("saves complete output and emits at most ten lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "output-limit-"));
    try {
      const text = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\n");
      const image = { type: "image", data: "abc" };
      const output = await limitResult({ ...result(text), content: [...result(text).content, image] }, { sessionManager: { getArtifactsDir: () => dir } });
      expect(output).toBeDefined();
      const preview = output!.content[0].text!;
      expect(preview.split("\n")).toHaveLength(10);
      const path = preview.match(/full output: (.+?)\. Use read/)![1];
      expect(await readFile(path, "utf8")).toBe(text);
      expect(output!.content[1]).toEqual(image);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("bounds a single oversized line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "output-limit-"));
    try {
      const output = await limitResult(result("x".repeat(5000)), { sessionManager: { getArtifactsDir: () => dir } });
      expect(output!.content[0].text!.length).toBeLessThan(2300);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("does not lose output if storage is unavailable", async () => {
    const text = Array(11).fill("line").join("\n");
    expect(await limitResult(result(text), { sessionManager: { getArtifactsDir: () => undefined } })).toBeUndefined();
    expect(await limitResult(result(text), { sessionManager: { getArtifactsDir: () => "/dev/null/nope" } })).toBeUndefined();
  });
});

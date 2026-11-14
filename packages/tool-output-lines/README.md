# Tool output lines

By default, limits text in each tool result to ten lines, including a notice that points to the full output in the session artifact directory. Preview text is also capped at 2,000 characters. Use `read` with a line range on that path for more detail. Non-text blocks and result error status are unchanged.

Configure `~/.config/omp/tool-output-lines.json`:

```json
{
  "maxLines": 10,
  "maxPreviewChars": 2000,
  "tools": {
    "bash": { "maxLines": 5 },
    "grep": { "maxPreviewChars": 1000 }
  }
}
```

Global limits are required; per-tool overrides are optional and inherit any omitted field. Tool names are exact. The minimum line limit is 2 and the minimum character limit is 1. Invalid configuration falls back to the defaults. Changes apply to the next tool result.

If the session has no artifact directory or the file cannot be saved, the extension leaves the result unchanged. Existing tool-side truncation happens first; the saved output is the result the extension receives.

Test with `bun test packages/tool-output-lines/limit.test.ts` from the repository root.

# Tool output lines

By default, limits text in each tool result to ten lines, including a notice with a short `artifact://` reference. Preview text is also capped at 2,000 characters. The limit also applies to structured `read`, `grep`, `ast_grep`, `ast_edit`, `glob`, `eval`, and `task` terminal previews. Use `read` with a line range, such as `artifact://1:10-19`, for more detail. Non-text blocks and result error status are unchanged.

OMP normally passes loaded extensions to subagents. A subagent configured to disable extensions, such as the isolated seance mode, does not inherit this limit. Tool streaming can appear before a final result is available; this extension limits the final result.

Configure `$XDG_CONFIG_HOME/omp/tool-output-lines.json`, or `~/.config/omp/tool-output-lines.json` when `XDG_CONFIG_HOME` is unset, empty, or not absolute:

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

If the session cannot save an artifact, the extension leaves the result unchanged. Existing tool-side truncation happens first; the saved output is the result the extension receives.

Test with `bun test packages/tool-output-lines/limit.test.ts` from the repository root.

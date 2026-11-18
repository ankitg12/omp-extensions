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

## Modes: head and stride

`"mode": "head"` (default) keeps the first lines. `"mode": "stride"` keeps evenly spaced lines from the whole output, always including the first and the last. Each sampled line shows its original line number (added when the tool gave none), and the notice reads `[sampled K of N evenly spaced lines ...]`. This gives the agent a zoom-out view; it zooms in with `read artifact://ID:START-END` or `read <path>:START-END`. When any configured mode is `stride`, the extension appends a short note about this to the system prompt, so the agent knows the lines are not contiguous. Set `mode` globally or per tool:

```json
{ "maxLines": 10, "maxPreviewChars": 2000, "tools": { "read": { "mode": "stride", "before": 1, "after": 1 } } }
```

`before` and `after` (default 0, like `grep -B` and `-A`) add context lines around each sample point. The total still stays within `maxLines`: the extension uses fewer sample points when context lines take space, and it drops the context if two points with context would not fit.

Change the limit for the current session with `/tool-lines`: `off` stops truncation, `<N>` sets the line limit (minimum 2), `head` or `stride` sets the mode, `before=N`, `after=N`, or `context=N` (both) sets the context lines (tokens combine, for example `/tool-lines stride context=2 40`), `on` or `reset` returns to the config file limits, and no argument shows the state. The override lasts until the session ends and does not change the config file.

Global limits are required; per-tool overrides are optional and inherit any omitted field. Tool names are exact. The minimum line limit is 2 and the minimum character limit is 1. Invalid configuration falls back to the defaults. Changes apply to the next tool result.

If the session cannot save an artifact, the extension leaves the result unchanged. Existing tool-side truncation happens first; the saved output is the result the extension receives.

Test with `bun test packages/tool-output-lines/limit.test.ts` from the repository root.

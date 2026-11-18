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

`"mode": "head"` (default) keeps the first lines. `"mode": "stride"` keeps evenly spaced lines from the tool result. A `read` with an explicit range within the line limit (`path:START-END` or `path:START+COUNT`) is kept intact only when it also fits the character limit, even though OMP adds context lines and a footer around it. The terminal preview of `read` shows exactly the text the model receives, line-number prefixes included. For a sampled `read`, use `read <original-path>:START-END` with the displayed source line numbers to zoom in. An artifact contains the saved tool result, which can already be a range or summary; its line numbers are relative to that result and may not match the source. For other tools, `read artifact://ID:START-END` uses result line numbers. The extension adds a note to the system prompt on every prompt that says how to get exact lines: request a range within the limit. When stride is active, the note also explains sampled results; each sampled result carries only a short `[sampled K/N lines · artifact://ID]` notice. Set `mode` globally or per tool:

```json
{ "maxLines": 10, "maxPreviewChars": 2000, "tools": { "read": { "mode": "stride", "before": 1, "after": 1 } } }
```

`before` and `after` (default 0, like `grep -B` and `-A`) add context lines around each sample point. The total still stays within `maxLines`: the extension uses fewer sample points when context lines take space, and it drops the context if two points with context would not fit.

Stride mode follows the idea of [VenetianBlinds.js](https://github.com/firasd/vblinds), which samples a text file at evenly spaced character positions. This extension samples whole lines, keeps their original line numbers, and holds the result to `maxLines`. For code, [Aider's repository map](https://aider.chat/docs/repomap.html) is a different approach that shows symbols within a token budget.

Change the limit for the current session with `/tool-lines`: `off` stops truncation, `<N>` sets the line limit (minimum 2), `head` or `stride` sets the mode, `before=N`, `after=N`, or `context=N` (both) sets the context lines (tokens combine, for example `/tool-lines stride context=2 40`), `on` or `reset` returns to the config file limits, and no argument shows the state. The override lasts until the session ends and does not change the config file.

Global limits are required; per-tool overrides are optional and inherit any omitted field. Tool names are exact. The minimum line limit is 2 and the minimum character limit is 1. Invalid configuration falls back to the defaults. Changes apply to the next tool result.

Tool-side truncation happens first. When OMP supplies a verified full-output artifact, the extension combines both truncation notices and points to that artifact. For a verified byte-limited source read, the combined notice gives the source continuation and labels the saved result as partial. Otherwise, the extension saves the tool result it received; this may already be truncated. If saving fails, the extension leaves the result unchanged. Raw reads are limited too; their saved artifact retains the tool output verbatim.

Test with `bun test packages/tool-output-lines/limit.test.ts` from the repository root.

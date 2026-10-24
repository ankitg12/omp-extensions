# agent-dream-omp

Idle-time memory consolidation for OMP sessions. After sustained idle (default
30 min) with the diary cooldown elapsed (default 12 h), injects the bundled
`dream` skill pass as a follow-up turn: mines recent session JSONLs for durable
lessons, updates memory, prepends a `DREAMS.md` diary entry.

No OMP fork. Pure user-space extension: one timer, one idle gate, one command.

## Install

Add the package path to `extensions` in `~/.omp/agent/config.yml`:

```yaml
extensions:
  - ~/repos/github.com/ankitg12/omp-extensions/packages/agent-dream-omp
```

## Configure

Copy [`agent-dream.example.json`](./agent-dream.example.json) to
`~/.omp/agent/agent-dream.json` and edit to taste. All fields optional.

| Field | Default | Description |
|---|---|---|
| `idleMs` | `1800000` (30 min) | Fire after this long with no turn/terminal activity. |
| `minIntervalMs` | `43200000` (12 h) | Minimum gap between diary entries. |
| `diaryPath` | `~/Notes/dreams/DREAMS.md` | Newest-first diary, capped at `maxDiaryEntries`. |
| `maxSessions` | `10` | Sessions scanned per pass. |
| `maxDiaryEntries` | `50` | Diary entries kept (old `maxEntries` still accepted). |
| `maxMemoriesPerPass` | `20` | Memories written per pass, highest-signal first. |
| `maxDiaryEntryLines` | `30` | Max lines per diary entry body. |
| `logPath` | `~/.omp/agent/agent-dream.log` | Log file. |
| `memoryFile` | `""` (diary only) | Per-project memory file. Empty = lessons go to the diary only, never invented paths. |
| `reportPath` | `~/.omp/agent/agent-dream-report.json` | Skill report JSON; folded into state on next start. |
| `enabled` | `true` | Master switch. |
| `debug` | `false` | Log arming/cooldown to `logPath`. |

Last-pass state lives in `~/.omp/agent/agent-dream-state.json` (written on
every injected pass, enriched from the skill's report JSON on next start):
timestamp, trigger reason, sessions/memories reported, diary entry, total
passes. `/dream status` reads it.

## Helper scripts

- `dream-index [--max N] [--exclude <sessionId>]` — session JSONLs newest-first
  (`mtime lines path`); replaces 4–5 discovery tool calls in the pass.
- `dream-diary --diary <path> --max <n> --entry-file <tmp>` — prepend entry +
  trim, atomically; prints the entry timestamp.

## Commands

- `/dream` / `/dream now` — run the pass now (bypasses idle gate, not cooldown).
- `/dream status` — idle time, cooldown, last pass (from state file).
- `/dream diary` — diary path.
- `/dream log` — log file path.

## Behavior

- Fires only when `ctx.isIdle()`; mid-turn it re-arms instead.
- Any `turn_end` / `agent_end` / keystroke resets the idle clock.
- Subscribes to the `agent-afk` bus (`afk:changed`): AFK engage starts the
  idle clock, disengage re-arms. Works standalone without agent-afk.
- Raw `setInterval`-family timers with `try/catch` containment and
  `session_shutdown` cleanup (same pattern as `agent-afk`): the SDK
  (`pi-coding-agent@16.1.16`) types `ExtensionContext` without the documented
  `ctx.setTimeout`/`ctx.clearTimer` managed timers.

## Headless / cron

`omp-dream` runs the same pass without a live session:

```bash
./omp-dream --dry-run   # show what the next pass would scan
./omp-dream             # one headless pass, exits afterwards
```

Suitable for `cron`/launchd on a 12–24 h schedule as a backstop for sessions
that never idle long enough in-TUI.

## Verifying consolidation works

Testing the write path is not enough — test retrieval:

1. Session one: state an explicit preference ("always X").
2. Run `/dream now`; confirm the diary entry and memory write.
3. Session two (fresh): ask a question requiring the preference; check the
   answer uses it.
4. Session three: state the opposite; run `/dream now`; confirm session four
   follows the new value (merge logic).

## Test

```bash
bun test && bun run typecheck
```

# agent-cost-guard-omp

A zero-dependency OMP extension that warns as session cost approaches a configurable USD limit, then stops further agent work at the limit.

## Install

Clone the repository and add its path to `~/.omp/agent/config.yml`:

```yaml
extensions:
  - ~/repos/github.com/ankitg12/agent-cost-guard-omp/cost-guard.ts
```

Set thresholds for one launch:

```bash
OMP_COST_WARN=8 OMP_COST_LIMIT=10 OMP_COST_REMINDER_STEP=5 omp
```

Defaults are **$8 warning**, **$10 one-time abort**, then a reminder for each additional **$5** spent after deliberate continuation.

## Configuration

Precedence, highest first: **environment variables → config file → built-in defaults.**

The config file is `~/.omp/cost-guard.json` (override its path with `OMP_COST_CONFIG`). A missing or malformed file is ignored silently.

```json
{
  "warn": 8,
  "limit": 10,
  "reminderStep": 5,
  "abortEachStep": false,
  "debugLog": "C:/Users/you/.omp/cost-guard.log"
}
```

| Key | Env var | Default | Meaning |
| --- | --- | --- | --- |
| `warn` | `OMP_COST_WARN` | `8` | One-time warning threshold, USD. |
| `limit` | `OMP_COST_LIMIT` | `10` | Abort threshold, USD. |
| `reminderStep` | `OMP_COST_REMINDER_STEP` | `5` | Checkpoint interval past the limit. |
| `abortEachStep` | `OMP_COST_ABORT_EACH_STEP` | `false` | Error and abort at **every** checkpoint past the limit, not just the first. |
| `debugLog` | `OMP_COST_DEBUG_LOG` | *(off)* | Absolute path to an append-only debug log. |

### Error at each limit

By default the guard aborts once at the limit and thereafter only *reminds* every `reminderStep`, so a deliberately continued session is never blocked again. With `abortEachStep` enabled, each subsequent checkpoint raises an error notification and calls `ctx.abort()` again — every further increment of spend must be consciously re-authorised.

```bash
OMP_COST_ABORT_EACH_STEP=1 OMP_COST_DEBUG_LOG=~/.omp/cost-guard.log omp
```

### Debug log

With `debugLog` set, the extension appends one ISO-timestamped line per event: the resolved configuration and its source at startup, then every `session_start`/`turn_end` with cumulative spend and guard state, plus each warning, abort, and reminder. Logging failures are swallowed and can never break a session.

## What it counts

At the end of every turn, the extension recomputes cumulative spend from the active session branch:

- assistant-message usage;
- `task` tool-result usage from subagents; and
- costs already present when a session is resumed.

When spend reaches the warning threshold, it emits a notification. At the limit, it calls OMP's supported `ctx.abort()` method once. The session remains resumable; a resumed session starts from its existing cumulative cost and emits deduplicated reminders at later checkpoints.

## Soft-cap limitation

This is a soft cap, not a prepaid-token reservation. OMP learns the actual cost after the provider finishes a response, so the session can overshoot by one turn. A single expensive request can therefore cross the limit substantially before the extension can abort subsequent work.

A native pre-request budget mechanism in OMP or an LLM gateway is required for a hard cap.

`ctx.abort()` stops the current operation; it does not delete the session. This was verified by continuing a persisted session after its guard fired: cumulative cost advanced from `$0.13` to `$0.25`, demonstrating that the resumed prompt was accepted and processed.

## Requirements

Tested with OMP v17.2.9.

## License

MIT

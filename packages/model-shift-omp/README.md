# model-shift-omp

Switches the session model when a [CEL](https://cel.dev) rule over spend, context, or turns matches.
Example: "after $1, move from Opus to Sonnet".

## Config

The rules file is `~/.omp/model-shift.yml`. Set `OMP_MODEL_SHIFT_CONFIG` to use another path. If there is no file, the extension does nothing.

```yaml
enabled: true          # optional, default true
agents: [main]         # optional; agent kinds to act in (main | sub)
rules:                 # ordered; first matching, not-yet-fired rule wins
  - name: budget
    when: 'cost > 1.0 && model.startsWith("amd-claude/claude-opus")'
    use: amd-claude/claude-sonnet-4.5     # provider/id, or a role alias such as '@smol'
  - name: big-context
    when: 'tokens > 100000'
    use: '@slow'
    effort: medium                        # optional thinking level after the switch
  - name: away
    when: 'afk'
    use: '@smol'
    revert: true                          # restore the previous model (and effort) when `when` turns false
```

| Variable | CEL type | Meaning |
|---|---|---|
| `cost` | double | Session spend in USD: assistant usage plus `task` subagent usage (same method as agent-cost-guard-omp) |
| `tokens` | int | Current context tokens |
| `context_window` | int | Context window of the current model |
| `context_pct` | double | Percentage of the context window used (0–100) |
| `turns` | int | Number of user prompts in this branch |
| `elapsed_min` | double | Minutes since the first session entry |
| `model` | string | Current model as `provider/id` |
| `agent` | string | `main` or `sub` |
| `afk` | bool | AFK mode is on (from agent-afk-omp) |

The extension type-checks all rules when it loads the config. If one rule has a typo or does not return a bool, it rejects the whole file and shows an error. It does not drop the bad rule and keep the rest, because that would silently change the first-match order.

## Behaviour

- The extension checks the rules at **`agent_end`**, which is between prompts. A model change rebuilds the system prompt for that model, and `before_agent_start` is too late for that turn.
- **One-way by default:** each rule fires at most once per session.
- **`revert: true`:** while the rule is applied, no other rule fires. When its expression becomes false, the extension restores the previous model and effort, and the rule is armed again. Each direction costs one cold cache read.
- **Manual override:** if you change the model with `/model` after an automatic switch, the extension pauses for the rest of the session.
- **Guards:** the extension disables a matching rule, and does not switch, in these cases:
  - the target does not resolve to a model;
  - the target has no credentials;
  - the target's context window is smaller than the current context.
- **Persistence:** the extension stores fired and paused state as `model-shift` custom session entries, so the state is kept when you resume a session. It also writes an audit log to `~/.omp/logs/model-shift.jsonl`.
- **Commands:**
  - `/model-shift` shows the live variables and each rule's current result.
  - `/model-shift reset` re-arms all rules.
  - `/model-shift reload` reads the config file again.

## AFK integration

agent-afk-omp publishes `afk:changed` on the shared extension bus (`pi.events`) with the payload `{ active, auto, waitUntil }`. Before it sends its AFK prompt or its back prompt, it waits up to 5 s for any promises passed to `waitUntil(promise)`. The pattern is the same as ServiceWorker `ExtendableEvent.waitUntil`. model-shift uses this to switch *before* that prompt, but only when the agent is idle. So the whole AFK run uses the AFK model, and the back prompt already runs on your original model.

The AFK flag is kept in memory only. A resumed session starts with `afk = false`, so an applied AFK rule reverts on the first evaluation.

## Cost caveat

A switch starts the new model with a **cold prompt cache**. The first prompt after the switch pays the full input price for the whole context. A context-size rule (`tokens > 100000`) can cost more than it saves. Rules based on spend, at small context, are the safe case.

The limit is soft. Cost is known only after a turn ends, so one large turn can go past the threshold before the switch happens.

## Coexistence with decaying-effort-omp

The live test (`WITH_DECAY=1`) shows that a switch without `effort:` does not trigger decaying-effort's manual-override detection. A rule *with* `effort:` sets the thinking level directly, so decaying-effort reads it as an override and pauses. This is intended: the rule now controls effort.

## Verify

```
bun test                       # unit: compile, decide, state replay, cost accounting
bun verify-live.ts @smol @scout            # live RPC: real switch between two prompts (~$0.01)
WITH_DECAY=1 bun verify-live.ts            # same, with decaying-effort loaded
AFK=1 bun verify-live.ts                   # prompt → /afk → /back must be answered by A, B, A
```

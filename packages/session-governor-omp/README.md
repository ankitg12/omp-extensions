# session-governor-omp

A single policy engine for session model selection, thinking effort, and wire-level context pruning in [oh-my-pi](https://github.com/can1357/oh-my-pi).

Merges and replaces `@ankitg12/model-shift-omp`, `@ankitg12/model-switch-prune-omp`, and `@ankitg12/decaying-effort-omp`.

## Why one extension?

Previously, `model-shift-omp` switched models based on cost or context size, while `model-switch-prune-omp` pruned foreign tool outputs on the wire. When they operated separately:
1. Model switches and context prunes happened at different turn boundaries, causing **two separate cache misses** (cold prompt reads).
2. Wire-only pruning does not shrink the saved disk history, so native auto-compaction still calculated context size against the stored estimate and triggered unexpectedly.

`session-governor-omp` unifies both actions under a single [CEL](https://cel.dev) rule engine:
- If a rule switches the model and prunes at the same turn boundary, you pay for **one cold cache read**, not two.
- Pruning uses a **latched cut point** (`cutTs`), so earlier tool outputs are elided while maintaining byte-level prefix stability across subsequent requests.
- Foreign model outputs are automatically pruned on model transitions to avoid cross-provider tool-call formatting errors.

## Config

The rules file is `~/.omp/governor.yml` (fallback env: `OMP_GOVERNOR_CONFIG`). If missing, default wire-level foreign pruning remains active (`elide` mode).

```yaml
enabled: true          # optional, default true
agents: [main]         # optional; agent kinds to act in (main | sub)

# Global pruning behavior
prune:
  foreign: elide       # elide | drop | keep (default: elide)
  debug: false         # write prune metrics to log when they change

rules:                 # ordered; first matching rule wins
  - name: budget
    when: 'cost > 1.0 && model.startsWith("amd-claude/claude-opus")'
    use: amd-claude/claude-sonnet-4.5
    prune: true        # prune older tool results at the same boundary

  - name: context-epoch
    when: 'tokens > 80000 && turns_since_prune >= 4'
    prune: true        # epoch prune older results without switching models
    repeat: true       # allow re-arming once turns_since_prune resets

  - name: away
    when: 'afk'
    use: '@smol'
    revert: true       # restore previous model/effort when afk becomes false

  # Effort decay (replaces decaying-effort-omp). Rules run at agent_end, so each
  # step applies to the NEXT turn; set defaultThinkingLevel: max in OMP config so
  # turn 1 starts at the top of the schedule.
  - name: effort-xhigh
    when: 'turns >= 1 && cost < 1.0'   # cost guard: do not raise effort after a budget rule
    effort: xhigh                      # effort-only rule: no 'use', no 'revert', no 'repeat'
  - name: effort-auto
    when: 'turns >= 4'
    effort: auto
```

### Manual overrides

The engine has two independent pauses. Both persist in the session and `/governor reset` clears both.

| You change | Paused | Still armed |
|---|---|---|
| Model (`/model`) after a governor switch | Rules with `use:`; no revert | Effort-only and prune rules |
| Effort (Shift+Tab) after a governor effort change | Effort-only rules | Model and prune rules |

Effort is compared by the *selector* (`configured` on the last `thinking_level_change` entry), not the resolved level, because `auto` re-resolves each prompt.

Sessions recorded by `model-shift-omp` are read too: a legacy `paused` entry restores as a model-rule pause.

### Native compaction

Wire pruning lowers the billed token count only. Native compaction triggers on `max(billed, stored)` and runs before extension `agent_end`, so it cannot be delayed by this extension. Keep native compaction on as the safety net and set its thresholds above the governor's prune thresholds.

### Rule Variables

| Variable | CEL type | Meaning |
|---|---|---|
| `turns_since_prune` | int | User prompts since the last epoch cut (or total turns if never pruned) |
| `cost` | double | Session spend in USD (assistant + `task` subagent usage) |
| `tokens` | int | Current context tokens reported by OMP |
| `context_window` | int | Context window of the current model |
| `context_pct` | double | Percentage of context window used (0–100) |
| `turns` | int | Total user prompts in the session branch |
| `elapsed_min` | double | Minutes since the first session entry |
| `model` | string | Current model as `provider/id` |
| `agent` | string | `main` or `sub` |
| `afk` | bool | AFK mode state (from `agent-afk-omp`) |

## Commands

- `/governor` — Show engine status, live CEL variables, recent prune savings, and rule match state.
- `/governor reload` — Re-read `~/.omp/governor.yml` without restarting the session.
- `/governor reset` — Re-arm all one-way rules and clear manual override pauses (keeps existing epoch cut).

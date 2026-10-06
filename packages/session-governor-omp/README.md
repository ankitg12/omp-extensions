# session-governor-omp

A single policy engine for session model selection, thinking effort, and wire-level context pruning in [oh-my-pi](https://github.com/can1357/oh-my-pi).

Replaces `@ankitg12/model-shift-omp` and `@ankitg12/decaying-effort-omp`.

## Policy here, mechanism elsewhere

This extension is **policy**: CEL rules decide *when* to switch model, set effort, or prune.
Pruning the previous model's tool turns after a switch is **mechanism**, not policy: it must happen on
every switch, whether or not the governor is installed or enabled. That lives in
[`model-switch-prune-omp`](../model-switch-prune-omp), which also owns the shared pure functions in
`prune.ts`. The governor imports `pruneBeforeCut` from there for rule-driven epoch cuts.

Install both, governor first: OMP chains `context` handlers in load order, and the epoch pass must
see raw tool results before the switch pass folds foreign ones into user messages.

Why policy-driven pruning is in the governor:
- If a rule switches the model and prunes at the same turn boundary, you pay for **one cold cache read**, not two.
- Pruning uses a **latched cut point** (`cutTs`), so earlier tool outputs are elided while maintaining byte-level prefix stability across subsequent requests.

## Config

The rules file is `~/.omp/governor.yml` (fallback env: `OMP_GOVERNOR_CONFIG`). If missing, the governor is inert.

```yaml
enabled: true          # optional, default true
agents: [main]         # optional; agent kinds to act in (main | sub)

# Epoch pruning shape (switch pruning is configured in model-switch-prune-omp)
prune:
  minChars: 2000       # elide results longer than this
  headChars: 600
  tailChars: 300
debug: false           # write prune metrics to log when they change

rules:                 # ordered; first matching rule wins
  - name: budget
    when: 'cost > 1.0 && model.startsWith("anthropic/claude-opus")'
    use: anthropic/claude-sonnet-4.5
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

### Stuck detection (agent self-report)

The `progress` tool (`goal`, `status: progress|blocked|done`, `evidence`) is registered by
[`agent-progress-tool-omp`](../agent-progress-tool-omp), not by the governor. Without that package the
counters below stay at 0 and stuck rules never fire.
The agent calls it once per turn. Two CEL variables are derived from those calls in the session branch,
so they survive resume and follow branch switches:

| Variable | Meaning |
|---|---|
| `blocked_streak` | `blocked` reports in a row on the current goal |
| `attempts_on_goal` | Reports on the current goal since its last `done`, any status; catches a model that reports `progress` but never finishes |

A new goal text (compared case- and space-insensitively) resets both counters.

```yaml
  - name: stuck-escalate
    when: '(blocked_streak >= 3 || attempts_on_goal >= 6) && !model.startsWith("anthropic/claude-opus")'
    use: '@slow'
    effort: high
```

Known limits: a stuck model can reset the counters by rewording its goal; each turn costs one extra
tool round trip; models that never call the tool never escalate.

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

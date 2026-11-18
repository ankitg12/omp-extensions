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

## Model after compaction

Set `afterCompaction` in `~/.omp/governor.yml` to use a model after a successful compaction:

```yaml
# Use OMP's configured default model role.
afterCompaction: '@default'
# Or set afterCompaction to an explicit selector such as 'provider/model-id'.
```

This changes the current session model, not OMP's default or the model that performs compaction.
It applies to any method that saves a compaction entry, including manual `/compact`, soft, remote,
snapcompact, and handoff. Failed or cancelled compactions and prune-only maintenance do not trigger it.
If a run is active, the governor waits for `agent_end` rather than switch during a tool loop. The
compaction selection takes precedence over CEL model and effort rules at that boundary. The setting
is independent of the manual-model pause for CEL rules; it still obeys `enabled` and `agents`.
If the target is unavailable, the governor warns and leaves the model unchanged.

A model from another provider may not be able to use a remote compaction payload. OMP can then
rebuild from older history, which can cause another compaction. Prefer a text-summary method such as
`soft` when switching providers. Remove `afterCompaction` to turn this policy off.

## Model-specific instructions

The governor can append a trusted instruction file for the main agent's current model. Add an exact
`provider/model-id` mapping to `~/.omp/governor.yml`:

```yaml
modelInstructions:
  provider-a/model-a: ~/.omp/model-instructions/model-a.md
  provider-b/model-b: ~/.omp/model-instructions/model-b.md
```

The file is read at each user prompt; a model switch selects the new file at the next prompt.
Paths starting with `~/` use the home directory; relative paths resolve against the config file's
directory. Unmapped models add nothing. A missing, unreadable, or empty file produces a warning and
leaves the prompt unchanged. Instructions append to the existing prompt; they do not replace shared
context or safety rules. Only put trusted text in these files. The feature is main-agent only and
is disabled when the governor is disabled. Use `/governor reload` after editing the mapping; file
content changes are picked up on the next prompt. Model switches during tool-only continuations do
not update the instructions until the next user prompt.

## Config

The rules file is `~/.omp/governor.yml` (fallback env: `OMP_GOVERNOR_CONFIG`). If missing, the governor is inert.

```yaml
enabled: true          # optional, default true
agents: [main]         # optional; agent kinds to act in (main | sub)
pruneOnModelSwitch: false  # optional; elide older tool results before the new model's first request

# Epoch pruning shape (foreign-model pruning is configured in model-switch-prune-omp)
prune:
  style: soft          # soft (head + tail, below) | aggressive (like /shake: >200 chars → marker, no head/tail)
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

### Pruning on model switch

Set `pruneOnModelSwitch: true` to latch a wire-only epoch cut when a new model is observed on a confirmed model change. The cut is the last user request before the switch, so its exchange stays intact. The governor applies `prune.style` before the new model's first request; it does not rewrite the saved session. Automatic fallback and prewalk changes do not trigger a cut. The policy follows `agents` and is off by default.

This is separate from the always-on foreign-model pass: that pass only elides older foreign results over 6,000 characters and protects the last two. Epoch pruning also affects older same-model results. `aggressive` replaces eligible text with a marker; unlike native `/shake`, it does not create recoverable artifact links. Use `soft` when the new model needs more of the earlier results. `/governor` shows the policy and last prune statistics.

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

**When rules run.** All rules run at `agent_end`. Prune-only rules (`prune: true`, no `use`, no `effort`) also run at every `turn_end`, so a long run is pruned mid-run instead of after it ends; model and effort changes never happen mid-run. The cut is still the last user prompt, so a mid-run prune frees earlier exchanges, not the current run's tool results (that needs OMP's real `/shake`, see can1357/oh-my-pi#5661).

Wire pruning lowers the billed token count only. Native compaction triggers on `max(billed, stored)` and runs before extension `agent_end`, so it cannot be delayed by this extension. Keep native compaction on as the safety net and set its thresholds above the governor's prune thresholds.

### Rule Variables

| Variable | CEL type | Meaning |
|---|---|---|
| `turns_since_prune` | int | User prompts since the last epoch cut (or total turns if never pruned) |
| `cost` | double | Session spend in USD (assistant + `task` subagent usage) |
| `prunable` | int | Tokens a governor prune would free now (chars/4, using the configured `prune.style`) |
| `shakeable` | int | Tokens a manual `/shake` would free now ([`shake-meter-omp`](../shake-meter-omp) estimate) |
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

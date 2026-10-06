# model-switch-prune-omp

Always-on execution layer for [oh-my-pi](https://github.com/can1357/oh-my-pi) model switches.
On every request, tool turns written by a model other than the active one ("foreign" turns) are
pruned **on the wire**. The saved session file does not change, and if you switch back, the full turns return.

- Foreign tool calls are removed. Their results are folded into user messages. This also avoids
  cross-provider tool-call format errors.
- Older foreign results above 6000 chars are elided to head + tail. The 2 most recent stay whole.
- A turn is foreign because of its provenance (api/provider/model), not its position. So the pruned
  prefix is the same on every request after a switch, and only the first request has a cold cache.

There are no rules here. *When* to prune for other reasons is policy and belongs to
[`session-governor-omp`](../session-governor-omp), which imports `pruneBeforeCut` from `prune.ts`.

## Install order

Load `session-governor-omp` **before** this extension. OMP chains `context` handlers in load order.
The governor's epoch pass must see raw tool results before this pass folds the foreign ones. The
reverse order is still correct, but it saves less.

## Config (optional)

`~/.omp/agent/model-switch-prune.json` (override: `OMP_MODEL_SWITCH_PRUNE_CONFIG`):

```json
{ "mode": "elide", "debug": false }
```

`mode`: `elide` (default) | `drop` | `keep`. A missing or invalid file gives the default. The
mechanism never turns itself off by accident. `debug` writes changed per-request stats to
`~/.omp/agent/model-switch-prune.log` (override: `OMP_MODEL_SWITCH_PRUNE_LOG`).

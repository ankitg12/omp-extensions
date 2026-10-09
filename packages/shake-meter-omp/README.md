# shake-meter-omp

Display-only footer item for [oh-my-pi](https://github.com/can1357/oh-my-pi): how many tokens a
manual `/shake` would free right now, e.g. ` ~12k shakeable` (Nerd Font scissors, U+F0C4).
Colour: dim below 10k, warning from 10k, error from 25k.

`preview.ts` asks OMP itself: `collectShakeRegions` with `AGGRESSIVE_SHAKE_CONFIG` and the model's
native `Tokenizer`, all from the bare specifier `@oh-my-pi/pi-agent-core`, which the extension
loader routes to the running OMP's own module. Freed = Σ region tokens − one placeholder each.

If that import fails (unit tests, a future OMP rename), it falls back to `estimate.ts`, which
restates the rules with chars/4. That fallback undercounts by about half: Claude tokenizers measure
about 2.2 chars per token on tool output. The source in use is logged.

Replays of four real shakes on 2026-10-09 (`verify-shake.ts`, `claude-v5` tokenizer):

| Shake | Regions | Σ region tokens (artifact) | OMP preview | chars/4 fallback |
| --- | --- | --- | --- | --- |
| artifact 20 | 10 | 2,740 | 2,460 | 1,254 |
| artifact 47 | 28 | 16,408 | 15,624 | 7,750 |
| artifact 62 | 44 | 29,034 (reported ~27,838 freed) | 27,237 | 14,614 |
| artifact 82 | 63 | 35,068 | 33,304 | 15,938 |

Every number change is appended to `~/.omp/logs/shake-meter.jsonl` (`OMP_SHAKE_METER_LOG`
overrides), with `source: omp|estimate`. OMP does not log shakes itself; its record is the
`N.shake.log` artifact beside the session file, one `### region K (tool, ~T tok)` header per region.

```sh
bun verify-shake.ts <session.jsonl> <artifact-number> claude-v5   # needs OMP_SRC checkout + natives
```

It never prunes. `/shake` emits no event, so a 3 s tick refreshes the number after a shake.
[`session-governor-omp`](../session-governor-omp) imports `previewShake` as the CEL variable
`shakeable` for rules such as `shakeable > 25000`.

Not mirrored: plan-file protection. The governor's own wire prune sets no `prunedAt`, so it does not
lower this meter; only a real `/shake` does.

## Install

```yaml
# ~/.omp/agent/config.yml
extensions:
  - ~/repos/github.com/ankitg12/omp-extensions-pub/packages/shake-meter-omp/shake-meter.ts
```

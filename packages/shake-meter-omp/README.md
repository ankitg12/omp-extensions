# shake-meter-omp

Display-only footer item for [oh-my-pi](https://github.com/can1357/oh-my-pi): how many tokens a
manual `/shake` would free right now, e.g. ` ~12k shakeable` (Nerd Font scissors, U+F0C4).
Colour: dim below 10k, warning from 10k, error from 25k.

`estimate.ts` restates the rules of OMP's `AGGRESSIVE_SHAKE_CONFIG`
(`packages/agent/src/compaction/shake.ts`), because extensions cannot import it from the compiled
binary: a 4k-token protect window, nothing before the last compaction's `firstKeptEntryId`, no
already-shaken (`prunedAt`) results, no `skill` tool or `skill://` reads, fence/XML blocks of 400+
tokens, minus a 20-token placeholder per region. Tokens are chars/4, so expect a gap of about 10%.
On 2026-10-09 it estimated 2,385 against a real `/shake` of ~2,469.

It never prunes. `/shake` emits no event, so a 3 s tick refreshes the number after a shake.
[`session-governor-omp`](../session-governor-omp) imports `estimateShake` as the CEL variable
`shakeable` for rules such as `shakeable > 25000`.

Not mirrored: plan-file protection. The governor's own wire prune sets no `prunedAt`, so it does not
lower this meter; only a real `/shake` does.

## Install

```yaml
# ~/.omp/agent/config.yml
extensions:
  - ~/repos/github.com/ankitg12/omp-extensions-pub/packages/shake-meter-omp/shake-meter.ts
```

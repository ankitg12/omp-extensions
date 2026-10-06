# agent-progress-tool-omp

Essential OMP tool for agent self-reported progress (`progress`).

Provides a single sensor tool (`goal`, `status: progress|blocked|done`, `evidence`) called once per turn before the final reply. Downstream systems (such as `session-governor-omp`, `daylog`, or `agentsview`) read progress calls from the session branch to detect stuck streaks, track task velocity, or assess session outcomes.

## Usage

Add to `~/.omp/agent/config.yml`:

```yaml
packages:
  - ~/repos/github.com/ankitg12/omp-extensions-pub/packages/agent-progress-tool-omp
```

# @ankitg12/omp-output-styles

Adaptive output styles for [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi).

Brings interactive learning, explanatory insights, and arbitrary user-defined output styles to OMP coding sessions, with **zero token overhead** when turned off.

---

## Features

- **Arbitrary Custom Styles Without Code Changes**:
  - Drop any `<name>.md` file into `~/.omp/agent/output-styles/` or `.omp/output-styles/`.
  - Instantly switch to it with `/style <name>`.
- **Interactive Learning Mode (`/learning` or `/style learning`)**:
  - Shifts the agent from passive code generation to active pair programming.
  - The agent scaffolds architecture and function signatures, then leaves `TODO(human)` markers for you to write 5–10 strategic lines shaping the solution.
  - Emits educational `★ Insight` boxes highlighting codebase patterns and trade-offs.
- **Explanatory Insights Mode (`/explanatory` or `/style explanatory`)**:
  - The agent completes the coding task directly while presenting educational `★ Insight` boxes explaining implementation choices.
- **Zero Inactive Cost (`/style-off`)**:
  - When disabled (`off`), no extra tokens are added to provider requests.
- **Terminal Status Line Integration**:
  - Displays `🎓 learning`, `💡 explanatory`, or `📝 <name>` in the OMP footer statusline when enabled.

---

## Commands

| Command | Action |
| :--- | :--- |
| `/style` | List all available styles and show current active style |
| `/style <name>` | Switch to any discovered style (bundled or custom) |
| `/style-off` | Disable output style prompt injection |
| `/learning` | Shortcut for `/style learning` |
| `/explanatory` | Shortcut for `/style explanatory` |

---

## Adding Your Own Styles

You can create any output style without touching TypeScript code:

1. Create a markdown file in `~/.omp/agent/output-styles/<name>.md` (global) or `<project>/.omp/output-styles/<name>.md` (project-scoped).
   For example, create `~/.omp/agent/output-styles/socratic.md`:
   ```markdown
   You are in Socratic tutoring mode. Never provide the direct code answer immediately.
   Ask guiding questions that lead the developer to discover the solution.
   ```
2. In your OMP session, run:
   ```
   /style socratic
   ```
3. To list all recognized styles on disk:
   ```
   /style
   ```

---

## Configuration

Add the extension to `~/.omp/agent/config.yml`:

```yaml
extensions:
  - ~/repos/github.com/ankitg12/omp-extensions-pub/packages/omp-output-styles/output-styles.ts
```

---

## Testing

Run unit tests via Bun:

```bash
bun test packages/omp-output-styles/output-styles.test.ts
```

---

## License

MIT © Ankit Gaur

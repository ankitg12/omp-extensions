# @ankitg12/omp-output-styles

Adaptive output styles for [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi).

Brings interactive learning and explanatory insight modes to OMP coding sessions, with **zero token overhead** when turned off.

---

## Features

- **Interactive Learning Mode (`/learning`)**:
  - Shifts the agent from passive generation to active pair programming.
  - The agent identifies key architecture and business logic decision points, generates context and function signatures, and leaves `TODO(human)` markers for you to write 5–10 strategic lines.
  - Generates educational `★ Insight` boxes highlighting codebase patterns and trade-offs.
  - Direct execution for boilerplate, setup, and simple CRUD.
- **Explanatory Insights Mode (`/explanatory`)**:
  - The agent completes the coding task directly while presenting educational `★ Insight` boxes explaining implementation choices.
- **Zero Inactive Cost (`/style-off`)**:
  - Unlike static prompt rules or always-on plugins, no extra tokens are added to provider requests when disabled.
- **Terminal Status Line Integration**:
  - Displays `🎓 learning` or `💡 explanatory` in the OMP footer statusline when enabled.

---

## Commands

| Command | Action |
| :--- | :--- |
| `/learning` | Enable interactive learning mode |
| `/explanatory` | Enable explanatory mode |
| `/style-off` | Disable output style prompt injection |
| `/output-style` | Check active style or set mode directly (`/output-style learning \| explanatory \| off`) |

---

## Configuration

Add the extension to `~/.omp/agent/config.yml`:

```yaml
extensions:
  - ~/repos/github.com/ankitg12/omp-extensions-pub/packages/omp-output-styles/output-styles.ts
```

### Custom Prompts

Prompts are bundled inside the package (`prompts/learning.md` and `prompts/explanatory.md`).

To customize prompt instructions globally without modifying the package source, place overrides in:
- `~/.omp/agent/output-styles/learning.md`
- `~/.omp/agent/output-styles/explanatory.md`

The extension checks user overrides first before falling back to bundled defaults.

---

## Testing

Run unit tests via Bun:

```bash
bun test packages/omp-output-styles/output-styles.test.ts
```

---

## License

MIT © Ankit Gaur

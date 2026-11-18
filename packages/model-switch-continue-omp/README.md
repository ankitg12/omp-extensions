# model-switch-continue-omp

After Ctrl-P changes the model in an interactive OMP session, send a continuation request. The extension waits 800 ms after the last Ctrl-P, so several presses select a model before the next turn starts.

OMP's `.` shortcut invokes a private resume operation. A `.` sent by an extension is only a literal message. This extension sends an agent-attributed continuation request instead, so it appears in the conversation. The default request follows the intent of OMP's `.` directive and states the previous and new model IDs.

The extension acts only when the session has a conversation, the agent is idle, the editor is empty, and no messages are queued. It confirms the new model in the session branch before sending. Other input cancels the pending continuation. A failed switch, a switch back to the original model, and automatic fallback do not start a turn.

This extension observes the default Ctrl-P key, not remapped cycle keys, the model picker, or `/model`. It does not intercept the key. Reload or restart OMP after installation.

## Prompt configuration

Optional file: `~/.omp/agent/model-switch-continue.json`. Set `OMP_MODEL_SWITCH_CONTINUE_CONFIG` to use a different file. Changes take effect on the next switch.

```json
{
  "prompt": "Continue the most recent intent. Resume unfinished work without asking for confirmation.",
  "switchContext": "The user switched from {{previous_model}} to {{new_model}}. Review the earlier work and continue.",
  "models": {
    "provider/model-id": "Review the prior model's work, then complete the user's request."
  }
}
```

`models` selects a replacement prompt by exact destination `provider/model` ID. `switchContext` is appended to either prompt; set it to an empty string to omit it. Both fields support `{{previous_model}}` and `{{new_model}}`. Missing or invalid configuration uses the defaults. The extension does not infer why the user selected a model.

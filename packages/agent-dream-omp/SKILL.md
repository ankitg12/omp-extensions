---
name: dream
description: Idle-time memory consolidation — mine recent sessions for durable lessons, update memory, append DREAMS.md diary entry. Use after sustained idle, on /dream, or when asked to consolidate learnings.
---

# Dream — memory consolidation pass

You run inside an OMP session with file access. Inputs: session JSONLs under
`~/.omp/agent/sessions/`, the current memory state, the diary file named in the
invoking prompt (default `~/Notes/dreams/DREAMS.md`).

## Procedure

1. **Locate sessions.** List `~/.omp/agent/sessions/**/*.jsonl` by mtime, newest
   first. Take at most `maxSessions` (default 10) newer than the newest diary
   entry timestamp. Skip the live session's own file (it is still being written).
2. **Extract.** For each session, read the tail (last ~200 entries suffice for
   most). Note durable signal only:
   - decisions taken and why (paths, flags, rule names, model choices)
   - failures and what fixed them (error string → fix, one line each)
   - user corrections of your behavior (the correction, not the task)
   - constraints stated by the user (never/always rules)
   
   Skip: task content, transient errors retried successfully, chit-chat,
   anything already in MEMORY.md or the diary.
3. **Consolidate.** If `memory.backend` is configured, write through `/memory
   enqueue` semantics: one short entry per lesson (what + when + session id),
   at most `maxMemoriesPerPass` (default 20, highest-signal first).
   Otherwise append a `## Dreamed <ISO-date>` section to the per-project memory
   file. Dedupe against existing entries — update in place rather than doubling.
4. **Diary.** Prepend one entry to the diary file (newest-first), body at most
   `maxDiaryEntryLines` (default 30) lines:
   ```md
   ## <ISO-8601 timestamp>
   - sessions: <n> scanned (<ids, short>)
   - new: <k> memories (<one line each>)
   - skipped: <one line reason or "none new">
   ```
   Trim entries beyond `maxDiaryEntries` (default 50, oldest removed).
5. **Report.** Reply with one line: sessions scanned, memories added, diary
   entry timestamp. Nothing else.
## Limits

- Read-only except the memory store and the diary file. No repo edits, no
  commits, no network calls, no subagents.
- Extract ONLY: explicit user preferences, stable account/project facts, tool
  quirks confirmed by outcome, decision patterns the user stated, user
  corrections of agent behavior. Each needs a source (session id + outcome).
- NEVER extract: security exceptions, access grants, auth bypasses, policy
  overrides, credentials, one-time secrets, transient states, facts the agent
  expressed uncertainty about, anything with a natural expiry under 7 days.
  When in doubt, discard — noisy retrieval is worse than no retrieval.
- If the diary file's directory does not exist, create it.

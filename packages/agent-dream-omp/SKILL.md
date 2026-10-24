---
name: dream
description: Idle-time memory consolidation — mine recent sessions for durable lessons, update memory, append DREAMS.md diary entry. Use after sustained idle, on /dream, or when asked to consolidate learnings.
---

# Dream — memory consolidation pass

You run inside an OMP session with file access. Inputs: session JSONLs under
`~/.omp/agent/sessions/`, the current memory state, the diary file named in the
invoking prompt (default `~/Notes/dreams/DREAMS.md`).

## Procedure (the injected prompt carries the authoritative version — this file is the reference)

Budget: ~15 tool calls; report partial rather than grinding.

1. **Index.** Run `dream-index --max <maxSessions>` (ships with the extension, same dir as `dream.ts`). Take sessions newer than the newest `## <ISO>` heading in the diary (if no diary yet, take the newest batch). Skip the live session's own file. STOP after this step if nothing is newer — write a skipped report.
2. **Extract.** Read each session's tail (last ~200 lines). Note durable signal ONLY — explicit user preferences, stable account/project facts, tool quirks confirmed by outcome, user corrections of your behavior, constraints the user stated. Each needs a source. NEVER extract: security exceptions, access grants, auth bypasses, credentials, one-time secrets, transient states, uncertain facts, anything expiring under 7 days. When in doubt, discard. STOP scanning after `maxSessions` sessions or earlier if two consecutive sessions yield zero new signal.
3. **Consolidate.** One short entry per lesson (what + when + session id), at most `maxMemoriesPerPass`, highest-signal first. The injected prompt names the exact memory target — never invent a path. Dedupe — update in place, never double.
4. **Diary.** Write the entry body (≤ `maxDiaryEntryLines` lines) to a temp file, then run `dream-diary --diary <path> --max <maxDiaryEntries> --entry-file <tmp>`. It prints the entry timestamp.
5. **Report.** Write JSON `{"sessions": n, "memories": k, "diaryEntry": "<ISO or null>", "at": "<now ISO>"}` to the report path named in the injected prompt, then reply with exactly one line: sessions scanned, memories added, diary entry timestamp.
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

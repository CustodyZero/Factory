# Claude Code — [Project Name]

Read `AGENTS.md` first. It defines all operating constraints.

## Critical Rules

1. **Run `npx tsx .factory/tools/status.ts` at the start of every session**
2. **Never implement without a packet**
3. **Never introduce facades or partial success paths**
4. **One intent per change — no scope mixing**
5. **Pre-commit hook enforces FI-7** (no commit while a started packet lacks a completion)

## Quick Reference (operator)

The factory has one operator command: `run.ts`.

```sh
npx tsx .factory/tools/status.ts                          # What is the factory state?
npx tsx .factory/tools/run.ts <spec-id> [<spec-id>...]    # Run the full pipeline for one or more specs
npx tsx .factory/tools/validate.ts                        # Validate factory integrity
npx vitest run --config .factory/vitest.config.ts         # Run factory tooling tests
```

`run.ts` accepts spec IDs (specs at `specs/<spec-id>.md`). Intent IDs from
`factory/intents/<intent-id>.json` are still accepted for backward compatibility.

## Agent protocol (called by agents, not operators)

The lifecycle scripts below are how agents signal back to the factory.
Operators do not invoke them during normal pipeline runs — `run.ts`
calls them as the pipeline drives state forward.

```sh
npx tsx .factory/tools/start.ts <packet>              # Agent claims a packet
npx tsx .factory/tools/request-review.ts <packet>     # Developer signals code ready for review
npx tsx .factory/tools/review.ts <packet> --approve   # Code reviewer approves
npx tsx .factory/tools/complete.ts <packet>           # Agent records completion (build/lint/test)
```

All four are idempotent — re-invocation on the same state is a no-op.

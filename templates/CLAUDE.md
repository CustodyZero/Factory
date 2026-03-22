# Claude Code — [Project Name]

Read `AGENTS.md` first. It defines all operating constraints.

## Critical Rules

1. **Run `npx tsx factory/tools/status.ts` at the start of every session**
2. **Never implement without a packet**
3. **Never commit without a completion**
4. **Never introduce facades or partial success paths**
5. **One intent per change — no scope mixing**

## Quick Reference

```sh
npx tsx factory/tools/status.ts              # What is the factory state?
npx tsx factory/tools/execute.ts <feature>   # What packets are ready?
npx tsx factory/tools/complete.ts <packet>   # Create completion record
npx tsx factory/tools/report.ts <feature>    # Produce QA report (after all packets complete)
npx tsx factory/tools/accept.ts <packet>     # Accept a completed packet (human action)
npx tsx factory/tools/validate.ts            # Validate factory integrity
npx vitest run --config factory/vitest.config.ts  # Run factory tooling tests
```

# Claude Code — [Project Name]

Read `AGENTS.md` first. It defines all operating constraints.

## Critical Rules

1. **Run `npx tsx .factory/tools/status.ts` at the start of every session**
2. **Never implement without a packet**
3. **Never commit without a completion**
4. **Never introduce facades or partial success paths**
5. **One intent per change — no scope mixing**

## Quick Reference

```sh
npx tsx .factory/tools/status.ts              # What is the factory state?
npx tsx .factory/tools/run.ts <intent-id>     # Run full pipeline for an intent
npx tsx .factory/tools/plan.ts <intent-id>    # Resolve planner action for intent
npx tsx .factory/tools/execute.ts <feature>   # What packets are ready?
npx tsx .factory/tools/start.ts <packet>      # Claim a packet
npx tsx .factory/tools/request-review.ts <p>  # Signal code ready for review
npx tsx .factory/tools/review.ts <p> --approve # Approve code review
npx tsx .factory/tools/complete.ts <packet>   # Create completion record
npx tsx .factory/tools/validate.ts            # Validate factory integrity
npx vitest run --config .factory/vitest.config.ts  # Run factory tooling tests
```

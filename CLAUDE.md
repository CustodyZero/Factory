# Claude Code — Factory

Read `AGENTS.md` first. It defines all operating constraints.

## Critical Rules

1. **Run `npx tsx tools/status.ts` at the start of every session**
2. **Never implement without a packet**
3. **Never commit without a completion**
4. **Never introduce facades or partial success paths**
5. **One intent per change — no scope mixing**

## Quick Reference

```sh
npx tsx tools/status.ts              # What is the factory state?
npx tsx tools/run.ts <intent-id>     # Run full pipeline for an intent
npx tsx tools/plan.ts <intent-id>    # Resolve planner action for intent
npx tsx tools/execute.ts <feature>   # What packets are ready?
npx tsx tools/start.ts <packet>      # Claim a packet
npx tsx tools/request-review.ts <p>  # Signal code ready for review
npx tsx tools/review.ts <p> --approve # Approve code review
npx tsx tools/complete.ts <packet>   # Create completion record
npx tsx tools/validate.ts            # Validate factory integrity
npx vitest run                       # Run factory tooling tests
```

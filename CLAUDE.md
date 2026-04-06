# Claude Code — Factory Project

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
npx tsx tools/execute.ts <feature>   # What packets are ready? (returns packet + persona)
npx tsx tools/start.ts <packet>      # Claim a packet before implementation
npx tsx tools/complete.ts <packet>   # Create completion record (--identity <id> for QA)
npx tsx tools/accept.ts <packet>     # Accept a completed packet (human action)
npx tsx tools/supervise.ts           # Supervisor tick — next orchestration action
npx tsx tools/supervise.ts --init    # Initialize supervisor state
npx tsx tools/validate.ts            # Validate factory integrity
npx tsx tools/migrate.ts             # Migrate pre-existing artifacts to new schema
npm test                             # Run factory tooling tests
```

Note: This repo uses `factory_dir: "."` because the factory IS the project.
When installed in a host project, paths become `factory/tools/...` instead.

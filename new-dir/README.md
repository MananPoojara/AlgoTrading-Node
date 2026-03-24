# Algo Trading Codex Agent System

This package is the minimum structure I would use to run your 7-agent workflow safely in Codex.

## What is inside
- root `AGENTS.md` for global repo rules
- nested `AGENTS.md` files only at real boundaries
- your 7 role files under `agents/roles/`
- reusable workflow skills under `agents/skills/`
- machine-checkable templates + schemas
- workflow control files under `agents/state/`

## What to do next
1. Copy this structure into your real repo.
2. Move your code into the target folders you choose (`apps/`, `packages/`, `infra/`).
3. Add real scripts/commands in the skills.
4. Add validation tooling that checks front matter against schemas.
5. Make Codex use the root `AGENTS.md` and current workflow state on every task.

## Important
This is the safest structure baseline.
It is not a promise of perfect autonomy.
You still need human gates for live trading, deployment, risk, and client communications.

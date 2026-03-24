# AGENTS.md

## Scope

This subtree is the API/backend application surface.

## Rules

- Follow root `AGENTS.md` first.
- Do not add architecture shortcuts here that conflict with Senior Backend standards.
- Hot-path safety wins over convenience.
- No hardcoded session times, expiry days, or broker assumptions.
- No direct production deployment logic here.
- If editing order flow, risk checks, durable events, or state recovery behavior, ensure the relevant role artifacts are updated.

## Required Before Major Changes

- Read the current strategy/event contracts in `packages/`.
- Read the relevant role files if the change affects:
  - risk
  - orders
  - market data
  - state restoration
  - strategy execution

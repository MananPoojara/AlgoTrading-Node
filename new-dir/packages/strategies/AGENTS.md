# AGENTS.md

## Scope

This subtree contains strategy implementations and shared strategy helpers.

## Rules

- Strategy logic starts from an approved QA spec, never directly from a Python backtest.
- Deterministic signal identity only; never use `Date.now()` for dedup fingerprints.
- Critical strategy signals must use durable delivery patterns.
- Strategy state must be restorable.
- If a strategy needs a missing platform component, stop and escalate; do not build platform work inline.
- No strategy-specific hacks that violate the standard state machine.

## Required Evidence Before Review

- mapping document acknowledged
- unit tests
- integration tests for durable delivery/idempotency where relevant
- self-review checklist complete

# SKILL.md

## Name
paper-trading-review

## Used By
QA Engineer, Data Engineer, Ops Analyst

## Purpose
Evaluate paper trading performance over the required observation window and assemble founder-facing sign-off.

## Inputs
- deployment log
- shift logs
- daily PnL/fill-quality data
- parity context
- minimum paper period rules

## Outputs
- paper trading sign-off package
- anomalies list
- recommendation

## Procedure
1. Verify minimum trading-day window.
2. Confirm lifecycle completeness.
3. Summarize fill quality and risk events.
4. Attach data and ops evidence.
5. Leave founder approval blank.
6. Set status to `AWAITING_FOUNDER_DECISION`.

## Stop Conditions
- open positions at close when not expected
- unexplained divergence
- missing ops/data evidence

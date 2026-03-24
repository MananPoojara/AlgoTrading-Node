# SKILL.md

## Name
spec-intake

## Used By
QA Engineer

## Purpose
Turn founder input (Python file + plain-language rules) into a machine-checkable strategy specification package.

## Inputs
- founder request
- Python backtest file or rules
- current workflow state
- current strategy registry entry

## Outputs
- strategy spec document
- ambiguity log
- platform gap note
- artifact index update

## Procedure
1. Read founder input completely.
2. Extract exact entry/exit/timeframe/instrument/state assumptions.
3. Write down live-trading ambiguities one by one.
4. Ask founder only if a genuine business or execution ambiguity remains.
5. Draft the spec from the template.
6. Validate front matter.
7. Set status to `READY_FOR_REVIEW` or `APPROVED` only if founder ambiguity fields are complete.

## Stop Conditions
- missing founder clarification
- unresolved platform dependency
- contradictory rules

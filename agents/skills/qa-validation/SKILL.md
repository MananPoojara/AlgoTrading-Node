# SKILL.md

## Name
qa-validation

## Used By
QA Engineer

## Purpose
Validate that the implementation matches the approved spec and platform expectations.

## Inputs
- approved PR
- strategy spec
- parity dataset
- runbook requirements
- checklists

## Outputs
- signal parity report
- edge-case test results
- paper trading readiness package

## Procedure
1. Run parity checks.
2. Run state machine tests.
3. Run restart recovery tests.
4. Run broker conformance checks.
5. Confirm observability readiness.
6. Produce pass/fail package.

## Stop Conditions
- parity divergence
- missing restart evidence
- missing alert/runbook coverage

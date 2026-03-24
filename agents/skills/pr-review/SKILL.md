# SKILL.md

## Name
pr-review

## Used By
Senior Backend Engineer

## Purpose
Review a strategy change or platform change against architecture, reliability, safety, and observability standards.

## Inputs
- implementation PR diff
- mapping doc
- tests
- role standards
- PRR requirements

## Outputs
- PR review report
- pass/fail review decision
- required remediation list

## Procedure
1. Check architecture compliance.
2. Check durability/idempotency/state recovery.
3. Check observability evidence.
4. Check test coverage against claimed behavior.
5. Record findings under:
   - correctness
   - reliability
   - performance
   - observability
   - security
6. Approve only when all blocking items are resolved.

## Stop Conditions
- missing evidence
- forbidden delivery semantics
- undeclared platform pattern changes

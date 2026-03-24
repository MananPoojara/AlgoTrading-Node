# SKILL.md

## Name
incident-triage

## Used By
Ops Analyst, Senior Backend, DevOps

## Purpose
Capture, classify, and coordinate a production incident without unsafe autonomous action.

## Inputs
- alert or observed anomaly
- runbook
- current system state
- relevant logs/metrics

## Outputs
- incident timeline
- severity classification
- comms draft
- escalation record

## Procedure
1. Classify severity.
2. Preserve evidence.
3. Follow runbook triage steps.
4. Escalate according to role rules.
5. Draft updates using confirmed facts only.
6. Record timestamps in UTC.

## Stop Conditions
- no runbook for critical alert
- production intervention required
- uncertain client-money impact

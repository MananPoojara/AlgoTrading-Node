# AGENTS.md

## Scope

This subtree is the dashboard/operator UI.

## Rules

- The dashboard is cold-path unless explicitly wired into a live control surface.
- Do not silently add controls that can affect live trading without:
  - explicit role approval,
  - audit logging requirement,
  - founder / Senior Backend policy alignment.
- Prefer read-oriented operator views over mutating controls.
- UI language for incidents must match Ops/Founder communication policy.

## Safe Defaults

- Read-only metrics and status views are preferred.
- Any action button that affects strategy state must be documented in PR and tied to role approvals.

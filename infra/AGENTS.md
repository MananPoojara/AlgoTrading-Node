# AGENTS.md

## Scope

This subtree contains deployment, monitoring, and operational scripts/configuration.

## Rules

- Nothing here may assume permission to deploy to production autonomously.
- Hot-path deploys are forbidden during market hours.
- Scripts must prefer explicit safety checks and dry-run-friendly behavior.
- Do not embed secrets.
- Any script that could restart, deploy, or alter production must require explicit human invocation and be documented in change control.

## Operational Safety

- Preserve evidence before restart/rollback actions.
- Backup/restore scripts must be reversible and documented.
- Monitoring and alert rules should map to runbooks.

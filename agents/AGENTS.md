# AGENTS.md

## Purpose of `agents/`

This subtree contains the AI-team operating system:
- role files,
- reusable skills,
- templates,
- schemas,
- workflow state,
- stage artifacts.

If you are working in `agents/`, optimize for deterministic orchestration and auditability, not prose beauty.

## Required Read Order

1. repo root `AGENTS.md`
2. `roles/ROLE_07_TEAM_WORKFLOW_ORCHESTRATION.md`
3. your role file
4. relevant skill under `skills/`
5. relevant template + schema
6. current `state/*.json`

## Rules Specific to This Subtree

- Every stage-gating artifact must start with YAML front matter.
- Every artifact front matter must match its schema.
- Never store secrets here.
- Never place runtime-only logs here; put runtime outputs under `var/` in the real repo.
- Skills are executable playbooks, not role definitions.
- Roles own **who** acts; skills define **how** the work is executed.

## File Ownership

- `roles/` = human-authored role contracts
- `skills/` = reusable execution instructions
- `templates/` = standard outputs
- `schemas/` = machine-checkable validation
- `state/` = workflow control plane
- `artifacts/` = generated handoff materials

## Coordination Rule

Agents do not "chat freely" here.
They coordinate through:
- workflow state,
- artifact files,
- artifact index,
- explicit approval fields.

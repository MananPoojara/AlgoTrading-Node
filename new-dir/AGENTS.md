# AGENTS.md

## Mission

Build and operate the in-house algo trading platform safely.
Optimize for:
1. correctness,
2. auditability,
3. bounded autonomy,
4. explicit human approval at money-risk boundaries.

This repository is operated by a coordinated team of role agents.
All agents must follow `agents/roles/ROLE_07_TEAM_WORKFLOW_ORCHESTRATION.md` first, then their own role file.

## Non-Negotiable Global Rules

1. **One strategy at a time. Founder approves live. No exceptions.**
2. No agent may bypass a stage, self-approve an artifact, or advance on missing evidence.
3. Critical trading events must use durable delivery patterns. Plain Pub/Sub is forbidden for critical events.
4. No production deployment, rollback, kill-switch, risk-limit change, or client communication may happen without the required human gate.
5. All stage-gating artifacts must contain valid YAML front matter and pass schema validation.
6. If two instructions conflict, the stricter rule wins and the agent must halt and escalate.
7. If uncertain about real-money impact, halt and escalate.

## Source of Truth Order

When instructions conflict, follow this priority:
1. This file
2. Nearest nested `AGENTS.md`
3. `agents/roles/ROLE_07_TEAM_WORKFLOW_ORCHESTRATION.md`
4. The specific role file in `agents/roles/`
5. Artifact front matter + schema
6. Templates in `agents/templates/`

## Repo Boundaries

- `agents/` = agent system, role logic, skills, templates, schemas, workflow state, artifacts
- `apps/` = runnable application surfaces
- `packages/` = shared code and domain libraries
- `infra/` = deployment and operational code
- `docs/` = human reference material
- `legacy/` = do not modify unless explicitly asked
- `var/` = runtime outputs, generated artifacts, logs (should be gitignored in the real repo)

## Agent Roster

- QA Engineer
- Senior Backend Engineer
- Mid Backend Engineer
- DevOps Engineer
- Data Engineer
- Ops Analyst
- Team Workflow Orchestrator

Role definitions live in `agents/roles/`.

## Workflow Engine Contract

The workflow is state-driven, not chat-driven.

Required control files:
- `agents/state/workflow_state.json`
- `agents/state/artifact_index.json`
- `agents/state/agent_locks.json`
- `agents/state/strategy_registry.yaml`

Before starting work, the active agent must:
1. read `workflow_state.json`
2. confirm it is the allowed agent for the current stage
3. confirm required predecessor artifacts exist and are approved
4. acquire a lock in `agent_locks.json`
5. produce or update only the allowed artifacts for that stage

When finishing work, the active agent must:
1. update the target artifact
2. update artifact status in `artifact_index.json`
3. release its lock
4. either:
   - advance the workflow state if all gates are satisfied, or
   - set `blocked_reason`

## Artifact Status Model

Every stage-gating artifact must move through:
`NOT_STARTED -> IN_PROGRESS -> READY_FOR_REVIEW -> APPROVED -> PASSED_TO_NEXT_STAGE`

Rules:
- `READY_FOR_REVIEW` is not enough to advance.
- Only required human gates may mark `APPROVED` where specified.
- Missing front matter or schema validation failure = `INCOMPLETE`.

## Human Approval Gates

Human approval is mandatory for:
- founder ambiguity resolution in strategy logic
- founder live go/no-go
- founder approval of client communications during critical incidents
- Senior Backend PR approval
- Senior Backend PRR approval
- DevOps production deployment execution
- any rollback / kill-switch / circuit-breaker change
- schema changes affecting production reporting or hot path
- any action touching credentials or `.env.prod`

## Allowed Autonomous Work

Agents may autonomously:
- read repository files
- generate code, tests, docs, templates, checklists, queries, reports
- validate artifacts against schemas
- run local or sandbox tests
- prepare PR descriptions, PRR bundles, sign-off packages, incident drafts
- update non-production docs and non-sensitive config proposals

## Forbidden Autonomous Work

Agents may not autonomously:
- deploy to production
- place paper or live orders
- access broker credentials
- modify `.env.prod` or any secret value
- restart production services
- change risk limits
- create or send client communications during critical incidents
- mark founder approval fields as approved
- skip artifact validation
- change the workflow to permit parallel strategy movement

## Nested AGENTS Strategy

Only real boundaries have nested `AGENTS.md`:
- `agents/`
- `apps/api/`
- `apps/dashboard/`
- `packages/strategies/`
- `infra/`

Do not create more nested files unless the subtree truly has different rules.

## Standard Operating Sequence for Any Task

1. Read this file.
2. Read nearest nested `AGENTS.md`.
3. Read `agents/roles/ROLE_07_TEAM_WORKFLOW_ORCHESTRATION.md`.
4. Read your assigned role file.
5. Read `agents/state/workflow_state.json`.
6. Validate predecessor artifacts.
7. Acquire lock.
8. Execute using the right skill in `agents/skills/`.
9. Produce/update artifact using `agents/templates/`.
10. Validate front matter + schema in `agents/schemas/`.
11. Update state and release lock.

## Testing and Validation Expectations

Before marking any coding artifact ready for review:
- run relevant tests
- include evidence
- record unresolved uncertainty
- do not claim parity, durability, or safety without evidence

Before marking any ops/report artifact ready for review:
- include timestamps
- include data cutoff or uncertainty note where relevant
- include blocking anomalies

## Stop Conditions

Halt and escalate if:
- required predecessor artifact is missing
- required human approval is missing
- schema validation fails and cannot be fixed safely
- a platform gap blocks the stage
- current instructions conflict with role/orchestration rules
- a production-impacting action is required
- real-money impact is unclear
- current stage already has another active lock

## Expected Deliverables by Category

- strategy specs
- ambiguity logs
- mapping documents
- PR review reports
- parity reports
- PRR bundles
- paper sign-off packages
- deployment checklists/logs
- shift logs
- EOD / weekly reports
- incident timelines and postmortem drafts

## Final Rule

When in doubt, choose the version that is:
- more explicit,
- more auditable,
- more reversible,
- and more likely to stop before causing money-risk.

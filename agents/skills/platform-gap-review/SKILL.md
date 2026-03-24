# SKILL.md

## Name
platform-gap-review

## Used By
Senior Backend Engineer

## Purpose
Determine whether a strategy spec requires platform work before Mid Backend starts.

## Inputs
- approved strategy spec
- current platform gap table / strategy registry
- architecture docs
- platform standards

## Outputs
- spec review memo
- platform gap decision
- updated registry / workflow block reason

## Procedure
1. Compare strategy requirements against existing platform capabilities.
2. Mark each requirement as:
   - already supported
   - supported with constraints
   - missing platform component
3. If missing, create a clear gap statement with owner and priority.
4. Do not allow Stage 2 to begin until the gap is resolved in state.

## Stop Conditions
- unsupported timeframe aggregation
- unsupported instrument resolution
- unsupported multi-ticker position model
- unresolved durability/recovery dependency

# SKILL.md

## Name
reporting

## Used By
Data Engineer

## Purpose
Generate EOD/weekly reports safely and with explicit data-quality notes.

## Inputs
- reporting DB connection
- data reliability cutoff log
- query/view definitions
- anomaly checks

## Outputs
- EOD report
- weekly performance report
- weekly DB health report
- anomaly report

## Procedure
1. Run data quality checks first.
2. Exclude uncertain data with explicit notes.
3. Use only read-safe queries/roles.
4. Record cutoffs and exclusions.
5. Halt report if required contract tests fail.

## Stop Conditions
- contract test failure
- query safety violation
- unexplained PnL discrepancy above threshold

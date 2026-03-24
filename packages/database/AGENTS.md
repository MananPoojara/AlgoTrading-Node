# Database Package

This folder owns database runtime code shared by the platform:
- `postgresClient.js`
- migrations
- schema capability helpers
- seed/reset scripts

Rules:
- use `timestamptz`
- keep migrations idempotent
- do not couple package code to app-local paths

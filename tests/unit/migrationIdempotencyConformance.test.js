const fs = require("fs");
const path = require("path");

const MIGRATIONS_DIR = path.resolve(__dirname, "../../packages/database/migrations");
const MIGRATION_FILES = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith(".sql"))
  .sort();

const FORBIDDEN_PATTERNS = [
  {
    description: "CREATE TABLE without IF NOT EXISTS",
    pattern: /CREATE TABLE(?! IF NOT EXISTS)/g,
  },
  {
    description: "CREATE INDEX without IF NOT EXISTS",
    pattern: /CREATE INDEX(?! IF NOT EXISTS)/g,
  },
  {
    description: "CREATE UNIQUE INDEX without IF NOT EXISTS",
    pattern: /CREATE UNIQUE INDEX(?! IF NOT EXISTS)/g,
  },
  {
    description: "CREATE EXTENSION without IF NOT EXISTS",
    pattern: /CREATE EXTENSION(?! IF NOT EXISTS)/g,
  },
  {
    description: "ADD COLUMN without IF NOT EXISTS",
    pattern: /ADD COLUMN(?! IF NOT EXISTS)/g,
  },
];

describe("Migration idempotency conformance", () => {
  it("uses IF NOT EXISTS for migration statements that support it", () => {
    const violations = [];

    for (const file of MIGRATION_FILES) {
      const fullPath = path.join(MIGRATIONS_DIR, file);
      const sql = fs.readFileSync(fullPath, "utf8");

      for (const { description, pattern } of FORBIDDEN_PATTERNS) {
        const matches = [...sql.matchAll(pattern)];
        for (const match of matches) {
          const line = sql.slice(0, match.index).split("\n").length;
          violations.push(`${file}:${line} ${description}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

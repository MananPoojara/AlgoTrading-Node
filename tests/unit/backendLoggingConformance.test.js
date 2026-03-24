const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..", "..");
const backendRoots = [
  path.join(projectRoot, "apps"),
  path.join(projectRoot, "packages"),
];
const loggerPath = path.join(projectRoot, "packages", "core", "logger", "logger.js");
const excludedDirectories = new Set(["dashboard", "node_modules", ".next", ".next-verify"]);

function listBackendSourceFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (excludedDirectories.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...listBackendSourceFiles(fullPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(fullPath);
    }
  }

  return files;
}

describe("backend logging conformance", () => {
  it("keeps console.log out of backend source files", () => {
    const backendFiles = backendRoots.flatMap((root) => listBackendSourceFiles(root));
    const offenders = backendFiles.filter((filePath) => {
      const source = fs.readFileSync(filePath, "utf8");
      return /console\.log\s*\(/.test(source);
    });

    expect(offenders).toEqual([]);
  });

  it("implements the shared backend logger with pino", () => {
    const source = fs.readFileSync(loggerPath, "utf8");

    expect(source).toMatch(/require\(["']pino["']\)/);
    expect(source).not.toMatch(/require\(["']winston["']\)/);
  });
});

#!/usr/bin/env bun
/**
 * preflight.ts — Lightweight smoke test invoked by install.sh / install.ps1
 * after the install completes. Verifies critical pieces and exits 0/1.
 *
 * For a fuller diagnostic, use `bun run doctor` instead.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { platform } from "node:os";

const ROOT = resolve(import.meta.dir, "..");
const IS_WIN = platform() === "win32";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

let failed = 0;
function check(name: string, ok: boolean, hint?: string) {
  if (ok) {
    console.log(`  ${GREEN}✓${RESET} ${name}`);
  } else {
    console.log(`  ${RED}✗${RESET} ${name}${hint ? `\n      → ${hint}` : ""}`);
    failed++;
  }
}

console.log("\n  Etteum Pool — Preflight\n");

// 1. Bun
const bunCheck = spawnSync("bun", ["--version"], { encoding: "utf8" });
check("Bun runtime", bunCheck.status === 0, "Re-run installer or install Bun manually");

// 2. .env exists & has required keys
const envFile = join(ROOT, ".env");
check(".env file", existsSync(envFile), "Re-run installer to recreate .env");

// 3. node_modules
check("Root node_modules", existsSync(join(ROOT, "node_modules")), "Run: bun install");
check("Dashboard node_modules", existsSync(join(ROOT, "dashboard", "node_modules")), "Run: cd dashboard && bun install");

// 4. Dashboard build
check("Dashboard build", existsSync(join(ROOT, "dashboard", "dist", "index.html")), "Run: cd dashboard && bun run build");

// 5. Python venv
const venvPy = IS_WIN
  ? join(ROOT, "scripts", "auth", ".venv", "Scripts", "python.exe")
  : join(ROOT, "scripts", "auth", ".venv", "bin", "python");
check("Python venv", existsSync(venvPy), "Re-run installer to rebuild venv");

// 6. Python imports
if (existsSync(venvPy)) {
  const pyImport = spawnSync(venvPy, ["-c", "import camoufox, playwright, aiohttp, httpx, cbor2, pydantic"], { encoding: "utf8" });
  check(
    "Python packages (camoufox/playwright/aiohttp/httpx/cbor2/pydantic)",
    pyImport.status === 0,
    `Run: ${IS_WIN ? "scripts\\auth\\.venv\\Scripts\\pip" : "scripts/auth/.venv/bin/pip"} install -r scripts/auth/requirements.txt`,
  );
}

console.log("");
if (failed === 0) {
  console.log(`  ${GREEN}✓ Preflight passed.${RESET}\n`);
  process.exit(0);
} else {
  console.log(`  ${RED}✗ ${failed} preflight check(s) failed. Run \`bun run doctor\` for details.${RESET}\n`);
  process.exit(1);
}

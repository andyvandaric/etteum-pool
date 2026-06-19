#!/usr/bin/env bun
/**
 * sync-9router-proxies-to-etteum.ts
 * 
 * Sync active proxy pool entries from 9router into Etteum Pool.
 * 
 * Usage:
 *   bun run sync-9router-proxies-to-etteum.ts [--dry-run] [--force]
 * 
 * Flags:
 *   --dry-run   Show what would be synced without writing
 *   --force     Overwrite existing proxies (by URL match)
 * 
 * Requirements:
 *   - Run from etteum-pool root directory
 *   - 9router data at %APPDATA%/9router/db/data.sqlite
 *   - Etteum pool DB at ./data/poolprox3.db
 */

import { Database } from "bun:sqlite";
import { db } from "./src/db/index";
import { eq } from "drizzle-orm";
import path from "node:path";
import os from "node:os";

// --- Config ---
const NINE_ROUTER_DB = path.join(
  process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
  "9router", "db", "data.sqlite"
);
const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");

// --- Types ---
interface NineRouterProxy {
  id: string;
  isActive: number;
  testStatus: string;
  data: string;
}

interface NineRouterProxyData {
  name: string;
  proxyUrl: string;
  noProxy: string;
  type: string;
  strictProxy: boolean;
  lastTestedAt: string | null;
  lastError: string | null;
}

// --- Main ---
async function main() {
  console.log("=== 9router → Etteum Proxy Pool Sync ===");
  console.log(`Source: ${NINE_ROUTER_DB}`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}${FORCE ? " (force overwrite)" : ""}`);
  console.log("");

  // Open 9router DB (read-only)
  const srcDb = new Database(NINE_ROUTER_DB, { readonly: true });

  // Query active proxies
  const rows = srcDb.query<NineRouterProxy, []>(
    "SELECT id, isActive, testStatus, data FROM proxyPools WHERE isActive = 1 AND testStatus = 'active'"
  ).all();

  console.log(`Found ${rows.length} active proxies in 9router\n`);

  if (rows.length === 0) {
    console.log("Nothing to sync.");
    srcDb.close();
    process.exit(0);
  }

  // Get existing etteum proxies for dedup
  const existingRows = db.query.proxyPool
    ? await (db as any).select().from((await import("./src/db/schema")).proxyPool)
    : [];
  const existingUrls = new Set(existingRows.map((r: any) => r.url));

  let synced = 0;
  let skipped = 0;
  let updated = 0;
  let errors = 0;

  const { proxyPool } = await import("./src/db/schema");

  for (const row of rows) {
    try {
      const data: NineRouterProxyData = JSON.parse(row.data);

      if (!data.proxyUrl) {
        skipped++;
        continue;
      }

      const url = data.proxyUrl.trim();
      const label = data.name || `9router-${row.id.substring(0, 8)}`;
      const type = data.type || "http";

      // Dedup check
      if (existingUrls.has(url)) {
        if (FORCE) {
          if (!DRY_RUN) {
            await (db as any).update(proxyPool).set({
              label,
              type,
              status: "active",
              errorMessage: null,
              updatedAt: new Date(),
            }).where(eq(proxyPool.url, url));
          }
          console.log(`  ↻ ${label} (updated)`);
          updated++;
        } else {
          skipped++;
        }
        continue;
      }

      if (DRY_RUN) {
        console.log(`  + ${label} | ${type} | ${url.substring(0, 50)}...`);
        synced++;
        continue;
      }

      // Insert new proxy
      await (db as any).insert(proxyPool).values({
        url,
        type,
        label,
        status: "active",
        errorMessage: data.lastError || null,
        latencyMs: null,
        successCount: 0,
        failCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      synced++;
    } catch (err: any) {
      console.log(`  ✗ Error: ${err.message}`);
      errors++;
    }
  }

  srcDb.close();

  console.log(`\n=== Summary ===`);
  console.log(`  Inserted: ${synced}`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Skipped (duplicate): ${skipped}`);
  console.log(`  Errors: ${errors}`);
  console.log(`  Total in etteum: ${synced + updated + existingUrls.size}`);

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

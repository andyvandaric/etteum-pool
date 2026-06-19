#!/usr/bin/env bun
/**
 * sync-9router-to-etteum.ts
 * 
 * Sync active Kiro accounts from 9router SQLite DB into Etteum Pool.
 * Maps 9router's `kiro` provider → etteum's `kiro-pro` provider.
 * 
 * Usage:
 *   bun run sync-9router-to-etteum.ts [--dry-run] [--warmup]
 * 
 * Requirements:
 *   - Run from etteum-pool root directory
 *   - 9router data at %APPDATA%/9router/db/data.sqlite
 *   - Etteum pool DB at ./data/poolprox3.db
 */

import { Database } from "bun:sqlite";
import { db } from "./src/db/index";
import { accounts } from "./src/db/schema";
import { eq, and } from "drizzle-orm";
import path from "node:path";
import os from "node:os";

// --- Config ---
const NINE_ROUTER_DB = path.join(
  process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
  "9router", "db", "data.sqlite"
);
const ETTEUM_PROVIDER = "kiro-pro";
const DRY_RUN = process.argv.includes("--dry-run");
const DO_WARMUP = process.argv.includes("--warmup");

// --- Types ---
interface NineRouterConnection {
  id: string;
  provider: string;
  email: string | null;
  isActive: number;
  data: string;
}

interface NineRouterData {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  expiresIn?: number;
  profileArn?: string;
  providerSpecificData?: {
    profileArn?: string;
  };
  testStatus?: string;
  lastRefreshAt?: string;
}

interface EtteumTokens {
  access_token: string;
  refresh_token: string;
  expires_at: string;
  profile_arn: string;
}

// --- Main ---
async function main() {
  console.log("=== 9router → Etteum Pool Sync ===");
  console.log(`Source: ${NINE_ROUTER_DB}`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log("");

  // Open 9router DB (read-only)
  const srcDb = new Database(NINE_ROUTER_DB, { readonly: true });

  // Query active kiro accounts (9router stores email in `name` column)
  const rows = srcDb.query<NineRouterConnection, []>(
    "SELECT id, provider, COALESCE(NULLIF(email,''), name) as email, isActive, data FROM providerConnections WHERE provider = 'kiro' AND isActive = 1"
  ).all();

  console.log(`Found ${rows.length} active Kiro accounts in 9router\n`);

  if (rows.length === 0) {
    console.log("Nothing to sync.");
    srcDb.close();
    process.exit(0);
  }

  let synced = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      const data: NineRouterData = JSON.parse(row.data);
      const email = row.email || deriveEmail(data, row.id);

      if (!data.refreshToken) {
        console.log(`  ⚠ ${email}: No refresh token, skipping`);
        skipped++;
        continue;
      }

      // Refresh token to get fresh access_token + correct profileArn from AWS
      let accessToken = data.accessToken;
      let refreshToken = data.refreshToken;
      let expiresAt = data.expiresAt;
      let profileArn = data.profileArn || data.providerSpecificData?.profileArn || "";

      try {
        const refreshResp = await fetch("https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken }),
        });
        if (refreshResp.ok) {
          const refreshData = await refreshResp.json() as any;
          accessToken = refreshData.accessToken || accessToken;
          refreshToken = refreshData.refreshToken || refreshToken;
          expiresAt = new Date(Date.now() + (refreshData.expiresIn || 3600) * 1000).toISOString();
          profileArn = refreshData.profileArn || profileArn;
          console.log(`    ✓ Token refreshed, profileArn: ${profileArn?.substring(0, 60)}`);
        } else {
          console.log(`    ⚠ Refresh failed (${refreshResp.status}), using existing tokens`);
        }
      } catch (err: any) {
        console.log(`    ⚠ Refresh error: ${err.message}, using existing tokens`);
      }

      if (!profileArn) {
        console.log(`    ⚠ No profileArn found, warmup may fail`);
      }

      // Build etteum tokens object
      const tokens: EtteumTokens = {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: expiresAt,
        profile_arn: profileArn,
      };

      console.log(`  → ${email}`);
      console.log(`    profileArn: ${profileArn ? profileArn.substring(0, 60) + "..." : "MISSING"}`);
      console.log(`    refreshToken: ${data.refreshToken.substring(0, 20)}...`);
      console.log(`    expiresAt: ${data.expiresAt}`);

      if (DRY_RUN) {
        console.log(`    [DRY RUN] Would upsert as ${ETTEUM_PROVIDER}\n`);
        synced++;
        continue;
      }

      // Upsert into etteum: check if exists by provider+email
      const existing = await db.select()
        .from(accounts)
        .where(and(eq(accounts.provider, ETTEUM_PROVIDER), eq(accounts.email, email)));

      if (existing.length > 0) {
        // Update existing
        await db.update(accounts).set({
          tokens,
          metadata: { profileArn, source: "9router", syncedAt: new Date().toISOString() },
          status: "active",
          errorMessage: null,
          updatedAt: new Date(),
        }).where(eq(accounts.id, existing[0].id));
        console.log(`    ✓ Updated existing account #${existing[0].id}\n`);
      } else {
        // Insert new
        await db.insert(accounts).values({
          provider: ETTEUM_PROVIDER,
          email,
          password: "",
          status: "active",
          enabled: true,
          tokens,
          metadata: { profileArn, source: "9router", syncedAt: new Date().toISOString() },
          quotaLimit: -1,
          quotaRemaining: -1,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        console.log(`    ✓ Inserted new account\n`);
      }

      synced++;
    } catch (err: any) {
      console.log(`  ✗ Error processing ${row.email || row.id}: ${err.message}\n`);
      errors++;
    }
  }

  srcDb.close();

  console.log("\n=== Summary ===");
  console.log(`  Synced: ${synced}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Errors: ${errors}`);

  // Optional: trigger warmup after sync
  if (DO_WARMUP && synced > 0 && !DRY_RUN) {
    console.log("\n--- Triggering warmup ---");
    const allAccounts = await db.select().from(accounts)
      .where(eq(accounts.provider, ETTEUM_PROVIDER));
    
    for (const acc of allAccounts) {
      try {
        const r = await fetch(`http://localhost:1930/api/accounts/${acc.id}/warmup`, {
          method: "POST",
          headers: { 
            "Authorization": `Bearer ${getApiKey()}`,
            "Content-Type": "application/json"
          }
        });
        const result = await r.json() as any;
        console.log(`  Warmup #${acc.id} (${acc.email}): ${result.message || result.error?.message || "OK"}`);
      } catch (err: any) {
        console.log(`  Warmup #${acc.id} failed: ${err.message}`);
      }
    }
  }

  process.exit(0);
}

function deriveEmail(data: NineRouterData, id: string): string {
  // Fallback: generate email from ID hash
  const hash = id.substring(0, 8);
  return `kiro-${hash}@9router.local`;
}

function getApiKey(): string {
  // Read from env or use default
  return process.env.API_KEY || "pool-proxy-secret-key";
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

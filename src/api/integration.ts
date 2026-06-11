import { Hono } from "hono";
import { db } from "../db/index";
import { modelMappings, settings } from "../db/schema";
import { asc, eq } from "drizzle-orm";
import { invalidateModelMappingCache } from "../proxy/model-mapping";
import { getAllModels } from "../proxy/router";
import { broadcast } from "../ws/index";

export const integrationRouter = new Hono();

const MAPPING_ENABLED_SETTING = "model_mapping_enabled";
const VALID_MATCH_TYPES = new Set(["contains", "exact", "regex"]);

interface MappingInput {
  sourcePattern: string;
  matchType?: string;
  targetModel?: string;
  enabled?: boolean;
  priority?: number;
  label?: string | null;
}

async function getMasterEnabled(): Promise<boolean> {
  const [row] = await db.select().from(settings).where(eq(settings.key, MAPPING_ENABLED_SETTING));
  return row?.value == null ? true : row.value !== "false";
}

async function setMasterEnabled(enabled: boolean): Promise<void> {
  const value = enabled ? "true" : "false";
  const existing = await db.select().from(settings).where(eq(settings.key, MAPPING_ENABLED_SETTING));
  if (existing.length > 0) {
    await db.update(settings).set({ value, updatedAt: new Date() }).where(eq(settings.key, MAPPING_ENABLED_SETTING));
  } else {
    await db.insert(settings).values({ key: MAPPING_ENABLED_SETTING, value });
  }
}

/**
 * GET /api/integration - current mappings, master toggle, and the list of
 * models available in the pool (so the dashboard can offer them as targets).
 */
integrationRouter.get("/", async (c) => {
  const mappings = await db.select().from(modelMappings).orderBy(asc(modelMappings.priority));
  const enabled = await getMasterEnabled();
  const models = getAllModels().map((m) => ({ id: m.id, owned_by: m.owned_by }));
  return c.json({ enabled, mappings, models });
});

/**
 * PUT /api/integration - replace the full mapping set (and optional master
 * toggle) transactionally. Bulk-replace keeps the dashboard state model simple.
 */
integrationRouter.put("/", async (c) => {
  const body = await c.req.json<{ enabled?: boolean; mappings?: MappingInput[] }>();

  if (body.mappings !== undefined) {
    if (!Array.isArray(body.mappings)) {
      return c.json({ error: "mappings must be an array" }, 400);
    }

    const rows: Array<{
      sourcePattern: string;
      matchType: string;
      targetModel: string;
      enabled: boolean;
      priority: number;
      label: string | null;
    }> = [];

    for (const [i, m] of body.mappings.entries()) {
      const sourcePattern = (m.sourcePattern || "").trim();
      if (!sourcePattern) {
        return c.json({ error: `mappings[${i}]: sourcePattern is required` }, 400);
      }
      const matchType = m.matchType && VALID_MATCH_TYPES.has(m.matchType) ? m.matchType : "contains";
      if (matchType === "regex") {
        try {
          new RegExp(sourcePattern);
        } catch (e) {
          return c.json({ error: `mappings[${i}]: invalid regex: ${(e as Error).message}` }, 400);
        }
      }
      rows.push({
        sourcePattern,
        matchType,
        targetModel: (m.targetModel || "").trim(),
        enabled: m.enabled !== false,
        priority: Number.isFinite(m.priority) ? Number(m.priority) : i,
        label: m.label ?? null,
      });
    }

    // Bulk replace: clear then insert.
    await db.delete(modelMappings);
    if (rows.length > 0) {
      await db.insert(modelMappings).values(rows);
    }
  }

  if (typeof body.enabled === "boolean") {
    await setMasterEnabled(body.enabled);
  }

  invalidateModelMappingCache();
  broadcast({ type: "model_mappings_updated", data: {} });

  const mappings = await db.select().from(modelMappings).orderBy(asc(modelMappings.priority));
  const enabled = await getMasterEnabled();
  return c.json({ success: true, enabled, mappings });
});

/**
 * POST /api/integration/apply-config - Apply Claude Code configuration to ~/.claude/settings.json
 * Merges ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN into env section, removes model overrides.
 *
 * The frontend sends the base URL it already resolved (API_BASE) since the server
 * may not know its own public-facing address (proxied, tunnelled, etc.).
 */
integrationRouter.post("/apply-config", async (c) => {
  try {
    const pathMod = await import("node:path");
    const os = await import("node:os");
    const fs = await import("node:fs/promises");

    const body = await c.req.json<{ baseUrl?: string }>().catch((): { baseUrl?: string } => ({}));

    // Get current API key
    const apiKeyRow = await db.select().from(settings).where(eq(settings.key, "api_key"));
    const apiKey = apiKeyRow[0]?.value || process.env.API_KEY || "pool-proxy-secret-key";

    // Use frontend-provided base URL, fall back to localhost with config port
    const { config } = await import("../config");
    const baseUrl = body.baseUrl || `http://localhost:${config.port}`;

    // Target: ~/.claude/settings.json
    const homeDir = os.homedir();
    const claudeDir = pathMod.join(homeDir, ".claude");
    const settingsPath = pathMod.join(claudeDir, "settings.json");

    // Read existing settings or start with empty object
    let existingSettings: Record<string, unknown> = {};
    try {
      const content = await fs.readFile(settingsPath, "utf-8");
      existingSettings = JSON.parse(content);
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err;
    }

    // Merge env variables — preserve existing, upsert ours
    const envVars = {
      ...((existingSettings.env as Record<string, string>) || {}),
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: apiKey,
    };

    // Remove model overrides so proxy backend handles mapping
    delete existingSettings.model;
    delete existingSettings.smallModel;

    // Build new settings
    const newSettings = {
      ...existingSettings,
      env: envVars,
    };

    // Ensure directory exists and write atomically (write tmp then rename)
    await fs.mkdir(claudeDir, { recursive: true });
    const tmpPath = settingsPath + ".tmp";
    await fs.writeFile(tmpPath, JSON.stringify(newSettings, null, 2) + "\n", "utf-8");
    await fs.rename(tmpPath, settingsPath);

    return c.json({
      success: true,
      path: settingsPath,
      config: newSettings,
    });
  } catch (error: any) {
    console.error("[Integration] Failed to apply config:", error);
    return c.json(
      { success: false, error: error.message || "Failed to apply configuration" },
      500
    );
  }
});

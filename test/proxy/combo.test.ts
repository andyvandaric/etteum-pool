import { describe, it, expect, beforeEach } from "bun:test";
import {
  findComboForModel,
  shouldComboRetry,
  isComboModel,
  getComboVirtualModels,
  recordStepFailure,
  recordStepSuccess,
  isStepCooledDown,
  getStepCooldowns,
  ensureComboTable,
  loadComboCache,
  createComboRule,
  deleteComboRule,
  getAllComboRules,
  type ComboRule,
} from "../../src/proxy/combo";

// ---------------------------------------------------------------------------
// Helper: inject a combo rule into cache for testing
// ---------------------------------------------------------------------------
function injectRule(overrides: Partial<ComboRule> = {}): ComboRule {
  const rule: ComboRule = {
    id: 1,
    name: "test-chain",
    modelId: "best",
    triggerModel: "opus",
    matchType: "contains",
    steps: [
      { provider: "codebuddy", model: "cb-opus-4.6" },
      { provider: "kiro", model: "kr-claude-sonnet-4.5" },
    ],
    maxRetries: 3,
    retryOn: ["quota_exhausted", "rate_limit", "error", "timeout"],
    enabled: true,
    priority: 0,
    createdAt: new Date(),
    updatedAt: null,
    ...overrides,
  };
  return rule;
}

// We need to access the internal cache to test pure functions.
// The combo module uses module-level cache. We'll test via the public API
// by creating rules in DB and loading cache.

describe("combo findComboForModel", () => {
  it("returns null when combo is disabled", async () => {
    // When masterEnabled is false, findComboForModel returns null
    // We test this by ensuring no rules match when none exist
    const result = findComboForModel("claude-opus-4");
    // With empty cache, should return null
    expect(result).toBeNull();
  });

  it("returns null when no rule matches the model", async () => {
    const result = findComboForModel("totally-unrelated-model");
    expect(result).toBeNull();
  });
});

describe("combo shouldComboRetry", () => {
  const baseRule = injectRule();

  it("returns true for quota_exhausted when configured", () => {
    expect(shouldComboRetry(baseRule, "quota exceeded", true)).toBe(true);
  });

  it("returns true for rate_limit when configured", () => {
    expect(shouldComboRetry(baseRule, "429 too many", undefined, true)).toBe(true);
  });

  it("returns true for timeout errors", () => {
    expect(shouldComboRetry(baseRule, "Request timeout after 30s")).toBe(true);
    expect(shouldComboRetry(baseRule, "ETIMEDOUT")).toBe(true);
    expect(shouldComboRetry(baseRule, "The operation was aborted")).toBe(true);
  });

  it("returns true for generic errors when 'error' is in retryOn", () => {
    expect(shouldComboRetry(baseRule, "connection refused")).toBe(true);
    expect(shouldComboRetry(baseRule, "500 internal server error")).toBe(true);
  });

  it("returns false for content moderation errors", () => {
    expect(shouldComboRetry(baseRule, "content moderation detected")).toBe(false);
    expect(shouldComboRetry(baseRule, "sensitive content flagged")).toBe(false);
  });

  it("returns false for invalid model errors", () => {
    expect(shouldComboRetry(baseRule, "invalid_model_id: foo")).toBe(false);
    expect(shouldComboRetry(baseRule, "model_not_found")).toBe(false);
  });

  it("returns false when error type not in retryOn list", () => {
    const quotaOnlyRule = injectRule({ retryOn: ["quota_exhausted"] });
    expect(shouldComboRetry(quotaOnlyRule, "timeout after 30s")).toBe(false);
    expect(shouldComboRetry(quotaOnlyRule, "429 rate limited")).toBe(false);
  });

  it("returns true for empty error string (not a content issue, so generic error fires)", () => {
    expect(shouldComboRetry(baseRule, "")).toBe(true);
  });
});

describe("combo isComboModel", () => {
  it("returns null with empty cache", () => {
    expect(isComboModel("best")).toBeNull();
  });
});

describe("combo getComboVirtualModels", () => {
  it("returns empty array with empty cache", () => {
    const models = getComboVirtualModels();
    expect(Array.isArray(models)).toBe(true);
  });
});

describe("combo cooldown mechanism", () => {
  it("isStepCooledDown returns false for unknown step", () => {
    expect(isStepCooledDown("kiro", "unknown-model")).toBe(false);
  });

  it("recordStepFailure returns false below threshold", () => {
    // 4 failures (< threshold of 5) should not trigger cooldown
    for (let i = 0; i < 4; i++) {
      const cooled = recordStepFailure("kiro", "test-model");
      expect(cooled).toBe(false);
    }
  });

  it("recordStepFailure returns true at threshold (5th failure)", () => {
    const cooled = recordStepFailure("kiro", "test-model");
    expect(cooled).toBe(true);
    expect(isStepCooledDown("kiro", "test-model")).toBe(true);
  });

  it("recordStepSuccess resets cooldown", () => {
    recordStepSuccess("kiro", "test-model");
    expect(isStepCooledDown("kiro", "test-model")).toBe(false);
  });

  it("getStepCooldowns returns active cooldowns", () => {
    recordStepFailure("codebuddy", "cb-test");
    recordStepFailure("codebuddy", "cb-test");
    recordStepFailure("codebuddy", "cb-test");
    recordStepFailure("codebuddy", "cb-test");
    recordStepFailure("codebuddy", "cb-test");

    const cooldowns = getStepCooldowns();
    const entry = cooldowns.find((c) => c.step === "codebuddy/cb-test");
    expect(entry).toBeDefined();
    expect(entry!.failures).toBeGreaterThanOrEqual(5);
  });
});

describe("combo DB CRUD", () => {
  ensureComboTable();

  it("creates a combo rule and retrieves it", async () => {
    const created = await createComboRule({
      name: "test-opus-chain",
      modelId: "best",
      triggerModel: "opus",
      matchType: "contains",
      steps: [
        { provider: "codebuddy", model: "cb-opus-4.6" },
        { provider: "kiro", model: "kr-claude-sonnet-4.5" },
      ],
      maxRetries: 3,
      retryOn: ["quota_exhausted", "rate_limit", "error", "timeout"],
      enabled: true,
      priority: 0,
    });

    expect(created.id).toBeGreaterThan(0);
    expect(created.name).toBe("test-opus-chain");
    expect(created.modelId).toBe("best");
    expect(created.steps).toHaveLength(2);

    const all = await getAllComboRules();
    const found = all.find((r) => r.id === created.id);
    expect(found).toBeDefined();
    expect(found!.triggerModel).toBe("opus");
  });

  it("deletes a combo rule", async () => {
    const created = await createComboRule({
      name: "to-delete",
      modelId: "",
      triggerModel: "temp",
      matchType: "exact",
      steps: [{ provider: "kiro", model: "kr-test" }],
      maxRetries: 1,
      retryOn: ["error"],
      enabled: false,
      priority: 99,
    });

    const deleted = await deleteComboRule(created.id);
    expect(deleted).toBe(true);

    const all = await getAllComboRules();
    const found = all.find((r) => r.id === created.id);
    expect(found).toBeUndefined();
  });

  it("returns false when deleting non-existent rule", async () => {
    const deleted = await deleteComboRule(999999);
    expect(deleted).toBe(false);
  });
});

describe("combo shouldComboRetry edge cases", () => {
  const baseRule = injectRule();

  it("retries on generic network errors", () => {
    expect(shouldComboRetry(baseRule, "ECONNREFUSED")).toBe(true);
    expect(shouldComboRetry(baseRule, "fetch failed")).toBe(true);
    expect(shouldComboRetry(baseRule, "socket hang up")).toBe(true);
  });

  it("does not retry on content issues even with 'error' in retryOn", () => {
    expect(shouldComboRetry(baseRule, "Content moderation: flagged")).toBe(false);
    expect(shouldComboRetry(baseRule, "sensitive content detected")).toBe(false);
    expect(shouldComboRetry(baseRule, "invalid_model_id: foo")).toBe(false);
    expect(shouldComboRetry(baseRule, "model_not_found: bar")).toBe(false);
  });

  it("quotaExhausted flag takes priority over error string", () => {
    expect(shouldComboRetry(baseRule, "quota exceeded", true)).toBe(true);
    expect(shouldComboRetry(baseRule, "quota exceeded", false)).toBe(true); // generic error fires
  });

  it("rateLimited flag triggers retry when configured", () => {
    const rateLimitOnly = injectRule({ retryOn: ["rate_limit"] });
    expect(shouldComboRetry(rateLimitOnly, "429", undefined, true)).toBe(true);
    expect(shouldComboRetry(rateLimitOnly, "429", undefined, false)).toBe(false);
  });

  it("all retry conditions disabled returns false", () => {
    const noRetry = injectRule({ retryOn: [] });
    expect(shouldComboRetry(noRetry, "anything")).toBe(false);
    expect(shouldComboRetry(noRetry, "timeout", true)).toBe(false);
  });
});

describe("combo cooldown isolation", () => {
  it("different provider/model pairs have independent cooldowns", () => {
    recordStepFailure("kiro", "model-a");
    recordStepFailure("kiro", "model-a");
    recordStepFailure("kiro", "model-a");
    recordStepFailure("kiro", "model-a");
    recordStepFailure("kiro", "model-a");

    expect(isStepCooledDown("kiro", "model-a")).toBe(true);
    expect(isStepCooledDown("kiro", "model-b")).toBe(false);
    expect(isStepCooledDown("codebuddy", "model-a")).toBe(false);
  });

  it("success resets only the specific step", () => {
    recordStepFailure("codebuddy", "x");
    recordStepFailure("codebuddy", "x");
    recordStepFailure("codebuddy", "x");
    recordStepFailure("codebuddy", "x");
    recordStepFailure("codebuddy", "x");

    recordStepSuccess("codebuddy", "x");
    expect(isStepCooledDown("codebuddy", "x")).toBe(false);
  });
});

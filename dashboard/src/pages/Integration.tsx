import { useState, useEffect, useCallback, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plug, Copy, Check, Terminal, ArrowRight, Search, ChevronsUpDown, Zap } from "lucide-react";
import {
  fetchIntegration,
  saveIntegration,
  fetchApiKey,
  applyIntegrationConfig,
  API_BASE,
  type ModelMappingDTO,
} from "@/lib/api";
import { useTimedMessage } from "@/hooks/useTimedMessage";
import { useWsEvent } from "@/hooks/useWebSocket";

// Claude Code only ever calls these three model classes. Source patterns are
// fixed; the user just picks which pool model each one maps to.
const CLAUDE_CODE_SLOTS = [
  { source: "haiku", title: "Haiku", desc: "small / fast / background tasks" },
  { source: "sonnet", title: "Sonnet", desc: "main coding model" },
  { source: "opus", title: "Opus", desc: "heavy reasoning" },
] as const;

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
      className="p-1.5 rounded-md text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--secondary)] transition-colors shrink-0"
      title="Copy"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-[var(--success)]" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

function CodeRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <label className="text-xs font-medium text-[var(--muted-foreground)] mb-1 block">{label}</label>
      <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--background)]">
        <code className="text-sm font-mono text-[var(--foreground)] truncate flex-1">{value}</code>
        <CopyButton value={value} />
      </div>
    </div>
  );
}

interface ModelOption {
  id: string;
  owned_by: string;
}

/** Searchable dropdown: type to filter, list capped at ~8 visible rows + scroll. */
function ModelCombobox({
  value,
  options,
  onChange,
}: {
  value: string;
  options: ModelOption[];
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    if (open) {
      document.addEventListener("mousedown", onDoc);
      document.addEventListener("keydown", onKey);
    }
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? options.filter(
        (o) => o.id.toLowerCase().includes(q) || o.owned_by.toLowerCase().includes(q)
      )
    : options;

  const select = (id: string) => {
    onChange(id);
    setOpen(false);
    setQuery("");
  };

  const triggerCls =
    "w-full px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--background)] text-sm flex items-center justify-between gap-2 focus:outline-none focus:ring-2 focus:ring-[var(--primary)]";

  return (
    <div ref={ref} className="relative w-full">
      <button type="button" onClick={() => setOpen((o) => !o)} className={triggerCls}>
        <span className={value ? "truncate text-[var(--foreground)]" : "truncate text-[var(--muted-foreground)]"}>
          {value || "— pass through (no mapping) —"}
        </span>
        <ChevronsUpDown className="w-4 h-4 opacity-60 shrink-0" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] shadow-lg">
          <div className="flex items-center gap-2 px-2 py-1.5 border-b border-[var(--border)]">
            <Search className="w-3.5 h-3.5 text-[var(--muted-foreground)] shrink-0" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models..."
              className="w-full bg-transparent text-sm focus:outline-none text-[var(--foreground)]"
            />
          </div>
          {/* ~8 rows visible (each ~36px), the rest scrolls */}
          <ul className="max-h-[18rem] overflow-y-auto py-1">
            <li>
              <button
                type="button"
                onClick={() => select("")}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-[var(--secondary)] flex items-center justify-between ${
                  !value ? "bg-[var(--secondary)]" : ""
                }`}
              >
                <span className="text-[var(--muted-foreground)]">— pass through (no mapping) —</span>
                {!value && <Check className="w-3.5 h-3.5 text-[var(--primary)]" />}
              </button>
            </li>
            {filtered.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  onClick={() => select(o.id)}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-[var(--secondary)] flex items-center justify-between gap-2 ${
                    value === o.id ? "bg-[var(--secondary)]" : ""
                  }`}
                >
                  <span className="truncate text-[var(--foreground)]">{o.id}</span>
                  <span className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-[var(--muted-foreground)]">{o.owned_by}</span>
                    {value === o.id && <Check className="w-3.5 h-3.5 text-[var(--primary)]" />}
                  </span>
                </button>
              </li>
            ))}
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-xs text-[var(--muted-foreground)]">No models match “{query}”.</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function Integration() {
  const [enabled, setEnabled] = useState(true);
  // target model keyed by source slot ("haiku" | "sonnet" | "opus")
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [models, setModels] = useState<{ id: string; owned_by: string }[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const { message, setMessage } = useTimedMessage<string>(null, 3000);

  // ANTHROPIC_BASE_URL points at the proxy root; Claude Code appends /v1/messages.
  const baseUrl = API_BASE;

  const load = useCallback(async () => {
    try {
      const [data, keyRes] = await Promise.all([
        fetchIntegration(),
        fetchApiKey().catch(() => null),
      ]);
      setEnabled(data.enabled);
      setModels(data.models || []);
      // Match stored mappings back onto the three fixed slots by source pattern.
      const next: Record<string, string> = {};
      for (const slot of CLAUDE_CODE_SLOTS) {
        const found = (data.mappings || []).find(
          (m) => m.sourcePattern.toLowerCase() === slot.source
        );
        next[slot.source] = found?.targetModel || "";
      }
      setTargets(next);
      if (keyRes?.key) setApiKey(keyRes.key);
    } catch (e: any) {
      setMessage(e.message || "Failed to load integration settings");
    } finally {
      setLoading(false);
    }
  }, [setMessage]);

  useEffect(() => { load(); }, [load]);
  useWsEvent(["model_mappings_updated"], load);

  const handleSave = async () => {
    setSaving(true);
    try {
      const mappings: ModelMappingDTO[] = CLAUDE_CODE_SLOTS.map((slot, i) => ({
        sourcePattern: slot.source,
        matchType: "contains",
        targetModel: targets[slot.source] || "",
        enabled: Boolean(targets[slot.source]), // active only when a target is set
        priority: i,
        label: `Claude Code · ${slot.title}`,
      }));
      await saveIntegration({ enabled, mappings });
      setMessage("Saved");
    } catch (e: any) {
      setMessage(e.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleApplyConfig = async () => {
    setApplying(true);
    try {
      await applyIntegrationConfig(baseUrl);
      setMessage("Applied configuration to ~/.claude/settings.json");
    } catch (e: any) {
      setMessage(e.message || "Failed to apply configuration");
    } finally {
      setApplying(false);
    }
  };

  const envSnippet = `export ANTHROPIC_BASE_URL="${baseUrl}"
export ANTHROPIC_AUTH_TOKEN="${apiKey || "<YOUR_API_KEY>"}"`;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)] flex items-center gap-2">
            <Plug className="w-6 h-6" /> Integration
          </h1>
          <p className="text-sm text-[var(--muted-foreground)]">
            Connect Claude Code and route its models to any model in your pool
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Enable mapping
          </label>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>

      {message && (
        <div className="px-4 py-2 rounded-md bg-[var(--secondary)] text-sm text-[var(--foreground)]">{message}</div>
      )}

      {/* Claude Code connection guide */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Terminal className="w-4 h-4" /> Claude Code Setup
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-[var(--muted-foreground)]">
            Point Claude Code at this proxy with the two env vars below. It keeps calling its own models
            (Haiku / Sonnet / Opus) — the mapping below rewrites them to your chosen models automatically.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <CodeRow label="ANTHROPIC_BASE_URL" value={baseUrl} />
            <CodeRow label="ANTHROPIC_AUTH_TOKEN" value={apiKey || "<YOUR_API_KEY>"} />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-[var(--muted-foreground)]">Shell snippet</label>
              <CopyButton value={envSnippet} />
            </div>
            <pre className="px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--background)] text-xs font-mono text-[var(--foreground)] overflow-x-auto whitespace-pre">
              {envSnippet}
            </pre>
          </div>
          <div className="pt-2">
            <Button onClick={handleApplyConfig} disabled={applying} className="w-full sm:w-auto gap-2">
              {applying ? (
                <>Applying...</>
              ) : (
                <>
                  <Zap className="w-4 h-4" />
                  Apply Config
                </>
              )}
            </Button>
            <p className="text-xs text-[var(--muted-foreground)] mt-2">
              Write configuration to ~/.claude/settings.json. This sets up the proxy connection and removes any model overrides.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Fixed Claude Code model mapping — just pick the target for each class */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ArrowRight className="w-4 h-4" /> Model Mapping
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-[var(--muted-foreground)]">Loading...</p>
          ) : (
            <div className="space-y-3">
              {CLAUDE_CODE_SLOTS.map((slot) => (
                <div
                  key={slot.source}
                  className="flex flex-col gap-2 sm:flex-row sm:items-center px-4 py-3 rounded-md bg-[var(--secondary)]"
                >
                  <div className="sm:w-48 shrink-0">
                    <div className="text-sm font-medium text-[var(--foreground)]">{slot.title}</div>
                    <div className="text-xs text-[var(--muted-foreground)]">{slot.desc}</div>
                  </div>
                  <ArrowRight className="hidden sm:block w-4 h-4 text-[var(--muted-foreground)] shrink-0" />
                  <ModelCombobox
                    value={targets[slot.source] || ""}
                    options={models}
                    onChange={(id) => setTargets((t) => ({ ...t, [slot.source]: id }))}
                  />
                </div>
              ))}
            </div>
          )}
          <p className="mt-3 text-xs text-[var(--muted-foreground)]">
            Leave a class on “pass through” to keep its original behavior. Changes apply after you click Save.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

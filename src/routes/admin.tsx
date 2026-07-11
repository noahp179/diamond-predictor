import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

export const Route = createFileRoute("/admin")({
  head: () => ({
    meta: [{ title: "Pipeline Admin — Diamond Edge" }],
  }),
  component: Admin,
});

function Admin() {
  const [secret, setSecret] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  async function runPipeline() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/public/hooks/run-pipeline", {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` },
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error ?? `HTTP ${res.status}`);
      } else {
        setResult(json);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="font-display text-3xl">Pipeline admin</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Manually trigger ingest + settle + recompute metrics — the same code path the daily
        Vercel cron runs. Self-heals up to 10 missing days in one call. Requires the{" "}
        <code className="font-mono">CRON_SECRET</code> from Vercel → Project Settings →
        Environment Variables.
      </p>
      <div className="mt-6 space-y-3">
        <input
          type="password"
          placeholder="CRON_SECRET"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
        <button
          onClick={runPipeline}
          disabled={loading || !secret}
          className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {loading ? "Running…" : "Run pipeline now"}
        </button>
      </div>
      {error && (
        <pre className="mt-6 whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/10 p-4 text-xs text-destructive">
          {error}
        </pre>
      )}
      {result != null && (
        <pre className="mt-6 whitespace-pre-wrap rounded-md border border-border bg-muted p-4 text-xs">
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  );
}

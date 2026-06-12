import { createFileRoute } from "@tanstack/react-router";

import {
  ingestAndPredict,
  recomputeDailyMetrics,
  settleFinished,
} from "@/lib/mlb-pipeline.server";

function verifyCronSecret(request: Request): Response | null {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error("[cron] CRON_SECRET is not set — rejecting request");
    return Response.json({ ok: false, error: "Server misconfiguration" }, { status: 500 });
  }
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.replace("Bearer ", "").trim();
  if (token !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

export const Route = createFileRoute("/api/public/hooks/run-pipeline")({
  server: {
    handlers: {
      GET: async () => {
        // Health-check / dry-run: return last-run info so you can test the endpoint without side-effects.
        const today = new Date().toISOString().slice(0, 10);
        return Response.json({
          ok: true,
          note: "Use POST to run the full pipeline (ingest + settle + metrics).",
          today,
          env: process.env.VERCEL ? "vercel" : "local",
        });
      },
      POST: async ({ request }) => {
        // Guard the destructive operation with a shared secret.
        const authErr = verifyCronSecret(request);
        if (authErr) return authErr;

        const today = new Date().toISOString().slice(0, 10);
        const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        const startedAt = new Date().toISOString();
        console.log(`[cron] pipeline started at ${startedAt} for yesterday=${yesterday}, today=${today}`);
        try {
          // 1. Catch up the previous day (ingest + settle) — this is the main 3am job
          const ingestYesterday = await ingestAndPredict(yesterday);
          const settle = await settleFinished();
          const metrics = await recomputeDailyMetrics();
          // 2. Pre-load today's schedule so the front-end can read from the DB quickly
          const ingestToday = await ingestAndPredict(today);
          const finishedAt = new Date().toISOString();
          console.log(`[cron] pipeline finished at ${finishedAt}`);
          return Response.json({
            ok: true,
            yesterday,
            today,
            startedAt,
            finishedAt,
            ingestYesterday,
            ingestToday,
            settle,
            metrics,
          });
        } catch (err) {
          console.error("[cron] pipeline failed", err);
          return Response.json(
            { ok: false, startedAt, error: err instanceof Error ? err.message : String(err) },
            { status: 500 },
          );
        }
      },
    },
  },
});

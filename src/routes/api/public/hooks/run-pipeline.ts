import { createFileRoute } from "@tanstack/react-router";

import {
  ingestAndPredict,
  recomputeDailyMetrics,
  settleFinished,
} from "@/lib/mlb-pipeline.server";

export const Route = createFileRoute("/api/public/hooks/run-pipeline")({
  server: {
    handlers: {
      POST: async () => {
        const today = new Date().toISOString().slice(0, 10);
        try {
          const ingest = await ingestAndPredict(today);
          const settle = await settleFinished();
          const metrics = await recomputeDailyMetrics();
          return Response.json({ ok: true, date: today, ingest, settle, metrics });
        } catch (err) {
          console.error("[cron] pipeline failed", err);
          return Response.json(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            { status: 500 },
          );
        }
      },
    },
  },
});
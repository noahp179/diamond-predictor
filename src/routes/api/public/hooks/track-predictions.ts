import { createFileRoute } from "@tanstack/react-router";

import { canTrack, runTrackingCycle } from "@/lib/tracking.server";

/**
 * Records today's and tomorrow's soccer and tennis predictions, then scores
 * whatever has finished since the last run.
 *
 * Runs after the MLB pipeline so the two are not competing for the same cold
 * start. Idempotent by construction: predictions conflict on
 * (model_version, event_id) and are dropped rather than merged, so re-running
 * cannot change a call that was already written down.
 */
function verifyCronSecret(request: Request): Response | null {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error("[cron] CRON_SECRET is not set — rejecting request");
    return Response.json({ ok: false, error: "Server misconfiguration" }, { status: 500 });
  }
  const token = (request.headers.get("authorization") ?? "").replace("Bearer ", "").trim();
  if (token !== expected) return new Response("Unauthorized", { status: 401 });
  return null;
}

export const Route = createFileRoute("/api/public/hooks/track-predictions")({
  server: {
    handlers: {
      GET: async () =>
        Response.json({
          ok: true,
          note: "Use POST to record today's predictions and settle finished ones.",
          writable: canTrack(),
          today: new Date().toISOString().slice(0, 10),
        }),
      POST: async ({ request }) => {
        const authErr = verifyCronSecret(request);
        if (authErr) return authErr;
        if (!canTrack()) {
          return Response.json(
            { ok: false, error: "No service-role key; the ledger is read-only here." },
            { status: 503 },
          );
        }
        const startedAt = new Date().toISOString();
        try {
          const result = await runTrackingCycle(startedAt.slice(0, 10));
          console.log(
            `[cron] tracking: recorded ${result.recorded.soccer} soccer + ` +
              `${result.recorded.tennis} tennis, settled ${result.settled}`,
          );
          return Response.json({ ok: true, startedAt, ...result });
        } catch (err) {
          console.error("[cron] tracking failed", err);
          return Response.json(
            { ok: false, startedAt, error: err instanceof Error ? err.message : String(err) },
            { status: 500 },
          );
        }
      },
    },
  },
});

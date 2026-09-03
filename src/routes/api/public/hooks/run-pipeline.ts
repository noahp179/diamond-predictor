import { createFileRoute } from "@tanstack/react-router";

import { runFullPipelineCycle } from "@/lib/mlb-pipeline.server";

/**
 * The daily MLB cycle: ingest and predict, settle what finished, recompute
 * the daily metrics.
 *
 * WHY GET RUNS THE PIPELINE
 * -------------------------
 * Vercel Cron invokes a scheduled path with GET, sending the CRON_SECRET as a
 * bearer token. This handler used to do the work on POST only and answer GET
 * with "use POST to run the full pipeline", so the scheduled job fired on time
 * every day, got a 200, and did nothing. A 200 is a success as far as the
 * platform is concerned, so nothing ever alerted — CRON.md records the symptom
 * ("the cron stopped writing on 2026-06-15") and the workaround that has been
 * carrying the pipeline since: running it by hand from a local crontab.
 *
 * An authenticated GET now runs the cycle. An unauthenticated one still gets a
 * harmless status page, but one that says plainly that it did NOT run and
 * whether the secret is even configured, so this cannot fail silently twice.
 */
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

function authorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  const token = (request.headers.get("authorization") ?? "").replace("Bearer ", "").trim();
  return Boolean(expected) && token === expected;
}

async function run(request: Request): Promise<Response> {
  const authErr = verifyCronSecret(request);
  if (authErr) return authErr;

  const startedAt = new Date().toISOString();
  console.log(`[cron] pipeline started at ${startedAt}`);
  try {
    const result = await runFullPipelineCycle();
    const finishedAt = new Date().toISOString();
    console.log(
      `[cron] pipeline finished at ${finishedAt}, backfilled=${result.backfilledDates.join(",") || "none"}`,
    );
    return Response.json({ ok: true, startedAt, finishedAt, ...result });
  } catch (err) {
    console.error("[cron] pipeline failed", err);
    return Response.json(
      { ok: false, startedAt, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export const Route = createFileRoute("/api/public/hooks/run-pipeline")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        authorized(request)
          ? run(request)
          : Response.json({
              ok: true,
              ran: false,
              why: "No valid CRON_SECRET on this request, so the pipeline did not run.",
              cronSecretSet: Boolean(process.env.CRON_SECRET),
              today: new Date().toISOString().slice(0, 10),
              env: process.env.VERCEL ? "vercel" : "local",
            }),
      POST: async ({ request }) => run(request),
    },
  },
});

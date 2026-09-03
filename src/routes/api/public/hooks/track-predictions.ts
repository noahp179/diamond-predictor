import { createFileRoute } from "@tanstack/react-router";

import { canTrack, readLedger, runTrackingCycle } from "@/lib/tracking.server";

/**
 * Records today's and tomorrow's predictions for every sport the ledger covers
 * — soccer, tennis, NFL and NBA — then scores whatever has finished.
 *
 * Runs after the MLB pipeline so the two are not competing for the same cold
 * start. Idempotent by construction: predictions conflict on
 * (model_version, event_id) and are dropped rather than merged, so re-running
 * cannot change a call that was already written down.
 *
 * GET AND POST BOTH DO THE WORK, AND THAT IS NOT AN OVERSIGHT
 * ----------------------------------------------------------
 * Vercel Cron invokes a scheduled path with GET. This handler used to do the
 * work on POST only and answer GET with a friendly "use POST to record"
 * note — so the scheduled job ran on time, every day, received the note, and
 * wrote nothing. Nothing errored and nothing was logged, because from the
 * platform's point of view a 200 is a success.
 *
 * Both verbs now run the cycle behind the same CRON_SECRET check. The work is
 * idempotent, so there is no risk in a GET doing it, and being unreachable by
 * the scheduler is a far worse failure than being reachable by two verbs.
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

/**
 * What an unauthenticated GET answers.
 *
 * The endpoint stays pokeable from a browser, but it now reports whether it
 * COULD do anything rather than describing how to call it. Every field here is
 * a way this job has silently failed: no secret means Vercel's cron arrives
 * unauthenticated, no service-role key means every insert is dropped, and
 * `ledgerReady: false` means the table does not exist so the writes go nowhere.
 */
async function diagnose(): Promise<Response> {
  const probe = await readLedger("tennis", "atp");
  return Response.json({
    ok: true,
    ran: false,
    why: "No valid CRON_SECRET on this request, so nothing was written.",
    cronSecretSet: Boolean(process.env.CRON_SECRET),
    writable: canTrack(),
    ledgerReady: probe.status === "ok",
    ledgerStatus: probe.status,
    today: new Date().toISOString().slice(0, 10),
  });
}

async function run(request: Request): Promise<Response> {
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
      `[cron] tracking: recorded ${result.recorded.soccer} soccer, ` +
        `${result.recorded.tennis} tennis, ${result.recorded.nfl} nfl, ` +
        `${result.recorded.nba} nba; settled ${result.settled}`,
    );
    return Response.json({ ok: true, startedAt, ...result });
  } catch (err) {
    console.error("[cron] tracking failed", err);
    return Response.json(
      { ok: false, startedAt, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export const Route = createFileRoute("/api/public/hooks/track-predictions")({
  server: {
    handlers: {
      // Vercel Cron sends GET with `Authorization: Bearer $CRON_SECRET`, so an
      // authenticated GET runs the cycle. An unauthenticated one reports why it
      // cannot, which is the failure mode that cost this ledger every row it
      // never wrote.
      GET: async ({ request }) => {
        const expected = process.env.CRON_SECRET;
        const token = (request.headers.get("authorization") ?? "").replace("Bearer ", "").trim();
        return expected && token === expected ? run(request) : diagnose();
      },
      POST: async ({ request }) => run(request),
    },
  },
});

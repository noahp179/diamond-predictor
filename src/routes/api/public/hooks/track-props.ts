import { createFileRoute } from "@tanstack/react-router";

import { canTrackProps, runPropCycle } from "@/lib/prop-ledger.server";

/**
 * Records and settles every player-prop board that had no record: MLB and NFL
 * player props, the five soccer leagues' player props, and MLB team stacks
 * (see prop-ledger.server.ts).
 *
 * Its own daily cron rather than a step in track-predictions: building these
 * boards is the heaviest thing the site does (soccer replays a season of match
 * reports per league), and the event cron already runs close to its time
 * limit. Two jobs, two budgets, neither starves the other.
 *
 * Same contract as track-predictions: Vercel Cron calls it with GET and
 * `Authorization: Bearer $CRON_SECRET`; POST works too; an unauthenticated GET
 * only reports whether a run COULD write.
 */
function authorised(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  const token = (request.headers.get("authorization") ?? "").replace("Bearer ", "").trim();
  return Boolean(expected) && token === expected;
}

async function run(): Promise<Response> {
  if (!canTrackProps()) {
    return Response.json(
      { ok: false, error: "No service-role key; the ledger is read-only here." },
      { status: 503 },
    );
  }
  const startedAt = new Date().toISOString();
  try {
    const result = await runPropCycle(startedAt.slice(0, 10));
    console.log(`[cron] props: ${JSON.stringify(result)}`);
    return Response.json({ ok: true, startedAt, ...result });
  } catch (err) {
    console.error("[cron] props failed", err);
    return Response.json(
      { ok: false, startedAt, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export const Route = createFileRoute("/api/public/hooks/track-props")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        authorised(request)
          ? run()
          : Response.json({
              ok: true,
              ran: false,
              why: "No valid CRON_SECRET on this request, so nothing was written.",
              cronSecretSet: Boolean(process.env.CRON_SECRET),
              writable: canTrackProps(),
            }),
      POST: async ({ request }) =>
        authorised(request) ? run() : new Response("Unauthorized", { status: 401 }),
    },
  },
});

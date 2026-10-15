import { createFileRoute } from "@tanstack/react-router";

import { todayET } from "@/lib/date";
import { runSimSlot, settleSimPicks, SLOTS, type SimPropsLeague } from "@/lib/sim-props.server";

/**
 * Plays one slot of today's games up to 100,000 times each and stores every
 * player's chances in sim_props, for the simulation-driven prop boards.
 *
 *   GET /api/public/hooks/sim-props?league=nba&slot=0
 *   GET /api/public/hooks/sim-props?league=nba&settle=1   (grade finished games)
 *
 * One cron per slot (vercel.json): a slot is a few games, sized to finish
 * inside one function's time limit at the full count. Same contract as the
 * other hooks — Vercel Cron sends `Authorization: Bearer $CRON_SECRET`; an
 * unauthenticated GET only reports whether a run could write.
 */
const LEAGUES = new Set<SimPropsLeague>(["nba", "nhl", "nfl", "cfb"]);

function authorised(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  const token = (request.headers.get("authorization") ?? "").replace("Bearer ", "").trim();
  return Boolean(expected) && token === expected;
}

async function run(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const league = url.searchParams.get("league") as SimPropsLeague | null;
  if (league && LEAGUES.has(league) && url.searchParams.get("settle")) {
    // The morning after: grade every pick from the box scores, with the whole
    // function's time to do it in.
    const result = await settleSimPicks(league, url.searchParams.get("date") ?? todayET(), 270_000);
    console.log(`[cron] sim-props settle ${league}: ${JSON.stringify(result)}`);
    return Response.json({ ok: true, ...result });
  }
  const slot = Number(url.searchParams.get("slot") ?? "0");
  if (
    !league ||
    !LEAGUES.has(league) ||
    !Number.isInteger(slot) ||
    slot < 0 ||
    slot >= SLOTS[league]
  )
    return Response.json({ ok: false, error: "league and slot required" }, { status: 400 });
  const date = url.searchParams.get("date") ?? todayET();
  try {
    const result = await runSimSlot(league, date, slot);
    console.log(`[cron] sim-props ${league} ${date} slot ${slot}: ${JSON.stringify(result)}`);
    return Response.json({ date, ...result });
  } catch (err) {
    console.error(`[cron] sim-props ${league} slot ${slot} failed`, err);
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export const Route = createFileRoute("/api/public/hooks/sim-props")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        authorised(request)
          ? run(request)
          : Response.json({
              ok: true,
              ran: false,
              why: "No valid CRON_SECRET on this request, so nothing was written.",
              cronSecretSet: Boolean(process.env.CRON_SECRET),
            }),
      POST: async ({ request }) =>
        authorised(request) ? run(request) : new Response("Unauthorized", { status: 401 }),
    },
  },
});

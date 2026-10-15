#!/usr/bin/env node
/**
 * Checks the game-by-game results on real games, without writing anything.
 *
 * For a few finished games that have recorded picks it reads ESPN's box score
 * the way the grading job does (boxFor), shapes it the way game_results stores
 * it, joins the recorded picks and the stored simulation exactly as the
 * Analytics page does (resultGames) — and re-grades every pick from the box
 * score, so a pick whose stored verdict disagrees with the stat line fails.
 *
 *   npx tsx scripts/test-game-results.ts nfl [event ids...]
 *
 * With no ids it takes the most recent games that have graded picks. The
 * server module reads import.meta.env, so it is loaded through Vite's SSR
 * loader rather than imported directly.
 */
import { createServer } from "vite";

const league = (process.argv[2] ?? "nfl") as "nfl" | "nhl" | "nba";
const asked = process.argv.slice(3);
const URL_ = process.env.SUPABASE_URL ?? "https://fmhtbaikwlcjzrlisesf.supabase.co";
const KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";

async function rest<T>(path: string): Promise<T> {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json() as Promise<T>;
}

let fails = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) fails += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
}

const vite = await createServer({
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "error",
});
try {
  const mod = await vite.ssrLoadModule("/src/lib/sim-props.server.ts");
  const nflModel = (await vite.ssrLoadModule("/src/lib/nfl-props-model.json")).default;

  type Pick = Parameters<typeof mod.resultGames>[3][number];
  const ids: string[] = asked.length
    ? asked
    : [
        ...new Set(
          (
            await rest<{ event_id: string }[]>(
              `player_predictions?select=event_id&sport=eq.${league}&provenance=eq.forward&settled_at=not.is.null&order=event_date.desc&limit=400`,
            )
          ).map((r) => r.event_id),
        ),
      ].slice(0, 4);

  for (const id of ids) {
    const box = await mod.boxFor(league, id);
    if (!box) {
      console.log(`--  ${id}: not final yet`);
      continue;
    }
    const players = [...box.lines.entries()].map(
      ([pid, stats]: [string, Record<string, number>]) => ({
        id: pid,
        name: box.who.get(pid)?.name ?? "",
        team: box.who.get(pid)?.team ?? "",
        stats,
      }),
    );
    const picks = await rest<Pick[]>(
      `player_predictions?select=event_id,model_version,market,player_id,player,team,pick_rank,prob,scored,settled_at&sport=eq.${league}&provenance=eq.forward&event_id=eq.${id}`,
    );
    const sims = await rest<{ event_id: string; players: unknown[] }[]>(
      `sim_props?select=event_id,players&league=eq.${league}&event_id=eq.${id}`,
    );
    const [g] = mod.resultGames(
      league,
      [
        {
          event_id: id,
          game_date: null,
          matchup: box.matchup,
          final_score: box.score,
          players,
          first_scorer: box.first,
          box_url: mod.boxUrl(league, id),
        },
      ],
      new Map(sims.map((s) => [s.event_id, s.players])),
      picks,
      nflModel.markets,
    );

    console.log(
      `\n== ${g.matchup}  ${g.score}  (${g.simulated ? "simulated" : "no simulation"})  ${g.boxUrl}`,
    );
    console.log(`   ${g.stars.title}:`);
    for (const s of g.stars.rows)
      console.log(
        `     ${s.player} (${s.team}) ${s.value} ${g.stars.noun}` +
          (s.prob != null ? ` — board had ${(s.prob * 100).toFixed(0)}%` : " — not priced") +
          (s.rank ? `, ranked ${s.rank} of ${s.of}` : "") +
          (s.proj != null ? ` — projected ${s.proj.toFixed(1)}` : "") +
          (s.picked ? " [picked]" : ""),
      );
    console.log(`   ${g.picks.length} recorded picks, ${g.hits} of ${g.graded} graded came in`);
    for (const p of g.picks.slice(0, 8))
      console.log(
        `     ${p.model} · ${p.market} · ${p.player}: said ${(p.prob * 100).toFixed(0)}% → ${p.actual} [${p.result}]`,
      );

    // Re-grade every graded pick from the stat line.
    check(`${g.matchup}: the box has players`, players.length > 10, `${players.length}`);
    check(`${g.matchup}: the matchup reads "AWY @ HOM"`, /^\S+ @ \S+$/.test(g.matchup), g.matchup);
    for (const p of picks) {
      if (!p.settled_at) continue;
      const stored = p.scored;
      const again =
        p.market === "anytime_td"
          ? box.lines.get(p.player_id)
            ? (box.lines.get(p.player_id)!.td ?? 0) >= 1
            : null
          : mod.outcome(p.market, box, p.player_id);
      check(
        `${g.matchup}: ${p.player} ${p.market} graded ${stored === null ? "void" : stored ? "hit" : "miss"} agrees with the box`,
        again === stored,
        `box says ${again === null ? "void" : again ? "hit" : "miss"}`,
      );
    }
    const scorers = g.stars.rows.reduce((n: number, s: { value: number }) => n + s.value, 0);
    console.log(`   ${scorers} ${g.stars.noun} counted from the box`);
  }
} finally {
  await vite.close();
}
console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
process.exit(fails ? 1 : 0);

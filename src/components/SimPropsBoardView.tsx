import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";

import { CalibrationTable } from "@/components/CalibrationTable";
import { SportShell, Stat, StatBar } from "@/components/SportShell";
import { useSimWorker } from "@/components/sim/useSimWorker";
import { todayET } from "@/lib/date";
import backtest from "@/lib/sim-props-backtest.json";
import { getSimPropsBoard, type SimBoardGame } from "@/lib/sim-props.functions";
import {
  playersFrom,
  probOf,
  simBoard,
  type Market,
  type SimPlayer,
  type SimPropsLeague,
} from "@/lib/sim-props-shared";
import { getSimMatchup } from "@/lib/sim/sim.functions";

/**
 * A simulation-driven prop board: every game on the date played up to
 * 100,000 times by the site's simulator, and the players ranked by how often
 * they reached the line — corrected by the calibration map the backtest
 * learned, so that 60% on this page has meant 6 in 10.
 *
 * Games the morning jobs have not reached yet can be played here in the
 * browser (10,000 times) with the same arithmetic.
 */

const LEAGUE_NAME: Record<SimPropsLeague, string> = {
  nba: "NBA",
  nhl: "NHL",
  nfl: "NFL",
  cfb: "College football",
};
const SPORT_WORD: Record<SimPropsLeague, string> = {
  nba: "game",
  nhl: "game",
  nfl: "game",
  cfb: "game",
};
const BROWSER_RUNS = 10_000;
const SHOW = 15;

type Row = SimPlayer & { gameId: string };

type BacktestMarket = {
  label: string;
  season: string;
  n: number;
  games: number;
  chosen: string;
  methods: Record<
    string,
    { brier: number; log_loss: number; auc: number; top_hit: number; top_said: number }
  >;
  top_unit: string;
  calibration: { band: string; n: number; predicted: number; actual: number }[];
};
const BT = backtest as unknown as Record<string, Record<string, BacktestMarket>>;

/** 1,000 vs 10,000 vs 100,000 plays on a sample of last season's games
 *  (research/player-props/runs_study.py), one entry per line. */
type RunLine = {
  mean_abs_diff_1k: number;
  mean_abs_diff_10k: number;
  brier_1k: number;
  brier_100k: number;
  top3_same_1k: number;
};
const RUNS = (backtest as unknown as { runs?: Record<string, { games: number; lines: RunLine[] }> })
  .runs;

const METHOD_LABEL: Record<string, string> = {
  sim_cal: "The simulator, calibrated (what this page shows)",
  sim: "The simulator, raw",
  avg: "His season average",
  fit: "A fitted model (gradient-boosted trees)",
  hybrid: "Fitted model + simulator",
  blend: "Half simulator, half fitted model",
  model: "The previous model on this page",
  model_td1: "The shipped first-touchdown model",
  model_share: "Anytime model, split by share",
};

const pct = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`;

function when(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function SimPropsBoardView({ league, board }: { league: SimPropsLeague; board: string }) {
  const def = simBoard(league, board);
  const [date, setDate] = useState(todayET());
  const [marketKey, setMarketKey] = useState(
    // Basketball opens on 20+ points; every other board on its first line.
    def?.markets[league === "nba" ? Math.min(2, def.markets.length - 1) : 0]?.key ?? "",
  );
  const [showAll, setShowAll] = useState(false);
  const load = useServerFn(getSimPropsBoard);
  const loadMatchup = useServerFn(getSimMatchup);
  const worker = useSimWorker();
  const { data, isLoading } = useQuery({
    queryKey: ["sim-props", league, date],
    queryFn: () => load({ data: { league, date } }),
    staleTime: 5 * 60_000,
  });
  // Games played here in the browser, keyed by game id.
  const [local, setLocal] = useState<Record<string, { players: SimPlayer[]; runs: number }>>({});
  const [running, setRunning] = useState<{ game: string; done: number; n: number } | null>(null);

  const market: Market | undefined =
    def?.markets.find((m) => m.key === marketKey) ?? def?.markets[0];
  const games = useMemo(() => data?.games ?? [], [data]);
  const gameOf = useMemo(() => new Map(games.map((g) => [g.id, g])), [games]);

  const rows: Row[] = useMemo(() => {
    const fromServer = data?.players ?? [];
    const fromHere = Object.entries(local).flatMap(([gameId, v]) =>
      v.players.map((p) => ({ ...p, gameId })),
    );
    const served = new Set(fromServer.map((p) => p.gameId));
    return [...fromServer, ...fromHere.filter((p) => !served.has(p.gameId))];
  }, [data, local]);

  const ranked = useMemo(() => {
    if (!market) return [];
    return rows
      .map((p) => ({ p, prob: probOf(league, p, market.key) }))
      .filter((r) => r.prob > 0.001)
      .sort((a, b) => b.prob - a.prob);
  }, [rows, market, league]);

  const pending = games.filter((g) => g.runs === 0 && !local[g.id] && g.state === "pre");
  const runsShown = [...new Set(rows.map((r) => r.gameId))]
    .map((id) => gameOf.get(id)?.runs || local[id]?.runs || 0)
    .filter(Boolean);

  async function playHere() {
    for (const g of pending) {
      setRunning({ game: `${g.away.abbr} @ ${g.home.abbr}`, done: 0, n: BROWSER_RUNS });
      try {
        const m = await loadMatchup({
          data: { league, homeId: g.home.id, awayId: g.away.id, date, gameId: g.id },
        });
        const h = worker.batch(m, { benched: [], activated: [] }, BROWSER_RUNS, (done, n) =>
          setRunning({ game: `${g.away.abbr} @ ${g.home.abbr}`, done, n }),
        );
        const { result } = await h.promise;
        setLocal((s) => ({
          ...s,
          [g.id]: {
            players: playersFrom(league, result, { home: g.home.abbr, away: g.away.abbr }),
            runs: result.n,
          },
        }));
      } catch {
        // Leave the game pending; the morning job will reach it.
      }
    }
    setRunning(null);
  }

  if (!def || !market) return null;
  const top = ranked[0];
  const bt = BT[league]?.[market.key];
  const shown = showAll ? ranked : ranked.slice(0, SHOW);

  return (
    <SportShell
      sport={league}
      current="props"
      eyebrow={`Diamond Edge · ${LEAGUE_NAME[league]} ${def.label}`}
      title={`${def.label}: who's most likely`}
      blurb={`Every ${SPORT_WORD[league]} on the slate is played up to 100,000 times by the site's simulator — each player's minutes, shot rates and role against tonight's opponent. A player's percentage is how often he ${market.phrase} across those plays, corrected by what last season showed those percentages really mean.`}
      date={date}
      onDateChange={(d) => {
        setDate(d);
        setLocal({});
      }}
      statBar={
        <StatBar>
          <Stat label="Games" value={`${games.length}`} />
          <Stat
            label="Plays per game"
            value={runsShown.length ? Math.min(...runsShown).toLocaleString() : "—"}
          />
          <Stat
            label="Most likely"
            value={top ? `${top.p.name.split(" ").slice(-1)[0]} ${pct(top.prob)}` : "—"}
          />
          <Stat label="Players priced" value={`${ranked.length}`} />
        </StatBar>
      }
    >
      {def.markets.length > 1 && (
        <div className="mb-6 flex flex-wrap gap-2" role="tablist" aria-label="Line">
          {def.markets.map((m) => (
            <button
              key={m.key}
              type="button"
              role="tab"
              aria-selected={m.key === market.key}
              onClick={() => setMarketKey(m.key)}
              className={`border px-4 py-2 font-mono text-[11px] uppercase tracking-widest ${
                m.key === market.key
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}

      {isLoading && <div className="h-56 animate-pulse border border-border bg-card" />}
      {data?.error && (
        <div className="border border-destructive/40 bg-destructive/10 p-5 text-sm">
          {data.error}
        </div>
      )}
      {!isLoading && !games.length && !data?.error && (
        <div className="border border-border bg-card p-6 text-sm text-muted-foreground">
          No {LEAGUE_NAME[league]} games on {date}.
        </div>
      )}

      {pending.length > 0 && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border border-primary/40 bg-primary/10 px-5 py-4 text-sm">
          <span>
            {pending.length} {pending.length === 1 ? "game hasn't" : "games haven't"} been simulated
            yet — the morning runs play each game 100,000 times around 11am Eastern.
            {running && (
              <span className="ml-2 font-mono text-xs text-muted-foreground">
                Playing {running.game}: {running.done.toLocaleString()} /{" "}
                {running.n.toLocaleString()}
              </span>
            )}
          </span>
          {!running && (
            <button
              type="button"
              onClick={() => void playHere()}
              className="border border-primary px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-primary hover:bg-primary/20"
            >
              Play them here ({BROWSER_RUNS.toLocaleString()} each)
            </button>
          )}
        </div>
      )}

      {ranked.length > 0 && (
        <section className="border border-border bg-card">
          <div className="border-b border-border px-5 py-4 sm:px-6">
            <h2 className="font-display text-2xl">
              Most likely to {market.phrase.replace(/^scores/, "score").replace(/^gets/, "get")}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Ranked by how often it happened in the simulations. The bar is the chance; the note
              underneath is what the simulator expects from him.
            </p>
          </div>
          <ol>
            {shown.map(({ p, prob }, i) => (
              <PlayerRow
                key={`${p.gameId}-${p.id}`}
                rank={i + 1}
                p={p}
                prob={prob}
                market={market}
                game={gameOf.get(p.gameId)}
              />
            ))}
          </ol>
          {ranked.length > SHOW && (
            <button
              type="button"
              onClick={() => setShowAll((s) => !s)}
              className="w-full border-t border-border px-5 py-3 font-mono text-[11px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
            >
              {showAll ? "Show the top 15" : `Show all ${ranked.length}`}
            </button>
          )}
        </section>
      )}

      <HowItWorks league={league} market={market} bt={bt} />
    </SportShell>
  );
}

function PlayerRow({
  rank,
  p,
  prob,
  market,
  game,
}: {
  rank: number;
  p: Row;
  prob: number;
  market: Market;
  game?: SimBoardGame;
}) {
  const opp = game ? (p.side === "home" ? game.away.abbr : game.home.abbr) : "";
  const at = game ? (p.side === "home" ? "vs" : "@") : "";
  const stat = market.key === "first" ? null : market.key.split(":")[0];
  const mean = stat ? p.mean[stat] : undefined;
  const note =
    market.key === "first"
      ? `scored first in ${pct(p.first, 1)} of plays`
      : stat === "pts" && mean != null
        ? `averages ${mean.toFixed(1)} ${p.mean.pts && stat === "pts" ? "points" : ""} in the simulations`
        : stat === "td" && mean != null
          ? `${mean.toFixed(2)} touchdowns a game in the simulations`
          : stat === "g" && mean != null
            ? `${mean.toFixed(2)} goals a game in the simulations`
            : "";
  return (
    <li className="grid grid-cols-[2rem_1fr_auto] items-center gap-3 border-t border-border/60 px-5 py-3 first:border-t-0 sm:px-6">
      <span className="font-mono text-sm text-primary/70">{rank}</span>
      <div className="min-w-0">
        <div className="truncate font-display text-lg leading-tight">{p.name}</div>
        <div className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          {p.team} {at} {opp}
          {game ? ` · ${when(game.start)}` : ""}
        </div>
        <div className="mt-1.5 h-2 w-full max-w-sm rounded-full bg-secondary">
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${Math.min(100, prob * 100)}%` }}
          />
        </div>
        {note && <div className="mt-1 text-xs text-muted-foreground">{note}</div>}
      </div>
      <div className="text-right font-display text-3xl leading-none">{pct(prob)}</div>
    </li>
  );
}

function HowItWorks({
  league,
  market,
  bt,
}: {
  league: SimPropsLeague;
  market: Market;
  bt?: BacktestMarket;
}) {
  const methods = bt ? Object.entries(bt.methods).sort((a, b) => a[1].brier - b[1].brier) : [];
  const runStudy = RUNS?.[league];
  const run = market.key.includes(":")
    ? runStudy?.lines[Number(market.key.split(":")[1])]
    : undefined;
  return (
    <section className="mt-10 border border-border bg-card">
      <div className="border-b border-border px-5 py-4 sm:px-6">
        <h2 className="font-display text-2xl">How these numbers are made — and how they did</h2>
      </div>
      <div className="space-y-3 px-5 py-5 text-sm text-muted-foreground sm:px-6">
        <p>
          <strong className="text-foreground">1. Play the game, many times.</strong> The simulator
          plays each game possession by possession (shift by shift in hockey, snap by snap in
          football) from every player's season numbers — blended with last season early on, and
          pulled toward the league average for anyone with little playing time — against tonight's
          opponent, with the injury report applied. It plays it up to 100,000 times.
        </p>
        <p>
          <strong className="text-foreground">2. Count.</strong> If a player {market.phrase} in
          61,000 of 100,000 plays, the simulator says 61%. With 100,000 plays that count is good to
          about a quarter of a point; the uncertainty that matters is the simulator's, not the
          counting.
        </p>
        {run && runStudy && (
          <p>
            <strong className="text-foreground">Why 100,000.</strong> We replayed {runStudy.games}{" "}
            of last season's games at 1,000, 10,000 and 100,000 plays. At 1,000 a player's number
            sat {(run.mean_abs_diff_1k * 100).toFixed(1)} points from the 100,000-play number on
            average, and {pct(1 - run.top3_same_1k)} of each game's top three changed; at 10,000 it
            sat {(run.mean_abs_diff_10k * 100).toFixed(1)} points away. The extra plays sharpen the
            numbers, not the order: the error score moved from {run.brier_1k.toFixed(4)} to{" "}
            {run.brier_100k.toFixed(4)}.
          </p>
        )}
        {market.key !== "first" ? (
          <p>
            <strong className="text-foreground">3. Correct with last season.</strong> A simulator is
            a little over-sure at the extremes — it can give a bench player 0%. So each raw
            percentage goes through a correction learned from last season: of the players it gave,
            say, 61%, how many actually did it? That map never changes the order of the list, only
            how honest its numbers are.
          </p>
        ) : (
          <p>
            <strong className="text-foreground">3. No correction needed.</strong> On last season the
            simulator's first-scorer percentages already matched how often they came in, so they are
            shown as it has them.
          </p>
        )}
      </div>

      {bt && (
        <div className="border-t border-border px-5 py-5 sm:px-6">
          <h3 className="font-display text-xl">Tested on {bt.season}</h3>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {bt.n.toLocaleString()} player-{SPORT_WORD[league]}s across {bt.games.toLocaleString()}{" "}
            games the method never saw, each priced with only what was known that morning. Every
            method below was scored on exactly the same players. The &ldquo;error score&rdquo; is
            the Brier score — the average squared miss, lower is better.
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse font-mono text-[11px]">
              <thead>
                <tr className="border-b border-border text-left uppercase tracking-widest text-muted-foreground">
                  <th className="py-2 pr-3 font-normal">Method</th>
                  <th className="py-2 pr-3 text-right font-normal">Error score</th>
                  <th className="py-2 pr-3 text-right font-normal">Ranking (AUC)</th>
                  <th className="py-2 text-right font-normal">{bt.top_unit}</th>
                </tr>
              </thead>
              <tbody>
                {methods.map(([m, v]) => (
                  <tr
                    key={m}
                    className={`border-b border-border/50 ${m === bt.chosen ? "text-foreground" : "text-muted-foreground"}`}
                  >
                    <td className="py-2 pr-3 normal-case">
                      {m === bt.chosen ? "▸ " : ""}
                      {METHOD_LABEL[m] ?? m}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{v.brier.toFixed(4)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{v.auc.toFixed(3)}</td>
                    <td className="py-2 text-right tabular-nums">
                      {pct(v.top_hit)}{" "}
                      <span className="text-muted-foreground">(said {pct(v.top_said)})</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {bt.calibration.length > 0 && (
            <div className="mt-6">
              <h4 className="mb-2 font-display text-lg">When it said X%, did X% happen?</h4>
              <CalibrationTable rows={bt.calibration} unit="players" verb="did it" />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";

import { AppShell } from "@/components/AppShell";
import { BatchResults } from "@/components/sim/BatchResults";
import {
  BATCH_SIZES,
  hideBroken,
  kickoff,
  LEAGUE_LABEL,
  MAX_BATCH,
  PLAY_VERB,
  SPORT_NAME,
  spreadText,
} from "@/components/sim/format";
import { GameViewer } from "@/components/sim/GameViewer";
import { MatchupFactors } from "@/components/sim/MatchupFactors";
import { RosterPanel } from "@/components/sim/RosterPanel";
import { SlateRunner } from "@/components/sim/SlateRunner";
import { useSimWorker } from "@/components/sim/useSimWorker";
import { addDays, todayET } from "@/lib/date";
import type { MassResult } from "@/lib/sim/aggregate";
import type { SlateEntry } from "@/lib/sim/build.server";
import { getSimMatchup, getSimSlate, getSimTeams } from "@/lib/sim/sim.functions";
import type { GameResult, SimLeague, SimMatchup, SimOverrides } from "@/lib/sim/types";

import type { SimSearch } from "./simulate-route";

/**
 * The Simulate view of a sport's section — /nfl/simulate, /nba/simulate,
 * /mlb/simulate, /nhl/simulate. One component for all four; each route file
 * only owns its URL and search params.
 *
 * Pick a game from the date's slate (or build any matchup), then play it out
 * as many times as you like — ten games or a hundred thousand — and read the
 * average box score, every player's projected line against his season, and
 * the matchup factors that moved it. Nothing is seeded from the page: every
 * run draws fresh randomness, so two runs of the same game differ by about
 * the Monte Carlo error the results report.
 */

export type { SimSearch } from "./simulate-route";

export function SimulatePage({
  league,
  search,
  onSearch,
}: {
  league: SimLeague;
  search: SimSearch;
  onSearch: (next: SimSearch) => void;
}) {
  const date = search.date ?? todayET();
  const queryClient = useQueryClient();
  const worker = useSimWorker();

  const slateFn = useServerFn(getSimSlate);
  const teamsFn = useServerFn(getSimTeams);
  const matchupFn = useServerFn(getSimMatchup);

  const slate = useQuery({
    queryKey: ["sim-slate", league, date],
    queryFn: () => slateFn({ data: { league, date } }),
    staleTime: 5 * 60_000,
  });
  const teams = useQuery({
    queryKey: ["sim-teams", league],
    queryFn: () => teamsFn({ data: { league } }),
    staleTime: 60 * 60_000,
  });

  const games = slate.data?.games ?? [];
  const selectedGame = search.game ? games.find((g) => g.id === search.game) : undefined;
  const homeId = selectedGame?.home.id ?? search.home;
  const awayId = selectedGame?.away.id ?? search.away;
  const gameId = selectedGame?.id ?? null;

  const matchupKey = (h: string, a: string, gid: string | null) =>
    ["sim-matchup", league, h, a, gid, date] as const;
  const loadMatchup = useCallback(
    (h: string, a: string, gid: string | null) =>
      queryClient.fetchQuery({
        queryKey: matchupKey(h, a, gid),
        queryFn: () => matchupFn({ data: { league, homeId: h, awayId: a, date, gameId: gid } }),
        staleTime: 30 * 60_000,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryClient, matchupFn, league, date],
  );

  const matchup = useQuery({
    queryKey: matchupKey(homeId ?? "", awayId ?? "", gameId),
    queryFn: () => matchupFn({ data: { league, homeId: homeId!, awayId: awayId!, date, gameId } }),
    enabled: !!homeId && !!awayId && homeId !== awayId && (!search.game || !!selectedGame),
    staleTime: 30 * 60_000,
    retry: 1,
  });

  const setSearch = onSearch;
  const pickGame = (g: SlateEntry) => {
    setSearch({ date, game: g.id });
    requestAnimationFrame(() =>
      document.getElementById("matchup")?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  };

  return (
    <AppShell
      sport={league}
      view="simulate"
      eyebrow={`Diamond Edge · ${LEAGUE_LABEL[league]}`}
      title={`${LEAGUE_LABEL[league]} Game Simulator`}
      blurb={`Pick a game — or build one — and play it out ${SPORT_NAME[league] === "baseball" ? "plate appearance by plate appearance" : "play by play"} from every player's season numbers and each team's tendencies on both sides of the ball. Run it ten times or a hundred thousand: you get the win probability, the average box score, and every player's projected line against his season average. Every run is fresh randomness, so results move a little from run to run — that is the simulation.`}
      date={date}
      onDateChange={(d) => setSearch({ date: d })}
      footerNote="Data · ESPN season stats, team splits, rosters & injury reports · Simulations run in your browser · Not affiliated with any league"
    >
      <section>
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <h2 className="font-display text-3xl">
            Games on{" "}
            {new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
          </h2>
          <div className="flex gap-1 font-mono text-[11px] uppercase tracking-widest">
            <button
              onClick={() => setSearch({ date: addDays(date, -1) })}
              className="border border-border px-3 py-1.5 text-muted-foreground hover:text-foreground"
            >
              ← Prev day
            </button>
            <button
              onClick={() => setSearch({ date: addDays(date, 1) })}
              className="border border-border px-3 py-1.5 text-muted-foreground hover:text-foreground"
            >
              Next day →
            </button>
          </div>
        </div>

        {slate.isLoading && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-24 animate-pulse border border-border bg-card" />
            ))}
          </div>
        )}
        {(slate.data?.error || slate.isError) && (
          <div className="border border-destructive/40 bg-destructive/10 p-4 font-mono text-sm text-destructive-foreground">
            {slate.data?.error ?? "Couldn't load the schedule. Try refreshing."}
          </div>
        )}
        {slate.isSuccess && !slate.data.error && games.length === 0 && (
          <div className="border border-border bg-card p-6">
            <div className="font-display text-2xl">
              No {LEAGUE_LABEL[league]} games on this date
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {slate.data?.next ? (
                <>
                  The next ones are on{" "}
                  <button
                    onClick={() => setSearch({ date: slate.data!.next! })}
                    className="text-primary hover:underline"
                  >
                    {new Date(`${slate.data.next}T12:00:00`).toLocaleDateString(undefined, {
                      weekday: "long",
                      month: "long",
                      day: "numeric",
                    })}{" "}
                    →
                  </button>{" "}
                  — or build any matchup you like below.
                </>
              ) : (
                "Build any matchup you like below — every team can play every other."
              )}
            </p>
          </div>
        )}
        {games.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {games.map((g) => (
              <SlateCard key={g.id} g={g} active={g.id === gameId} onPick={() => pickGame(g)} />
            ))}
          </div>
        )}

        <CustomMatchup
          league={league}
          teams={teams.data?.teams ?? []}
          home={search.game ? undefined : search.home}
          away={search.game ? undefined : search.away}
          onPick={(home, away) => {
            setSearch({ date, home, away });
            requestAnimationFrame(() =>
              document
                .getElementById("matchup")
                ?.scrollIntoView({ behavior: "smooth", block: "start" }),
            );
          }}
        />
      </section>

      <div id="matchup" className="scroll-mt-4">
        {matchup.isFetching && !matchup.data && (
          <div className="mt-10 border border-border bg-card p-8 text-center font-mono text-sm text-muted-foreground">
            Loading rosters, injury reports and two seasons of player stats… the first load of a
            league takes a few seconds.
          </div>
        )}
        {matchup.isError && (
          <div className="mt-10 border border-destructive/40 bg-destructive/10 p-4 font-mono text-sm text-destructive-foreground">
            {(matchup.error as Error).message}
          </div>
        )}
        {matchup.data && matchup.data.league === league && (
          <MatchupWorkspace
            key={`${matchup.data.home.id}-${matchup.data.away.id}-${gameId}`}
            matchup={matchup.data}
            worker={worker}
          />
        )}
      </div>

      {games.length > 1 && (
        <div className="mt-12">
          <SlateRunner
            league={league}
            games={games}
            worker={worker}
            loadMatchup={(g) => loadMatchup(g.home.id, g.away.id, g.id)}
            onOpen={pickGame}
          />
        </div>
      )}

      <Methodology league={league} />
    </AppShell>
  );
}

// ---------------------------------------------------------------- pieces

function SlateCard({ g, active, onPick }: { g: SlateEntry; active: boolean; onPick: () => void }) {
  const status = g.state === "pre" ? kickoff(g.date) : g.status;
  return (
    <button
      onClick={onPick}
      className={`group border bg-card p-4 text-left transition-colors ${active ? "border-primary" : "border-border hover:border-primary/60"}`}
      aria-pressed={active}
    >
      <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        <span className={g.state === "in" ? "text-primary" : ""}>{status}</span>
        <span>{g.playoff ? "Postseason" : g.neutral ? "Neutral site" : ""}</span>
      </div>
      <div className="mt-2 space-y-1">
        {(["away", "home"] as const).map((s) => (
          <div key={s} className="flex items-center gap-2">
            {g[s].logo && (
              <img
                src={g[s].logo}
                alt=""
                onError={hideBroken}
                className="h-5 w-5 object-contain"
                loading="lazy"
              />
            )}
            <span className="flex-1 text-sm text-foreground">{g[s].name}</span>
            {(s === "home" ? g.homeScore : g.awayScore) != null && (
              <span className="font-display text-xl tabular-nums">
                {s === "home" ? g.homeScore : g.awayScore}
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        <span>
          {g.line?.spread != null ? spreadText(g.home.abbr, g.line.spread) : ""}
          {g.line?.total != null ? ` · O/U ${g.line.total}` : ""}
        </span>
        <span className="text-primary opacity-0 transition-opacity group-hover:opacity-100">
          Simulate →
        </span>
      </div>
      {(g.probableName.away || g.probableName.home) && (
        <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
          {g.probableName.away ?? "TBD"} vs {g.probableName.home ?? "TBD"}
        </div>
      )}
    </button>
  );
}

function CustomMatchup({
  league,
  teams,
  home,
  away,
  onPick,
}: {
  league: SimLeague;
  teams: { id: string; abbr: string; name: string }[];
  home?: string;
  away?: string;
  onPick: (home: string, away: string) => void;
}) {
  const [h, setH] = useState(home ?? "");
  const [a, setA] = useState(away ?? "");
  useEffect(() => {
    setH(home ?? "");
    setA(away ?? "");
  }, [home, away, league]);
  const select = (value: string, set: (v: string) => void, label: string) => (
    <label className="flex-1">
      <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => set(e.target.value)}
        className="mt-1 block w-full border border-border bg-secondary px-2 py-2 text-sm text-foreground"
      >
        <option value="">Choose a team…</option>
        {teams.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="mt-6 border border-border bg-card p-5 sm:p-6">
      <div className="font-display text-2xl">Or build your own matchup</div>
      <p className="mt-1 text-sm text-muted-foreground">
        Any two {LEAGUE_LABEL[league]} teams, today&apos;s rosters, at the home team&apos;s
        building.
      </p>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        {select(a, setA, "Away")}
        <span className="hidden pb-2 font-display text-2xl text-muted-foreground sm:block">@</span>
        {select(h, setH, "Home")}
        <button
          disabled={!h || !a || h === a}
          onClick={() => onPick(h, a)}
          className="border border-primary bg-primary/10 px-5 py-2 font-mono text-[11px] uppercase tracking-widest text-primary hover:bg-primary/20 disabled:opacity-40"
        >
          Load matchup
        </button>
      </div>
      {h && a && h === a && (
        <p className="mt-2 font-mono text-xs text-destructive-foreground">
          A team can&apos;t play itself.
        </p>
      )}
    </div>
  );
}

function MatchupWorkspace({
  matchup,
  worker,
}: {
  matchup: SimMatchup;
  worker: ReturnType<typeof useSimWorker>;
}) {
  const [overrides, setOverrides] = useState<SimOverrides>({ benched: [], activated: [] });
  const [mode, setMode] = useState<"batch" | "watch">("batch");
  const [n, setN] = useState(1000);
  const [batch, setBatch] = useState<{ result: MassResult; partial: boolean; key: string } | null>(
    null,
  );
  const [progress, setProgress] = useState<{ done: number; n: number } | null>(null);
  const [batchId, setBatchId] = useState<number | null>(null);
  const [game, setGame] = useState<GameResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRoster, setShowRoster] = useState(false);
  const settingsKey = JSON.stringify(overrides);
  const stale = batch && batch.key !== settingsKey;
  const autoRan = useRef(false);

  const runBatch = useCallback(
    async (size: number) => {
      setError(null);
      const h = worker.batch(matchup, overrides, size, (done, total) =>
        setProgress({ done, n: total }),
      );
      setBatchId(h.id);
      setProgress({ done: 0, n: size });
      try {
        const { result, partial } = await h.promise;
        setBatch({ result, partial, key: JSON.stringify(overrides) });
      } catch (err) {
        if ((err as Error).message !== "cancelled") setError((err as Error).message);
      } finally {
        setProgress(null);
        setBatchId(null);
      }
    },
    [worker, matchup, overrides],
  );

  const play = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await worker.single(matchup, overrides);
      setGame(r.result);
      setMode("watch");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [worker, matchup, overrides]);

  // A matchup opens with a thousand games already played.
  useEffect(() => {
    if (autoRan.current) return;
    autoRan.current = true;
    void runBatch(1000);
  }, [runBatch]);

  const ctx = matchup.ctx;
  const neutral = overrides.neutral ?? ctx.neutral;
  const playoff = overrides.playoff ?? ctx.playoff;

  return (
    <div className="mt-10 space-y-6">
      {/* Header */}
      <div className="border border-border bg-card">
        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-5 py-6 sm:gap-4 sm:px-8">
          <TeamHead team={matchup.away} side="away" />
          <div className="text-center font-display text-3xl text-muted-foreground">
            {neutral ? "vs" : "@"}
          </div>
          <TeamHead team={matchup.home} side="home" />
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border px-5 py-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground sm:px-8">
          <span>{ctx.venue || "Home team's building"}</span>
          {ctx.line?.spread != null && (
            <span>{spreadText(matchup.home.abbr, ctx.line.spread)}</span>
          )}
          {ctx.line?.total != null && <span>O/U {ctx.line.total}</span>}
          {ctx.park != null && ctx.park !== 100 && <span>Park factor {ctx.park}</span>}
          <label className="flex items-center gap-1.5 normal-case tracking-normal">
            <input
              type="checkbox"
              checked={neutral}
              onChange={(e) => setOverrides({ ...overrides, neutral: e.target.checked })}
              className="accent-[var(--color-primary)]"
            />
            <span className="uppercase tracking-widest">Neutral site</span>
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={playoff}
              onChange={(e) => setOverrides({ ...overrides, playoff: e.target.checked })}
              className="accent-[var(--color-primary)]"
            />
            <span>Playoff rules</span>
          </label>
        </div>
        <div className="border-t border-border px-5 py-3 text-xs text-muted-foreground sm:px-8">
          Numbers from {ctx.basis}. Rates are regressed toward the league average by how much each
          player has actually played; players on the injury report as out start on the bench.
        </div>
      </div>

      <MatchupFactors matchup={matchup} overrides={overrides} />

      {/* Lineups */}
      <div className="border border-border bg-card">
        <button
          onClick={() => setShowRoster((s) => !s)}
          className="flex w-full items-center justify-between px-5 py-4 text-left sm:px-8"
          aria-expanded={showRoster}
        >
          <span>
            <span className="font-display text-2xl">Lineups & injuries</span>
            <span className="ml-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              sit anyone, start anyone
              {overrides.benched.length + overrides.activated.length > 0
                ? ` · ${overrides.benched.length + overrides.activated.length} changed`
                : ""}
            </span>
          </span>
          <span className="font-mono text-xs text-muted-foreground">{showRoster ? "▲" : "▼"}</span>
        </button>
        {showRoster && (
          <div className="border-t border-border">
            <RosterPanel matchup={matchup} overrides={overrides} onChange={setOverrides} />
            {(overrides.benched.length > 0 ||
              overrides.activated.length > 0 ||
              overrides.starter) && (
              <div className="border-t border-border px-5 py-3 sm:px-8">
                <button
                  onClick={() =>
                    setOverrides({
                      benched: [],
                      activated: [],
                      neutral: overrides.neutral,
                      playoff: overrides.playoff,
                    })
                  }
                  className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
                >
                  Reset to the injury report
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Mode */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex" role="tablist">
          {(
            [
              ["batch", "Simulate many"],
              ["watch", "Watch one game"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              role="tab"
              aria-selected={mode === k}
              onClick={() => {
                setMode(k);
                if (k === "watch" && !game) void play();
              }}
              className={`border px-4 py-2 font-mono text-[11px] uppercase tracking-widest ${
                mode === k
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {mode === "batch" ? (
          <RunControls
            n={n}
            setN={setN}
            running={batchId != null}
            onRun={() => void runBatch(n)}
            onStop={() => batchId != null && worker.cancel(batchId)}
          />
        ) : (
          <button
            onClick={() => void play()}
            disabled={busy}
            className="border border-primary bg-primary/10 px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-primary hover:bg-primary/20 disabled:opacity-40"
          >
            ▶ {PLAY_VERB[matchup.league]}
          </button>
        )}
      </div>

      {error && (
        <div className="border border-destructive/40 bg-destructive/10 p-4 font-mono text-sm text-destructive-foreground">
          {error}
        </div>
      )}

      {mode === "batch" && (
        <div>
          {progress && (
            <div className="mb-4 border border-border bg-card px-5 py-4">
              <div className="flex justify-between font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                <span>Simulating</span>
                <span className="tabular-nums">
                  {progress.done.toLocaleString()} / {progress.n.toLocaleString()}
                </span>
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full bg-primary transition-[width]"
                  style={{ width: `${(progress.done / Math.max(1, progress.n)) * 100}%` }}
                />
              </div>
            </div>
          )}
          {stale && !progress && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border border-primary/40 bg-primary/10 px-4 py-3 font-mono text-xs text-foreground">
              <span>Lineups or settings changed since these games were played.</span>
              <button
                onClick={() => void runBatch(n)}
                className="uppercase tracking-widest text-primary hover:underline"
              >
                Re-run →
              </button>
            </div>
          )}
          {batch && (
            <div className={progress ? "opacity-60 transition-opacity" : ""}>
              <BatchResults matchup={matchup} result={batch.result} partial={batch.partial} />
            </div>
          )}
        </div>
      )}

      {mode === "watch" && (
        <div>
          {!game && busy && <div className="h-96 animate-pulse border border-border bg-card" />}
          {game && (
            <GameViewer matchup={matchup} result={game} busy={busy} onNew={() => void play()} />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * How many games to play: the common sizes as one click, or any number up to
 * MAX_BATCH typed in. Big batches are split across the browser's cores.
 */
function RunControls({
  n,
  setN,
  running,
  onRun,
  onStop,
}: {
  n: number;
  setN: (n: number) => void;
  running: boolean;
  onRun: () => void;
  onStop: () => void;
}) {
  const [custom, setCustom] = useState("");
  const preset = BATCH_SIZES.includes(n);
  const commit = (raw: string) => {
    const v = Math.round(Number(raw.replace(/[^0-9]/g, "")));
    if (Number.isFinite(v) && v >= 1) setN(Math.min(MAX_BATCH, v));
  };
  return (
    <div className="flex w-full flex-col gap-2 sm:w-auto sm:items-end">
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Number of games">
        {BATCH_SIZES.map((v) => (
          <button
            key={v}
            onClick={() => {
              setN(v);
              setCustom("");
            }}
            disabled={running}
            aria-pressed={n === v}
            className={`border px-2.5 py-1.5 font-mono text-[11px] tabular-nums tracking-wider disabled:opacity-50 ${
              n === v
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {v.toLocaleString()}
          </button>
        ))}
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commit((e.target as HTMLInputElement).value);
              (e.target as HTMLInputElement).blur();
            }
          }}
          disabled={running}
          inputMode="numeric"
          placeholder="Custom"
          aria-label={`Custom number of games, up to ${MAX_BATCH.toLocaleString()}`}
          className={`w-24 border bg-secondary px-2 py-1.5 font-mono text-[11px] tabular-nums text-foreground outline-none focus:border-primary ${
            !preset ? "border-primary" : "border-border"
          }`}
        />
      </div>
      {running ? (
        <button
          onClick={onStop}
          className="border border-border px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
        >
          Stop
        </button>
      ) : (
        <button
          onClick={onRun}
          className="border border-primary bg-primary/10 px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-primary hover:bg-primary/20"
        >
          ▶ Simulate {n.toLocaleString()} game{n === 1 ? "" : "s"}
        </button>
      )}
    </div>
  );
}

function TeamHead({ team, side }: { team: SimMatchup["home"]; side: "home" | "away" }) {
  return (
    <div
      className={`flex min-w-0 items-center gap-4 ${side === "home" ? "flex-row-reverse text-right" : ""}`}
    >
      {team.logo && (
        <img
          src={team.logo}
          alt=""
          onError={hideBroken}
          className="hidden h-14 w-14 shrink-0 object-contain sm:block sm:h-20 sm:w-20"
        />
      )}
      <div className="min-w-0">
        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {side}
        </div>
        <div className="break-words font-display text-2xl leading-none sm:text-4xl">
          {team.name}
        </div>
        <div className="mt-1 font-mono text-[11px] text-muted-foreground">
          {team.record} · {team.pf.toFixed(1)} for · {team.pa.toFixed(1)} against
        </div>
      </div>
    </div>
  );
}

const HOW: Record<SimLeague, string[]> = {
  nba: [
    "Possession by possession. One of the five players on the floor uses each trip — a two, a three, free throws or a turnover — in proportion to how often he does each per minute.",
    "Every shot meets the defense in front of it: the shooter's own percentage combines with what that team allows on twos and on threes (by odds ratio), how often it lets opponents shoot threes, get to the line and turn it over, and how well it finishes possessions on the glass.",
    "Pace is both teams' season pace combined, so a fast team against a slow one plays near the middle and two fast teams play fast.",
    "A rotation tracks every player's minutes against his season average: starters open each half, the closers finish a close fourth, the bench mops up a blowout. Foul trouble and foul-outs are real, and minutes and shot share wobble from night to night, so a player has hot and quiet games. The second night of a back-to-back shoots a little worse.",
    "Calibrated so the league's rosters score its 115 points a team, home teams win about 55%, and the margin spreads about 13 points around its expectation — as real games do.",
  ],
  nfl: [
    "Snap by snap, with the state a broadcast shows: quarter, clock, down, distance, field position, timeouts.",
    "Each play is a run or a pass from the coaching staff's own tendency — how much more or less than expected it throws on early downs in a close game — and its tempo, bent by down, distance, score and clock. The ball goes to a player in proportion to his carries or targets.",
    "Then the defense: completion odds combine the quarterback's accuracy and the receiver's catch rate with the completion rate this defense allows; yards per catch and per carry scale by what it gives up against the league; sacks and interceptions meet its sack and pick rates. A receiver facing a soft secondary really does gain more.",
    "Fourth downs go the way the league's coaches actually decide from that distance and spot, leaning toward this head coach's own aggressiveness. Field goals by distance and kicker, punts, 2025 kickoff rules, the two-minute warning, clock-killing, onside kicks and overtime are all played out. Calibrated to the league's ~23 points and ~63 plays per team.",
    "Checked against every 2025 game: quarterbacks scramble, sneak and throw to the sticks on third down; gains shrink in the red zone; penalties are real types and yardages (holding, false starts, pass interference at the spot); teams tied late play for the win; domes add a little to the passing game. Third-down rate, drives, punts, penalties, scrambles and overtime frequency now match real games within a few percent.",
  ],
  cfb: [
    "Snap by snap, on the same engine as the NFL's, under college rules: overtime from the 25 with two-point tries required from the second period and alternating two-point plays from the third, so there are no ties; the clock stops on first downs only in the last two minutes of a half; kickoffs fair-caught or downed come out to the 25; pass interference is 15 yards at most.",
    "Players come from box scores, not a season feed: ESPN publishes no college player statistics league-wide, so every FBS game of last season and every game each team has played this season is read play by play. A transfer brings last season's numbers with him. Box scores record no targets, so a receiver's are estimated from his catches.",
    "Each defense meets the offense across from it through what opponents have done against it — completion rate, yards per catch and per carry, sacks, interceptions — and each offense plays at its own pass rate and tempo, from the option academies to the air raid.",
    "An FCS opponent plays at a discount: its numbers came against FCS teams. College kickers are shorter and less accurate than the NFL's, and the box score counts a sack as a quarterback rush, as college does.",
  ],
  nhl: [
    "Shift by shift in continuous time. The twelve forwards and six defencemen who play most dress in lines and pairs and get ice time in proportion to how much they play.",
    "While a unit is out, each skater shoots at his own per-60 rate scaled by how many shots the other team allows; a shot scores at his regressed shooting percentage scaled by how good the goalie in front of him is.",
    "Penalties follow each player's penalty rate; the power play's season conversion meets the other team's penalty kill. The trailing team presses at even strength and the leader sits back; late, the goalie comes out for an extra attacker. Offsetting minors, fights and misconducts fill out the penalty minutes as in a real box score.",
    "Regular-season ties go to three-on-three and a shootout; playoff games go to twenty-minute sudden-death periods. Calibrated to ~3.1 goals and ~28 shots per team.",
  ],
  mlb: [
    "Plate appearance by plate appearance. Each outcome — walk, strikeout, homer, triple, double, single, out — combines the batter's rate with the pitcher's by the odds-ratio method, then the park.",
    "Platoon splits: a hitter's season line is split into how he does against left- and right-handed pitching, so a lefty-heavy lineup against a lefty starter strikes out more and hits for less power. The defense's error rate sets how often an out becomes a runner.",
    "Rates regress by how fast each stabilises: strikeouts quickly, power more slowly, singles hardly at all, because balls in play are mostly luck.",
    "Runners advance the way they do in real games, with double plays, sac flies, steals and errors. Starters tire the third time through and leave on a pitch count that varies start to start; the pen is used by leverage — closer in a save spot, set-up man in the eighth. Late, the manager pinch-hits in close games, rests regulars in blowouts and sends in defensive replacements, so a team uses about ten hitters, as real ones do.",
    "Extra innings use the automatic runner in the regular season and not in October. Calibrated to the league's ~4.5 runs per team and ~53% home wins.",
  ],
};

function Methodology({ league }: { league: SimLeague }) {
  return (
    <section className="mt-12 grid gap-6 border border-border bg-card p-5 sm:p-8 md:grid-cols-2">
      <div>
        <h2 className="font-display text-3xl">
          How the {LEAGUE_LABEL[league]} engine plays a game
        </h2>
        <ul className="mt-3 space-y-3 text-sm text-muted-foreground">
          {HOW[league].map((t) => (
            <li key={t} className="flex gap-3">
              <span className="mt-2 inline-block h-1 w-3 shrink-0 bg-primary" aria-hidden />
              <span>{t}</span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h2 className="font-display text-3xl">What it can&apos;t know</h2>
        <ul className="mt-3 space-y-3 text-sm text-muted-foreground">
          <li>
            <strong className="text-foreground">Today&apos;s news.</strong> Late scratches, a
            minutes limit, wind and rain. Edit the lineups to account for what you know.
          </li>
          <li>
            <strong className="text-foreground">Matchups inside the matchup.</strong> The engines
            use each defense&apos;s season splits — against the pass, the run, threes, the power
            play — but not who guards whom: a shutdown corner on one receiver, a scheme built for
            one opponent. Position-by-position defense isn&apos;t in the public data.
          </li>
          <li>
            <strong className="text-foreground">Whether a player&apos;s season is real.</strong>{" "}
            Small samples are pulled toward the league average, which is right on average and wrong
            for the occasional genuine breakout.
          </li>
          <li>
            <strong className="text-foreground">That it isn&apos;t betting advice.</strong> The
            probabilities are the simulation&apos;s own. Where it disagrees with the market, the
            market usually knows something it doesn&apos;t.
          </li>
        </ul>
      </div>
    </section>
  );
}

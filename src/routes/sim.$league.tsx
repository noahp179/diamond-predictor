import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BatchResults } from "@/components/sim/BatchResults";
import {
  BATCH_SIZES,
  hideBroken,
  kickoff,
  LEAGUE_LABEL,
  PLAY_VERB,
  SPORT_NAME,
  spreadText,
} from "@/components/sim/format";
import { GameViewer } from "@/components/sim/GameViewer";
import { RosterPanel } from "@/components/sim/RosterPanel";
import { SimShell } from "@/components/sim/SimShell";
import { SlateRunner } from "@/components/sim/SlateRunner";
import { useSimWorker } from "@/components/sim/useSimWorker";
import { addDays, todayET } from "@/lib/date";
import type { MassResult } from "@/lib/sim/aggregate";
import type { SlateEntry } from "@/lib/sim/build.server";
import { newSeed } from "@/lib/sim/core";
import { getSimMatchup, getSimSlate, getSimTeams } from "@/lib/sim/sim.functions";
import {
  SIM_LEAGUES,
  type GameResult,
  type SimLeague,
  type SimMatchup,
  type SimOverrides,
} from "@/lib/sim/types";

type Search = { date?: string; game?: string; home?: string; away?: string };

const str = (v: unknown) => (typeof v === "string" && v.length < 24 ? v : undefined);

export const Route = createFileRoute("/sim/$league")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    date: typeof s.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.date) ? s.date : undefined,
    game: str(s.game),
    home: str(s.home),
    away: str(s.away),
  }),
  head: ({ params }) => {
    const l = (SIM_LEAGUES as string[]).includes(params.league)
      ? LEAGUE_LABEL[params.league as SimLeague]
      : "Game";
    return {
      meta: [
        { title: `${l} Game Simulator — Diamond Edge` },
        {
          name: "description",
          content: `Simulate any ${l} game play by play from real player statistics — watch one unfold or run ten thousand and see win probabilities, score distributions and every player's projected stat line.`,
        },
        { property: "og:title", content: `${l} Game Simulator — Diamond Edge` },
      ],
    };
  },
  component: SimLeaguePage,
});

function SimLeaguePage() {
  const { league: raw } = Route.useParams();
  if (!(SIM_LEAGUES as string[]).includes(raw)) {
    return (
      <SimShell title="Unknown league" blurb="The simulator covers the NFL, NBA, NHL and MLB.">
        <Link to="/sim" className="text-primary hover:underline">
          ← Back to the simulator
        </Link>
      </SimShell>
    );
  }
  return <Simulator league={raw as SimLeague} />;
}

function Simulator({ league }: { league: SimLeague }) {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
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

  const setSearch = (next: Search) =>
    navigate({ search: next, replace: false, resetScroll: false });
  const pickGame = (g: SlateEntry) => {
    setSearch({ date, game: g.id });
    requestAnimationFrame(() =>
      document.getElementById("matchup")?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  };

  return (
    <SimShell
      league={league}
      date={date}
      onDateChange={(d) => setSearch({ date: d })}
      title={`${LEAGUE_LABEL[league]} Simulator`}
      blurb={`Pick a game — or invent one — and play it out ${SPORT_NAME[league] === "baseball" ? "pitch by pitch" : "play by play"} from every player's real season numbers. Watch a single game unfold, or run thousands and read off the win probability, the score distribution and every player's projected line.`}
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
    </SimShell>
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
  const [game, setGame] = useState<{ result: GameResult; seed: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRoster, setShowRoster] = useState(false);
  const settingsKey = JSON.stringify(overrides);
  const stale = batch && batch.key !== settingsKey;
  const autoRan = useRef(false);

  const runBatch = useCallback(
    async (size: number) => {
      setError(null);
      const h = worker.batch(matchup, overrides, size, newSeed(), (done, total) =>
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

  const play = useCallback(
    async (seed: number) => {
      setBusy(true);
      setError(null);
      try {
        const r = await worker.single(matchup, overrides, seed);
        setGame({ result: r.result, seed: r.seed });
        setMode("watch");
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [worker, matchup, overrides],
  );

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
                if (k === "watch" && !game) void play(newSeed());
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
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={n}
              onChange={(e) => setN(Number(e.target.value))}
              aria-label="Number of games"
              className="border border-border bg-secondary px-2 py-2 font-mono text-xs text-foreground"
            >
              {BATCH_SIZES.map((v) => (
                <option key={v} value={v}>
                  {v.toLocaleString()} games
                </option>
              ))}
            </select>
            {batchId != null ? (
              <button
                onClick={() => worker.cancel(batchId)}
                className="border border-border px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
              >
                Stop
              </button>
            ) : (
              <button
                onClick={() => void runBatch(n)}
                className="border border-primary bg-primary/10 px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-primary hover:bg-primary/20"
              >
                ▶ Simulate {n.toLocaleString()}
              </button>
            )}
          </div>
        ) : (
          <button
            onClick={() => void play(newSeed())}
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
              <BatchResults
                matchup={matchup}
                result={batch.result}
                partial={batch.partial}
                onWatch={(seed) => void play(seed)}
              />
            </div>
          )}
        </div>
      )}

      {mode === "watch" && (
        <div>
          {!game && busy && <div className="h-96 animate-pulse border border-border bg-card" />}
          {game && (
            <GameViewer
              matchup={matchup}
              result={game.result}
              seed={game.seed}
              busy={busy}
              onReplay={() => void play(game.seed)}
              onNew={() => void play(newSeed())}
            />
          )}
        </div>
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
    "Misses become rebound battles between the offense's offensive rebounding and the defense's defensive rebounding; steals, blocks, assists and fouls are credited the same way.",
    "A rotation tracks every player's minutes against his season average: starters open each half, the closers finish a close fourth, the bench mops up a blowout. Foul trouble and foul-outs are real.",
    "Calibrated so two average teams score the league's 115 points at its pace, an average home team wins about 55%, and the margin spreads about 13 points around its expectation — as real games do.",
  ],
  nfl: [
    "Snap by snap, with the state a broadcast shows: quarter, clock, down, distance, field position, timeouts.",
    "Each play is a run or a pass from the team's own tendencies bent by the situation. The ball goes to a player in proportion to his carries or targets; yards come from his own averages against this defense.",
    "Completions combine the quarterback's accuracy with the receiver's catch rate. Sacks and interceptions are the quarterback's rates against the pass rush and secondary he faces. Touchdowns happen when a gain carries past the goal line.",
    "Fourth-down calls, field goals by distance and kicker, punts, 2025 kickoff rules, penalties, the two-minute warning, clock-killing, onside kicks and overtime are all played out. Calibrated to the league's ~23 points and ~63 plays per team.",
  ],
  nhl: [
    "Shift by shift in continuous time. The twelve forwards and six defencemen who play most dress in lines and pairs and get ice time in proportion to how much they play.",
    "While a unit is out, each skater shoots at his own per-60 rate; a shot scores at his regressed shooting percentage scaled by how good the goalie in front of him is.",
    "Penalties follow each player's penalty rate and put the best power-play producers on the ice. Trailing late, the goalie comes out for an extra attacker.",
    "Regular-season ties go to three-on-three and a shootout; playoff games go to twenty-minute sudden-death periods. Calibrated to ~3.1 goals and ~28 shots per team.",
  ],
  mlb: [
    "Plate appearance by plate appearance. Each outcome — walk, strikeout, homer, triple, double, single, out — combines the batter's rate with the pitcher's by the odds-ratio method, then the park.",
    "Rates regress by how fast each stabilises: strikeouts quickly, power more slowly, singles hardly at all, because balls in play are mostly luck.",
    "Runners advance the way they do in real games, with double plays, sac flies, steals and errors. Starters tire the third time through and leave on a pitch count; the pen is used by leverage — closer in a save spot, set-up man in the eighth.",
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
            minutes limit, weather, a back-to-back. Edit the lineups to account for what you know.
          </li>
          <li>
            <strong className="text-foreground">Matchups inside the matchup.</strong> A shutdown
            corner on a star receiver, a lefty specialist, a defensive scheme — the engines use
            season rates, not tape.
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

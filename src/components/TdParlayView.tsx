import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { SportShell, StatBar, Stat, Note } from "@/components/SportShell";
import { getTdParlays } from "@/lib/sports.functions";
import { PAIR_FACTOR } from "@/lib/td-parlay";
import { todayET } from "@/lib/date";

type Result = Awaited<ReturnType<typeof getTdParlays>>;
type Parlay = Result["parlays"][number];
type Leg = Parlay["legs"][number];

const SIZES = [5, 10, 15, 20];

/**
 * The three questions the NFL board can answer off one feature vector.
 *
 * Only anytime runs on college — the other two were fitted on NFL play-by-play
 * and NFL market lines, and college has neither feed behind them.
 *
 * Fifteen and twenty legs are absent from the narrow markets on purpose. At a
 * 3.7% base rate a fifteen-leg 2+ slip is a number with nothing attached to it,
 * and a first-touchdown slip cannot have more legs than the slate has games.
 */
const MARKETS = [
  { value: "anytime", label: "Anytime TD", blurb: "one touchdown or more" },
  { value: "td1", label: "First TD", blurb: "the game's opening touchdown" },
  { value: "td2", label: "2+ TDs", blurb: "two or more in one game" },
] as const;
type Market = (typeof MARKETS)[number]["value"];

/** 0 means unrestricted — Infinity does not survive the wire. */
const PER_GAME: { value: number; label: string }[] = [
  { value: 1, label: "1 / game" },
  { value: 2, label: "2 / game" },
  { value: 3, label: "3 / game" },
  { value: 0, label: "any" },
];

const pct = (p: number, dp = 0) => `${(p * 100).toFixed(dp)}%`;
const price = (n: number) => (n > 0 ? `+${n.toLocaleString()}` : n.toLocaleString());

/** "Sun Sep 20" — enough to tell the reader which day they are looking at. */
function dayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** "1 in 1,507,887" is the number that matters most on a long slip. */
function oneIn(n: number): string {
  if (!n) return "—";
  return `1 in ${n.toLocaleString()}`;
}

const TIER_CLASS: Record<string, string> = {
  Strong: "text-primary border-primary/50",
  Solid: "text-foreground border-border",
  Lean: "text-muted-foreground border-border",
};

function LegRow({ leg }: { leg: Leg }) {
  return (
    <div className="border-t border-border py-3 first:border-t-0">
      <div className="flex items-start gap-3">
        <span className="w-6 shrink-0 pt-1 font-mono text-sm text-primary/70 tabular-nums">
          {leg.rank}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-display text-lg leading-tight">{leg.player}</span>
            <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              {leg.team}
              {leg.position ? ` · ${leg.position}` : ""} · {leg.matchup}
            </span>
          </div>
          {/* The reasoning is read back out of the model's own coefficients, so
              it cannot drift from the number beside it. */}
          {leg.reasons.length > 0 && (
            <div className="mt-1 text-sm text-muted-foreground">{leg.reasons.join(" · ")}</div>
          )}
          {leg.against && (
            <div className="mt-0.5 font-mono text-[11px] text-clay">against: {leg.against}</div>
          )}
          {(leg.sharesGame || leg.belowFloor) && (
            <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {leg.sharesGame && "shares a game with another leg"}
              {leg.sharesGame && leg.belowFloor && " · "}
              {leg.belowFloor && "below this slip's usual bar"}
            </div>
          )}
        </div>
        <div className="shrink-0 text-right">
          <div className="font-display text-2xl leading-none">{pct(leg.prob)}</div>
          <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            to score
          </div>
        </div>
        {leg.tier && (
          <div
            className={`shrink-0 border px-2 py-1 text-center font-mono text-[10px] uppercase tracking-widest ${
              TIER_CLASS[leg.tier] ?? TIER_CLASS.Lean
            }`}
            title={
              leg.tierHit != null
                ? `${leg.tier}. Picks in this tier scored in ${pct(leg.tierHit)} of games across the held-out seasons.`
                : leg.tier
            }
          >
            <div className="text-sm leading-none">
              {leg.tierHit != null ? pct(leg.tierHit) : "—"}
            </div>
            <div className="mt-0.5">{leg.tier}</div>
          </div>
        )}
      </div>
    </div>
  );
}

export function TdParlayView({ sport }: { sport: "cfb" | "nfl" }) {
  const [date, setDate] = useState(todayET());
  const [size, setSize] = useState(5);
  const [perGame, setPerGame] = useState(2);
  const [market, setMarket] = useState<Market>("anytime");
  const run = useServerFn(getTdParlays);
  const { data, isLoading, isError } = useQuery({
    queryKey: [sport, "td-parlay", date, perGame, market],
    queryFn: () => run({ data: { sport, date, maxPerGame: perGame, market } }),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  const parlays = data?.parlays ?? [];
  // Each market offers its own sizes, and a reader who was on 20 legs when they
  // switch to a market that stops at 10 must not be left staring at a blank
  // panel — fall back to the largest size this market does offer.
  const sizes = (data?.sizes ?? SIZES) as number[];
  const activeSize = sizes.includes(size) ? size : (sizes[sizes.length - 1] ?? 5);
  const current = parlays.find((p) => p.size === activeSize);
  const evidence = (data?.evidence ?? {}) as Record<
    number,
    {
      stated: number;
      oneIn: number;
      observed?: string;
      note?: string;
      slips?: number;
      won?: number;
      expected?: number;
    }
  >;
  const evRaw = evidence[activeSize];
  // The two evidence shapes say the same thing differently: the anytime board
  // carries a written `observed`, the narrow markets carry the counts. Render
  // the counts into the same sentence rather than teaching the card two formats.
  const ev = evRaw
    ? {
        ...evRaw,
        observed:
          evRaw.observed ??
          `${evRaw.won ?? 0} of ${evRaw.slips ?? 0} held-out weeks (${(evRaw.expected ?? 0).toFixed(3)} expected)`,
      }
    : undefined;
  const heldout = data?.heldout as
    | { top1: number; games: number; base_rate: number; auc: number; ceiling?: number }
    | null
    | undefined;
  const label = sport === "cfb" ? "College Football" : "NFL";

  // Quote the correction the board is actually applying rather than a number
  // typed into this file. The two sports disagree — a college game is decided
  // by blowouts, so opposed scorers are strongly anti-correlated, while NFL
  // games stay close and the penalty is mild — and a hardcoded pair of figures
  // went stale the moment either model was replaced.
  const pair = PAIR_FACTOR[sport] ?? PAIR_FACTOR.cfb;
  const modelName =
    sport === "cfb" ? "calibrated extra-trees" : "within-game pairwise ranker";

  // The board may be showing a different day than the one asked for, because
  // football is not played on most of them.
  const shown = data?.date;
  const movedTo = shown && shown !== date ? shown : null;

  return (
    <SportShell
      sport={sport}
      current="parlay"
      eyebrow={`Diamond Edge · ${label}`}
      title="Touchdown Parlays"
      blurb={
        market === "anytime"
          ? `Five, ten, fifteen or twenty touchdown scorers on one slip, surest first, ` +
            `each with the model's probability and its reasons. Stack as many legs from ` +
            `one game as you like — the quoted chance is corrected for it rather than ` +
            `assuming the legs are independent, because two opposed players in the same ` +
            `game score together only ${pair.opposed.toFixed(2)}× as often as the plain ` +
            `product implies, and two on the same team ${pair.sameTeam.toFixed(2)}×.`
          : market === "td1"
            ? `Five or ten players to score their game's FIRST touchdown. One leg per ` +
              `game, and that is arithmetic rather than caution: exactly one player ` +
              `opens a game's scoring, so two legs from one game could never both win. ` +
              `About one first touchdown in twenty goes to a defender or a returner, ` +
              `which no pick here could have been, and every number below already ` +
              `carries that.`
            : `Five or ten players to score TWICE OR MORE in their game. A rare thing — ` +
              `it happens to about one candidate in twenty-seven — and the board is ` +
              `better at ranking it than at being confident about it. Read the ` +
              `backtest line under each slip before the price.`
      }
      date={date}
      onDateChange={setDate}
      footerNote={`Data · ESPN · ${market === "anytime" ? modelName : "L2 logistic"} on season usage · ${MARKETS.find((m) => m.value === market)?.label} · Not affiliated with ${sport === "cfb" ? "college football or the NCAA" : "the NFL"}`}
      statBar={
        <StatBar>
          <Stat label="Slip" value={`${current?.legs.length ?? 0} legs`} />
          <Stat label="All legs hit" value={current ? oneIn(current.oneIn) : "—"} />
          <Stat label="Fair price" value={current?.legs.length ? price(current.fairPrice) : "—"} />
          <Stat label="Mean leg" value={current?.legs.length ? pct(current.meanLeg, 1) : "—"} />
        </StatBar>
      }
    >
      {isLoading && <div className="h-64 animate-pulse border border-border bg-card" />}
      {isError && (
        <div className="border border-destructive/40 bg-destructive/10 p-6 font-mono text-sm text-destructive-foreground">
          Failed to build the parlays. The ESPN scoreboard may be unreachable.
        </div>
      )}
      {!isLoading && !isError && data?.note && <Note>{data.note}</Note>}

      {/* Moving the reader to a playable day is only acceptable if the page
          says so. Silently showing Sunday's slip under Tuesday's date would
          trade one confusing board for a misleading one. */}
      {!isLoading && !isError && movedTo && (
        <Note>
          No {sport === "cfb" ? "college" : "NFL"} games left to build from on{" "}
          {dayLabel(date)} — showing <span className="text-foreground">{dayLabel(movedTo)}</span>,
          the next slate that can fill a slip. Pick a date above to override.
        </Note>
      )}

      {!isLoading && !isError && data?.thin && (data?.games ?? 0) > 0 && (
        <Note>
          {dayLabel(shown ?? date)} carries {data?.games} game
          {data?.games === 1 ? "" : "s"}, which is the fullest slate in the week ahead but not
          enough for every size at this cap — the longer slips reach further down the board or
          double up to fill.
        </Note>
      )}

      {/* Which question the board is answering. NFL only — the narrow markets
          were fitted on NFL play-by-play and NFL market lines. */}
      {sport === "nfl" && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="mr-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Market
          </span>
          {MARKETS.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => setMarket(m.value)}
              aria-pressed={market === m.value}
              title={m.blurb}
              className={`border px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest transition-colors ${
                market === m.value
                  ? "border-primary text-primary"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}

      {/* What the market being shown actually did on seasons it was not fitted
          on. The narrow markets are long shots and the headline number should
          not be the price. */}
      {!isLoading && !isError && heldout && (
        <div className="mb-4 border border-border bg-card px-4 py-3 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          Held out ({heldout.games} games): top pick right{" "}
          <span className="text-foreground">{pct(heldout.top1, 1)}</span> of the time, against a{" "}
          {pct(heldout.base_rate, 1)} base rate
          {heldout.ceiling != null && (
            <>
              {" "}
              and a {pct(heldout.ceiling, 1)} ceiling — the rest of the time the first score
              came off a defender or a returner
            </>
          )}
          .
        </div>
      )}

      {!isLoading && !isError && parlays.length > 0 && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {sizes.map((s) => {
              const p = parlays.find((x) => x.size === s);
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSize(s)}
                  aria-pressed={activeSize === s}
                  className={`border px-4 py-2 font-mono text-[11px] uppercase tracking-widest transition-colors ${
                    activeSize === s
                      ? "border-primary text-primary"
                      : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {s} legs
                  <span className="ml-2 text-[10px] opacity-70">
                    {p?.legs.length ? oneIn(p.oneIn) : "—"}
                  </span>
                </button>
              );
            })}
          </div>

          {/* How much of one game a slip may take is the reader's call; the
              quoted chance is corrected for whatever they pick.

              Except on first touchdown, where it is not a choice. Exactly one
              player opens a game's scoring, so a second leg from the same game
              could never also win — that is a slip that cannot be built, not a
              correlated one to price, and offering the control would be
              offering a setting that silently does nothing. */}
          {market === "td1" ? (
            <div className="mb-6 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              One leg per game · only one player scores a game's first touchdown, so a
              second leg from the same game could never also land
            </div>
          ) : (
            <div className="mb-6 flex flex-wrap items-center gap-2">
              <span className="mr-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Legs from one game
              </span>
              {PER_GAME.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => setPerGame(o.value)}
                  aria-pressed={perGame === o.value}
                  className={`border px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest transition-colors ${
                    perGame === o.value
                      ? "border-primary text-primary"
                      : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}

          {/* The long slips are lottery tickets and the page says so in the
              same breath as it offers them. */}
          {current && current.legs.length > 0 && (
            <div className="mb-6 border border-border bg-card px-4 py-3">
              <div className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                All {current.legs.length} legs hit{" "}
                <span className="text-foreground">{oneIn(current.oneIn)}</span>
                {current.correlationFactor < 0.999 ? (
                  <>
                    {" "}
                    — the plain product says {pct(current.combinedProb, 3)}, corrected to{" "}
                    {pct(current.adjustedProb, 3)} because{" "}
                    {[
                      current.stackedPairs.opposed > 0 &&
                        `${current.stackedPairs.opposed} opposed pair${current.stackedPairs.opposed === 1 ? "" : "s"}`,
                      current.stackedPairs.sameTeam > 0 &&
                        `${current.stackedPairs.sameTeam} same-team pair${current.stackedPairs.sameTeam === 1 ? "" : "s"}`,
                    ]
                      .filter(Boolean)
                      .join(" and ")}{" "}
                    share a game (×{current.correlationFactor.toFixed(2)}).
                  </>
                ) : (
                  " — no two legs share a game, so the plain product needs no correction."
                )}
              </div>
              {current.extrapolated && (
                <div className="mt-2 font-mono text-[11px] uppercase tracking-widest text-clay">
                  {current.stackedPairs.opposed} opposed pairs is past where that correction was
                  checked — it was measured on slips carrying under one. Treat this slip's number as
                  an estimate of an estimate.
                </div>
              )}
              {ev && (
                <div className="mt-2 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                  Backtest at this size:{" "}
                  <span className="text-foreground">{pct(ev.stated, 4)}</span> stated ·{" "}
                  {ev.observed}
                  {ev.note ? ` · ${ev.note}` : ""}
                </div>
              )}
              {/* A slip this long shot never won in the backtest because it was
                  never expected to. Saying so is the difference between evidence
                  of failure and no evidence at all. */}
              {ev && (ev.expected ?? 1) < 1 && (ev.won ?? 0) === 0 && (
                <div className="mt-1 font-mono text-[11px] uppercase tracking-widest text-clay">
                  Zero wins here is not a verdict — over {ev.slips ?? 0} held-out weeks this
                  slip was expected to land {(ev.expected ?? 0).toFixed(3)} times. The backtest
                  cannot tell you whether the price is right at this length.
                </div>
              )}
              {(current.doubledUp > 0 || current.belowFloor > 0 || current.short) && (
                <div className="mt-2 font-mono text-[11px] uppercase tracking-widest text-clay">
                  {current.short && `Only ${current.legs.length} legs available. `}
                  {current.doubledUp > 0 &&
                    `${current.doubledUp} game${current.doubledUp === 1 ? "" : "s"} contribute more than one leg, out of ${current.gamesAvailable} on the slate. `}
                  {current.belowFloor > 0 &&
                    `${current.belowFloor} leg${current.belowFloor === 1 ? "" : "s"} below this slip's usual bar of ${pct(current.floor)}.`}
                </div>
              )}
            </div>
          )}

          {current && current.legs.length > 0 ? (
            <div className="border border-border bg-card p-5">
              {current.legs.map((l) => (
                <LegRow key={l.playerId} leg={l} />
              ))}
            </div>
          ) : (
            <div className="border border-border bg-card p-10 text-center">
              <div className="font-display text-3xl">No slip to build</div>
              <p className="mt-2 font-mono text-sm text-muted-foreground">
                A parlay needs upcoming games with picks. Pick a{" "}
                {sport === "cfb" ? "Saturday" : "Sunday"} in season.
              </p>
            </div>
          )}
        </>
      )}

      {!isLoading && !isError && parlays.length === 0 && !data?.note && (
        <div className="border border-border bg-card p-10 text-center">
          <div className="font-display text-3xl">No games to build from</div>
          <p className="mt-2 font-mono text-sm text-muted-foreground">
            Legs are only drawn from games that have not kicked off.
          </p>
        </div>
      )}
    </SportShell>
  );
}

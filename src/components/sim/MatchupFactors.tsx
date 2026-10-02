import { mlbPlan } from "@/lib/sim/mlb";
import type { SimLeague, SimMatchup, SimOverrides, Tendency, TeamInfo } from "@/lib/sim/types";

import { AWAY_COLOR, HOME_COLOR } from "./format";

/**
 * Matchup factors: the team-level numbers the engine reads for this game, so
 * the "why" behind a projection is on the page. Each row is one side's season
 * figure (regressed toward the league by sample size), the league's, and what
 * it does to the offense on the other side — "+6% yards per catch" — in the
 * engine's own terms: odds multipliers for rates, ratios for amounts.
 */

type Kind = "ratio" | "odds" | "notOdds" | "notRatio";

interface Factor {
  key: string;
  /** Whose number it is: the defense's, or the offense's own. */
  from: "def" | "off";
  /** What it changes for the offense. */
  what: string;
  kind: Kind;
  /** Does an increase help the offense? null for pure style (pace). */
  upHelps: boolean | null;
}

const FACTORS: Record<SimLeague, Factor[]> = {
  nfl: [
    { key: "defCmp", from: "def", what: "completion odds", kind: "odds", upHelps: true },
    { key: "defYpc", from: "def", what: "yards per catch", kind: "ratio", upHelps: true },
    { key: "defYpcRush", from: "def", what: "yards per carry", kind: "ratio", upHelps: true },
    { key: "defSack", from: "def", what: "sack odds", kind: "odds", upHelps: false },
    { key: "defInt", from: "def", what: "interceptions", kind: "ratio", upHelps: false },
    { key: "neutralPass", from: "off", what: "early-down passes", kind: "ratio", upHelps: null },
    { key: "pace", from: "off", what: "plays", kind: "ratio", upHelps: null },
    { key: "fourthGo", from: "off", what: "go-for-it calls", kind: "odds", upHelps: null },
  ],
  nba: [
    { key: "defOpp2p", from: "def", what: "2-point make odds", kind: "odds", upHelps: true },
    { key: "defOpp3p", from: "def", what: "3-point make odds", kind: "odds", upHelps: true },
    {
      key: "defOpp3aRate",
      from: "def",
      what: "odds a shot is a three",
      kind: "odds",
      upHelps: null,
    },
    { key: "defOppFtRate", from: "def", what: "free-throw trips", kind: "ratio", upHelps: true },
    { key: "defForcedTov", from: "def", what: "turnovers", kind: "ratio", upHelps: false },
    { key: "defDreb", from: "def", what: "offensive-rebound odds", kind: "notOdds", upHelps: true },
    { key: "pace", from: "off", what: "possessions", kind: "ratio", upHelps: null },
  ],
  nhl: [
    { key: "shotsAgainst", from: "def", what: "shots on goal", kind: "ratio", upHelps: true },
    { key: "ppPct", from: "off", what: "power-play scoring", kind: "ratio", upHelps: true },
    {
      key: "pkPct",
      from: "def",
      what: "power-play goals allowed",
      kind: "notRatio",
      upHelps: true,
    },
  ],
  mlb: [{ key: "errors", from: "def", what: "reached on error", kind: "ratio", upHelps: true }],
};

const odds = (p: number) => p / Math.max(1e-9, 1 - p);

function effect(t: Tendency, kind: Kind): number {
  const v = t.value;
  const lg = t.league;
  switch (kind) {
    case "ratio":
      return v / Math.max(1e-9, lg) - 1;
    case "odds":
      return odds(v) / Math.max(1e-9, odds(lg)) - 1;
    case "notOdds":
      return odds(1 - v) / Math.max(1e-9, odds(1 - lg)) - 1;
    case "notRatio":
      return (1 - v) / Math.max(1e-9, 1 - lg) - 1;
  }
}

function fmtT(t: Tendency, v: number): string {
  return t.fmt === "pct" ? `${(v * 100).toFixed(1)}%` : v.toFixed(t.fmt);
}

const signedPct = (x: number) => {
  const r = Math.round(x * 100);
  return `${r > 0 ? "+" : r < 0 ? "−" : "±"}${Math.abs(r)}%`;
};

export function MatchupFactors({
  matchup,
  overrides,
}: {
  matchup: SimMatchup;
  overrides: SimOverrides;
}) {
  const factors = FACTORS[matchup.league];
  const any = factors.some((f) => matchup.home.tend?.[f.key] || matchup.away.tend?.[f.key]);
  const platoon = matchup.league === "mlb" ? mlbPlatoon(matchup, overrides) : null;
  if (!any && !platoon) return null;
  return (
    <section className="border border-border bg-card">
      <div className="border-b border-border px-5 py-4 sm:px-8">
        <h3 className="font-display text-2xl">Matchup factors</h3>
        <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
          The team numbers this game is played with, on top of every player&apos;s own rates. Each
          row is a season figure — pulled toward the league average by how much it has been played —
          next to the league&apos;s, and what it does to the offense facing it.{" "}
          {LEAGUE_NOTE[matchup.league]}
        </p>
      </div>
      <div className="grid gap-px bg-border md:grid-cols-2">
        <Direction
          off={matchup.away}
          def={matchup.home}
          offColor={AWAY_COLOR}
          defColor={HOME_COLOR}
          factors={factors}
          extra={platoon?.away}
        />
        <Direction
          off={matchup.home}
          def={matchup.away}
          offColor={HOME_COLOR}
          defColor={AWAY_COLOR}
          factors={factors}
          extra={platoon?.home}
        />
      </div>
    </section>
  );
}

const LEAGUE_NOTE: Record<SimLeague, string> = {
  nfl: "Completion, sack and interception rates combine with the quarterback's and receivers' own by odds ratio; yardage scales each ball-carrier's and receiver's own average. Pass rate (in neutral game states, so a team that trailed a lot doesn't look pass-happy), tempo and the head coach's fourth-down aggressiveness are the offense's own choices; a fourth-down call starts from what the league's coaches did from the same spot.",
  nba: "Make probabilities combine with each shooter's own by odds ratio; trips, turnovers and rebounds scale each player's rates. Pace is both teams' combined.",
  nhl: "Shots scale each skater's own shot rate; the power play's conversion meets the penalty kill's, split between them. The goalie in net is each skater's other opponent.",
  mlb: "Most of baseball's matchup is batter against pitcher, played out plate appearance by plate appearance — including which hand each throws and hits with. The defense adds its error rate.",
};

function Direction({
  off,
  def,
  offColor,
  defColor,
  factors,
  extra,
}: {
  off: TeamInfo;
  def: TeamInfo;
  offColor: string;
  defColor: string;
  factors: Factor[];
  extra?: { label: string; detail: string };
}) {
  const rows = factors
    .map((f) => {
      const t = (f.from === "def" ? def : off).tend?.[f.key];
      return t ? { f, t, e: effect(t, f.kind) } : null;
    })
    .filter((r): r is { f: Factor; t: Tendency; e: number } => !!r);
  return (
    <div className="bg-card px-5 py-4 sm:px-8">
      <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: offColor }} />
        <span className="text-foreground">{off.abbr} offense</span>
        <span>vs</span>
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: defColor }} />
        <span className="text-foreground">{def.abbr} defense</span>
      </div>
      {/* A grid rather than a table so a phone can put the label on its own
          line and the numbers under it. */}
      <div className="font-mono text-[11px] tabular-nums" role="table">
        <div
          role="row"
          className="grid grid-cols-[3.5rem_3.5rem_minmax(0,1fr)] gap-x-2 py-1 text-muted-foreground sm:grid-cols-[minmax(0,1fr)_3.5rem_3.5rem_auto]"
        >
          <span role="columnheader" className="hidden sm:block">
            Season figure
          </span>
          <span role="columnheader" className="text-right">
            Team
          </span>
          <span role="columnheader" className="text-right">
            Lg
          </span>
          <span role="columnheader" className="text-right">
            Effect on {off.abbr}
          </span>
        </div>
        {rows.map(({ f, t, e }) => {
          const helps = f.upHelps == null ? null : e > 0 === f.upHelps;
          const color =
            helps == null || Math.abs(e) < 0.005
              ? "var(--color-muted-foreground)"
              : helps
                ? offColor
                : defColor;
          const owner = f.from === "def" ? def.abbr : off.abbr;
          return (
            <div
              key={f.key}
              role="row"
              className="grid grid-cols-[3.5rem_3.5rem_minmax(0,1fr)] items-start gap-x-2 border-t border-border/40 py-1.5 sm:grid-cols-[minmax(0,1fr)_3.5rem_3.5rem_auto]"
            >
              <span role="cell" className="col-span-3 pb-0.5 text-muted-foreground sm:col-span-1">
                <span className="text-foreground/90">{owner}</span>{" "}
                {t.label.charAt(0).toLowerCase() + t.label.slice(1)}
              </span>
              <span
                role="cell"
                className="text-right text-foreground"
                title={`Before regression: ${fmtT(t, t.raw)}`}
              >
                {fmtT(t, t.value)}
              </span>
              <span role="cell" className="text-right text-muted-foreground">
                {fmtT(t, t.league)}
              </span>
              <span role="cell" className="flex items-start justify-end gap-2 text-right">
                <EffectBar e={e} color={color} />
                <span className="text-foreground">
                  {signedPct(e)} <span className="text-muted-foreground">{f.what}</span>
                </span>
              </span>
            </div>
          );
        })}
        {extra && (
          <div
            role="row"
            className="border-t border-border/40 py-1.5 sm:flex sm:justify-between sm:gap-3"
          >
            <div role="cell" className="text-muted-foreground">
              {extra.label}
            </div>
            <div role="cell" className="text-foreground sm:text-right">
              {extra.detail}
            </div>
          </div>
        )}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        <span style={{ color: offColor }}>■</span> helps {off.abbr}&apos;s offense ·{" "}
        <span style={{ color: defColor }}>■</span> helps {def.abbr}&apos;s defense
      </p>
    </div>
  );
}

/** A small centred bar: right of centre is up, left is down, up to ±20%. */
function EffectBar({ e, color }: { e: number; color: string }) {
  const w = Math.min(1, Math.abs(e) / 0.2) * 24;
  return (
    <svg width="52" height="8" viewBox="0 0 52 8" aria-hidden className="mt-1 shrink-0">
      <line x1="26" x2="26" y1="0" y2="8" stroke="var(--color-border)" strokeWidth="1" />
      {w > 0.5 && (
        <rect x={e >= 0 ? 27 : 25 - w} y="1.5" width={w} height="5" rx="1.5" fill={color} />
      )}
    </svg>
  );
}

/** Lineup handedness against the probable starter, from the engine's plan. */
function mlbPlatoon(
  m: SimMatchup,
  o: SimOverrides,
): { home: { label: string; detail: string }; away: { label: string; detail: string } } | null {
  if (m.league !== "mlb") return null;
  const plan = mlbPlan(m, o);
  const side = (bat: "home" | "away") => {
    const k = bat === "home" ? 0 : 1;
    const opp = bat === "home" ? 1 : 0;
    const pitchSide = bat === "home" ? "away" : "home";
    const order = plan[k].order.map((i) => m[bat].batters[i]).filter(Boolean);
    const sp = plan[opp].starter >= 0 ? m[pitchSide].pitchers[plan[opp].starter] : null;
    const L = order.filter((b) => b.bats === "L").length;
    const R = order.filter((b) => b.bats === "R").length;
    const S = order.filter((b) => b.bats === "S").length;
    const mix = `${L} L · ${R} R${S ? ` · ${S} switch` : ""}`;
    if (!sp)
      return {
        label: `${m[bat].abbr} lineup handedness`,
        detail: `${mix} — starter drawn from the rotation each game`,
      };
    const adv = order.filter((b) => b.bats === "S" || b.bats !== sp.throws).length;
    return {
      label: `${m[bat].abbr} lineup vs ${sp.short} (${sp.throws}HP)`,
      detail: `${mix} — ${adv} of ${order.length} with the platoon edge`,
    };
  };
  return { home: side("home"), away: side("away") };
}

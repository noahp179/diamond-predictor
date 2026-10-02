/**
 * types.ts — the contract between the simulator's data layer and its engines.
 *
 * The server builds a `SimMatchup` out of ESPN's season stats (see
 * data.server.ts); the browser hands it to an engine in a Web Worker and plays
 * games out of it. Everything in here is plain JSON so it crosses both of those
 * boundaries untouched.
 *
 * Rates are already regressed toward the league when they arrive. The engines
 * never see a raw 3-for-3 and believe it: a player with three attempts carries
 * a percentage that is mostly the league's, and one with eight hundred carries
 * his own. Doing that once, on the server, keeps four engines from each having
 * their own idea of what "small sample" means.
 */

export type SimLeague = "nfl" | "nba" | "nhl" | "mlb";

export const SIM_LEAGUES: SimLeague[] = ["nfl", "nba", "nhl", "mlb"];

export type Side = "home" | "away";

/** Availability as the injury report has it. "out" players start benched. */
export type Availability = "active" | "questionable" | "out";

export interface BasePlayer {
  id: string;
  name: string;
  /** "L. James" — what the play-by-play uses. */
  short: string;
  pos: string;
  jersey: string;
  status: Availability;
  /** The injury report's own words, when there is one. */
  injury?: string;
  /** Games the rates rest on, after weighting last season. */
  sample: number;
  /** Season per-game averages (seasons blended, not regressed), keyed like
   *  the projections in props.ts — what the player usually does, for
   *  comparing with what the simulation expects in this game. */
  avg?: Record<string, number>;
}

/**
 * One team tendency — an offensive habit or a defensive weakness — as the
 * engines use it and as the page explains it.
 *
 * `value` is regressed toward the league by how many games stand behind it;
 * `raw` is the season figure as it stands. The engines read `value` against
 * `league`; the matchup panel shows all three.
 */
export interface Tendency {
  label: string;
  value: number;
  raw: number;
  league: number;
  /** How to print it: a percentage, or a number with this many decimals. */
  fmt: "pct" | 0 | 1 | 2 | 3;
  /** Which way is good for the team that owns it: "high" (more is better for
   *  them), "low" (less is better — e.g. yards allowed), or "style" (neither:
   *  pace, pass rate). */
  good: "high" | "low" | "style";
}

export interface TeamInfo {
  id: string;
  abbr: string;
  name: string;
  /** "Los Angeles" — for the scoreboard. */
  location: string;
  color: string;
  altColor: string;
  logo: string;
  record: string;
  /** Points (runs, goals) scored and allowed per game, seasons blended. */
  pf: number;
  pa: number;
  /** Offensive and defensive tendencies from the team's season (see
   *  Tendency). Keys are per league; build.server.ts documents them. */
  tend: Record<string, Tendency>;
}

// ------------------------------------------------------------------- NBA

export interface NbaPlayer extends BasePlayer {
  /** Minutes per game. */
  mpg: number;
  /** Per-minute rates. */
  fg2a: number;
  fg3a: number;
  fta: number;
  oreb: number;
  dreb: number;
  ast: number;
  stl: number;
  blk: number;
  tov: number;
  pf: number;
  /** Shooting percentages, regressed. */
  fg2p: number;
  fg3p: number;
  ftp: number;
}

export interface NbaTeam extends TeamInfo {
  players: NbaPlayer[];
}

export interface NbaEnv {
  ppg: number;
  /** Possessions per team per 48 minutes. */
  pace: number;
  fg2p: number;
  fg3p: number;
  ftp: number;
  /** Per-minute league rates for one player-minute. */
  stl: number;
  blk: number;
  ast: number;
  pf: number;
}

// ------------------------------------------------------------------- NHL

export interface NhlSkater extends BasePlayer {
  kind: "F" | "D";
  /** Seconds of ice time per game. */
  toi: number;
  /** Per-60-minute rates. */
  sog60: number;
  a60: number;
  pim60: number;
  /** Power-play points per game — who goes out on PP1. */
  ppPts: number;
  /** Shooting percentage, regressed. */
  shPct: number;
  /** Faceoffs taken per 60 and the share won. */
  fo60: number;
  foPct: number;
}

export interface NhlGoalie extends BasePlayer {
  kind: "G";
  svPct: number;
  starts: number;
}

export interface NhlTeam extends TeamInfo {
  skaters: NhlSkater[];
  goalies: NhlGoalie[];
  /** The listed probable goalie, when the scoreboard names one. */
  probable?: string;
  /** Shots this team allows relative to the league, regressed (1 = average). */
  shotSuppression: number;
}

export interface NhlEnv {
  gpg: number;
  sogPerGame: number;
  svPct: number;
  shPct: number;
}

// ------------------------------------------------------------------- MLB

/** Per-PA (batters) or per-batter-faced (pitchers) event rates. */
export interface PaRates {
  bb: number;
  so: number;
  hr: number;
  b3: number;
  b2: number;
  b1: number;
}

export type Hand = "L" | "R" | "S";

export interface MlbBatter extends BasePlayer {
  kind: "B";
  /** Bats: left, right or switch. */
  bats: Hand;
  pa: number;
  rates: PaRates;
  /** Stolen-base attempts per time on first with second open. */
  sbAttempt: number;
  ops: number;
  obp: number;
}

export interface MlbPitcher extends BasePlayer {
  kind: "P";
  throws: "L" | "R";
  bf: number;
  rates: PaRates;
  starts: number;
  /** Batters faced per start, for the starter's leash. */
  bfPerStart: number;
  saves: number;
  holds: number;
  era: number;
  ip: number;
}

export interface MlbTeam extends TeamInfo {
  batters: MlbBatter[];
  pitchers: MlbPitcher[];
  /** The listed probable starter, when the scoreboard names one. */
  probable?: string;
}

export interface MlbEnv {
  rpg: number;
  /** League rates per plate appearance, from the batting lines. */
  rates: PaRates;
  /** The same, from the pitching lines (batters faced is estimated). */
  pRates: PaRates;
}

// ------------------------------------------------------------------- NFL

export interface NflPlayer extends BasePlayer {
  unit: "off" | "def" | "st";
  // passing, per attempt
  passAtt: number; // attempts per game played
  cmpPct: number;
  ypc: number; // yards per completion
  passTd: number; // per attempt
  intRate: number; // per attempt
  sackRate: number; // per dropback
  // rushing
  carries: number; // per game played
  ypc_r: number; // yards per carry
  rushTd: number; // per carry
  fumble: number; // fumbles lost per touch
  // receiving
  targets: number; // per game played
  catchRate: number;
  ypr: number;
  recTd: number; // per target
  // kicking
  /** Field-goal skill: makes over what the league makes from the same
   *  distances, regressed. 1 = league average. */
  fgSkill: number;
  xpPct: number;
  longFg: number;
  // punting
  puntNet: number;
  // defense, per game played
  tackles: number;
  sacks: number;
  ints: number;
}

export interface NflTeam extends TeamInfo {
  players: NflPlayer[];
  /** Share of offensive plays that are designed passes (incl. sacks). */
  passRate: number;
  /** The head coach's fourth-down go rate above (or below) the league's from
   *  the same spots, regressed; 0 when unknown. */
  goAggr?: number;
}

export interface NflEnv {
  ppg: number;
  cmpPct: number;
  ypc: number;
  ypcRush: number;
  intRate: number;
  sackRate: number;
  passTd: number;
}

// ------------------------------------------------------------- the matchup

export interface MarketLine {
  provider: string;
  /** Home spread (negative = home favoured). */
  spread: number | null;
  total: number | null;
  homeMl: number | null;
  awayMl: number | null;
}

export interface MatchupContext {
  gameId: string | null;
  date: string;
  venue: string;
  neutral: boolean;
  /** Postseason rules: no ties, no shootouts, no ghost runner. */
  playoff: boolean;
  line: MarketLine | null;
  /** Human-readable account of which seasons the numbers came from. */
  basis: string;
  /** MLB park factor, 100 = neutral. */
  park?: number;
}

export type SimMatchup =
  | { league: "nba"; home: NbaTeam; away: NbaTeam; env: NbaEnv; ctx: MatchupContext }
  | { league: "nhl"; home: NhlTeam; away: NhlTeam; env: NhlEnv; ctx: MatchupContext }
  | { league: "mlb"; home: MlbTeam; away: MlbTeam; env: MlbEnv; ctx: MatchupContext }
  | { league: "nfl"; home: NflTeam; away: NflTeam; env: NflEnv; ctx: MatchupContext };

/**
 * What the user changed before pressing play: who sits, who starts. Kept apart
 * from the matchup so the same server payload serves every what-if.
 */
export interface SimOverrides {
  /** Player ids benched (on top of, or instead of, the injury report). */
  benched: string[];
  /** Player ids forced active even though the report has them out. */
  activated: string[];
  /** Starting pitcher / goalie / quarterback, per side. */
  starter?: Partial<Record<Side, string>>;
  /** Override the matchup's playoff flag. */
  playoff?: boolean;
  /** Override neutral site. */
  neutral?: boolean;
}

// --------------------------------------------------------------- results

/**
 * A box-score delta: [side (0 home, 1 away), player index, stat index, amount].
 * Events carry these so the viewer can rebuild the box score at any moment of
 * a replay without the engine snapshotting it two hundred times.
 */
export type StatDelta = [number, number, number, number];

export interface PlayEvent {
  /** Period: inning, quarter, period. OT continues the count. */
  period: number;
  /** "7:42" / "Top 3rd" — whatever the sport shows. */
  clock: string;
  side: Side | null;
  text: string;
  scoring?: boolean;
  /** Visual weight: big plays get the highlight treatment. */
  big?: boolean;
  home: number;
  away: number;
  /** Sport-specific situation the scoreboard shows (bases, down & distance). */
  sit?: string;
  /** NFL ball position, 0-100 from the home goal line, for the field strip. */
  ball?: number;
  /** MLB base state bitmask and outs. */
  bases?: number;
  outs?: number;
  deltas?: StatDelta[];
}

export interface GameResult {
  home: number;
  away: number;
  /** Per-period scoring, home and away. */
  periods: { home: number[]; away: number[] };
  /** Reached overtime / extra innings. */
  ot: boolean;
  /** NHL shootout. */
  so?: boolean;
  tie: boolean;
  /** Box score: per side, per player (same order as the roster), stat vector. */
  box: { home: number[][]; away: number[][] };
  /** Team-level extras (hits & errors in MLB, shots in NHL, yards in NFL). */
  team: { home: Record<string, number>; away: Record<string, number> };
  events?: PlayEvent[];
  /** Final status line: "Final", "Final/OT", "Final/11". */
  status: string;
}

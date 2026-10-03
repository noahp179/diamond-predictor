/**
 * cfb-box.ts — one college football box score, read into player stat lines.
 *
 * ESPN's league-wide player feed (statistics/byathlete), which the other four
 * leagues are built on, returns games played and nothing else for college
 * football. The game summaries are complete, so college player lines are built
 * from them instead: the box score for passing, rushing, receiving, defense
 * and kicking, and the play-by-play for what the box leaves out — sacks taken
 * by each passer, field-goal distances, and net punting.
 *
 * The lines come out keyed exactly as the byathlete feed keys them
 * ("passing.passingAttempts", "rushing.rushingYards", …) so the NFL player
 * builder reads them unchanged.
 *
 * College box scores count a sack as a quarterback rush for the yards lost
 * (and passing yards are not reduced by it). The lines keep that convention,
 * as ESPN's own season totals do, and record the sacks separately so the
 * builder can take them back out of a quarterback's running.
 *
 * Pure: no I/O, so the offline 2025 build (scripts/build-cfb-players.ts) and
 * the live current-season loader share it.
 */

export type CfbLine = { name: string; s: Record<string, number> };

export type CfbTeamGame = {
  teamId: string;
  players: Map<string, CfbLine>;
};

export type CfbGame = {
  id: string;
  season: number;
  /** 2 regular season, 3 postseason. */
  seasonType: number;
  completed: boolean;
  teams: CfbTeamGame[];
};

type Athlete = { athlete?: { id?: string; displayName?: string }; stats?: string[] };
type StatGroup = { name: string; keys?: string[]; athletes?: Athlete[] };
type Play = {
  type?: { text?: string };
  text?: string;
  statYardage?: number;
  teamParticipants?: { id?: string; type?: string }[];
  start?: { team?: { id?: string } };
};

export type Summary = {
  header?: {
    id?: string;
    season?: { year?: number; type?: number };
    competitions?: {
      status?: { type?: { completed?: boolean } };
      competitors?: { team?: { id?: string } }[];
    }[];
  };
  boxscore?: { players?: { team?: { id?: string }; statistics?: StatGroup[] }[] };
  drives?: { previous?: { plays?: Play[] }[] };
};

/** Box-score group → the byathlete feed's category name. */
const CATEGORY: Record<string, string> = {
  passing: "passing",
  rushing: "rushing",
  receiving: "receiving",
  fumbles: "fumbles",
  defensive: "defensive",
  interceptions: "defensiveinterceptions",
  kicking: "kicking",
  punting: "punting",
  puntReturns: "returning",
  kickReturns: "returning",
};

/** Totals that a season sums; averages and percentages are rebuilt later. */
const SKIP = new Set([
  "yardsPerPassAttempt",
  "adjQBR",
  "yardsPerRushAttempt",
  "yardsPerReception",
  "fieldGoalPct",
  "grossAvgPuntYards",
  "yardsPerKickReturn",
  "yardsPerPuntReturn",
]);

/** Kept as a maximum rather than summed. */
const LONG = new Set([
  "longRushing",
  "longReception",
  "longFieldGoalMade",
  "longPunt",
  "longKickReturn",
  "longPuntReturn",
]);

const FG_BUCKETS: [number, string][] = [
  [19, "1_19"],
  [29, "20_29"],
  [39, "30_39"],
  [49, "40_49"],
  [999, "50"],
];

function num(raw: string | undefined): number {
  if (raw == null) return NaN;
  const s = raw.replace(/,/g, "").trim();
  if (s === "" || s === "-" || s === "--") return NaN;
  return Number(s);
}

const add = (s: Record<string, number>, k: string, v: number) => {
  if (Number.isFinite(v)) s[k] = (s[k] ?? 0) + v;
};

/** Read one game summary. Returns null for a game without a box score. */
export function readSummary(sum: Summary): CfbGame | null {
  const comp = sum.header?.competitions?.[0];
  const groups = sum.boxscore?.players ?? [];
  if (!comp || groups.length !== 2) return null;
  const teams: CfbTeamGame[] = [];
  for (const g of groups) {
    const teamId = g.team?.id ?? "";
    const players = new Map<string, CfbLine>();
    const line = (a: Athlete): CfbLine | null => {
      const id = a.athlete?.id;
      if (!id) return null; // the "Team" row
      let l = players.get(id);
      if (!l) {
        l = { name: a.athlete?.displayName ?? "?", s: { "general.gamesPlayed": 1 } };
        players.set(id, l);
      }
      return l;
    };
    for (const st of g.statistics ?? []) {
      const cat = CATEGORY[st.name];
      if (!cat || !st.keys) continue;
      for (const a of st.athletes ?? []) {
        const l = line(a);
        if (!l) continue;
        st.keys.forEach((key, i) => {
          const raw = a.stats?.[i];
          if (key.includes("/")) {
            const [k1, k2] = key.split("/");
            const [v1, v2] = (raw ?? "").split("/");
            add(l.s, `${cat}.${k1}`, num(v1));
            add(l.s, `${cat}.${k2}`, num(v2));
          } else if (LONG.has(key)) {
            const v = num(raw);
            if (Number.isFinite(v)) l.s[`${cat}.${key}`] = Math.max(l.s[`${cat}.${key}`] ?? 0, v);
          } else if (!SKIP.has(key)) add(l.s, `${cat}.${key}`, num(raw));
        });
      }
    }
    // Fumbles lost are kept as the feed keys them, on the rushing line.
    for (const l of players.values()) {
      const lost = l.s["fumbles.fumblesLost"];
      if (lost) l.s["rushing.rushingFumblesLost"] = lost;
    }
    teams.push({ teamId, players });
  }

  // ------------------------------------------------ from the play-by-play
  const plays = (sum.drives?.previous ?? []).flatMap((d) => d.plays ?? []);
  const offense = (p: Play) =>
    p.teamParticipants?.find((t) => t.type === "offense")?.id ?? p.start?.team?.id ?? "";
  for (const tg of teams) {
    const mine = plays.filter((p) => offense(p) === tg.teamId);
    const L = [...tg.players.values()];
    const by = (k: string) => L.filter((l) => (l.s[k] ?? 0) > 0);

    // Sacks taken, shared among the game's passers by attempts.
    let sacks = 0;
    let sackYds = 0;
    for (const p of mine) {
      if (!/sacked/i.test(p.text ?? "")) continue;
      sacks++;
      sackYds += Math.max(0, -(p.statYardage ?? 0));
    }
    const passers = by("passing.passingAttempts");
    const att = passers.reduce((a, l) => a + l.s["passing.passingAttempts"], 0);
    if (sacks && att > 0)
      for (const l of passers) {
        const f = l.s["passing.passingAttempts"] / att;
        add(l.s, "passing.sacks", sacks * f);
        add(l.s, "passing.sackYardsLost", sackYds * f);
      }

    // Field goals by distance, to the game's kicker.
    const kicker = by("kicking.fieldGoalAttempts")[0];
    if (kicker)
      for (const p of mine) {
        // "J. Smith 41 yd FG GOOD", "41 Yd Field Goal", "field goal attempt
        // from 41 yards GOOD"; made or missed by the play's type.
        const type = p.type?.text ?? "";
        if (!/field goal/i.test(type)) continue;
        const m =
          /(\d+)\s*y(?:ar)?ds?\.?\s*(?:FG|field goal)/i.exec(p.text ?? "") ??
          /field goal attempt from (\d+)/i.exec(p.text ?? "");
        if (!m) continue;
        const dist = Number(m[1]);
        const b = FG_BUCKETS.find(([hi]) => dist <= hi)![1];
        add(kicker.s, `kicking.fieldGoalAttempts${b}`, 1);
        if (/good/i.test(type)) add(kicker.s, `kicking.fieldGoalsMade${b}`, 1);
      }

    // Net punting: gross, less touchbacks and the other side's returns.
    const punters = by("punting.punts");
    const punts = punters.reduce((a, l) => a + l.s["punting.punts"], 0);
    if (punts > 0) {
      const other = teams.find((t) => t !== tg);
      const ret = other
        ? [...other.players.values()].reduce(
            (a, l) => a + (l.s["returning.puntReturnYards"] ?? 0),
            0,
          )
        : 0;
      for (const l of punters) {
        const n = l.s["punting.punts"];
        const net = (l.s["punting.puntYards"] ?? 0) - 20 * (l.s["punting.touchbacks"] ?? 0);
        add(l.s, "punting.netYards", net - (ret * n) / punts);
      }
    }
  }

  return {
    id: sum.header?.id ?? "",
    season: sum.header?.season?.year ?? 0,
    seasonType: sum.header?.season?.type ?? 0,
    completed: comp.status?.type?.completed === true,
    teams,
  };
}

/** Add one game's lines into a season's running totals. */
export function accumulate(
  into: Map<string, { name: string; teamId: string; s: Record<string, number> }>,
  team: CfbTeamGame,
): void {
  for (const [id, l] of team.players) {
    let t = into.get(id);
    if (!t) {
      t = { name: l.name, teamId: team.teamId, s: {} };
      into.set(id, t);
    }
    t.teamId = team.teamId;
    for (const [k, v] of Object.entries(l.s)) {
      if (k.startsWith("rushing.long") || k.startsWith("receiving.long") || k.includes(".long"))
        t.s[k] = Math.max(t.s[k] ?? 0, v);
      else t.s[k] = (t.s[k] ?? 0) + v;
    }
  }
}

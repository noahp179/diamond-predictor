import { useMemo, useState } from "react";

import { available } from "@/lib/sim/core";
import { mlbPlan } from "@/lib/sim/mlb";
import type {
  BasePlayer,
  MlbBatter,
  MlbPitcher,
  NbaPlayer,
  NflPlayer,
  NhlGoalie,
  NhlSkater,
  SimMatchup,
  SimOverrides,
  Side,
} from "@/lib/sim/types";

import { AWAY_COLOR, hideBroken, HOME_COLOR } from "./format";

/**
 * Who plays. The injury report sets the defaults — anyone listed out starts
 * on the bench — and every name can be flipped either way: sit a star, play
 * through an injury, start the backup goalie. The engines rebuild rotations,
 * lines, lineups and depth charts around whoever is left.
 */
export function RosterPanel({
  matchup,
  overrides,
  onChange,
}: {
  matchup: SimMatchup;
  overrides: SimOverrides;
  onChange: (o: SimOverrides) => void;
}) {
  return (
    <div className="grid gap-px bg-border lg:grid-cols-2">
      {(["away", "home"] as const).map((side) => (
        <TeamRoster
          key={side}
          side={side}
          matchup={matchup}
          overrides={overrides}
          onChange={onChange}
        />
      ))}
    </div>
  );
}

type Row = { p: BasePlayer; line: string; dim?: boolean };
type Group = { title: string; rows: Row[]; collapsed?: boolean };

function TeamRoster({
  side,
  matchup,
  overrides,
  onChange,
}: {
  side: Side;
  matchup: SimMatchup;
  overrides: SimOverrides;
  onChange: (o: SimOverrides) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const benched = useMemo(() => new Set(overrides.benched), [overrides.benched]);
  const activated = useMemo(() => new Set(overrides.activated), [overrides.activated]);
  const isOn = (p: BasePlayer) => available(p, benched, activated);
  const toggle = (p: BasePlayer) => {
    const b = new Set(benched);
    const a = new Set(activated);
    if (isOn(p)) {
      if (a.has(p.id)) a.delete(p.id);
      else b.add(p.id);
    } else {
      if (b.has(p.id)) b.delete(p.id);
      else a.add(p.id);
    }
    onChange({ ...overrides, benched: [...b], activated: [...a] });
  };
  const setStarter = (id: string) =>
    onChange({ ...overrides, starter: { ...overrides.starter, [side]: id } });

  const team = matchup[side];
  const { groups, starter } = useMemo(
    () => describe(matchup, side, overrides),
    [matchup, side, overrides],
  );
  const color = side === "home" ? HOME_COLOR : AWAY_COLOR;
  const out = groups.flatMap((g) => g.rows).filter((r) => !isOn(r.p)).length;

  return (
    <div className="bg-card p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {team.logo && (
            <img
              src={team.logo}
              alt=""
              onError={hideBroken}
              className="h-8 w-8 object-contain"
              loading="lazy"
            />
          )}
          <div>
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />
              {side}
            </div>
            <div className="font-display text-2xl leading-none">{team.name}</div>
          </div>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {out} not playing
        </span>
      </div>

      {starter && (
        <label className="mt-4 block">
          <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {starter.label}
          </span>
          <select
            value={starter.value}
            onChange={(e) => setStarter(e.target.value)}
            className="mt-1 block w-full border border-border bg-secondary px-2 py-1.5 font-mono text-xs text-foreground"
          >
            {starter.options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="mt-4 space-y-4">
        {groups
          .filter((g) => showAll || !g.collapsed)
          .map((g) => (
            <div key={g.title}>
              <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                {g.title}
              </div>
              <ul className="divide-y divide-border/40">
                {g.rows.map(({ p, line }) => {
                  const on = isOn(p);
                  return (
                    <li key={p.id} className="flex items-center gap-2 py-1">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggle(p)}
                        aria-label={`${p.name} plays`}
                        className="accent-[var(--color-primary)]"
                      />
                      <span
                        className={`min-w-0 flex-1 truncate text-sm ${on ? "text-foreground" : "text-muted-foreground line-through"}`}
                      >
                        {p.name}{" "}
                        <span className="font-mono text-[10px] text-muted-foreground no-underline">
                          {p.pos}
                        </span>
                      </span>
                      {p.injury && (
                        <span
                          className={`shrink-0 border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider ${
                            p.status === "out"
                              ? "border-destructive/50 text-destructive-foreground"
                              : "border-primary/40 text-primary"
                          }`}
                          title="Injury report"
                        >
                          {p.injury}
                        </span>
                      )}
                      <span className="hidden shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums sm:inline">
                        {line}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
      </div>
      {groups.some((g) => g.collapsed) && (
        <button
          onClick={() => setShowAll((s) => !s)}
          className="mt-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
        >
          {showAll ? "Show fewer" : "Show the whole roster"}
        </button>
      )}
    </div>
  );
}

type Starter = { label: string; value: string; options: { id: string; label: string }[] };

function describe(
  m: SimMatchup,
  side: Side,
  o: SimOverrides,
): { groups: Group[]; starter: Starter | null } {
  switch (m.league) {
    case "nba": {
      const ps = m[side].players.slice().sort((a, b) => b.mpg - a.mpg);
      const line = (p: NbaPlayer) => {
        const pts = (2 * p.fg2a * p.fg2p + 3 * p.fg3a * p.fg3p + p.fta * p.ftp) * p.mpg;
        return `${p.mpg.toFixed(1)} min · ${pts.toFixed(1)} pts · ${((p.oreb + p.dreb) * p.mpg).toFixed(1)} reb · ${(p.ast * p.mpg).toFixed(1)} ast`;
      };
      return {
        starter: null,
        groups: [
          { title: "Rotation", rows: ps.slice(0, 10).map((p) => ({ p, line: line(p) })) },
          {
            title: "End of the bench",
            rows: ps.slice(10).map((p) => ({ p, line: line(p) })),
            collapsed: true,
          },
        ],
      };
    }
    case "nhl": {
      const t = m[side];
      const sk = (p: NhlSkater) =>
        `${Math.floor(p.toi / 60)}:${String(Math.round(p.toi % 60)).padStart(2, "0")} TOI · ${((p.sog60 * p.toi) / 3600).toFixed(1)} SOG · ${(p.shPct * 100).toFixed(1)}% sh`;
      const gl = (g: NhlGoalie) =>
        `${g.svPct.toFixed(3).replace(/^0/, "")} sv% · ${Math.round(g.starts)} starts`;
      const want = o.starter?.[side] ?? t.probable ?? t.goalies[0]?.id ?? "";
      return {
        starter: t.goalies.length
          ? {
              label: "Starting goalie",
              value: want,
              options: t.goalies.map((g) => ({
                id: g.id,
                label: `${g.name} — ${gl(g)}${g.id === t.probable ? " · listed starter" : ""}${g.status === "out" ? " · OUT" : ""}`,
              })),
            }
          : null,
        groups: [
          {
            title: "Forwards",
            rows: t.skaters.filter((p) => p.kind === "F").map((p) => ({ p, line: sk(p) })),
          },
          {
            title: "Defense",
            rows: t.skaters.filter((p) => p.kind === "D").map((p) => ({ p, line: sk(p) })),
          },
          { title: "Goalies", rows: t.goalies.map((g) => ({ p: g, line: gl(g) })) },
        ],
      };
    }
    case "mlb": {
      const t = m[side];
      const plan = mlbPlan(m, o)[side === "home" ? 0 : 1];
      const bat = (b: MlbBatter) =>
        `${b.obp.toFixed(3).replace(/^0/, "")} OBP · ${b.ops.toFixed(3).replace(/^0/, "")} OPS · ${Math.round(b.pa)} PA`;
      const pit = (p: MlbPitcher) =>
        `${p.era.toFixed(2)} ERA · ${p.ip} IP · ${(p.rates.so * 100).toFixed(0)}% K`;
      const order = plan.order.map((i, k) => ({
        p: t.batters[i],
        line: `${k + 1}. ${bat(t.batters[i])}`,
      }));
      const bench = t.batters
        .filter((_, i) => !plan.order.includes(i))
        .map((b) => ({ p: b, line: bat(b) }));
      const sps = t.pitchers.filter((p) => p.starts > 0).sort((a, b) => b.starts - a.starts);
      const want = o.starter?.[side] ?? t.probable ?? "rotation";
      return {
        starter: {
          label: "Starting pitcher",
          value: want,
          options: [
            { id: "rotation", label: "Rotation — a different starter each simulated game" },
            ...sps.map((p) => ({
              id: p.id,
              label: `${p.name} — ${pit(p)}${p.id === t.probable ? " · listed probable" : ""}${p.status === "out" ? " · OUT" : ""}`,
            })),
            ...t.pitchers
              .filter((p) => p.starts === 0 && p.id === t.probable)
              .map((p) => ({
                id: p.id,
                label: `${p.name} — ${pit(p)} · listed probable (opener)`,
              })),
          ],
        },
        groups: [
          { title: "Batting order (projected)", rows: order },
          { title: "Bench", rows: bench, collapsed: true },
          {
            title: "Pitching staff",
            rows: t.pitchers
              .slice()
              .sort((a, b) => b.ip - a.ip)
              .map((p) => ({ p, line: pit(p) })),
            collapsed: true,
          },
        ],
      };
    }
    case "nfl": {
      const t = m[side];
      const ps = t.players;
      const by = (pos: string[]) => ps.filter((p) => pos.includes(p.pos));
      const qbLine = (p: NflPlayer) =>
        `${(p.cmpPct * 100).toFixed(0)}% cmp · ${(p.cmpPct * p.ypc).toFixed(1)} Y/A · ${p.passAtt.toFixed(0)} att/g`;
      const skill = (p: NflPlayer) => {
        const parts: string[] = [];
        if (p.carries >= 1) parts.push(`${p.carries.toFixed(1)} car/g · ${p.ypc_r.toFixed(1)} ypc`);
        if (p.targets >= 0.5) parts.push(`${p.targets.toFixed(1)} tgt/g · ${p.ypr.toFixed(1)} ypr`);
        return parts.join(" · ") || "—";
      };
      const usage = (p: NflPlayer) => p.carries + p.targets;
      const qbs = by(["QB"]).sort(
        (a, b) => b.passAtt * Math.min(b.sample, 4) - a.passAtt * Math.min(a.sample, 4),
      );
      const skills = ps
        .filter((p) => ["RB", "FB", "WR", "TE"].includes(p.pos))
        .sort((a, b) => usage(b) - usage(a));
      const defense = ps
        .filter((p) => p.unit === "def")
        .sort((a, b) => b.tackles + 5 * b.sacks - (a.tackles + 5 * a.sacks));
      const want = o.starter?.[side] ?? qbs.find((q) => q.status !== "out")?.id ?? qbs[0]?.id ?? "";
      return {
        starter: qbs.length
          ? {
              label: "Starting quarterback",
              value: want,
              options: qbs.map((q) => ({
                id: q.id,
                label: `${q.name} — ${qbLine(q)}${q.status === "out" ? " · OUT" : q.injury ? ` · ${q.injury}` : ""}`,
              })),
            }
          : null,
        groups: [
          {
            title: "Ball carriers & receivers",
            rows: skills.filter((p) => usage(p) >= 0.5).map((p) => ({ p, line: skill(p) })),
          },
          {
            title: "Specialists",
            rows: by(["PK", "K", "P"]).map((p) => ({
              p,
              line:
                p.pos === "P"
                  ? `${p.puntNet.toFixed(1)} net`
                  : `FG ${(p.fgSkill * 100).toFixed(0)} skill · long ${p.longFg}`,
            })),
          },
          {
            title: "Defense",
            rows: defense.map((p) => ({
              p,
              line: `${p.tackles.toFixed(1)} tkl · ${p.sacks.toFixed(2)} sk · ${p.ints.toFixed(2)} int /g`,
            })),
            collapsed: true,
          },
          {
            title: "Depth",
            rows: skills.filter((p) => usage(p) < 0.5).map((p) => ({ p, line: skill(p) })),
            collapsed: true,
          },
        ],
      };
    }
  }
}

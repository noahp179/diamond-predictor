import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { SportShell, StatBar, Stat, Note } from "@/components/SportShell";
import { getMlbTwoBases } from "@/lib/sports.functions";

type Result = Awaited<ReturnType<typeof getMlbTwoBases>>;
type Pick = Result["picks"][number];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`;
const price = (x: number) => `${x > 0 ? "+" : ""}${x}`;

/**
 * Tiers come from the model file — cut on the held-out 2026 season at the
 * points where the hit rate actually separates, not at round numbers.
 * See research/mlb-tb2/final_tb2.py.
 */
const TIER_CLS: Record<string, string> = {
  Strong: "text-primary border-primary/50",
  Solid: "text-foreground border-border",
  Lean: "text-muted-foreground border-border",
};

function PickCard({ pick, rank }: { pick: Pick; rank: number }) {
  const cls = TIER_CLS[pick.tier ?? "Lean"] ?? TIER_CLS.Lean;
  return (
    <div className="border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <span className="w-6 shrink-0 pt-1 font-mono text-sm text-primary/70">{rank}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-xl leading-tight">{pick.player}</div>
          <div className="mt-0.5 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
            {pick.team} {pick.isHome ? "vs" : "@"} {pick.opponent} · bats {pick.slot}
            {pick.opposingStarter ? ` · vs ${pick.opposingStarter}` : ""}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-display text-3xl leading-none text-foreground">{pct(pick.prob)}</div>
          <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            fair {price(pick.fairOdds)}
          </div>
        </div>
        <div
          className={`w-20 shrink-0 border px-2 py-1 text-center font-mono text-[10px] uppercase tracking-widest ${cls}`}
          title={
            pick.tierHitRate != null
              ? `${pick.tier}: picks in this tier got 2+ bases ${pct1(pick.tierHitRate)} of the time across the held-out 2026 season.`
              : undefined
          }
        >
          <div className="text-xs leading-none">{pick.tier ?? "—"}</div>
          <div className="mt-0.5">{pick.tierHitRate != null ? pct(pick.tierHitRate) : "—"}</div>
        </div>
      </div>

      <p className="mt-3 border-t border-border pt-3 text-sm leading-relaxed text-foreground">
        {pick.summary}
      </p>

      {(pick.up.length > 0 || pick.down.length > 0) && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {pick.up.map((r) => (
            <span
              key={`u${r.key}`}
              className="border border-primary/40 px-2 py-0.5 font-mono text-[10px] text-primary"
              title={`${r.label} — pushes this projection up`}
            >
              ↑ {r.detail || r.label}
            </span>
          ))}
          {pick.down.map((r) => (
            <span
              key={`d${r.key}`}
              className="border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
              title={`${r.label} — pushes this projection down`}
            >
              ↓ {r.detail || r.label}
            </span>
          ))}
        </div>
      )}
      {!pick.lineupPosted && (
        <div className="mt-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Lineup not posted — batting order from this team's last game
        </div>
      )}
    </div>
  );
}

export function MlbTwoBasesView() {
  const [date, setDate] = useState(todayISO());
  const [strongOnly, setStrongOnly] = useState(false);
  const [limit, setLimit] = useState(24);
  const run = useServerFn(getMlbTwoBases);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["mlb", "two-bases", date],
    queryFn: () => run({ data: { date } }),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  const all = useMemo(() => data?.picks ?? [], [data]);
  const strong = useMemo(() => all.filter((p) => p.tier === "Strong"), [all]);
  const shown = (strongOnly ? strong : all).slice(0, limit);
  const m = data?.model ?? null;
  const best = all[0];

  return (
    <SportShell
      sport="mlb"
      current="twoBases"
      eyebrow="Diamond Edge · MLB 2+ Bases"
      title="2+ Total Bases"
      blurb="How likely is each hitter to pick up two or more bases today? A single is one base, a double two, a triple three, a home run four — so this is a double, a homer, or two hits in the same game. Every projection comes with the reason it is what it is, in plain English."
      date={date}
      onDateChange={setDate}
      footerNote="Data · MLB Stats API · logistic model, fit 2024-25, tested on 2026 · Not affiliated with MLB"
      statBar={
        <StatBar>
          <Stat label="Hitters" value={`${all.length}`} />
          <Stat
            label="Best pick"
            value={best ? `${pct(best.prob)} ${best.player.split(" ").at(-1) ?? ""}` : "—"}
          />
          <Stat label="Strong" value={`${strong.length}`} />
          <Stat label="Typical starter" value={m ? pct(m.base) : "—"} />
        </StatBar>
      }
    >
      {isLoading && <div className="h-56 animate-pulse border border-border bg-card" />}
      {isError && (
        <div className="border border-destructive/40 bg-destructive/10 p-6 font-mono text-sm text-destructive-foreground">
          Failed to load 2+ base projections. The MLB Stats API may be unreachable.
        </div>
      )}
      {!isLoading && !isError && data?.note && <Note>{data.note}</Note>}

      {!isLoading && !isError && m && all.length > 0 && (
        <div className="mb-6 border border-border bg-card p-4">
          <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            How to read this
          </div>
          <p className="mt-2 text-sm leading-relaxed text-foreground">
            A typical lineup starter gets two or more bases about <strong>{pct(m.base)}</strong> of
            the time. The model moves that number using the hitter, how many at-bats he should get,
            the pitcher he faces, the opponent's staff and the ballpark. On the{" "}
            {m.nTest.toLocaleString()} held-out games of the 2026 season the day's single best pick
            landed <strong>{pct1(m.top1)}</strong> of the time and the top three{" "}
            <strong>{pct1(m.top3)}</strong>. The percentages are calibrated — when it says 40%, it
            happened about 40% of the time — so they compare directly against a sportsbook's price.
          </p>
          <div className="mt-3 flex flex-wrap gap-3 border-t border-border pt-3 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
            {m.tiers.map((t) => (
              <span key={t.label}>
                {t.label} <span className="text-foreground">{pct1(t.hitRate)}</span>
              </span>
            ))}
            <span>
              ranking <span className="text-foreground">{m.auc.toFixed(4)} AUC</span> vs{" "}
              {m.aucNaive.toFixed(4)} for his own season rate alone
            </span>
          </div>
        </div>
      )}

      {!isLoading && !isError && all.length > 0 && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border border-border bg-card px-4 py-3">
          <div className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
            {data?.games ?? 0} games · {data?.lineupsPosted ?? 0} lineups posted
          </div>
          <button
            type="button"
            onClick={() => setStrongOnly((v) => !v)}
            aria-pressed={strongOnly}
            className={`border px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest transition-colors ${
              strongOnly
                ? "border-primary text-primary"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {strongOnly ? "▸ " : ""}Strong only ({strong.length})
          </button>
        </div>
      )}

      {!isLoading && !isError && shown.length > 0 && (
        <>
          <div className="grid gap-3 md:grid-cols-2">
            {shown.map((p, i) => (
              <PickCard key={`${p.gameId}:${p.playerId}`} pick={p} rank={i + 1} />
            ))}
          </div>
          {shown.length < (strongOnly ? strong : all).length && (
            <button
              type="button"
              onClick={() => setLimit((v) => v + 24)}
              className="mt-4 w-full border border-border px-3 py-3 font-mono text-[11px] uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
            >
              Show more ({(strongOnly ? strong : all).length - shown.length} left)
            </button>
          )}
        </>
      )}

      {!isLoading && !isError && shown.length === 0 && all.length > 0 && (
        <div className="border border-border bg-card p-10 text-center">
          <div className="font-display text-3xl">No Strong picks today</div>
          <p className="mt-2 font-mono text-sm text-muted-foreground">
            Nobody clears the top tier. Turn the filter off to see the whole board.
          </p>
        </div>
      )}

      {!isLoading && !isError && all.length === 0 && !data?.note && (
        <div className="border border-border bg-card p-10 text-center">
          <div className="font-display text-3xl">No games to project</div>
          <p className="mt-2 font-mono text-sm text-muted-foreground">
            Pick a day with a slate. Projections need a season of games behind each hitter, so the
            board sharpens after the first couple of weeks.
          </p>
        </div>
      )}
    </SportShell>
  );
}

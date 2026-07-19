import type { PredictedGame } from "@/lib/mlb.functions";

function pct(n: number) {
  return `${Math.round(n * 100)}%`;
}

/** Confidence tier for a prediction, keyed to the historical win rates in
 *  MODEL-BAKEOFF.md (≥80% ≈ 86% hit, ≥70% ≈ 78–80%, ≥60% ≈ 64–70%). */
type Tier = { label: string; cls: string };
function tierOf(conf: number): Tier {
  if (conf >= 0.8) return { label: "Safe", cls: "text-grass" };
  if (conf >= 0.7) return { label: "Strong", cls: "text-primary" };
  if (conf >= 0.6) return { label: "Lean", cls: "text-foreground" };
  return { label: "Toss-up", cls: "text-muted-foreground" };
}

/** The favored side of a prediction and the confidence in it. */
function favOf(homeProb: number, awayProb: number, homeAbbr: string, awayAbbr: string) {
  const homeFav = homeProb >= awayProb;
  return { abbr: homeFav ? homeAbbr : awayAbbr, conf: homeFav ? homeProb : awayProb };
}

function formatTime(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export function GameCard({
  game,
  modelLabel = "Simulator",
}: {
  game: PredictedGame;
  /** Headline model name shown on the probability bar (MLB uses the Simulator;
   *  NFL/NBA use the Elo engine). */
  modelLabel?: string;
}) {
  const homeFav = game.homeWinProb >= game.awayWinProb;
  const favProb = homeFav ? game.homeWinProb : game.awayWinProb;
  const favName = homeFav ? game.home.abbreviation : game.away.abbreviation;
  // The SEPARATE confidence: the market's own read on the side the model picked
  // — a different number and a different algorithm than the prediction. Null
  // when no line is available (offseason / unpriced game).
  const pickConf = game.pickConfidence ?? null;
  const tier = pickConf != null ? tierOf(pickConf) : null;

  return (
    <article className="group relative overflow-hidden border border-border bg-card transition-colors hover:border-primary/60">
      {/* status strip */}
      <div className="flex items-center justify-between border-b border-border bg-secondary/40 px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
        <span>
          {formatTime(game.date)} · {game.venue}
        </span>
        <span
          className={
            game.correct == null ? "text-primary" : game.correct ? "text-grass" : "text-clay"
          }
        >
          {game.correct == null ? game.status : game.correct ? "✓ Correct" : "✗ Miss"}
        </span>
      </div>

      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4 px-5 py-6">
        <TeamBlock side={game.away} prob={game.awayWinProb} align="left" />
        <div className="text-center">
          {game.homeScore != null && game.awayScore != null ? (
            <div className="font-display text-3xl text-foreground">
              {game.awayScore}–{game.homeScore}
            </div>
          ) : (
            <div className="font-display text-3xl text-muted-foreground">@</div>
          )}
        </div>
        <TeamBlock side={game.home} prob={game.homeWinProb} align="right" />
      </div>

      {/* SEPARATE confidence — the market's own read on the pick, a different
          number and algorithm than the model's prediction shown on the bar
          below. Hidden when no line is available. */}
      {pickConf != null && tier && (
        <div className="flex items-center justify-between border-t border-border bg-secondary/20 px-5 py-2.5">
          <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
            Confidence <span className="text-muted-foreground/60">· market read</span>
          </span>
          <span className="flex items-baseline gap-2 font-mono text-[11px] uppercase tracking-widest">
            <span className="text-foreground">{favName}</span>
            <span className="font-display text-xl leading-none text-primary">{pct(pickConf)}</span>
            <span className={tier.cls}>{tier.label}</span>
          </span>
        </div>
      )}

      {/* prediction — each model's own win probability */}
      <div className="px-5 pb-4 pt-4">
        <div className="mb-2 flex justify-between font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          <span>
            {game.away.abbreviation} {pct(game.awayWinProb)}
          </span>
          <span className="text-primary">
            {modelLabel} · {favName} {pct(favProb)}
          </span>
          <span>
            {pct(game.homeWinProb)} {game.home.abbreviation}
          </span>
        </div>
        <div className="flex h-2 overflow-hidden bg-secondary">
          <div className="bg-chalk/70" style={{ width: `${game.awayWinProb * 100}%` }} />
          <div className="bg-signal" style={{ width: `${game.homeWinProb * 100}%` }} />
        </div>

        {/* secondary models (Recent Form, Bullpen, Poisson) — each its own label
            row + probability bar mirroring the primary above, dimmed so the
            Simulator headline still leads */}
        {game.altModels?.map((m) => {
          const mf = favOf(
            m.homeWinProb,
            m.awayWinProb,
            game.home.abbreviation,
            game.away.abbreviation,
          );
          return (
            <div key={m.label} className="mt-3">
              <div className="mb-1.5 flex justify-between font-mono text-[10px] uppercase tracking-widest text-muted-foreground/80">
                <span>
                  {game.away.abbreviation} {pct(m.awayWinProb)}
                </span>
                <span>
                  {m.label} · {mf.abbr} {pct(mf.conf)}
                </span>
                <span>
                  {pct(m.homeWinProb)} {game.home.abbreviation}
                </span>
              </div>
              <div className="flex h-2 overflow-hidden bg-secondary opacity-70">
                <div className="bg-chalk/70" style={{ width: `${m.awayWinProb * 100}%` }} />
                <div className="bg-signal" style={{ width: `${m.homeWinProb * 100}%` }} />
              </div>
            </div>
          );
        })}
      </div>

      <details className="border-t border-border bg-background/30 px-5 py-3 text-sm">
        <summary className="cursor-pointer font-mono text-[11px] uppercase tracking-widest text-muted-foreground hover:text-foreground">
          Model breakdown
        </summary>
        <ul className="mt-3 space-y-1 font-mono text-xs text-muted-foreground">
          {game.rationale.map((r, i) => (
            <li key={i}>· {r}</li>
          ))}
        </ul>
      </details>
    </article>
  );
}

function TeamBlock({
  side,
  prob,
  align,
}: {
  side: PredictedGame["home"];
  prob: number;
  align: "left" | "right";
}) {
  const alignClass = align === "left" ? "text-left items-start" : "text-right items-end";
  return (
    <div className={`flex flex-col ${alignClass}`}>
      <div className="font-display text-4xl leading-none">{side.abbreviation}</div>
      <div className="mt-1 text-sm text-muted-foreground">{side.name}</div>
      <div className="mt-2 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
        {side.record} · {(side.winPct * 1000).toFixed(0).padStart(3, "0")}
      </div>
      {side.pitcher && (
        <div className="mt-3 font-mono text-xs">
          <span className="text-primary">SP</span>{" "}
          <span className="text-foreground">{side.pitcher.name}</span>
          {side.pitcher.era != null && (
            <span className="text-muted-foreground"> · {side.pitcher.era.toFixed(2)} ERA</span>
          )}
        </div>
      )}
      <div
        className={`mt-3 font-display text-2xl ${prob >= 0.5 ? "text-primary" : "text-muted-foreground"}`}
      >
        {Math.round(prob * 100)}%
      </div>
    </div>
  );
}

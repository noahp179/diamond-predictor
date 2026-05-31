import type { PredictedGame } from "@/lib/mlb.functions";

function pct(n: number) {
  return `${Math.round(n * 100)}%`;
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

export function GameCard({ game }: { game: PredictedGame }) {
  const homeFav = game.homeWinProb >= game.awayWinProb;
  const favProb = homeFav ? game.homeWinProb : game.awayWinProb;
  const favName = homeFav ? game.home.abbreviation : game.away.abbreviation;

  return (
    <article className="group relative overflow-hidden border border-border bg-card transition-colors hover:border-primary/60">
      {/* status strip */}
      <div className="flex items-center justify-between border-b border-border bg-secondary/40 px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
        <span>{formatTime(game.date)} · {game.venue}</span>
        <span className={game.correct == null ? "text-primary" : game.correct ? "text-grass" : "text-clay"}>
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

      {/* probability bar */}
      <div className="px-5 pb-4">
        <div className="mb-2 flex justify-between font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          <span>{game.away.abbreviation} {pct(game.awayWinProb)}</span>
          <span className="text-primary">Edge · {favName} {pct(favProb)}</span>
          <span>{pct(game.homeWinProb)} {game.home.abbreviation}</span>
        </div>
        <div className="flex h-2 overflow-hidden bg-secondary">
          <div
            className="bg-chalk/70"
            style={{ width: `${game.awayWinProb * 100}%` }}
          />
          <div
            className="bg-signal"
            style={{ width: `${game.homeWinProb * 100}%` }}
          />
        </div>
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
      <div className={`mt-3 font-display text-2xl ${prob >= 0.5 ? "text-primary" : "text-muted-foreground"}`}>
        {Math.round(prob * 100)}%
      </div>
    </div>
  );
}
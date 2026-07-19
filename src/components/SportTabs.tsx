import { Link } from "@tanstack/react-router";

/**
 * Secondary navigation: the views within one sport — Slate, Recommended, Best
 * Odds, Track Record. Each sport routes to its own set of pages (MLB reuses the
 * original flat routes; NFL/NBA use nested routes under their slate).
 */

export type SportKey = "mlb" | "nfl" | "nba";
export type TabKey = "slate" | "recommended" | "bestOdds" | "trackRecord";

const ROUTES = {
  mlb: {
    slate: "/",
    recommended: "/model",
    bestOdds: "/best-odds",
    trackRecord: "/history",
  },
  nfl: {
    slate: "/nfl",
    recommended: "/nfl/recommended",
    bestOdds: "/nfl/best-odds",
    trackRecord: "/nfl/track-record",
  },
  nba: {
    slate: "/nba",
    recommended: "/nba/recommended",
    bestOdds: "/nba/best-odds",
    trackRecord: "/nba/track-record",
  },
} as const;

const LABELS: { key: TabKey; label: string }[] = [
  { key: "slate", label: "Slate" },
  { key: "recommended", label: "Recommended" },
  { key: "bestOdds", label: "Best Odds" },
  { key: "trackRecord", label: "Track Record" },
];

export function SportTabs({ sport, current }: { sport: SportKey; current: TabKey }) {
  const routes = ROUTES[sport];
  return (
    <div className="border-b border-border bg-secondary/20">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-1 gap-y-2 px-6 py-2.5">
        {LABELS.map(({ key, label }) => (
          <Link
            key={key}
            to={routes[key]}
            className={`px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest transition-colors ${
              current === key ? "text-primary" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <span className="mr-1 text-primary/60">{current === key ? "▸" : ""}</span>
            {label}
          </Link>
        ))}
      </div>
    </div>
  );
}

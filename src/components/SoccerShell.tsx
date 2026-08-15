import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";

import { SiteNav } from "@/components/SiteNav";
import { LEAGUES, type LeagueSlug } from "@/lib/soccer-leagues";

/**
 * Page frame for the Soccer tab.
 *
 * Soccer has one more level of navigation than the other sports: the top bar
 * picks the sport, a league bar picks the competition, and a view bar picks the
 * page within it. Each league is a separate model with a separate backtest, so
 * the league bar is not cosmetic — crossing it changes which numbers you are
 * looking at.
 */

export type SoccerTabKey = "slate" | "props" | "model";

const VIEWS: { key: SoccerTabKey; label: string }[] = [
  { key: "slate", label: "Matches" },
  { key: "props", label: "Player Props" },
  { key: "model", label: "Model & Backtest" },
];

function viewPath(league: LeagueSlug, key: SoccerTabKey) {
  return key === "slate" ? `/soccer/${league}` : `/soccer/${league}/${key}`;
}

export function SoccerShell({
  league,
  current,
  eyebrow,
  title,
  blurb,
  date,
  onDateChange,
  statBar,
  footerNote,
  children,
}: {
  league: LeagueSlug;
  current: SoccerTabKey;
  eyebrow: string;
  title: string;
  blurb: string;
  date?: string;
  onDateChange?: (d: string) => void;
  statBar?: ReactNode;
  footerNote?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-6 px-6 py-10">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.3em] text-primary">
              {eyebrow}
            </div>
            <h1 className="mt-2 font-display text-6xl leading-none md:text-7xl">{title}</h1>
            <p className="mt-3 max-w-xl text-sm text-muted-foreground">{blurb}</p>
          </div>
          <div className="flex flex-col items-end gap-3">
            {date !== undefined && onDateChange && (
              <input
                type="date"
                value={date}
                onChange={(e) => onDateChange(e.target.value)}
                className="border border-border bg-secondary px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-primary"
              />
            )}
            <SiteNav current="soccer" />
          </div>
        </div>
        {statBar}
      </header>

      {/* League switcher — each one is its own model and its own backtest. */}
      <div className="border-b border-border bg-secondary/40">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-1 px-6 py-2.5">
          {LEAGUES.map((l) => (
            <Link
              key={l.slug}
              to={viewPath(l.slug, current)}
              className={`border px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest transition-colors ${
                l.slug === league
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {l.short}
            </Link>
          ))}
        </div>
      </div>

      {/* View switcher within the active league. */}
      <div className="border-b border-border bg-secondary/20">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-1 gap-y-2 px-6 py-2.5">
          {VIEWS.map((v) => (
            <Link
              key={v.key}
              to={viewPath(league, v.key)}
              className={`px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest transition-colors ${
                current === v.key ? "text-primary" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <span className="mr-1 text-primary/60">{current === v.key ? "▸" : ""}</span>
              {v.label}
            </Link>
          ))}
        </div>
      </div>

      <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>

      <footer className="border-t border-border">
        <div className="mx-auto max-w-6xl px-6 py-8 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          {footerNote ?? "Data · ESPN soccer API · goal-difference Elo, calibrated per league"} ·
          Not affiliated with any league
        </div>
      </footer>
    </div>
  );
}

import type { ReactNode } from "react";
import { Link, type LinkProps } from "@tanstack/react-router";

import {
  divisionsOf,
  SPORTS,
  viewHref,
  viewsFor,
  type DivisionSlug,
  type SportKey,
  type ViewKey,
} from "@/lib/nav";

/**
 * nav.ts builds hrefs by joining segments, so TypeScript sees `string` where the
 * router wants its generated union of literal routes. The assertion is made once
 * here rather than at twenty call sites — and because that gives up the router's
 * compile-time check that a route exists, scripts/test-nav.ts asserts every href
 * nav.ts can produce is present in routeTree.gen.ts. The guarantee moves from the
 * type system to a test rather than disappearing.
 */
const to = (href: string) => href as LinkProps["to"];

/**
 * AppShell — the frame every page renders inside.
 *
 * Three bands of navigation, each answering one question:
 *
 *   brand + sports   which sport am I in?
 *   leagues          (soccer only) which competition?
 *   views            which page within it?
 *
 * The league band appears only where it means something. That is the point of
 * having it as its own row rather than folding five leagues into the sport
 * switcher: crossing it changes which *model's* numbers you are reading, and it
 * deserves to look like a change of context rather than a filter.
 *
 * Everything here reads from src/lib/nav.ts, so a new page is one line there
 * and appears in every surface at once.
 */

export function AppShell({
  sport,
  view,
  league,
  eyebrow,
  title,
  blurb,
  date,
  onDateChange,
  statBar,
  footerNote,
  children,
}: {
  /** Omit on pages that sit outside a sport (the hub, Teams). */
  sport?: SportKey;
  view?: ViewKey;
  /** Soccer's league or tennis's tour, on the sports that have one. */
  league?: DivisionSlug;
  eyebrow: string;
  title: string;
  blurb?: string;
  date?: string;
  onDateChange?: (d: string) => void;
  statBar?: ReactNode;
  footerNote?: string;
  children: ReactNode;
}) {
  const views = sport ? viewsFor(sport, league) : [];

  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto max-w-6xl px-6">
          <TopBar sport={sport} />
          <div className="flex flex-wrap items-end justify-between gap-6 pb-10 pt-8">
            <div>
              <div className="font-mono text-[11px] uppercase tracking-[0.3em] text-primary">
                {eyebrow}
              </div>
              <h1 className="mt-2 font-display text-6xl leading-none md:text-7xl">{title}</h1>
              {blurb && <p className="mt-3 max-w-2xl text-sm text-muted-foreground">{blurb}</p>}
            </div>
            {date !== undefined && onDateChange && (
              <input
                type="date"
                value={date}
                onChange={(e) => onDateChange(e.target.value)}
                className="border border-border bg-secondary px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-primary"
              />
            )}
          </div>
        </div>
        {statBar}
      </header>

      {sport && league && divisionsOf(sport).length > 0 && (
        <DivisionBar sport={sport} division={league} view={view} />
      )}

      {views.length > 0 && (
        <nav className="border-b border-border bg-secondary/20">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-1 gap-y-2 px-6 py-2.5">
            {views.map((v) => (
              <Link
                key={v.key}
                to={to(v.href)}
                className={`px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest transition-colors ${
                  view === v.key ? "text-primary" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <span className="mr-1 text-primary/60">{view === v.key ? "▸" : ""}</span>
                {v.label}
              </Link>
            ))}
          </div>
        </nav>
      )}

      <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-8 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          <span>
            {footerNote ?? "Data · MLB Stats API · ESPN · Not affiliated with any league"}
          </span>
          <Link to="/" className="hover:text-foreground">
            Diamond Edge
          </Link>
        </div>
      </footer>
    </div>
  );
}

/** Brand plus the sport switcher — present on every page, including the hub. */
function TopBar({ sport }: { sport?: SportKey }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border/60 py-4">
      <Link to="/" className="font-display text-xl tracking-tight hover:text-primary">
        Diamond Edge
      </Link>
      <nav className="flex flex-wrap items-center gap-1.5">
        {SPORTS.map((s) => (
          <Link
            key={s.key}
            to={to(s.href)}
            className={`border px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-widest transition-colors ${
              sport === s.key
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-secondary text-foreground hover:border-primary"
            }`}
          >
            {s.label}
          </Link>
        ))}
        <span className="mx-1 hidden h-5 w-px bg-border sm:inline-block" aria-hidden />
        <Link
          to="/teams"
          className="border border-border bg-secondary px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-widest text-foreground transition-colors hover:border-primary"
        >
          Teams
        </Link>
      </nav>
    </div>
  );
}

/**
 * The division band — soccer's leagues, tennis's tours.
 *
 * Staying on the same view while switching division is the common move
 * (comparing Serie A's props with the Bundesliga's, or the ATP's model page
 * with the WTA's), so each link preserves the current view rather than dumping
 * you back on the draw. viewHref does that resolution, which is why this bar
 * cannot construct paths itself.
 */
function DivisionBar({
  sport,
  division,
  view,
}: {
  sport: SportKey;
  division: DivisionSlug;
  view?: ViewKey;
}) {
  return (
    <div className="border-b border-border bg-secondary/40">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-1 px-6 py-2.5">
        {divisionsOf(sport).map((d) => (
          <Link
            key={d.slug}
            to={to(viewHref(sport, view ?? "slate", d.slug))}
            title={d.name}
            className={`border px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest transition-colors ${
              d.slug === division
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {d.short}
          </Link>
        ))}
        <span className="ml-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {sport === "tennis" ? "each tour its own model" : "each league its own model"}
        </span>
      </div>
    </div>
  );
}

export function StatBar({ children }: { children: ReactNode }) {
  return (
    <div className="border-t border-border bg-secondary/30">
      <div className="mx-auto grid max-w-6xl grid-cols-2 divide-x divide-border font-mono text-xs uppercase tracking-widest text-muted-foreground md:grid-cols-4">
        {children}
      </div>
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-6 py-4">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="mt-1 font-display text-2xl text-foreground">{value}</div>
    </div>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return (
    <div className="mb-8 border border-border bg-card p-6 font-mono text-sm text-muted-foreground">
      {children}
    </div>
  );
}

import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";

import { AppShell } from "@/components/AppShell";
import { SIM_LEAGUES, type SimLeague } from "@/lib/sim/types";

import { LEAGUE_LABEL } from "./format";

/** The frame every simulator page renders in: the site shell plus a league
 *  band. Switching league keeps the date, so a Sunday's NFL slate and that
 *  night's NHL games are one click apart. */
export function SimShell({
  league,
  date,
  onDateChange,
  title,
  blurb,
  children,
}: {
  league?: SimLeague;
  date?: string;
  onDateChange?: (d: string) => void;
  title: string;
  blurb: string;
  children: ReactNode;
}) {
  return (
    <AppShell
      section="sim"
      eyebrow="Diamond Edge · Game Simulator"
      title={title}
      blurb={blurb}
      date={date}
      onDateChange={onDateChange}
      footerNote="Data · ESPN season stats, rosters & injury reports · Simulations run in your browser · Not affiliated with any league"
      subnav={
        <div className="border-b border-border bg-secondary/40">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-1 px-6 py-2.5">
            <Link
              to="/sim"
              className={`border px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest transition-colors ${
                !league
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              Overview
            </Link>
            {SIM_LEAGUES.map((l) => (
              <Link
                key={l}
                to="/sim/$league"
                params={{ league: l }}
                search={date ? { date } : {}}
                className={`border px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest transition-colors ${
                  l === league
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {LEAGUE_LABEL[l]}
              </Link>
            ))}
            <span className="ml-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              play-by-play engines · built from player stats
            </span>
          </div>
        </div>
      }
    >
      {children}
    </AppShell>
  );
}

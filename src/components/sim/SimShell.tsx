import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";

import { AppShell } from "@/components/AppShell";
import { SIM_LEAGUES, type SimLeague } from "@/lib/sim/types";

import { LEAGUE_LABEL } from "./format";

/** Each league's simulator, inside that sport's section. */
export const SIM_HOME = {
  nfl: "/nfl/simulate",
  nba: "/nba/simulate",
  nhl: "/nhl/simulate",
  mlb: "/mlb/simulate",
} as const satisfies Record<SimLeague, string>;

/** The frame of the simulator overview (/sim): the site shell plus a band
 *  linking to each sport's Simulate view. */
export function SimShell({
  title,
  blurb,
  children,
}: {
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
      footerNote="Data · ESPN season stats, rosters & injury reports · Simulations run in your browser · Not affiliated with any league"
      subnav={
        <div className="border-b border-border bg-secondary/40">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-1 px-6 py-2.5">
            <span className="border border-primary px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-primary">
              Overview
            </span>
            {SIM_LEAGUES.map((l) => (
              <Link
                key={l}
                to={SIM_HOME[l]}
                className="border border-transparent px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
              >
                {LEAGUE_LABEL[l]} →
              </Link>
            ))}
            <span className="ml-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              each one lives in its sport&apos;s section
            </span>
          </div>
        </div>
      }
    >
      {children}
    </AppShell>
  );
}

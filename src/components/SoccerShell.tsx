import type { ReactNode } from "react";

import { AppShell } from "@/components/AppShell";
import type { LeagueSlug } from "@/lib/soccer-leagues";
import type { ViewKey } from "@/lib/nav";

/** Thin adapter over AppShell for the soccer pages, which carry a league. */
export type SoccerTabKey = Extract<ViewKey, "slate" | "props" | "model">;

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
    <AppShell
      sport="soccer"
      view={current}
      league={league}
      eyebrow={eyebrow}
      title={title}
      blurb={blurb}
      date={date}
      onDateChange={onDateChange}
      statBar={statBar}
      footerNote={
        footerNote ?? "Data · ESPN soccer API · goal-difference Elo, calibrated per league"
      }
    >
      {children}
    </AppShell>
  );
}

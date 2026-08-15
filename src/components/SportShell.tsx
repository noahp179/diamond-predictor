import type { ReactNode } from "react";

import { AppShell } from "@/components/AppShell";
import type { SportKey, ViewKey } from "@/lib/nav";

/**
 * Thin adapter kept so the NFL/NBA/MLB view pages did not all need rewriting
 * when the shell was unified. New pages should use AppShell directly.
 *
 * StatBar / Stat / Note are re-exported because half the app imports them from
 * here; they now live in AppShell.
 */
export function SportShell({
  sport,
  current,
  eyebrow,
  title,
  blurb,
  date,
  onDateChange,
  children,
  statBar,
  footerNote,
}: {
  sport: SportKey;
  current: ViewKey;
  eyebrow: string;
  title: string;
  blurb: string;
  date?: string;
  onDateChange?: (d: string) => void;
  children: ReactNode;
  statBar?: ReactNode;
  footerNote?: string;
}) {
  return (
    <AppShell
      sport={sport}
      view={current}
      eyebrow={eyebrow}
      title={title}
      blurb={blurb}
      date={date}
      onDateChange={onDateChange}
      statBar={statBar}
      footerNote={
        footerNote ??
        `Data · ESPN · margin-of-victory Elo · Not affiliated with the ${sport.toUpperCase()}`
      }
    >
      {children}
    </AppShell>
  );
}

export { StatBar, Stat, Note } from "@/components/AppShell";

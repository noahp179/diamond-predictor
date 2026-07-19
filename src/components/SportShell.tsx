import type { ReactNode } from "react";

import { SiteNav } from "@/components/SiteNav";
import { SportTabs, type SportKey, type TabKey } from "@/components/SportTabs";

/**
 * Common page frame for a sport's views (Recommended / Best Odds / Track
 * Record): the header with the sport switcher, the secondary tab bar, a main
 * content slot, and the footer. The slate page (SportPage) predates this and
 * renders its own copy; everything else composes this.
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
}: {
  sport: Exclude<SportKey, "mlb">;
  current: TabKey;
  eyebrow: string;
  title: string;
  blurb: string;
  date?: string;
  onDateChange?: (d: string) => void;
  children: ReactNode;
  statBar?: ReactNode;
}) {
  const label = sport.toUpperCase();
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
            <SiteNav current={sport} />
          </div>
        </div>
        {statBar}
      </header>

      <SportTabs sport={sport} current={current} />

      <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>

      <footer className="border-t border-border">
        <div className="mx-auto max-w-6xl px-6 py-8 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          Data · ESPN · margin-of-victory Elo · Not affiliated with the {label}
        </div>
      </footer>
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

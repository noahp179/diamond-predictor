import { Link } from "@tanstack/react-router";

/**
 * Primary top navigation: the sport switcher. Each sport's own views
 * (Slate · Recommended · Best Odds · Track Record) live in the secondary
 * SportTabs bar, not here.
 */

type NavKey = "mlb" | "nfl" | "nba" | "teams";

const base = "border px-4 py-2 font-mono text-xs uppercase tracking-widest transition-colors";
const idle = "border-border bg-secondary text-foreground hover:border-primary";
const active = "border-primary bg-primary/10 text-primary";

export function SiteNav({ current }: { current?: NavKey }) {
  return (
    <nav className="flex flex-wrap items-center gap-2 sm:gap-3">
      <Link to="/" className={`${base} ${current === "mlb" ? active : idle}`}>
        MLB
      </Link>
      <Link to="/nfl" className={`${base} ${current === "nfl" ? active : idle}`}>
        NFL
      </Link>
      <Link to="/nba" className={`${base} ${current === "nba" ? active : idle}`}>
        NBA
      </Link>
      <span className="mx-1 hidden h-5 w-px bg-border sm:inline-block" aria-hidden />
      <Link to="/teams" className={`${base} ${current === "teams" ? active : idle}`}>
        Teams
      </Link>
    </nav>
  );
}

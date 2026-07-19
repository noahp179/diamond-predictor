import { Link } from "@tanstack/react-router";

/**
 * Shared top navigation. Three sport tabs (MLB · NFL · NBA) lead, with the
 * MLB-specific tools as secondary links. Best Odds and Track Record are
 * intentionally hidden for now (being reorganized) — their routes still exist
 * and resolve by direct URL, they're just off the nav.
 */

type NavKey = "mlb" | "nfl" | "nba" | "teams" | "model";

const base = "border px-4 py-2 font-mono text-xs uppercase tracking-widest transition-colors";
const idle = "border-border bg-secondary text-foreground hover:border-primary";
const active = "border-primary bg-primary/10 text-primary";
const accent = "border-primary/60 bg-primary/10 text-primary hover:border-primary";

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
      <Link to="/model" className={`${base} ${current === "model" ? active : accent}`}>
        Recommended
      </Link>
    </nav>
  );
}

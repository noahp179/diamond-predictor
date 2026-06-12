import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";

import { getTeamLeaderboard } from "@/lib/mlb.functions";

export const Route = createFileRoute("/teams")({
  head: () => ({
    meta: [
      { title: "Teams — Diamond Edge" },
      {
        name: "description",
        content:
          "Per-team standings and Diamond Edge model accuracy for every MLB club.",
      },
      { property: "og:title", content: "Teams — Diamond Edge" },
      {
        property: "og:description",
        content: "Per-team standings and model accuracy.",
      },
    ],
  }),
  component: TeamsPage,
  errorComponent: ({ error }) => (
    <div className="p-10 font-mono text-sm text-destructive">
      Couldn't load teams: {error.message}
    </div>
  ),
});

function pct(n: number | null) {
  if (n == null) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function TeamsPage() {
  const fetchTeams = useServerFn(getTeamLeaderboard);
  const { data, isLoading } = useQuery({
    queryKey: ["team-leaderboard"],
    queryFn: () => fetchTeams(),
  });

  const teams = data?.teams ?? [];

  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-6 px-6 py-10">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.3em] text-primary">
              Diamond Edge · Team Index
            </div>
            <h1 className="mt-2 font-display text-6xl leading-none md:text-7xl">
              Clubhouse Ledger
            </h1>
            <p className="mt-3 max-w-xl text-sm text-muted-foreground">
              Records, run differential, and how well the model has predicted each
              team's settled games. Model version{" "}
              <span className="font-mono text-foreground">
                {data?.modelVersion ?? "—"}
              </span>
              .
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              to="/model"
              className="border border-primary/60 bg-primary/10 px-4 py-2 font-mono text-xs uppercase tracking-widest text-primary hover:border-primary"
            >
              Recommended
            </Link>
            <Link
              to="/"
              className="border border-border bg-secondary px-4 py-2 font-mono text-xs uppercase tracking-widest text-foreground hover:border-primary"
            >
              Today's slate
            </Link>
            <Link
              to="/history"
              className="border border-border bg-secondary px-4 py-2 font-mono text-xs uppercase tracking-widest text-foreground hover:border-primary"
            >
              Track record
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        {isLoading && (
          <div className="h-96 animate-pulse border border-border bg-card" />
        )}
        {!isLoading && teams.length === 0 && (
          <div className="border border-border bg-card p-10 text-center font-mono text-sm text-muted-foreground">
            No settled games yet — run the pipeline from the home page once games finish.
          </div>
        )}
        {teams.length > 0 && (
          <div className="overflow-x-auto border border-border bg-card">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-secondary/40 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 text-left">#</th>
                  <th className="px-4 py-3 text-left">Team</th>
                  <th className="px-4 py-3 text-right">W</th>
                  <th className="px-4 py-3 text-right">L</th>
                  <th className="px-4 py-3 text-right">Win%</th>
                  <th className="px-4 py-3 text-right">RS</th>
                  <th className="px-4 py-3 text-right">RA</th>
                  <th className="px-4 py-3 text-right">Diff</th>
                  <th className="px-4 py-3 text-right">Model Acc</th>
                  <th className="px-4 py-3 text-right">Settled</th>
                </tr>
              </thead>
              <tbody>
                {teams.map((t, i) => (
                  <tr
                    key={t.id}
                    className="border-b border-border/60 last:border-0 hover:bg-secondary/30"
                  >
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                      {i + 1}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-display text-base text-foreground">
                        {t.name}
                      </div>
                      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                        {t.abbr}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right font-mono">{t.wins}</td>
                    <td className="px-4 py-3 text-right font-mono">{t.losses}</td>
                    <td className="px-4 py-3 text-right font-mono">
                      {pct(t.winPct)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-muted-foreground">
                      {t.runsFor}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-muted-foreground">
                      {t.runsAgainst}
                    </td>
                    <td
                      className={`px-4 py-3 text-right font-mono ${t.runDiff > 0 ? "text-primary" : t.runDiff < 0 ? "text-destructive" : ""}`}
                    >
                      {t.runDiff > 0 ? `+${t.runDiff}` : t.runDiff}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {pct(t.modelAccuracy)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-muted-foreground">
                      {t.predicted}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto max-w-6xl px-6 py-8 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          Data · MLB Stats API · Settled predictions only
        </div>
      </footer>
    </div>
  );
}
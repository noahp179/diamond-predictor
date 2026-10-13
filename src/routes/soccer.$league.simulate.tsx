import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";

import { SoccerShell } from "@/components/SoccerShell";
import { UclSimulatePage, type UclSimSearch } from "@/components/sim/UclSimulatePage";
import { leagueOf, type LeagueSlug } from "@/lib/soccer-leagues";

const str = (v: unknown) => (typeof v === "string" && /^\d{1,12}$/.test(v) ? v : undefined);

/** The match simulator. Only the Champions League has one; a domestic league's
 *  link lands on a pointer to it rather than a 404. */
export const Route = createFileRoute("/soccer/$league/simulate")({
  validateSearch: (s: Record<string, unknown>): UclSimSearch => ({
    date: typeof s.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.date) ? s.date : undefined,
    game: str(s.game),
    home: str(s.home),
    away: str(s.away),
  }),
  head: ({ params }) => {
    const l = leagueOf(params.league);
    return {
      meta: [
        { title: `${l.name} Match Simulator — Diamond Edge` },
        {
          name: "description",
          content:
            "Play any Champions League match minute by minute up to 100,000 times — win, draw and loss, scorelines, goal totals and every likely goalscorer, next to the model and the market.",
        },
      ],
    };
  },
  component: Page,
});

function Page() {
  const { league } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  if (league !== "ucl") {
    const l = leagueOf(league);
    return (
      <SoccerShell
        league={league as LeagueSlug}
        current="slate"
        eyebrow={`Diamond Edge · ${l.name}`}
        title="Simulate"
        blurb="The match simulator runs on the Champions League model."
      >
        <Link
          to="/soccer/$league/simulate"
          params={{ league: "ucl" }}
          className="text-primary underline"
        >
          Open the Champions League simulator →
        </Link>
      </SoccerShell>
    );
  }
  return (
    <UclSimulatePage
      search={search}
      onSearch={(next) => navigate({ search: next, resetScroll: false })}
    />
  );
}

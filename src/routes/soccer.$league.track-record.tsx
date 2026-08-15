import { createFileRoute } from "@tanstack/react-router";

import { LedgerView } from "@/components/LedgerView";
import { leagueOf, type LeagueSlug } from "@/lib/soccer-leagues";

export const Route = createFileRoute("/soccer/$league/track-record")({
  head: ({ params }) => {
    const l = leagueOf(params.league);
    return {
      meta: [
        { title: `${l.name} Track Record — Diamond Edge` },
        {
          name: "description",
          content: `Every ${l.name} prediction recorded before kick-off and scored afterwards, against what the backtest said to expect.`,
        },
      ],
    };
  },
  component: () => {
    const { league } = Route.useParams();
    const l = leagueOf(league);
    return (
      <LedgerView
        sport="soccer"
        division={league as LeagueSlug}
        eyebrow={`Diamond Edge · ${l.name}`}
        title="Track Record"
      />
    );
  },
});

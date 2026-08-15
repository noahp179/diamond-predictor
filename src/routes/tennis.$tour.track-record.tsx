import { createFileRoute } from "@tanstack/react-router";

import { LedgerView } from "@/components/LedgerView";
import { tourOf, type TourSlug } from "@/lib/tennis-tours";

export const Route = createFileRoute("/tennis/$tour/track-record")({
  head: ({ params }) => {
    const t = tourOf(params.tour);
    return {
      meta: [
        { title: `${t.name} Track Record — Diamond Edge` },
        {
          name: "description",
          content: `Every ${t.name} prediction recorded on the morning of the match and scored afterwards, against what the backtest said to expect.`,
        },
      ],
    };
  },
  component: () => {
    const { tour } = Route.useParams();
    const t = tourOf(tour);
    return (
      <LedgerView
        sport="tennis"
        division={tour as TourSlug}
        eyebrow={`Diamond Edge · ${t.name}`}
        title="Track Record"
      />
    );
  },
});

import { createFileRoute } from "@tanstack/react-router";

import { TrackRecordView } from "@/components/TrackRecordView";
import { getNflTrackRecord } from "@/lib/sports.functions";

export const Route = createFileRoute("/nfl/track-record")({
  head: () => ({ meta: [{ title: "NFL Track Record — Diamond Edge" }] }),
  component: () => <TrackRecordView sport="nfl" fetchTrackRecord={getNflTrackRecord} />,
});

import { createFileRoute } from "@tanstack/react-router";

import { TrackRecordView } from "@/components/TrackRecordView";
import { getNbaTrackRecord } from "@/lib/sports.functions";

export const Route = createFileRoute("/nba/track-record")({
  head: () => ({ meta: [{ title: "NBA Track Record — Diamond Edge" }] }),
  component: () => <TrackRecordView sport="nba" fetchTrackRecord={getNbaTrackRecord} />,
});

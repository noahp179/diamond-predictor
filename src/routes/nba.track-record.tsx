import { createFileRoute } from "@tanstack/react-router";

import { LedgerView } from "@/components/LedgerView";

/**
 * The NBA Track Record — the forward ledger, not the season replay it used to
 * show. See nfl.track-record.tsx for why.
 */
export const Route = createFileRoute("/nba/track-record")({
  head: () => ({ meta: [{ title: "NBA Track Record — Diamond Edge" }] }),
  component: () => <LedgerView sport="nba" title="Track Record" eyebrow="Diamond Edge · NBA" />,
});

import { createFileRoute } from "@tanstack/react-router";

import { LedgerView } from "@/components/LedgerView";

/**
 * The NFL Track Record.
 *
 * This used to render `TrackRecordView`, which replayed the last three seasons
 * and scored them afterwards — a backtest presented as a record. It now reads
 * the same forward ledger every other sport uses: rows written the morning of a
 * game and scored once it finished. That means it starts empty, which is the
 * honest state of an NFL forward record that began on 2026-09-03.
 */
export const Route = createFileRoute("/nfl/track-record")({
  head: () => ({ meta: [{ title: "NFL Track Record — Diamond Edge" }] }),
  component: () => <LedgerView sport="nfl" title="Track Record" eyebrow="Diamond Edge · NFL" />,
});

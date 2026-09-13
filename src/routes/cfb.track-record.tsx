import { createFileRoute } from "@tanstack/react-router";

import { LedgerView } from "@/components/LedgerView";

/**
 * The college football Track Record — the forward ledger every sport uses:
 * rows written the morning of a game and scored once it finished. It starts
 * empty, which is the honest state of a record that begins the day the cron
 * first writes to it. The backtest lives in CFB-ANALYSIS.md and is labelled as
 * a backtest, which is a different claim.
 */
export const Route = createFileRoute("/cfb/track-record")({
  head: () => ({ meta: [{ title: "College Football Track Record — Diamond Edge" }] }),
  component: () => (
    <LedgerView sport="cfb" title="Track Record" eyebrow="Diamond Edge · College Football" />
  ),
});

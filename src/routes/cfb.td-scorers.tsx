import { createFileRoute } from "@tanstack/react-router";

import { CfbTdScorersView } from "@/components/CfbTdScorersView";

export const Route = createFileRoute("/cfb/td-scorers")({
  head: () => ({ meta: [{ title: "College Football TD Scorers — Diamond Edge" }] }),
  component: () => <CfbTdScorersView />,
});

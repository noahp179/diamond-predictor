import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Layout for /nba and its views (slate, recommended, best odds, track
 *  record). Each child renders its own full page frame; this is just the
 *  routing parent. */
export const Route = createFileRoute("/nba")({
  component: () => <Outlet />,
});

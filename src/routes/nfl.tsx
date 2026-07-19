import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Layout for /nfl and its views (slate, recommended, best odds, track
 *  record). Each child renders its own full page frame; this is just the
 *  routing parent. */
export const Route = createFileRoute("/nfl")({
  component: () => <Outlet />,
});

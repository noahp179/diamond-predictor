import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Layout for /cfb and its views (slate, recommended, best odds, TD scorers,
 *  track record). Each child renders its own full page frame; this is just the
 *  routing parent. */
export const Route = createFileRoute("/cfb")({
  component: () => <Outlet />,
});

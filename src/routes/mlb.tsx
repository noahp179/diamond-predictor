import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Layout for /mlb and its views. Each page renders its own shell, so this is
 *  only a mount point for the nested routes. */
export const Route = createFileRoute("/mlb")({
  component: () => <Outlet />,
});

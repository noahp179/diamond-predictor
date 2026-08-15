import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Layout for one tour's pages (draw, model). */
export const Route = createFileRoute("/tennis/$tour")({
  component: () => <Outlet />,
});

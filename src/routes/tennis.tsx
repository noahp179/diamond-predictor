import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Layout for /tennis and its tour pages. */
export const Route = createFileRoute("/tennis")({
  component: () => <Outlet />,
});
